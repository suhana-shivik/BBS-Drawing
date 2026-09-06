// ============================================================
// Query framing: the model says what it needs to look at, we look.
//
// Answering blind is the weak point of a one-shot chat. The context is a
// summary — top 40 blocks, top 30 layers, 90 text strings — and the question
// is often about something that fell off the end of one of those lists. So
// there is a first pass whose ONLY output is a plan: "to answer this I need
// layer E-LITE, block MCB, and every text containing 'server'".
//
// THE GUARDRAIL IS UNCHANGED, and this file is where it is enforced.
// The model REQUESTS data; it never computes it. `DataRequest` is a closed
// union of five things our own code knows how to measure, every request is
// checked against the drawing's real key list before it is executed (a layer
// the model invented is dropped, exactly as `contract.parseAnalysis` drops an
// invented block name), and `fulfilPlan` answers each one out of
// `takeoff.ts` / `metrics.ts` / `digest.ts`. Nothing the model writes reaches
// the arithmetic — only the choice of what to measure does.
//
// Contract gap, documented rather than worked around: `contract.ts` keeps its
// `extractJson` private, so the fence/preamble stripper below is a second copy
// of that logic. If `extractJson` is ever exported, delete this one.
// ============================================================
import type { CadDocument, CadEntity } from '../types';
import { computeTakeoff, type Takeoff } from '../takeoff';
import { entityFacts, summarise } from '../metrics';
import { collectTexts, type TextHit } from './digest';
import {
  cadEntitiesOfBlock,
  cadEntitiesOnLayer,
  cadSheets,
  getCadSession,
  selectedCadEntities,
} from '../session';
import { getAiConfig, isAiConfigured } from './config';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// ------------------------------------------------------------
// budgets
// ------------------------------------------------------------

/** a plan longer than this is the model asking for the whole drawing again */
export const MAX_NEEDS = 8;
/** names offered to the planner, per kind */
const MAX_INVENTORY = 140;
const MAX_TEXT_MATCHES = 40;
const MAX_QUERY_CHARS = 60;
const MAX_SAMPLES = 8;

// ------------------------------------------------------------
// the closed union — five things this engine knows how to measure
// ------------------------------------------------------------

export type DataRequest =
  | { kind: 'layer'; name: string }
  | { kind: 'block'; name: string }
  | { kind: 'selection' }
  | { kind: 'textSearch'; query: string }
  | { kind: 'sheet'; file: string };

export interface QueryPlan {
  /** the model's one-line reading of what is really being asked */
  intent: string;
  /** validated: every name here exists in the drawing */
  needs: DataRequest[];
  /** requests thrown away, with the reason — shown, never executed */
  dropped: string[];
}

// ------------------------------------------------------------
// the key list — OURS, never the model's
// ------------------------------------------------------------

export interface PlanIndex {
  /** upper-cased name → the drawing's own spelling */
  layers: Map<string, string>;
  blocks: Map<string, string>;
  /** other sheets open in the project, by file name and by basename */
  sheets: Map<string, string>;
  hasSelection: boolean;
}

const upper = (s: string): string => s.trim().toUpperCase();
const basename = (s: string): string => s.split(/[\\/]/).pop() ?? s;

/**
 * Every layer and block name this drawing actually contains.
 *
 * Layers are gathered from the LAYER table AND from the entities themselves,
 * including the ones inside block definitions: a DXF routinely draws on a
 * layer it never declared, and a layer used only inside symbols is invisible
 * to a top-level scan of a drawing that is nothing but INSERTs. Missing a name
 * here does not produce a wrong number — it produces a dropped request, which
 * is the safe direction.
 */
export function buildPlanIndex(doc: CadDocument, others?: readonly CadDocument[]): PlanIndex {
  const layers = new Map<string, string>();
  const blocks = new Map<string, string>();

  const addLayer = (name: string): void => {
    const k = upper(name);
    if (k && !layers.has(k)) layers.set(k, name);
  };
  const addBlock = (name: string): void => {
    const k = upper(name);
    if (k && !blocks.has(k)) blocks.set(k, name);
  };

  for (const name of doc.layers.keys()) addLayer(name);
  for (const b of doc.blocks.values()) {
    addBlock(b.name);
    for (const e of b.entities) {
      addLayer(e.style.layer);
      if (e.type === 'insert') addBlock(e.blockName);
    }
  }
  for (const e of doc.entities) {
    addLayer(e.style.layer);
    if (e.type === 'insert') addBlock(e.blockName);
  }

  const sheets = new Map<string, string>();
  const sheetDocs =
    others ??
    cadSheets()
      .map((s) => s.doc)
      .filter((d) => d !== doc);
  for (const d of sheetDocs) {
    const file = d.sourceFile || d.name;
    if (!file) continue;
    sheets.set(upper(file), file);
    sheets.set(upper(basename(file)), file);
  }

  let hasSelection = false;
  try {
    hasSelection = getCadSession().doc === doc && selectedCadEntities().length > 0;
  } catch {
    /* no session (headless) — a selection request will simply report none */
  }

  return { layers, blocks, sheets, hasSelection };
}

