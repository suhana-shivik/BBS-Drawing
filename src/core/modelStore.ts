// The active BIM model + its command stack.
//
// ── The seam ────────────────────────────────────────────────────────────────
// SOURCE kept this inside `src/core/store.ts`, which was the whole old app's
// state: screens, workspaces, view mode, assistant visibility, tool options,
// selection, status bar. This repo already has one shell store —
// `src/studio/store.ts` — and a second app store would be a second source of
// truth for the same facts within a day. So only the *model* half of SOURCE's
// store lives here:
//
//   ported     the active BIMModel holder, the CommandStack, runCommand,
//              undo/redo, and a subscribe function
//   NOT ported screen / viewMode / workspace / assistantOpen / toolsVisible /
//              inspectorVisible / activeTool / selectedIds / activeLevelId /
//              hiddenIds / isolatedIds / activeCatalogId / toolOptions /
//              hiddenLayers / the status-bar store / IndexedDB autosave
//
// Everything in that second list is shell state and belongs to
// `src/studio/store.ts`, or is UI state that belongs to the editor.
//
// This module deliberately imports NOTHING from `src/studio`, `src/components`
// or `src/cad`, and it does not touch React. It is a plain observable the
// studio store drives:
//
//   openModel(data)            when a project opens
//   subscribe(fn) + revision() to mirror into useSyncExternalStore, or to
//                              debounce an autosave of `getModel().toJSON()`
//   runCommand / undo / redo   the editor's only write path (EDITOR_TOOLS_NOTE
//                              §9 — no tool calls model.add directly)
//
// undo() and redo() return the NAME of the command they moved, so the shell can
// render "Undo — Draw wall" and record a matching named entry in its own
// history stack, exactly like StudioStore.record(label, undo, redo).
// ────────────────────────────────────────────────────────────────────────────

import type { ProjectData } from './types';
import { BIMModel } from './model';
import { type Command, CommandStack } from './commands';

export type ModelStoreListener = () => void;

let model: BIMModel | null = null;
let unsubscribeModel: (() => void) | null = null;
let rev = 0;

const listeners = new Set<ModelStoreListener>();

/** The undo/redo stack for the active model. Cleared whenever a model opens. */
export const commandStack = new CommandStack();

function emit(): void {
  rev += 1;
  for (const fn of [...listeners]) fn();
}

// ------------------------------------------------------------
// subscription
// ------------------------------------------------------------

/**
 * Called on every model mutation, on a model swap, and after undo/redo.
 * Returns the unsubscribe function.
 */
export function subscribe(fn: ModelStoreListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * A monotonically increasing revision — a stable snapshot for
 * `useSyncExternalStore(subscribe, revision)`. It changes when the model
 * changes AND when the model itself is replaced, which `model.version` alone
 * cannot express (a fresh model restarts at 0).
 */
export function revision(): number {
  return rev;
}

// ------------------------------------------------------------
// the active model
// ------------------------------------------------------------

/** Throws when nothing is open — callers that may run with no project use `maybeModel`. */
export function getModel(): BIMModel {
  if (!model) throw new Error('No project is open');
  return model;
}

export function maybeModel(): BIMModel | null {
  return model;
}

export function hasModel(): boolean {
  return model !== null;
}

/**
 * Make `data` the active model. The command stack is cleared: undo must never
 * reach across a project boundary. Persistence is the caller's job — subscribe
 * and save `getModel().toJSON()`.
 */
export function openModel(data: ProjectData): BIMModel {
  detach();
  model = BIMModel.fromJSON(data);
  commandStack.clear();
  unsubscribeModel = model.subscribe(emit);
  emit();
  return model;
}

/** Adopt an already-built model (import pipelines that construct one directly). */
export function setModel(next: BIMModel | null): void {
  detach();
  model = next;
  commandStack.clear();
  if (model) unsubscribeModel = model.subscribe(emit);
  emit();
}

export function closeModel(): void {
  detach();
  model = null;
  commandStack.clear();
  emit();
}

function detach(): void {
  if (unsubscribeModel) {
    unsubscribeModel();
    unsubscribeModel = null;
  }
}

// ------------------------------------------------------------
// the write path
// ------------------------------------------------------------

/**
 * The ONLY way anything mutates the model. Every drafting tool commits through
 * here, which is what makes the whole editor undoable by construction.
 */
export function runCommand(cmd: Command): void {
  commandStack.run(getModel(), cmd);
  emit();
}

/** Returns the name of the command undone, or null when there was nothing to undo. */
export function undo(): string | null {
  const name = commandStack.undoName;
  if (name === null) return null;
  commandStack.undo(getModel());
  emit();
  return name;
}

/** Returns the name of the command redone, or null when there was nothing to redo. */
export function redo(): string | null {
  const name = commandStack.redoName;
  if (name === null) return null;
  commandStack.redo(getModel());
  emit();
  return name;
}

export function canUndo(): boolean {
  return model !== null && commandStack.canUndo;
}

export function canRedo(): boolean {
  return model !== null && commandStack.canRedo;
}

/** What the Undo control should say it will undo — null when it is disabled. */
export function undoLabel(): string | null {
  return model === null ? null : commandStack.undoName;
}

/** What the Redo control should say it will re-apply — null when it is disabled. */
export function redoLabel(): string | null {
  return model === null ? null : commandStack.redoName;
}

/** Oldest-first names of everything on the undo stack. */
export function undoHistory(): string[] {
  return commandStack.history;
}
