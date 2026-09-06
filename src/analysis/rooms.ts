// Room boundary detection: given a point inside a region enclosed by walls,
// return the boundary polygon of that region (following wall inner faces),
// or null when the point is not enclosed.
//
// Approach: adaptive raster flood fill.
//  1. Walls on the level are rasterized into a grid (≤ ~500×500 cells,
//     cell ≥ 20mm). A cell is a "wall cell" when its centre lies inside a
//     wall outline OR within a stroke of max(thickness, 2 cells) around the
//     wall centreline — the stroke guarantees thin walls still block the
//     fill with no diagonal leaks.
//  2. 4-connected BFS from the clicked cell. Reaching the grid border means
//     the point is not enclosed → null (the grid is padded, so the border
//     ring is always outside the building).
//  3. The filled region's outer contour is traced from its boundary edges
//     (interior kept on the left → CCW), then simplified: collinear
//     collapse, Douglas–Peucker at 1.5×cell, and orthogonal snapping of
//     segments within 5° of horizontal/vertical.
import type { BIMModel } from '../core/model';
import type { Vec2, WallElement } from '../core/types';
import {
  distPointToSegment,
  pointInPolygon,
  polygonArea,
  wallOutline,
} from '../core/geometry';

const MAX_GRID = 500; // target max cells per axis
const MIN_CELL = 20; // mm
const MAX_VISITED = 400_000; // BFS safety cap
const TAN5 = Math.tan((5 * Math.PI) / 180);

