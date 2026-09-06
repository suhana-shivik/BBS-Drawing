// ============================================================
// THE authoritative section geometry.
//
// One box per section, defined once, used by both the PNG path and the DXF
// path. This file exists because the previous implementation kept two copies
// of the band-box arithmetic and one of them produced a zero-height crop —
// the kind of bug that renders a blank image and reports success.
//
// So there is exactly one rule here and it is enforced by construction:
//
//     A SectionBounds is millimetres. `toSourceUnits` is the ONLY place a
//     bounds becomes source units, and only the DXF writer needs that.
//
// Bounds are deliberately GENEROUS. An arc is measured by its full circle, a
// spline by its control hull, a block by its definition box. Every one of
// those over-estimates, and over-estimating is the safe direction: an extra
// neighbouring entity in a section costs nothing, a clipped dimension chain
// costs the number someone reads off it.
// ============================================================
import { expandVertices } from '../displayList';
import type {
  CadBlock,
  CadDocument,
  CadEntity,
  Vec2,
} from '../types';
import type { SectionBounds, SectionLimitation } from './types';

/**
 * Average glyph advance as a fraction of cap height.
 *
 * Same value the text harvester uses (`bbs/extract.ts` GLYPH_ADVANCE), so a
 * text entity's box here agrees with the box it is given there. If one moves,
 * move both.
 */
const GLYPH_ADVANCE = 0.62;

/** how deep a block may nest before bounds stop descending */
const MAX_BLOCK_DEPTH = 4;

/** MINSERT arrays past this are measured by their first cell and flagged */
const MAX_ARRAY_CELLS = 10_000;

/** bounds identity is rounded to this, in mm — see `boundsKey` */
const IDENTITY_MM = 1;

interface Box {
  min: Vec2;
  max: Vec2;
}

// ------------------------------------------------------------
// bounds algebra
// ------------------------------------------------------------

/** Order the corners. A box typed the wrong way round is a box, not an error. */
export function normaliseBounds(b: SectionBounds): SectionBounds {
  return {
    xMin: Math.min(b.xMin, b.xMax),
    yMin: Math.min(b.yMin, b.yMax),
    xMax: Math.max(b.xMin, b.xMax),
    yMax: Math.max(b.yMin, b.yMax),
  };
}

export function boundsFromCorners(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): SectionBounds {
  return normaliseBounds({ xMin: x1, yMin: y1, xMax: x2, yMax: y2 });
}

export function boundsWidth(b: SectionBounds): number {
  return b.xMax - b.xMin;
}

export function boundsHeight(b: SectionBounds): number {
  return b.yMax - b.yMin;
}

export function boundsArea(b: SectionBounds): number {
  return Math.max(0, boundsWidth(b)) * Math.max(0, boundsHeight(b));
}

/**
 * A box with no extent in one axis renders as a blank strip and clips every
 * entity out of the DXF. It is always a bug upstream, and it must be caught
 * here rather than discovered in the output.
 */
export function isDegenerate(b: SectionBounds): boolean {
  return (
    !Number.isFinite(b.xMin) ||
    !Number.isFinite(b.yMin) ||
    !Number.isFinite(b.xMax) ||
    !Number.isFinite(b.yMax) ||
    boundsWidth(b) <= 0 ||
    boundsHeight(b) <= 0
  );
}

/** Grow a box by a fraction of its own size, floored so a thin box survives. */
export function padBounds(b: SectionBounds, fraction: number): SectionBounds {
  const w = Math.max(boundsWidth(b), 1);
  const h = Math.max(boundsHeight(b), 1);
  // cross-floors: a box whose texts happen to be collinear would otherwise
  // pad to nothing in the collapsed axis
  const padX = Math.max(w * fraction, h * fraction * 0.5);
  const padY = Math.max(h * fraction, w * fraction * 0.5);
  return {
    xMin: b.xMin - padX,
    yMin: b.yMin - padY,
    xMax: b.xMax + padX,
    yMax: b.yMax + padY,
  };
}

