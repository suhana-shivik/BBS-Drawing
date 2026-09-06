// EditorController — owns the canvas, view transform, tool state machine and
// all pointer/keyboard interaction for the 2D plan editor. Rendering is
// delegated to render.ts; all model mutations go through runCommand.
//
// Ported from SOURCE src/editor/controller.ts. Two structural changes, both
// required by EDITOR_TOOLS_NOTE §13/§14 and CONTRACT.md's editor addendum:
//
//  1. NO STORE IMPORT. Shell state, commands, undo/redo and the catalogue all
//     arrive through an injected `EditorHost` (host.ts), and the hint line +
//     cursor are PUBLISHED to subscribers instead of pushed into an app store.
//  2. ONE KEYBOARD OWNER. This controller owns the tool letters as well as the
//     editing keys, and calls `stopImmediatePropagation()` on everything it
//     consumes — which is the single fix for defects D1 and D2. Defect D5 is
//     fixed alongside it: `Del` deletes, `Backspace` belongs to the precision
//     buffer and never touches geometry.
import type {
  AnyElement,
  BeamElement,
  ColumnElement,
  DimensionElement,
  DoorElement,
  FurnitureElement,
  RefLineElement,
  RoomElement,
  SlabElement,
  StairElement,
  TextElement,
  Vec2,
  WallElement,
  WindowElement,
} from '../core/types';
import { DEFAULTS, newId } from '../core/types';
import type { BIMModel } from '../core/model';
import { TOOL_KEYS, type ToolId } from './tools';
import { activeLayerOf, optNumber, type ToolOptionKey } from './toolOptions';
import type {
  CatalogItem,
  EditorAppState,
  EditorHost,
  EditorStatus,
  StatusListener,
  ViewListener,
} from './host';
import {
  cmdAddElements,
  cmdDeleteElements,
  cmdUpdateElement,
  cmdUpdateMany,
} from '../core/commands';
import {
  add,
  angleOf,
  clamp,
  closestPointOnSegment,
  cross,
  dist,
  dot,
  len,
  mul,
  norm,
  perp,
  snapTo,
  sub,
  wallDir,
  wallLength,
} from '../core/geometry';
import { formatLength } from '../core/format';
import { detectRoomBoundary } from '../analysis/rooms';
import { computeSnap, type SnapResult } from './snap';
import { elementsInRect, hitTest, levelBounds } from './hit';
import { drawScene, type EditorColors, type Scene, type XformOverlay } from './render';
import { fitView, panBy, toModel, toScreen, zoomAt, type View } from './view';
import {
  cadBounds,
  clearCadSelection,
  getCadSession,
  setCadSelection,
  toggleCadSelection,
} from '../cad/session';
import { hitTestDisplayList } from '../cad/render/hitTest';
import { handlesBounds, handlesInRect, visibleHandles } from '../cad/render/select';
import { cadEntityByHandle, cadHoverHint } from './cadPick';
import {
  buildGeometryCommand,
  duplicateElements,
  meaningfulDelta,
  movePatchFor,
  wallEndpointEntries,
} from './edits';
import { arcThroughPoints, circlePoints, rectOutline, squareCorner } from './primitives';
import { textGripPoint } from './shapes';
import { parseNumberInput, parsePrecisionInput } from './precision';
import {
  MAX_TEXT_SIZE,
  MIN_SCALE_FACTOR,
  MIN_TEXT_SIZE,
  mirrorXform,
  rotateXform,
  scaleXform,
  transformEntries,
  type TransformTool,
  type Xform,
} from './transform';


/**
 * Add-to-selection modifier. CAD applications use Shift; Windows file managers
 * and most web UIs use Ctrl (Cmd on macOS), and users reach for whichever they
 * know. Accept all three rather than making people guess.
 */
function isAdditive(e: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): boolean {
  return Boolean(e.shiftKey || e.ctrlKey || e.metaKey);
}

type DimAnchor = { elementId: string; end: 'start' | 'end' };

type Op =
  | { kind: 'none' }
  | {
      kind: 'maybeMove';
      startScreen: Vec2;
      startModel: Vec2;
      clickedId: string;
      wasSelected: boolean;
    }
  | { kind: 'move'; startModel: Vec2; ids: string[] }
  | { kind: 'grip'; wallId: string; which: 'start' | 'end' }
  | {
      /** dragging the corner grip of a single selected text element */
      kind: 'textGrip';
      id: string;
      /** the text's anchor point — the fixed end of the drag */
      anchor: Vec2;
      startSize: number;
      /** anchor-to-grip distance when the drag started; the divisor of the factor */
      startDist: number;
    }
  | {
      /** scale / rotate / mirror gesture over a frozen copy of the selection */
      kind: 'xform';
      tool: TransformTool;
      /** base point (scale/rotate) or first axis point (mirror) */
      base: Vec2;
      /** scale only: reference distance from click 2; null until it is picked */
      refDist: number | null;
      ids: string[];
    }
  | { kind: 'marquee'; startScreen: Vec2; curScreen: Vec2; additive: boolean }
  | { kind: 'chain'; last: Vec2 }
  | { kind: 'polyChain'; points: Vec2[] }
  | { kind: 'arcPts'; pts: Vec2[] }
  | {
      kind: 'two';
      tool: 'beam' | 'slab' | 'measure' | 'line' | 'rectangle' | 'circle';
      a: Vec2;
    }
  | { kind: 'dimA'; a: Vec2; anchorA: DimAnchor | null }
  | { kind: 'dimOffset'; a: Vec2; b: Vec2; anchors: DimAnchor[] }
  | { kind: 'measureDone'; a: Vec2; b: Vec2 };

interface HoverWall {
  id: string;
  offset: number;
  flip: boolean;
  valid: boolean;
  width: number;
  height: number;
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/** Shift-snap increments for the transform tools */
const SCALE_FACTOR_STEP = 0.25;
const ROTATE_ANGLE_STEP = Math.PI / 12; // 15°
const MIRROR_AXIS_STEP = Math.PI / 4; // 45°, i.e. axes at 0/45/90/135

// characters that may START a typed coordinate (need at least a digit/./-/@)
const PRECISION_START = /^[0-9.@-]$/;
// characters that may CONTINUE one (adds ',' for dx,dy and 'a' for the angle infix)
const PRECISION_CONTINUE = /^[0-9.,@a-]$/i;

/** pick aperture in screen px, shared by BIM and CAD picking */
const PICK_PX = 6;

/**
 * The controller currently driving the canvas, for UI that has no ref to it
 * (the CAD selection panel calling `zoomToCadSelection`, say). There is only
 * ever one 2D editor mounted; `Editor2D` creates and disposes it.
 */
let active: EditorController | null = null;

export function activeEditor(): EditorController | null {
  return active;
}

/**
 * Construction options — the whole integration seam for the shell, in one
 * object. Everything is optional: `new EditorController(canvas, host)` behaves
 * exactly like SOURCE did.
 */
export interface EditorOptions {
  /**
   * integration seam: the initial view transform. The new shell's viewport owns
   * pan/zoom, so it can hand its own View in here and keep it in step with
   * `setView()` / `onViewChanged`. Omit and the editor fits content itself.
   */
  view?: View;
  /**
   * integration seam: false when the HOST owns pan and zoom — the controller
   * then ignores the wheel, the middle button, space-pan and the Pan tool, and
   * never changes the view on its own. Default true (SOURCE behaviour).
   */
  ownsViewGestures?: boolean;
  /** integration seam: called whenever the controller changes the view itself */
  onViewChanged?: ViewListener;
  /** integration seam: hint + cursor for the status bar (§11) */
  onStatus?: StatusListener;
  /**
   * integration seam: false to leave the window keydown/keyup listeners
   * unregistered — for a host that already forwards key events via
   * `handleKeyDown()`. Default true, and the controller is then the ONE
   * keyboard owner (D1/D2).
   */
  ownsKeyboard?: boolean;
  /**
   * integration seam: false to listen in the bubble phase instead of the
   * capture phase. Capture is the default and is what makes the single-owner
   * guarantee independent of who registered first.
   */
  keyboardCapture?: boolean;
}

export class EditorController {
  private canvas: HTMLCanvasElement;
  private host: EditorHost;
  private opts: EditorOptions;
  private statusListeners = new Set<StatusListener>();
  /** last published status, replayed to a late subscriber */
  private lastStatus: EditorStatus = { cursor: null, hint: '' };
  private precisionEl: HTMLDivElement;
  private view: View = { scale: 0.04, tx: 0, ty: 0 };
  private cssW = 0;
  private cssH = 0;
  private raf = 0;
  private didFit = false;
  private disposed = false;
  private ro: ResizeObserver | null = null;

  private op: Op = { kind: 'none' };
  private panning: { last: Vec2; button: number } | null = null;
  private spaceHeld = false;
  private shiftHeld = false;

  private cursorScreen: Vec2 | null = null;
  private cursorRaw: Vec2 | null = null;
  private effPt: Vec2 | null = null;
  private snap: SnapResult | null = null;
  private hoverWall: HoverWall | null = null;
  private ghostRotation = 0;

  /** handle of the CAD underlay entity under the cursor, or null */
  private cadHover: string | null = null;
  /** status line for `cadHover`, recomputed only when the handle changes */
  private cadHoverHint = '';
  /** cursor point whose CAD hover pick is still owed; null = nothing pending */
  private cadHoverPt: Vec2 | null = null;
  /** true while draw() is running, so hover resolution cannot re-enter it */
  private drawing = false;

  /** typed-coordinate buffer; null = not currently typing a coordinate */
  private pendingBuffer: string | null = null;

  private colors: EditorColors;

