// Model-editing helpers for the 2D editor: move/nudge patch builders,
// wall-geometry commands that keep rooms + hosted openings in sync,
// and selection duplication. All return data/commands — the controller
// commits them through runCommand so undo/redo stays clean.
import type { AnyElement, DimensionElement, RoomElement, Vec2, WallElement } from '../core/types';
import { newId } from '../core/types';
import { BIMModel } from '../core/model';
import { cmdUpdateMany, type Command } from '../core/commands';
import {
  add,
  clamp,
  dist,
  dot,
  polygonCentroid,
  wallDir,
  wallLength,
} from '../core/geometry';
import { detectRoomBoundary } from '../analysis/rooms';

/**
 * Patch that moves one element by delta. Doors/windows slide along their
 * host wall (offset only, clamped); they return null when the host itself
 * is moving (they follow it for free).
 */
export function movePatchFor(
  el: AnyElement,
  delta: Vec2,
  movingIds: ReadonlySet<string>,
  model: BIMModel,
): Record<string, unknown> | null {
  switch (el.type) {
    case 'wall':
      return { start: add(el.start, delta), end: add(el.end, delta) };
    case 'door':
    case 'window': {
      if (movingIds.has(el.hostWallId)) return null;
      const host = model.get(el.hostWallId);
      if (!host || host.type !== 'wall') return null;
      const L = wallLength(host);
      const slide = dot(delta, wallDir(host));
      const off = clamp(el.offset + slide, el.width / 2, Math.max(el.width / 2, L - el.width / 2));
      return Math.abs(off - el.offset) < 1e-6 ? null : { offset: off };
    }
    case 'column':
    case 'furniture':
    case 'text':
    case 'stair':
      return { position: add(el.position, delta) };
    case 'beam':
      return { start: add(el.start, delta), end: add(el.end, delta) };
    case 'dimension':
      return { start: add(el.start, delta), end: add(el.end, delta) };
    case 'slab':
      return { outline: el.outline.map((p) => add(p, delta)) };
    case 'room':
      return { boundary: el.boundary.map((p) => add(p, delta)) };
    case 'refline':
      return { points: el.points.map((p) => add(p, delta)) };
    default:
      return null;
  }
}

function polysEqual(a: Vec2[], b: Vec2[], tol = 0.5): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].x - b[i].x) > tol || Math.abs(a[i].y - b[i].y) > tol) return false;
  }
  return true;
}

/** clamp patches for openings hosted on a wall whose new length is `newLen` */
export function openingClampEntries(
  model: BIMModel,
  wallId: string,
  newLen: number,
): { id: string; patch: Record<string, unknown> }[] {
  const out: { id: string; patch: Record<string, unknown> }[] = [];
  for (const o of model.hosted(wallId)) {
    const lo = o.width / 2;
    const hi = Math.max(lo, newLen - o.width / 2);
    const off = clamp(o.offset, lo, hi);
    if (Math.abs(off - o.offset) > 1e-6) out.push({ id: o.id, patch: { offset: off } });
  }
  return out;
}

/**
 * Which end of `dim` an anchor holds.
 *
 * `DimensionElement.anchors` records `{elementId, end}` — the WALL's end — but
 * not which end of the dimension it is attached to, and the list is built by
 * pushing whichever ends actually snapped, so `[b]` and `[a]` are the same
 * shape. Position cannot answer it. Geometry can: at the moment the anchor was
 * taken, the dimension's endpoint WAS the wall's endpoint, and every move since
 * has kept them together. So the answer is whichever end still sits on the
 * wall's current endpoint — and when neither does the anchor is stale, which is
 * exactly when it should be left alone rather than snapped back.
 */
function anchoredEnd(
  dim: DimensionElement,
  at: Vec2,
  tol = 1,
): 'start' | 'end' | null {
  const ds = dist(dim.start, at);
  const de = dist(dim.end, at);
  if (ds <= tol && ds <= de) return 'start';
  if (de <= tol) return 'end';
  return null;
}

/**
 * Dimension patches that keep anchored dimensions glued to moved walls (§8.7).
 *
 * `before` is the model as it stands, `after` a clone with the entries applied:
 * the anchor is identified against the OLD wall endpoint and re-pointed at the
 * NEW one. A dimension already being patched by the caller is skipped — it is
 * moving under its own gesture and re-anchoring it would fight that.
 */
export function dimensionFollowEntries(
  before: BIMModel,
  after: BIMModel,
  levelId: string,
  movedWallIds: ReadonlySet<string>,
  alreadyPatched: ReadonlySet<string>,
): { id: string; patch: Record<string, unknown> }[] {
  const out: { id: string; patch: Record<string, unknown> }[] = [];
  for (const dim of before.byType<DimensionElement>('dimension')) {
    if (dim.levelId !== levelId || alreadyPatched.has(dim.id) || !dim.anchors?.length) continue;
    const patch: Record<string, unknown> = {};
    for (const anc of dim.anchors) {
      if (!movedWallIds.has(anc.elementId)) continue;
      const was = before.get(anc.elementId);
      const now = after.get(anc.elementId);
      if (was?.type !== 'wall' || now?.type !== 'wall') continue;
      const which = anchoredEnd(dim, was[anc.end]);
      if (!which || which in patch) continue;
      const to = now[anc.end];
      if (dist(dim[which], to) > 1e-6) patch[which] = { x: to.x, y: to.y };
    }
    if (Object.keys(patch).length) out.push({ id: dim.id, patch });
  }
  return out;
}

