// Uniform scale / rotate / mirror for a selection of plan elements.
//
// A transform is described by an `Xform`: a point map plus the three scalar
// consequences a plan element can have —
//   * `lengthFactor`  every length-valued field (thickness, width, text size…)
//   * `angleDelta`    added to element rotations (rotate only)
//   * `axisAngle`     reflected rotations become `2*axisAngle - r` (mirror only)
//
// Nothing here mutates the model: every entry point returns patches, which the
// controller wraps in ONE cmdUpdateMany so a gesture is a single undo step.
// The same patches drive the live preview (merged into Scene.overrides), so
// what you see during the drag is exactly what gets committed.
import type { AnyElement, TextElement, Vec2 } from '../core/types';
import type { BIMModel } from '../core/model';
import { add, clamp, mul, perp, rot, wallLength } from '../core/geometry';

export type XformKind = 'scale' | 'rotate' | 'mirror';

export interface Xform {
  kind: XformKind;
  /** maps a model-space point */
  point: (p: Vec2) => Vec2;
  /** uniform multiplier for length-valued fields (1 for rotate/mirror) */
  lengthFactor: number;
  /** radians added to element rotations (0 for scale/mirror) */
  angleDelta: number;
  /** mirror axis direction, radians CCW from +x (0 for scale/rotate) */
  axisAngle: number;
}

/** guards against a degenerate or absurd drag turning the model into dust */
export const MIN_SCALE_FACTOR = 1e-4;
export const MAX_SCALE_FACTOR = 1e4;

/** text height clamp, mm — a 2D label below ~10mm is invisible at any zoom */
export const MIN_TEXT_SIZE = 10;
export const MAX_TEXT_SIZE = 100_000;

/** the three tools driven from here; matches the matching ToolId members */
export type TransformTool = XformKind;

// ------------------------------------------------------------------
// Xform constructors
// ------------------------------------------------------------------

export function scaleXform(base: Vec2, factor: number): Xform {
  const f = clamp(factor, MIN_SCALE_FACTOR, MAX_SCALE_FACTOR);
  return {
    kind: 'scale',
    point: (p) => ({ x: base.x + (p.x - base.x) * f, y: base.y + (p.y - base.y) * f }),
    lengthFactor: f,
    angleDelta: 0,
    axisAngle: 0,
  };
}

export function rotateXform(base: Vec2, angle: number): Xform {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    kind: 'rotate',
    point: (p) => {
      const dx = p.x - base.x;
      const dy = p.y - base.y;
      return { x: base.x + dx * c - dy * s, y: base.y + dx * s + dy * c };
    },
    lengthFactor: 1,
    angleDelta: angle,
    axisAngle: 0,
  };
}

/** reflection across the infinite line through a and b */
export function mirrorXform(a: Vec2, b: Vec2): Xform {
  const theta = Math.atan2(b.y - a.y, b.x - a.x);
  // reflection about a line at angle t:  (x,y) -> (x cos2t + y sin2t, x sin2t - y cos2t)
  const c2 = Math.cos(2 * theta);
  const s2 = Math.sin(2 * theta);
  return {
    kind: 'mirror',
    point: (p) => {
      const dx = p.x - a.x;
      const dy = p.y - a.y;
      return { x: a.x + dx * c2 + dy * s2, y: a.y + dx * s2 - dy * c2 };
    },
    lengthFactor: 1,
    angleDelta: 0,
    axisAngle: theta,
  };
}

/** an element rotation (radians, CCW) after the transform */
export function mapAngle(x: Xform, r: number): number {
  return x.kind === 'mirror' ? 2 * x.axisAngle - r : r + x.angleDelta;
}

// ------------------------------------------------------------------
// per-element patches
// ------------------------------------------------------------------

type Patch = Record<string, unknown>;

/**
 * Doors and windows have no position of their own — they live at `offset`
 * along their host wall. Scaling multiplies that offset (and the opening's
 * own sizes) so it keeps its relative place on a wall that grew by the same
 * factor; the result is clamped against the POST-transform wall length so an
 * opening can never slide off its host. Mirroring reverses the wall's normal,
 * so a door's swing side has to flip to keep the same appearance.
 */
function openingPatch(
  el: Extract<AnyElement, { type: 'door' | 'window' }>,
  x: Xform,
  model: BIMModel,
  targets: ReadonlySet<string>,
): Patch | null {
  const f = x.lengthFactor;
  const patch: Patch = {};
  const width = el.width * f;
  if (f !== 1) {
    patch.width = width;
    patch.height = el.height * f;
    if (el.type === 'window') patch.sillHeight = el.sillHeight * f;
  }
  const host = model.get(el.hostWallId);
  const hostLen = host?.type === 'wall' ? wallLength(host) : 0;
  const newHostLen = hostLen * (host && targets.has(host.id) ? f : 1);
  let off = el.offset * f;
  if (newHostLen > 0) {
    off = clamp(off, width / 2, Math.max(width / 2, newHostLen - width / 2));
  }
  if (Math.abs(off - el.offset) > 1e-9) patch.offset = off;
  if (x.kind === 'mirror' && el.type === 'door') patch.flip = !el.flip;
  return Object.keys(patch).length ? patch : null;
}