  constructor(canvas: HTMLCanvasElement, host: EditorHost, options: EditorOptions = {}) {
    this.canvas = canvas;
    this.host = host;
    this.opts = options;
    if (options.onStatus) this.statusListeners.add(options.onStatus);
    if (options.view) {
      this.view = { ...options.view };
      this.didFit = true; // the host framed it; do not steal the framing back
    }
    const css = getComputedStyle(document.documentElement);
    const cvar = (name: string, fb: string): string => {
      const v = css.getPropertyValue(name).trim();
      return v || fb;
    };
    this.colors = {
      bg: cvar('--bg-canvas', '#1d1f24'),
      selection: cvar('--selection', '#ffb648'),
      accent: cvar('--accent', '#4f8cff'),
      snap: cvar('--ok', '#4fbf67'),
      text: cvar('--canvas-text', '#e6e7ea'),
      textDim: cvar('--canvas-text-dim', '#9a9da6'),
      gridMinor: cvar('--grid-minor', 'rgba(255,255,255,0.045)'),
      gridMajor: cvar('--grid-major', 'rgba(255,255,255,0.095)'),
      // Chrome drawn ON the sheet, which is #101216 under BOTH themes, so it
      // must NOT borrow the UI panel tokens: --floating goes near-white in the
      // light theme and painted --canvas-text (also near-white, correctly) on
      // top of itself — the measurement pill was invisible.
      floating: cvar('--canvas-floating', 'rgba(16,18,22,0.9)'),
      border: cvar('--canvas-floating-border', 'rgba(230,231,234,0.34)'),
    };

    this.precisionEl = document.createElement('div');
    this.precisionEl.className = 'editor2d-precision';
    (canvas.parentElement ?? document.body).appendChild(this.precisionEl);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    // Middle-drag pans, as it does in AutoCAD. `onPointerDown` already handles
    // button 1, but preventing default THERE does not stop Chrome and Edge on
    // Windows from starting their autoscroll ring: that behaviour is bound to
    // `mousedown`, which fires separately and must be cancelled on its own.
    // Without these two lines the pan begins and is then hijacked mid-drag.
    canvas.addEventListener('mousedown', this.onMouseDownSuppress);
    canvas.addEventListener('auxclick', this.onAuxClick);
    canvas.addEventListener('dblclick', this.onDblClick);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    // DEFECT D1/D2 fix: this is the ONLY keydown listener in the editor, and
    // it listens in the CAPTURE phase at the window — the first position in
    // the whole propagation path. Registration order then cannot decide who
    // wins: a stray listener left on `document` (the shell had one) fires
    // during bubbling, long after this one has consumed the key. The tool
    // strip must render TOOL_KEYS rather than register its own.
    if (options.ownsKeyboard !== false) {
      window.addEventListener('keydown', this.onKeyDown, this.keyCapture());
      window.addEventListener('keyup', this.onKeyUp, this.keyCapture());
    }

    this.ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => this.scheduleDraw());
    this.ro?.observe(canvas);
    active = this;
    this.updateCursor();
    this.pushStatus();
    this.scheduleDraw();
  }