export function boundsIntersect(a: SectionBounds, b: SectionBounds): boolean {
  return a.xMin <= b.xMax && a.xMax >= b.xMin && a.yMin <= b.yMax && a.yMax >= b.yMin;
}

export function boundsContains(outer: SectionBounds, inner: SectionBounds): boolean {
  return (
    inner.xMin >= outer.xMin &&
    inner.xMax <= outer.xMax &&
    inner.yMin >= outer.yMin &&
    inner.yMax <= outer.yMax
  );
}

export function unionBounds(a: SectionBounds, b: SectionBounds): SectionBounds {
  return {
    xMin: Math.min(a.xMin, b.xMin),
    yMin: Math.min(a.yMin, b.yMin),
    xMax: Math.max(a.xMax, b.xMax),
    yMax: Math.max(a.yMax, b.yMax),
  };
}

/** Clamp a requested box to the sheet, so a wild coordinate cannot escape it. */
export function clampToSheet(b: SectionBounds, sheet: SectionBounds | null): SectionBounds {
  if (!sheet) return b;
  return {
    xMin: Math.max(b.xMin, sheet.xMin),
    yMin: Math.max(b.yMin, sheet.yMin),
    xMax: Math.min(b.xMax, sheet.xMax),
    yMax: Math.min(b.yMax, sheet.yMax),
  };
}

/**
 * Stable identity for deduplication.
 *
 * Rounded to the millimetre: two requests that resolve to the same box are the
 * same region and must not become REGION-04 and REGION-09 with identical
 * geometry. Two boxes that merely OVERLAP get different keys and stay separate
 * sections, because an overlap is frequently deliberate — a detail inside a
 * layout is a different useful thing from the layout.
 */
export function boundsKey(b: SectionBounds): string {
  const r = (v: number): number => Math.round(v / IDENTITY_MM) * IDENTITY_MM;
  return `${r(b.xMin)}:${r(b.yMin)}:${r(b.xMax)}:${r(b.yMax)}`;
}

// ------------------------------------------------------------
// the one unit conversion
// ------------------------------------------------------------

/**
 * Millimetres → source units. The ONLY such conversion in the codebase's
 * section path, and only the DXF writer is entitled to call it.
 *
 * `doc.entities` are in source units; `doc.extents` are in mm. Everything the
 * orchestrator sees, everything stored in a package, and every box passed
 * around this module is mm.
 */
export function toSourceUnits(b: SectionBounds, unitScale: number): SectionBounds {
  const k = unitScale || 1;
  return { xMin: b.xMin / k, yMin: b.yMin / k, xMax: b.xMax / k, yMax: b.yMax / k };
}

/** Source units → millimetres. */
export function toMillimetres(b: SectionBounds, unitScale: number): SectionBounds {
  const k = unitScale || 1;
  return { xMin: b.xMin * k, yMin: b.yMin * k, xMax: b.xMax * k, yMax: b.yMax * k };
}

/** The sheet's own box, in mm, straight from the parser. */
export function sheetBounds(doc: CadDocument): SectionBounds | null {
  if (!doc.extents) return null;
  return boundsFromCorners(
    doc.extents.min.x,
    doc.extents.min.y,
    doc.extents.max.x,
    doc.extents.max.y,
  );
}

// ------------------------------------------------------------
// entity bounds — source units
// ------------------------------------------------------------

function boxOf(points: readonly Vec2[]): Box | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return null;
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/**
 * The rendered box of a TEXT/MTEXT, in source units.
 *
 * The parser's own bounds walker uses the insertion POINT for text, which is
 * right for clustering and wrong here: a 40-character note anchored just
 * outside a section would be excluded even though most of it is inside. §7
 * asks for effective bounds, so this estimates the glyph run and honours the
 * alignment and rotation.
 */
