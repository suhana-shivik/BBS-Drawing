// Ask questions about the open drawing.
//
// The context handed to the model is built from MEASURED facts — block counts
// and layer lengths straight out of `takeoff.ts` and `metrics.ts`. The model
// is therefore reading our arithmetic rather than performing its own, which is
// the same guardrail the labelling pass uses, expressed for conversation: it
// may interpret and explain, but the numbers it quotes are ours.
//
// Two things sit on top of that text context, both additive and both optional:
//
//   ONE OVERVIEW IMAGE. A layer called "LIGHT" means a luminaire on an
//   electrical plan, a lightweight member on a steel drawing and a line weight
//   on an architectural one. No amount of measured text settles which; one
//   low-resolution picture of the sheet settles it immediately. The image is
//   NOT for reading text — the text is harvested from the DXF as exact strings,
//   which beats OCR every time — it is for establishing what the sheet IS.
//   It is rendered once per document and cached, because rasterising a 26k
//   entity drawing on every keystroke-sized question is seconds of nothing.
//
//   QUERY FRAMING (`plan.ts`, opt-in). The model first says what it needs to
//   look at, we execute that with our own code, and only then does it answer.
//   The guardrail survives intact: it requests DATA, it never computes.
import type { CadDocument } from '../types';
import { computeTakeoff } from '../takeoff';
import { summarise } from '../metrics';
import { cadSheets, getCadSession, selectedCadEntities } from '../session';
import { buildDigest } from './digest';
import { OVERVIEW_PX, renderOverview } from './crops';
import { getAiConfig, isAiConfigured, isVisionCapable } from './config';
import { auditElectrical, phaseBalance } from '../../domain/india';
import { memoryContext, rememberExchange } from './memory';
import { describePlan, fulfilPlan, planQuery, type QueryPlan } from './plan';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const ASK_REQUEST_TIMEOUT_MS = 120_000;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// ------------------------------------------------------------
// the overview image
// ------------------------------------------------------------

/**
 * The caption the image travels behind.
 *
 * Stated as narrowly as possible on purpose: a vision model handed line art
 * will happily "read" a smudge as a dimension, and a hallucinated number is
 * exactly what this codebase exists to prevent. The image answers one
 * question — what kind of drawing is this — and the text answers the rest.
 */
export const OVERVIEW_CAPTION =
  'Overview of the whole sheet, low resolution — use it to judge what kind of drawing this is ' +
  '(plan, section, single-line diagram, bar bending schedule, general arrangement), how it is ' +
  'laid out, and therefore how to read the layer and block names above. Do NOT read text, ' +
  'dimensions or numbers off this image: every string on the sheet is already given to you ' +
  'verbatim in the measured facts, and those are exact.';

/**
 * One render per document, kept for as long as the document is alive.
 *
 * A `WeakMap` because the cache must not be the reason a closed sheet stays in
 * memory. An empty string is cached too: a drawing that cannot rasterise (no
 * DOM, no drawable ops) will not rasterise on the next question either, and
 * retrying it every turn would spend the same seconds for the same nothing.
 */
const overviewCache = new WeakMap<CadDocument, string>();
const overviewPending = new WeakMap<CadDocument, Promise<string>>();
const overviewSlow = new WeakSet<CadDocument>();

/**
 * How long a question will wait for the picture.
 *
 * `rasterise` resolves when an `<img>` fires load or error, and there are real
 * environments where neither ever happens — a headless DOM with image loading
 * off, a hardened CSP, a decoder that gives up silently. Without a ceiling the
 * question hangs forever, which is the worst failure a chat box has. The render
 * is NOT cancelled when the ceiling is hit: it runs on and fills the cache, so
 * the NEXT question carries the image even though this one went without it.
 */
const OVERVIEW_TIMEOUT_MS = 12_000;

/** true when there is a DOM to rasterise in at all */
function canRasterise(): boolean {
  return typeof document !== 'undefined' && typeof Image !== 'undefined';
}

/**
 * The sheet overview as a PNG data URL, or '' when one cannot be made.
 *
 * Never throws — a missing image costs the model one piece of context, while a
 * thrown error would cost the user their answer.
 */