/**
 * Wrap element patches in a single command. When any patched element is a
 * wall, re-detect every room boundary on the level against the post-change
 * geometry (via a throwaway model clone) and re-point every dimension anchored
 * to a moved wall, folding both into the same composite — rooms and bound
 * dimensions follow their walls under ONE undo step.
 */
export function buildGeometryCommand(
  model: BIMModel,
  levelId: string,
  entries: { id: string; patch: Record<string, unknown> }[],
  name: string,
): Command {
  const walls = new Set(entries.filter((e) => model.get(e.id)?.type === 'wall').map((e) => e.id));
  if (walls.size === 0) return cmdUpdateMany(entries, name);

  const rooms = model
    .byType<RoomElement>('room')
    .filter((r) => r.levelId === levelId && r.boundary.length >= 3);
  const anchored = model
    .byType<DimensionElement>('dimension')
    .some((d) => d.levelId === levelId && d.anchors?.some((a) => walls.has(a.elementId)));
  if (rooms.length === 0 && !anchored) return cmdUpdateMany(entries, name);

  const clone = BIMModel.fromJSON(model.toJSON());
  for (const e of entries) clone.update(e.id, e.patch);

  const extra: { id: string; patch: Record<string, unknown> }[] = [];
  for (const room of rooms) {
    const centroid = polygonCentroid(room.boundary);
    const nb = detectRoomBoundary(clone, levelId, centroid);
    if (nb && nb.length >= 3 && !polysEqual(nb, room.boundary)) {
      extra.push({ id: room.id, patch: { boundary: nb } });
    }
  }
  if (anchored) {
    extra.push(
      ...dimensionFollowEntries(model, clone, levelId, walls, new Set(entries.map((e) => e.id))),
    );
  }
  return cmdUpdateMany([...entries, ...extra], name);
}

/**
 * Clones of the selected elements, offset by delta, with fresh ids.
 * Doors/windows are kept only when their host wall is also duplicated
 * (rehosted onto the new wall); otherwise they are skipped. Dimension
 * anchors pointing outside the copied set are dropped.
 */
export function duplicateElements(
  model: BIMModel,
  ids: string[],
  delta: Vec2,
): AnyElement[] {
  const idSet = new Set(ids);
  const els = ids
    .map((id) => model.get(id))
    .filter((el): el is AnyElement => !!el);
  const idMap = new Map<string, string>();
  for (const el of els) {
    if ((el.type === 'door' || el.type === 'window') && !idSet.has(el.hostWallId)) {
      continue; // host not copied — skip the opening
    }
    idMap.set(el.id, newId(el.type));
  }
  const out: AnyElement[] = [];
  for (const el of els) {
    const nid = idMap.get(el.id);
    if (!nid) continue;
    const c = structuredClone(el);
    c.id = nid;
    switch (c.type) {
      case 'wall':
      case 'beam':
        c.start = add(c.start, delta);
        c.end = add(c.end, delta);
        break;
      case 'door':
      case 'window':
        c.hostWallId = idMap.get(c.hostWallId) ?? c.hostWallId;
        break;
      case 'column':
      case 'furniture':
      case 'text':
      case 'stair':
        c.position = add(c.position, delta);
        break;
      case 'slab':
        c.outline = c.outline.map((p) => add(p, delta));
        break;
      case 'room':
        c.boundary = c.boundary.map((p) => add(p, delta));
        break;
      case 'refline':
        c.points = c.points.map((p) => add(p, delta));
        break;
      case 'dimension': {
        c.start = add(c.start, delta);
        c.end = add(c.end, delta);
        if (c.anchors) {
          const kept = c.anchors
            .filter((anc) => idMap.has(anc.elementId))
            .map((anc) => ({ ...anc, elementId: idMap.get(anc.elementId)! }));
          c.anchors = kept.length ? kept : undefined;
        }
        break;
      }
    }
    out.push(c);
  }
  return out;
}

/** significant translation? (avoid committing no-op moves) */
export const meaningfulDelta = (d: Vec2): boolean => dist(d, { x: 0, y: 0 }) > 0.01;

/** wall geometry entries + hosted opening clamps for a start/end change */
export function wallEndpointEntries(
  model: BIMModel,
  wall: WallElement,
  which: 'start' | 'end',
  pt: Vec2,
): { id: string; patch: Record<string, unknown> }[] {
  const newStart = which === 'start' ? pt : wall.start;
  const newEnd = which === 'end' ? pt : wall.end;
  const entries: { id: string; patch: Record<string, unknown> }[] = [
    { id: wall.id, patch: which === 'start' ? { start: pt } : { end: pt } },
  ];
  entries.push(...openingClampEntries(model, wall.id, dist(newStart, newEnd)));
  return entries;
}