function textBox(e: Extract<CadEntity, { type: 'text' }>): Box {
  const h = Math.abs(e.height) || 1;
  const wf = e.widthFactor > 0 ? e.widthFactor : 1;
  const chars = e.text.length || 1;
  let w = chars * h * wf * GLYPH_ADVANCE;
  let lines = 1;
  if (e.wrapWidth > 0 && w > e.wrapWidth) {
    lines = Math.max(1, Math.ceil(w / e.wrapWidth));
    w = e.wrapWidth;
  }
  const totalH = h * lines;

  // unrotated extents relative to the insertion point
  let x0 = 0;
  let x1 = w;
  if (e.hAlign === 'center') {
    x0 = -w / 2;
    x1 = w / 2;
  } else if (e.hAlign === 'right') {
    x0 = -w;
    x1 = 0;
  }
  // a descender hangs below the baseline; being generous downward is free
  let y0 = -h * 0.25;
  let y1 = totalH;
  if (e.vAlign === 'middle') {
    y0 = -totalH / 2;
    y1 = totalH / 2;
  } else if (e.vAlign === 'top') {
    y0 = -totalH;
    y1 = 0;
  } else if (e.vAlign === 'bottom') {
    y0 = 0;
    y1 = totalH;
  }

  const cos = Math.cos(e.rotation);
  const sin = Math.sin(e.rotation);
  const corners: Vec2[] = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ].map((p) => ({
    x: e.position.x + p.x * cos - p.y * sin,
    y: e.position.y + p.x * sin + p.y * cos,
  }));
  return boxOf(corners) ?? { min: e.position, max: e.position };
}

/**
 * The box an INSERT occupies, including its block's contents and any MINSERT
 * array — in source units.
 *
 * Checking the insertion point alone (§7 forbids exactly this) would drop
 * every symbol whose anchor sits outside the cut while its geometry sits
 * inside it.
 */
function insertBox(
  e: Extract<CadEntity, { type: 'insert' }>,
  blocks: Map<string, CadBlock> | undefined,
  depth: number,
  limits: Map<string, SectionLimitation>,
): Box {
  const anchor: Box = { min: { ...e.position }, max: { ...e.position } };
  const block = blocks?.get(e.blockName.toUpperCase()) ?? blocks?.get(e.blockName);
  if (!block) {
    note(limits, 'block-not-found', `block "${e.blockName}" is not defined; measured by its insertion point`);
    return anchor;
  }
  if (depth >= MAX_BLOCK_DEPTH) {
    note(limits, 'depth-limit', `block "${e.blockName}" nests deeper than ${MAX_BLOCK_DEPTH}; measured by its insertion point`);
    return anchor;
  }

  const inner: Vec2[] = [];
  for (const child of block.entities) {
    const b = entityBoxSource(child, blocks, depth + 1, limits);
    if (b) inner.push(b.min, b.max, { x: b.min.x, y: b.max.y }, { x: b.max.x, y: b.min.y });
  }
  const bb = boxOf(inner);
  if (!bb) return anchor;

  const cos = Math.cos(e.rotation);
  const sin = Math.sin(e.rotation);
  const sx = e.scale.x || 1;
  const sy = e.scale.y || 1;
  const placed: Vec2[] = [];
  for (const corner of [
    bb.min,
    { x: bb.max.x, y: bb.min.y },
    bb.max,
    { x: bb.min.x, y: bb.max.y },
  ]) {
    const lx = (corner.x - block.basePoint.x) * sx;
    const ly = (corner.y - block.basePoint.y) * sy;
    placed.push({
      x: e.position.x + lx * cos - ly * sin,
      y: e.position.y + lx * sin + ly * cos,
    });
  }
  const one = boxOf(placed) ?? anchor;

  // MINSERT: the array occupies far more than its first cell, and a take-off
  // that measured only the first cell would put the rest outside every section
  const cols = Math.max(1, Math.floor(e.cols) || 1);
  const rows = Math.max(1, Math.floor(e.rows) || 1);
  if (cols * rows <= 1) return one;
  if (cols * rows > MAX_ARRAY_CELLS) {
    note(limits, 'unclippable-entity', `MINSERT "${e.blockName}" arrays ${cols}x${rows}; measured by its first cell`);
    return one;
  }
  const dx = (cols - 1) * e.colSpacing;
  const dy = (rows - 1) * e.rowSpacing;
  // the array steps along the INSERT's own rotated axes
  const stepped: Vec2[] = [];
  for (const corner of [one.min, one.max]) {
    stepped.push(corner);
    stepped.push({
      x: corner.x + dx * cos - dy * sin,
      y: corner.y + dx * sin + dy * cos,
    });
  }
  return boxOf(stepped) ?? one;
}

