// ============================================================
// CadDocument → Digest: everything the model is allowed to see, and nothing
// it could echo back as a fact.
//
// The digest carries `count` per item ONLY as ordering context — the contract's
// system prompt forbids the model reporting it and `parseAnalysis` strips any
// quantity field from the response. Every number a user ever sees comes from
// `metrics.ts` / `takeoff.ts`, never from here and never from the model.
//
// The single highest-value input is TEXT. A legend/key table in a DXF is not a
// picture of a table — it is TEXT entities sitting in a dense cluster, already
// machine-readable. Harvesting it well means the model rarely has to OCR
// anything, which is where vision models make their mistakes.
// ============================================================
import type { CadDocument, CadEntity, Vec2 } from '../types';
import type { Digest, DigestItem } from './contract';
import { symbolContexts } from './context';
import { apply, compose, type Xform } from '../displayList';
import { computeTakeoff } from '../takeoff';

// ------------------------------------------------------------
// budgets — the prompt has to stay small enough to be cheap and focused
// ------------------------------------------------------------

export const MAX_ITEMS = 120;
export const MAX_TEXT_SAMPLES = 120;
export const MAX_SAMPLE_CHARS = 120;

/** share of the item budget layers may take, so blocks are never squeezed out */
const LAYER_SHARE = 0.4;

/** how deep INSERT nesting is followed when harvesting text */
const MAX_TEXT_DEPTH = 3;
/** hard ceilings so a pathological file cannot hang the tab */
const MAX_TEXT_VISITS = 300_000;
const MAX_TEXT_HITS = 20_000;

/**
 * Words that mark the part of a drawing that explains the rest of it.
 * A hit here is worth more than any amount of geometry.
 */
export const LEGEND_WORDS = /legend|key|schedule|symbol|description|notes/i;

/**
 * Anonymous blocks. `*D…` are dimension geometry, `*U…`/`*X…` are generated
 * groups, `*Model_Space`/`*Paper_Space` are containers. None of them is a
 * symbol a human named, so none of them can carry meaning worth asking about.
 * The whole `*` prefix is reserved for generated blocks in DXF, so the test is
 * the prefix rather than an enumeration of the letters.
 */
export function isGeneratedBlock(name: string): boolean {
  return /^\*/.test(name.trim());
}

// ------------------------------------------------------------
// text harvesting
// ------------------------------------------------------------

/** one TEXT/MTEXT occurrence, resolved to world millimetres */
export interface TextHit {
  /** cleaned to a single line; MTEXT formatting is already stripped by the parser */
  text: string;
  x: number;
  y: number;
  /** cap height in mm, after the insert transform */
  height: number;
}

