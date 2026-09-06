// Public surface of the 2D drafting editor — what the shell may import.
//
// The wiring agent needs five things and nothing else:
//   1. `EditorController` + `EditorHost` — construct it with an adapter over
//      the studio store and `src/core/modelStore.ts` (getModel / runCommand /
//      undo / redo already have the right shapes).
//   2. `Editor2D` — the React mount; see the "integration seam" block at the
//      top of Editor2D.tsx for the whole contract.
//   3. `TOOL_GROUPS` / `TOOL_DEFS` / `TOOL_NAMES` / `TOOL_KEYS` / `toolName` —
//      ONE table for the strip's buttons AND the status bar's label (D3).
//      The strip renders `key` for its tooltip; it must NOT bind a keydown
//      listener, because the controller owns the keyboard (D1/D2).
//   4. `EditorStatus` — subscribe with `controller.onStatus()` (or the
//      `onStatus` prop) and render `hint` in the status bar (§11).
//   5. `View` + `fitView`/`zoomAt`/`toModel`/`toScreen` — if the host viewport
//      owns pan and zoom, pass `ownsViewGestures: false` and push each new
//      View in with `setView()`.
export { EditorController, activeEditor, type EditorOptions } from './controller';
export { default as Editor2D, type Editor2DProps } from './Editor2D';
export type {
  CatalogItem,
  EditorAppState,
  EditorHost,
  EditorStatus,
  StatusListener,
  ViewListener,
} from './host';
export {
  TOOL_BY_ID,
  TOOL_DEFS,
  TOOL_GROUPS,
  TOOL_KEYS,
  TOOL_NAMES,
  isToolId,
  toolForKey,
  toolName,
  type ToolDef,
  type ToolId,
} from './tools';
// 6. `TOOL_OPTIONS` — what each tool is ARMED with. The strip renders these
//    fields and writes them through `EditorHost.setToolOption`; the controller
//    reads the same table, so a field the UI shows and a number the geometry
//    gets can never be two different things.
export {
  ACTIVE_LAYER_KEY,
  ALL_TOOL_OPTIONS,
  DEFAULT_LAYER,
  LAYERED_TOOLS,
  TOOL_OPTIONS,
  activeLayerOf,
  clampOption,
  optNumber,
  type ToolOptionDef,
  type ToolOptionKey,
} from './toolOptions';
export {
  MAX_SCALE,
  MIN_SCALE,
  fitView,
  panBy,
  toModel,
  toScreen,
  zoomAt,
  type View,
} from './view';
export { computeSnap, type SnapKind, type SnapResult } from './snap';
export { drawScene, type EditorColors, type Scene } from './render';
export { elementsInRect, hitTest, levelBounds } from './hit';