function note(
  limits: Map<string, SectionLimitation>,
  code: SectionLimitation['code'],
  message: string,
): void {
  const key = `${code}:${message}`;
  const hit = limits.get(key);
  if (hit) hit.count += 1;
  else limits.set(key, { code, message, count: 1 });
}

/**
 * Bounding box of one entity in SOURCE units, or null when it has no
 * measurable geometry.
 */
export function entityBoxSource(
  e: CadEntity,
  blocks?: Map<string, CadBlock>,
  depth = 0,
  limits: Map<string, SectionLimitation> = new Map(),
): Box | null {
  switch (e.type) {
    case 'line':
      return boxOf([e.a, e.b]);
    case 'polyline':
      // expandVertices tessellates bulge arcs — a bulged segment bows OUTSIDE
      // the hull of its two vertices, so the vertex list alone under-measures
      return boxOf(expandVertices(e.vertices, e.closed));
    case 'circle':
    case 'arc':
      // an arc is measured by its full circle: conservative, and identical to
      // what the parser does, so section bounds and region bounds agree
      return boxOf([
        { x: e.center.x - e.radius, y: e.center.y - e.radius },
        { x: e.center.x + e.radius, y: e.center.y + e.radius },
      ]);
    case 'ellipse': {
      const r = Math.hypot(e.major.x, e.major.y);
      return boxOf([
        { x: e.center.x - r, y: e.center.y - r },
        { x: e.center.x + r, y: e.center.y + r },
      ]);
    }
    case 'spline':
      return boxOf(e.fitPoints.length ? e.fitPoints : e.controlPoints);
    case 'text':
      return textBox(e);
    case 'insert':
      return insertBox(e, blocks, depth, limits);
    case 'solid':
      return boxOf(e.points);
    case 'point':
      return boxOf([e.position]);
    case 'hatch': {
      const pts: Vec2[] = [];
      for (const loop of e.loops) pts.push(...expandVertices(loop.vertices, true));
      return boxOf(pts);
    }
    default:
      return null;
  }
}

/** Bounding box of one entity in MILLIMETRES. */
export function entityBoundsMm(
  e: CadEntity,
  doc: CadDocument,
  limits?: Map<string, SectionLimitation>,
): SectionBounds | null {
  const box = entityBoxSource(e, doc.blocks, 0, limits);
  if (!box) return null;
  const k = doc.unitScale || 1;
  return boundsFromCorners(box.min.x * k, box.min.y * k, box.max.x * k, box.max.y * k);
}

// ------------------------------------------------------------
// selection
// ------------------------------------------------------------

/**
 * How an entity straddling the section edge is treated.
 *
 * `intersect` — anything whose geometry reaches into the box belongs to it.
 *   This is the default and what §7 describes: a long grid line crossing the
 *   section is part of the section.
 * `contain` — only entities wholly inside. Produces a tidier but poorer cut;
 *   offered because a schedule table crop genuinely does not want the leader
 *   lines running off it.
 */
export type SectionPolicy = 'intersect' | 'contain';

export interface EntitySelection {
  entities: CadEntity[];
  /** handles, in document order */
  handles: string[];
  limitations: SectionLimitation[];
}

/**
 * Every modelspace entity belonging to `boundsMm`.
 *
 * Geometric intersection, never insertion-point testing. Entities with no
 * measurable geometry are dropped and counted rather than emitted broken —
 * §7: "If a particular entity type cannot safely be clipped or included, do
 * not silently corrupt it. Record the limitation."
 */
