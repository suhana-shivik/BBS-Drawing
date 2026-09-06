// Geometry builders for the general-purpose CAD drafting primitives
// (line/polyline/rectangle/circle/arc). All of them are committed as
// RefLineElement — a closed/open polyline on a named layer — so selection,
// hit-testing, move, duplicate and snapping all fall out of the existing
// refline handling elsewhere in the editor for free.
import type { Vec2 } from '../core/types';
import { angleOf, dist, sub } from '../core/geometry';

export const rectOutline = (a: Vec2, b: Vec2): Vec2[] => [
  { x: a.x, y: a.y },
  { x: b.x, y: a.y },
  { x: b.x, y: b.y },
  { x: a.x, y: b.y },
];

/** adjust `pt` so that a→pt forms a square, preserving each axis' sign */
export function squareCorner(a: Vec2, pt: Vec2): Vec2 {
  const dx = pt.x - a.x;
  const dy = pt.y - a.y;
  const side = Math.min(Math.abs(dx), Math.abs(dy));
  return {
    x: a.x + Math.sign(dx || 1) * side,
    y: a.y + Math.sign(dy || 1) * side,
  };
}

export function circlePoints(center: Vec2, radius: number, segments = 48): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    pts.push({ x: center.x + radius * Math.cos(t), y: center.y + radius * Math.sin(t) });
  }
  return pts;
}

function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-6) return null; // collinear
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x: ux, y: uy };
}

const TAU = Math.PI * 2;
const norm2pi = (a: number): number => {
  let v = a % TAU;
  if (v < 0) v += TAU;
  return v;
};

/**
 * Tessellates the circular arc through three points: `start`, `end`, and
 * `onArc` (a point that lies on the arc — this picks which of the two
 * possible sweeps between start/end is used). Returns null when the three
 * points are (near-)collinear, i.e. no finite circle passes through them.
 */
export function arcThroughPoints(
  start: Vec2,
  end: Vec2,
  onArc: Vec2,
  segments = 32,
): Vec2[] | null {
  const center = circumcenter(start, end, onArc);
  if (!center) return null;
  const r = dist(center, start);
  if (r < 1e-6) return null;
  const a0 = norm2pi(angleOf(sub(start, center)));
  const a1 = norm2pi(angleOf(sub(end, center)));
  const am = norm2pi(angleOf(sub(onArc, center)));
  const ccw = norm2pi(a1 - a0);
  const amRel = norm2pi(am - a0);
  const sweep = amRel <= ccw ? ccw : ccw - TAU;
  if (Math.abs(sweep) < 1e-6) return null;
  const pts: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = a0 + (sweep * i) / segments;
    pts.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  return pts;
}
