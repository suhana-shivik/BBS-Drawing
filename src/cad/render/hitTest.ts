// ============================================================
// Picking against a resolved display list.
//
// The painter walks the list forwards, so later ops sit on top; picking
// therefore walks it backwards and returns the first op it lands on. That
// keeps "what you clicked" identical to "what you see" even where a solid
// hatch or a wipeout covers older geometry.
//
// Everything here is model space (mm). `tolerance` is the pick aperture,
// which callers normally derive from the view — e.g. 6 / view.scale.
// ============================================================
import type { Vec2 } from '../../core/types';
import type { DisplayList, DisplayPath, DisplayText } from '../types';
import { listBounds, textLocalBox } from './bounds';

export interface HitTestOptions {
  /** layers to ignore, matching what the painter was told to hide */
  hiddenLayers?: ReadonlySet<string> | null;
  /** restrict the pick, e.g. to strokes only */
  filter?: (op: DisplayList['ops'][number]) => boolean;
}

/** squared distance from p to segment ab, allocation free */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = 0;
  if (l2 > 1e-18) {
    t = ((px - ax) * dx + (py - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const cx = ax + dx * t - px;
  const cy = ay + dy * t - py;
  return cx * cx + cy * cy;
}

/** any edge of the path within tolerance (closing edge included when closed) */
function nearEdge(op: DisplayPath, p: Vec2, tol2: number): boolean {
  const subs = op.subpaths;
  for (let s = 0; s < subs.length; s++) {
    const pts = subs[s];
    const n = pts.length;
    if (n === 0) continue;
    if (n === 1) {
      const dx = pts[0].x - p.x;
      const dy = pts[0].y - p.y;
      if (dx * dx + dy * dy <= tol2) return true;
      continue;
    }
    for (let i = 1; i < n; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (segDist2(p.x, p.y, a.x, a.y, b.x, b.y) <= tol2) return true;
    }
    if (op.closed) {
      const a = pts[n - 1];
      const b = pts[0];
      if (segDist2(p.x, p.y, a.x, a.y, b.x, b.y) <= tol2) return true;
    }
  }
  return false;
}

/**
 * Even-odd containment across every subpath at once — the same rule the
 * painter fills with, so islands punched out of a hatch are not pickable.
 */
function insideEvenOdd(op: DisplayPath, p: Vec2): boolean {
  let inside = false;
  const subs = op.subpaths;
  for (let s = 0; s < subs.length; s++) {
    const pts = subs[s];
    const n = pts.length;
    if (n < 3) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if (a.y > p.y !== b.y > p.y) {
        const x = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
        if (p.x < x) inside = !inside;
      }
    }
  }
  return inside;
}

function hitPath(op: DisplayPath, p: Vec2, tol: number): boolean {
  // the outline always picks — including on a fill-only op, so a click just
  // off the edge of a thin sliver still registers
  if (nearEdge(op, p, tol * tol)) return true;
  // a filled region also picks anywhere inside it; an unfilled closed path
  // does not, exactly as in AutoCAD
  return op.fill !== null && insideEvenOdd(op, p);
}

/** inside the approximate glyph box, tolerance included */
function hitText(t: DisplayText, p: Vec2, tol: number): boolean {
  const b = textLocalBox(t);
  // into the glyph frame: undo the anchor translation, then the rotation
  const dx = p.x - t.position.x;
  const dy = p.y - t.position.y;
  const c = Math.cos(-t.rotation);
  const s = Math.sin(-t.rotation);
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return (
    lx >= b.minX - tol && lx <= b.maxX + tol && ly >= b.minY - tol && ly <= b.maxY + tol
  );
}

/** topmost-first walk; `out` null = stop at the first hit */
function walk(
  list: DisplayList,
  p: Vec2,
  tolerance: number,
  opts: HitTestOptions | undefined,
  out: string[] | null,
): string | null {
  const ops = list.ops;
  const bounds = listBounds(list);
  const hidden = opts?.hiddenLayers ?? null;
  const filter = opts?.filter;
  const tol = tolerance > 0 ? tolerance : 0;

  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.alpha <= 0) continue;
    if (hidden !== null && hidden.has(op.layer)) continue;
    const bi = i * 4;
    if (
      p.x < bounds[bi] - tol ||
      p.x > bounds[bi + 2] + tol ||
      p.y < bounds[bi + 1] - tol ||
      p.y > bounds[bi + 3] + tol
    ) {
      continue;
    }
    if (filter && !filter(op)) continue;
    let hit: boolean;
    if (op.kind === 'text') hit = hitText(op, p, tol);
    else if (op.stroke === null && op.fill === null) hit = false;
    else hit = hitPath(op, p, tol);
    if (!hit) continue;
    if (out === null) return op.handle;
    out.push(op.handle);
  }
  return null;
}

/**
 * Handle of the topmost op within `tolerance` of `modelPoint`, or null.
 */
export function hitTestDisplayList(
  list: DisplayList,
  modelPoint: Vec2,
  tolerance: number,
  opts?: HitTestOptions,
): string | null {
  return walk(list, modelPoint, tolerance, opts, null);
}

/**
 * Every handle within tolerance, topmost first. Useful for cycling through
 * stacked geometry (repeated clicks in the same spot) and for takeoff, which
 * wants the whole stack rather than only the winner.
 */
export function hitTestAll(
  list: DisplayList,
  modelPoint: Vec2,
  tolerance: number,
  opts?: HitTestOptions,
): string[] {
  const out: string[] = [];
  walk(list, modelPoint, tolerance, opts, out);
  return out;
}