export function entitiesInBounds(
  doc: CadDocument,
  boundsMm: SectionBounds,
  policy: SectionPolicy = 'intersect',
): EntitySelection {
  const limits = new Map<string, SectionLimitation>();
  const box = normaliseBounds(boundsMm);
  const entities: CadEntity[] = [];
  const handles: string[] = [];

  if (isDegenerate(box)) {
    note(limits, 'degenerate-bounds', `bounds ${boundsKey(box)} has no area; no entities selected`);
    return { entities, handles, limitations: [...limits.values()] };
  }

  let unmeasurable = 0;
  for (const e of doc.entities) {
    const eb = entityBoundsMm(e, doc, limits);
    if (!eb) {
      unmeasurable += 1;
      continue;
    }
    const inside = policy === 'contain' ? boundsContains(box, eb) : boundsIntersect(box, eb);
    if (!inside) continue;
    entities.push(e);
    handles.push(e.style.handle);
  }

  if (unmeasurable > 0) {
    note(
      limits,
      'unclippable-entity',
      `${unmeasurable} entit${unmeasurable === 1 ? 'y has' : 'ies have'} no measurable geometry and were left out`,
    );
  }
  if (entities.length === 0) {
    note(limits, 'no-geometry', `nothing is drawn inside ${boundsKey(box)}`);
  }

  return { entities, handles, limitations: [...limits.values()] };
}

// ------------------------------------------------------------
// disjoint-content detection — a box can be geometrically correct and
// semantically wrong
// ------------------------------------------------------------

/**
 * How far a gap must run, as a fraction of the axis extent, before the
 * content on either side counts as two different things rather than one
 * sparse thing.
 *
 * Chosen empirically against the real GAMCO sheet, not guessed: eighteen
 * independently-produced sections — including a 25 m layout band and a
 * narrow two-storey wall section — the worst had a 12.5% gap. The known bad
 * merge (a tie-beam cut that had swallowed a neighbouring column detail's
 * caption) measured 24.1%. 20% sits with several points of margin on both
 * sides; see `tests/domain/drawing-splitter-gap.test.ts`.
 */
const DISCONNECT_GAP_FRACTION = 0.2;
/**
 * A first version of the background filter compared every entity's diagonal
 * to `median * factor`. It broke on small, size-diverse selections: five
 * items — a line, two short text callouts, a stray caption, and one huge
 * frame polyline — put the MEDIAN close to the small text sizes purely
 * because text items outnumbered everything else, so the filter excluded
 * the legitimate LINE along with the frame. With the line gone, nothing
 * distinctive remained to find the real split by.
 *
 * The replacement asks a different question: is there a single dramatic
 * JUMP in the sorted sizes, and is whatever sits above that jump a small
 * MINORITY of the selection? Sheet scaffolding — a title-block border, a
 * full-width frame rectangle — is always a handful of entities dwarfing
 * everything else, never a large share of what got selected. On the real
 * GAMCO sheet, genuine background entities were 2–4 items out of 18–660
 * (0.5%–22%) at jumps of 2.8×–13.3×; sections whose largest size-jump was
 * merely "text vs. this detail's own thicker geometry" excluded 40–68 items
 * out of 42–92 (68%–95%) at similar-looking jumps of 4.8×–5.7×. The two
 * populations do not overlap; `BACKGROUND_MAX_FRACTION` sits with wide
 * margin between them. See `tests/domain/drawing-splitter-gap.test.ts`.
 */
const BACKGROUND_RATIO_FLOOR = 2;
/** below this sample size, "background vs. normal" cannot be told apart — see excludeOutlierSized */
const MIN_ITEMS_FOR_BACKGROUND_FILTER = 10;
const BACKGROUND_MAX_FRACTION = 0.3;
/** below this the selection is too sparse to tell "empty" from "just spread out" */
const MIN_ITEMS_FOR_GAP_CHECK = 3;
/** bounds a pathological handle list to a fixed amount of work, never a loop */
const MAX_TIGHTEN_ITERATIONS = 4;

