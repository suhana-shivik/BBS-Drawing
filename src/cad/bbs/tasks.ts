// ============================================================
// Tasks — what the orchestrator delegates, and what comes back.
//
// WHY A TASK RATHER THAN A STEP
//
// Every run up to 010 was one model walking one loop. Run 010's trail shows the
// cost plainly: the SC detail, the C2 detail, the TB detail and the wall section
// are four INDEPENDENT questions, and it spent one sequential turn on each —
// then re-read the sheet structure stage 1 had already established, because that
// structure arrived as prose to re-read rather than state to consult.
//
// A task fixes both. Independent questions are dispatched together in one batch,
// and what comes back is structured — findings, evidence, confidence, what is
// still open — so the orchestrator consults a board instead of re-reading a
// transcript.
//
// WHAT A SPECIALIST IS
//
// NOT a fixed cast of eight agents with permanent jobs. There is no Ownership
// Agent. There is a mechanism for asking one focused question with the drawing
// tools available, and the orchestrator writes the question. "Read the SC detail
// and say which callouts it draws" and "decide whether BAND-01 is the whole job"
// run through exactly the same code.
//
// A SPECIALIST MAY RETURN NOTHING BUT EVIDENCE. It is not required to reach an
// engineering conclusion, and a task that reports "I looked and it is still
// ambiguous" has done its job — that is a finding the orchestrator can act on,
// and far better than a confident guess.
// ============================================================
import {
  arrayOf, enumOf, num, object, optional, passthrough, required, str,
  validate, explain, type Validator,
} from './schema';
import { isImageResult, runToolAsync, type ToolContext, type ToolRequest } from './tools';
import { validImage } from './render';
import { skillBriefing } from './knowledge';

// ------------------------------------------------------------
// the task
// ------------------------------------------------------------

export type TaskStatus =
  | 'planned'
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs-more-evidence'
  | 'superseded';

export interface Task {
  taskId: string;
  /** the orchestrator's own words — there is no fixed set of task types */
  type: string;
  objective: string;
  /** area ids, member ids, evidence ids — whatever the question is about */
  inputs: string[];
  /** what the orchestrator thinks will answer it; the specialist may disagree */
  requestedEvidence: string[];
  status: TaskStatus;
  /** the task this one replaces, when the plan changed */
  supersedes?: string;
  createdAtStep: number;
  result?: TaskResult;
}

export interface Finding {
  statement: string;
  evidenceIds: string[];
  /** images the conclusion actually rests on — visual provenance, not decoration */
  imageIds: string[];
  confidence: number;
}

export interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'needs-more-evidence';
  findings: Finding[];
  evidenceIds: string[];
  imagesInspected: string[];
  confidence: number;
  unresolved: string[];
  conflicts: string[];
  /** what the specialist thinks should happen next — advice, never an order */
  recommendations: string[];
  /** decisions it proposes; the orchestrator decides whether to accept them */
  proposals: unknown[];
  toolCalls: number;
  aiCalls: number;
  /** the raw reply, kept when it could not be read at all */
  malformed?: string;
}

// ------------------------------------------------------------
// what a specialist may reply
// ------------------------------------------------------------

const FINDING = object({
  statement: required(str({ min: 1 })),
  evidenceIds: optional(arrayOf(str())),
  imageIds: optional(arrayOf(str())),
  confidence: optional(num({ min: 0, max: 1 })),
}, { name: 'a finding' });

export const SPECIALIST_REPLY: Validator<{
  thinking?: string;
  requestTools?: ToolRequest[];
  findings?: { statement: string; evidenceIds?: string[]; imageIds?: string[]; confidence?: number }[];
  unresolved?: string[];
  conflicts?: string[];
  recommendations?: string[];
  proposals?: unknown[];
  confidence?: number;
  done?: boolean;
}> = object({
  thinking: optional(str()),
  requestTools: optional(arrayOf(object({
    tool: required(str({ min: 1 })),
    args: optional(passthrough('the tool\'s arguments')),
  }, { name: 'a tool request' }))),
  findings: optional(arrayOf(FINDING)),
  unresolved: optional(arrayOf(str())),
  conflicts: optional(arrayOf(str())),
  recommendations: optional(arrayOf(str())),
  proposals: optional(arrayOf(passthrough('a proposed decision'))),
  confidence: optional(num({ min: 0, max: 1 })),
  done: optional(passthrough('true when the question is answered as far as it can be')),
}, { name: 'a specialist reply' });

