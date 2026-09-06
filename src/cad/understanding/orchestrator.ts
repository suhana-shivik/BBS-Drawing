// ============================================================
// The Drawing Orchestrator — the AI that decides how a sheet divides.
//
// ITS ONLY RESPONSIBILITY IS TO UNDERSTAND AND DECOMPOSE THE DRAWING.
//
// Nothing here knows what a bar bending schedule is. It does not count, it
// does not measure, it does not assign a callout to a member. It looks at a
// sheet, works out which parts of it are useful pieces, and asks the platform
// to cut them. A BBS run is one consumer of the result; take-off, structural
// review and plain human inspection are others, and none of them should be
// able to tell which was written first.
//
// THE HARDCODING BAN (§4). There is no list of section names in this file, no
// regex over caption text, no "if it says SECTION then". The model is given
// the sheet and the tools to interrogate it, and every cut in the output is
// one it asked for. That is the difference between this and the caption-guess
// heuristic it replaces.
//
// WHAT THE MODEL MAY AND MAY NOT PRODUCE. It may produce MEANING — a label, a
// kind, a member hint, a relationship, a confidence. It may not produce
// geometry it typed as fact: `propose_section` prefers a list of text HANDLES
// and the platform measures the box from where those texts actually are. It
// may give explicit coordinates when a region carries no text to point at,
// and when it does they are clamped to the sheet and recorded as its own,
// not laundered into something that looks measured.
// ============================================================
import type { CadDocument } from '../types';
import { getAiConfig } from '../ai/config';
import { contentOf, messageFromErrorBody } from '../ai/openrouter';
import {
  boundsForHandles,
  boundsFromCorners,
  boundsKey,
  clampToSheet,
  isDegenerate,
  sheetBounds,
} from './bounds';
import { defaultRenderer, exportSection, sectionIdFor, type SectionRenderer } from './section';
import { drawingHash } from './hash';
import { computeCoverage, coverageSummaryLines, type CoverageSummary } from './coverage';
import {
  checkReproducible,
  reproducibilityLimitation,
  reproducibilityNote,
} from './reproducible';
import {
  PACKAGE_VERSION,
  type DrawingSection,
  type DrawingUnderstandingPackage,
  type MemberHint,
  type SectionBounds,
  type SectionRelationship,
  type SectionRequestRecord,
} from './types';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** turns the orchestrator may take before it must summarise */
const MAX_ROUNDS = 14;
/** sections one run may produce — past this it is describing pixels, not parts */
const MAX_SECTIONS = 24;
/** texts offered in the opening brief */
const MAX_BRIEF_TEXTS = 400;
/** hits returned by one find_text */
const MAX_HITS = 60;
/** longest side of an investigation crop, px */
const LOOK_PX = 1100;
/**
 * Empty replies tolerated before the run gives up.
 *
 * A reply with no tool calls AND no text is not a decision — it is a turn that
 * failed, usually because the model spent its whole completion budget on
 * reasoning and had nothing left to emit. The first version treated it as
 * "the model is finished", which ended a live GAMCO run with ZERO sections
 * after four successful look_at calls: everything it had established was
 * thrown away on the strength of one blank message.
 */
const MAX_EMPTY_REPLIES = 3;
/**
 * Extra finish-attempts granted when the model tries to close with real
 * geometry still in no section — see the remediation block in splitDrawing.
 *
 * Bounded the same way MAX_EMPTY_REPLIES and bounds.ts's
 * MAX_TIGHTEN_ITERATIONS are: a retry budget, not a licence to loop forever
 * chasing a gap the model cannot or should not close (title-block noise has
 * no section either, and is not supposed to get one).
 */
const REMEDIATION_ROUNDS = 3;

// ------------------------------------------------------------
// transport — injectable so the whole loop is testable unpaid
// ------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatReply {
  content: string;
  toolCalls: ToolCall[];
  /**
   * The model's own reasoning, when the provider returns it.
   *
   * Surfaced as a `thinking` event rather than dropped. A panel that shows
   * only "Looking at the sheet…" for two minutes tells the user nothing about
   * whether the run is working, stuck, or about to produce nonsense — and the
   * reasoning is the most informative thing there is to show.
   */
  reasoning?: string;
}