/**
 * Text follows AutoCAD's MIRRTEXT=0 convention: mirroring moves the anchor but
 * leaves the glyphs readable rather than back-to-front (the canvas cannot draw
 * reversed text, and reflecting the rotation would only turn labels upside
 * down). Horizontal justification swaps so the block still lands on the
 * mirrored side of its anchor point.
 */
function textPatch(el: TextElement, x: Xform): Patch {
  const patch: Patch = { position: x.point(el.position) };
  if (x.lengthFactor !== 1) {
    patch.size = clamp(el.size * x.lengthFactor, MIN_TEXT_SIZE, MAX_TEXT_SIZE);
  }
  if (x.kind === 'mirror') {
    if (el.hAlign === 'left') patch.hAlign = 'right';
    else if (el.hAlign === 'right') patch.hAlign = 'left';
  } else if (x.angleDelta !== 0) {
    patch.rotation = el.rotation + x.angleDelta;
  }
  return patch;
}

/** patch that applies `x` to one element, or null when it has nothing to change */
export function transformPatchFor(
  el: AnyElement,
  x: Xform,
  model: BIMModel,
  targets: ReadonlySet<string>,
): Patch | null {
  const f = x.lengthFactor;
  const P = x.point;
  switch (el.type) {
    case 'wall': {
      const patch: Patch = { start: P(el.start), end: P(el.end) };
      if (f !== 1) {
        patch.thickness = el.thickness * f;
        patch.height = el.height * f;
      }
      return patch;
    }
    case 'door':
    case 'window':
      return openingPatch(el, x, model, targets);
    case 'column': {
      const patch: Patch = { position: P(el.position), rotation: mapAngle(x, el.rotation) };
      if (f !== 1) {
        patch.width = el.width * f;
        patch.depth = el.depth * f;
        patch.height = el.height * f;
      }
      return patch;
    }
    case 'beam': {
      const patch: Patch = { start: P(el.start), end: P(el.end) };
      if (f !== 1) {
        patch.width = el.width * f;
        patch.depth = el.depth * f;
      }
      return patch;
    }
    case 'slab': {
      const patch: Patch = { outline: el.outline.map(P) };
      if (f !== 1) patch.thickness = el.thickness * f;
      return patch;
    }
    case 'room':
      return { boundary: el.boundary.map(P) };
    case 'stair': {
      // A stair's footprint runs from `position` along its rotation and then
      // toward perp(dir). Mirroring reverses handedness, so the reflected
      // rectangle is anchored at the opposite long edge — reflecting that
      // corner instead keeps the footprint (and direction of ascent) exact.
      const anchor =
        x.kind === 'mirror'
          ? add(el.position, mul(perp(rot({ x: 1, y: 0 }, el.rotation)), el.width))
          : el.position;
      const patch: Patch = { position: P(anchor), rotation: mapAngle(x, el.rotation) };
      if (f !== 1) {
        patch.width = el.width * f;
        patch.length = el.length * f;
      }
      return patch;
    }
    case 'furniture': {
      const patch: Patch = { position: P(el.position), rotation: mapAngle(x, el.rotation) };
      if (f !== 1) {
        patch.width = el.width * f;
        patch.depth = el.depth * f;
        patch.height = el.height * f;
      }
      return patch;
    }
    case 'dimension': {
      const patch: Patch = { start: P(el.start), end: P(el.end) };
      // offsetDist is signed along perp(end-start); a mirror reverses that
      // normal, so the sign has to flip for the witness line to stay put.
      const off = el.offsetDist * f * (x.kind === 'mirror' ? -1 : 1);
      if (off !== el.offsetDist) patch.offsetDist = off;
      return patch;
    }
    case 'text':
      return textPatch(el, x);
    case 'refline':
      return { points: el.points.map(P) };
    default:
      return null;
  }
}

/**
 * Ids actually transformed: the selection, plus every door/window hosted by a
 * selected wall. Openings carry no position of their own, so leaving them
 * behind would strand them — a mirrored wall would keep its doors swinging the
 * wrong way, a scaled wall would keep pre-scale opening widths.
 */
export function transformTargets(model: BIMModel, ids: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    if (model.get(id)) out.add(id);
  }
  for (const id of [...out]) {
    if (model.get(id)?.type === 'wall') {
      for (const o of model.hosted(id)) out.add(o.id);
    }
  }
  return [...out];
}

/** every patch a transform produces, ready for cmdUpdateMany */
export function transformEntries(
  model: BIMModel,
  ids: readonly string[],
  x: Xform,
): { id: string; patch: Patch }[] {
  const targetIds = transformTargets(model, ids);
  const targets = new Set(targetIds);
  const out: { id: string; patch: Patch }[] = [];
  for (const id of targetIds) {
    const el = model.get(id);
    if (!el) continue;
    const patch = transformPatchFor(el, x, model, targets);
    if (patch && Object.keys(patch).length) out.push({ id, patch });
  }
  return out;
}
