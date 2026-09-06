// Studio shell state — the §9 state shape from STUDIO_DESIGN.md, held in one
// small external store read through useSyncExternalStore. No state library.
//
// `select` is ONE object shared by the schedule and the canvas: whichever view
// acted writes it, both read it. Two selection states would be two sources of
// truth and would drift within a day (STUDIO_DESIGN §6.3, §9).

import { createContext, useContext, useRef, useSyncExternalStore } from 'react';

export type StageMode = 'sheet' | 'files' | 'spec';
// Two primary faces — 'details' and 'ask' — plus the three the dock keeps to
// the RIGHT of them: the catalogue, the specification and the run log.
// 'bbs' and 'qty' are not destinations; they are Ask, showing a result.
export type DockTab = 'details' | 'ask' | 'library' | 'memory' | 'log' | 'bbs' | 'qty';
export type BrowseView = 'large' | 'small' | 'details';
// The Files view sorts on any column its header offers, the way a file
// manager does — the header IS the sort control (§4.3).
export type BrowseSort =
  | 'name'
  | 'rev'
  | 'number'
  | 'type'
  | 'discipline'
  | 'size'
  | 'status'
  | 'date';
export type ViewMode = '2d' | 'split' | '3d';
export type ScheduleGroup = 'member' | 'dia' | 'shape';

export interface HistoryEntry {
  /** Names itself, so Undo can say what it will undo: "hiding Dimensions". */
  label: string;
  undo: () => void;
  redo: () => void;
}

