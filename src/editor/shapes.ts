// Shared plan-shape builders used by both the renderer and hit-testing,
// so what you see is exactly what you pick.
import type {
  AnyElement,
  BeamElement,
  ColumnElement,
  DimensionElement,
  DoorElement,
  FurnitureElement,
  StairElement,
  TextElement,
  Vec2,
  WallElement,
  WindowElement,
} from '../core/types';
import {
  add,
  dist,
  mul,
  norm,
  openingEnds,
  perp,
  polygonBounds,
  rot,
  sub,
  wallDir,
  wallOutline,
} from '../core/geometry';
import type { BIMModel } from '../core/model';

export type EffFn = (el: AnyElement | undefined) => AnyElement | undefined;

/** corners of a rectangle centred at `center`, rotated by `rotation` (CCW model) */
export function rectCorners(center: Vec2, w: number, d: number, rotation: number): Vec2[] {
  const hw = w / 2;
  const hd = d / 2;
  return [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ].map((p) => add(center, rot(p, rotation)));
}

export const columnCorners = (c: ColumnElement): Vec2[] =>
  rectCorners(c.position, c.width, c.depth, c.rotation);

export const furnitureCorners = (f: FurnitureElement): Vec2[] =>
  rectCorners(f.position, f.width, f.depth, f.rotation);

/** stair footprint; position is the corner at the start of the run */
export function stairCorners(s: StairElement): Vec2[] {
  const d = rot({ x: 1, y: 0 }, s.rotation);
  const n = perp(d);
  const p0 = s.position;
  const p1 = add(p0, mul(d, s.length));
  return [p0, p1, add(p1, mul(n, s.width)), add(p0, mul(n, s.width))];
}

export function beamCorners(b: BeamElement): Vec2[] {
  const d = norm(sub(b.end, b.start));
  const n = mul(perp(d), b.width / 2);
  return [add(b.start, n), add(b.end, n), sub(b.end, n), sub(b.start, n)];
}

/** plan rectangle of a door/window gap across the host wall thickness */
export function openingPolygon(
  w: WallElement,
  o: { offset: number; width: number },
): Vec2[] {
  const { a, b } = openingEnds(w, o);
  const n = mul(perp(wallDir(w)), w.thickness / 2);
  return [add(a, n), add(b, n), sub(b, n), sub(a, n)];
}

/** solid [t0,t1] intervals along a wall of length L after cutting opening gaps */
export function wallSolidIntervals(
  L: number,
  openings: { offset: number; width: number }[],
): [number, number][] {
  const gaps = openings
    .map(
      (o) =>
        [Math.max(0, o.offset - o.width / 2), Math.min(L, o.offset + o.width / 2)] as [
          number,
          number,
        ],
    )
    .filter((g) => g[1] - g[0] > 0.5)
    .sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const g of gaps) {
    const last = merged[merged.length - 1];
    if (last && g[0] <= last[1] + 0.5) last[1] = Math.max(last[1], g[1]);
    else merged.push([g[0], g[1]]);
  }
  const out: [number, number][] = [];
  let t = 0;
  for (const g of merged) {
    if (g[0] - t > 0.5) out.push([t, g[0]]);
    t = g[1];
  }
  if (L - t > 0.5) out.push([t, L]);
  return out;
}

/** rectangle of one solid wall sub-segment */
export function wallSegmentCorners(w: WallElement, t0: number, t1: number): Vec2[] {
  const d = wallDir(w);
  const n = mul(perp(d), w.thickness / 2);
  const a = add(w.start, mul(d, t0));
  const b = add(w.start, mul(d, t1));
  return [add(a, n), add(b, n), sub(b, n), sub(a, n)];
}

/** per-line vertical extent around the draw baseline, as multiples of `size`,
 * for each CAD vertical justification (mirrors V_BASELINE in render.ts, plus a
 * 0.25 margin so the box is comfortable to pick) */
const V_EXTENT: Record<string, [number, number]> = {
  top: [-0.25, 1.25],
  middle: [-0.75, 0.75],
  bottom: [-1.25, 0.25],
  baseline: [-1.05, 0.45],
};

/**
 * Approximate plan box of a text element, laid out exactly the way the
 * renderer draws it: `position` is an anchor, not necessarily the centre, so
 * hAlign/vAlign decide which side of it the block sits on, and multi-line text
 * grows downward at 1.25×size line height. Glyph width is estimated at
 * 0.62×size per character (canvas measureText is unavailable here, and this is
 * the same estimate the renderer's own selection outline has always used).
 * Returned counter-clockwise from the model-space lower-left corner.
 */
