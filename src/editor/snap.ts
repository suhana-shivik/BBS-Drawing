// Snapping engine. Priority: endpoint > midpoint > intersection/on-line > grid.
// All candidates must be within a screen-space radius (~12px) of the cursor.
import type { Vec2, WallElement } from '../core/types';
import type { BIMModel } from '../core/model';
import {
  closestPointOnSegment,
  dist,
  lerpPt,
  segmentIntersect,
  snapTo,
} from '../core/geometry';

export type SnapKind = 'endpoint' | 'midpoint' | 'intersection' | 'online' | 'grid';

export interface SnapResult {
  point: Vec2;
  kind: SnapKind;
  /** element the snap belongs to (endpoint/midpoint/online) */
  refId?: string;
  /** set when the snap is a wall's start or end point (dimension anchors) */
  end?: 'start' | 'end';
}

const RANK: Record<SnapKind, number> = {
  endpoint: 0,
  midpoint: 1,
  intersection: 2,
  online: 2,
  grid: 3,
};

export interface SnapQuery {
  /** px per mm — converts the pixel radius into model space */
  scale: number;
  radiusPx?: number;
  /** ids whose geometry should not attract snaps (e.g. elements being dragged) */
  exclude?: ReadonlySet<string>;
}

export function computeSnap(
  model: BIMModel,
  levelId: string,
  pt: Vec2,
  q: SnapQuery,
): SnapResult | null {
  const settings = model.settings;
  const radius = (q.radiusPx ?? 12) / Math.max(q.scale, 1e-9);
  const exclude = q.exclude;
  let best: SnapResult | null = null;
  let bestRank = Infinity;
  let bestDist = Infinity;

  const consider = (cand: SnapResult) => {
    const d = dist(cand.point, pt);
    if (d > radius) return;
    const r = RANK[cand.kind];
    if (r < bestRank || (r === bestRank && d < bestDist)) {
      best = cand;
      bestRank = r;
      bestDist = d;
    }
  };

  if (settings.snapObjects) {
    const walls: WallElement[] = [];
    const nearWalls: WallElement[] = [];
    for (const el of model.onLevel(levelId)) {
      if (exclude?.has(el.id)) continue;
      if (el.type === 'wall') {
        walls.push(el);
        // endpoints
        consider({ point: el.start, kind: 'endpoint', refId: el.id, end: 'start' });
        consider({ point: el.end, kind: 'endpoint', refId: el.id, end: 'end' });
        // midpoint
        consider({ point: lerpPt(el.start, el.end, 0.5), kind: 'midpoint', refId: el.id });
        // projection onto centreline
        const cp = closestPointOnSegment(pt, el.start, el.end);
        if (cp.dist <= radius) {
          nearWalls.push(el);
          consider({ point: cp.point, kind: 'online', refId: el.id });
        }
      } else if (el.type === 'refline') {
        for (const p of el.points) {
          consider({ point: p, kind: 'endpoint', refId: el.id });
        }
      }
    }
    // wall centreline intersections (only among walls passing near the cursor)
    for (let i = 0; i < nearWalls.length; i++) {
      for (let j = i + 1; j < nearWalls.length; j++) {
        const a = nearWalls[i];
        const b = nearWalls[j];
        const x = segmentIntersect(a.start, a.end, b.start, b.end);
        if (x) consider({ point: x, kind: 'intersection', refId: a.id });
      }
    }
  }

  if (settings.snapGrid) {
    const g = settings.gridSpacing > 0 ? settings.gridSpacing : 500;
    consider({
      point: { x: snapTo(pt.x, g), y: snapTo(pt.y, g) },
      kind: 'grid',
    });
  }

  return best;
}