/** Millimetre box a viewport can be asked to frame (R3 "Show on the sheet"). */
export interface FocusBounds {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface StudioState {
  /**
   * R1 — the active project. `activeId === null` means no project is open and
   * the Projects home is the surface. There is NO default project: every
   * project-scoped read takes this id, and reading without one is a bug.
   */
  project: {
    activeId: string | null;
    /** set when "New project…" was chosen from inside a project — the
     *  Projects home opens with the new-project form showing. */
    wantNew: boolean;
  };
  ui: {
    theme: 'light' | 'dark';
    treeWidth: number;
    dockWidth: number;
    treeOpen: boolean;
    /** The dock while BROWSING — the properties pane, wanted immediately. */
    dockOpen: boolean;
    /** The dock while a DRAWING is open — the assistant, asked for. */
    assistantOpen: boolean;
    toolsOpen: boolean;
    /**
     * The drawing filling the window — register, assistant, dock rail and
     * title bar collapsed to nothing.
     *
     * It is a pure VIEW override and deliberately does NOT write `treeOpen` or
     * `assistantOpen`: leaving it hands back exactly the panels the user had
     * open, which is what "restore" has to mean. The way back is the pair of
     * controls in the drawing's own bottom-right corner, which the override
     * never covers (§3 — nothing closes without leaving a way back).
     */
    maximized: boolean;
    /**
     * The sheet strip's visual order — FILES_TAB, SPEC_TAB and open sheet ids,
     * in whatever order they have been dragged into.
     *
     * This array is allowed to be stale about which sheets are open; read it
     * through `tabOrderOf`, which drops closed sheets and lands new ones.
     */
    tabOrder: string[];
    stageMode: StageMode;
    dockTab: DockTab;
    /**
     * The FILED output on screen in the BBS panel — an artifact id — or null
     * for "whatever is current": the live run if there is one, else the newest
     * filed version.
     *
     * A schedule is versioned (Outputs → BBS holds v1, v2, …) and the panel
     * could only ever show the newest one, so an older version was filed and
     * then unreachable. This is the pin that makes an old one openable, and
     * the panel says which version it is showing whenever it is set.
     */
    artifactId: string | null;
    activeTool: string;
    // EDITOR_TOOLS_NOTE §14.3 — there is deliberately NO snapGrid/snapOsnap
    // here. Both flags are MODEL state (`model.settings`), read and written
    // through the editor host, so the tool strip and the status bar cannot
    // drift apart. A UI mirror of them would be exactly the drift the note
    // warns about.
    /** Ctrl+P — asks the title bar to open the project switcher menu. */
    switcherOpen: boolean;
    /** Ctrl+K — the command palette over the project index (R6). */
    paletteOpen: boolean;
  };
  /** R4 — the Specification view's one-shot navigation target (§6.4). */
  spec: {
    /** fact id to scroll to and expand after the next render, then cleared */
    reveal: string | null;
  };
  browse: {
    /** Folder ids from the root down; [] is the root ("Files"). */
    path: string[];
    view: BrowseView;
    sort: BrowseSort;
    /** Sort direction of the active column — a second click on it reverses. */
    desc: boolean;
    selection: string[];
    query: string;
    back: string[][];
    fwd: string[][];
    /** A node to reveal (select + scroll to) after the next render. */
    reveal: string | null;
  };
  sheets: {
    open: string[];
    active: string | null;
  };
  view: {
    mode: ViewMode;
    zoom: number;
    pan: { x: number; y: number };
    /**
     * Layer visibility per sheet id — NOT one record shared by every tab.
     *
     * It used to be one map for the whole window: hide CONC while looking at
     * one drawing and every OTHER drawing lost its concrete outline too, even
     * one opened later that had never been touched — because a sheet's own
     * six ink-groups (the Layers menu, "Layers on this sheet") aren't a
     * property of the window, they're a property of the sheet. A sheet with
     * no entry here reads as `DEFAULT_LAYERS` (see `layersFor`), same as
     * `frames` reads as the fitted view.
     */
    layersBySheet: Record<string, Record<string, boolean>>;
    isolate: boolean;
    /**
     * Outline every section the read filed, on the sheet it was cut from.
     *
     * "97.5% covered" is a number about a drawing you are looking at, and it
     * cannot say WHICH 97.5%. The outlines put the read back on the geometry:
     * what was read, section by section, and by omission what was not.
     */
    sectionMarks: boolean;
    /** Section id under the pointer in the Details list — lit on the sheet. */
    hoverSection: string | null;
    /**
     * Section ids CHOSEN in the Details list. THREE STATES, because "I have not
     * chosen anything" and "I have chosen nothing" are different answers:
     *
     *   null  — resting. Every read area outlined; this is how a drawing opens.
     *   []    — deselected. NO area outlined: the plain drawing, nothing over
     *           it. "Deselect all" means take the colour off, not put it all
     *           back — collapsing this into `null` left the button doing the
     *           opposite of what it says.
     *   [ids] — those lit at full strength, the rest dimmed (never hidden, so
     *           the coverage picture survives looking at one part of it).
     *
     * Hovering could already light one, but a hover ends the moment you move
     * the mouse towards the drawing to look at what it lit. Answering "which
     * part of the sheet is REGION-03?" needs the answer to stay put.
     *
     * A LIST, not one id. "Which parts did the splitter miss?" is a question
     * about several areas at once — you tick REGION-03 and REGION-06 to see
     * whether they are the same table read twice — and singling them out one
     * at a time cannot answer it, because the comparison is the point.
     */
    pinnedSections: readonly string[] | null;
    /**
     * Bumped to ask the viewport to frame the drawing's INK.
     *
     * A one-shot, like `focus`, because only the viewport can answer it: the
     * store knows nothing about how much of the viewBox the drawing actually
     * fills, and on a sheet whose viewBox is two hundred times its ink — one
     * stray entity a long way from the content does it — that is the whole
     * question. `zoomFit` used to set zoom to 1, which frames the VIEWBOX and
     * leaves the drawing a speck in the middle of it.
     */
    fitRequest: number;
    /**
     * Framing per sheet id — zoom and pan are PER DRAWING, not per window.
     *
     * They used to be one pair shared by every tab: opening a second drawing
     * kept the first one's framing, and since every drawing sits at its own
     * coordinates that framing means nothing to the new sheet — it opened
     * scrolled off its own geometry and read as "the drawing did not load".
     * `{ zoom: 1, pan: 0,0 }` IS the fitted view (see `sheetView`), so a sheet
     * with no remembered frame opens framed.
     */
    frames: Record<string, { zoom: number; pan: { x: number; y: number } }>;
    unit: 'mm' | 'm' | 'ft-in';
    /** One-shot request: frame these mm bounds on this sheet, then clear. */
    focus: { sheetId: string; bounds: FocusBounds; nonce: number } | null;
  };
  select: {
    rows: string[];
    handles: string[];
    memberId: string | null;
    source: 'schedule' | 'canvas' | null;
  };
  /**
   * The slice the 2D drafting editor reads through `EditorHost.state()`
   * (src/studio/editorHost.ts). It lives here rather than inside the editor
   * because the shell owns state — src/editor imports no store at all.
   * NOTE the two things that are NOT here: the active tool (it is `ui`
   * state, shared with the strip) and the snap flags (model state, §14.3).
   */
  editor: {
    /** BIM level the tools draw on; null until a model is open */
    levelId: string | null;
    /** BIM element ids selected on the canvas — NOT the CAD handles in `select` */
    selectedIds: string[];
    /** the Library tab's armed catalogue item; arms Furniture, sizes openings */
    catalogId: string | null;
    /** wallThickness, doorWidth, textSize, activeLayer, … */
    toolOptions: Record<string, number | string | boolean>;
  };
  format: {
    columns: string[];
    derived: string[];
    group: ScheduleGroup;
  };
  history: {
    past: HistoryEntry[];
    future: HistoryEntry[];
  };
}

export const TREE_WIDTH = { min: 180, max: 460, initial: 268 };
export const DOCK_WIDTH = { min: 320, max: 720, initial: 400 };

export const DEFAULT_LAYERS: Record<string, boolean> = {
  CONC: true,
  RBAR: true,
  GRND: true,
  DIMS: true,
  TEXT: true,
  SHEET: true,
};

/** A sheet with no toggles of its own reads as fully visible — `frames`' own rule. */
export function layersFor(
  view: Pick<StudioState['view'], 'layersBySheet'>,
  sheetId: string | null,
): Record<string, boolean> {
  return (sheetId && view.layersBySheet[sheetId]) || DEFAULT_LAYERS;
}

const PERSIST_KEY = 'studio.ui.v1';

function persistedUi(): Partial<StudioState['ui']> {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as Partial<StudioState['ui']>;
    return {
      theme: p.theme === 'dark' ? 'dark' : 'light',
      treeWidth: clamp(Number(p.treeWidth) || TREE_WIDTH.initial, TREE_WIDTH.min, TREE_WIDTH.max),
      dockWidth: clamp(Number(p.dockWidth) || DOCK_WIDTH.initial, DOCK_WIDTH.min, DOCK_WIDTH.max),
      // DEFECT D4: the strip's own copy says drafting tools are hidden by
      // default "because this is not a drawing tool". The default now agrees —
      // absent or malformed persistence means COLLAPSED, not open.
      toolsOpen: p.toolsOpen === true,
    };
  } catch {
    return {};
  }
}