// ------------------------------------------------------------
// the board — structured state, not a transcript
// ------------------------------------------------------------

export class TaskBoard {
  private readonly tasks = new Map<string, Task>();
  private seq = 0;

  create(spec: Omit<Task, 'taskId' | 'status' | 'createdAtStep'> & { status?: TaskStatus }, atStep: number): Task {
    this.seq += 1;
    const task: Task = {
      taskId: `TASK-${String(this.seq).padStart(3, '0')}`,
      status: spec.status ?? 'planned',
      createdAtStep: atStep,
      ...spec,
    } as Task;
    this.tasks.set(task.taskId, task);
    if (spec.supersedes) {
      const old = this.tasks.get(spec.supersedes);
      if (old && old.status !== 'completed') old.status = 'superseded';
    }
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  all(): Task[] {
    return [...this.tasks.values()];
  }

  byStatus(...s: TaskStatus[]): Task[] {
    return this.all().filter((t) => s.includes(t.status));
  }

  /** everything waiting to run — the batch the orchestrator dispatches */
  runnable(): Task[] {
    return this.byStatus('planned', 'pending');
  }

  record(id: string, result: TaskResult): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.result = result;
    t.status = result.status;
  }

  /**
   * The board as the orchestrator reads it.
   *
   * Deliberately terse. This is consulted every turn, and a board that costs a
   * thousand tokens to read is a board that crowds out the drawing.
   */
  render(limit = 40): string {
    const all = this.all();
    if (!all.length) return '  (no tasks yet)';
    const lines = all.slice(-limit).map((t) => {
      const head = `  ${t.taskId} [${t.status}] ${t.type}: ${t.objective.slice(0, 110)}`;
      if (!t.result) return head;
      const bits: string[] = [];
      for (const f of t.result.findings.slice(0, 4)) {
        bits.push(`      · ${f.statement.slice(0, 160)}${f.confidence ? ` (${f.confidence})` : ''}`);
      }
      for (const u of t.result.unresolved.slice(0, 3)) bits.push(`      ? still open: ${u.slice(0, 140)}`);
      for (const c of t.result.conflicts.slice(0, 2)) bits.push(`      ! conflict: ${c.slice(0, 140)}`);
      // an adoptable proposal is the whole point of delegating — it must be
      // VISIBLE to the lead, not buried in a task record nobody re-reads
      for (const pr of t.result.proposals.slice(0, 3)) {
        bits.push(`      > proposes: ${JSON.stringify(pr).slice(0, 150)}`);
      }
      return [head, ...bits].join('\n');
    });
    const hidden = all.length - Math.min(all.length, limit);
    return [...(hidden > 0 ? [`  (${hidden} earlier task(s) not shown)`] : []), ...lines].join('\n');
  }
}

// ------------------------------------------------------------
// running one specialist
// ------------------------------------------------------------

export interface SpecialistContext {
  toolCtx: ToolContext;
  /** the shared drawing briefing every specialist opens with */
  briefing: string;
  ask(args: {
    system: string;
    prompt: string;
    images: { dataUrl: string; caption: string }[];
    label: string;
  }): Promise<Record<string, unknown> | null>;
  /** images already rendered this run, so a crop is never paid for twice */
  imageCache: Map<string, { dataUrl: string; caption: string; imageId: string }>;
  maxTurns?: number;
  maxToolCalls?: number;
  /**
   * Absolute time past which no new specialist turn may START.
   *
   * RUN 013 DIED WITHOUT THIS. The batch held the thread until every task
   * settled; four hung requests settled twenty-one minutes later, and the
   * orchestrator's review turn — the one that would have collected the
   * findings — never came. A deadline makes "return control to the lead"
   * something the machine guarantees rather than hopes for.
   */
  deadline?: number;
  now?: () => number;
  onEvent?: (e: { taskId: string; kind: string; detail: string }) => void;
}