  dispose(): void {
    this.disposed = true;
    if (active === this) active = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('mousedown', this.onMouseDownSuppress);
    this.canvas.removeEventListener('auxclick', this.onAuxClick);
    this.canvas.removeEventListener('dblclick', this.onDblClick);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown, this.keyCapture());
    window.removeEventListener('keyup', this.onKeyUp, this.keyCapture());
    this.ro?.disconnect();
    this.ro = null;
    this.precisionEl.remove();
    this.statusListeners.clear();
  }

  // ---------------- the host seam ----------------
  //
  // Every read of shell state and every write to the model funnels through
  // these five, so `src/editor` imports no store at all.

  private st(): EditorAppState {
    return this.host.state();
  }

  private maybeModel(): BIMModel | null {
    return this.host.model();
  }

  /** the model, for paths that already established there is one */
  private getModel(): BIMModel {
    const m = this.host.model();
    if (!m) throw new Error('EditorController: no model open');
    return m;
  }

  private catalogItem(id: string | null): CatalogItem | undefined {
    return id ? this.host.catalogItem?.(id) : undefined;
  }

  /**
   * §11 — the hint line is written HERE and nowhere else, per tool and per
   * phase. SOURCE pushed it into the app store; it is published instead, so
   * the shell's status bar subscribes and the editor stays store-free.
   */
  private emitStatus(patch: Partial<EditorStatus>): void {
    this.lastStatus = { ...this.lastStatus, ...patch };
    for (const fn of [...this.statusListeners]) fn(this.lastStatus);
  }

  /**
   * integration seam: subscribe to hint + cursor. The current value is
   * delivered immediately, so a status bar mounting late is never blank.
   * Returns an unsubscribe.
   */
  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    fn(this.lastStatus);
    return () => {
      this.statusListeners.delete(fn);
    };
  }

  /** the hint the status bar would show right now, for a host that polls */
  status(): EditorStatus {
    return this.lastStatus;
  }

  // ---------------- the view seam ----------------

  /** integration seam: the current mm↔px transform */
  getView(): View {
    return this.view;
  }

  /**
   * integration seam: adopt a view owned by the host's viewport. Marks the
   * fit as done — the host framed it, and re-fitting would fight the host.
   */
  setView(v: View): void {
    this.view = { ...v };
    this.didFit = true;
    if (this.cursorScreen && !this.panning) this.updateHover(this.cursorScreen);
    this.pushStatus();
    this.scheduleDraw();
  }

  /** notify the host that the controller moved the view itself */
  private viewChanged(): void {
    this.opts.onViewChanged?.(this.view);
  }

  private ownsViewGestures(): boolean {
    return this.opts.ownsViewGestures !== false;
  }

  /** capture phase, so this handler is first in the propagation path (D1/D2) */
  private keyCapture(): boolean {
    return this.opts.keyboardCapture !== false;
  }

  // ---------------- lifecycle hooks from the React component ----------------

  onToolChanged(): void {
    this.op = { kind: 'none' };
    this.hoverWall = null;
    this.ghostRotation = 0;
    this.pendingBuffer = null;
    this.cadHoverPt = null;
    this.setCadHover(null);
    this.updateCursor();
    this.pushStatus();
    this.scheduleDraw();
  }

  onLevelChanged(): void {
    this.op = { kind: 'none' };
    this.hoverWall = null;
    this.pendingBuffer = null;
    this.pushStatus();
    this.scheduleDraw();
  }

  scheduleDraw(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(this.draw);
  }

  // ---------------- drawing ----------------

  private draw = (): void => {
    this.raf = 0;
    if (this.disposed) return;
    const model = this.maybeModel();
    if (!model) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (cw < 2 || ch < 2) return;
    this.cssW = cw;
    this.cssH = ch;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(cw * dpr);
    const ph = Math.round(ch * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    if (!this.didFit) {
      this.fitToContent(model);
      this.didFit = true;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawing = true;
    try {
      // one CAD hover pick per painted frame, whatever the pointer rate
      this.resolveCadHover();
      drawScene(ctx, this.buildScene(model));
    } finally {
      this.drawing = false;
    }
  };

  private fitToContent(model: BIMModel): void {
    const st = this.st();
    const b = levelBounds(model, st.activeLevelId);
    // An imported drawing carries its own coordinates, often far from the
    // origin, and is not part of the BIM element set — so it has to be
    // folded into the fit or the canvas opens on empty space.
    const cad = cadBounds();
    const merged =
      b && cad
        ? {
            min: { x: Math.min(b.min.x, cad.min.x), y: Math.min(b.min.y, cad.min.y) },
            max: { x: Math.max(b.max.x, cad.max.x), y: Math.max(b.max.y, cad.max.y) },
          }
        : (b ?? cad);

    if (merged) {
      this.view = fitView(this.cssW, this.cssH, merged.min, merged.max);
    } else {
      // empty project: ~24m wide view centred on the origin
      const scale = this.cssW / 24000;
      this.view = { scale, tx: this.cssW / 2, ty: this.cssH / 2 };
    }
    this.viewChanged();
  }

  /**
   * integration seam: re-read shell state and re-publish the hint (§11).
   *
   * `pushStatus()` otherwise runs only off pointer, key and tool events, so a
   * hint that depends on state the canvas never saw an event for sat stale:
   * arming a catalogue item left Furniture still saying "Pick an item from the
   * Library tab", and adding a storey left Stair still refusing. The React
   * mount calls this after every render, which is exactly when that state can
   * have changed.
   */
  refresh(): void {
    this.updateCursor();
    this.pushStatus();
    this.scheduleDraw();
  }

  /** re-fit on the next frame, e.g. once a drawing has been imported */
  refit(): void {
    this.didFit = false;
    this.scheduleDraw();
  }

  /**
   * Frame the view on the selected CAD entities. No-op when nothing is
   * selected, so a toolbar button can call it unconditionally.
   *
   * Bounds come from the display list, not from the entities: a selected
   * symbol lives inside a block definition at the block's own coordinates,
   * and only the display list knows where its instances actually landed.
   */
  zoomToCadSelection(): void {
    const cad = getCadSession();
    if (!cad.list || cad.selected.size === 0) return;
    const b = handlesBounds(cad.list, cad.selected);
    if (!b) return;
    if (this.cssW < 2 || this.cssH < 2) return; // canvas not measured yet
    this.view = fitView(this.cssW, this.cssH, b.min, b.max);
    // a later resize must not throw the framing away again
    this.didFit = true;
    this.viewChanged();
    this.scheduleDraw();
  }

  // ---------------- pointer events ----------------

  private screenPt(e: { clientX: number; clientY: number }): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** kill the browser's own middle-click gesture before it starts */
  private onMouseDownSuppress = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
  };

  /** and the click that would otherwise land when the middle button releases */
  private onAuxClick = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
  };

  private onPointerDown = (e: PointerEvent): void => {
    const model = this.maybeModel();
    if (!model) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    const s = this.screenPt(e);
    this.cursorScreen = s;
    this.shiftHeld = e.shiftKey;
    const st = this.st();

    // integration seam: when the host viewport owns pan/zoom, the middle
    // button and the Pan tool are its business and this branch stands down.
    if (
      this.ownsViewGestures() &&
      (e.button === 1 || (e.button === 0 && (this.spaceHeld || st.activeTool === 'pan')))
    ) {
      this.panning = { last: s, button: e.button };
      this.updateCursor();
      e.preventDefault();
      return;
    }
    if (e.button === 2) {
      if (this.op.kind === 'chain' || this.op.kind === 'polyChain') this.endChainLike();
      else this.endOrCancelOp();
      return;
    }
    if (e.button !== 0) return;

    this.updateHover(s, e);
    const pt = this.effPt ?? toModel(this.view, s);

    if (st.activeTool === 'select') this.selectDown(s, e);
    else if (st.activeTool !== 'pan') this.dispatchClick(st.activeTool, pt);

    this.pushStatus();
    this.scheduleDraw();
  };

  /** dispatches a resolved model-space point to the active drawing tool —
   * used by real clicks and by precision-typed points alike. */
  private dispatchClick(tool: ToolId, pt: Vec2): void {
    switch (tool) {
      case 'wall':
        this.wallClick(pt);
        break;
      case 'line':
        this.twoClick('line', pt);
        break;
      case 'polyline':
        this.polylineClick(pt);
        break;
      case 'rectangle':
        this.twoClick('rectangle', pt);
        break;
      case 'circle':
        this.twoClick('circle', pt);
        break;
      case 'arc':
        this.arcClick(pt);
        break;
      case 'door':
        this.openingClick('door');
        break;
      case 'window':
        this.openingClick('window');
        break;
      case 'column':
        this.placeColumn(pt);
        break;
      case 'beam':
        this.twoClick('beam', pt);
        break;
      case 'slab':
        this.twoClick('slab', pt);
        break;
      case 'room':
        this.roomClick(pt);
        break;
      case 'stair':
        this.placeStair(pt);
        break;
      case 'furniture':
        this.placeFurniture(pt);
        break;
      case 'dimension':
        this.dimensionClick(pt);
        break;
      case 'measure':
        this.measureClick(pt);
        break;
      case 'text':
        this.placeText(pt);
        break;
      case 'scale':
      case 'rotate':
      case 'mirror':
        this.transformClick(tool, pt);
        break;
      default:
        break; // select, pan handled by the caller
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.disposed || !this.maybeModel()) return;
    const s = this.screenPt(e);
    this.cursorScreen = s;
    this.shiftHeld = e.shiftKey;

    if (this.panning) {
      this.view = panBy(this.view, s.x - this.panning.last.x, s.y - this.panning.last.y);
      this.panning.last = s;
      this.viewChanged();
      this.emitStatus({ cursor: toModel(this.view, s) });
      this.scheduleDraw();
      return;
    }

    this.updateHover(s, e);

    const op = this.op;
    if (op.kind === 'maybeMove') {
      if (Math.hypot(s.x - op.startScreen.x, s.y - op.startScreen.y) > 4) {
        this.op = { kind: 'move', startModel: op.startModel, ids: [...this.st().selectedIds] };
      }
    } else if (op.kind === 'marquee') {
      op.curScreen = s;
    }

    this.pushStatus();
    this.scheduleDraw();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.panning && e.button === this.panning.button) {
      this.panning = null;
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    const s = this.screenPt(e);
    const op = this.op;
    switch (op.kind) {
      case 'maybeMove': {
        // plain click on an already-selected element of a multi-selection
        // collapses the selection to just that element
        const sel = this.st().selectedIds;
        if (op.wasSelected && sel.length > 1) this.host.setSelection([op.clickedId]);
        this.op = { kind: 'none' };
        break;
      }
      case 'move':
        this.commitMove();
        this.op = { kind: 'none' };
        break;
      case 'grip':
        this.commitGrip();
        this.op = { kind: 'none' };
        break;
      case 'textGrip':
        this.commitTextResize(op);
        this.op = { kind: 'none' };
        break;
      case 'marquee':
        this.applyMarquee(op, s);
        this.op = { kind: 'none' };
        break;
      default:
        break;
    }
    this.pushStatus();
    this.scheduleDraw();
  };

  private onPointerCancel = (): void => {
    this.panning = null;
    const k = this.op.kind;
    if (k === 'maybeMove' || k === 'move' || k === 'grip' || k === 'marquee' || k === 'textGrip') {
      this.op = { kind: 'none' };
    }
    this.updateCursor();
    this.scheduleDraw();
  };

  private onPointerLeave = (): void => {
    if (this.op.kind === 'none' && !this.panning) {
      this.effPt = null;
      this.cursorRaw = null;
      this.snap = null;
      this.hoverWall = null;
      this.cadHoverPt = null;
      this.setCadHover(null);
      this.emitStatus({ cursor: null, hint: this.hintFor() });
      this.scheduleDraw();
    }
  };

  private onDblClick = (): void => {
    this.endChainLike();
  };

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private onWheel = (e: WheelEvent): void => {
    // integration seam: a host that owns zoom gets the wheel untouched
    if (!this.ownsViewGestures()) return;
    e.preventDefault();
    const s = this.screenPt(e);
    this.cursorScreen = s;
    this.view = zoomAt(this.view, s, Math.exp(-e.deltaY * 0.0012));
    this.viewChanged();
    if (!this.panning) {
      this.updateHover(s);
      this.pushStatus();
    }
    this.scheduleDraw();
  };

  /** right-click / Escape while a tool op is pending: discards it */
  private endOrCancelOp(): void {
    if (this.op.kind !== 'none') {
      this.op = { kind: 'none' };
      this.pushStatus();
      this.scheduleDraw();
    }
  }

  /** ends a wall/polyline chain (Enter, Escape, double-click or right-click
   * all funnel here) — wall segments are already committed per-click so
   * this just stops the chain; a polyline commits its accumulated points
   * as a single element if it has at least two of them. */
  private endChainLike(): void {
    const op = this.op;
    if (op.kind === 'chain') {
      this.op = { kind: 'none' };
    } else if (op.kind === 'polyChain') {
      if (op.points.length >= 2) this.commitPolyline(op.points, false);
      else this.op = { kind: 'none' };
    } else {
      return;
    }
    this.pushStatus();
    this.scheduleDraw();
  }

  // ---------------- hover / snapping ----------------

  private updateHover(s: Vec2, e?: { shiftKey: boolean }): void {
    const model = this.maybeModel();
    if (!model) return;
    const st = this.st();
    const raw = toModel(this.view, s);
    this.cursorRaw = raw;
    const tool = st.activeTool;

    let exclude: Set<string> | undefined;
    if (this.op.kind === 'move') exclude = new Set(this.op.ids);
    else if (this.op.kind === 'grip') exclude = new Set([this.op.wallId]);

    const snapTools: ToolId[] = [
      'wall',
      'line',
      'polyline',
      'rectangle',
      'circle',
      'arc',
      'column',
      'beam',
      'slab',
      'dimension',
      'measure',
      'text',
      'stair',
      'furniture',
      // transform base points and mirror axes snap like any other picked point
      'scale',
      'rotate',
      'mirror',
    ];
    let wantSnap = snapTools.includes(tool);
    if (tool === 'select') wantSnap = this.op.kind === 'grip';

    this.snap = wantSnap
      ? computeSnap(model, st.activeLevelId, raw, { scale: this.view.scale, exclude })
      : null;
    let pt = this.snap?.point ?? raw;

    // angle-snapped rubber band for chain/segment tools (real object snaps win)
    const angleCfg = this.angleSnapConfig(tool);
    if (angleCfg && !(e?.shiftKey ?? this.shiftHeld)) {
      if (!this.snap || this.snap.kind === 'grid') {
        const d = sub(raw, angleCfg.last);
        if (len(d) > 1) {
          const ang = Math.round(angleOf(d) / angleCfg.increment) * angleCfg.increment;
          const dir = { x: Math.cos(ang), y: Math.sin(ang) };
          let t = dot(d, dir);
          if (model.settings.snapGrid && model.settings.gridSpacing > 0) {
            t = snapTo(t, model.settings.gridSpacing);
          }
          pt = add(angleCfg.last, mul(dir, t));
          this.snap = null;
        }
      }
    }
    this.effPt = pt;

    if (tool === 'door' || tool === 'window') this.updateHoverWall(raw, tool);
    else this.hoverWall = null;

    this.updateCadHover(raw, tool);
  }

  // ---------------- CAD underlay picking ----------------
  //
  // The underlay is display-only geometry: picking it selects and measures,
  // it never edits, so nothing here touches the BIM model or the undo stack.
  // Every pick goes through the display list, which is the same thing the
  // painter drew — what you clicked is what you saw.

  /** topmost CAD entity handle within the pick aperture of a model point */
  private cadHitAt(pt: Vec2): string | null {
    const cad = getCadSession();
    if (!cad.visible || !cad.list) return null;
    return hitTestDisplayList(cad.list, pt, PICK_PX / this.view.scale, {
      hiddenLayers: cad.hiddenLayers,
    });
  }

  /**
   * Adopt a hover result. Throttled by handle: `entityFacts` and the
   * formatted readout only run when the entity under the cursor actually
   * changes, so sliding along one long polyline costs nothing after the
   * first pixel.
   */
  private setCadHover(handle: string | null): void {
    if (handle === this.cadHover) return;
    this.cadHover = handle;
    this.cadHoverHint = '';
    const doc = getCadSession().doc;
    const model = this.maybeModel();
    if (handle && doc && model) {
      const e = cadEntityByHandle(doc, handle);
      if (e) this.cadHoverHint = cadHoverHint(doc, e, model.settings.unit);
    }
    this.pushStatus();
    // when resolved from inside draw(), this frame already shows the change
    if (!this.drawing) this.scheduleDraw();
  }

  /**
   * Queue a hover pick. The pick itself is deferred to the next painted
   * frame: pointermove can outrun the display, and picking a 68k-op drawing
   * costs ~1.5 ms — enough to matter if it ran several times per frame.
   */
  private updateCadHover(raw: Vec2, tool: ToolId): void {
    const cad = getCadSession();
    if (tool !== 'select' || this.op.kind !== 'none' || !cad.visible || !cad.list) {
      this.cadHoverPt = null;
      this.setCadHover(null);
      return;
    }
    this.cadHoverPt = raw;
  }

  private resolveCadHover(): void {
    const pt = this.cadHoverPt;
    if (!pt) return;
    this.cadHoverPt = null;
    // BIM keeps priority: a wall drawn over a CAD line takes both the hover
    // and the click, so the pre-highlight can never promise a pick it will
    // not deliver
    const model = this.maybeModel();
    if (model && hitTest(model, this.st().activeLevelId, pt, PICK_PX / this.view.scale)) {
      this.setCadHover(null);
      return;
    }
    this.setCadHover(this.cadHitAt(pt));
  }

  /** angle-snap increment + anchor point for tools that draw a rubber-band
   * segment from a known last point (wall/polyline: 45°, line: 15°) */
  private angleSnapConfig(tool: ToolId): { last: Vec2; increment: number } | null {
    const op = this.op;
    if (tool === 'wall' && op.kind === 'chain') {
      return { last: op.last, increment: Math.PI / 4 };
    }
    if (tool === 'polyline' && op.kind === 'polyChain' && op.points.length) {
      return { last: op.points[op.points.length - 1], increment: Math.PI / 4 };
    }
    if (tool === 'line' && op.kind === 'two' && op.tool === 'line') {
      return { last: op.a, increment: Math.PI / 12 };
    }
    return null;
  }

  private updateHoverWall(raw: Vec2, tool: 'door' | 'window'): void {
    const model = this.getModel();
    const st = this.st();
    const { width, height } = this.openingSize(tool);
    let best: { wall: WallElement; t: number; d: number; point: Vec2 } | null = null;
    for (const el of model.onLevel(st.activeLevelId)) {
      if (el.type !== 'wall') continue;
      const cp = closestPointOnSegment(raw, el.start, el.end);
      if (cp.dist * this.view.scale <= 15 && (!best || cp.dist < best.d)) {
        best = { wall: el, t: cp.t, d: cp.dist, point: cp.point };
      }
    }
    if (!best) {
      this.hoverWall = null;
      return;
    }
    const w = best.wall;
    const L = wallLength(w);
    const valid = L >= width + 1;
    const offset = clamp(best.t * L, width / 2, Math.max(width / 2, L - width / 2));
    const side = cross(wallDir(w), sub(raw, best.point));
    this.hoverWall = { id: w.id, offset, flip: side < 0, valid, width, height };
  }

  /**
   * The value a tool is armed with, or its default. `optNumber` is total over
   * `ToolOptionKey` (toolOptions.ts) because every key is a key of `DEFAULTS`,
   * so no call site here spells a fallback number of its own — the strip's
   * field and the geometry that gets created read the SAME table.
   */
  private opt(key: ToolOptionKey): number {
    return optNumber(this.st().toolOptions, key);
  }

  /** active CAD layer for newly drawn drafting primitives */
  private activeLayer(): string {
    return activeLayerOf(this.st().toolOptions);
  }

  private openingSize(tool: 'door' | 'window'): {
    width: number;
    height: number;
    item?: CatalogItem;
  } {
    const st = this.st();
    const raw = this.catalogItem(st.activeCatalogId);
    const item = raw && raw.category === tool ? raw : undefined;
    if (tool === 'door') {
      return {
        width: item?.width ?? this.opt('doorWidth'),
        height: item?.height ?? this.opt('doorHeight'),
        item,
      };
    }
    return {
      width: item?.width ?? this.opt('windowWidth'),
      height: item?.height ?? this.opt('windowHeight'),
      item,
    };
  }

  // ---------------- select tool ----------------

  private selectDown(s: Vec2, e: PointerEvent): void {
    const model = this.getModel();
    const st = this.st();
    // grips of a single selected element take priority over picking
    if (st.selectedIds.length === 1) {
      const el = model.get(st.selectedIds[0]);
      if (el?.type === 'wall') {
        for (const which of ['start', 'end'] as const) {
          const gp = toScreen(this.view, el[which]);
          if (Math.hypot(gp.x - s.x, gp.y - s.y) <= 8) {
            this.op = { kind: 'grip', wallId: el.id, which };
            this.updateHover(s, e); // recompute snap with the wall excluded
            return;
          }
        }
      } else if (el?.type === 'text') {
        const gp = textGripPoint(el);
        const sp = toScreen(this.view, gp);
        const startDist = dist(gp, el.position);
        if (Math.hypot(sp.x - s.x, sp.y - s.y) <= 8 && startDist > 1e-6) {
          this.op = {
            kind: 'textGrip',
            id: el.id,
            anchor: el.position,
            startSize: el.size,
            startDist,
          };
          return;
        }
      }
    }
    const pt = toModel(this.view, s);
    // BIM first, always: the CAD drawing is an underlay, so anything drawn
    // over it wins the pick. The CAD hit-test happens on release instead
    // (see applyMarquee), which keeps drag-a-marquee-from-anywhere working.
    const hit = hitTest(model, st.activeLevelId, pt, PICK_PX / this.view.scale);
    const additive = isAdditive(e);
    if (hit) {
      if (additive) {
        const has = st.selectedIds.includes(hit.id);
        this.host.setSelection(
          has ? st.selectedIds.filter((i) => i !== hit.id) : [...st.selectedIds, hit.id],
        );
        return;
      }
      clearCadSelection();
      const wasSelected = st.selectedIds.includes(hit.id);
      if (!wasSelected) this.host.setSelection([hit.id]);
      this.op = {
        kind: 'maybeMove',
        startScreen: s,
        startModel: pt,
        clickedId: hit.id,
        wasSelected,
      };
    } else {
      this.op = { kind: 'marquee', startScreen: s, curScreen: s, additive };
    }
  }

  private currentMoveDelta(): Vec2 | null {
    if (this.op.kind !== 'move' || !this.cursorRaw) return null;
    const model = this.getModel();
    let d = sub(this.cursorRaw, this.op.startModel);
    const g = model.settings.gridSpacing;
    if (model.settings.snapGrid && g > 0) {
      d = { x: snapTo(d.x, g), y: snapTo(d.y, g) };
    }
    return d;
  }

  private commitMove(): void {
    if (this.op.kind !== 'move') return;
    const d = this.currentMoveDelta();
    if (!d || !meaningfulDelta(d)) return;
    const model = this.getModel();
    const st = this.st();
    const ids = new Set(this.op.ids);
    const entries: { id: string; patch: Record<string, unknown> }[] = [];
    for (const id of this.op.ids) {
      const el = model.get(id);
      if (!el) continue;
      const patch = movePatchFor(el, d, ids, model);
      if (patch) entries.push({ id, patch });
    }
    if (!entries.length) return;
    this.host.runCommand(buildGeometryCommand(model, st.activeLevelId, entries, 'Move'));
  }

  private commitGrip(): void {
    if (this.op.kind !== 'grip' || !this.effPt) return;
    const model = this.getModel();
    const st = this.st();
    const wall = model.get(this.op.wallId);
    if (wall?.type !== 'wall') return;
    const pt = this.effPt;
    if (dist(pt, wall[this.op.which]) < 0.01) return;
    const entries = wallEndpointEntries(model, wall, this.op.which, pt);
    this.host.runCommand(buildGeometryCommand(model, st.activeLevelId, entries, 'Edit wall'));
  }

  // ---------------- text resize grip ----------------

  /** live text height for the grip drag: the anchor-to-cursor distance
   * against the anchor-to-grip distance the drag started from */
  private textGripSize(op: Extract<Op, { kind: 'textGrip' }>): number {
    const c = this.cursorRaw;
    if (!c) return op.startSize;
    const f = dist(c, op.anchor) / op.startDist;
    return clamp(op.startSize * f, MIN_TEXT_SIZE, MAX_TEXT_SIZE);
  }

  private commitTextResize(op: Extract<Op, { kind: 'textGrip' }>): void {
    const el = this.getModel().get(op.id);
    if (el?.type !== 'text') return;
    const size = this.textGripSize(op);
    if (Math.abs(size - el.size) < 1e-6) return;
    this.host.runCommand(cmdUpdateElement(op.id, { size }, 'Resize text'));
    // remember it, so the next text placed matches what the user just dialled in
    this.host.setToolOption?.('textSize', size);
  }

  // ---------------- transform tools (scale / rotate / mirror) ----------------
  //
  // Scale uses classic CAD *reference* scaling — three clicks: base point,
  // then a reference point whose distance from the base means "1x", then the
  // point that sets the new distance. It is the only variant that is exactly
  // predictable in a millimetre model: AutoCAD's 2-click form reads the raw
  // cursor distance as the factor, which at mm scale means a 1.75x scale lives
  // 1.75 mm from the base point. Rotate and mirror need no reference and stay
  // two clicks: rotate measures CCW from +x at the base point (as AutoCAD's
  // ROTATE does), mirror's two clicks are the axis itself.
  //
  // At any point after the base click a typed value commits directly:
  // a bare factor for scale, degrees for rotate, a coordinate for mirror.

  private transformClick(tool: TransformTool, pt: Vec2): void {
    const op = this.op;
    if (op.kind !== 'xform' || op.tool !== tool) {
      // hintFor() already tells the user to select something first
      const ids = this.st().selectedIds;
      if (!ids.length) return;
      this.op = { kind: 'xform', tool, base: pt, refDist: null, ids: [...ids] };
      return;
    }
    if (tool === 'scale' && op.refDist === null) {
      const d = dist(pt, op.base);
      if (d < 1e-6) return; // degenerate reference — ignore this click
      op.refDist = d;
      return;
    }
    const x = this.currentXform(pt);
    if (!x) return;
    this.commitTransform(x, tool === 'scale' ? 'Scale' : tool === 'rotate' ? 'Rotate' : 'Mirror');
  }

  /** the transform the pending gesture currently describes, or null when it is
   * not yet well defined (no reference distance, zero-length drag, ...) */
  private currentXform(at?: Vec2): Xform | null {
    const op = this.op;
    if (op.kind !== 'xform') return null;
    const c = at ?? this.effPt ?? this.cursorRaw;
    if (!c) return null;
    if (op.tool === 'scale') {
      if (op.refDist === null) return null;
      let f = dist(c, op.base) / op.refDist;
      if (this.shiftHeld) f = Math.round(f / SCALE_FACTOR_STEP) * SCALE_FACTOR_STEP;
      return f >= MIN_SCALE_FACTOR ? scaleXform(op.base, f) : null;
    }
    if (op.tool === 'rotate') {
      const d = sub(c, op.base);
      if (len(d) < 1e-6) return null;
      let a = angleOf(d);
      if (this.shiftHeld) a = Math.round(a / ROTATE_ANGLE_STEP) * ROTATE_ANGLE_STEP;
      return rotateXform(op.base, a);
    }
    const b = this.mirrorAxisPoint(op.base, c);
    return b ? mirrorXform(op.base, b) : null;
  }

  /** second mirror-axis point, with Shift constraining the axis to 45° steps */
  private mirrorAxisPoint(base: Vec2, c: Vec2): Vec2 | null {
    const d = sub(c, base);
    const l = len(d);
    if (l < 1e-6) return null;
    if (!this.shiftHeld) return c;
    const a = Math.round(angleOf(d) / MIRROR_AXIS_STEP) * MIRROR_AXIS_STEP;
    return add(base, mul({ x: Math.cos(a), y: Math.sin(a) }, l));
  }

  private commitTransform(x: Xform, name: string): void {
    const op = this.op;
    const ids = op.kind === 'xform' ? op.ids : this.st().selectedIds;
    this.op = { kind: 'none' };
    this.pendingBuffer = null;
    const entries = transformEntries(this.getModel(), ids, x);
    if (entries.length) this.host.runCommand(cmdUpdateMany(entries, name));
  }

  private applyMarquee(op: Extract<Op, { kind: 'marquee' }>, s: Vec2): void {
    const model = this.getModel();
    const st = this.st();
    const a = op.startScreen;

    // barely moved: this was a click on empty space — or on the CAD underlay,
    // which is the only thing the pointer-down pick did not already consider
    if (Math.abs(a.x - s.x) < 3 && Math.abs(a.y - s.y) < 3) {
      const handle = this.cadHitAt(toModel(this.view, s));
      if (handle) {
        if (!op.additive) this.host.setSelection([]);
        toggleCadSelection(handle, op.additive);
        return;
      }
      if (!op.additive) {
        this.host.setSelection([]);
        clearCadSelection();
      }
      return;
    }

    const ma = toModel(this.view, a);
    const mb = toModel(this.view, s);
    const min = { x: Math.min(ma.x, mb.x), y: Math.min(ma.y, mb.y) };
    const max = { x: Math.max(ma.x, mb.x), y: Math.max(ma.y, mb.y) };
    const mode = s.x >= a.x ? 'contain' : 'intersect';
    let ids = elementsInRect(model, st.activeLevelId, min, max, mode);
    if (op.additive) ids = [...new Set([...st.selectedIds, ...ids])];
    this.host.setSelection(ids);

    // the same rect over the underlay; the display list is walked once, off
    // its cached bounds, so a 68k-op drawing costs one linear pass
    const cad = getCadSession();
    if (cad.visible && cad.list) {
      const handles = handlesInRect(cad.list, min, max, mode, {
        hiddenLayers: cad.hiddenLayers,
      });
      setCadSelection(op.additive ? [...cad.selected, ...handles] : handles);
    } else if (!op.additive) {
      clearCadSelection();
    }
  }

  // ---------------- drawing tools: BIM elements ----------------

  private wallClick(pt: Vec2): void {
    if (this.op.kind !== 'chain') {
      this.op = { kind: 'chain', last: pt };
      return;
    }
    const last = this.op.last;
    if (dist(pt, last) < 1) return;
    const st = this.st();
    const wall: WallElement = {
      id: newId('wall'),
      type: 'wall',
      name: 'Wall',
      levelId: st.activeLevelId,
      material: 'brick',
      start: last,
      end: pt,
      thickness: this.opt('wallThickness'),
      height: this.opt('wallHeight'),
    };
    this.host.runCommand(cmdAddElements([wall], 'Add wall'));
    this.op = { kind: 'chain', last: pt };
  }

  private openingClick(tool: 'door' | 'window'): void {
    const hw = this.hoverWall;
    if (!hw) return;
    if (!hw.valid) {
      this.emitStatus({ hint: `Wall is too short for this ${tool}` });
      return;
    }
    const model = this.getModel();
    const host = model.get(hw.id);
    if (host?.type !== 'wall') return;
    const { item } = this.openingSize(tool);
    if (tool === 'door') {
      const el: DoorElement = {
        id: newId('door'),
        type: 'door',
        name: item?.name ?? 'Door',
        levelId: host.levelId,
        material: 'wood',
        hostWallId: host.id,
        offset: hw.offset,
        width: hw.width,
        height: hw.height,
        flip: hw.flip,
      };
      this.host.runCommand(cmdAddElements([el], 'Add door'));
    } else {
      const el: WindowElement = {
        id: newId('window'),
        type: 'window',
        name: item?.name ?? 'Window',
        levelId: host.levelId,
        material: 'glass',
        hostWallId: host.id,
        offset: hw.offset,
        width: hw.width,
        height: hw.height,
        sillHeight: this.opt('sillHeight'),
      };
      this.host.runCommand(cmdAddElements([el], 'Add window'));
    }
  }

  private placeColumn(pt: Vec2): void {
    const model = this.getModel();
    const st = this.st();
    const size = this.opt('columnSize');
    const el: ColumnElement = {
      id: newId('column'),
      type: 'column',
      name: 'Column',
      levelId: st.activeLevelId,
      material: 'concrete',
      position: pt,
      width: size,
      depth: size,
      height: model.getLevel(st.activeLevelId)?.height ?? DEFAULTS.columnHeight,
      rotation: 0,
    };
    this.host.runCommand(cmdAddElements([el], 'Add column'));
  }

  /** two-click BIM/drafting shapes: beam, slab, and the line/rectangle/circle
   * drafting primitives all share this click-count state machine. */
  private twoClick(
    tool: 'beam' | 'slab' | 'line' | 'rectangle' | 'circle',
    pt: Vec2,
  ): void {
    if (this.op.kind !== 'two' || this.op.tool !== tool) {
      this.op = { kind: 'two', tool, a: pt };
      return;
    }
    const a = this.op.a;
    this.op = { kind: 'none' };
    const st = this.st();
    switch (tool) {
      case 'beam': {
        if (dist(a, pt) < 1) return;
        const el: BeamElement = {
          id: newId('beam'),
          type: 'beam',
          name: 'Beam',
          levelId: st.activeLevelId,
          material: 'concrete',
          start: a,
          end: pt,
          width: this.opt('beamWidth'),
          depth: this.opt('beamDepth'),
          offset: 0,
        };
        this.host.runCommand(cmdAddElements([el], 'Add beam'));
        break;
      }
      case 'slab': {
        if (Math.abs(pt.x - a.x) < 1 || Math.abs(pt.y - a.y) < 1) return;
        const el: SlabElement = {
          id: newId('slab'),
          type: 'slab',
          name: 'Slab',
          levelId: st.activeLevelId,
          material: 'concrete',
          outline: rectOutline(a, pt),
          thickness: this.opt('slabThickness'),
        };
        this.host.runCommand(cmdAddElements([el], 'Add slab'));
        break;
      }
      case 'line': {
        if (dist(a, pt) < 1) return;
        const el: RefLineElement = {
          id: newId('ref'),
          type: 'refline',
          name: 'Line',
          levelId: st.activeLevelId,
          points: [a, pt],
          closed: false,
          layer: this.activeLayer(),
        };
        this.host.runCommand(cmdAddElements([el], 'Add line'));
        break;
      }
      case 'rectangle': {
        const corner = this.shiftHeld ? squareCorner(a, pt) : pt;
        if (Math.abs(corner.x - a.x) < 1 || Math.abs(corner.y - a.y) < 1) return;
        const el: RefLineElement = {
          id: newId('ref'),
          type: 'refline',
          name: 'Rectangle',
          levelId: st.activeLevelId,
          points: rectOutline(a, corner),
          closed: true,
          layer: this.activeLayer(),
        };
        this.host.runCommand(cmdAddElements([el], 'Add rectangle'));
        break;
      }
      case 'circle': {
        const r = dist(a, pt);
        if (r < 1) return;
        const el: RefLineElement = {
          id: newId('ref'),
          type: 'refline',
          name: 'Circle',
          levelId: st.activeLevelId,
          points: circlePoints(a, r, 48),
          closed: true,
          layer: this.activeLayer(),
        };
        this.host.runCommand(cmdAddElements([el], 'Add circle'));
        break;
      }
    }
  }

  private roomClick(pt: Vec2): void {
    const model = this.getModel();
    const st = this.st();
    const boundary = detectRoomBoundary(model, st.activeLevelId, pt);
    if (!boundary || boundary.length < 3) {
      this.emitStatus({ hint: 'Region is not enclosed by walls' });
      return;
    }
    const count = model.byType<RoomElement>('room').length + 1;
    const el: RoomElement = {
      id: newId('room'),
      type: 'room',
      name: 'Room',
      number: String(count).padStart(3, '0'),
      levelId: st.activeLevelId,
      boundary,
    };
    this.host.runCommand(cmdAddElements([el], 'Add room'));
  }

  private placeStair(pt: Vec2): void {
    const model = this.getModel();
    const st = this.st();
    const above = model.levelAbove(st.activeLevelId);
    if (!above) {
      this.emitStatus({ hint: 'Add a level above first' });
      return;
    }
    const el: StairElement = {
      id: newId('stair'),
      type: 'stair',
      name: 'Stair',
      levelId: st.activeLevelId,
      material: 'concrete',
      position: pt,
      rotation: this.ghostRotation,
      width: this.opt('stairWidth'),
      length: this.opt('stairLength'),
      toLevelId: above.id,
    };
    this.host.runCommand(cmdAddElements([el], 'Add stair'));
  }

  private placeFurniture(pt: Vec2): void {
    const st = this.st();
    const item = this.catalogItem(st.activeCatalogId);
    if (!item) {
      this.emitStatus({ hint: 'Pick an item from the Library tab' });
      return;
    }
    const el: FurnitureElement = {
      id: newId('furniture'),
      type: 'furniture',
      name: item.name,
      levelId: st.activeLevelId,
      material: 'wood',
      catalogId: item.id,
      position: pt,
      rotation: this.ghostRotation,
      width: item.width,
      depth: item.depth,
      height: item.height,
    };
    this.host.runCommand(cmdAddElements([el], 'Add furniture'));
  }

  private dimAnchorFromSnap(): DimAnchor | null {
    const s = this.snap;
    return s && s.kind === 'endpoint' && s.end && s.refId
      ? { elementId: s.refId, end: s.end }
      : null;
  }

  private dimensionClick(pt: Vec2): void {
    const st = this.st();
    const op = this.op;
    if (op.kind === 'dimA') {
      if (dist(pt, op.a) < 1) return;
      const anchors: DimAnchor[] = [];
      if (op.anchorA) anchors.push(op.anchorA);
      const b = this.dimAnchorFromSnap();
      if (b) anchors.push(b);
      this.op = { kind: 'dimOffset', a: op.a, b: pt, anchors };
      return;
    }
    if (op.kind === 'dimOffset') {
      const d = norm(sub(op.b, op.a));
      const off = dot(sub(pt, op.a), perp(d));
      const el: DimensionElement = {
        id: newId('dim'),
        type: 'dimension',
        name: 'Dimension',
        levelId: st.activeLevelId,
        start: op.a,
        end: op.b,
        offsetDist: off,
        anchors: op.anchors.length ? op.anchors : undefined,
      };
      this.host.runCommand(cmdAddElements([el], 'Add dimension'));
      this.op = { kind: 'none' };
      return;
    }
    this.op = { kind: 'dimA', a: pt, anchorA: this.dimAnchorFromSnap() };
  }

  private measureClick(pt: Vec2): void {
    if (this.op.kind === 'two' && this.op.tool === 'measure') {
      this.op = { kind: 'measureDone', a: this.op.a, b: pt };
    } else {
      this.op = { kind: 'two', tool: 'measure', a: pt };
    }
  }

  private placeText(pt: Vec2): void {
    const st = this.st();
    // integration seam: the shell can supply its own text entry; the browser
    // prompt is only the fallback.
    const content = this.host.promptText ? this.host.promptText() : window.prompt('Text:');
    if (!content || !content.trim()) return;
    const el: TextElement = {
      id: newId('text'),
      type: 'text',
      name: 'Text',
      levelId: st.activeLevelId,
      position: pt,
      text: content.trim(),
      // last size the user settled on (set by the text resize grip), so text
      // placed on a 20mm drawing does not arrive at the 200mm BIM default
      size: this.opt('textSize'),
      rotation: 0,
      // TextElement.layer "drives layer visibility" (core/types.ts) and the
      // renderer already honours it generically, so text placed by the tool
      // lands on the same active layer the drafting primitives do — otherwise
      // the strip's Layer field would silently mean nothing under Text.
      layer: this.activeLayer(),
    };
    this.host.runCommand(cmdAddElements([el], 'Add text'));
  }

  // ---------------- drawing tools: CAD drafting primitives ----------------
  // All produce a RefLineElement on the active CAD layer (toolOptions.activeLayer,
  // default "0"). Selection, hit-testing, move and duplicate already treat
  // 'refline' generically, so these tools only need to build the geometry.

  private polylineClick(pt: Vec2): void {
    if (this.op.kind !== 'polyChain') {
      this.op = { kind: 'polyChain', points: [pt] };
      return;
    }
    const points = this.op.points;
    const last = points[points.length - 1];
    if (dist(pt, last) < 1) return; // duplicate-click guard (also swallows dblclick's 2nd click)
    if (points.length >= 2) {
      // snap-close: within ~12px screen of the start point finishes a closed loop
      const s0 = toScreen(this.view, points[0]);
      const s1 = toScreen(this.view, pt);
      if (Math.hypot(s0.x - s1.x, s0.y - s1.y) <= 12) {
        this.commitPolyline(points, true);
        return;
      }
    }
    this.op = { kind: 'polyChain', points: [...points, pt] };
  }

  private commitPolyline(points: Vec2[], closed: boolean): void {
    const st = this.st();
    const el: RefLineElement = {
      id: newId('ref'),
      type: 'refline',
      name: 'Polyline',
      levelId: st.activeLevelId,
      points,
      closed,
      layer: this.activeLayer(),
    };
    this.host.runCommand(cmdAddElements([el], 'Add polyline'));
    this.op = { kind: 'none' };
  }

  private arcClick(pt: Vec2): void {
    const op = this.op;
    if (op.kind !== 'arcPts') {
      this.op = { kind: 'arcPts', pts: [pt] };
      return;
    }
    if (op.pts.length === 1) {
      if (dist(pt, op.pts[0]) < 1) return;
      this.op = { kind: 'arcPts', pts: [op.pts[0], pt] };
      return;
    }
    const [a, b] = op.pts;
    if (dist(pt, a) < 1 || dist(pt, b) < 1) return;
    const pts = arcThroughPoints(a, b, pt, 32);
    if (!pts) {
      this.emitStatus({ hint: 'Points are collinear — pick a different point on the arc' });
      return;
    }
    const st = this.st();
    const el: RefLineElement = {
      id: newId('ref'),
      type: 'refline',
      name: 'Arc',
      levelId: st.activeLevelId,
      points: pts,
      closed: false,
      layer: this.activeLayer(),
    };
    this.host.runCommand(cmdAddElements([el], 'Add arc'));
    this.op = { kind: 'none' };
  }

  // ---------------- precision (typed-coordinate) input ----------------

  /** the reference point a typed distance/offset is measured from, or null
   * when the active tool isn't currently awaiting a "next point" that has one */
  private precisionRefPoint(): Vec2 | null {
    const op = this.op;
    switch (op.kind) {
      case 'chain':
        return op.last;
      case 'polyChain':
        return op.points.length ? op.points[op.points.length - 1] : null;
      case 'two':
        return op.a;
      case 'arcPts':
        return op.pts.length ? op.pts[op.pts.length - 1] : null;
      case 'dimA':
        return op.a;
      case 'xform':
        // mirror's second click is a real point, so it uses the normal
        // coordinate grammar; scale/rotate type a factor/angle instead
        return op.tool === 'mirror' ? op.base : null;
      default:
        return null;
    }
  }

  /** what a typed value means right now: a point, a bare scale factor, or an
   * angle in degrees. null = nothing to type against. */
  private precisionMode(): 'point' | 'factor' | 'angle' | null {
    const op = this.op;
    if (op.kind === 'xform') {
      if (op.tool === 'scale') return 'factor';
      if (op.tool === 'rotate') return 'angle';
      return 'point';
    }
    return this.precisionRefPoint() ? 'point' : null;
  }

  private commitPrecisionInput(): void {
    const mode = this.precisionMode();
    const op = this.op;
    if ((mode === 'factor' || mode === 'angle') && op.kind === 'xform') {
      const n = parseNumberInput(this.pendingBuffer ?? '');
      if (n === null) return; // incomplete/invalid — keep editing
      if (mode === 'factor') {
        if (!(n >= MIN_SCALE_FACTOR)) return; // 0 or negative is not a scale
        this.commitTransform(scaleXform(op.base, n), 'Scale');
      } else {
        this.commitTransform(rotateXform(op.base, (n * Math.PI) / 180), 'Rotate');
      }
      this.pushStatus();
      this.scheduleDraw();
      return;
    }
    const ref = this.precisionRefPoint();
    if (!ref) {
      this.pendingBuffer = null;
      this.pushStatus();
      return;
    }
    const dirSource = this.effPt ?? this.cursorRaw ?? ref;
    const pt = parsePrecisionInput(this.pendingBuffer ?? '', ref, dirSource);
    if (!pt) return; // incomplete/invalid — keep editing
    this.pendingBuffer = null;
    this.dispatchClick(this.st().activeTool, pt);
    this.pushStatus();
    this.scheduleDraw();
  }

  private updatePrecisionOverlay(): void {
    const el = this.precisionEl;
    if (this.pendingBuffer === null || !this.cursorScreen) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.style.left = `${this.cursorScreen.x + 14}px`;
    el.style.top = `${this.cursorScreen.y + 14}px`;
    el.textContent = `${this.pendingBuffer}_`;
  }

  // ---------------- keyboard ----------------
  //
  // THE SINGLE KEYBOARD OWNER (EDITOR_TOOLS_NOTE §13 D1/D2, §14.2).
  //
  // In SOURCE two `window` listeners raced: this one, and the tool palette's.
  // Neither stopped the other, so `R` rotated a stair ghost AND switched to the
  // Room tool, and a `w` typed halfway through a coordinate changed the tool
  // mid-entry. The fix is not a bigger `preventDefault` — `preventDefault` does
  // nothing to a sibling listener. It is single ownership: the tool letters live
  // here (TOOL_KEYS, from tools.ts), and every key this controller acts on is
  // consumed with `stopImmediatePropagation()` so no second listener — however
  // it got registered — can act on the same press.

  /**
   * Consume a key: no browser default, and no other listener, in this window
   * or on this element. The `stopImmediatePropagation` is the D1/D2 fix.
   */
  private consume(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  /**
   * integration seam: a host that sets `ownsKeyboard: false` (because it
   * routes keys itself) forwards them here instead. Same handler either way —
   * there is still exactly one owner.
   */
  handleKeyDown(e: KeyboardEvent): void {
    this.onKeyDown(e);
  }

  handleKeyUp(e: KeyboardEvent): void {
    this.onKeyUp(e);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isEditableTarget(e.target)) return;
    const model = this.maybeModel();
    if (!model || this.disposed) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;

    if (!ctrl && !e.altKey) {
      if (this.pendingBuffer !== null) {
        // DEFECT D5 fix: inside a coordinate buffer Backspace edits the
        // buffer. Outside one it does NOT delete geometry — see below.
        if (key === 'Backspace') {
          this.consume(e);
          this.pendingBuffer = this.pendingBuffer.slice(0, -1);
          this.pushStatus();
          return;
        }
        if (key === 'Enter') {
          this.consume(e);
          this.commitPrecisionInput();
          return;
        }
        if (key === 'Escape') {
          this.consume(e);
          this.pendingBuffer = null;
          this.pushStatus();
          this.scheduleDraw();
          return;
        }
        if (PRECISION_CONTINUE.test(key)) {
          this.consume(e);
          this.pendingBuffer += key;
          this.pushStatus();
          return;
        }
        // DEFECT D2 fix: swallow every other single character while a
        // coordinate is being typed — and swallow it LOUDLY. Typing `500`
        // and then reaching for `w` must not change the tool underneath the
        // entry; consuming the press is what actually prevents that.
        if (key.length === 1) this.consume(e);
        return;
      }
      if (PRECISION_START.test(key) && this.precisionMode()) {
        this.consume(e);
        this.pendingBuffer = key;
        this.pushStatus();
        return;
      }
    }

    if (key === ' ') {
      if (this.ownsViewGestures() && !this.spaceHeld) {
        this.spaceHeld = true;
        this.updateCursor();
      }
      this.consume(e);
      return;
    }
    if (key === 'Shift') {
      this.shiftHeld = true;
      this.refreshHover();
      return; // a held modifier is not "consumed" — other UI may want it
    }
    if (ctrl && !e.shiftKey && (key === 'z' || key === 'Z')) {
      this.consume(e);
      this.host.undo();
      this.scheduleDraw();
      return;
    }
    if (ctrl && (key === 'y' || key === 'Y' || ((key === 'z' || key === 'Z') && e.shiftKey))) {
      this.consume(e);
      this.host.redo();
      this.scheduleDraw();
      return;
    }
    if (ctrl && (key === 'd' || key === 'D')) {
      this.consume(e);
      this.duplicateSelection();
      return;
    }
    if (ctrl && (key === 'a' || key === 'A')) {
      if (this.selectAllCad()) this.consume(e);
      return;
    }
    // DEFECT D5 fix: `Del` alone deletes. SOURCE treated Backspace as Delete
    // whenever no buffer was open, so correcting a typo outside an input
    // destroyed the selection. Backspace is still swallowed here so the
    // browser cannot navigate back — it simply does nothing to the model.
    if (key === 'Delete') {
      this.consume(e);
      this.deleteSelection();
      return;
    }
    if (key === 'Backspace') {
      this.consume(e);
      return;
    }
    if (key === 'Escape') {
      this.consume(e);
      this.escapePressed();
      return;
    }
    if (key === 'Enter') {
      this.consume(e);
      this.endChainLike();
      return;
    }
    // DEFECT D1 fix: `R` rotates the armed ghost when there is one, and only
    // falls through to the Room tool shortcut when there is not. One owner,
    // one meaning per press — the hint "Click to place stair · R rotates" is
    // now true.
    if (key === 'r' || key === 'R') {
      const tool = this.st().activeTool;
      if (tool === 'stair' || tool === 'furniture') {
        this.consume(e);
        this.ghostRotation = (this.ghostRotation + Math.PI / 2) % (Math.PI * 2);
        this.pushStatus();
        this.scheduleDraw();
        return;
      }
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
      if (this.st().selectedIds.length) {
        this.consume(e);
        this.nudge(key);
      }
      return;
    }
    // Tool letters, last — they are the lowest-priority meaning a bare key
    // can have, and they live in tools.ts so the strip can render the same
    // letters without a listener of its own (D1/D2).
    if (!ctrl && !e.altKey && !e.shiftKey && key.length === 1) {
      const tool = TOOL_KEYS[key.toLowerCase()];
      if (tool) {
        this.consume(e);
        if (tool !== this.st().activeTool) this.host.setActiveTool(tool);
        return;
      }
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ') {
      this.spaceHeld = false;
      this.updateCursor();
    } else if (e.key === 'Shift') {
      this.shiftHeld = false;
      this.refreshHover();
    }
  };

  private refreshHover(): void {
    if (this.cursorScreen && !this.panning) {
      this.updateHover(this.cursorScreen);
      this.scheduleDraw();
    }
  }

  private escapePressed(): void {
    if (this.op.kind === 'chain' || this.op.kind === 'polyChain') {
      this.endChainLike();
      return;
    }
    if (this.op.kind !== 'none') {
      this.endOrCancelOp();
      return;
    }
    // one Escape clears the whole selection, BIM and CAD alike — two kinds
    // of highlight on screen should not need two presses to dismiss
    const st = this.st();
    const cadSelected = getCadSession().selected.size > 0;
    if (st.selectedIds.length || cadSelected) {
      if (st.selectedIds.length) this.host.setSelection([]);
      if (cadSelected) clearCadSelection();
      this.scheduleDraw();
      return;
    }
    if (st.activeTool !== 'select') this.host.setActiveTool('select');
  }

  /**
   * Ctrl+A over a CAD drawing: select every entity that currently has ink on
   * screen. The display list is already built against the hidden layers and
   * the file's own layer state, so "everything in the list" IS "everything
   * visible". Deferred to the BIM selection when there is one — Ctrl+A there
   * would be a different, model-mutating kind of "all".
   */
  private selectAllCad(): boolean {
    const cad = getCadSession();
    if (!cad.doc || !cad.list || !cad.visible) return false;
    if (this.st().selectedIds.length) return false;
    const handles = visibleHandles(cad.list, cad.hiddenLayers);
    if (!handles.length) return false;
    setCadSelection(handles);
    this.scheduleDraw();
    return true;
  }

  private deleteSelection(): void {
    const ids = this.st().selectedIds;
    if (!ids.length) return;
    this.host.runCommand(cmdDeleteElements(ids, 'Delete'));
    this.host.setSelection([]);
    this.scheduleDraw();
  }

  private nudge(key: string): void {
    const model = this.getModel();
    const st = this.st();
    if (!st.selectedIds.length) return;
    const g = model.settings.gridSpacing > 0 ? model.settings.gridSpacing : 500;
    const d: Vec2 =
      key === 'ArrowLeft'
        ? { x: -g, y: 0 }
        : key === 'ArrowRight'
          ? { x: g, y: 0 }
          : key === 'ArrowUp'
            ? { x: 0, y: g }
            : { x: 0, y: -g };
    const ids = new Set(st.selectedIds);
    const entries: { id: string; patch: Record<string, unknown> }[] = [];
    for (const id of st.selectedIds) {
      const el = model.get(id);
      if (!el) continue;
      const patch = movePatchFor(el, d, ids, model);
      if (patch) entries.push({ id, patch });
    }
    if (!entries.length) return;
    this.host.runCommand(buildGeometryCommand(model, st.activeLevelId, entries, 'Nudge'));
    this.scheduleDraw();
  }

  private duplicateSelection(): void {
    const model = this.getModel();
    const st = this.st();
    if (!st.selectedIds.length) return;
    const g = model.settings.gridSpacing > 0 ? model.settings.gridSpacing : 500;
    const clones = duplicateElements(model, st.selectedIds, { x: g, y: -g });
    if (!clones.length) return;
    this.host.runCommand(cmdAddElements(clones, 'Duplicate'));
    this.host.setSelection(clones.map((c) => c.id));
    this.scheduleDraw();
  }

  // ---------------- status ----------------

  private pushStatus(): void {
    this.emitStatus({ cursor: this.effPt ?? this.cursorRaw, hint: this.hintFor() });
    this.updatePrecisionOverlay();
  }

  private hintFor(): string {
    const model = this.maybeModel();
    if (!model) return '';
    if (this.pendingBuffer !== null) {
      const mode = this.precisionMode();
      const label =
        mode === 'factor' ? 'Scale factor' : mode === 'angle' ? 'Angle (deg)' : 'Coordinate';
      return `${label}: ${this.pendingBuffer} — Enter confirms · Esc back to mouse`;
    }
    const st = this.st();
    const unit = model.settings.unit;
    const op = this.op;
    let base: string;
    switch (st.activeTool) {
      case 'select':
        if (op.kind === 'move') base = 'Moving — release to commit · Esc cancels';
        else if (op.kind === 'grip') base = 'Drag wall endpoint — snaps to endpoints and grid';
        else if (op.kind === 'textGrip') {
          base = `Text height ${formatLength(this.textGripSize(op), unit)} — release to commit`;
        } else if (op.kind === 'marquee') {
          base = 'Release to select · left→right contains, right→left crosses';
        } else if (this.cadHoverHint) {
          // what the underlay entity under the cursor actually is, and how
          // long it is — measured by cad/metrics.ts, not by this file
          base = this.cadHoverHint;
        } else {
          const cadCount = getCadSession().selected.size;
          base = cadCount
            ? `${cadCount} drawing ${cadCount === 1 ? 'entity' : 'entities'} selected · Esc clears`
            : 'Click to select · drag to move · Shift+click toggles · Del deletes';
        }
        break;
      case 'pan':
        base = 'Drag to pan · scroll to zoom';
        break;
      case 'wall':
        base =
          op.kind === 'chain'
            ? 'Click next point · Enter / Esc / double-click ends · Shift = free angle'
            : 'Click to start a wall chain';
        break;
      case 'line':
        base =
          op.kind === 'two' && op.tool === 'line'
            ? 'Click the end point · Shift = free angle'
            : 'Click the start point';
        break;
      case 'polyline':
        base =
          op.kind === 'polyChain'
            ? 'Click next point · Enter/double-click/right-click ends · click near start to close'
            : 'Click to start a polyline';
        break;
      case 'rectangle':
        base =
          op.kind === 'two' && op.tool === 'rectangle'
            ? 'Click the opposite corner · hold Shift for a square'
            : 'Click the first corner';
        break;
      case 'circle':
        base =
          op.kind === 'two' && op.tool === 'circle'
            ? 'Click to set the radius'
            : 'Click the centre point';
        break;
      case 'arc':
        if (op.kind === 'arcPts') {
          base = op.pts.length === 1 ? 'Click the arc end point' : 'Click a point on the arc';
        } else base = 'Click the arc start point';
        break;
      case 'door':
        if (!this.hoverWall) base = 'Hover a wall to place a door';
        else {
          base = this.hoverWall.valid
            ? 'Click to place door · cursor side sets the swing'
            : 'Wall is too short for this door';
        }
        break;
      case 'window':
        if (!this.hoverWall) base = 'Hover a wall to place a window';
        else {
          base = this.hoverWall.valid
            ? 'Click to place window'
            : 'Wall is too short for this window';
        }
        break;
      case 'column':
        base = 'Click to place column';
        break;
      case 'beam':
        base = op.kind === 'two' && op.tool === 'beam' ? 'Click beam end point' : 'Click beam start point';
        break;
      case 'slab':
        base =
          op.kind === 'two' && op.tool === 'slab'
            ? 'Click the opposite corner'
            : 'Click the first corner of the slab';
        break;
      case 'room':
        base = 'Click inside an enclosed wall region';
        break;
      case 'stair':
        base = model.levelAbove(st.activeLevelId)
          ? 'Click to place stair · R rotates'
          : 'Add a level above first';
        break;
      case 'furniture':
        base = st.activeCatalogId ? 'Click to place · R rotates' : 'Pick an item from the Library tab';
        break;
      case 'dimension':
        if (op.kind === 'dimA') base = 'Pick the second point';
        else if (op.kind === 'dimOffset') base = 'Click to set the dimension side';
        else base = 'Pick the first point';
        break;
      case 'measure':
        if (op.kind === 'two' && op.tool === 'measure' && this.effPt) {
          base = `Distance: ${formatLength(dist(op.a, this.effPt), unit)}`;
        } else if (op.kind === 'measureDone') {
          base = `Distance: ${formatLength(dist(op.a, op.b), unit)} · Esc resets`;
        } else base = 'Pick the first point';
        break;
      case 'text':
        base = 'Click to place text';
        break;
      case 'scale':
      case 'rotate':
      case 'mirror':
        base = this.transformHint(st.activeTool);
        break;
      default:
        base = '';
    }
    if (this.precisionMode() === 'point') base += ' · Type a length, or click';
    return base;
  }

  private transformHint(tool: TransformTool): string {
    const op = this.op;
    if (op.kind !== 'xform' || op.tool !== tool) {
      if (!this.st().selectedIds.length) {
        return 'Select objects first, then pick a base point';
      }
      if (tool === 'scale') return 'Scale: pick base point';
      if (tool === 'rotate') return 'Rotate: pick base point';
      return 'Mirror: pick the first point of the mirror axis';
    }
    if (tool === 'mirror') {
      return 'Mirror: pick the second axis point · Shift constrains to 45° · Esc cancels';
    }
    if (tool === 'scale') {
      if (op.refDist === null) {
        return 'Scale: click a reference point (its distance from the base is 1×) — or type a factor';
      }
      const x = this.currentXform();
      if (!x) return 'Scale: move away from the base point — or type a factor';
      const f = x.lengthFactor;
      return `Scale ${f.toFixed(3)}× — click or type a factor · Shift = 0.25 steps · Esc cancels`;
    }
    const x = this.currentXform();
    if (!x) return 'Rotate: move away from the base point — or type an angle';
    const deg = ((((x.angleDelta * 180) / Math.PI) % 360) + 360) % 360;
    return `Rotate ${deg.toFixed(1)}° — click or type an angle · Shift = 15° steps · Esc cancels`;
  }

  private updateCursor(): void {
    const st = this.st();
    let cursor = 'crosshair';
    if (this.panning) cursor = 'grabbing';
    else if (this.spaceHeld || st.activeTool === 'pan') cursor = 'grab';
    else if (st.activeTool === 'select') cursor = 'default';
    this.canvas.style.cursor = cursor;
  }

  // ---------------- scene assembly ----------------

  private makeGhostWall(a: Vec2, b: Vec2, levelId: string): WallElement {
    return {
      id: '__ghost_wall',
      type: 'wall',
      name: 'Wall',
      levelId,
      material: 'brick',
      start: a,
      end: b,
      thickness: this.opt('wallThickness'),
      height: this.opt('wallHeight'),
    };
  }

  private buildScene(model: BIMModel): Scene {
    const st = this.st();
    const levelId = st.activeLevelId;
    const unit = model.settings.unit;
    const overrides = new Map<string, AnyElement>();
    const ghosts: AnyElement[] = [];
    let readout: Scene['readout'] = null;
    let measure: Scene['measure'] = null;
    let marquee: Scene['marquee'] = null;
    let xform: XformOverlay | null = null;
    const op = this.op;
    const pt = this.effPt;

    if (op.kind === 'move') {
      const d = this.currentMoveDelta();
      if (d && meaningfulDelta(d)) {
        const ids = new Set(op.ids);
        for (const id of op.ids) {
          const el = model.get(id);
          if (!el) continue;
          const patch = movePatchFor(el, d, ids, model);
          if (patch) {
            overrides.set(id, {
              ...structuredClone(el),
              ...structuredClone(patch),
            } as AnyElement);
          }
        }
      }
    } else if (op.kind === 'grip' && pt) {
      const wall = model.get(op.wallId);
      if (wall?.type === 'wall') {
        const merged = structuredClone(wall);
        merged[op.which] = pt;
        overrides.set(wall.id, merged);
        readout = {
          text: formatLength(
            dist(op.which === 'start' ? merged.end : merged.start, pt),
            unit,
          ),
          near: pt,
        };
      }
    } else if (op.kind === 'textGrip') {
      const el = model.get(op.id);
      if (el?.type === 'text') {
        const merged = structuredClone(el);
        merged.size = this.textGripSize(op);
        overrides.set(el.id, merged);
        readout = { text: formatLength(merged.size, unit), near: el.position };
      }
    } else if (op.kind === 'xform') {
      // preview only: the patches are computed exactly as they will be
      // committed, then merged into overrides — the model is never touched
      const x = this.currentXform();
      if (x) {
        for (const e of transformEntries(model, op.ids, x)) {
          const el = model.get(e.id);
          if (!el) continue;
          overrides.set(e.id, {
            ...structuredClone(el),
            ...structuredClone(e.patch),
          } as AnyElement);
        }
        const near = pt ?? op.base;
        if (x.kind === 'scale') readout = { text: `× ${x.lengthFactor.toFixed(3)}`, near };
        else if (x.kind === 'rotate') {
          const deg = ((((x.angleDelta * 180) / Math.PI) % 360) + 360) % 360;
          readout = { text: `${deg.toFixed(1)}°`, near };
        } else {
          const deg = ((((x.axisAngle * 180) / Math.PI) % 180) + 180) % 180;
          readout = { text: `axis ${deg.toFixed(1)}°`, near };
        }
      }
      xform = {
        kind: op.tool,
        base: op.base,
        to: op.tool === 'mirror' && pt ? this.mirrorAxisPoint(op.base, pt) : pt,
        refDist: op.refDist,
      };
    } else if (op.kind === 'marquee') {
      marquee = {
        a: op.startScreen,
        b: op.curScreen,
        crossing: op.curScreen.x < op.startScreen.x,
      };
    } else if (op.kind === 'chain' && pt) {
      if (dist(pt, op.last) > 1) {
        ghosts.push(this.makeGhostWall(op.last, pt, levelId));
        readout = { text: formatLength(dist(op.last, pt), unit), near: pt };
      }
    } else if (op.kind === 'polyChain' && pt) {
      const last = op.points[op.points.length - 1];
      const showCursor = dist(last, pt) > 1;
      const pts = showCursor ? [...op.points, pt] : [...op.points];
      if (pts.length >= 2) {
        ghosts.push({
          id: '__ghost_polyline',
          type: 'refline',
          name: 'Polyline',
          levelId,
          points: pts,
          closed: false,
        });
      }
      if (showCursor) readout = { text: formatLength(dist(last, pt), unit), near: pt };
    } else if (op.kind === 'arcPts' && pt) {
      if (op.pts.length === 1) {
        if (dist(op.pts[0], pt) > 1) {
          ghosts.push({
            id: '__ghost_arc',
            type: 'refline',
            name: 'Arc',
            levelId,
            points: [op.pts[0], pt],
            closed: false,
          });
          readout = { text: formatLength(dist(op.pts[0], pt), unit), near: pt };
        }
      } else {
        const [a, b] = op.pts;
        const arcPts = arcThroughPoints(a, b, pt, 32);
        ghosts.push({
          id: '__ghost_arc',
          type: 'refline',
          name: 'Arc',
          levelId,
          points: arcPts ?? [a, b],
          closed: false,
        });
      }
    } else if (op.kind === 'two' && pt) {
      if (op.tool === 'beam') {
        if (dist(op.a, pt) > 1) {
          ghosts.push({
            id: '__ghost_beam',
            type: 'beam',
            name: 'Beam',
            levelId,
            material: 'concrete',
            start: op.a,
            end: pt,
            width: this.opt('beamWidth'),
            depth: this.opt('beamDepth'),
            offset: 0,
          });
          readout = { text: formatLength(dist(op.a, pt), unit), near: pt };
        }
      } else if (op.tool === 'slab') {
        const dx = Math.abs(pt.x - op.a.x);
        const dy = Math.abs(pt.y - op.a.y);
        if (dx > 1 && dy > 1) {
          ghosts.push({
            id: '__ghost_slab',
            type: 'slab',
            name: 'Slab',
            levelId,
            material: 'concrete',
            outline: rectOutline(op.a, pt),
            thickness: this.opt('slabThickness'),
          });
          readout = {
            text: `${formatLength(dx, unit)} × ${formatLength(dy, unit)}`,
            near: pt,
          };
        }
      } else if (op.tool === 'line') {
        if (dist(op.a, pt) > 1) {
          ghosts.push({
            id: '__ghost_line',
            type: 'refline',
            name: 'Line',
            levelId,
            points: [op.a, pt],
            closed: false,
          });
          readout = { text: formatLength(dist(op.a, pt), unit), near: pt };
        }
      } else if (op.tool === 'rectangle') {
        const corner = this.shiftHeld ? squareCorner(op.a, pt) : pt;
        const dx = Math.abs(corner.x - op.a.x);
        const dy = Math.abs(corner.y - op.a.y);
        if (dx > 1 && dy > 1) {
          ghosts.push({
            id: '__ghost_rect',
            type: 'refline',
            name: 'Rectangle',
            levelId,
            points: rectOutline(op.a, corner),
            closed: true,
          });
          readout = { text: `${formatLength(dx, unit)} × ${formatLength(dy, unit)}`, near: pt };
        }
      } else if (op.tool === 'circle') {
        const r = dist(op.a, pt);
        if (r > 1) {
          ghosts.push({
            id: '__ghost_circle',
            type: 'refline',
            name: 'Circle',
            levelId,
            points: circlePoints(op.a, r, 48),
            closed: true,
          });
          readout = { text: `R ${formatLength(r, unit)}`, near: pt };
        }
      } else {
        measure = { a: op.a, b: pt };
      }
    } else if (op.kind === 'measureDone') {
      measure = { a: op.a, b: op.b };
    } else if (op.kind === 'dimA' && pt) {
      if (dist(op.a, pt) > 1) {
        ghosts.push({
          id: '__ghost_dim',
          type: 'dimension',
          name: 'Dimension',
          levelId,
          start: op.a,
          end: pt,
          offsetDist: 0,
        });
      }
    } else if (op.kind === 'dimOffset' && pt) {
      const d = norm(sub(op.b, op.a));
      ghosts.push({
        id: '__ghost_dim',
        type: 'dimension',
        name: 'Dimension',
        levelId,
        start: op.a,
        end: op.b,
        offsetDist: dot(sub(pt, op.a), perp(d)),
      });
    }

    // idle placement ghosts
    if (op.kind === 'none' && pt && this.cursorRaw) {
      switch (st.activeTool) {
        case 'door':
        case 'window': {
          const hw = this.hoverWall;
          if (hw?.valid) {
            if (st.activeTool === 'door') {
              ghosts.push({
                id: '__ghost_door',
                type: 'door',
                name: 'Door',
                levelId,
                hostWallId: hw.id,
                offset: hw.offset,
                width: hw.width,
                height: hw.height,
                flip: hw.flip,
              });
            } else {
              ghosts.push({
                id: '__ghost_window',
                type: 'window',
                name: 'Window',
                levelId,
                hostWallId: hw.id,
                offset: hw.offset,
                width: hw.width,
                height: hw.height,
                sillHeight: this.opt('sillHeight'),
              });
            }
          }
          break;
        }
        case 'column': {
          const size = this.opt('columnSize');
          ghosts.push({
            id: '__ghost_column',
            type: 'column',
            name: 'Column',
            levelId,
            material: 'concrete',
            position: pt,
            width: size,
            depth: size,
            height: model.getLevel(levelId)?.height ?? DEFAULTS.columnHeight,
            rotation: 0,
          });
          break;
        }
        case 'stair':
          ghosts.push({
            id: '__ghost_stair',
            type: 'stair',
            name: 'Stair',
            levelId,
            material: 'concrete',
            position: pt,
            rotation: this.ghostRotation,
            width: this.opt('stairWidth'),
            length: this.opt('stairLength'),
            toLevelId: '',
          });
          break;
        case 'furniture': {
          const item = this.catalogItem(st.activeCatalogId);
          if (item) {
            ghosts.push({
              id: '__ghost_furniture',
              type: 'furniture',
              name: item.name,
              levelId,
              catalogId: item.id,
              position: pt,
              rotation: this.ghostRotation,
              width: item.width,
              depth: item.depth,
              height: item.height,
            });
          }
          break;
        }
        default:
          break;
      }
    }

    const selection = new Set(st.selectedIds);
    const gripsOk =
      st.activeTool === 'select' &&
      selection.size === 1 &&
      (op.kind === 'none' ||
        op.kind === 'maybeMove' ||
        op.kind === 'grip' ||
        op.kind === 'textGrip');
    const single = gripsOk ? model.get(st.selectedIds[0]) : undefined;
    const showGrips = single?.type === 'wall';
    // the grip tracks the live preview size while it is being dragged
    const singleEff = single ? overrides.get(single.id) ?? single : undefined;
    const textGrip = singleEff?.type === 'text' ? textGripPoint(singleEff) : null;

    return {
      model,
      levelId,
      unit,
      view: this.view,
      w: this.cssW,
      h: this.cssH,
      selection,
      overrides,
      ghosts,
      hoverWallId:
        (st.activeTool === 'door' || st.activeTool === 'window') && this.hoverWall
          ? this.hoverWall.id
          : null,
      snap: this.snap,
      marquee,
      measure,
      readout,
      showGrips,
      xform,
      textGrip,
      colors: this.colors,
      hiddenLayers: new Set(st.hiddenLayers),
      // the session's own set, not a copy: it is replaced (never mutated) on
      // every selection change, so the painter can hold it for the frame
      cadSelection: getCadSession().selected,
      cadHover: this.cadHover,
      catalogItem: (id: string) => this.catalogItem(id),
    };
  }
}