interface BoundedEntity {
  e: CadEntity;
  b: SectionBounds;
}

function diagonalOf(b: SectionBounds): number {
  return Math.hypot(b.xMax - b.xMin, b.yMax - b.yMin);
}

/**
 * Items with a genuinely outlying bounding-box diagonal — sheet scaffolding
 * that would otherwise bridge every gap on the page — set aside for the
 * purpose of FINDING where the split is. Nothing is discarded for good here:
 * `axisGap` reclassifies every excluded item back into majority or minority
 * by where it actually sits once the split is known (see below), so a
 * legitimate large entity that happened to look like an outlier in a small
 * sample still ends up on the correct side rather than silently dropped.
 */
function excludeOutlierSized(items: readonly BoundedEntity[]): readonly BoundedEntity[] {
  // Telling "background scaffolding" apart from "the single largest normal
  // thing in a small drawing" needs enough samples to establish what normal
  // even looks like. Below this count, one legitimate line among a couple of
  // short text captions is ALREADY a large share of the selection on size
  // alone — a 4-item cluster excludes 25% of itself by dropping just one
  // item, comfortably inside `BACKGROUND_MAX_FRACTION`, and that one item
  // was the real content, not a border. Every real background entity this
  // module was validated against sat in a selection of at least 18 (see
  // `BACKGROUND_MAX_FRACTION`'s own comment); this floor stays safely below
  // that so genuine cases are untouched, while a sparse one skips the filter
  // and uses everything it has.
  if (items.length < MIN_ITEMS_FOR_BACKGROUND_FILTER) return items;
  const withDiag = items.map((r) => ({ r, d: diagonalOf(r.b) })).sort((a, b) => a.d - b.d);
  let bestRatio = 1;
  let cutAt = withDiag.length;
  for (let i = 1; i < withDiag.length; i++) {
    const ratio = withDiag[i].d / Math.max(withDiag[i - 1].d, 1e-6);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      cutAt = i;
    }
  }
  const excludedCount = withDiag.length - cutAt;
  if (bestRatio < BACKGROUND_RATIO_FLOOR) return items; // no clear jump at all
  if (excludedCount / items.length > BACKGROUND_MAX_FRACTION) return items; // not a minority — real content varies in size too
  return withDiag.slice(0, cutAt).map((x) => x.r);
}

interface AxisSplit {
  axis: 'x' | 'y';
  fraction: number;
  majority: BoundedEntity[];
  minority: BoundedEntity[];
}

/**
 * The largest gap in the union of this axis's projected intervals, and which
 * items sit on the smaller side of it.
 *
 * Interval-merge, not centroid clustering: a callout's text is routinely
 * placed a metre or more from what it labels (the leader carries the visual
 * link), so text-to-text CENTRE distance is not a reliable "same detail"
 * signal — it flagged a legitimate P.C.C. bedding note as more distant from
 * its own detail than an actual stray caption from a different one. The
 * entity's drawn FOOTPRINT is what a gap in it means empty sheet.
 */
