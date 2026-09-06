// The seam between the editor and whatever shell it is mounted in.
//
// SOURCE's controller imported the old app store directly (`getAppState`,
// `setStatus`, `setActiveTool`, `runCommand`, …) and pushed its hint line into
// it. That is inverted here: the controller reads and writes ONLY through an
// `EditorHost` handed to it at construction, and publishes its hint + cursor
// to subscribers. Nothing under src/editor imports a store.
//
// Two reasons this matters beyond tidiness:
//  * the shell in this rebuild owns its own state (src/studio/store.ts) and its
//    viewport owns pan/zoom — the editor must not assume either;
//  * a controller with an injected host can be driven from a test, which is why
//    the five defects in EDITOR_TOOLS_NOTE §13 survived unnoticed in SOURCE.
//
// Everything the tools mutate still goes through `runCommand` (§9, §12): the
// host supplies the command sink, the editor never touches the model directly.
import type { Vec2 } from '../core/types';
import type { BIMModel } from '../core/model';
import type { Command } from '../core/commands';
import type { ToolId } from './tools';

/**
 * One catalogue entry — a door/window/furniture family that can be placed.
 * SOURCE read these from `src/library/catalog.ts`; the shell owns the library
 * now, so it is passed in. Only the fields the editor actually draws or
 * measures with are declared.
 */
export interface CatalogItem {
  id: string;
  name: string;
  category: 'door' | 'window' | 'furniture' | 'sanitary' | 'structural';
  /** plan footprint, mm */
  width: number;
  depth: number;
  height: number;
  /** optional plan symbol as an SVG path in a unit box (0..1 × 0..1) */
  symbolPath?: string;
}

/** The slice of shell state the editor reads on every event. */
export interface EditorAppState {
  activeTool: ToolId;
  activeLevelId: string;
  selectedIds: string[];
  /** the Library tab's armed item; arms the Furniture tool and sizes openings */
  activeCatalogId: string | null;
  /** wallThickness, doorWidth, textSize, activeLayer, … */
  toolOptions: Record<string, number | string | boolean>;
  /** CAD layer names hidden in the shell's layer panel */
  hiddenLayers: string[];
}

/** What the status bar renders. §11 — per tool AND per phase. */
export interface EditorStatus {
  /** post-snap cursor point in model mm, or null when off-canvas */
  cursor: Vec2 | null;
  hint: string;
}

export interface EditorHost {
  /** null before a project is open — the editor simply does not draw */
  model(): BIMModel | null;
  state(): EditorAppState;
  setSelection(ids: string[]): void;
  setActiveTool(tool: ToolId): void;
  /** the ONLY way a tool changes the model (§9, §12) */
  runCommand(cmd: Command): void;
  undo(): void;
  redo(): void;
  /** remember a tool option, e.g. the text height dialled in by the resize grip */
  setToolOption?(key: string, value: number | string | boolean): void;
  /** resolve a catalogue id; omit and catalogue-driven sizing falls back to DEFAULTS */
  catalogItem?(id: string): CatalogItem | undefined;
  /** what the Text tool asks for; defaults to window.prompt */
  promptText?(): string | null;
}

export type StatusListener = (s: EditorStatus) => void;
export type ViewListener = (v: { scale: number; tx: number; ty: number }) => void;