export const SPECIALIST_SYSTEM = `You are a structural engineer investigating ONE question about ONE reinforcement drawing.

You were given this question by the engineer leading the job. Answer only it. Do not attempt the whole schedule, and do not answer a question you were not asked — someone else is working on those, and a conclusion you reach in passing will not carry the evidence to defend it.

## HOW TO WORK

Ask for the evidence you need. Independent requests go in ONE turn, not one per turn. Look at the drawing when the structured evidence cannot answer you — a crop settles what a parser could not.

WHEN A STRUCTURED TOOL RETURNS NOTHING, that means EXTRACTION failed, not that the drawing lacks it. The line is almost certainly drawn. Asking again returns nothing again. Ask for a picture of that area instead.

## WHAT YOU RETURN

One json object:

{"thinking":"one line on what you are doing",
 "requestTools":[{"tool":"getDrawingRegionImage","args":{"regionId":"REGION-07","reason":"read its callouts"}}],
 "findings":[],
 "done":false}

When you have looked enough:

{"findings":[{"statement":"CALL-009 and CALL-014 sit inside the captioned SC detail and their leaders terminate on the section bars",
              "evidenceIds":["CALL-009","CALL-014","DECL-07"],"imageIds":["IMG-03"],"confidence":0.9}],
 "unresolved":["whether CALL-013 belongs to the same detail — its leader leaves the crop"],
 "conflicts":["TASK-004 put CALL-009 in the C1 detail; its leader terminates on the SC section, so TASK-004 is wrong"],
 "recommendations":["a wider crop east of the SC detail would settle CALL-013"],
 "proposals":[],
 "confidence":0.85,
 "done":true}

## PROPOSALS

A proposal, when you make one, must be phrased in the lead engineer's conclusion vocabulary so it can be adopted verbatim — {"kind":"own","calloutId":"CALL-009","memberId":"MEM-01","basis":"in-detail","barType":"MAIN","evidenceIds":["CALL-009"]} or {"kind":"placement","memberId":"MEM-05","placement":{"kind":"template-repeat","panelId":"BAND-01","runFactId":"run","orderedOccurrenceIds":["MARK-…","…"]}} — a placement carries its kind's OWN required fields, and every id must be one a tool returned, never prose. A proposal in any other shape cannot be used. No defensible proposal? Leave "proposals" empty — findings and unresolved are a complete answer.

## THE RULES

"unresolved", "conflicts" and "recommendations" are lists of PLAIN SENTENCES — one string each, not objects. Put the ids you mean inside the sentence.

A FINDING MUST BE SOMETHING YOU SAW. Cite the evidence ids a tool returned and the images you actually looked at. A statement with no evidence behind it is worth less than saying you could not tell.

YOU MAY RETURN ONLY EVIDENCE. You are not required to reach a conclusion. "I looked at X and Y and it is still ambiguous because Z" is a complete, useful answer — put it in "unresolved" and say what would settle it.

NEVER INVENT. Not a dimension, not a count, not a spacing, not a bar. If the drawing does not say it, the answer is that the drawing does not say it.

SAY HOW SURE YOU ARE, and let it be low when it should be.`;

// What is actually sent. Harness rules first, the trade reference second:
// skillBriefing() closes by saying the instructions above win where the two
// disagree, so the order is the tie-break. A specialist needs this more than
// anyone — the callout dialect it decodes (`10TOR@200C/C`, `4L-8TOR@150C/C`)
// is documented there and nowhere else in these prompts.
export const SPECIALIST_SYSTEM_SENT = `${SPECIALIST_SYSTEM}

${skillBriefing()}`;