/**
 * Is the right-hand column showing?
 *
 * The dock has two open flags because it is two things. Browsing, it is the
 * properties pane and it belongs on screen the moment a file is picked. With a
 * drawing open it is the ASSISTANT — Details, Ask, Specification, Log — and it
 * used to slide in the instant a sheet opened, taking a third of the canvas
 * before it had been asked anything. It now waits for the Assistant button in
 * the title bar. One flag could not say both without the drawing page and the
 * browser fighting over it.
 */
export function dockIsOpen(ui: StudioState['ui']): boolean {
  return ui.stageMode === 'sheet' ? ui.assistantOpen : ui.dockOpen;
}

// --- the sheet strip's order ------------------------------------------------
//
// Files and the Specification are tabs like any other (§4.4), so they carry an
// id and sit in the same order the drawings do — a strip where two of the tabs
// cannot be dragged is a strip with two rules.

export const FILES_TAB = 'files';
export const SPEC_TAB = 'spec';

/**
 * The strip's order, reconciled: the two fixed tabs plus every open sheet,
 * honouring `ui.tabOrder` where it still applies.
 *
 * Closed sheets fall out, a newly opened sheet lands at the end, and a fixed
 * tab missing from the stored order goes back to the front — so a dragged
 * order survives opening and closing drawings without ever hiding one.
 */
export function tabOrderOf(state: Pick<StudioState, 'ui' | 'sheets'>): string[] {
  const known = new Set<string>([FILES_TAB, SPEC_TAB, ...state.sheets.open]);
  const out: string[] = [];
  state.ui.tabOrder.forEach((id) => {
    if (known.has(id) && !out.includes(id)) out.push(id);
  });
  if (!out.includes(FILES_TAB)) out.unshift(FILES_TAB);
  if (!out.includes(SPEC_TAB)) out.splice(out.indexOf(FILES_TAB) + 1, 0, SPEC_TAB);
  state.sheets.open.forEach((id) => {
    if (!out.includes(id)) out.push(id);
  });
  return out;
}

/**
 * Is the drawing already as small as the controls can make it? Both side
 * panels open and no window override — there is nothing left to give back.
 */