/**
 * How a turn reaches a model.
 *
 * Injected rather than hardcoded so the orchestrator can be driven by a
 * scripted stand-in in tests. §26 forbids a paid run before the local path is
 * proven, and a loop that can only talk to a real endpoint cannot be proven
 * without paying.
 */
export type ChatTransport = (req: {
  model: string;
  messages: ChatMessage[];
  tools: readonly unknown[];
  signal?: AbortSignal;
}) => Promise<ChatReply>;

export const openRouterTransport: ChatTransport = async (req) => {
  const cfg = getAiConfig();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    signal: req.signal,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': cfg.appName,
    },
    body: JSON.stringify({
      model: req.model,
      temperature: 0.1,
      // Live run 011 spent its ENTIRE completion budget on reasoning and
      // returned a blank message, which ended the run with zero sections.
      // Both halves of the fix belong here, not only in the test harness:
      // cap the reasoning, and leave a completion budget it cannot exhaust.
      max_tokens: 8_000,
      reasoning: { effort: 'low' },
      tools: req.tools,
      messages: req.messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(messageFromErrorBody(res.status, body));
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string; tool_calls?: ToolCall[] } }[];
  };
  const message = json.choices?.[0]?.message as
    | { content?: string; tool_calls?: ToolCall[]; reasoning?: string; reasoning_content?: string }
    | undefined;
  // providers disagree on the field name; take whichever arrived
  const reasoning =
    typeof message?.reasoning === 'string'
      ? message.reasoning
      : typeof message?.reasoning_content === 'string'
        ? message.reasoning_content
        : '';
  return {
    content: typeof message?.content === 'string' ? message.content : contentOf(json),
    toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
    reasoning,
  };
};

// ------------------------------------------------------------
// tool surface
// ------------------------------------------------------------

export const ORCHESTRATOR_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'find_text',
      description:
        'Search every text on the sheet. Returns matching texts with their HANDLE and position. Use the handles to point at a region rather than typing its coordinates.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'case-insensitive substring or regular expression' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'text_near',
      description: 'Every text within a radius of a point, nearest first, with handles.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          radius: { type: 'number', description: 'millimetres' },
        },
        required: ['x', 'y', 'radius'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'look_at',
      description:
        'Render a rectangle of the sheet and show it to you. Use this to check what is actually drawn somewhere before deciding whether it is a useful section, and to check whether a crop you are considering is big enough.',
      parameters: {
        type: 'object',
        properties: {
          x1: { type: 'number' },
          y1: { type: 'number' },
          x2: { type: 'number' },
          y2: { type: 'number' },
        },
        required: ['x1', 'y1', 'x2', 'y2'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_section',
      description:
        'Cut a section and save it as a real drawing object (PNG + DXF + metadata). Prefer `handles`: the platform measures the box from where those texts actually are, so you cannot mis-measure it. Use x1/y1/x2/y2 only for a region with no text to point at.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: "the sheet's own wording where it has any" },
          kind: {
            type: 'string',
            description:
              'what sort of thing this is — e.g. overall, plan, elevation, section, detail, typical-detail, layout, schedule, note, foundation, wall, column, beam, precast. Your own word is fine.',
          },
          handles: { type: 'array', items: { type: 'string' }, description: 'text handles inside this region' },
          x1: { type: 'number' },
          y1: { type: 'number' },
          x2: { type: 'number' },
          y2: { type: 'number' },
          confidence: { type: 'number', description: '0..1' },
          memberHints: {
            type: 'array',
            description: 'members this region appears to be ABOUT — a hint, never an assignment',
            items: {
              type: 'object',
              properties: { mark: { type: 'string' }, basis: { type: 'string' } },
              required: ['mark', 'basis'],
            },
          },
          calloutHints: { type: 'array', items: { type: 'string' } },
          evidenceIds: { type: 'array', items: { type: 'string' }, description: 'handles you read this from' },
        },
        required: ['label', 'kind'],
      },
    },
  },
] as const;

