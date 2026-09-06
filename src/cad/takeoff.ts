// ============================================================
// Quantity takeoff from a CadDocument.
//
// Three schedules fall straight out of the parsed source, provided the
// source is read the way CAD means it rather than the way it draws:
//
//   Blocks   INSERT instances counted by block name. MINSERT arrays count
//            cols x rows, and nested INSERTs inside a block definition are
//            multiplied by the parent's instance count. For an electrical
//            drawing this schedule IS the bill of materials.
//   Lengths  LINE / POLYLINE / ARC / CIRCLE run per layer, in mm. Bulge
//            arcs are measured along the arc (via expandVertices), never
//            across the chord — a door swing is not its chord.
//   Areas    CLOSED polylines and hatch outer loops, shoelace, in mm².
//
// Everything is walked with the same transform stack the display list
// uses, so a block scaled 2x measures 2x. Nothing here tessellates on its
// own; curve handling is borrowed from displayList.ts so the numbers agree
// with what is on screen.
//
// Layer attribution follows the CAD rule: geometry drawn on layer "0"
// inside a block reports on the INSERT's layer, which is what makes the
// per-layer numbers mean anything on symbol-heavy drawings.
// ============================================================
import type {
  CadDocument,
  CadEntity,
  CadHatchLoop,
  Vec2,
} from './types';
import { apply, compose, expandVertices, type Xform } from './displayList';
import { polygonAreaAbs } from '../core/geometry';
import { buildOccurrenceIndex } from './occurrences';

const TAU = Math.PI * 2;

// ------------------------------------------------------------
// public shape
// ------------------------------------------------------------

export interface BlockCount {
  name: string;
  /** actual expanded placements used as the reference quantity */
  count: number;
  /** top-level source INSERTs that can be selected */
  sourceEntityCount: number;
  sourceHandles: string[];
  layers: string[];
}

/** total run of linework on a layer, in mm */
export interface LayerLength {
  layer: string;
  length: number;
  entityCount: number;
}

/** total enclosed area on a layer, in mm² */
export interface AreaItem {
  layer: string;
  area: number;
  count: number;
}

export interface Takeoff {
  blocks: BlockCount[];
  lengths: LayerLength[];
  areas: AreaItem[];
  totals: {
    /** top-level entities inside the scope (region + layer filter) */
    entities: number;
    /** total block instances, MINSERT and nesting included */
    blocks: number;
    /** distinct layers that carried a measurable quantity */
    layers: number;
  };
}

export interface TakeoffOptions {
  /** limit to one region's entities; null/undefined = whole modelspace */
  regionId?: string | null;
  /** limit to these layer names; undefined = every layer */
  layers?: ReadonlySet<string>;
}

/** how deep INSERT nesting is followed when counting symbols */
const MAX_DEPTH = 4;
/** a malformed MINSERT can claim millions of copies; refuse to believe it */
const MAX_ARRAY = 1_000_000;
/** hard ceiling on entity visits so a pathological file cannot hang the tab */
const MAX_VISITS = 2_000_000;

// ------------------------------------------------------------
// small geometry helpers
// ------------------------------------------------------------

/**
 * Average absolute scale of a transform — the same measure displayList uses
 * for tessellation tolerance. Radii scale by this, which is exact for the
 * uniform case and the right average for a mildly anisotropic block.
 */
