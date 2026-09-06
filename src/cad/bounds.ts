// Where to point the camera at a drawing.
//
// A real DXF routinely carries a stray a long way from its content: an entity
// left at the origin while the drawing sits at x = 10,240,531, a construction
// point kilometres out, a zero-length line in a title block. Framing the raw
// extents then renders the drawing itself a few pixels wide — one origin stray
// takes a 47,000-unit drawing down to 0.4% of the sheet, which reads as "the
// drawing did not load", not as "the drawing is over there".
//
// THE RULE IS AN EXTENT TEST — see `trimmedSpan`. Three rules were tried
// before it and every one of them was wrong on a real drawing:
//
//   A PERCENTILE TRIM ("drop the extreme 1%") cannot cut a stray at all. One
//   stray entity is two points, and 1% of a 146-point drawing is one of them;
//   the second survives and the drawing is still a speck.
//
//   AN INTERQUARTILE FENCE cuts far too much. It assumes the middle 50% of the
//   points describes the drawing, and a schedule table or a grid of footings
//   puts both quartiles inside a few hundred millimetres. Measured, the frame
//   collapsed to 5.9% of the drawing's width.
//
//   A DISTANCE RATIO ("further away than the drawing is wide") splits the two
//   textbook cases — a stray at the origin is 216x, a second plan area 3.8x —
//   and then meets a drawing whose stray is 9.5x, under every threshold that
//   spares the plan area. Distance cannot tell a lone point from a small
//   drawing element, because the two genuinely overlap.
//
// EXTENT does not overlap. A stray is a POINT: it spans a millimetre. A plan
// area, however sparse or far, is thousands of millimetres wide. So the test
// is the outlier's own size, with distance only excluding near neighbours.
//
// EVERYTHING IS STILL DRAWN. This decides framing only — never what exists.
// `cadBounds()` (the CAD viewer's camera) and `groupedSheetSvg()` (the studio
// sheet's viewBox) both read this one function: two copies of a rule this
// subtle would drift, and then the same drawing would be framed two different
// ways in two places in the same app.

import type { DisplayList } from './types';

export interface Bounds {
  min: { x: number; y: number };
  max: { x: number; y: number };
}

/** Sampling cap — a 600k-op list does not need every op to find a frame. */
const MAX_OPS = 60_000;

/** Below this many samples a quartile means nothing; use the extents. */
const MIN_SAMPLES = 8;

/** Never drop more than this share of the points from either end. */
const MAX_TRIM = 0.02;

/**
 * A STRAY HAS NO SIZE OF ITS OWN. That is the test, and it is the only one
 * that separates every case this has been wrong about.
 *
 * The distance to the outlier cannot do it. Measured as a fraction of the span
 * it kept cutting real geometry; measured against the content it looked
 * decisive — a stray at the origin is 216x the drawing, a second plan area is
 * 3.8x — until a drawing turned up whose stray was only 9.5x, under any
 * threshold that spared the plan area. Distance alone cannot tell a lone point
 * from a small drawing element; the two overlap.
 *
 * What never overlaps is EXTENT. An entity left at the origin is a point: it
 * spans a millimetre or two. A plan area, however sparse, is thousands of
 * millimetres wide. So a group is cut off only when its own span is a
 * rounding error next to the drawing's (TINY) and it is genuinely detached
 * (SEPARATE) — never merely because it is far away.
 */
const TINY = 0.01;
// Detached by MORE THAN THE DRAWING IS WIDE. At a twentieth of it this cut a
// lone mark 12,000 units off the GAMCO sheet and the drawing then overflowed
// its own frame by 31%. TINY is what identifies a stray; this only keeps a
// small neighbouring mark from qualifying because it happens to sit apart.
const SEPARATE = 1;

/**
 * The span of one axis with its runaways cut.
 *
 * A STRAY IS SEPARATED BY EMPTY SPACE. That is the definition this encodes,
 * and both halves of it matter: a cut is made only where the sorted points
 * jump a real gap, AND only within the first/last 2% of them.
 *
 * The rule this replaces was a distribution test — an interquartile fence,
 * twenty widths wide. It assumed the middle 50% of the points is
 * representative of the drawing, and on a real sheet it is not: a schedule
 * table or a grid of footings puts both quartiles inside a few hundred
 * millimetres, twenty of those is still a few thousand, and the frame
 * collapsed onto the table — measured at 5.9% of the drawing's width. The
 * sheet still LOOKED right, because `overflow: visible` keeps painting outside
 * the viewBox, but every millimetre↔viewBox conversion calibrated on that
 * frame was wrong by 17×: the coordinate readout, and every section
 * highlight, which is how this was found.
 *
 * A gap test cannot fail that way. Points packed together have no gap between
 * them to cut at, however tight the quartiles are.
 */
/** A gap this big, relative to the whole span, starts a new cluster. */
const CLUSTER_GAP = 0.02;