const SYSTEM = `You are looking at one sheet of an engineering drawing in order to DECOMPOSE it into useful parts.

A sheet like this is not one drawing. It is a dozen: layouts, elevations, sections, typical details, schedules, a notes block, a title block — arranged on one page. Your job is to say which is which, so each can be saved as its own drawing that someone can open on its own.

YOU DECIDE WHAT IS USEFUL. There is no list of expected sections and nothing is waiting for particular names. If this sheet has four typical details and two layouts, that is six sections. If it has one big plan and nothing else, that is one.

HOW TO WORK
1. Look at the whole sheet you have been given. It is for ORIENTATION — at that size you can see THAT something is a section, not WHAT it says. Do not try to read callouts from it.
2. Use find_text and text_near to see what is written where.
3. Use look_at to actually look at a region before you commit to it. If the crop is too tight, or contains two things, or misses the dimension chain running off to one side, ask for a different one. Iterating here is expected and cheap.
4. Call propose_section for each useful part.

POINTING, NOT MEASURING
Prefer giving propose_section a list of text HANDLES. The platform computes the box from where those texts really are, so a box built that way cannot be wrong. Give coordinates only when a region genuinely has no text in it.
Put EVERY handle that belongs to the region in the list — its title, its dimensions, its callouts, its level marks. A region listed with only its title becomes a crop containing only the title.

WHAT YOU MAY SAY
- what a region is ("this is the typical SC detail", "this is a reinforcement schedule")
- which member it appears to be about, as a HINT with its basis ("the label C1 is printed in this region")
- how confident you are
- that something is unclear

WHAT YOU MUST NOT DO
- do not decide which callout belongs to which member
- do not count anything, or state a quantity, a length or a tonnage
- do not invent a dimension
- do not skip the notes block or the schedules; they are useful sections too
- do not propose the title block or the revision table

WHEN YOU ARE DONE
Stop calling tools and reply with JSON only:
{"summary":"one paragraph on how this sheet is laid out",
 "relationships":[{"from":"REGION-02","to":"REGION-05","kind":"detail-of","basis":"..."}],
 "unresolved":["anything you looked at and could not account for"]}`;

// ------------------------------------------------------------
// text index — handles the model can point at
// ------------------------------------------------------------

interface IndexedText {
  handle: string;
  text: string;
  /** millimetres */
  x: number;
  y: number;
  height: number;
}

/**
 * Top-level text entities, in millimetres, with their handles.
 *
 * Deliberately NOT the block-following harvester in `ai/digest.ts`: a text
 * inside a block definition has ONE handle shared by every INSERT of that
 * block, so pointing at it is ambiguous. Everything the model is invited to
 * point at here resolves to exactly one entity.
 */
export function textIndex(doc: CadDocument): IndexedText[] {
  const k = doc.unitScale || 1;
  const out: IndexedText[] = [];
  for (const e of doc.entities) {
    if (e.type !== 'text') continue;
    const text = e.text.trim();
    if (text.length < 2) continue;
    if (!e.style.handle) continue;
    out.push({
      handle: e.style.handle,
      text,
      x: e.position.x * k,
      y: e.position.y * k,
      height: Math.abs(e.height) * k || 1,
    });
  }
  return out;
}

// ------------------------------------------------------------
// the run
// ------------------------------------------------------------

export interface OrchestratorEvent {
  step: number;
  ask: string;
  served: string;
}

export interface SplitOptions {
  projectId: string;
  model?: string;
  signal?: AbortSignal;
  onEvent?: (e: OrchestratorEvent) => void;
  transport?: ChatTransport;
  renderer?: SectionRenderer;
  /** DXF-only run: no rasteriser is called at all */
  skipPng?: boolean;
  maxRounds?: number;
  /** original upload bytes, for the strongest source hash */
  sourceBytes?: ArrayBuffer | Uint8Array | null;
  /** whole-sheet image for orientation; omitted in headless runs */
  overview?: string | null;
  /**
   * Whether a real model produced this run.
   *
   * Inferred from the transport by default, which is right for the two normal
   * cases — the built-in transport means a model, a scripted one means a
   * stand-in. It is wrong for a transport that WRAPS the real endpoint to log
   * it, so a caller doing that says so explicitly rather than having its run
   * filed as a stand-in.
   */
  source?: 'model' | 'local';
}