const scaleOf = (m: Xform): number =>
  (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2 || 1;

function polylineLength(pts: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return total;
}

/**
 * The one loop of a hatch that bounds it. Islands would otherwise be added
 * on top of the region that contains them, inflating the area.
 * Prefer a boundary flagged external (bit 1); otherwise the biggest loop.
 */
function hatchOuterArea(loops: CadHatchLoop[], T: (p: Vec2) => Vec2): number {
  let best = 0;
  let bestExternal = 0;
  for (const loop of loops) {
    const pts = expandVertices(loop.vertices, true);
    if (pts.length < 3) continue;
    const area = polygonAreaAbs(pts.map(T));
    if (area > best) best = area;
    if ((loop.flags & 1) !== 0 && area > bestExternal) bestExternal = area;
  }
  return bestExternal > 0 ? bestExternal : best;
}

// ------------------------------------------------------------
// accumulation
// ------------------------------------------------------------

interface BlockAcc {
  name: string;
  count: number;
  layers: Set<string>;
}

interface Acc {
  blocks: Map<string, BlockAcc>;
  lengths: Map<string, { length: number; entityCount: number }>;
  areas: Map<string, { area: number; count: number }>;
  entities: number;
  visits: number;
}

function addLength(acc: Acc, layer: string, mm: number, weight: number): void {
  if (!(mm > 0)) return;
  let row = acc.lengths.get(layer);
  if (!row) acc.lengths.set(layer, (row = { length: 0, entityCount: 0 }));
  row.length += mm * weight;
  row.entityCount += weight;
}

function addArea(acc: Acc, layer: string, mm2: number, weight: number): void {
  if (!(mm2 > 0)) return;
  let row = acc.areas.get(layer);
  if (!row) acc.areas.set(layer, (row = { area: 0, count: 0 }));
  row.area += mm2 * weight;
  row.count += weight;
}

// ------------------------------------------------------------
// walker
// ------------------------------------------------------------

interface WalkCtx {
  doc: CadDocument;
  acc: Acc;
  filter: ReadonlySet<string> | null;
}

/**
 * Measure one entity.
 *
 * `weight` is how many times this entity really exists — the product of the
 * MINSERT array sizes above it. Carrying a multiplier instead of iterating
 * the array is exact (array copies differ by translation only, which changes
 * neither length nor area) and keeps a 200x200 MINSERT from costing 40,000
 * traversals.
 *
 * `parentLayer` is the layer of the enclosing INSERT, used to resolve the
 * CAD "layer 0 inside a block means the insert's layer" rule.
 */
function walk(
  ctx: WalkCtx,
  e: CadEntity,
  xf: Xform,
  weight: number,
  depth: number,
  path: ReadonlySet<string>,
  parentLayer: string,
): void {
  if (ctx.acc.visits++ > MAX_VISITS) return;

  const layer = e.style.layer === '0' && parentLayer ? parentLayer : e.style.layer;
  if (ctx.filter && !ctx.filter.has(layer)) return;
  if (depth === 0) ctx.acc.entities++;

  const acc = ctx.acc;
  const T = (p: Vec2): Vec2 => apply(xf, p);

  switch (e.type) {
    case 'line': {
      const a = T(e.a);
      const b = T(e.b);
      addLength(acc, layer, Math.hypot(b.x - a.x, b.y - a.y), weight);
      break;
    }

    case 'polyline': {
      const pts = expandVertices(e.vertices, e.closed).map(T);
      addLength(acc, layer, polylineLength(pts), weight);
      // an open polyline encloses nothing — measuring it as if it did is the
      // classic way a takeoff invents floor area that is not there
      if (e.closed && pts.length >= 3) addArea(acc, layer, polygonAreaAbs(pts), weight);
      break;
    }

    case 'arc': {
      // DXF arcs always sweep CCW from start to end; normalise the way the
      // display list does so a wrapped arc measures its real included angle
      let a1 = e.endAngle;
      while (a1 <= e.startAngle) a1 += TAU;
      addLength(acc, layer, e.radius * (a1 - e.startAngle) * scaleOf(xf), weight);
      break;
    }

    case 'circle':
      addLength(acc, layer, TAU * e.radius * scaleOf(xf), weight);
      break;

    case 'hatch':
      addArea(acc, layer, hatchOuterArea(e.loops, T), weight);
      break;

    case 'insert': {
      const key = e.blockName.toUpperCase();
      const block = ctx.doc.blocks.get(key);
      const copies = Math.min(MAX_ARRAY, Math.max(1, e.cols * e.rows));
      const instances = weight * copies;

      let row = acc.blocks.get(key);
      if (!row) acc.blocks.set(key, (row = { name: block?.name ?? e.blockName, count: 0, layers: new Set() }));
      row.count += instances;
      row.layers.add(layer);

      // count the instance, then stop: a self-referencing or absurdly deep
      // block tree must not take the takeoff down with it
      if (!block || depth >= MAX_DEPTH || path.has(key)) break;

      const cos = Math.cos(e.rotation);
      const sin = Math.sin(e.rotation);
      const sx = e.scale.x || 1;
      const sy = e.scale.y || 1;
      // translate ∘ rotate ∘ scale ∘ (-basePoint), matching displayList
      const local: Xform = {
        a: cos * sx, b: sin * sx,
        c: -sin * sy, d: cos * sy,
        e: e.position.x - (cos * sx * block.basePoint.x - sin * sy * block.basePoint.y),
        f: e.position.y - (sin * sx * block.basePoint.x + cos * sy * block.basePoint.y),
      };
      const next = compose(xf, local);
      const nextPath = new Set(path).add(key);
      for (const child of block.entities) {
        walk(ctx, child, next, instances, depth + 1, nextPath, layer);
      }
      break;
    }

    default:
      // text, points, solids, ellipses and splines carry no quantity here.
      // Ellipse/spline length would need displayList's tessellators, which
      // are private to that module — see the note in the module header.
      break;
  }
}

// ------------------------------------------------------------
// entry point
// ------------------------------------------------------------

export function computeTakeoff(doc: CadDocument, opts?: TakeoffOptions): Takeoff {
  const acc: Acc = {
    blocks: new Map(),
    lengths: new Map(),
    areas: new Map(),
    entities: 0,
    visits: 0,
  };

  let source = doc.entities;
  if (opts?.regionId) {
    const region = doc.regions.find((r) => r.id === opts.regionId);
    source = region ? region.indices.map((i) => doc.entities[i]).filter(Boolean) : [];
  }

  // source units → mm, exactly as the display list does it
  const k = doc.unitScale || 1;
  const unit: Xform = { a: k, b: 0, c: 0, d: k, e: 0, f: 0 };
  const ctx: WalkCtx = { doc, acc, filter: opts?.layers ?? null };
  const root: ReadonlySet<string> = new Set<string>();

  for (const e of source) walk(ctx, e, unit, 1, 0, root, '');

  const occurrenceIndex = buildOccurrenceIndex(doc, {
    regionId: opts?.regionId ?? null,
    layers: opts?.layers,
  });
  const blocks: BlockCount[] = occurrenceIndex.blocks.map((b) => ({
    name: b.name,
    count: b.placementCount,
    sourceEntityCount: b.sourceEntityCount,
    sourceHandles: b.sourceHandles,
    layers: b.layers,
  }));

  const lengths: LayerLength[] = [...acc.lengths]
    .map(([layer, r]) => ({ layer, length: r.length, entityCount: r.entityCount }))
    .sort((a, b) => b.length - a.length || a.layer.localeCompare(b.layer));

  const areas: AreaItem[] = [...acc.areas]
    .map(([layer, r]) => ({ layer, area: r.area, count: r.count }))
    .sort((a, b) => b.area - a.area || a.layer.localeCompare(b.layer));

  const layerNames = new Set<string>();
  for (const r of lengths) layerNames.add(r.layer);
  for (const r of areas) layerNames.add(r.layer);
  for (const b of blocks) for (const l of b.layers) layerNames.add(l);

  return {
    blocks,
    lengths,
    areas,
    totals: {
      entities: acc.entities,
      blocks: blocks.reduce((s, b) => s + b.count, 0),
      layers: layerNames.size,
    },
  };
}

// ------------------------------------------------------------
// CSV
// ------------------------------------------------------------

/** display factor from the mm/mm² the takeoff stores */
const PER_MM: Record<string, number> = {
  mm: 1,
  cm: 0.1,
  m: 0.001,
  in: 1 / 25.4,
  ft: 1 / 304.8,
};
const PER_MM2: Record<string, number> = {
  mm: 1,
  cm: 0.01,
  m: 1e-6,
  in: 1 / 645.16,
  ft: 1 / 92903.04,
};

/** RFC 4180: quote anything holding a comma, quote or newline; double the quotes */
function cell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const num = (n: number): string => String(Number(n.toFixed(3)));

const row = (...cells: (string | number)[]): string => cells.map(cell).join(',');

/**
 * Three labelled sections in one file — blocks, lengths, areas — each with a
 * header row and a total. Values are converted out of the stored mm into
 * `unitLabel`; an unrecognised label falls back to mm so the header and the
 * numbers can never disagree.
 */
export function takeoffToCSV(t: Takeoff, unitLabel: string): string {
  const key = unitLabel.trim().toLowerCase();
  const unit = key in PER_MM ? key : 'mm';
  const lf = PER_MM[unit];
  const af = PER_MM2[unit];

  const lines: string[] = [];

  lines.push(row('BLOCKS'));
  lines.push(row('Block', 'Placements', 'Source entities', 'Layers'));
  for (const b of t.blocks) lines.push(row(b.name, b.count, b.sourceEntityCount, b.layers.join(', ')));
  lines.push(row('Total', t.totals.blocks, '', ''));
  lines.push('');

  lines.push(row('LENGTHS'));
  lines.push(row('Layer', `Length (${unit})`, 'Entities'));
  let totalLength = 0;
  let totalLengthEntities = 0;
  for (const l of t.lengths) {
    totalLength += l.length;
    totalLengthEntities += l.entityCount;
    lines.push(row(l.layer, num(l.length * lf), l.entityCount));
  }
  lines.push(row('Total', num(totalLength * lf), totalLengthEntities));
  lines.push('');

  lines.push(row('AREAS'));
  lines.push(row('Layer', `Area (${unit}²)`, 'Count'));
  let totalArea = 0;
  let totalAreaCount = 0;
  for (const a of t.areas) {
    totalArea += a.area;
    totalAreaCount += a.count;
    lines.push(row(a.layer, num(a.area * af), a.count));
  }
  lines.push(row('Total', num(totalArea * af), totalAreaCount));

  return lines.join('\r\n');
}