/**
 * Run one task to completion, or to its turn limit.
 *
 * The specialist gets its own short loop because a question worth delegating is
 * usually worth two or three looks — but it is capped hard, since a specialist
 * that wanders is just the monolithic loop again wearing a different hat.
 */
export async function runSpecialist(task: Task, ctx: SpecialistContext): Promise<TaskResult> {
  const maxTurns = ctx.maxTurns ?? 3;
  const maxToolCalls = ctx.maxToolCalls ?? 12;

  const result: TaskResult = {
    taskId: task.taskId,
    status: 'needs-more-evidence',
    findings: [],
    evidenceIds: [],
    imagesInspected: [],
    confidence: 0,
    unresolved: [],
    conflicts: [],
    recommendations: [],
    proposals: [],
    toolCalls: 0,
    aiCalls: 0,
  };

  const transcript: string[] = [
    `THE QUESTION: ${task.objective}`,
    task.inputs.length ? `It concerns: ${task.inputs.join(', ')}` : '',
    task.requestedEvidence.length
      ? `The lead engineer suggests looking at: ${task.requestedEvidence.join(', ')} — use your own judgement if something else would answer it better.`
      : '',
  ].filter(Boolean);

  const tried = new Map<string, boolean>();
  const signature = (r: ToolRequest): string => `${r.tool}(${JSON.stringify(r.args ?? {}, Object.keys(r.args ?? {}).sort())})`;
  let pending: { dataUrl: string; caption: string }[] = [];
  let feedback = '';

  const nowFn = ctx.now ?? Date.now;
  for (let turn = 1; turn <= maxTurns; turn++) {
    if (ctx.deadline !== undefined && nowFn() >= ctx.deadline) {
      result.unresolved.push('the run deadline arrived before this question was finished');
      break;
    }
    const images = pending;
    pending = [];
    result.aiCalls += 1;

    const raw = await ctx.ask({
      system: SPECIALIST_SYSTEM_SENT,
      prompt: [
        ctx.briefing,
        '',
        '--- YOUR TASK ---',
        ...transcript,
        feedback ? `\n${feedback}` : '',
        '',
        `Turn ${turn} of ${maxTurns}. ${result.toolCalls}/${maxToolCalls} tool calls used.`,
        images.length ? `${images.length} image(s) from your last request are attached.` : '',
      ].filter(Boolean).join('\n'),
      images,
      label: task.taskId,
    });
    feedback = '';

    if (!raw) {
      transcript.push(`(turn ${turn}: no reply)`);
      continue;
    }

    // THE GATE. Nothing below this line touches an unvalidated field.
    const checked = validate(raw, SPECIALIST_REPLY);
    if (!checked.ok) {
      feedback = explain(checked.problems);
      result.malformed = JSON.stringify(raw).slice(0, 1200);
      ctx.onEvent?.({ taskId: task.taskId, kind: 'malformed', detail: checked.problems.map((p) => p.path).join(', ') });
      continue;
    }
    const reply = checked.value;

    for (const f of reply.findings ?? []) {
      result.findings.push({
        statement: f.statement,
        evidenceIds: f.evidenceIds ?? [],
        imageIds: f.imageIds ?? [],
        confidence: f.confidence ?? 0.5,
      });
      for (const id of f.evidenceIds ?? []) if (!result.evidenceIds.includes(id)) result.evidenceIds.push(id);
    }
    result.unresolved.push(...(reply.unresolved ?? []));
    result.conflicts.push(...(reply.conflicts ?? []));
    result.recommendations.push(...(reply.recommendations ?? []));
    result.proposals.push(...(reply.proposals ?? []));
    if (typeof reply.confidence === 'number') result.confidence = reply.confidence;

    const wants = reply.requestTools ?? [];
    if (!wants.length || reply.done === true) {
      result.status = result.findings.length ? 'completed' : 'needs-more-evidence';
      break;
    }

    for (const req of wants) {
      if (result.toolCalls >= maxToolCalls) {
        transcript.push('(tool budget spent — answer with what you have)');
        break;
      }
      const sig = signature(req);
      if (tried.get(sig) === false) {
        transcript.push(`${sig}: ALREADY TRIED and returned nothing. Extraction cannot resolve it — ask for a picture of that area instead.`);
        continue;
      }
      // a crop already rendered this run is reused rather than re-billed
      const cached = ctx.imageCache.get(sig);
      if (cached) {
        pending.push({ dataUrl: cached.dataUrl, caption: cached.caption });
        result.imagesInspected.push(cached.imageId);
        transcript.push(`${sig}: (already rendered — ${cached.imageId} attached again)`);
        continue;
      }

      result.toolCalls += 1;
      const res = await runToolAsync(ctx.toolCtx, req);
      tried.set(sig, res.ok);

      if (isImageResult(res) && validImage(res.image)) {
        const imageId = `IMG-${ctx.imageCache.size + 1}`;
        const caption = `${imageId} — ${res.text.split('\n')[0]}`;
        ctx.imageCache.set(sig, { dataUrl: res.image, caption, imageId });
        pending.push({ dataUrl: res.image, caption });
        result.imagesInspected.push(imageId);
        transcript.push(`${req.tool}(${JSON.stringify(req.args ?? {})}) → ${imageId}:`, res.text.slice(0, 2500));
      } else {
        transcript.push(`${req.tool}(${JSON.stringify(req.args ?? {})}):`, res.text.slice(0, 2500));
      }
      for (const id of res.evidenceIds) if (!result.evidenceIds.includes(id)) result.evidenceIds.push(id);
    }
  }

  if (result.status === 'needs-more-evidence' && result.findings.length) result.status = 'completed';
  return result;
}