/**
 * THE DRAWING'S OWN SPAN — the widest run of points with no big gap in it.
 *
 * `content` used to be "everything still between lo and hi", and with strays
 * on BOTH sides that is a deadlock: each side's strays inflate the span the
 * other side is measured against, so `gap >= content` fails at both ends and
 * nothing is ever cut. A sheet with a speck at each corner kept its full
 * extents however obvious the specks were.
 *
 * Measuring the biggest cluster instead breaks the circularity, because a
 * cluster of strays is small BY DEFINITION — that is what makes them strays.
 * It also leaves the case this rule was tuned on unchanged: a lone mark twelve
 * thousand units off a forty-seven-thousand-unit drawing is inside the same
 * cluster (the gap is under 2% of the sheet), so `content` still comes out as
 * the whole drawing and the mark is still kept.
 */
function contentSpan(sorted: number[]): number {
  const n = sorted.length;
  const total = sorted[n - 1] - sorted[0];
  if (!(total > 0)) return 0;
  const cut = total * CLUSTER_GAP;
  let best = 0;
  let start = 0;
  for (let i = 1; i < n; i += 1) {
    if (sorted[i] - sorted[i - 1] > cut) {
      best = Math.max(best, sorted[i - 1] - sorted[start]);
      start = i;
    }
  }
  return Math.max(best, sorted[n - 1] - sorted[start]);
}

function trimmedSpan(sorted: number[]): { min: number; max: number } | null {
  const n = sorted.length;
  if (n < MIN_SAMPLES) return null;
  const span = sorted[n - 1] - sorted[0];
  if (!(span > 0)) return null;

  const budget = Math.floor(n * MAX_TRIM);
  const content = contentSpan(sorted);
  if (!(content > 0)) return null;
  let lo = 0;
  let hi = n - 1;
  // Low end: is everything up to here a speck, detached from the rest?
  //
  // MEASURED FROM THE RUNNING BOUNDARY, not from the original first point.
  // That is the whole of the second-stray bug: a drawing with TWO strays at
  // different distances could only ever lose the first. Once `lo` had moved
  // past it, the next candidate's "own span" was still measured back to the
  // discarded stray — a huge number — so it failed the TINY test forever and
  // the frame stayed pinned to whatever was left. A real sheet came in framed
  // at roughly two hundred times its own ink: the drawing rendered as a speck,
  // and because stroke widths are floored in viewBox units, its hairlines came
  // out five per cent of its width — slabs of colour bleeding into each other.
  // Both symptoms, one cause.
  for (let i = 0; i < budget; i += 1) {
    const outlier = sorted[i] - sorted[lo];
    const gap = sorted[i + 1] - sorted[i];
    if (outlier <= content * TINY && gap >= content * SEPARATE) lo = i + 1;
  }
  // High end, the same question from the other side — and the same correction.
  for (let i = 0; i < budget; i += 1) {
    const j = n - 1 - i;
    const outlier = sorted[hi] - sorted[j];
    const gap = sorted[j] - sorted[j - 1];
    if (outlier <= content * TINY && gap >= content * SEPARATE) hi = j - 1;
  }
  return hi > lo ? { min: sorted[lo], max: sorted[hi] } : null;
}

/**
 * The frame for a display list: its content, not its outliers.
 *
 * Returns `null` for an empty list. An axis that cannot be fenced keeps its
 * raw extents, so this never returns something narrower than the geometry
 * unless it is confident about what it dropped.
 */
export function framedBounds(list: DisplayList): Bounds | null {
  if (!list.ops.length) return null;
  const raw: Bounds = { min: { ...list.min }, max: { ...list.max } };

  const xs: number[] = [];
  const ys: number[] = [];
  const stride = Math.max(1, Math.ceil(list.ops.length / MAX_OPS));
  for (let i = 0; i < list.ops.length; i += stride) {
    const op = list.ops[i];
    if (op.kind === 'text') {
      xs.push(op.position.x);
      ys.push(op.position.y);
    } else {
      // EVERY point of the subpath, not just its first. Sampling `sub[0]`
      // alone misses where a polyline GOES: a grid line whose first vertex
      // sits inside the core and whose far end is 30 m away reads as a point
      // in the middle, and the frame it produces crops the drawing it was
      // supposed to contain.
      for (const sub of op.subpaths) {
        for (const p of sub) {
          xs.push(p.x);
          ys.push(p.y);
        }
      }
    }
  }
  if (xs.length < MIN_SAMPLES) return raw;

  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const x = trimmedSpan(xs);
  const y = trimmedSpan(ys);
  if (!x && !y) return raw;

  return {
    min: { x: x ? x.min : raw.min.x, y: y ? y.min : raw.min.y },
    max: { x: x ? x.max : raw.max.x, y: y ? y.max : raw.max.y },
  };
}