function briefFor(doc: CadDocument, texts: readonly IndexedText[]): string {
  const sheet = sheetBounds(doc);
  const lines: string[] = [];
  lines.push(`DRAWING: ${doc.sourceFile}`);
  if (sheet) {
    lines.push(
      `SHEET EXTENTS (mm): x ${sheet.xMin.toFixed(0)} to ${sheet.xMax.toFixed(0)}, ` +
        `y ${sheet.yMin.toFixed(0)} to ${sheet.yMax.toFixed(0)}`,
    );
  }
  lines.push(`${doc.entities.length} entities on ${doc.layers.size} layers.`);
  lines.push('');
  lines.push('TEXTS ON THIS SHEET (handle @(x,y) height "text") — biggest first:');
  const offered = [...texts].sort((a, b) => b.height - a.height).slice(0, MAX_BRIEF_TEXTS);
  for (const t of offered) {
    lines.push(
      `${t.handle} @(${t.x.toFixed(0)},${t.y.toFixed(0)}) h${t.height.toFixed(0)} ${JSON.stringify(t.text.slice(0, 70))}`,
    );
  }
  if (texts.length > offered.length) {
    lines.push(`… ${texts.length - offered.length} smaller texts not listed — use find_text to reach them.`);
  }
  return lines.join('\n');
}

function readBounds(args: Record<string, unknown>): SectionBounds | null {
  const n = (v: unknown): number => Number(v);
  const vals = [n(args.x1), n(args.y1), n(args.x2), n(args.y2)];
  if (vals.some((v) => !Number.isFinite(v))) return null;
  return boundsFromCorners(vals[0], vals[1], vals[2], vals[3]);
}

function readHints(value: unknown): MemberHint[] {
  if (!Array.isArray(value)) return [];
  const out: MemberHint[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const mark = typeof rec.mark === 'string' ? rec.mark.trim() : '';
    if (!mark) continue;
    out.push({ mark, basis: typeof rec.basis === 'string' ? rec.basis.trim() : 'stated by the orchestrator' });
  }
  return out;
}

function readStrings(value: unknown, cap = 40): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').slice(0, cap);
}

/**
 * What the model is told when it tries to close but real geometry is still
 * outside every section it cut.
 *
 * Gives it the same three things a person would need to act on this: WHICH
 * layers, WHERE (a box it can hand straight to look_at), and WHAT the content
 * looks like (sample text). The model decides whether that is a missed detail
 * or title-block noise that does not deserve a section — this only makes sure
 * that decision is made on purpose, in the closing "unresolved" list, instead
 * of by omission.
 */