export async function overviewImage(doc: CadDocument): Promise<string> {
  const hit = overviewCache.get(doc);
  if (hit !== undefined) return hit;

  // check before building the display list, not after: `rasterise` bails on a
  // missing DOM only once the SVG has already been serialised, and that is the
  // expensive half
  if (!canRasterise()) {
    overviewCache.set(doc, '');
    return '';
  }

  // a render that already blew the ceiling once does not get to delay every
  // later question too; it is still running, and the cache check above will
  // pick it up the moment it lands
  if (overviewSlow.has(doc)) return '';

  let job = overviewPending.get(doc);
  if (!job) {
    job = (async (): Promise<string> => {
      let url = '';
      try {
        url = await renderOverview(doc, OVERVIEW_PX);
      } catch {
        url = '';
      }
      overviewCache.set(doc, url);
      overviewPending.delete(doc);
      overviewSlow.delete(doc);
      return url;
    })();
    overviewPending.set(doc, job);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      overviewSlow.add(doc);
      resolve('');
    }, OVERVIEW_TIMEOUT_MS);
  });
  try {
    return await Promise.race([job, ceiling]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** drop the cached render — for a document whose geometry has been edited */
export function forgetOverview(doc: CadDocument): void {
  overviewCache.delete(doc);
  overviewPending.delete(doc);
  overviewSlow.delete(doc);
}

/** true when this document's overview is already rendered and non-empty */
export function hasOverview(doc: CadDocument): boolean {
  return !!overviewCache.get(doc);
}

export const CHAT_SYSTEM = `You are helping an Indian construction professional understand a CAD drawing that has already been parsed and measured.

You are given the drawing's measured facts: block instance counts, layer lengths, areas, detected labels, and text found on the sheet. Those numbers were computed from the geometry by the application.

Rules:
- Quote the numbers you are given. Do NOT calculate new quantities, estimate, or extrapolate — if a number is not in the context, say it is not available rather than inventing one.
- You may reason, compare, spot inconsistencies and explain what the drawing appears to show.
- Use Indian construction conventions: R/Y/B phases, ACDB/UDB/MCB/MCCB, IS 1200 measurement, Rmt/sq.m/cu.m, lakh/crore.
- If something looks wrong or missing, say so plainly and say what evidence made you think it.
- Be concise. This is a working tool, not a report.`;

/** measured context — everything here is computed, never guessed */
export function buildChatContext(doc: CadDocument): string {
  const lines: string[] = [];
  const session = getCadSession();

  lines.push(`DRAWING: ${doc.sourceFile}`);
  lines.push(
    `${doc.entities.length} entities · ${doc.layers.size} layers · ${doc.blocks.size} block definitions · units ×${doc.unitScale} to mm`,
  );
  if (doc.extents) {
    const w = (doc.extents.max.x - doc.extents.min.x) / 1000;
    const h = (doc.extents.max.y - doc.extents.min.y) / 1000;
    lines.push(`Extents ${w.toFixed(1)} m × ${h.toFixed(1)} m`);
  }

  // ---- measured quantities ----
  try {
    const t = computeTakeoff(doc, { regionId: session.regionId });
    if (t.blocks.length) {
      lines.push('', 'SYMBOL COUNTS (measured, includes array/nested copies):');
      for (const b of t.blocks.slice(0, 40)) {
        const named = session.labels.get(b.name)?.label;
        lines.push(`  ${b.count} × ${b.name}${named ? ` = ${named}` : ''}  [${b.layers.slice(0, 3).join(', ')}]`);
      }
    }
    if (t.lengths.length) {
      lines.push('', 'LENGTH BY LAYER (measured, mm → m):');
      for (const l of t.lengths.slice(0, 30)) {
        const named = session.labels.get(l.layer)?.label;
        lines.push(`  ${(l.length / 1000).toFixed(1)} m on "${l.layer}"${named ? ` = ${named}` : ''} (${l.entityCount} entities)`);
      }
    }
    if (t.areas.length) {
      lines.push('', 'AREA BY LAYER (measured, m²):');
      for (const a of t.areas.slice(0, 20)) {
        lines.push(`  ${(a.area / 1e6).toFixed(2)} m² on "${a.layer}" (${a.count})`);
      }
    }
  } catch {
    lines.push('', '(quantities unavailable)');
  }

  // ---- domain findings ----
  try {
    const names: string[] = [];
    for (const e of doc.entities) {
      if (e.type === 'insert') names.push(e.blockName);
      else if (e.type === 'text') names.push(e.text);
    }
    const pb = phaseBalance(names);
    if (pb.counts.R + pb.counts.Y + pb.counts.B > 0) {
      lines.push('', `PHASE BALANCE (measured): R ${pb.counts.R} / Y ${pb.counts.Y} / B ${pb.counts.B} — ${pb.balanced ? 'balanced' : 'uneven'}`);
    }
    const findings = auditElectrical(doc);
    if (findings.length) {
      lines.push('', 'AUTOMATED FINDINGS:');
      for (const f of findings) lines.push(`  [${f.severity}] ${f.title}: ${f.detail}`);
    }
  } catch {
    /* domain audit is best-effort */
  }

  // ---- what the user is currently looking at ----
  try {
    const sel = selectedCadEntities();
    if (sel.length) {
      const s = summarise(doc, sel);
      lines.push(
        '',
        `CURRENT SELECTION: ${s.count} entities, ${(s.totalLength / 1000).toFixed(2)} m total length` +
          (s.totalArea > 0 ? `, ${(s.totalArea / 1e6).toFixed(2)} m² total area` : ''),
      );
      for (const b of s.byLayer.slice(0, 6)) {
        lines.push(`  ${b.count} on "${b.layer}" (${(b.length / 1000).toFixed(2)} m)`);
      }
    }
  } catch {
    /* selection is optional context */
  }

  // ---- sheet text: titles, notes, legend rows ----
  try {
    const digest = buildDigest(doc);
    if (digest.textSamples.length) {
      lines.push('', 'TEXT ON THE SHEET (verbatim):');
      for (const t of digest.textSamples.slice(0, 90)) lines.push(`  ${t}`);
    }
  } catch {
    /* text is optional context */
  }

  // Other drawings open in this project. A site never runs on one sheet, and
  // the useful questions are cross-sheet — so the model is told what else is
  // available and what is on it, without paying to render any of it.
  try {
    const others = cadSheets().filter((sh) => sh.doc !== doc);
    if (others.length) {
      lines.push('', 'OTHER DRAWINGS IN THIS PROJECT (not rendered, ask to compare):');
      for (const sh of others.slice(0, 12)) {
        const layers = [...sh.doc.layers.keys()].slice(0, 8).join(', ');
        lines.push(
          `  ${sh.doc.sourceFile} — ${sh.doc.entities.length} entities, ${sh.doc.layers.size} layers [${layers}]`,
        );
      }
    }
  } catch {
    /* other sheets are optional context */
  }

  // what the harness has already established about this drawing
  const mem = memoryContext(doc);
  if (mem) lines.push('', mem);

  return lines.join('\n');
}

// ------------------------------------------------------------
// asking
// ------------------------------------------------------------

/** where a question has got to, for the UI's live line */
export type AskPhase =
  | { kind: 'planning' }
  | { kind: 'gathering'; plan: QueryPlan }
  | { kind: 'answering' };

export interface AskOptions {
  signal?: AbortSignal;
  history?: ChatTurn[];
  /**
   * Attach the sheet overview. Default true; it is dropped silently when the
   * configured model cannot see, so this is an override, not a guard.
   */
  images?: boolean;
  /**
   * Let the model choose what to examine before it answers: one extra request
   * to plan, our code to fulfil it, then the answer. Off by default — it costs
   * a second request and several seconds of latency, so it is the user's
   * decision per question, not a standing tax.
   */
  deepen?: boolean;
  /** progress, so a two-request question is not a blank spinner */
  onPhase?: (phase: AskPhase) => void;
  /** Files the user deliberately attached to this turn. */
  attachments?: readonly AskAttachment[];
}

export interface AskAttachment {
  name: string;
  mimeType: string;
  dataUrl: string;
  text?: string;
  kind: 'image' | 'spreadsheet' | 'text' | 'file';
}

/** why the overview did not go with the question */
export type ImageSkip =
  | 'text-only-model'  // the configured model cannot accept images
  | 'not-rendered'     // nothing to rasterise, or no DOM to do it in
  | 'off';             // the caller asked for text only

export interface AskResult {
  answer: string;
  model: string;
  /** the overview image travelled with the question */
  imageSent: boolean;
  imageSkipped?: ImageSkip;
  /** the validated plan, when `deepen` was set and the planning pass worked */
  plan?: QueryPlan;
  /** the measured block our code produced for that plan */
  planData?: string;
  /** the planning pass failed and the question was answered single-pass */
  planError?: string;
  /** characters of measured text context sent */
  contextChars: number;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

interface ChatMessage {
  role: string;
  content: string | ContentPart[];
}

/**
 * Ask one question about the drawing. Returns the model's reply text.
 *
 * Kept returning a plain string because that is what every existing caller
 * wants; `askDrawingDetailed` is the same call with the metadata, mirroring
 * `analyseDrawing` / `analyseDrawingDetailed` in `openrouter.ts`.
 */
export async function askDrawing(
  doc: CadDocument,
  question: string,
  opts: AskOptions = {},
): Promise<string> {
  return (await askDrawingDetailed(doc, question, opts)).answer;
}

/** as `askDrawing`, but also reports what was sent and what was looked at */
export async function askDrawingDetailed(
  doc: CadDocument,
  question: string,
  opts: AskOptions = {},
): Promise<AskResult> {
  if (!isAiConfigured()) {
    throw new Error(
      'Add your OpenRouter key before asking questions. Paste a key from openrouter.ai/keys ' +
        'into the box below, or set VITE_OPENROUTER_API_KEY in .env and restart.',
    );
  }
  const cfg = getAiConfig();
  const model = cfg.textModel || cfg.visionModel;
  const context = buildChatContext(doc);

  // ---- pass one: let the model frame the question (opt-in) ----
  let plan: QueryPlan | undefined;
  let planData: string | undefined;
  let planError: string | undefined;
  if (opts.deepen) {
    opts.onPhase?.({ kind: 'planning' });
    try {
      plan = await planQuery(doc, question, { signal: opts.signal, model });
      opts.onPhase?.({ kind: 'gathering', plan });
      // OUR code, OUR arithmetic — the model picked the questions only
      planData = fulfilPlan(doc, plan);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      // a planning failure must never cost the user their answer; fall back to
      // the single pass and say so rather than throwing
      planError = err instanceof Error ? err.message : String(err);
      plan = undefined;
      planData = undefined;
    }
  }

  opts.onPhase?.({ kind: 'answering' });

  // ---- the image ----
  const wantImage = opts.images !== false;
  let imageUrl = '';
  let imageSkipped: ImageSkip | undefined;
  if (!wantImage) {
    imageSkipped = 'off';
  } else if (!isVisionCapable(model)) {
    // silently, deliberately: chat must keep working on a text-only model, and
    // the measured facts — which are most of the evidence — are unaffected
    imageSkipped = 'text-only-model';
  } else {
    imageUrl = await overviewImage(doc);
    if (!imageUrl) imageSkipped = 'not-rendered';
  }

  // ---- messages ----
  const messages: ChatMessage[] = [
    { role: 'system', content: CHAT_SYSTEM },
    { role: 'system', content: `MEASURED FACTS FOR THIS DRAWING\n\n${context}` },
  ];
  const attachments = opts.attachments ?? [];
  const readableAttachments = attachments.filter((attachment) => attachment.text?.trim());
  if (readableAttachments.length) {
    messages.push({
      role: 'system',
      content:
        'USER-ATTACHED EVIDENCE — this was supplied by the user with this exact message. ' +
        'Treat it as user-provided context, not as geometry measured from the drawing.\n\n' +
        readableAttachments
          .map((attachment) => `--- ${attachment.name} ---\n${attachment.text}`)
          .join('\n\n'),
    });
  }
  if (imageUrl) {
    messages.push({
      role: 'system',
      content:
        'You are also given ONE low-resolution image of the sheet. Use it for layout and for ' +
        'what kind of drawing this is. Never quote a number or a string read from it — the ' +
        'measured facts above are the only source for both.',
    });
  }
  if (planData) {
    messages.push({
      role: 'system',
      content:
        'REQUESTED DATA — you asked to look at these, and the application measured them for you ' +
        `with the same geometry code as the facts above.${
          plan?.intent ? `\nYour stated intent: ${plan.intent}` : ''
        }\n\n${planData}`,
    });
  }
  // keep the last few turns so follow-ups work without resending everything
  for (const t of (opts.history ?? []).slice(-8)) {
    messages.push({ role: t.role, content: t.content });
  }
  // the image rides on the final user turn: the API is stateless, so this is
  // the only place it can be, and the question stays last so it is what the
  // model is left holding
  messages.push({
    role: 'user',
    content: imageUrl || attachments.length
      ? ([
          ...(imageUrl
            ? [
                { type: 'text' as const, text: OVERVIEW_CAPTION },
                { type: 'image_url' as const, image_url: { url: imageUrl } },
              ]
            : []),
          ...attachments.flatMap((attachment): ContentPart[] => {
            if (attachment.kind === 'image') {
              return [
                { type: 'text', text: `User attachment: ${attachment.name}` },
                { type: 'image_url', image_url: { url: attachment.dataUrl } },
              ];
            }
            if (attachment.text?.trim()) return [];
            return [{ type: 'file', file: { filename: attachment.name, file_data: attachment.dataUrl } }];
          }),
          { type: 'text', text: question },
        ] satisfies ContentPart[])
      : question,
  });

  let res: Response;
  const requestController = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => requestController.abort(opts.signal?.reason);
  if (opts.signal?.aborted) abortFromCaller();
  else opts.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    requestController.abort(new DOMException('The model request timed out.', 'TimeoutError'));
  }, ASK_REQUEST_TIMEOUT_MS);
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: requestController.signal,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': cfg.appName,
      },
      body: JSON.stringify({ model, temperature: 0.2, messages }),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new Error('The request was stopped. You can edit it and send again.');
    if (timedOut) {
      throw new Error('The model did not respond within 2 minutes. The request was stopped so the chat can be used again. Check the Log tab, then retry or ask a narrower question.');
    }
    throw new Error(
      `Could not reach OpenRouter: ${err instanceof Error ? err.message : String(err)}. ` +
        'Check the network connection and try again.',
    );
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', abortFromCaller);
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch {
      /* keep the status line */
    }
    const hint =
      res.status === 401 || res.status === 403
        ? 'The key was rejected — check it at openrouter.ai/keys.'
        : res.status === 402
          ? 'This account has no credit left for that model.'
          : res.status === 404
            ? `OpenRouter does not know the model id "${model}".`
            : res.status === 413 && imageUrl
              ? 'The request was too large — the sheet overview may be too big for this model.'
              : res.status === 429
                ? 'Rate-limited; wait a moment and ask again.'
                : '';
    throw new Error(hint ? `${hint} (OpenRouter: ${detail})` : `OpenRouter: ${detail}`);
  }

  const body = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const raw = body.choices?.[0]?.message?.content;
  const text =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw
            .map((p) =>
              p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '',
            )
            .join('')
        : '';
  if (!text.trim()) {
    throw new Error(
      `${model} returned an empty reply. Try again, or ask a narrower question — a very ` +
        'large drawing can overflow a small model.',
    );
  }
  const reply = text.trim();
  // carry the exchange forward so later answers stay consistent with it
  rememberExchange(doc, question, reply);

  return {
    answer: reply,
    model,
    imageSent: !!imageUrl,
    imageSkipped,
    plan,
    planData,
    planError,
    contextChars: context.length + (planData?.length ?? 0),
  };
}

/** the plan rendered for the UI's "Checking: …" line */
export { describePlan };
export type { QueryPlan };

/** rough size of what a question will send, so the cost is visible up front */
export function contextSize(doc: CadDocument): number {
  try {
    return buildChatContext(doc).length;
  } catch {
    return 0;
  }
}

/** the model chat talks to — one place, so the UI cannot disagree with the call */
export function chatModel(): string {
  const cfg = getAiConfig();
  return cfg.textModel || cfg.visionModel;
}

/**
 * Whether a question asked right now would carry the sheet overview.
 *
 * Answered before anything is sent so the UI can say "text-only model — no
 * overview" up front rather than after the user has paid for a request.
 */
export function chatCanSeeImages(): boolean {
  return isVisionCapable(chatModel());
}