export function detectRoomBoundary(
  model: BIMModel,
  levelId: string,
  point: Vec2,
): Vec2[] | null {
  const walls = model
    .byType<WallElement>('wall')
    .filter((w) => w.levelId === levelId);
  if (walls.length === 0) return null;

  // ---- bounds over wall outlines ----
  const outlines = walls.map((w) => wallOutline(w));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const o of outlines) {
    for (const p of o) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  if (!Number.isFinite(extent) || extent <= 0) return null;

  const cell = Math.max(MIN_CELL, extent / MAX_GRID);
  // two cells of padding: guarantees a free ring around all geometry even
  // when the centreline stroke bleeds one cell past the wall outlines.
  minX -= 2 * cell;
  minY -= 2 * cell;
  maxX += 2 * cell;
  maxY += 2 * cell;
  const nx = Math.max(3, Math.ceil((maxX - minX) / cell));
  const ny = Math.max(3, Math.ceil((maxY - minY) / cell));

  // ---- rasterize walls ----
  const wallGrid = new Uint8Array(nx * ny);
  for (let k = 0; k < walls.length; k++) {
    const w = walls[k];
    const o = outlines[k];
    const strokeR = Math.max(w.thickness, 2 * cell) / 2;
    let wx0 = Infinity;
    let wy0 = Infinity;
    let wx1 = -Infinity;
    let wy1 = -Infinity;
    for (const p of o) {
      if (p.x < wx0) wx0 = p.x;
      if (p.y < wy0) wy0 = p.y;
      if (p.x > wx1) wx1 = p.x;
      if (p.y > wy1) wy1 = p.y;
    }
    const i0 = Math.max(0, Math.floor((wx0 - strokeR - minX) / cell));
    const j0 = Math.max(0, Math.floor((wy0 - strokeR - minY) / cell));
    const i1 = Math.min(nx - 1, Math.ceil((wx1 + strokeR - minX) / cell));
    const j1 = Math.min(ny - 1, Math.ceil((wy1 + strokeR - minY) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * nx + i;
        if (wallGrid[idx]) continue;
        const c = { x: minX + (i + 0.5) * cell, y: minY + (j + 0.5) * cell };
        if (
          pointInPolygon(c, o) ||
          distPointToSegment(c, w.start, w.end) <= strokeR
        ) {
          wallGrid[idx] = 1;
        }
      }
    }
  }

  // ---- BFS flood fill from the clicked cell ----
  const ci = Math.floor((point.x - minX) / cell);
  const cj = Math.floor((point.y - minY) / cell);
  if (ci < 0 || cj < 0 || ci >= nx || cj >= ny) return null;
  const startIdx = cj * nx + ci;
  if (wallGrid[startIdx]) return null;

  const region = new Uint8Array(nx * ny);
  const queue = new Int32Array(nx * ny);
  let qh = 0;
  let qt = 0;
  region[startIdx] = 1;
  queue[qt++] = startIdx;
  let visited = 0;
  while (qh < qt) {
    const idx = queue[qh++];
    visited += 1;
    if (visited > MAX_VISITED) return null;
    const i = idx % nx;
    const j = (idx - i) / nx;
    // escaped to the padded border → the point is not enclosed
    if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) return null;
    const west = idx - 1;
    const east = idx + 1;
    const south = idx - nx;
    const north = idx + nx;
    if (!region[west] && !wallGrid[west]) {
      region[west] = 1;
      queue[qt++] = west;
    }
    if (!region[east] && !wallGrid[east]) {
      region[east] = 1;
      queue[qt++] = east;
    }
    if (!region[south] && !wallGrid[south]) {
      region[south] = 1;
      queue[qt++] = south;
    }
    if (!region[north] && !wallGrid[north]) {
      region[north] = 1;
      queue[qt++] = north;
    }
  }

  // ---- trace the outer contour of the filled region ----
  // Directed boundary edges between cell corners, region interior on the
  // left, so the outer loop comes out counter-clockwise.
  const vw = nx + 1; // vertices per row
  const edges = new Map<number, number[]>();
  const addEdge = (a: number, b: number): void => {
    const list = edges.get(a);
    if (list) list.push(b);
    else edges.set(a, [b]);
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!region[j * nx + i]) continue;
      const v00 = j * vw + i;
      const v10 = v00 + 1;
      const v01 = v00 + vw;
      const v11 = v01 + 1;
      if (j === 0 || !region[(j - 1) * nx + i]) addEdge(v00, v10); // bottom
      if (i === nx - 1 || !region[j * nx + i + 1]) addEdge(v10, v11); // right
      if (j === ny - 1 || !region[(j + 1) * nx + i]) addEdge(v11, v01); // top
      if (i === 0 || !region[j * nx + i - 1]) addEdge(v01, v00); // left
    }
  }

  const dirOf = (a: number, b: number): Vec2 => {
    const ax = a % vw;
    const bx = b % vw;
    return { x: bx - ax, y: (b - bx) / vw - (a - ax) / vw };
  };

  const loops: number[][] = [];
  while (edges.size > 0) {
    const start = edges.keys().next().value as number;
    const loop: number[] = [start];
    let prev = -1;
    let cur = start;
    for (;;) {
      const outs = edges.get(cur);
      if (!outs || outs.length === 0) {
        edges.delete(cur);
        break; // dead end — degenerate, discard partial chain below
      }
      let pick = 0;
      if (outs.length > 1 && prev >= 0) {
        // pinch vertex: prefer the sharpest left turn to keep loops simple
        const di = dirOf(prev, cur);
        let best = -Infinity;
        for (let k = 0; k < outs.length; k++) {
          const dk = dirOf(cur, outs[k]);
          const crossV = di.x * dk.y - di.y * dk.x;
          const dotV = di.x * dk.x + di.y * dk.y;
          const score = crossV > 0 ? 2 : crossV === 0 ? (dotV > 0 ? 1 : -2) : 0;
          if (score > best) {
            best = score;
            pick = k;
          }
        }
      }
      const next = outs[pick];
      outs.splice(pick, 1);
      if (outs.length === 0) edges.delete(cur);
      if (next === start) break; // closed the loop
      loop.push(next);
      prev = cur;
      cur = next;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  if (loops.length === 0) return null;

  // outer contour = loop with the largest absolute area (holes are smaller)
  const loopArea = (loop: number[]): number => {
    let s = 0;
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k];
      const b = loop[(k + 1) % loop.length];
      const ax = a % vw;
      const ay = (a - ax) / vw;
      const bx = b % vw;
      const by = (b - bx) / vw;
      s += ax * by - bx * ay;
    }
    return s / 2;
  };
  let outer: number[] | null = null;
  let outerArea = 0;
  for (const lp of loops) {
    const a = Math.abs(loopArea(lp));
    if (a > outerArea) {
      outerArea = a;
      outer = lp;
    }
  }
  if (!outer || outerArea < 1) return null;

  // ---- convert to mm and simplify ----
  let pts: Vec2[] = outer.map((k) => {
    const i = k % vw;
    return { x: minX + i * cell, y: minY + ((k - i) / vw) * cell };
  });
  pts = collapseCollinear(pts, cell);
  pts = simplifyClosed(pts, cell * 1.5);
  pts = snapOrthogonal(pts);
  pts = collapseCollinear(pts, cell);
  if (pts.length < 3) return null;
  if (polygonArea(pts) < 0) pts.reverse();
  return pts;
}

