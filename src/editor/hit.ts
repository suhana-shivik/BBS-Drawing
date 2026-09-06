// Hit-testing and marquee selection. Picks in reverse painter order so the
// element drawn on top wins.
import type { AnyElement, Vec2 } from '../core/types';
import type { BIMModel } from '../core/model';
import {
  add,
  distPointToSegment,
  mul,
  norm,
  perp,
  pointInPolygon,
  sub,
  wallOutline,
} from '../core/geometry';
import {
  beamCorners,
  columnCorners,
  elementBounds,
  furnitureCorners,
  openingPolygon,
  resolveDimensionEnds,
  stairCorners,
  textCorners,
  type EffFn,
} from './shapes';

/** inside the polygon, or within tol of one of its edges */
function polyHit(pt: Vec2, poly: Vec2[], tol: number): boolean {
  if (poly.length < 3) return false;
  if (pointInPolygon(pt, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    if (distPointToSegment(pt, poly[i], poly[(i + 1) % poly.length]) <= tol) return true;
  }
  return false;
}

function polylineHit(pt: Vec2, pts: Vec2[], closed: boolean, tol: number): boolean {
  const n = pts.length;
  if (n < 2) return false;
  const limit = closed ? n : n - 1;
  for (let i = 0; i < limit; i++) {
    if (distPointToSegment(pt, pts[i], pts[(i + 1) % n]) <= tol) return true;
  }
  return false;
}

/**
 * Topmost element at a model point. `tolMm` is the pick slack in model mm
 * (derive from ~6px / view.scale).
 */
export function hitTest(
  model: BIMModel,
  levelId: string,
  pt: Vec2,
  tolMm: number,
): AnyElement | null {
  const els = model.onLevel(levelId);
  const byType = new Map<string, AnyElement[]>();
  for (const el of els) {
    const arr = byType.get(el.type);
    if (arr) arr.push(el);
    else byType.set(el.type, [el]);
  }
  const list = (t: string): AnyElement[] => byType.get(t) ?? [];

  // reverse painter order: text/dims, then furniture/stairs/beams/columns,
  // then openings, walls, reflines, rooms, slabs
  for (const el of list('text').slice().reverse()) {
    if (el.type === 'text' && polyHit(pt, textCorners(el), tolMm)) return el;
  }
  for (const el of list('dimension').slice().reverse()) {
    if (el.type !== 'dimension') continue;
    const { a, b } = resolveDimensionEnds(model, el);
    const d = norm(sub(b, a));
    const n = mul(perp(d), el.offsetDist);
    if (distPointToSegment(pt, add(a, n), add(b, n)) <= tolMm * 1.5) return el;
  }
  for (const el of list('furniture').slice().reverse()) {
    if (el.type === 'furniture' && polyHit(pt, furnitureCorners(el), tolMm)) return el;
  }
  for (const el of list('stair').slice().reverse()) {
    if (el.type === 'stair' && polyHit(pt, stairCorners(el), tolMm)) return el;
  }
  for (const el of list('beam').slice().reverse()) {
    if (el.type === 'beam' && polyHit(pt, beamCorners(el), tolMm)) return el;
  }
  for (const el of list('column').slice().reverse()) {
    if (el.type === 'column' && polyHit(pt, columnCorners(el), tolMm)) return el;
  }
  for (const t of ['door', 'window'] as const) {
    for (const el of list(t).slice().reverse()) {
      if (el.type !== 'door' && el.type !== 'window') continue;
      const host = model.get(el.hostWallId);
      if (host?.type === 'wall' && polyHit(pt, openingPolygon(host, el), tolMm)) {
        return el;
      }
    }
  }
  for (const el of list('wall').slice().reverse()) {
    if (el.type === 'wall' && polyHit(pt, wallOutline(el), tolMm)) return el;
  }
  for (const el of list('refline').slice().reverse()) {
    if (el.type === 'refline' && polylineHit(pt, el.points, el.closed, tolMm * 1.5)) {
      return el;
    }
  }
  for (const el of list('room').slice().reverse()) {
    if (el.type === 'room' && el.boundary.length >= 3 && pointInPolygon(pt, el.boundary)) {
      return el;
    }
  }
  for (const el of list('slab').slice().reverse()) {
    if (el.type === 'slab' && el.outline.length >= 3 && pointInPolygon(pt, el.outline)) {
      return el;
    }
  }
  return null;
}

/**
 * Marquee selection. mode 'contain' keeps only elements fully inside the
 * rect (drag left→right), 'intersect' keeps anything overlapping it.
 */
export function elementsInRect(
  model: BIMModel,
  levelId: string,
  min: Vec2,
  max: Vec2,
  mode: 'contain' | 'intersect',
): string[] {
  const out: string[] = [];
  for (const el of model.onLevel(levelId)) {
    const b = elementBounds(el, model);
    if (!b) continue;
    const hit =
      mode === 'contain'
        ? b.min.x >= min.x && b.max.x <= max.x && b.min.y >= min.y && b.max.y <= max.y
        : b.max.x >= min.x && b.min.x <= max.x && b.max.y >= min.y && b.min.y <= max.y;
    if (hit) out.push(el.id);
  }
  return out;
}

/** union bounds of all elements on a level (for zoom-to-fit) */
export function levelBounds(
  model: BIMModel,
  levelId: string,
  eff?: EffFn,
): { min: Vec2; max: Vec2 } | null {
  let min: Vec2 | null = null;
  let max: Vec2 | null = null;
  for (const el of model.onLevel(levelId)) {
    const b = elementBounds(el, model, eff);
    if (!b) continue;
    if (!min || !max) {
      min = { ...b.min };
      max = { ...b.max };
    } else {
      min.x = Math.min(min.x, b.min.x);
      min.y = Math.min(min.y, b.min.y);
      max.x = Math.max(max.x, b.max.x);
      max.y = Math.max(max.y, b.max.y);
    }
  }
  return min && max ? { min, max } : null;
}
