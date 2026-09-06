// ============================================================
// Model-space bounds for display ops.
//
// Both the painter (viewport culling) and the hit-test walk every op in a
// display list on every frame / every click. Computing a bbox per op per
// frame is the single easiest way to make a 50k-op drawing stutter, so the
// bounds are computed once and cached in a flat Float64Array keyed by the
// ops array itself — never written onto the op objects, which belong to the
// display-list builder and must stay immutable.
//
// The cache key is `list.ops` rather than the list: rebuilding a display
// list produces a fresh array, which invalidates the entry for free, and a
// list object that is re-created around the same ops array still hits.
// ============================================================
import type { CadVAlign, DisplayList, DisplayOp, DisplayText } from '../types';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Average glyph advance as a fraction of the font size. Canvas cannot give
 * us metrics without measuring (which would defeat the point of culling),
 * so text boxes are approximate — deliberately a little generous so nothing
 * is culled or missed by a pick that a real measure would have caught.
 */
export const CHAR_ADVANCE = 0.6;

/** multi-line spacing, matching src/editor/render.ts:drawTextEl */
export const LINE_HEIGHT = 1.25;

/**
 * Vertical extent of one drawn line relative to its anchor line, in
 * multiples of the text height, in model space (y up). Mirrors the canvas
 * textBaseline the painter selects for each CAD justification.
 */
const V_EXTENT: Record<CadVAlign, readonly [number, number]> = {
  baseline: [-0.25, 1.0],
  bottom: [0, 1.25],
  middle: [-0.625, 0.625],
  top: [-1.25, 0],
};

export interface TextShape {
  /** number of `\n`-separated lines */
  lines: number;
  /** longest line, in characters */
  maxLen: number;
}

/** line count + longest line without allocating a split array */
export function textShape(s: string): TextShape {
  let lines = 1;
  let maxLen = 0;
  let cur = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      lines++;
      if (cur > maxLen) maxLen = cur;
      cur = 0;
    } else {
      cur++;
    }
  }
  return { lines, maxLen: cur > maxLen ? cur : maxLen };
}

/** widthFactor guarded against 0/NaN/negative from a sloppy source file */
export function safeWidthFactor(wf: number): number {
  const w = Math.abs(wf);
  return w > 1e-6 && Number.isFinite(w) ? w : 1;
}

/**
 * Text box in the glyph's own frame: origin at `position`, x along the
 * baseline, y up, before `rotation` is applied. Model units.
 */
export function textLocalBox(t: DisplayText): Bounds {
  const h = Math.abs(t.height);
  const { lines, maxLen } = textShape(t.text);
  const w = maxLen * CHAR_ADVANCE * h * safeWidthFactor(t.widthFactor);

  let minX = 0;
  let maxX = w;
  if (t.hAlign === 'center') {
    minX = -w / 2;
    maxX = w / 2;
  } else if (t.hAlign === 'right') {
    minX = -w;
    maxX = 0;
  }

  // the block grows downward from the anchor; centre/bottom attachments
  // shift it back up exactly as the painter does
  const lh = LINE_HEIGHT * h;
  const span = (lines - 1) * lh;
  let topLine = 0; // model y of the first line's anchor
  if (t.vAlign === 'middle') topLine = span / 2;
  else if (t.vAlign === 'bottom' || t.vAlign === 'baseline') topLine = span;
  const bottomLine = topLine - span;

  const ext = V_EXTENT[t.vAlign] ?? V_EXTENT.baseline;
  return {
    minX,
    minY: bottomLine + ext[0] * h,
    maxX,
    maxY: topLine + ext[1] * h,
  };
}

/** model-space AABB of a text op, `rotation` included */
function textBounds(t: DisplayText, out: Float64Array, at: number): void {
  const b = textLocalBox(t);
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  // four corners through the rotation
  for (let i = 0; i < 4; i++) {
    const lx = i === 0 || i === 3 ? b.minX : b.maxX;
    const ly = i < 2 ? b.minY : b.maxY;
    const x = t.position.x + lx * c - ly * s;
    const y = t.position.y + lx * s + ly * c;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  out[at] = minX;
  out[at + 1] = minY;
  out[at + 2] = maxX;
  out[at + 3] = maxY;
}

function opBounds(op: DisplayOp, out: Float64Array, at: number): void {
  if (op.kind === 'text') {
    textBounds(op, out, at);
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const subs = op.subpaths;
  for (let s = 0; s < subs.length; s++) {
    const pts = subs[s];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  // an empty path keeps the inverted box, which fails every overlap test
  out[at] = minX;
  out[at + 1] = minY;
  out[at + 2] = maxX;
  out[at + 3] = maxY;
}

const cache = new WeakMap<DisplayOp[], Float64Array>();

/**
 * Per-op model-space bounds as [minX, minY, maxX, maxY] × ops.length.
 * Computed on first use for a given ops array and reused after that.
 */
export function listBounds(list: DisplayList): Float64Array {
  const ops = list.ops;
  const hit = cache.get(ops);
  if (hit && hit.length === ops.length * 4) return hit;
  const out = new Float64Array(ops.length * 4);
  for (let i = 0; i < ops.length; i++) opBounds(ops[i], out, i * 4);
  cache.set(ops, out);
  return out;
}

/** drop a cached entry (only needed if an ops array is mutated in place) */
export function invalidateBounds(list: DisplayList): void {
  cache.delete(list.ops);
}