// ------------------------------------------------------------
// polygon simplification helpers (module-private)
// ------------------------------------------------------------

/** drop consecutive duplicates, then vertices whose triangle area ≈ 0 */
function collapseCollinear(poly: Vec2[], cell: number): Vec2[] {
  const tol = cell * 1e-6; // duplicate-point tolerance, mm
  const pts: Vec2[] = [];
  for (const p of poly) {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last.x - p.x) > tol || Math.abs(last.y - p.y) > tol) {
      pts.push(p);
    }
  }
  while (
    pts.length > 1 &&
    Math.abs(pts[0].x - pts[pts.length - 1].x) <= tol &&
    Math.abs(pts[0].y - pts[pts.length - 1].y) <= tol
  ) {
    pts.pop();
  }
  if (pts.length < 3) return pts;
  const crossTol = cell * cell * 1e-6; // mm² — float noise only
  const n = pts.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) > crossTol) out.push(b);
  }
  return out;
}

/** Douglas–Peucker on a closed polygon, anchored at two extreme vertices */
function simplifyClosed(poly: Vec2[], tol: number): Vec2[] {
  const n = poly.length;
  if (n <= 4) return poly;
  let ia = 0;
  let ib = 0;
  for (let i = 1; i < n; i++) {
    if (poly[i].x + poly[i].y < poly[ia].x + poly[ia].y) ia = i;
    if (poly[i].x + poly[i].y > poly[ib].x + poly[ib].y) ib = i;
  }
  if (ia === ib) return poly;
  const chainA: Vec2[] = [];
  for (let i = ia; ; i = (i + 1) % n) {
    chainA.push(poly[i]);
    if (i === ib) break;
  }
  const chainB: Vec2[] = [];
  for (let i = ib; ; i = (i + 1) % n) {
    chainB.push(poly[i]);
    if (i === ia) break;
  }
  const sa = dpChain(chainA, tol);
  const sb = dpChain(chainB, tol);
  return [...sa.slice(0, -1), ...sb.slice(0, -1)];
}

function dpChain(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop() as [number, number];
    let maxD = 0;
    let maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distPointToSegment(pts[i], pts[s], pts[e]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxI >= 0 && maxD > tol) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/** snap segments within 5° of horizontal/vertical to exactly axis-aligned */
function snapOrthogonal(poly: Vec2[]): Vec2[] {
  const pts = poly.map((p) => ({ x: p.x, y: p.y }));
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    if (dy <= dx * TAN5) {
      const y = (a.y + b.y) / 2;
      a.y = y;
      b.y = y;
    } else if (dx <= dy * TAN5) {
      const x = (a.x + b.x) / 2;
      a.x = x;
      b.x = x;
    }
  }
  return pts;
}