export function textCorners(t: TextElement): Vec2[] {
  const lines = t.text.split('\n');
  const cols = lines.reduce((m, l) => Math.max(m, l.length), 1);
  const w = cols * t.size * 0.62;
  const hAlign = t.hAlign ?? 'center';
  const x0 = hAlign === 'left' ? 0 : hAlign === 'right' ? -w : -w / 2;
  const x1 = x0 + w;

  const vAlign = t.vAlign ?? 'middle';
  const [lo, hi] = V_EXTENT[vAlign] ?? V_EXTENT.middle;
  const lh = t.size * 1.25;
  // the renderer shifts a multi-line block so the anchor lands where CAD puts it
  let y0 = 0;
  if (lines.length > 1) {
    if (vAlign === 'middle') y0 = -((lines.length - 1) * lh) / 2;
    else if (vAlign === 'bottom' || vAlign === 'baseline') y0 = -(lines.length - 1) * lh;
  }
  // screen-space y grows downward; model-space y grows upward
  const yTop = y0 + lo * t.size;
  const yBot = y0 + (lines.length - 1) * lh + hi * t.size;
  const local: Vec2[] = [
    { x: x0, y: -yBot },
    { x: x1, y: -yBot },
    { x: x1, y: -yTop },
    { x: x0, y: -yTop },
  ];
  return local.map((p) => add(t.position, rot(p, t.rotation)));
}

/**
 * The corner of a text box used as its interactive resize grip: the one
 * farthest from the anchor (so dragging it always has usable leverage),
 * preferring the lower-right corner when several tie — which is where a
 * centred label, the common case, puts its handle.
 */
export function textGripPoint(t: TextElement): Vec2 {
  const cs = textCorners(t);
  let best = cs[1];
  let bestD = -Infinity;
  for (const i of [1, 2, 0, 3]) {
    const d = dist(cs[i], t.position);
    if (d > bestD) {
      bestD = d;
      best = cs[i];
    }
  }
  return best;
}

/**
 * Live endpoints of a dimension: anchors glued to wall start/end override the
 * stored points. Anchors are matched to whichever stored endpoint they sit
 * closest to, so ordering in the array does not matter.
 */
export function resolveDimensionEnds(
  model: BIMModel,
  el: DimensionElement,
  eff?: EffFn,
): { a: Vec2; b: Vec2 } {
  let a = el.start;
  let b = el.end;
  const anchors = el.anchors ?? [];
  const pts: Vec2[] = [];
  for (const anc of anchors) {
    const raw = model.get(anc.elementId);
    const host = eff ? eff(raw) : raw;
    if (host && host.type === 'wall') {
      pts.push(anc.end === 'start' ? host.start : host.end);
    }
  }
  if (pts.length === 1) {
    const p = pts[0];
    if (dist(p, a) <= dist(p, b)) a = p;
    else b = p;
  } else if (pts.length >= 2) {
    const [p, q] = pts;
    if (dist(p, a) + dist(q, b) <= dist(p, b) + dist(q, a)) {
      a = p;
      b = q;
    } else {
      a = q;
      b = p;
    }
  }
  return { a, b };
}

/** plan-space bounding box of any element, or null when it has none */
export function elementBounds(
  el: AnyElement,
  model: BIMModel,
  eff?: EffFn,
): { min: Vec2; max: Vec2 } | null {
  switch (el.type) {
    case 'wall':
      return polygonBounds(wallOutline(el));
    case 'door':
    case 'window': {
      const raw = model.get(el.hostWallId);
      const host = eff ? eff(raw) : raw;
      if (!host || host.type !== 'wall') return null;
      return polygonBounds(openingPolygon(host, el));
    }
    case 'slab':
      return el.outline.length ? polygonBounds(el.outline) : null;
    case 'room':
      return el.boundary.length ? polygonBounds(el.boundary) : null;
    case 'refline':
      return el.points.length ? polygonBounds(el.points) : null;
    case 'column':
      return polygonBounds(columnCorners(el));
    case 'beam':
      return polygonBounds(beamCorners(el));
    case 'stair':
      return polygonBounds(stairCorners(el));
    case 'furniture':
      return polygonBounds(furnitureCorners(el));
    case 'dimension': {
      const { a, b } = resolveDimensionEnds(model, el, eff);
      const d = norm(sub(b, a));
      const n = mul(perp(d), el.offsetDist);
      return polygonBounds([a, b, add(a, n), add(b, n)]);
    }
    case 'text':
      return polygonBounds(textCorners(el));
    default:
      return null;
  }
}

export type Opening = DoorElement | WindowElement;