function axisGap(items: readonly BoundedEntity[], axis: 'x' | 'y'): AxisSplit | null {
  const content = excludeOutlierSized(items);
  if (content.length < MIN_ITEMS_FOR_GAP_CHECK) return null;

  const sorted = [...content].sort(
    (a, b) => (axis === 'x' ? a.b.xMin - b.b.xMin : a.b.yMin - b.b.yMin),
  );
  const spans: { lo: number; hi: number; members: BoundedEntity[] }[] = [];
  for (const r of sorted) {
    const lo = axis === 'x' ? r.b.xMin : r.b.yMin;
    const hi = axis === 'x' ? r.b.xMax : r.b.yMax;
    const last = spans[spans.length - 1];
    if (last && lo <= last.hi) {
      last.hi = Math.max(last.hi, hi);
      last.members.push(r);
    } else {
      spans.push({ lo, hi, members: [r] });
    }
  }
  if (spans.length < 2) return null;

  const total = spans[spans.length - 1].hi - spans[0].lo;
  if (!(total > 0)) return null;

  let maxGap = 0;
  let splitAt = -1;
  for (let i = 1; i < spans.length; i++) {
    const gap = spans[i].lo - spans[i - 1].hi;
    if (gap > maxGap) {
      maxGap = gap;
      splitAt = i;
    }
  }
  if (splitAt < 0) return null;

  // majority/minority are drawn from CONTENT ONLY, never reclassified back
  // in from the full item list. An earlier version DID reclassify every
  // item — including whatever excludeOutlierSized had set aside — by which
  // side of the found boundary it geometrically fell on, meaning to stop a
  // legitimate large entity from being dropped for merely looking like an
  // outlier in a small sample. It backfired outright: a sheet-wide
  // title-block border, correctly excluded from CONTENT, got pulled straight
  // back into majority by that reclassification — and majorityBounds is a
  // union over majority, so the border's own 47-metre extent became the
  // "tightened" box. The box never shrank on a single iteration; the loop
  // reported the same outlier dropped four times over while nothing had
  // moved. `excludeOutlierSized`'s ratio-jump-plus-fraction-cap test is
  // validated with wide margin against fourteen real sections (see its own
  // doc comment) — trusting its verdict outright, rather than
  // second-guessing it per item afterwards, is what keeps a background
  // entity's size from ever reaching `majorityBounds` again.
  const left = spans.slice(0, splitAt).flatMap((s) => s.members);
  const right = spans.slice(splitAt).flatMap((s) => s.members);
  const [majority, minority] = left.length >= right.length ? [left, right] : [right, left];
  if (majority.length < MIN_ITEMS_FOR_GAP_CHECK) return null;

  return { axis, fraction: maxGap / total, majority, minority };
}

/** whichever axis shows the stronger disconnection, or null if neither does */
function largestAxisGap(items: readonly BoundedEntity[]): AxisSplit | null {
  const x = axisGap(items, 'x');
  const y = axisGap(items, 'y');
  if (!x) return y;
  if (!y) return x;
  return x.fraction >= y.fraction ? x : y;
}

/** narrowest box lying within both — the only way this module ever shrinks a box */
function intersectBounds(a: SectionBounds, b: SectionBounds): SectionBounds {
  return {
    xMin: Math.max(a.xMin, b.xMin),
    yMin: Math.max(a.yMin, b.yMin),
    xMax: Math.min(a.xMax, b.xMax),
    yMax: Math.min(a.yMax, b.yMax),
  };
}

export interface ConnectedSelection extends EntitySelection {
  /**
   * The bounds actually used — may be tighter than what was asked for. A
   * caller cutting a section MUST use this box for the DXF header and the
   * render, not the one it passed in, or §8's invariant (PNG, DXF and the
   * stored bounds all describe the same region) breaks the moment this
   * function tightens anything.
   */
  bounds: SectionBounds;
}

/**
 * `entitiesInBounds`, but refuses to hand back two disconnected things as
 * one section.
 *
 * WHY THIS EXISTS. `boundsForHandles` measures faithfully from whatever
 * handles it is given (§1: the model points, the platform measures) — which
 * means a handle list that mixes a detail's own callouts with a caption from
 * a *different* detail three metres away produces a box that is
 * geometrically correct and semantically wrong: two details unioned into
 * one, with a stretch of blank sheet between them where nothing is drawn.
 * The model's own contract violation (pointing at the wrong things) cannot
 * be caught by validating the box — the box is exactly what those handles
 * measure to. It has to be caught by looking at what ended up inside it.
 *
 * WHAT IT DOES. Projects the selected entities onto each axis, excluding
 * sheet-scaffolding first (see `excludeOutlierSized`). If the
 * largest resulting gap exceeds `DISCONNECT_GAP_FRACTION` of that axis's
 * extent, the minority side (by entity count) is dropped and the box is
 * retightened to the majority's own footprint — INTERSECTED with the box
 * already in play, so an over-generous bounding-box estimate for one
 * surviving entity can never license the box to grow past what was already
 * selected. Repeats until no gap remains or the iteration cap is hit. Every
 * drop is recorded as a `disjoint-cluster-dropped` limitation — never
 * silently discarded, per §7.
 *
 * WHAT IT DOES NOT DO. It does not try to identify and drop a single
 * isolated caption sitting a bit apart from its own detail — an isolated
 * SECTION TITLE is exactly as isolated by this measure as an isolated STRAY
 * caption, and a heuristic aggressive enough to catch the latter drops the
 * former. One or two straggling entities that fall under the threshold are
 * left in place; the coverage check that runs over the whole package (see
 * `orchestrator.ts`) is a second, independent net for anything this one
 * genuinely misses.
 */