// ------------------------------------------------------------
// prompt
// ------------------------------------------------------------

export const PLAN_SYSTEM = `You are the query planner for a CAD drawing assistant. You do NOT answer the question and you do NOT produce any number.

Your only job: decide which parts of the drawing must be measured or read before the question can be answered honestly, and return that list. The application then executes your list with its own geometry code and hands the measured results to the answering pass.

Request kinds — use ONLY these five:
  {"kind":"layer","name":"<exact layer name>"}   entity count, entity mix, total length, total area, blocks present, sample text on that layer
  {"kind":"block","name":"<exact block name>"}   instance count with MINSERT arrays and nesting included, layers it sits on, what the symbol itself draws
  {"kind":"selection"}                            what the user currently has selected, measured
  {"kind":"textSearch","query":"<substring>"}     every text string on the sheet containing this, with its position
  {"kind":"sheet","file":"<exact file name>"}     the same kind of summary for another drawing open in this project

Rules:
- Copy layer, block and file names EXACTLY from the inventory you are given. A name that is not in the inventory is discarded and you get nothing back for it.
- Ask for what would change the answer. At most ${MAX_NEEDS} requests; two or three is usually right.
- Prefer textSearch when the question is about a room, a circuit reference, a title or a note — the drawing's text is given to the answering pass verbatim, so searching it is exact.
- Never put a count, length, area, total or any other number in your reply. You have not measured anything yet.

Respond with JSON only, in this exact shape:
{"intent":"one line on what the question is really asking","needs":[{"kind":"layer","name":"E-LITE"}]}`;

/** the planner's user turn: the inventory it must choose from, then the question */
export function buildPlanPrompt(doc: CadDocument, question: string, index: PlanIndex): string {
  const lines: string[] = [];
  lines.push(`DRAWING: ${doc.sourceFile || doc.name}`);
  lines.push(
    `${doc.entities.length} entities · ${doc.layers.size} layers · ${doc.blocks.size} block definitions`,
  );

  // order the inventory the way the takeoff does, so the names most likely to
  // matter survive the cap
  let ranked: { layers: string[]; blocks: string[] } | null = null;
  try {
    const t = computeTakeoff(doc);
    ranked = {
      layers: t.lengths.map((l) => l.layer),
      blocks: t.blocks.map((b) => b.name),
    };
  } catch {
    ranked = null;
  }

  const order = (all: Map<string, string>, first: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const name of first) {
      const k = upper(name);
      const canon = all.get(k);
      if (canon && !seen.has(k)) {
        seen.add(k);
        out.push(canon);
      }
    }
    for (const [k, canon] of all) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(canon);
      }
    }
    return out;
  };

  const layerNames = order(index.layers, ranked?.layers ?? []);
  const blockNames = order(index.blocks, ranked?.blocks ?? []);

  lines.push('', `LAYER NAMES (${layerNames.length}, exact):`);
  lines.push(layerNames.slice(0, MAX_INVENTORY).map((n) => `"${n}"`).join(', '));
  if (layerNames.length > MAX_INVENTORY) lines.push(`  …and ${layerNames.length - MAX_INVENTORY} more`);

  lines.push('', `BLOCK NAMES (${blockNames.length}, exact):`);
  lines.push(blockNames.slice(0, MAX_INVENTORY).map((n) => `"${n}"`).join(', '));
  if (blockNames.length > MAX_INVENTORY) lines.push(`  …and ${blockNames.length - MAX_INVENTORY} more`);

  const sheetFiles = [...new Set(index.sheets.values())];
  if (sheetFiles.length) {
    lines.push('', 'OTHER SHEETS OPEN (exact file names):');
    lines.push(sheetFiles.map((n) => `"${n}"`).join(', '));
  }

  lines.push(
    '',
    index.hasSelection
      ? 'The user currently has a selection; {"kind":"selection"} will return it measured.'
      : 'The user has nothing selected; do not ask for the selection.',
  );

  lines.push('', `QUESTION: ${question.trim()}`);
  lines.push('', 'Return the plan as JSON now. No prose, no numbers.');
  return lines.join('\n');
}

