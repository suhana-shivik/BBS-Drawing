// ============================================================
// The Assistant — one grounding pass per drawing, shared by every task.
//
// WHY THIS FILE EXISTS
//
// Before it, three separate buttons each fired their own `labelDrawing`:
// `CadAnalyze` (mounted twice — inside the chat modal AND in the Inspector's
// Drawing tab) and `BoqPanel`. Chat added two more calls per question. Nothing
// was shared, so the same drawing was read cold three or four times, each read
// free to reach a different conclusion about the same symbol.
//
// The fix is not one giant request that answers everything at once. That would
// make an electrical SLD pay for rebar interpretation, dilute every sub-task in
// one oversized context, and lose all of it to a single failure. The fix is one
// shared UNDERSTANDING:
//
//   1. Deterministic facts cost nothing and are always present — units, grades,
//      cover, marks, table and callout counts. Available the instant a drawing
//      opens, before any key is configured.
//   2. ONE paid grounding pass per drawing assigns meaning to the unknown keys
//      and reads what kind of sheet this is. It runs once. Concurrent callers
//      share the same in-flight promise, so opening Quantities and BBS together
//      cannot bill twice.
//   3. Every task afterwards is a narrow delta on top of it. Quantities needs
//      no request of its own at all — the names it wants are what grounding
//      produced.
//
// The rule the whole project runs on is unchanged and is the reason grounding
// is safe to share: the model assigns MEANING, the engine computes every
// NUMBER. Nothing cached here is a quantity, so a stale record can never put a
// wrong figure in a bill.
// ============================================================
import type { CadDocument } from '../types';
import { extractDrawing } from '../bbs/extract';
import type { DrawingExtract } from '../bbs/types';
import { labelDrawing } from './index';
import type { AiProgress } from './openrouter';
import { isAiConfigured } from './config';
import { remember } from './memory';

const LS_KEY = 'bimcad.understanding';

/** What the drawing tells us for free. No request, no key, no cost. */
export interface DrawingFacts {
  unitScale: number;
  concreteGrade?: string;
  steelGrade?: string;
  coverMm?: number;
  marks: string[];
  tableCount: number;
  calloutCount: number;
  calloutsRead: number;
  layerCount: number;
  blockCount: number;
  entityCount: number;
}

/**
 * What we have established about one drawing.
 *
 * `facts` is deterministic and always present. Everything below `grounded` is
 * the product of the single paid pass, and is absent until it has run.
 */
export interface DrawingUnderstanding {
  drawing: string;
  at: number;
  facts: DrawingFacts;
  /** true once the one paid pass has completed for this drawing */
  grounded: boolean;
  /** names in place: dictionary hits + rule decodes + model */
  labelled: number;
  ruleLabelled: number;
  modelLabelled: number;
  /** the model's free-text reading of the sheet — shown, never parsed */
  summary?: string;
  model?: string;
  payloadBytes?: number;
}

type Listener = () => void;

const cache = new Map<string, DrawingUnderstanding>();
const inflight = new Map<string, Promise<DrawingUnderstanding>>();
const extracts = new Map<string, DrawingExtract>();
const listeners = new Set<Listener>();

function keyOf(doc: CadDocument): string {
  return doc.sourceFile || doc.name;
}

export function subscribeAssistant(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* one broken listener must not stop the rest */
    }
  }
}

// ------------------------------------------------------------
// persistence — so reopening a drawing does not re-pay
// ------------------------------------------------------------

function loadStore(): Record<string, DrawingUnderstanding> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, DrawingUnderstanding>;
  } catch {
    /* corrupt — start clean rather than throw */
  }
  return {};
}

function persist(u: DrawingUnderstanding): void {
  try {
    const store = loadStore();
    store[u.drawing] = u;
    // grounding records are small; keep the last 40 drawings
    const keys = Object.keys(store);
    if (keys.length > 40) for (const k of keys.slice(0, keys.length - 40)) delete store[k];
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    /* quota — the in-memory cache still serves this session */
  }
}

// ------------------------------------------------------------
// the free half
// ------------------------------------------------------------

/**
 * The deterministic extract, computed once per drawing and reused.
 *
 * BBS needs it, grounding needs it for grades and marks, and the Read tab
 * shows it before anything is sent. Running it three times would be wasteful
 * on a large sheet, so it is memoised here rather than at each call site.
 */
export function drawingExtract(doc: CadDocument): DrawingExtract | null {
  const k = keyOf(doc);
  const hit = extracts.get(k);
  if (hit) return hit;
  try {
    const ex = extractDrawing(doc);
    extracts.set(k, ex);
    return ex;
  } catch {
    // a drawing we cannot table-read is still a drawing we can label and chat
    // about; extraction failure must not block the rest of the assistant
    return null;
  }
}

function factsOf(doc: CadDocument): DrawingFacts {
  const ex = drawingExtract(doc);
  return {
    unitScale: doc.unitScale,
    concreteGrade: ex?.notes.concreteGrade,
    steelGrade: ex?.notes.steelGrade,
    coverMm: ex?.notes.coverMm,
    marks: ex?.marks ?? [],
    tableCount: ex?.tables.length ?? 0,
    calloutCount: ex?.callouts.length ?? 0,
    calloutsRead: ex?.callouts.filter((c) => c.diaMm !== undefined).length ?? 0,
    layerCount: doc.layers.size,
    blockCount: doc.blocks.size,
    entityCount: doc.entities.length,
  };
}

/**
 * What we know without spending anything. Safe to call on every render — the
 * expensive half is memoised and the rest is map sizes.
 */
