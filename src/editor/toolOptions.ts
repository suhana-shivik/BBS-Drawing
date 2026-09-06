// The options a tool is ARMED with — ONE table, the same way tools.ts is one
// table for the 22 tools themselves (D3).
//
// Before this file the controller read `toolOptions.wallThickness` and fell
// back to `DEFAULTS.wallThickness` inline, and NOTHING in the shell ever wrote
// the key: `setToolOption` existed on the host, the store had a `toolOptions`
// record, and no surface could put a value in it. Every wall in the app was
// 230 mm because there was no way to say otherwise — a tool that is armed only
// with its default is not a working tool, it is a fixed one.
//
// So the table is here, next to `tools.ts`, and BOTH ends read it:
//   * `EditorController.opt(key)` resolves a value or the default (below);
//   * `ToolOptions.tsx` renders exactly these fields for the active tool.
// A key the UI offers that no tool reads, or a value a tool reads that the UI
// cannot set, is the drift this file exists to make impossible.
//
// The defaults are NOT re-typed here. They are `DEFAULTS` from core/types.ts,
// which is what the tools already fell back to, so the arming UI opens showing
// the number the tool would have used anyway.
import { DEFAULTS } from '../core/types';
import type { ToolId } from './tools';

/**
 * The numeric option keys. Every one is a key of `DEFAULTS`, which is what
 * makes `optNumber` total: there is always a number to fall back to.
 */
export type ToolOptionKey =
  | 'wallThickness'
  | 'wallHeight'
  | 'doorWidth'
  | 'doorHeight'
  | 'windowWidth'
  | 'windowHeight'
  | 'sillHeight'
  | 'slabThickness'
  | 'columnSize'
  | 'beamWidth'
  | 'beamDepth'
  | 'stairWidth'
  | 'stairLength'
  | 'textSize';

export interface ToolOptionDef {
  /** the `toolOptions` key the controller reads — never spelled twice */
  key: ToolOptionKey;
  /** what the field is called in the strip */
  label: string;
  /** hard floor, mm. Below it the element would not be drawable. */
  min: number;
  /** hard ceiling, mm — a typo of 23000 for 230 should not be silently kept */
  max: number;
  /** spinner step */
  step: number;
}

/** shorthand: the default always comes from DEFAULTS, never from a literal */
function opt(key: ToolOptionKey, label: string, min: number, max: number, step = 10): ToolOptionDef {
  return { key, label, min, max, step };
}

/**
 * Which options each tool is armed with, in the order the strip shows them.
 * Tools absent from this map take no numeric option — Select, Pan, the three
 * transforms, the drafting primitives (they carry a LAYER, below, not a size),
 * Room, Dimension and Measure.
 */
export const TOOL_OPTIONS: Readonly<Partial<Record<ToolId, readonly ToolOptionDef[]>>> = {
  wall: [opt('wallThickness', 'Thickness', 20, 2000), opt('wallHeight', 'Height', 100, 20000, 50)],
  door: [opt('doorWidth', 'Width', 300, 6000), opt('doorHeight', 'Height', 300, 6000, 50)],
  window: [
    opt('windowWidth', 'Width', 200, 8000),
    opt('windowHeight', 'Height', 200, 6000, 50),
    opt('sillHeight', 'Sill', 0, 4000, 50),
  ],
  column: [opt('columnSize', 'Size', 50, 3000)],
  beam: [opt('beamWidth', 'Width', 50, 2000), opt('beamDepth', 'Depth', 50, 3000, 25)],
  slab: [opt('slabThickness', 'Thickness', 25, 2000, 25)],
  stair: [opt('stairWidth', 'Width', 400, 5000, 50), opt('stairLength', 'Run', 500, 20000, 100)],
  text: [opt('textSize', 'Height', 10, 5000, 10)],
};

/** Every numeric option any tool can be armed with, deduplicated. */
export const ALL_TOOL_OPTIONS: readonly ToolOptionDef[] = Object.values(TOOL_OPTIONS)
  .flat()
  .filter((d): d is ToolOptionDef => Boolean(d));

/**
 * The armed value for `key`, or the default.
 *
 * Total by construction: `DEFAULTS[key]` always exists, so no caller has to
 * write `?? DEFAULTS.x` again and no caller can fall back to a different
 * number than the strip is showing. A stored value that is not a finite
 * positive number is treated as absent rather than propagated into geometry.
 */
export function optNumber(
  options: Record<string, number | string | boolean> | undefined,
  key: ToolOptionKey,
): number {
  const raw = options?.[key];
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULTS[key];
}

/** Clamp a typed value into the field's declared range. */
export function clampOption(def: ToolOptionDef, value: number): number {
  if (!Number.isFinite(value)) return DEFAULTS[def.key];
  return Math.min(def.max, Math.max(def.min, value));
}

// ---------------------------------------------------------------------------
// the active CAD layer — a string option, not a size
// ---------------------------------------------------------------------------

/** `toolOptions` key holding the CAD layer new drafting primitives land on. */
export const ACTIVE_LAYER_KEY = 'activeLayer';

/** DXF's own name for the default layer; what a drawing with no layers uses. */
export const DEFAULT_LAYER = '0';

/** The tools whose output carries `layer: activeLayer()` (§8.4). */
export const LAYERED_TOOLS: readonly ToolId[] = ['line', 'polyline', 'rectangle', 'circle', 'arc', 'text'];

export function activeLayerOf(
  options: Record<string, number | string | boolean> | undefined,
): string {
  const v = options?.[ACTIVE_LAYER_KEY];
  return typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_LAYER;
}