// ------------------------------------------------------------
// validation — the hard boundary
// ------------------------------------------------------------

/** normalise the aliases models reach for, then refuse everything else */
function normaliseKind(raw: unknown): DataRequest['kind'] | null {
  if (typeof raw !== 'string') return null;
  switch (raw.trim().toLowerCase().replace(/[\s_-]+/g, '')) {
    case 'layer':
    case 'layers':
      return 'layer';
    case 'block':
    case 'blocks':
    case 'symbol':
      return 'block';
    case 'selection':
    case 'selected':
      return 'selection';
    case 'textsearch':
    case 'text':
    case 'search':
    case 'find':
      return 'textSearch';
    case 'sheet':
    case 'drawing':
    case 'file':
      return 'sheet';
    default:
      return null;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** the key a request occupies, so the same thing is never fetched twice */
function requestKey(r: DataRequest): string {
  switch (r.kind) {
    case 'layer': return `layer:${upper(r.name)}`;
    case 'block': return `block:${upper(r.name)}`;
    case 'sheet': return `sheet:${upper(r.file)}`;
    case 'textSearch': return `text:${r.query.toLowerCase()}`;
    default: return 'selection';
  }
}

/**
 * Parse and sanitise a plan.
 *
 * Tolerant of the usual model habits (fenced JSON, a prose preamble, a
 * singular/plural kind), strict about the contract: an unknown kind is
 * dropped, a layer/block/sheet name the drawing does not contain is dropped,
 * and every field beyond `kind` + its one name is ignored outright — a
 * quantity smuggled into the plan is not stripped, it is never read.
 */
export function parsePlan(raw: string, index: PlanIndex): QueryPlan {
  const json = extractJson(raw);
  if (!json) throw new Error('The planner did not return JSON.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('The planner returned malformed JSON.');
  }

  const root = parsed as { intent?: unknown; needs?: unknown; requests?: unknown };
  const rows = Array.isArray(root.needs)
    ? root.needs
    : Array.isArray(root.requests)
      ? root.requests
      : [];

  const needs: DataRequest[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (needs.length >= MAX_NEEDS) {
      dropped.push(`more than ${MAX_NEEDS} requests — the rest were ignored`);
      break;
    }
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const kind = normaliseKind(rec.kind ?? rec.type);
    if (!kind) {
      dropped.push(`unknown request kind ${JSON.stringify(rec.kind ?? rec.type ?? null)}`);
      continue;
    }

    let req: DataRequest | null = null;
    if (kind === 'layer') {
      const asked = str(rec.name) || str(rec.layer) || str(rec.key) || str(rec.value);
      const canon = index.layers.get(upper(asked));
      if (!asked) dropped.push('a layer request with no name');
      else if (!canon) dropped.push(`layer "${asked}" — not in this drawing`);
      else req = { kind: 'layer', name: canon };
    } else if (kind === 'block') {
      const asked = str(rec.name) || str(rec.block) || str(rec.key) || str(rec.value);
      const canon = index.blocks.get(upper(asked));
      if (!asked) dropped.push('a block request with no name');
      else if (!canon) dropped.push(`block "${asked}" — not in this drawing`);
      else req = { kind: 'block', name: canon };
    } else if (kind === 'sheet') {
      const asked = str(rec.file) || str(rec.name) || str(rec.sheet) || str(rec.value);
      const canon = index.sheets.get(upper(asked)) ?? index.sheets.get(upper(basename(asked)));
      if (!asked) dropped.push('a sheet request with no file name');
      else if (!canon) dropped.push(`sheet "${asked}" — not open in this project`);
      else req = { kind: 'sheet', file: canon };
    } else if (kind === 'textSearch') {
      const asked = (str(rec.query) || str(rec.text) || str(rec.value) || str(rec.name)).slice(
        0,
        MAX_QUERY_CHARS,
      );
      if (asked.length < 2) dropped.push('a text search shorter than two characters');
      else req = { kind: 'textSearch', query: asked };
    } else {
      req = { kind: 'selection' };
    }

    if (!req) continue;
    const key = requestKey(req);
    if (seen.has(key)) continue;
    seen.add(key);
    needs.push(req);
  }

  return {
    intent: str(root.intent).slice(0, 240),
    needs,
    dropped,
  };
}

/** pull the first JSON object out of a response that may be fenced or prefixed */
function extractJson(raw: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

/** one line for the UI: what the model decided to look at */
export function describePlan(plan: QueryPlan): string {
  return plan.needs
    .map((n) => {
      switch (n.kind) {
        case 'layer': return `layer "${n.name}"`;
        case 'block': return `block "${n.name}"`;
        case 'sheet': return `sheet "${basename(n.file)}"`;
        case 'textSearch': return `text “${n.query}”`;
        default: return 'the current selection';
      }
    })
    .join(', ');
}

// ------------------------------------------------------------
// execution — every number below is measured by this codebase
// ------------------------------------------------------------

const m = (mm: number): string => (mm / 1000).toFixed(2);
const sqm = (mm2: number): string => (mm2 / 1e6).toFixed(2);

/** work shared across the requests in one plan, computed at most once each */
interface Ctx {
  doc: CadDocument;
  takeoff: Takeoff | null;
  texts: TextHit[] | null;
}

function takeoffOf(ctx: Ctx): Takeoff | null {
  if (ctx.takeoff === null) {
    try {
      ctx.takeoff = computeTakeoff(ctx.doc);
    } catch {
      return null;
    }
  }
  return ctx.takeoff;
}

function textsOf(ctx: Ctx): TextHit[] {
  if (ctx.texts === null) {
    try {
      ctx.texts = collectTexts(ctx.doc);
    } catch {
      ctx.texts = [];
    }
  }
  return ctx.texts;
}

/**
 * Entities on a layer / of a block.
 *
 * `session.cadEntitiesOnLayer` reads the ACTIVE sheet, which is the same list
 * whenever the chat is about the drawing on screen — the normal case. When it
 * is not (a cross-sheet question), the document is filtered directly so the
 * numbers still belong to the document they are reported for.
 */
function onLayer(doc: CadDocument, layer: string): CadEntity[] {
  try {
    if (getCadSession().doc === doc) return cadEntitiesOnLayer(layer);
  } catch {
    /* headless */
  }
  return doc.entities.filter((e) => e.style.layer === layer);
}

function ofBlock(doc: CadDocument, name: string): CadEntity[] {
  try {
    if (getCadSession().doc === doc) return cadEntitiesOfBlock(name);
  } catch {
    /* headless */
  }
  return doc.entities.filter((e) => e.type === 'insert' && e.blockName === name);
}

function labelOf(key: string): string {
  try {
    return getCadSession().labels.get(key)?.label ?? '';
  } catch {
    return '';
  }
}

function fulfilLayer(ctx: Ctx, name: string): string[] {
  const { doc } = ctx;
  const lines: string[] = [];
  const named = labelOf(name);
  lines.push(`LAYER "${name}"${named ? ` = ${named}` : ''} (measured):`);

  const ents = onLayer(doc, name);
  const s = summarise(doc, ents);
  const mix = s.byType.map((t) => `${t.count} ${t.type}`).join(', ');
  lines.push(`  ${s.count} top-level entities${mix ? ` — ${mix}` : ''}`);

  let scoped: Takeoff | null = null;
  try {
    scoped = computeTakeoff(doc, { layers: new Set([name]) });
  } catch {
    scoped = null;
  }
  if (scoped) {
    const len = scoped.lengths.find((l) => l.layer === name);
    const area = scoped.areas.find((a) => a.layer === name);
    lines.push(
      len
        ? `  ${m(len.length)} m of linework (${len.entityCount} measured runs, block contents included)`
        : '  no measurable linework on this layer',
    );
    if (area) lines.push(`  ${sqm(area.area)} m² enclosed (${area.count} closed shapes)`);
    const blocks = scoped.blocks.filter((b) => b.count > 0).slice(0, 12);
    if (blocks.length) {
      lines.push(`  symbols on this layer: ${blocks.map((b) => `${b.count} × ${b.name}`).join(', ')}`);
    }
  }

  const layer = doc.layers.get(name);
  if (layer) {
    const colour = layer.color.kind === 'rgb' ? layer.color.hex : 'by block';
    lines.push(
      `  colour ${colour}${layer.frozen ? ' · frozen' : ''}${layer.visible ? '' : ' · off'}`,
    );
  } else {
    lines.push('  (drawn on, but not declared in the LAYER table)');
  }

  // read off the layer's own entities rather than harvesting the whole sheet:
  // a layer request must not pay for the text walk it does not use
  const here = ents
    .filter((e): e is Extract<CadEntity, { type: 'text' }> => e.type === 'text')
    .slice(0, MAX_SAMPLES)
    .map((e) => e.text.replace(/\s+/g, ' ').trim().slice(0, 70))
    .filter(Boolean);
  if (here.length) lines.push(`  text on this layer: ${here.map((t) => `“${t}”`).join(' · ')}`);
  return lines;
}

function fulfilBlock(ctx: Ctx, name: string): string[] {
  const { doc } = ctx;
  const lines: string[] = [];
  const named = labelOf(name);
  lines.push(`BLOCK "${name}"${named ? ` = ${named}` : ''} (measured):`);

  const t = takeoffOf(ctx);
  const row = t?.blocks.find((b) => upper(b.name) === upper(name));
  if (row) {
    lines.push(`  ${row.count} instances in total (MINSERT arrays and nested copies included)`);
    if (row.layers.length) lines.push(`  on layers: ${row.layers.slice(0, 10).join(', ')}`);
  } else {
    lines.push('  0 instances placed in modelspace');
  }

  const inserts = ofBlock(doc, name);
  if (inserts.length) lines.push(`  ${inserts.length} of those are top-level INSERTs`);

  const def = doc.blocks.get(upper(name));
  if (def) {
    const types = new Map<string, number>();
    for (const e of def.entities) types.set(e.type, (types.get(e.type) ?? 0) + 1);
    const mix = [...types]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    lines.push(`  the symbol draws: ${mix || 'nothing'}`);
    const inside = def.entities
      .filter((e): e is Extract<CadEntity, { type: 'text' }> => e.type === 'text')
      .slice(0, MAX_SAMPLES)
      .map((e) => e.text.replace(/\s+/g, ' ').trim().slice(0, 70))
      .filter(Boolean);
    if (inside.length) lines.push(`  text inside the symbol: ${inside.map((s) => `“${s}”`).join(' · ')}`);
  } else {
    lines.push('  (referenced by an INSERT, but the block definition is missing from the file)');
  }
  return lines;
}

function fulfilSelection(ctx: Ctx): string[] {
  const { doc } = ctx;
  let sel: CadEntity[] = [];
  try {
    sel = getCadSession().doc === doc ? selectedCadEntities() : [];
  } catch {
    sel = [];
  }
  if (!sel.length) return ['CURRENT SELECTION: nothing is selected in the editor.'];

  const s = summarise(doc, sel);
  const lines = [
    `CURRENT SELECTION (measured): ${s.count} entities, ${m(s.totalLength)} m total length` +
      (s.totalArea > 0 ? `, ${sqm(s.totalArea)} m² total area` : ''),
  ];
  for (const b of s.byLayer.slice(0, 8)) {
    lines.push(`  ${b.count} on "${b.layer}" (${m(b.length)} m)`);
  }
  for (const b of s.byBlock.slice(0, 8)) {
    lines.push(`  ${b.count} × block ${b.name}`);
  }
  for (const e of sel.slice(0, MAX_SAMPLES)) {
    const f = entityFacts(doc, e);
    lines.push(
      `  · ${f.describe} on "${f.layer}"${f.length > 0 ? `, ${m(f.length)} m` : ''}${
        f.area > 0 ? `, ${sqm(f.area)} m²` : ''
      }`,
    );
  }
  return lines;
}

function fulfilTextSearch(ctx: Ctx, query: string): string[] {
  const needle = query.toLowerCase();
  const hits = textsOf(ctx).filter((t) => t.text.toLowerCase().includes(needle));
  if (!hits.length) {
    return [`TEXT SEARCH “${query}”: no text on this sheet contains that.`];
  }
  const lines = [
    `TEXT SEARCH “${query}”: ${hits.length} match${hits.length === 1 ? '' : 'es'}` +
      (hits.length > MAX_TEXT_MATCHES ? ` (first ${MAX_TEXT_MATCHES} shown)` : '') +
      ', positions in metres from the drawing origin:',
  ];
  const seen = new Set<string>();
  for (const h of hits) {
    if (lines.length > MAX_TEXT_MATCHES) break;
    const key = `${h.text}|${Math.round(h.x)}|${Math.round(h.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  “${h.text.slice(0, 90)}” at (${m(h.x)}, ${m(h.y)})`);
  }
  return lines;
}

function fulfilSheet(ctx: Ctx, file: string): string[] {
  let target: CadDocument | null = null;
  try {
    target =
      cadSheets()
        .map((s) => s.doc)
        .find((d) => upper(d.sourceFile || d.name) === upper(file)) ?? null;
  } catch {
    target = null;
  }
  if (!target) return [`SHEET "${file}": that drawing is no longer open.`];
  if (target === ctx.doc) return [`SHEET "${file}": that is this drawing; see the measured facts above.`];

  const lines = [
    `SHEET "${file}" (measured): ${target.entities.length} entities · ${target.layers.size} layers · ${target.blocks.size} block definitions`,
  ];
  try {
    const t = computeTakeoff(target);
    if (t.blocks.length) {
      lines.push(`  symbols: ${t.blocks.slice(0, 12).map((b) => `${b.count} × ${b.name}`).join(', ')}`);
    }
    if (t.lengths.length) {
      lines.push(
        `  length by layer: ${t.lengths.slice(0, 10).map((l) => `${m(l.length)} m on "${l.layer}"`).join(', ')}`,
      );
    }
    if (t.areas.length) {
      lines.push(
        `  area by layer: ${t.areas.slice(0, 8).map((a) => `${sqm(a.area)} m² on "${a.layer}"`).join(', ')}`,
      );
    }
  } catch {
    lines.push('  (quantities unavailable for that sheet)');
  }
  return lines;
}

/**
 * Execute a validated plan with OUR code.
 *
 * Returns a text block of measured results, or '' when the plan asked for
 * nothing that survived validation. Every figure comes from `takeoff.ts`,
 * `metrics.ts` or the harvested text — the model chose the questions, this
 * codebase produced every answer.
 */
export function fulfilPlan(doc: CadDocument, plan: QueryPlan): string {
  if (!plan.needs.length) return '';
  const ctx: Ctx = { doc, takeoff: null, texts: null };
  const out: string[] = [];
  for (const need of plan.needs) {
    let lines: string[];
    try {
      switch (need.kind) {
        case 'layer': lines = fulfilLayer(ctx, need.name); break;
        case 'block': lines = fulfilBlock(ctx, need.name); break;
        case 'selection': lines = fulfilSelection(ctx); break;
        case 'textSearch': lines = fulfilTextSearch(ctx, need.query); break;
        case 'sheet': lines = fulfilSheet(ctx, need.file); break;
        default: lines = [];
      }
    } catch (err) {
      lines = [`(that request could not be measured: ${err instanceof Error ? err.message : 'failed'})`];
    }
    if (lines.length) out.push(lines.join('\n'));
  }
  return out.join('\n\n');
}

// ------------------------------------------------------------
// the planning request
// ------------------------------------------------------------

export interface PlanOptions {
  signal?: AbortSignal;
  /** override the model; defaults to the configured text model */
  model?: string;
  /** other open sheets, injected for tests; defaults to the session */
  otherSheets?: readonly CadDocument[];
}

/**
 * One request whose entire output is a plan.
 *
 * Errors here are the caller's to absorb: chat degrades to a single pass
 * rather than failing the question, because a planning failure must never
 * cost the user their answer.
 */
export async function planQuery(
  doc: CadDocument,
  question: string,
  opts: PlanOptions = {},
): Promise<QueryPlan> {
  if (!isAiConfigured()) {
    throw new Error('Add your OpenRouter key before asking questions.');
  }
  const cfg = getAiConfig();
  const model = opts.model || cfg.textModel || cfg.visionModel;
  const index = buildPlanIndex(doc, opts.otherSheets);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: opts.signal,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': cfg.appName,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: PLAN_SYSTEM },
          { role: 'user', content: buildPlanPrompt(doc, question, index) },
        ],
      }),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new Error(
      `Could not reach OpenRouter to plan the question: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch {
      /* keep the status line */
    }
    throw new Error(`OpenRouter (planning pass): ${detail}`);
  }

  const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = body.choices?.[0]?.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
            .join('')
        : '';
  if (!text.trim()) {
    throw new Error(`${model} returned an empty plan.`);
  }
  return parsePlan(text, index);
}
