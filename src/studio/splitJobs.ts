// R3 — split-on-import as a JOB, not a side effect.
//
// The splitter itself is src/cad/understanding (splitAndSaveDrawing): the
// package is keyed by the source hash and later consumers LOAD rather than
// re-run, so a job here only ever spends model calls on a drawing that has no
// current package. Policy (open question 1's leaning): a job is QUEUED by
// import, but it RUNS only when the user opens that drawing or presses Split;
// "Split all" is an explicit act. It never auto-runs on page load.
//
// Cost is reported honestly, the way the BBS tab does: the transport below
// asks OpenRouter to include usage and adds every round's cost to the job.
//
// R3 seam: the register entry TYPE now carries `splitStatus`/`packageHash`
// (src/register/types.ts §7), but src/register/register.ts owns every entry
// write and exposes no patch for them yet — its reconcile pass would drop a
// side-written value on the next import. So the LIVE status stays here, keyed
// by documentId, and realData derives the register's state dot from job +
// package + hash (nodeStateFor). When register.ts accepts the two fields,
// runSplit's completion is the one place that writes them.

import { useSyncExternalStore } from 'react';
import { getAiConfig, isAiConfigured } from '../cad/ai/config';
import { messageFromErrorBody } from '../cad/ai/openrouter';
import type { CadDocument } from '../cad/types';
import {
  defaultRenderer,
  readResidualsAndSave,
  validateAndSave,
  validationReport,
  verdictReport,
  sheetBounds,
  splitAndSaveDrawing,
  type ChatTransport,
  type DrawingUnderstandingPackage,
} from '../cad/understanding';

export type SplitRunStatus = 'queued' | 'splitting' | 'split' | 'failed';

export interface SplitJob {
  documentId: string;
  projectId: string;
  status: SplitRunStatus;
  /** live progress lines, oldest first */
  progress: string[];
  /** model rounds taken so far */
  rounds: number;
  /** summed off the usage blocks; 0 until the first reply lands */
  costUsd: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  /** how many sections the finished run produced */
  sectionCount: number | null;
}

const jobs = new Map<string, SplitJob>();
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const fn of [...listeners]) fn();
}

export function splitJobFor(documentId: string): SplitJob | null {
  return jobs.get(documentId) ?? null;
}

export function useSplitJobs(): number {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
  );
}

/** tests only */
export function resetSplitJobsForTest(): void {
  jobs.clear();
  emit();
}

function patchJob(documentId: string, patch: Partial<SplitJob>): void {
  const cur = jobs.get(documentId);
  if (!cur) return;
  jobs.set(documentId, { ...cur, ...patch });
  emit();
}

/**
 * Mark a freshly imported drawing as awaiting its split. Idempotent; never
 * touches a job that is running or finished.
 */
export function queueSplit(projectId: string, documentId: string): void {
  const cur = jobs.get(documentId);
  if (cur && cur.status !== 'failed') return;
  if (cur?.status === 'failed') return; // a failed run waits for an explicit Split
  jobs.set(documentId, {
    documentId,
    projectId,
    status: 'queued',
    progress: [],
    rounds: 0,
    costUsd: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
    sectionCount: null,
  });
  emit();
}

/**
 * Same POST as the splitter's own transport, plus `usage: {include: true}` so
 * every reply carries its cost — the honesty line §3.1 asks for.
 */
function costTrackingTransport(onUsage: (costUsd: number) => void): ChatTransport {
  return async (req) => {
    const cfg = getAiConfig();
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
        max_tokens: 8_000,
        reasoning: { effort: 'low' },
        usage: { include: true },
        tools: req.tools,
        messages: req.messages,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(messageFromErrorBody(res.status, body));
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; reasoning?: string; reasoning_content?: string } }[];
      usage?: { cost?: number };
    };
    if (typeof json.usage?.cost === 'number') onUsage(json.usage.cost);
    const message = json.choices?.[0]?.message;
    const reasoning =
      typeof message?.reasoning === 'string'
        ? message.reasoning
        : typeof message?.reasoning_content === 'string'
          ? message.reasoning_content
          : '';
    return {
      content: typeof message?.content === 'string' ? message.content : '',
      toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
      reasoning,
    };
  };
}