const scaleOf = (m: Xform): number =>
  (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2 || 1;

/**
 * Dimension text ("3200", "1'-6\"", "Ø25") is dense, numerous and says nothing
 * about meaning. Dropping it early both shrinks the sample list and stops a run
 * of dimensions masquerading as the densest "legend" cluster.
 */
const NUMERIC_ONLY = /^[\s\d.,;:\-+/\\'"×xX°%()@#&*_[\]]*$/;

function normaliseText(raw: string): string {
  const s = raw.replace(/\s*\r?\n\s*/g, ' / ').replace(/\s+/g, ' ').trim();
  if (s.length < 2) return '';
  if (NUMERIC_ONLY.test(s) && !/[A-Za-z]{2}/.test(s)) return '';
  return s;
}

const NO_PATH: ReadonlySet<string> = new Set<string>();

/**
 * Every text in the drawing, with a real world position.
 *
 * INSERTs are followed (a legend is often a block, and title-block text always
 * is) using the same transform composition the display list uses, so positions
 * agree with what is on screen. MINSERT arrays contribute their first copy
 * only: the other copies repeat the same strings.
 */
export function collectTexts(doc: CadDocument): TextHit[] {
  const out: TextHit[] = [];
  let visits = 0;
  const k = doc.unitScale || 1;
  const unit: Xform = { a: k, b: 0, c: 0, d: k, e: 0, f: 0 };

  const walk = (e: CadEntity, xf: Xform, depth: number, path: ReadonlySet<string>): void => {
    if (visits++ > MAX_TEXT_VISITS || out.length >= MAX_TEXT_HITS) return;

    if (e.type === 'text') {
      const text = normaliseText(e.text);
      if (!text) return;
      const p = apply(xf, e.position);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      out.push({ text, x: p.x, y: p.y, height: Math.abs(e.height) * scaleOf(xf) });
      return;
    }

    if (e.type !== 'insert' || depth >= MAX_TEXT_DEPTH) return;
    const key = e.blockName.toUpperCase();
    if (path.has(key)) return; // self-referencing block
    const block = doc.blocks.get(key);
    if (!block) return;

    const cos = Math.cos(e.rotation);
    const sin = Math.sin(e.rotation);
    const sx = e.scale.x || 1;
    const sy = e.scale.y || 1;
    const local: Xform = {
      a: cos * sx, b: sin * sx,
      c: -sin * sy, d: cos * sy,
      e: e.position.x - (cos * sx * block.basePoint.x - sin * sy * block.basePoint.y),
      f: e.position.y - (sin * sx * block.basePoint.x + cos * sy * block.basePoint.y),
    };
    const next = compose(xf, local);
    const nextPath = new Set(path).add(key);
    for (const child of block.entities) walk(child, next, depth + 1, nextPath);
  };

  for (const e of doc.entities) walk(e, unit, 0, NO_PATH);
  return out;
}

// ------------------------------------------------------------
// spatial grid — density is what identifies a legend
// ------------------------------------------------------------

interface Grid {
  cell: number;
  counts: Map<string, number>;
  colOf(t: TextHit): number;
  rowOf(t: TextHit): number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function bboxOf(texts: readonly TextHit[]): { min: Vec2; max: Vec2 } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of texts) {
    if (t.x < minX) minX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.x > maxX) maxX = t.x;
    if (t.y > maxY) maxY = t.y;
  }
  if (!Number.isFinite(minX)) return null;
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

const cellKey = (c: number, r: number): string => `${c}|${r}`;

/**
 * Cell size is derived from the text itself rather than from the sheet: a
 * legend row is a handful of character heights tall, so ~14 median heights is
 * "a few rows of the same table" at any drawing scale. The extents-derived
 * floor keeps a drawing full of hairline text from producing millions of cells.
 */
function buildGrid(texts: readonly TextHit[]): Grid | null {
  const box = bboxOf(texts);
  if (!box) return null;
  const diag = Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y) || 1;
  const h = median(texts.map((t) => t.height).filter((v) => v > 0));
  const cell = Math.max(h * 14 || 0, diag / 200, 1e-6);
  const counts = new Map<string, number>();
  const colOf = (t: TextHit): number => Math.floor((t.x - box.min.x) / cell);
  const rowOf = (t: TextHit): number => Math.floor((t.y - box.min.y) / cell);
  for (const t of texts) {
    const key = cellKey(colOf(t), rowOf(t));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { cell, counts, colOf, rowOf };
}

function neighbourCount(grid: Grid, t: TextHit): number {
  const c = grid.colOf(t);
  const r = grid.rowOf(t);
  let n = 0;
  for (let dc = -1; dc <= 1; dc++) {
    for (let dr = -1; dr <= 1; dr++) n += grid.counts.get(cellKey(c + dc, r + dr)) ?? 0;
  }
  return n;
}

/** the densest connected run of text cells — in a drawing, that is the legend */
export interface TextCluster {
  min: Vec2;
  max: Vec2;
  texts: TextHit[];
}

const MAX_CLUSTER_CELLS = 600;

export function findTextCluster(texts: readonly TextHit[]): TextCluster | null {
  if (texts.length < 4) return null;
  const grid = buildGrid(texts);
  if (!grid) return null;

  // A drawing that says "LEGEND" is telling us where its legend is; density
  // alone would just as happily pick the busiest room on the plan. So the seed
  // is the busiest cell that CONTAINS a heading, and only falls back to the
  // busiest cell overall when the sheet never names its own key table.
  const keyworded = new Set<string>();
  for (const t of texts) {
    if (LEGEND_WORDS.test(t.text)) keyworded.add(cellKey(grid.colOf(t), grid.rowOf(t)));
  }

  let bestKey = '';
  let bestCount = 0;
  for (const [key, n] of grid.counts) {
    if (keyworded.size && !keyworded.has(key)) continue;
    if (n > bestCount) {
      bestCount = n;
      bestKey = key;
    }
  }
  if (!bestKey) {
    for (const [key, n] of grid.counts) {
      if (n > bestCount) {
        bestCount = n;
        bestKey = key;
      }
    }
  }
  if (!bestKey) return null;

  // grow outward over cells that are still busy — a legend table spans several
  // cells, and the threshold stops the growth leaking into the drawing body
  const threshold = Math.max(2, bestCount * 0.2);
  const members = new Set<string>([bestKey]);
  const queue: [number, number][] = [bestKey.split('|').map(Number) as [number, number]];
  while (queue.length && members.size < MAX_CLUSTER_CELLS) {
    const [c, r] = queue.shift()!;
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (!dc && !dr) continue;
        const key = cellKey(c + dc, r + dr);
        if (members.has(key)) continue;
        if ((grid.counts.get(key) ?? 0) < threshold) continue;
        members.add(key);
        queue.push([c + dc, r + dr]);
      }
    }
  }

  const inCluster = texts.filter((t) => members.has(cellKey(grid.colOf(t), grid.rowOf(t))));
  if (inCluster.length < 4) return null;
  const box = bboxOf(inCluster);
  if (!box) return null;
  return { min: box.min, max: box.max, texts: inCluster };
}