/**
 * Run a batch of tasks together.
 *
 * Independent questions are what a batch is FOR. Run 010 investigated four
 * unrelated details in four sequential turns; there was never a reason for the
 * second to wait on the first. Concurrency is capped so a large plan cannot
 * open fifty sockets at once.
 */
export async function runBatch(
  tasks: readonly Task[],
  ctx: SpecialistContext,
  concurrency = 4,
): Promise<TaskResult[]> {
  const out: TaskResult[] = [];
  const nowFn = ctx.now ?? Date.now;
  for (let i = 0; i < tasks.length; i += concurrency) {
    // control goes back to the lead AT the deadline, with the untouched tasks
    // honestly marked — not after the last socket finally gives up
    if (ctx.deadline !== undefined && nowFn() >= ctx.deadline) {
      for (const t of tasks.slice(i)) {
        out.push({
          taskId: t.taskId, status: 'needs-more-evidence', findings: [], evidenceIds: [],
          imagesInspected: [], confidence: 0,
          unresolved: ['not started — the run deadline arrived before this task could begin'],
          conflicts: [], recommendations: [], proposals: [], toolCalls: 0, aiCalls: 0,
        });
      }
      break;
    }
    const slice = tasks.slice(i, i + concurrency);
    const done = await Promise.all(
      slice.map((t) =>
        runSpecialist(t, ctx).catch((err): TaskResult => ({
          taskId: t.taskId,
          status: 'failed',
          findings: [],
          evidenceIds: [],
          imagesInspected: [],
          confidence: 0,
          unresolved: [`the investigation itself failed: ${(err as Error).message}`],
          conflicts: [],
          recommendations: [],
          proposals: [],
          toolCalls: 0,
          aiCalls: 0,
        })),
      ),
    );
    out.push(...done);
  }
  return out;
}

export const TASK_STATUSES: readonly TaskStatus[] = [
  'planned', 'pending', 'running', 'completed', 'failed', 'needs-more-evidence', 'superseded',
];

export const taskStatusValidator = enumOf(TASK_STATUSES as readonly string[]);