function remediationPrompt(coverage: CoverageSummary): string {
  const lines = [
    `Before you close: ${coverage.uncoveredEntities} of ${coverage.measurableEntities} entities on this ` +
      'sheet are not inside ANY section you have cut so far. This is measured directly from the drawing ' +
      'geometry, not a guess — every entity outside every section box you proposed.',
    '',
    'By layer, worst first:',
    ...coverage.gaps.slice(0, 8).map((g) => {
      const where =
        `x ${g.bounds.xMin.toFixed(0)}..${g.bounds.xMax.toFixed(0)}, ` +
        `y ${g.bounds.yMin.toFixed(0)}..${g.bounds.yMax.toFixed(0)} mm`;
      const sample = g.sampleText.length
        ? ` — e.g. ${g.sampleText.slice(0, 3).map((t) => JSON.stringify(t)).join(', ')}`
        : '';
      return `· ${g.layer}: ${g.count} entit${g.count === 1 ? 'y' : 'ies'}, roughly at ${where}${sample}`;
    }),
    coverage.gaps.length > 8 ? `· …and ${coverage.gaps.length - 8} more layer(s).` : '',
    '',
    'For each gap: call look_at on its coordinates to see what is actually there, then either call ' +
      'propose_section to cut it — it may be a missed detail, or the untouched space between two of your ' +
      'existing sections — or, if it is genuinely title-block text, a sheet border, or background noise ' +
      'that does not deserve its own section, name it in your closing "unresolved" list instead of leaving it ' +
      'unexplained.',
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Run the splitter.
 *
 * Independent by construction: it takes a document and returns a package.
 * Nothing about a schedule, a bill or a bar reaches this function, and no
 * caller has to be building one to call it.
 */
export async function splitDrawing(
  doc: CadDocument,
  opts: SplitOptions,
): Promise<DrawingUnderstandingPackage> {
  const cfg = getAiConfig();
  const model = opts.model || cfg.visionModel;
  const transport = opts.transport ?? openRouterTransport;
  const renderer = opts.renderer ?? defaultRenderer;
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  const sheet = sheetBounds(doc);
  const texts = textIndex(doc);
  const hash = await drawingHash(doc, opts.sourceBytes ?? null);

  const sections: DrawingSection[] = [];
  const requests: SectionRequestRecord[] = [];
  /** boundsKey → sectionId, so the same region asked for twice is one section */
  const byBounds = new Map<string, string>();

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: briefFor(doc, texts) },
  ];
  if (opts.overview) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: 'The whole sheet, for orientation. Use look_at to read anything on it.' },
        { type: 'image_url', image_url: { url: opts.overview } },
      ],
    });
  }

  const emit = (step: number, ask: string, served: string): void =>
    opts.onEvent?.({ step, ask, served });

  let summary = '';
  let relationships: SectionRelationship[] = [];
  let unresolved: string[] = [];
  let empties = 0;
  let finished = false;
  /** finish-attempts granted back when a real gap survived one; see below */
  let remediationBudget = REMEDIATION_ROUNDS;
  let remediationRoundsUsed = 0;
  /** set right when a gap is caught, consumed as the very next user message */
  let pendingRemediationPrompt: string | null = null;
  /** once the model has been shown a gap, a deliberate unresolved note about it is an answer, not a dodge */
  let sawRemediationPrompt = false;
  // Only grows when remediation actually engages (one round per gap it is
  // given the chance to close), never up front — a model that never even
  // attempts to close still exhausts at exactly maxRounds, same as before.
  let roundLimit = maxRounds;
  let step = 1;

  for (; step <= roundLimit; step++) {
    if (opts.signal?.aborted) break;

    if (pendingRemediationPrompt) {
      messages.push({ role: 'user', content: pendingRemediationPrompt });
      pendingRemediationPrompt = null;
    } else if (step <= maxRounds) {
      // An invisible budget makes a model pace badly and die with nothing to
      // show — the same lesson the BBS harness learned. Tell it where it is.
      messages.push({
        role: 'user',
        content:
          `Step ${step} of ${maxRounds}. ${sections.length} section(s) cut so far.` +
          (step >= maxRounds - 1
            ? ' This is your last chance to propose sections — do it now, then close.'
            : ''),
      });
    } else {
      messages.push({
        role: 'user',
        content:
          `Remediation round ${step - maxRounds} of ${REMEDIATION_ROUNDS}. ${sections.length} section(s) cut ` +
          'so far. Keep working the coverage gap described earlier, then reply with the closing JSON.',
      });
    }

    const reply = await transport({ model, messages, tools: ORCHESTRATOR_TOOLS, signal: opts.signal });

    // Show the work. The reasoning and the prose the model writes alongside
    // its tool calls are the only window into WHY it is cutting where it is.
    if (reply.reasoning?.trim()) {
      emit(step, 'thinking', reply.reasoning.trim().slice(0, 4000));
    }
    if (reply.toolCalls.length && reply.content.trim()) {
      emit(step, 'thinking', reply.content.trim().slice(0, 4000));
    }

    if (!reply.toolCalls.length) {
      const text = reply.content.trim();

      // A blank turn is not a finish. Say so, tell the model what it still
      // has, and let it use the rounds it has left.
      if (!text) {
        empties += 1;
        emit(step, 'empty reply', empties >= MAX_EMPTY_REPLIES ? 'giving up' : 'nudging');
        if (empties >= MAX_EMPTY_REPLIES) {
          unresolved.push(
            `The run ended early: ${empties} replies in a row were empty. ` +
              `${sections.length} section(s) were cut before that.`,
          );
          break;
        }
        const cut = sections.length
          ? `: ${sections.map((x) => `${x.sectionId} ${JSON.stringify(x.label)}`).join(', ')}.`
          : ' \u2014 none yet.';
        messages.push({
          role: 'user',
          content: [
            'Your last reply was empty \u2014 no tool call and no text. That usually means the answer ran long. Keep it short.',
            '',
            `You have cut ${sections.length} section(s) so far${cut}`,
            `You have ${maxRounds - step} round(s) left.`,
            '',
            'Do ONE of these now:',
            '\u00b7 call propose_section for a region you have already identified (one call per region), or',
            '\u00b7 if you are done, reply with the closing JSON and nothing else.',
          ].join('\n'),
        });
        continue;
      }

      empties = 0;
      const parsed = parseFinal(reply.content);
      if (parsed) {
        summary = parsed.summary || prose(text);
        relationships = parsed.relationships;
        unresolved = parsed.unresolved;
      } else {
        // The closing reply was meant to be JSON and was not readable. Its raw
        // text is NOT a summary — dumping it put a wall of `"relationships":[…`
        // at the top of the register. Keep it only if it reads as prose.
        summary = prose(text);
        if (!summary) unresolved.push('The closing summary could not be read.');
      }

      // A finish is a PROPOSAL, not a fact, while real geometry is still in
      // no section. Coverage is pure geometry (computeCoverage) — check it
      // before accepting the close, and hand the model a bounded number of
      // extra attempts to either cut the gap or explain it away, exactly the
      // way an empty reply gets nudges instead of being read as "done".
      //
      // A closing reply that arrives AFTER the model has already been shown
      // the gap, and that writes something into "unresolved", is an answer —
      // not silence to nag again. Only a repeat close with nothing said about
      // it (or the very first close, before it knew) counts as unaddressed.
      const coverageNow = computeCoverage(doc, sections.map((s) => s.bounds));
      const gapAddressed = sawRemediationPrompt && unresolved.length > 0;
      if (
        coverageNow.uncoveredEntities > 0 &&
        !gapAddressed &&
        remediationBudget > 0 &&
        sections.length < MAX_SECTIONS
      ) {
        remediationBudget -= 1;
        remediationRoundsUsed += 1;
        sawRemediationPrompt = true;
        roundLimit += 1;
        pendingRemediationPrompt = remediationPrompt(coverageNow);
        emit(
          step,
          'coverage check',
          `${coverageNow.uncoveredEntities} of ${coverageNow.measurableEntities} entities uncovered — ` +
            `asking for another pass (${remediationRoundsUsed}/${REMEDIATION_ROUNDS})`,
        );
        continue;
      }

      emit(step, 'finish', `${sections.length} sections`);
      finished = true;
      break;
    }
    empties = 0;

    messages.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.toolCalls });

    for (const call of reply.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      const name = call.function.name;

      // ---- investigation ----
      if (name === 'find_text') {
        const pattern = String(args.pattern ?? '');
        let re: RegExp;
        try {
          re = new RegExp(pattern, 'i');
        } catch {
          re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        }
        const hits = texts.filter((t) => re.test(t.text)).slice(0, MAX_HITS);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: hits.length
            ? hits
                .map((t) => `${t.handle} @(${t.x.toFixed(0)},${t.y.toFixed(0)}) ${JSON.stringify(t.text)}`)
                .join('\n')
            : `Nothing on this sheet matches ${JSON.stringify(pattern)}.`,
        });
        emit(step, `find_text ${pattern}`, `${hits.length} hits`);
        continue;
      }

      if (name === 'text_near') {
        const x = Number(args.x);
        const y = Number(args.y);
        const r = Number(args.radius);
        const hits = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(r)
          ? texts
              .map((t) => ({ t, d: Math.hypot(t.x - x, t.y - y) }))
              .filter((h) => h.d <= r)
              .sort((a, b) => a.d - b.d)
              .slice(0, MAX_HITS)
          : [];
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: hits.length
            ? hits
                .map((h) => `${h.t.handle} @(${h.t.x.toFixed(0)},${h.t.y.toFixed(0)}) ${JSON.stringify(h.t.text)}`)
                .join('\n')
            : 'No text within that radius.',
        });
        emit(step, `text_near (${x},${y})`, `${hits.length} hits`);
        continue;
      }

      if (name === 'look_at') {
        const asked = readBounds(args);
        const record: SectionRequestRecord = {
          step,
          tool: name,
          argument: args,
          requestedBounds: asked,
          semanticHint: null,
          resolvedBounds: null,
          sectionId: null,
          pngPath: null,
          dxfPath: null,
          evidenceIds: [],
          timestamp: Date.now(),
        };
        if (!asked || isDegenerate(asked)) {
          record.note = 'the rectangle had no area';
          requests.push(record);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'That rectangle has no area. Give two opposite corners.',
          });
          continue;
        }
        const box = clampToSheet(asked, sheet);
        record.resolvedBounds = box;
        requests.push(record);
        const image = opts.skipPng ? null : await renderer(doc, box, LOOK_PX);
        if (image) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'Rendered — the image follows.' });
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: `look_at ${boundsKey(box)}` },
              { type: 'image_url', image_url: { url: image } },
            ],
          });
        } else {
          // say WHICH failure this is, so the model does not spend turns
          // re-aiming coordinates that were correct
          const has = entitiesPresent(doc, box);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: has
              ? 'That region has geometry but this run cannot render images — your coordinates were fine. Do not retry look_at; work from find_text and text_near.'
              : 'Nothing is drawn in that region — the crop is genuinely empty. Check the coordinates against the SHEET EXTENTS.',
          });
        }
        emit(step, `look_at ${boundsKey(box)}`, image ? 'rendered' : 'no image');
        continue;
      }

      // ---- the section-creating tool ----
      if (name === 'propose_section') {
        const label = String(args.label ?? '').trim() || 'unnamed region';
        const kind = String(args.kind ?? 'unknown').trim() || 'unknown';
        const handles = readStrings(args.handles, 500);
        const explicit = readBounds(args);
        const measured = handles.length ? boundsForHandles(doc, handles) : null;
        const box = measured ?? explicit;

        const record: SectionRequestRecord = {
          step,
          tool: name,
          argument: args,
          requestedBounds: explicit,
          semanticHint: `${kind}: ${label}`,
          resolvedBounds: null,
          sectionId: null,
          pngPath: null,
          dxfPath: null,
          evidenceIds: readStrings(args.evidenceIds, 200),
          timestamp: Date.now(),
        };

        if (!box || isDegenerate(box)) {
          record.note = handles.length
            ? 'none of those handles are on this sheet, and no usable rectangle was given'
            : 'no handles and no usable rectangle';
          requests.push(record);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content:
              'I could not work out where that is. Give handles that exist on this sheet (at least two), or two opposite corners.',
          });
          emit(step, `propose_section ${label}`, 'unresolvable');
          continue;
        }

        if (sections.length >= MAX_SECTIONS) {
          record.note = `section cap of ${MAX_SECTIONS} reached`;
          requests.push(record);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `That is more than ${MAX_SECTIONS} sections. Summarise what you have.`,
          });
          continue;
        }

        const resolved = clampToSheet(box, sheet);
        const key = boundsKey(resolved);
        const already = byBounds.get(key);
        if (already) {
          // §19: the same region asked for twice is one section, not two with
          // identical geometry. Overlapping-but-different boxes are NOT merged.
          record.resolvedBounds = resolved;
          record.sectionId = already;
          record.note = 'duplicate of an existing section with the same bounds';
          requests.push(record);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `That is the same region as ${already}, which is already saved. Move on.`,
          });
          emit(step, `propose_section ${label}`, `duplicate of ${already}`);
          continue;
        }

        const sectionId = sectionIdFor(sections.length);
        const section = await exportSection(
          doc,
          resolved,
          {
            sectionId,
            label,
            kind,
            sourceDrawingHash: hash,
            orchestratorStep: step,
            confidence: clamp01(Number(args.confidence)),
            evidenceIds: record.evidenceIds,
            memberHints: readHints(args.memberHints),
            calloutHints: readStrings(args.calloutHints, 100),
          },
          { renderer, skipPng: opts.skipPng },
        );
        sections.push(section);
        byBounds.set(key, sectionId);

        record.resolvedBounds = resolved;
        record.sectionId = sectionId;
        record.pngPath = section.png ? `${sectionId}/section.png` : null;
        record.dxfPath = `${sectionId}/section.dxf`;
        requests.push(record);

        const notes = section.limitations.map((l) => l.message).join('; ');
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content:
            `Saved ${sectionId} "${label}" (${kind}) — ${section.entityCount} CAD entities, ` +
            `bounds ${boundsKey(resolved)}.` + (notes ? ` Notes: ${notes}` : ''),
        });
        emit(step, `propose_section ${label}`, `${sectionId}, ${section.entityCount} entities`);
        continue;
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: `There is no tool called ${name}.`,
      });
    }
  }

  // A run that used every round without closing has not finished looking, and
  // the package must say so rather than reading like a considered stopping
  // point.
  if (!finished && empties < MAX_EMPTY_REPLIES) {
    const roundsTaken = Math.min(step - 1, roundLimit);
    const remediationNote =
      remediationRoundsUsed > 0
        ? ` (including ${remediationRoundsUsed} coverage-remediation round${remediationRoundsUsed === 1 ? '' : 's'})`
        : '';
    unresolved.push(
      `The orchestrator used all ${roundsTaken} round${roundsTaken === 1 ? '' : 's'} without closing` +
        `${remediationNote}; there may be more to cut.`,
    );
  }

  // Bloat (a section spanning two things) is fixed at cut time by
  // connectedEntitiesInBounds. This is the OTHER failure — geometry that
  // ended up in no section at all, the space between two individually
  // correct cuts. Pure geometry, costs nothing, and is never skipped: a
  // package that cannot say whether it accounts for the drawing is the
  // silent gap this exists to close. See coverage.ts.
  const coverage = computeCoverage(doc, sections.map((s) => s.bounds));
  unresolved.push(...coverageSummaryLines(coverage));

  // Guard 4 — reproducibility. Coverage asks what no section claimed; this
  // asks whether each section still describes itself. Re-select from every
  // saved section's OWN stored bounds and check it reproduces the entity list
  // it recorded: PNG, DXF and bounds come from one box variable, so a
  // disagreement here means something moved after that box was fixed. Pure
  // geometry, no model, and it records rather than repairs — rewriting the
  // entity list to match would destroy the evidence being checked.
  for (const finding of checkReproducible(doc, sections)) {
    const section = sections.find((s) => s.sectionId === finding.sectionId);
    if (section) section.limitations.push(reproducibilityLimitation(finding));
    unresolved.push(reproducibilityNote(finding));
  }

  return {
    version: PACKAGE_VERSION,
    projectId: opts.projectId,
    documentId: doc.id,
    sourceDrawing: doc.sourceFile,
    sourceDrawingHash: hash,
    createdAt: Date.now(),
    sheetExtents: sheet,
    sections,
    requests,
    relationships,
    unresolved,
    coverage,
    summary,
    model,
    // a caller that injected its own transport drove this with a stand-in;
    // saying so keeps a scripted run from being mistaken for a model's judgement
    source:
      opts.source ??
      (opts.transport && opts.transport !== openRouterTransport ? 'local' : 'model'),
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** cheap "is anything drawn here", without a rasteriser */
function entitiesPresent(doc: CadDocument, box: SectionBounds): boolean {
  // a full selection is wasted work for a yes/no; stop at the first hit
  const k = doc.unitScale || 1;
  for (const e of doc.entities) {
    if (e.type === 'text') {
      const x = e.position.x * k;
      const y = e.position.y * k;
      if (x >= box.xMin && x <= box.xMax && y >= box.yMin && y <= box.yMax) return true;
    }
  }
  return false;
}

/**
 * Text that is safe to show a person as a summary.
 *
 * A reply that is obviously a JSON object is not prose, however it failed to
 * parse; showing it verbatim is worse than showing nothing.
 */
function prose(text: string): string {
  const t = text.trim();
  if (!t) return '';
  if (t.startsWith('{') || t.startsWith('[')) return '';
  // a stray JSON tail after real prose — keep the prose, drop the tail
  const cut = t.search(/["']?(relationships|unresolved)["']?\s*:/);
  const kept = (cut > 40 ? t.slice(0, cut) : t).replace(/[",\s]+$/, '').trim();
  return kept.length > 20 ? kept : '';
}

function parseFinal(
  content: string,
): { summary: string; relationships: SectionRelationship[]; unresolved: string[] } | null {
  const stripped = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Salvage, the way the BBS harness does: a model that adds a word before
    // its JSON, or lets one trail after it, has still answered.
    const a = stripped.indexOf('{');
    const b = stripped.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      parsed = JSON.parse(stripped.slice(a, b + 1));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  const rels: SectionRelationship[] = [];
  if (Array.isArray(rec.relationships)) {
    for (const item of rec.relationships) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      if (typeof r.from !== 'string' || typeof r.to !== 'string') continue;
      rels.push({
        from: r.from,
        to: r.to,
        kind: typeof r.kind === 'string' ? r.kind : 'related',
        basis: typeof r.basis === 'string' ? r.basis : '',
      });
    }
  }
  return {
    summary: typeof rec.summary === 'string' ? rec.summary : '',
    relationships: rels,
    unresolved: readStrings(rec.unresolved, 50),
  };
}