export function stageIsSmallest(ui: StudioState['ui']): boolean {
  return !ui.maximized && ui.treeOpen && dockIsOpen(ui);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// --- R2 boot persistence ----------------------------------------------------
// Written ONLY by explicit acts (opening/closing a project, browsing while a
// project is open) — never by the general persist() sweep, which fires on
// every patch and would clobber the last-project record during boot.

const BOOT_KEY = 'studio.boot.v1';

export interface BootRecord {
  lastProjectId: string | null;
  /** folder-id chain of the last folder browsed, per §2.3 */
  lastFolderPath: string[];
}

export function loadBoot(): BootRecord {
  try {
    const raw = localStorage.getItem(BOOT_KEY);
    if (!raw) return { lastProjectId: null, lastFolderPath: [] };
    const p = JSON.parse(raw) as Partial<BootRecord>;
    return {
      lastProjectId: typeof p.lastProjectId === 'string' ? p.lastProjectId : null,
      lastFolderPath: Array.isArray(p.lastFolderPath)
        ? p.lastFolderPath.filter((s): s is string => typeof s === 'string')
        : [],
    };
  } catch {
    return { lastProjectId: null, lastFolderPath: [] };
  }
}

export function saveBoot(record: BootRecord): void {
  try {
    localStorage.setItem(BOOT_KEY, JSON.stringify(record));
  } catch {
    /* storage unavailable — boot simply lands on the Projects home next time */
  }
}

// Folder expansion is per PROJECT (§1.4), not per user.
const EXPAND_PREFIX = 'studio.expand.';

export function loadFolderExpansion(projectId: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(`${EXPAND_PREFIX}${projectId}`);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function saveFolderExpansion(projectId: string, expanded: Record<string, boolean>): void {
  try {
    localStorage.setItem(`${EXPAND_PREFIX}${projectId}`, JSON.stringify(expanded));
  } catch {
    /* storage unavailable — expansion lives for the session only */
  }
}

export function initialState(overrides?: Partial<StudioState>): StudioState {
  return {
    project: { activeId: null, wantNew: false },
    ui: {
      theme: 'light',
      treeWidth: TREE_WIDTH.initial,
      dockWidth: DOCK_WIDTH.initial,
      treeOpen: true,
      dockOpen: true,
      // A drawing opens to the whole canvas. See `dockIsOpen`.
      assistantOpen: false,
      // D4 — collapsed by default; the strip keeps its handle, the active
      // tool name and the snap flags on screen (STUDIO_DESIGN §4.6).
      toolsOpen: false,
      // A view override, never persisted: booting into a chrome-less window
      // would hide the way back before the user had asked for it.
      maximized: false,
      tabOrder: [FILES_TAB, SPEC_TAB],
      artifactId: null,
      stageMode: 'sheet',
      dockTab: 'details',
      activeTool: 'pan',
      switcherOpen: false,
      paletteOpen: false,
      ...persistedUi(),
    },
    spec: { reveal: null },
    browse: {
      path: [],
      // Details is the file-manager reading of a folder: one row per item with
      // its revision, drawing number and discipline stated. Icons stay a click
      // away in the View menu.
      view: 'details',
      sort: 'name',
      desc: false,
      selection: [],
      query: '',
      back: [],
      fwd: [],
      reveal: null,
    },
    sheets: { open: [], active: null },
    view: {
      mode: '2d',
      zoom: 1,
      pan: { x: 0, y: 0 },
      layersBySheet: {},
      isolate: false,
      // On by default: a read you cannot see is a percentage, not a reading.
      sectionMarks: true,
      hoverSection: null,
      pinnedSections: null,
      fitRequest: 0,
      frames: {},
      unit: 'mm',
      focus: null,
    },
    select: { rows: [], handles: [], memberId: null, source: null },
    editor: { levelId: null, selectedIds: [], catalogId: null, toolOptions: {} },
    format: { columns: [], derived: [], group: 'member' },
    history: { past: [], future: [] },
    ...overrides,
  };
}

type Listener = () => void;

export class StudioStore {
  private state: StudioState;
  private listeners = new Set<Listener>();

  constructor(overrides?: Partial<StudioState>) {
    this.state = initialState(overrides);
  }

  getState = (): StudioState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Immutable patch: shallow-merges top-level slices given in the patch. */
  patch(patch: {
    [K in keyof StudioState]?: Partial<StudioState[K]>;
  }): void {
    const next = { ...this.state } as StudioState;
    (Object.keys(patch) as (keyof StudioState)[]).forEach((k) => {
      (next as unknown as Record<string, unknown>)[k] = {
        ...(this.state[k] as object),
        ...(patch[k] as object),
      };
    });
    this.state = next;
    this.persist();
    this.listeners.forEach((fn) => fn());
  }

  private persist(): void {
    try {
      const { theme, treeWidth, dockWidth, toolsOpen } = this.state.ui;
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ theme, treeWidth, dockWidth, toolsOpen }));
    } catch {
      /* storage unavailable — the session still works */
    }
  }

  // --- history: a real stack, each entry named ---------------------------

  record(label: string, undo: () => void, redo: () => void): void {
    const past = [...this.state.history.past, { label, undo, redo }].slice(-60);
    this.patch({ history: { past, future: [] } });
  }

  undo(): string | null {
    const past = [...this.state.history.past];
    const entry = past.pop();
    if (!entry) return null;
    entry.undo();
    this.patch({ history: { past, future: [...this.state.history.future, entry] } });
    return entry.label;
  }

  redo(): string | null {
    const future = [...this.state.history.future];
    const entry = future.pop();
    if (!entry) return null;
    entry.redo();
    this.patch({ history: { past: [...this.state.history.past, entry], future } });
    return entry.label;
  }

  // --- layout ------------------------------------------------------------

  setTheme(theme: 'light' | 'dark'): void {
    this.patch({ ui: { theme } });
  }

  toggleTree(): void {
    this.patch({ ui: { treeOpen: !this.state.ui.treeOpen } });
  }

  toggleDock(): void {
    const ui = this.state.ui;
    this.patch({
      ui:
        ui.stageMode === 'sheet'
          ? { assistantOpen: !ui.assistantOpen }
          : { dockOpen: !ui.dockOpen },
    });
  }

  toggleTools(): void {
    this.patch({ ui: { toolsOpen: !this.state.ui.toolsOpen } });
  }

  /**
   * Grow the drawing one step — the two controls in its bottom-right corner.
   *
   * There are three sizes, not two: the side panels go first, then the window
   * chrome. One jump straight to a chrome-less window would throw away the
   * register AND the title bar for a user who only wanted the canvas wider,
   * and the step back would not know which of the two to return.
   */
  maximizeStage(): void {
    const ui = this.state.ui;
    if (ui.maximized) return;
    this.patch({
      ui:
        ui.treeOpen || dockIsOpen(ui)
          ? { treeOpen: false, assistantOpen: false, dockOpen: false }
          : { maximized: true },
    });
  }

  /** Shrink it one step: the window chrome comes back, then the side panels. */
  minimizeStage(): void {
    const ui = this.state.ui;
    if (ui.maximized) {
      this.patch({ ui: { maximized: false } });
      return;
    }
    this.patch({
      ui:
        ui.stageMode === 'sheet'
          ? { treeOpen: true, assistantOpen: true }
          : { treeOpen: true, dockOpen: true },
    });
  }

  /**
   * Drag one tab in front of or behind another (§4.4).
   *
   * `sheets.open` is rewritten to follow the strip, so what the eye reads and
   * what "close the others" and the next-active pick walk are ONE list. Two
   * orders for the same tabs is the drift that makes closing a tab activate a
   * drawing on the other side of the strip.
   */
  moveTab(dragId: string, targetId: string, after: boolean): void {
    if (dragId === targetId) return;
    const order = tabOrderOf(this.state);
    if (!order.includes(dragId) || !order.includes(targetId)) return;
    const rest = order.filter((id) => id !== dragId);
    rest.splice(rest.indexOf(targetId) + (after ? 1 : 0), 0, dragId);
    const open = new Set(this.state.sheets.open);
    this.patch({
      ui: { tabOrder: rest },
      sheets: { open: rest.filter((id) => open.has(id)) },
    });
  }

  setTreeWidth(px: number): void {
    this.patch({ ui: { treeWidth: clamp(Math.round(px), TREE_WIDTH.min, TREE_WIDTH.max) } });
  }

  setDockWidth(px: number): void {
    this.patch({ ui: { dockWidth: clamp(Math.round(px), DOCK_WIDTH.min, DOCK_WIDTH.max) } });
  }

  /** Asking for a tab is asking for the panel — whichever one this face has. */
  setDockTab(tab: DockTab): void {
    // Leaving the schedule drops the pin: a version is pinned to be READ, and
    // coming back later should show what is current, not what was open once.
    const artifactId = tab === 'bbs' ? this.state.ui.artifactId : null;
    this.patch({
      ui:
        this.state.ui.stageMode === 'sheet'
          ? { dockTab: tab, artifactId, assistantOpen: true }
          : { dockTab: tab, artifactId, dockOpen: true },
    });
  }

  /**
   * Open one FILED output — a versioned BBS from Outputs → BBS.
   *
   * `null` unpins and returns the panel to what is current. Everything else
   * about the panel is unchanged: it resolves the pinned artifact through the
   * same path the live run uses, so one grid renders both.
   */
  openArtifact(id: string | null): void {
    this.patch({ ui: { artifactId: id } });
    // Opening navigates; UNPINNING does not. A new run clears the pin so the
    // finished schedule is the one on screen, and that must not also drag the
    // dock away from the thread the person is reading.
    if (id) this.setDockTab('bbs');
  }

  setStageMode(mode: StageMode): void {
    // Maximizing belongs to the DRAWING. Its way back is the pair of controls
    // in the viewport's corner, and Files and the Specification do not render
    // a viewport — leaving the override on would strand a chrome-less window
    // with nothing left to click.
    this.patch({ ui: { stageMode: mode, maximized: mode === 'sheet' && this.state.ui.maximized } });
  }

  // --- projects (R1/R2) ---------------------------------------------------

  /**
   * Open a project: Files view at `folderPath` (default: root), nothing on the
   * canvas, no sheets restored (§2.3). Clears everything sheet-scoped from the
   * previous project so nothing can leak across.
   */
  openProject(projectId: string, folderPath: string[] = []): void {
    this.patch({
      project: { activeId: projectId, wantNew: false },
      ui: {
        stageMode: 'files',
        switcherOpen: false,
        paletteOpen: false,
        maximized: false,
        tabOrder: [FILES_TAB, SPEC_TAB],
      },
      browse: { path: folderPath, selection: [], query: '', back: [], fwd: [], reveal: null },
      sheets: { open: [], active: null },
      select: { rows: [], handles: [], memberId: null, source: null },
      editor: { levelId: null, selectedIds: [], catalogId: null, toolOptions: {} },
      view: { focus: null, zoom: 1, pan: { x: 0, y: 0 }, isolate: false },
      spec: { reveal: null },
      history: { past: [], future: [] },
    });
    saveBoot({ lastProjectId: projectId, lastFolderPath: folderPath });
  }

  /** Back to the Projects home. `wantNew` opens it on the new-project form. */
  closeProject(wantNew = false): void {
    this.patch({
      project: { activeId: null, wantNew },
      sheets: { open: [], active: null },
      select: { rows: [], handles: [], memberId: null, source: null },
      editor: { levelId: null, selectedIds: [], catalogId: null, toolOptions: {} },
      view: { focus: null },
      spec: { reveal: null },
      // The Projects home is not a drawing — a chrome-less window there
      // would have no way back at all.
      ui: { switcherOpen: false, paletteOpen: false, maximized: false, tabOrder: [FILES_TAB, SPEC_TAB] },
    });
    saveBoot({ lastProjectId: null, lastFolderPath: [] });
  }

  clearWantNew(): void {
    if (this.state.project.wantNew) this.patch({ project: { wantNew: false } });
  }

  setSwitcherOpen(open: boolean): void {
    if (this.state.ui.switcherOpen !== open) this.patch({ ui: { switcherOpen: open } });
  }

  // --- command palette (R6) -----------------------------------------------

  setPaletteOpen(open: boolean): void {
    if (this.state.ui.paletteOpen !== open) this.patch({ ui: { paletteOpen: open } });
  }

  // --- Specification view (R4/R6 §6.4: a fact result is a location) --------

  /** Open the Specification stage scrolled to (and expanded on) one fact. */
  revealFact(factId: string | null): void {
    this.patch({
      ui: { stageMode: 'spec' },
      spec: { reveal: factId },
    });
  }

  clearFactReveal(): void {
    if (this.state.spec.reveal !== null) this.patch({ spec: { reveal: null } });
  }

  // --- viewport focus (R3 "Show on the sheet") ----------------------------

  focusOn(sheetId: string, bounds: FocusBounds): void {
    const nonce = (this.state.view.focus?.nonce ?? 0) + 1;
    this.openSheet(sheetId);
    this.patch({ view: { focus: { sheetId, bounds, nonce } } });
  }

  clearFocus(): void {
    if (this.state.view.focus !== null) this.patch({ view: { focus: null } });
  }

  setActiveTool(tool: string): void {
    if (this.state.ui.activeTool !== tool) this.patch({ ui: { activeTool: tool } });
  }

  // --- the editor slice (read by EditorHost.state(), never cached) ---------

  /** BIM element selection on the canvas. Emptying it also drops the shared
   *  schedule/underlay highlight — one Escape clears every highlight (§10). */
  setEditorSelection(ids: string[]): void {
    const same =
      ids.length === this.state.editor.selectedIds.length &&
      ids.every((id, i) => this.state.editor.selectedIds[i] === id);
    if (same) return;
    this.patch({ editor: { selectedIds: ids } });
    if (!ids.length && (this.state.select.rows.length || this.state.select.handles.length)) {
      this.clearSelection();
    }
  }

  setEditorLevel(levelId: string | null): void {
    if (this.state.editor.levelId !== levelId) this.patch({ editor: { levelId } });
  }

  setCatalogItem(catalogId: string | null): void {
    if (this.state.editor.catalogId !== catalogId) this.patch({ editor: { catalogId } });
  }

  setToolOption(key: string, value: number | string | boolean): void {
    if (this.state.editor.toolOptions[key] === value) return;
    this.patch({ editor: { toolOptions: { ...this.state.editor.toolOptions, [key]: value } } });
  }

  // --- sheets ------------------------------------------------------------

  openSheet(id: string): void {
    const open = this.state.sheets.open.includes(id)
      ? this.state.sheets.open
      : [...this.state.sheets.open, id];
    const { active } = this.state.sheets;
    if (active === id) {
      this.patch({
        sheets: { open, active: id },
        ui: { stageMode: 'sheet' },
        view: { isolate: false },
      });
      return;
    }
    // Leaving a sheet keeps its framing; arriving at one takes its own, or the
    // fit if it has none. Never the framing of the drawing you just left.
    const v = this.state.view;
    const frames = active
      ? { ...v.frames, [active]: { zoom: v.zoom, pan: v.pan } }
      : { ...v.frames };
    const frame = frames[id] ?? { zoom: 1, pan: { x: 0, y: 0 } };
    this.patch({
      sheets: { open, active: id },
      ui: { stageMode: 'sheet' },
      view: { isolate: false, frames, zoom: frame.zoom, pan: frame.pan },
    });
  }

  closeSheet(id: string, sheetName?: string): void {
    const at = this.state.sheets.open.indexOf(id);
    if (at < 0) return;
    const open = this.state.sheets.open.filter((s) => s !== id);
    const wasActive = this.state.sheets.active === id;
    const active = wasActive ? open[Math.max(0, at - 1)] ?? null : this.state.sheets.active;
    const v = this.state.view;
    const frames = { ...v.frames };
    delete frames[id];
    if (wasActive) {
      const frame = (active && frames[active]) || { zoom: 1, pan: { x: 0, y: 0 } };
      this.patch({
        sheets: { open, active },
        view: { frames, zoom: frame.zoom, pan: frame.pan },
      });
    } else {
      this.patch({ sheets: { open, active }, view: { frames } });
    }
    this.record(
      `closing ${sheetName ?? id}`,
      () => {
        const reopened = [...this.state.sheets.open];
        reopened.splice(Math.min(at, reopened.length), 0, id);
        this.patch({ sheets: { open: reopened, active: id }, ui: { stageMode: 'sheet' } });
      },
      () => this.closeSheetSilently(id),
    );
  }

  private closeSheetSilently(id: string): void {
    const at = this.state.sheets.open.indexOf(id);
    if (at < 0) return;
    const open = this.state.sheets.open.filter((s) => s !== id);
    const active =
      this.state.sheets.active === id ? open[Math.max(0, at - 1)] ?? null : this.state.sheets.active;
    this.patch({ sheets: { open, active } });
  }

  // --- viewport ----------------------------------------------------------

  setZoomPan(zoom: number, pan: { x: number; y: number }): void {
    this.patch({ view: { zoom, pan } });
  }

  /** Frame the drawing's ink — see `fitRequest`. */
  zoomFit(): void {
    this.patch({ view: { fitRequest: this.state.view.fitRequest + 1 } });
  }

  setSectionMarks(on: boolean): void {
    this.patch({
      view: { sectionMarks: on, hoverSection: on ? this.state.view.hoverSection : null },
    });
  }

  /** Light one section on the sheet — hovering its row in the Details list. */
  setHoverSection(sectionId: string | null): void {
    if (this.state.view.hoverSection === sectionId) return;
    this.patch({ view: { hoverSection: sectionId } });
  }

  /**
   * Single ONE section out: it stays lit and every other mark dims, so the
   * answer to "which part of the sheet is this?" survives moving the mouse
   * over to look at it. Choosing the same one again — or passing null — goes
   * back to outlining them all. This REPLACES the selection; `toggleSection`
   * extends it.
   */
  pinSection(sectionId: string | null): void {
    const now = this.state.view.pinnedSections;
    const alone = now?.length === 1 && now[0] === sectionId;
    this.patch({ view: { pinnedSections: sectionId === null || alone ? null : [sectionId] } });
  }

  /**
   * Add or remove one section, KEEPING the rest — the checkbox on each row.
   *
   * From the resting state this starts a selection of one rather than ticking
   * everything else on: you tick a box to say "this one", not to say "all but
   * the eight I am about to untick". Order is preserved as chosen rather than
   * sorted, so the list reads back the way it was built up.
   */
  toggleSection(sectionId: string): void {
    const now = this.state.view.pinnedSections;
    if (!now) {
      this.patch({ view: { pinnedSections: [sectionId] } });
      return;
    }
    const next = now.includes(sectionId) ? now.filter((id) => id !== sectionId) : [...now, sectionId];
    this.patch({ view: { pinnedSections: next } });
  }

  /**
   * Deselect everything: the plain drawing, no colour over it.
   *
   * NOT the same as `showAllSections`. Reading the geometry underneath is a
   * real thing to want — the outlines sit on top of the very lines you are
   * checking them against — and it is what "deselect" says on the button.
   */
  clearSections(): void {
    const now = this.state.view.pinnedSections;
    if (now && now.length === 0) return;
    this.patch({ view: { pinnedSections: [] } });
  }

  /** Back to outlining every read area — the state a drawing opens in. */
  showAllSections(): void {
    if (this.state.view.pinnedSections === null) return;
    this.patch({ view: { pinnedSections: null } });
  }

  /** Toggles a layer on the ACTIVE sheet only — see `layersBySheet`. */
  setLayer(id: string, on: boolean, layerName?: string): void {
    const sheetId = this.state.sheets.active;
    if (!sheetId) return;
    const current = layersFor(this.state.view, sheetId);
    const was = current[id];
    if (was === on) return;
    const write = (value: boolean) =>
      this.patch({
        view: {
          layersBySheet: {
            ...this.state.view.layersBySheet,
            [sheetId]: { ...layersFor(this.state.view, sheetId), [id]: value },
          },
        },
      });
    write(on);
    const name = layerName ?? id;
    this.record(
      `${on ? 'showing' : 'hiding'} ${name}`,
      () => write(was),
      () => write(on),
    );
  }

  setIsolate(on: boolean): void {
    this.patch({ view: { isolate: on } });
  }

  setUnit(unit: StudioState['view']['unit']): void {
    const was = this.state.view.unit;
    if (was === unit) return;
    this.patch({ view: { unit } });
    this.record(
      'the unit change',
      () => this.patch({ view: { unit: was } }),
      () => this.patch({ view: { unit } }),
    );
  }

  setViewMode(mode: ViewMode): void {
    this.patch({ view: { mode } });
  }

  // --- browsing ----------------------------------------------------------

  browseTo(path: string[], push = true): void {
    this.patch({
      browse: {
        path,
        selection: [],
        back: push ? [...this.state.browse.back, this.state.browse.path] : this.state.browse.back,
        fwd: push ? [] : this.state.browse.fwd,
      },
      ui: { stageMode: 'files' },
    });
    // R2 — remember the folder, so boot lands back here.
    const projectId = this.state.project.activeId;
    if (projectId) saveBoot({ lastProjectId: projectId, lastFolderPath: path });
  }

  browseBack(): void {
    const back = [...this.state.browse.back];
    const prev = back.pop();
    if (!prev) return;
    this.patch({
      browse: { back, fwd: [...this.state.browse.fwd, this.state.browse.path], path: prev, selection: [] },
    });
  }

  browseForward(): void {
    const fwd = [...this.state.browse.fwd];
    const next = fwd.pop();
    if (!next) return;
    this.patch({
      browse: { fwd, back: [...this.state.browse.back, this.state.browse.path], path: next, selection: [] },
    });
  }

  browseUp(): void {
    if (!this.state.browse.path.length) return;
    this.browseTo(this.state.browse.path.slice(0, -1));
  }

  setBrowseView(view: BrowseView): void {
    this.patch({ browse: { view } });
  }

  /** Clicking the sorted column again reverses it; a new column sorts ascending. */
  setBrowseSort(sort: BrowseSort, desc?: boolean): void {
    const next = desc ?? (this.state.browse.sort === sort ? !this.state.browse.desc : false);
    this.patch({ browse: { sort, desc: next } });
  }

  setBrowseQuery(query: string): void {
    this.patch({ browse: { query, selection: [] } });
  }

  setBrowseSelection(selection: string[]): void {
    this.patch({ browse: { selection } });
  }

  /** Points the browser at the folder holding `nodeId` and marks it to reveal. */
  revealInBrowser(folderPath: string[], nodeId: string | null): void {
    this.patch({ browse: { path: folderPath, reveal: nodeId, selection: nodeId ? [nodeId] : [] } });
  }

  clearReveal(): void {
    if (this.state.browse.reveal !== null) this.patch({ browse: { reveal: null } });
  }

  // --- the one shared selection ------------------------------------------

  setSelection(sel: Partial<StudioState['select']> & { source: 'schedule' | 'canvas' }): void {
    this.patch({
      select: { rows: [], handles: [], memberId: null, ...sel },
    });
  }

  clearSelection(): void {
    this.patch({ select: { rows: [], handles: [], memberId: null, source: null } });
  }

  // --- schedule format ---------------------------------------------------

  setFormat(columns: string[], derived: string[]): void {
    this.patch({ format: { columns, derived } });
  }

  setScheduleGroup(group: ScheduleGroup): void {
    this.patch({ format: { group } });
  }
}

