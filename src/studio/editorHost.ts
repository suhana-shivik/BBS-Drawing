// The seam the editor was built against: an `EditorHost` (src/editor/host.ts)
// implemented over the studio store (shell state) and src/core/modelStore
// (the BIM model + its command stack). Nothing under src/editor imports a
// store; nothing here imports src/editor's internals.
//
// ── Three decisions this file makes, all of them load-bearing ───────────────
//
// 1. `state()` IS LIVE. It reads `store.getState()` on every call and builds a
//    fresh EditorAppState. The controller calls it inside every pointer and
//    key event, so a cached snapshot would arm the wrong tool for one frame.
//
// 2. ONE CTRL+Z, ONE VISIBLE UNDO STACK. The shell already had a named history
//    (StudioStore.record/undo/redo) that the Edit menu renders. The model has
//    its own CommandStack. Two stacks would mean two Ctrl+Z's, so they are
//    chained rather than merged:
//
//        runCommand(cmd)  →  modelStore.runCommand(cmd)          // model stack
//                         →  store.record(cmd.name, undo, redo)  // visible stack
//
//        host.undo()      →  store.undo()                        // visible stack
//                         →  entry.undo() → modelStore.undo()    // model stack
//
//    The visible stack is the ONLY entry point. It holds both kinds of entry
//    (a layer toggle and a drawn wall) in one chronological order; unwinding it
//    top-down meets the model entries in exactly the order the model stack
//    holds them, so the two can never fall out of step. The controller's own
//    Ctrl+Z calls `host.undo()`, i.e. the same door, and the Edit menu's Undo
//    names the command: "Undo — Draw wall".
//
//    The one honest caveat: StudioStore.record keeps the last 60 entries. A
//    command evicted off the bottom stays on the model stack but is no longer
//    reachable — the visible history is the truth, and it says 60.
//
// 3. SNAP FLAGS ARE MODEL STATE (EDITOR_TOOLS_NOTE §14.3). `snapFlags()` and
//    `setSnapFlag()` read and write `model.settings` and nothing else. There is
//    no UI mirror of them anywhere in the shell, so the tool strip and the
//    status bar cannot drift apart — they are reading the same object. With no
//    model open the flags are UNAVAILABLE, and the surfaces say so instead of
//    toggling something that means nothing.

import { useSyncExternalStore } from 'react';
import { cmdAddLevel, cmdDeleteElements, type Command } from '../core/commands';
import type { BIMModel } from '../core/model';
import type { Level, ProjectData, ProjectSettings } from '../core/types';
import { DEFAULTS, newId } from '../core/types';
import * as modelStore from '../core/modelStore';
import type { CatalogItem, EditorAppState, EditorHost, EditorStatus } from '../editor/host';
import { isToolId, type ToolId } from '../editor/tools';
import { CATALOG } from '../library/catalog';
import { layersFor, type StudioState, type StudioStore } from './store';

// ---------------------------------------------------------------------------
// the model, as the shell sees it
// ---------------------------------------------------------------------------

/** Re-renders a component whenever the active model changes or is swapped. */
export function useModelRevision(): number {
  return useSyncExternalStore(modelStore.subscribe, modelStore.revision, modelStore.revision);
}

/** The active model, or null. Subscribes, so callers re-render on a swap. */
export function useEditorModel(): BIMModel | null {
  useModelRevision();
  return modelStore.maybeModel();
}

/**
 * A project record straight out of storage may carry no level — older studio
 * projects were created as `levels: []`, and every drafting tool needs a level
 * to draw on (a column even takes its height from one). Normalise on the way
 * in rather than refusing every tool for a reason the user cannot act on.
 */
export const GROUND_LEVEL_ID = 'level-ground';

export function withGroundLevel(data: ProjectData): ProjectData {
  if (data.levels.length) return data;
  return {
    ...data,
    levels: [{ id: GROUND_LEVEL_ID, name: 'Ground Floor', elevation: 0, height: 3000 }],
  };
}

/** Open `data` as the active model, guaranteeing it has at least one level. */
export function openEditorModel(data: ProjectData): BIMModel {
  return modelStore.openModel(withGroundLevel(data));
}

export function closeEditorModel(): void {
  modelStore.closeModel();
}

// ---------------------------------------------------------------------------
// snap flags — model state, one source (§14.3)
// ---------------------------------------------------------------------------

export interface SnapFlags {
  grid: boolean;
  objects: boolean;
  /** false when no model is open: the flags have nowhere to live yet */
  available: boolean;
}

export const NO_SNAP_HOME =
  'Snaps live on the project model — open a project before setting them.';

export function snapFlags(): SnapFlags {
  const m = modelStore.maybeModel();
  if (!m) return { grid: false, objects: false, available: false };
  return { grid: m.settings.snapGrid, objects: m.settings.snapObjects, available: true };
}

/** Returns false when there is no model to write to — the caller must say so. */
export function setSnapFlag(which: 'grid' | 'objects', on: boolean): boolean {
  const m = modelStore.maybeModel();
  if (!m) return false;
  const patch: Partial<ProjectSettings> =
    which === 'grid' ? { snapGrid: on } : { snapObjects: on };
  m.updateSettings(patch);
  return true;
}

