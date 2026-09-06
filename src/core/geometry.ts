// 2D geometry helpers shared by the editor, viewer, exporters and analysis.
import type { Vec2, WallElement } from './types';

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec2): Vec2 => {
  const l = len(a);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};
/** left-hand perpendicular */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const lerpPt = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);
export const rot = (p: Vec2, ang: number): Vec2 => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
};
export const rotAround = (p: Vec2, center: Vec2, ang: number): Vec2 =>
  add(center, rot(sub(p, center), ang));

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));
export const snapTo = (value: number, step: number): number =>
  Math.round(value / step) * step;
export const almostEqual = (a: number, b: number, tol = 1e-6): boolean =>
  Math.abs(a - b) <= tol;
export const ptsEqual = (a: Vec2, b: Vec2, tol = 1): boolean =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

export function closestPointOnSegment(
  p: Vec2,
  a: Vec2,
  b: Vec2,
): { point: Vec2; t: number; dist: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < 1e-9 ? 0 : clamp(dot(sub(p, a), ab) / l2, 0, 1);
  const point = add(a, mul(ab, t));
  return { point, t, dist: dist(p, point) };
}

export const distPointToSegment = (p: Vec2, a: Vec2, b: Vec2): number =>
  closestPointOnSegment(p, a, b).dist;

/** intersection of segments ab and cd, or null */
export function segmentIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const rxs = cross(r, s);
  if (Math.abs(rxs) < 1e-9) return null;
  const t = cross(sub(c, a), s) / rxs;
  const u = cross(sub(c, a), r) / rxs;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return add(a, mul(r, t));
}

/** signed polygon area (positive = counter-clockwise), mm^2 */
export function polygonArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export const polygonAreaAbs = (poly: Vec2[]): number => Math.abs(polygonArea(poly));

export function polygonCentroid(poly: Vec2[]): Vec2 {
  const a = polygonArea(poly);
  if (Math.abs(a) < 1e-6) {
    let x = 0, y = 0;
    for (const p of poly) { x += p.x; y += p.y; }
    return { x: x / poly.length, y: y / poly.length };
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i], pj = poly[j];
    if (
      pi.y > p.y !== pj.y > p.y &&
      p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function polygonBounds(poly: Vec2[]): { min: Vec2; max: Vec2 } {
  const min = { x: Infinity, y: Infinity };
  const max = { x: -Infinity, y: -Infinity };
  for (const p of poly) {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
  }
  return { min, max };
}

// ------------------------------------------------------------
// Wall helpers
// ------------------------------------------------------------

export const wallDir = (w: WallElement): Vec2 => norm(sub(w.end, w.start));
export const wallLength = (w: WallElement): number => dist(w.start, w.end);
export const wallAngle = (w: WallElement): number => angleOf(sub(w.end, w.start));

/** point on the wall centreline, offsetMm from the start */
export function pointAlongWall(w: WallElement, offsetMm: number): Vec2 {
  const d = wallDir(w);
  return add(w.start, mul(d, offsetMm));
}

/** the 4 corners of the wall rectangle in plan (start-left, end-left, end-right, start-right) */
export function wallOutline(w: WallElement): [Vec2, Vec2, Vec2, Vec2] {
  const d = wallDir(w);
  const n = mul(perp(d), w.thickness / 2);
  return [
    add(w.start, n),
    add(w.end, n),
    sub(w.end, n),
    sub(w.start, n),
  ];
}

/** plan-space endpoints of an opening (door/window) centred at `offset` with `width` */
export function openingEnds(
  w: WallElement,
  opening: { offset: number; width: number },
): { a: Vec2; b: Vec2 } {
  const d = wallDir(w);
  return {
    a: add(w.start, mul(d, opening.offset - opening.width / 2)),
    b: add(w.start, mul(d, opening.offset + opening.width / 2)),
  };
}