// ------------------------------------------------------------
// sample selection
// ------------------------------------------------------------

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Reading order: rows top to bottom, cells left to right within a row. A
 * legend read out of order pairs the wrong symbol name with the wrong
 * description, which is exactly the mistake this whole pass exists to avoid.
 */
function readingOrder(texts: TextHit[]): TextHit[] {
  const h = median(texts.map((t) => t.height).filter((v) => v > 0)) || 1;
  const band = h * 0.8;
  return [...texts].sort((a, b) => {
    const ra = Math.round(a.y / band);
    const rb = Math.round(b.y / band);
    if (ra !== rb) return rb - ra; // +y is up, so higher y is an earlier row
    return a.x - b.x;
  });
}

/**
 * Rank every harvested string, then emit the legend cluster in reading order
 * followed by the rest of the winners.
 *
 * The ranking is deliberately biased towards short strings in dense company:
 * that is the shape of a legend row. Long paragraphs of general notes score
 * lower — they are rarely what names a symbol, and they eat the budget.
 */
export function selectTextSamples(
  texts: readonly TextHit[],
  cluster: TextCluster | null,
  limit: number = MAX_TEXT_SAMPLES,
): string[] {
  if (!texts.length) return [];
  const grid = buildGrid(texts);

  // cells that contain a legend/key/schedule heading, so its neighbours — the
  // rows of the table underneath it — get promoted too
  const keywordCells = new Set<string>();
  if (grid) {
    for (const t of texts) {
      if (LEGEND_WORDS.test(t.text)) {
        keywordCells.add(cellKey(grid.colOf(t), grid.rowOf(t)));
      }
    }
  }

  const clusterSet = new Set<TextHit>(cluster ? cluster.texts : []);

  const scored = texts.map((t) => {
    const len = t.text.length;
    let score = 0;
    if (grid) score += Math.log2(1 + neighbourCount(grid, t)) * 2.5;
    if (LEGEND_WORDS.test(t.text)) score += 10;
    if (grid) {
      const c = grid.colOf(t);
      const r = grid.rowOf(t);
      let near = false;
      for (let dc = -2; dc <= 2 && !near; dc++) {
        for (let dr = -2; dr <= 2 && !near; dr++) {
          if (keywordCells.has(cellKey(c + dc, r + dr))) near = true;
        }
      }
      if (near) score += 5;
    }
    if (clusterSet.has(t)) score += 6;
    score += len <= 48 ? 2.5 : len <= 90 ? 1 : len <= 140 ? 0 : -2;
    return { hit: t, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const chosen: TextHit[] = [];
  for (const s of scored) {
    if (chosen.length >= limit) break;
    const key = norm(s.hit.text).slice(0, MAX_SAMPLE_CHARS);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    chosen.push(s.hit);
  }

  const inCluster = chosen.filter((t) => clusterSet.has(t));
  const rest = chosen.filter((t) => !clusterSet.has(t));
  const ordered = [...readingOrder(inCluster), ...rest];
  return ordered.map((t) => t.text.slice(0, MAX_SAMPLE_CHARS));
}

// ------------------------------------------------------------
// items
// ------------------------------------------------------------

/**
 * The colour a block mostly draws in, resolved the way the display list would.
 * On an electrical drawing colour separates power from lighting from data more
 * reliably than the block name does, so it is a real hint and costs 6 words of
 * prompt.
 */
function blockColor(doc: CadDocument, blockName: string): string | undefined {
  const block = doc.blocks.get(blockName.toUpperCase());
  if (!block) return undefined;
  const tally = new Map<string, number>();
  let seen = 0;
  for (const e of block.entities) {
    if (seen++ > 400) break;
    let hex: string | undefined;
    if (e.style.color.kind === 'rgb') hex = e.style.color.hex;
    else {
      const layer = doc.layers.get(e.style.layer);
      if (layer && layer.color.kind === 'rgb') hex = layer.color.hex;
    }
    if (hex) tally.set(hex, (tally.get(hex) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [hex, n] of tally) {
    if (n > bestN) {
      bestN = n;
      best = hex;
    }
  }
  return best;
}

interface LayerTally {
  count: number;
  types: Set<string>;
}

/**
 * Entities per layer, block definitions included.
 *
 * Definitions count because a layer used only inside symbols ("E-SYMB-TEXT")
 * still has meaning worth naming, and it would be invisible in a top-level
 * scan of a drawing that is nothing but INSERTs.
 */
function tallyLayers(doc: CadDocument): Map<string, LayerTally> {
  const out = new Map<string, LayerTally>();
  const add = (e: CadEntity): void => {
    const name = e.style.layer;
    let row = out.get(name);
    if (!row) out.set(name, (row = { count: 0, types: new Set() }));
    row.count += 1;
    row.types.add(e.type);
  };
  for (const e of doc.entities) add(e);
  for (const b of doc.blocks.values()) {
    if (isGeneratedBlock(b.name)) continue;
    for (const e of b.entities) add(e);
  }
  return out;
}

export interface DigestOptions {
  maxItems?: number;
  maxTextSamples?: number;
  /**
   * Keys that already carry a label (from the dictionary or a human), compared
   * case-insensitively. Excluding them is what makes the second drawing from an
   * office cheap: the model is only ever asked about genuinely unknown keys.
   */
  skipKeys?: ReadonlySet<string>;
}

/**
 * Build the prompt payload for a drawing.
 *
 * Block counts come from `computeTakeoff`, which is the same walk the takeoff
 * table uses — MINSERT arrays and nested INSERTs included — so the ordering
 * here can never disagree with the schedule the user reads.
 */
export function buildDigest(doc: CadDocument, opts: DigestOptions = {}): Digest {
  const maxItems = opts.maxItems ?? MAX_ITEMS;
  const skip = new Set<string>();
  for (const k of opts.skipKeys ?? []) skip.add(k.trim().toUpperCase());

  const takeoff = computeTakeoff(doc);

  const blockItems: DigestItem[] = [];
  for (const b of takeoff.blocks) {
    if (b.count < 1) continue;
    if (isGeneratedBlock(b.name)) continue;
    if (skip.has(b.name.trim().toUpperCase())) continue;
    blockItems.push({
      key: b.name,
      kind: 'block',
      count: b.count,
      context: b.layers.slice(0, 6),
      color: blockColor(doc, b.name),
    });
  }
  blockItems.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const layerItems: DigestItem[] = [];
  for (const [name, tally] of tallyLayers(doc)) {
    if (tally.count < 1) continue;
    if (skip.has(name.trim().toUpperCase())) continue;
    const layer = doc.layers.get(name);
    layerItems.push({
      key: name,
      kind: 'layer',
      count: tally.count,
      context: [...tally.types].sort(),
      color: layer && layer.color.kind === 'rgb' ? layer.color.hex : undefined,
    });
  }
  layerItems.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  // Split the budget instead of merging and truncating by count. Layers carry
  // entity counts in the thousands and blocks in the tens, so one merged sort
  // would drop every symbol off the end of the list — and symbols are the
  // whole point of the pass.
  const layerBudget = Math.min(layerItems.length, Math.floor(maxItems * LAYER_SHARE));
  const blocksTaken = blockItems.slice(0, maxItems - layerBudget);
  const layersTaken = layerItems.slice(0, maxItems - blocksTaken.length);

  // What is written next to each symbol — the thing a person actually reads
  // to identify it. Gathered only for the blocks being asked about, so a
  // drawing whose symbols are all already named costs nothing here.
  const contexts = symbolContexts(
    doc,
    blocksTaken.map((b) => b.key),
  );
  for (const item of blocksTaken) {
    const ctx = contexts.get(item.key);
    if (!ctx) continue;
    item.nearby = ctx.nearby;
    item.hint = ctx.ruleHint;
  }

  const texts = collectTexts(doc);
  const cluster = findTextCluster(texts);

  return {
    drawingName: doc.name || doc.sourceFile || 'Untitled drawing',
    textSamples: selectTextSamples(texts, cluster, opts.maxTextSamples ?? MAX_TEXT_SAMPLES),
    items: [...blocksTaken, ...layersTaken],
  };
}

/** the key set a response is allowed to name — never the model's own list */
export function digestKeys(digest: Digest): Set<string> {
  return new Set(digest.items.map((i) => i.key));
}
