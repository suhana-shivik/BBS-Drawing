// ============================================================
// Set-selection queries against a resolved display list.
//
// The click-pick lives in hitTest.ts; this is everything that answers
// "which entities are in / under this region?" — marquee selection, select
// all, and the bounds of a selection for zoom-to-fit.
//
// All of it works from the display list rather than from CadEntity, for the
// same reason the painter and the hit-test do: the ops are already resolved
// (block transforms applied, curves tessellated, hidden layers dropped), so
// what the user boxed on screen is exactly what these functions measure.
// Bounds come from the cached `listBounds` array — no per-call geometry
// walk over the whole document.
//
// Model space (mm) throughout.
// ============================================================
import type { Vec2 } from '../../core/types';
import type { DisplayList } from '../types';
import { listBounds } from './bounds';

/** 'contain' = fully inside (drag left→right), 'intersect' = crossing (right→left) */
export type RectMode = 'contain' | 'intersect';

export interface RectSelectOptions {
  /** layers to ignore, matching what the painter was told to hide */
  hiddenLayers?: ReadonlySet<string> | null;
}

/** an op with no ink (fully transparent, or a path with neither stroke nor fill) */
function isBlank(op: DisplayList['ops'][number]): boolean {
  if (op.alpha <= 0) return true;
  return op.kind === 'path' && op.stroke === null && op.fill === null;
}

/**
 * Handles of every entity the rect selects.
 *
 * Op bounding boxes are the whole test, deliberately: it is what the BIM
 * marquee does (`elementsInRect`), it is O(1) per op against the cached
 * bounds array, and a box test is what CAD users expect from a crossing
 * window anyway. An entity split across several ops (a hatch, a block
 * instance) is selected as soon as any one of its ops qualifies.
 *
 * Handles come back in list order, de-duplicated.
 */
export function handlesInRect(
  list: DisplayList,
  min: Vec2,
  max: Vec2,
  mode: RectMode,
  opts?: RectSelectOptions,
): string[] {
  const ops = list.ops;
  const bounds = listBounds(list);
  const hidden = opts?.hiddenLayers ?? null;
  const seen = new Set<string>();
  const out: string[] = [];
  const contain = mode === 'contain';

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (hidden !== null && hidden.has(op.layer)) continue;
    if (isBlank(op)) continue;
    if (seen.has(op.handle)) continue;
    const b = i * 4;
    const minX = bounds[b];
    const minY = bounds[b + 1];
    const maxX = bounds[b + 2];
    const maxY = bounds[b + 3];
    // an empty op keeps the inverted box the bounds builder left behind,
    // which fails both tests below — exactly what we want
    const hit = contain
      ? minX >= min.x && maxX <= max.x && minY >= min.y && maxY <= max.y
      : maxX >= min.x && minX <= max.x && maxY >= min.y && minY <= max.y;
    if (!hit) continue;
    seen.add(op.handle);
    out.push(op.handle);
  }
  return out;
}

/**
 * Every handle that currently has ink on screen — "select all".
 *
 * The display list was already built against the session's hidden layers and
 * the file's own layer on/off/frozen state, so anything still in it is
 * visible; `hiddenLayers` here only covers layers hidden after the build.
 */
export function visibleHandles(
  list: DisplayList,
  hiddenLayers?: ReadonlySet<string> | null,
): string[] {
  const hidden = hiddenLayers ?? null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const op of list.ops) {
    if (hidden !== null && hidden.has(op.layer)) continue;
    if (isBlank(op)) continue;
    if (seen.has(op.handle)) continue;
    seen.add(op.handle);
    out.push(op.handle);
  }
  return out;
}

/**
 * Union model-space box of every op carrying one of `handles`, or null when
 * none of them is in the list. Used to frame the view on a selection.
 */
export function handlesBounds(
  list: DisplayList,
  handles: ReadonlySet<string>,
): { min: Vec2; max: Vec2 } | null {
  if (handles.size === 0) return null;
  const ops = list.ops;
  const bounds = listBounds(list);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ops.length; i++) {
    if (!handles.has(ops[i].handle)) continue;
    const b = i * 4;
    if (!Number.isFinite(bounds[b]) || !Number.isFinite(bounds[b + 2])) continue;
    if (bounds[b] < minX) minX = bounds[b];
    if (bounds[b + 1] < minY) minY = bounds[b + 1];
    if (bounds[b + 2] > maxX) maxX = bounds[b + 2];
    if (bounds[b + 3] > maxY) maxY = bounds[b + 3];
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}