export function baseUnderstanding(doc: CadDocument): DrawingUnderstanding {
  const k = keyOf(doc);
  const cached = cache.get(k) ?? loadStore()[k];
  if (cached) {
    // facts are re-derived: the document may have been re-parsed since
    const merged = { ...cached, facts: factsOf(doc) };
    cache.set(k, merged);
    return merged;
  }
  const fresh: DrawingUnderstanding = {
    drawing: k,
    at: Date.now(),
    facts: factsOf(doc),
    grounded: false,
    labelled: 0,
    ruleLabelled: 0,
    modelLabelled: 0,
  };
  cache.set(k, fresh);
  return fresh;
}

export function isGrounded(doc: CadDocument): boolean {
  return baseUnderstanding(doc).grounded;
}

// ------------------------------------------------------------
// the paid half — exactly once
// ------------------------------------------------------------

export interface GroundOptions {
  signal?: AbortSignal;
  onProgress?: (p: AiProgress) => void;
  /** ignore the cache and read the drawing again */
  force?: boolean;
}

/**
 * Ground this drawing, at most once.
 *
 * The in-flight map is the load-bearing part: Quantities and BBS opened
 * together, or a double-invoked effect under StrictMode, all await the SAME
 * promise. That is what makes a single umbrella real rather than cosmetic —
 * the guarantee lives here, not in the buttons.
 */
export async function ensureGrounded(
  doc: CadDocument,
  opts: GroundOptions = {},
): Promise<DrawingUnderstanding> {
  const k = keyOf(doc);
  const current = baseUnderstanding(doc);
  if (current.grounded && !opts.force) return current;

  const running = inflight.get(k);
  if (running && !opts.force) return running;

  if (!isAiConfigured()) {
    throw new Error('Add your OpenRouter key first — the drawing has not been read yet.');
  }

  const job = (async (): Promise<DrawingUnderstanding> => {
    const res = await labelDrawing(doc, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    const modelLabelled = res.result.labels.length;
    const next: DrawingUnderstanding = {
      drawing: k,
      at: Date.now(),
      facts: factsOf(doc),
      grounded: true,
      labelled: res.labels.size,
      ruleLabelled: res.ruleLabelled.length,
      modelLabelled,
      summary: res.result.summary,
      model: res.model,
      payloadBytes: res.payloadBytes,
    };
    cache.set(k, next);
    persist(next);
    recordFacts(doc, next);
    notify();
    return next;
  })();

  inflight.set(k, job);
  try {
    return await job;
  } finally {
    inflight.delete(k);
  }
}

/**
 * Write the grounding result into memory as statements.
 *
 * Statements only — never a quantity. `memory.ts` says so in its header and
 * this is the main producer, so it is the main place that rule could be
 * broken. Counts of NAMES are safe (they describe the labelling, not the
 * building); counts of BARS or metres are not, and none are written here.
 */
function recordFacts(doc: CadDocument, u: DrawingUnderstanding): void {
  const f = u.facts;
  if (f.concreteGrade) {
    remember(doc, { kind: 'finding', text: `Concrete grade on this sheet: ${f.concreteGrade}` });
  }
  if (f.steelGrade) {
    remember(doc, { kind: 'finding', text: `Steel grade on this sheet: ${f.steelGrade}` });
  }
  if (f.coverMm !== undefined) {
    remember(doc, { kind: 'finding', text: `Clear cover stated on this sheet: ${f.coverMm} mm` });
  }
  if (f.marks.length) {
    remember(doc, {
      kind: 'finding',
      text: `Element marks on this sheet: ${f.marks.slice(0, 24).join(', ')}`,
      refs: f.marks,
    });
  }
  if (u.summary) {
    remember(doc, { kind: 'conclusion', text: u.summary.replace(/\s+/g, ' ').slice(0, 300) });
  }
}

/**
 * The understanding rendered for a prompt.
 *
 * Every downstream task prefixes this, which is the whole point: BBS no longer
 * has to re-derive the concrete grade that grounding already read off the
 * notes, and chat cannot contradict it.
 */
export function understandingContext(doc: CadDocument): string {
  const u = baseUnderstanding(doc);
  const f = u.facts;
  const lines = ['ESTABLISHED ABOUT THIS DRAWING (read once, shared by every task):'];
  lines.push(`  Drawing: ${u.drawing}`);
  if (f.concreteGrade) lines.push(`  Concrete: ${f.concreteGrade}`);
  if (f.steelGrade) lines.push(`  Steel: ${f.steelGrade}`);
  if (f.coverMm !== undefined) lines.push(`  Clear cover: ${f.coverMm} mm`);
  if (f.marks.length) lines.push(`  Element marks: ${f.marks.slice(0, 30).join(', ')}`);
  if (f.tableCount) lines.push(`  Schedule tables read: ${f.tableCount}`);
  if (f.calloutCount) {
    lines.push(`  Reinforcement callouts: ${f.calloutsRead} of ${f.calloutCount} parsed`);
  }
  if (u.summary) lines.push(`  Reading: ${u.summary.replace(/\s+/g, ' ').slice(0, 400)}`);
  return lines.length > 1 ? lines.join('\n') : '';
}

/** Forget one drawing's grounding — the Re-read button. */
export function forgetUnderstanding(doc: CadDocument): void {
  const k = keyOf(doc);
  cache.delete(k);
  extracts.delete(k);
  try {
    const store = loadStore();
    delete store[k];
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    /* best-effort */
  }
  notify();
}