/** Both surfaces (strip and status bar) call this; both get the same object. */
export function useSnapFlags(): SnapFlags {
  useModelRevision();
  return snapFlags();
}

// ---------------------------------------------------------------------------
// grid spacing — model state too, and the number GRID actually snaps to
// ---------------------------------------------------------------------------
//
// The GRID flag was settable and the spacing it snaps to was not, so the
// toggle armed a 100 mm grid nobody chose. It is the same `model.settings`
// object the flags live on (§14.3), so it gets the same treatment: read and
// written here, mirrored nowhere.
//
// It is not only the grid: `snapTo` in the controller, the arrow-key nudge and
// Ctrl+D's duplicate offset all measure themselves in this number (falling
// back to 500 mm when it is 0, per §5).

export const MIN_GRID = 1;
export const MAX_GRID = 100000;

/** Current spacing in mm, or null when there is no model to read it from. */
export function gridSpacing(): number | null {
  return modelStore.maybeModel()?.settings.gridSpacing ?? null;
}

/** Returns false when there is no model to write to — the caller must say so. */
export function setGridSpacing(mm: number): boolean {
  const m = modelStore.maybeModel();
  if (!m) return false;
  if (!Number.isFinite(mm)) return false;
  m.updateSettings({ gridSpacing: Math.min(MAX_GRID, Math.max(MIN_GRID, Math.round(mm))) });
  return true;
}

export function useGridSpacing(): number | null {
  useModelRevision();
  return gridSpacing();
}

// ---------------------------------------------------------------------------
// levels — what every tool draws on, and what Stair needs one of ABOVE it
// ---------------------------------------------------------------------------
//
// Every element a tool creates carries `levelId: activeLevelId`; a column even
// takes its height from that level, and the Stair tool refuses outright unless
// `model.levelAbove(activeLevelId)` exists (§8.6). `store.setEditorLevel` and
// `cmdAddLevel` both existed and nothing in the shell called either, so the
// editor drew on `levels[0]` for ever and Stair could not be placed at all.
//
// ONE expression for "the level the tools draw on", used by `editorStateOf`,
// the viewport and the arming row alike — three copies of `?? levels[0]?.id`
// is exactly how the three drift.

export function activeLevelIdOf(s: StudioState, model: BIMModel | null): string {
  return s.editor.levelId ?? model?.levels[0]?.id ?? '';
}

/** The project's levels, lowest first. Re-renders on any model change. */
export function useEditorLevels(): Level[] {
  useModelRevision();
  return modelStore.maybeModel()?.sortedLevels() ?? [];
}

/**
 * Add a storey on top of the building — the action the Stair tool's refusal
 * ("Add a level above first") asks for.
 *
 * It goes through the SAME host as a drawn wall, so it lands on the model's
 * command stack AND the shell's visible history as one named entry: adding a
 * level is one Ctrl+Z, like everything else (§9).
 */
export function addLevelAbove(store: StudioStore, notify?: EditorNotify): Level | null {
  const m = modelStore.maybeModel();
  if (!m) {
    notify?.('No project model is open — there is no building to add a storey to.', 'warn');
    return null;
  }
  const sorted = m.sortedLevels();
  const top = sorted[sorted.length - 1];
  const level: Level = {
    id: newId('level'),
    name: `Level ${m.levels.length + 1}`,
    elevation: top ? top.elevation + top.height : 0,
    height: top?.height ?? DEFAULTS.levelHeight,
  };
  createEditorHost(store, notify ? { notify } : {}).runCommand(cmdAddLevel(level));
  notify?.(`Added ${level.name} at +${level.elevation} mm.`, 'ok');
  return level;
}

// ---------------------------------------------------------------------------
// the hint bus (§11)
// ---------------------------------------------------------------------------
//
// The controller publishes a status on every phase change AND on every pointer
// move. Pushing that through the studio store would re-render the whole shell
// per pixel, exactly as the cursor readout would — so it rides the same kind of
// side-channel `cursorBus` uses and lands in the status bar alone.

const EMPTY_STATUS: EditorStatus = { cursor: null, hint: '' };

class EditorStatusBus {
  private status: EditorStatus = EMPTY_STATUS;
  private listeners = new Set<() => void>();

  get = (): EditorStatus => this.status;

  set(next: EditorStatus): void {
    this.status = next;
    this.listeners.forEach((fn) => fn());
  }