// --- React binding ---------------------------------------------------------

export const StudioStoreContext = createContext<StudioStore | null>(null);

export function useStudioStore(): StudioStore {
  const store = useContext(StudioStoreContext);
  if (!store) throw new Error('useStudioStore must be used inside <StudioStoreContext.Provider>');
  return store;
}

export function useStudio<T = StudioState>(selector?: (s: StudioState) => T): T {
  const store = useStudioStore();
  const sel = selector ?? ((s: StudioState) => s as unknown as T);
  const cache = useRef<{ state: StudioState; value: T } | null>(null);
  const getSnapshot = () => {
    const s = store.getState();
    if (!cache.current || cache.current.state !== s) {
      cache.current = { state: s, value: sel(s) };
    }
    return cache.current.value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

// --- cursor bus ------------------------------------------------------------
// The coordinate readout updates on every pointer move; pushing that through
// the store would re-render the whole shell per pixel. A tiny side-channel
// keeps it in the status bar alone.

export interface CursorReading {
  xMm: number;
  yMm: number;
}

type CursorListener = () => void;

class CursorBus {
  private reading: CursorReading | null = null;
  private listeners = new Set<CursorListener>();

  get = (): CursorReading | null => this.reading;

  set(reading: CursorReading | null): void {
    this.reading = reading;
    this.listeners.forEach((fn) => fn());
  }

  subscribe = (fn: CursorListener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

export const cursorBus = new CursorBus();

export function useCursor(): CursorReading | null {
  return useSyncExternalStore(cursorBus.subscribe, cursorBus.get, cursorBus.get);
}

export function formatLength(mm: number, unit: StudioState['view']['unit']): string {
  if (unit === 'm') return `${(mm / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 })} m`;
  if (unit === 'ft-in') {
    const inches = mm / 25.4;
    const ft = Math.floor(inches / 12);
    const rem = Math.round(inches - ft * 12);
    return `${ft}'-${rem}"`;
  }
  return `${Math.round(mm).toLocaleString('en-IN')} mm`;
}