export function connectedEntitiesInBounds(
  doc: CadDocument,
  boundsMm: SectionBounds,
  policy: SectionPolicy = 'intersect',
): ConnectedSelection {
  let box = normaliseBounds(boundsMm);
  let selection = entitiesInBounds(doc, box, policy);
  const dropped: { handle: string; kind: string; text: string }[] = [];

  for (let iter = 0; iter < MAX_TIGHTEN_ITERATIONS && selection.entities.length > 0; iter++) {
    const items: BoundedEntity[] = [];
    for (const e of selection.entities) {
      const b = entityBoundsMm(e, doc);
      if (b) items.push({ e, b });
    }
    const split = largestAxisGap(items);
    if (!split || split.fraction < DISCONNECT_GAP_FRACTION) break;

    for (const r of split.minority) {
      dropped.push({
        handle: r.e.style.handle,
        kind: r.e.type,
        text: r.e.type === 'text' ? r.e.text.trim().slice(0, 60) : '',
      });
    }

    const majorityBounds = split.majority.reduce<SectionBounds | null>(
      (acc, r) => (acc ? unionBounds(acc, r.b) : r.b),
      null,
    );
    if (!majorityBounds) break;
    const tightened = intersectBounds(majorityBounds, box);
    if (isDegenerate(tightened)) break; // never collapse to nothing — keep the prior box

    box = tightened;
    selection = entitiesInBounds(doc, box, policy);
  }

  const limitations = [...selection.limitations];
  if (dropped.length) {
    const named = dropped
      .filter((d) => d.text)
      .slice(0, 5)
      .map((d) => `"${d.text}"`);
    limitations.push({
      code: 'disjoint-cluster-dropped',
      message:
        `${dropped.length} entit${dropped.length === 1 ? 'y sat' : 'ies sat'} across a gap from the rest ` +
        `of this section and ${dropped.length === 1 ? 'was' : 'were'} left out` +
        (named.length ? ` (${named.join(', ')}${dropped.length > named.length ? ', …' : ''})` : '') +
        ' — the box was tightened to the larger, connected group.',
      count: dropped.length,
    });
  }

  return { ...selection, limitations, bounds: box };
}

/**
 * The tight box around a set of text handles — how a semantic request
 * ("the SC typical detail") becomes coordinates.
 *
 * The model points at handles; this measures. It never reads a coordinate the
 * model typed, which is why a model cannot mis-measure a box it never
 * measured. Returns null for fewer than two resolvable handles, because one
 * label is a caption, not a region.
 */
export function boundsForHandles(
  doc: CadDocument,
  handles: readonly string[],
  padFraction = 0.12,
): SectionBounds | null {
  const wanted = new Set(handles);
  let acc: SectionBounds | null = null;
  let found = 0;
  for (const e of doc.entities) {
    if (!wanted.has(e.style.handle)) continue;
    const eb = entityBoundsMm(e, doc);
    if (!eb) continue;
    found += 1;
    acc = acc ? unionBounds(acc, eb) : eb;
  }
  if (!acc || found < 2) return null;
  return padBounds(acc, padFraction);
}