  clear(): void {
    if (this.status !== EMPTY_STATUS) this.set(EMPTY_STATUS);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

export const editorStatusBus = new EditorStatusBus();

export function useEditorStatus(): EditorStatus {
  return useSyncExternalStore(editorStatusBus.subscribe, editorStatusBus.get, editorStatusBus.get);
}

// ---------------------------------------------------------------------------
// what the shell must say when the editor cannot do what the strip implies
// ---------------------------------------------------------------------------
//
// §12: a CAD sheet is an UNDERLAY. Every tool creates BIM elements in the
// project model; nothing a tool draws is written back into the DXF, and a PDF
// page has no geometry at all. Where the project lacks what a tool needs, the
// sentence has to reach the user rather than the click quietly doing nothing.
//
// This is NOT tool text — the controller owns that (§11) and this function
// never looks at the active tool. It says what the SURFACE is.

export interface SheetFacts {
  /** a sheet is open on the stage */
  open: boolean;
  /** the sheet is real CAD geometry, not a rasterised PDF page */
  hasGeometry: boolean;
}

export function editorNotice(sheet: SheetFacts, model: BIMModel | null): string | null {
  if (!sheet.open) return null;
  if (!model) {
    return 'No project model is open — the drafting tools have nothing to draw into.';
  }
  if (!model.levels.length) {
    return 'This project has no level yet — add one before drawing.';
  }
  if (!sheet.hasGeometry) {
    return 'This sheet is a raster PDF page: no CAD entities to snap to or measure. Tools still draw model elements over it.';
  }
  // The underlay stays an underlay — worth saying once, where the tools are.
  return 'Tools draw BIM elements into the project model — the drawing underneath is never edited.';
}

// ---------------------------------------------------------------------------
// the host
// ---------------------------------------------------------------------------

export type EditorNotify = (message: string, kind?: 'ok' | 'warn') => void;

export interface EditorHostDeps {
  /** how a refusal or an undo reaches the user; the shell passes `toast` */
  notify?: EditorNotify;
  /**
   * What the Text tool asks for. Defaults to `window.prompt` — deliberately,
   * and stated here rather than hidden: the shell has no modal system of its
   * own yet, and a half-built inline prompt would be a worse lie than the
   * browser's own dialog. Swap this one function when it gets one.
   */
  promptText?: () => string | null;
}

/** Live shell state, rebuilt per call. Never cache the result. */
export function editorStateOf(s: StudioState, model: BIMModel | null): EditorAppState {
  const tool: ToolId = isToolId(s.ui.activeTool) ? s.ui.activeTool : 'select';
  const levelId = activeLevelIdOf(s, model);
  const sheetLayers = layersFor(s.view, s.sheets.active);
  return {
    activeTool: tool,
    activeLevelId: levelId,
    selectedIds: s.editor.selectedIds,
    activeCatalogId: s.editor.catalogId,
    toolOptions: s.editor.toolOptions,
    hiddenLayers: Object.keys(sheetLayers).filter((id) => sheetLayers[id] === false),
  };
}

export function catalogItem(id: string): CatalogItem | undefined {
  return CATALOG.find((c) => c.id === id);
}

export function createEditorHost(store: StudioStore, deps: EditorHostDeps = {}): EditorHost {
  const notify = deps.notify;
  return {
    model: () => modelStore.maybeModel(),

    // LIVE, per the seam contract in Editor2D.tsx: read on every event.
    state: () => editorStateOf(store.getState(), modelStore.maybeModel()),

    setSelection: (ids) => store.setEditorSelection(ids),

    setActiveTool: (tool) => store.setActiveTool(tool),

    /**
     * The single write path (§9/§12). It runs the command on the model stack,
     * then records ONE named entry on the shell's visible history that
     * delegates back to the model stack. See the header for why that ordering
     * keeps the two in lockstep.
     */
    runCommand: (cmd: Command) => {
      if (!modelStore.hasModel()) {
        notify?.('No project model is open — there is nothing to draw into.', 'warn');
        return;
      }
      modelStore.runCommand(cmd);
      store.record(
        cmd.name,
        () => void modelStore.undo(),
        () => void modelStore.redo(),
      );
    },

    undo: () => {
      const label = store.undo();
      if (label) notify?.(`Undid ${label}.`);
      else notify?.('Nothing to undo.');
    },

    redo: () => {
      const label = store.redo();
      if (label) notify?.(`Redid ${label}.`);
      else notify?.('Nothing to redo.');
    },

    setToolOption: (key, value) => store.setToolOption(key, value),

    catalogItem,

    promptText:
      deps.promptText ??
      (() => (typeof window === 'undefined' ? null : window.prompt('Text', 'Text'))),
  };
}

/**
 * Edit → Delete selection, from a menu that has no controller to talk to. It
 * goes through the same host, so it lands on the same command stack and the
 * same visible history — and when there is no model selection it says the true
 * thing: the sheet underneath is an underlay, not editable geometry (§12).
 */
export function deleteEditorSelection(store: StudioStore, notify?: EditorNotify): void {
  const ids = store.getState().editor.selectedIds;
  if (!ids.length) {
    notify?.('Nothing deleted — the sheet is an underlay, not editable geometry.', 'warn');
    return;
  }
  createEditorHost(store, { notify }).runCommand(cmdDeleteElements(ids, 'Delete'));
  store.setEditorSelection([]);
  notify?.(`Deleted ${ids.length} element${ids.length === 1 ? '' : 's'}.`, 'ok');
}