/** "3 model calls · $0.0042 · 84s" — the same shape the BBS run line uses. */
export function splitCostLine(job: SplitJob): string {
  const calls = `${job.rounds} model call${job.rounds === 1 ? '' : 's'}`;
  const cost = `$${job.costUsd.toFixed(4)}`;
  const end = job.finishedAt ?? Date.now();
  const secs = job.startedAt ? `${Math.max(1, Math.round((end - job.startedAt) / 1000))}s` : '';
  return [calls, cost, secs].filter(Boolean).join(' · ');
}

/**
 * Run the split for one drawing. The caller has already established consent
 * (the user opened the drawing, or pressed Split / Split all) — this function
 * still refuses to run unpaid-for work twice concurrently and refuses to run
 * with no key rather than failing mid-flight.
 */
export async function runSplit(
  projectId: string,
  doc: CadDocument,
  opts: { sourceBytes?: ArrayBuffer | Uint8Array | null } = {},
): Promise<DrawingUnderstandingPackage | null> {
  const existing = jobs.get(doc.id);
  if (existing?.status === 'splitting') return null;
  if (!isAiConfigured()) {
    queueSplit(projectId, doc.id);
    patchJob(doc.id, {
      progress: ['waiting for an OpenRouter key — set VITE_OPENROUTER_API_KEY in .env and restart.'],
    });
    return null;
  }

  jobs.set(doc.id, {
    documentId: doc.id,
    projectId,
    status: 'splitting',
    progress: ['reading the sheet…'],
    rounds: 0,
    costUsd: 0,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    sectionCount: null,
  });
  emit();

  try {
    // Whole-sheet overview for orientation — the splitter's own renderer.
    let overview: string | null = null;
    const sheet = sheetBounds(doc);
    if (sheet) overview = await defaultRenderer(doc, sheet, 1100).catch(() => null);

    const pkg = await splitAndSaveDrawing(doc, {
      projectId,
      sourceBytes: opts.sourceBytes ?? null,
      overview,
      transport: costTrackingTransport((cost) => {
        const cur = jobs.get(doc.id);
        if (cur) patchJob(doc.id, { costUsd: cur.costUsd + cost });
      }),
      // the transport above wraps the real endpoint — say so (see SplitOptions.source)
      source: 'model',
      onEvent: (e) => {
        const cur = jobs.get(doc.id);
        if (!cur) return;
        patchJob(doc.id, {
          rounds: Math.max(cur.rounds, e.step),
          progress: [...cur.progress, `step ${e.step} · ${e.ask} → ${e.served}`].slice(-200),
        });
      },
    });
    patchJob(doc.id, {
      status: 'split',
      finishedAt: Date.now(),
      sectionCount: pkg.sections.length,
    });
    return pkg;
  } catch (err) {
    patchJob(doc.id, {
      status: 'failed',
      finishedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// the second pass — reading the leftovers
// ---------------------------------------------------------------------------
//
// A SEPARATE job from the split, for the same reason it is a separate stage:
// it asks a different question of a much smaller payload, and it must be
// re-runnable on its own. A key that arrives late, or a first attempt that hit
// a rate limit, should cost one cheap re-read of the leftovers — not a whole
// re-cut of a sheet that was already split correctly.
//
// It reuses the split job's record so one drawing has ONE visible state: the
// progress lines and the cost land in the same place the split's did, and the
// register cannot show "split" while a second pass is still running.

/**
 * Read every unread piece of `doc` that the split left behind, and file it.
 *
 * Returns null if there is nothing to read, no key, or a job is already in
 * flight — the same contract as `runSplit`, so callers can treat them alike.
 */
export async function runSecondPass(
  projectId: string,
  doc: CadDocument,
  pkg: DrawingUnderstandingPackage,
): Promise<DrawingUnderstandingPackage | null> {
  const existing = jobs.get(doc.id);
  if (existing?.status === 'splitting') return null;
  if (!isAiConfigured()) {
    patchJob(doc.id, {
      progress: ['waiting for an OpenRouter key — the second pass reads the leftovers.'],
    });
    return null;
  }

  const before = jobs.get(doc.id);
  jobs.set(doc.id, {
    documentId: doc.id,
    projectId,
    status: 'splitting',
    progress: [...(before?.progress ?? []), 'second pass — reading what was left over…'].slice(-200),
    rounds: before?.rounds ?? 0,
    costUsd: before?.costUsd ?? 0,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    sectionCount: before?.sectionCount ?? pkg.sections.length,
  });
  emit();

  try {
    const next = await readResidualsAndSave(doc, pkg, {
      transport: costTrackingTransport((cost) => {
        const cur = jobs.get(doc.id);
        if (cur) patchJob(doc.id, { costUsd: cur.costUsd + cost });
      }),
      onEvent: (e) => {
        const cur = jobs.get(doc.id);
        if (!cur) return;
        patchJob(doc.id, {
          rounds: cur.rounds + 1,
          progress: [...cur.progress, `${e.gapId} → ${e.status}${e.note ? ` · ${e.note}` : ''}`].slice(-200),
        });
      },
    });
    const read = (next.residuals ?? []).filter((r) => r.status === 'read').length;
    patchJob(doc.id, {
      status: 'split',
      finishedAt: Date.now(),
      progress: [
        ...(jobs.get(doc.id)?.progress ?? []),
        `second pass done — ${read} of ${next.residuals?.length ?? 0} unread pieces read`,
      ].slice(-200),
    });
    return next;
  } catch (err) {
    patchJob(doc.id, {
      status: 'failed',
      finishedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// step 8 — does each section hold what its area of the drawing holds?
// ---------------------------------------------------------------------------
//
// The cheapest stage of the three, and usually free: the deterministic pass
// settles every section that matches, and only the residue of what it could
// not decide is ever sent anywhere. On a clean drawing that is no calls at all.

export async function runValidation(
  projectId: string,
  doc: CadDocument,
  pkg: DrawingUnderstandingPackage,
  /** ask about EVERY section's content — one call each, not just the residue */
  deep = false,
): Promise<DrawingUnderstandingPackage | null> {
  if (jobs.get(doc.id)?.status === 'splitting') return null;

  const before = jobs.get(doc.id);
  jobs.set(doc.id, {
    documentId: doc.id,
    projectId,
    status: 'splitting',
    progress: [
      ...(before?.progress ?? []),
      deep
        ? `checking all ${pkg.sections.length} sections with the model, one at a time…`
        : `validating ${pkg.sections.length} sections…`,
    ].slice(-200),
    rounds: before?.rounds ?? 0,
    costUsd: before?.costUsd ?? 0,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    sectionCount: before?.sectionCount ?? pkg.sections.length,
  });
  emit();

  try {
    const next = await validateAndSave(doc, pkg, {
      deep,
      // No key is not a reason to skip the check — the deterministic half is
      // the greater half, and it needs nothing.
      offline: !isAiConfigured(),
      transport: costTrackingTransport((cost) => {
        const cur = jobs.get(doc.id);
        if (cur) patchJob(doc.id, { costUsd: cur.costUsd + cost });
      }),
      onEvent: (e) => {
        const cur = jobs.get(doc.id);
        if (!cur) return;
        patchJob(doc.id, {
          progress: [...cur.progress, `${e.sectionId} → ${e.status}${e.asked ? ' (reviewed)' : ''}`].slice(-200),
        });
      },
    });
    const v = next.validations ?? [];
    const failed = v.filter((x) => x.status === 'FAIL').length;
    const warned = v.filter((x) => x.status === 'WARNING').length;
    if (import.meta.env?.MODE !== 'test') {
      // eslint-disable-next-line no-console
      console.log(validationReport(v).join('\n'));
    }
    patchJob(doc.id, {
      status: 'split',
      finishedAt: Date.now(),
      progress: [
        ...(jobs.get(doc.id)?.progress ?? []),
        `validation done — ${v.length - failed - warned} pass, ${warned} warning, ${failed} fail`,
      ].slice(-200),
    });
    return next;
  } catch (err) {
    patchJob(doc.id, {
      status: 'failed',
      finishedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
