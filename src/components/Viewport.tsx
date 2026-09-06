
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor2D from '../editor/Editor2D';
import type { EditorController } from '../editor/controller';
import type { View } from '../editor/view';
import { isToolId } from '../editor/tools';
import {
  useStudioData,
  type SheetModelMap,
  type SheetSectionsInfo,
  type StudioSheet,
} from '../studio/data';
import {
  activeLevelIdOf,
  createEditorHost,
  editorStatusBus,
  useEditorModel,
} from '../studio/editorHost';
import { cursorBus, layersFor, stageIsSmallest, useStudio, useStudioStore } from '../studio/store';
import { Icon } from './icons';
import { toast } from './Toasts';
import './Viewport.css';

/** Marks the overlay canvas so the pane's own handlers can stand down. */
const OVERLAY_ATTR = 'data-editor-overlay';

// --- how far the wheel may go ------------------------------------------------
//
// It used to stop at 0.3× and 12×, and neither number came from the drawing:
// a foundation plan two hundred metres across cannot be read at 12×, and a
// site layout will not fit on screen at 0.3×. The ceiling and the floor here
// are NOT a working range — they are the arithmetic's own edge. `sheetView`
// multiplies zoom into a CSS transform and into px-per-mm, and both go to
// garbage (blurred, then NaN) once the scale leaves float's usable middle.
// Anything a person can reach by scrolling is inside them, so in practice the
// zoom is unbounded in both directions.
const ZOOM_FLOOR = 1e-6;
const ZOOM_CEIL = 1e7;
const ZOOM_STEP = 1.12;

/** Wheel/step zoom, guarded against 0, Infinity and NaN — not clamped. */
export function nextZoom(zoom: number, factor: number): number {
  const k = zoom * factor;
  if (!Number.isFinite(k) || k <= 0) return zoom;
  return Math.min(ZOOM_CEIL, Math.max(ZOOM_FLOOR, k));
}

interface Rect {
  width: number;
  height: number;
}

/**
 * Move the sheet and its highlight overlay together.
 *
 * ONE function, because there is no correct state in which only one of them
 * has moved. Two call sites used to write `sheetRef.style.transform` by hand
 * and the overlay was added to only one of them — which left every read
 * highlight sitting at scale 1, pan 0, off the side of a canvas zoomed to
 * 547%, indistinguishable from an overlay that was never rendering.
 */
function applyTransform(
  sheet: React.RefObject<HTMLDivElement>,
  marks: React.RefObject<HTMLDivElement>,
  pan: { x: number; y: number },
  zoom: number,
): void {
  const t = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  if (sheet.current) sheet.current.style.transform = t;
  if (marks.current) marks.current.style.transform = t;
}

/**
 * The editor's View for a sheet framed in a `w × h` pane at `zoom`/`pan`.
 *
 * This is the SAME mapping `readCursor` inverts, written forwards:
 *   fit    = min(w / widthUnits, h / heightUnits)          — the viewBox fit
 *   px     = zoom · (off + fit · (mm − origin) / mmPerUnit) + pan
 * which is affine in mm, so it lands exactly on the editor's
 *   toScreen(v, p) = { x: p.x·scale + tx, y: −p.y·scale + ty }.
 * Returns null when the sheet or the pane has no extent to map onto.
 */
export function sheetView(
  rect: Rect,
  m: SheetModelMap,
  zoom: number,
  pan: { x: number; y: number },
): View | null {
  if (!rect.width || !rect.height) return null;
  if (!m.mmPerUnit || !m.widthUnits || !m.heightUnits) return null;
  const fit = Math.min(rect.width / m.widthUnits, rect.height / m.heightUnits);
  if (!fit) return null;
  const offX = (rect.width - m.widthUnits * fit) / 2;
  const offY = (rect.height - m.heightUnits * fit) / 2;
  const scale = (zoom * fit) / m.mmPerUnit;
  return {
    scale,
    tx: pan.x + zoom * offX - scale * m.x0Mm,
    ty: pan.y + zoom * (offY + m.heightUnits * fit) + scale * m.y0Mm,
  };
}

/**
 * What is actually PAINTED, in client pixels — the union of the ink layers.
 *
 * Measured from the DOM rather than from the model on purpose: this has to be
 * right about the pixels on the screen even when the mapping that put them
 * there is not, and being wrong about that is what "the drawing did not load"
 * has meant every time it has been reported.
 *
 * `.sheet-marks` is excluded: a highlight's label can sit outside the ink, and
 * fitting to a label is not fitting to a drawing.
 */
function inkRect(host: HTMLElement): DOMRect | null {
  const rects = [...host.querySelectorAll<SVGGElement>('svg > [data-layer]')]
    .map((g) => g.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

export function Viewport() {
  const data = useStudioData();
  const store = useStudioStore();
  const { sheets, view, select, ui, editor } = useStudio((s) => ({
    sheets: s.sheets,
    view: s.view,
    select: s.select,
    ui: s.ui,
    editor: s.editor,
  }));
  const sheet = sheets.active ? data.sheets[sheets.active] : null;
  const model = useEditorModel();
  // The drawing's size on the window, for the corner controls below. The dock
  // on this face is the ASSISTANT, so that is the flag the tooltip names.
  const readInfo = sheet?.documentId ? data.sectionsByDoc?.[sheet.documentId] : undefined;
  const sections = readInfo?.sections ?? [];
  const gaps = readInfo?.gaps ?? [];
  const assistantOpen = ui.assistantOpen;
  const smallest = stageIsSmallest(ui);

  const paneRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const marksRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; live: { x: number; y: number } } | null>(null);

  // The host is created ONCE per store: a new identity re-creates the
  // controller and abandons any half-drawn gesture (Editor2D seam 1).
  const host = useMemo(() => createEditorHost(store, { notify: toast }), [store]);
  const controllerRef = useRef<EditorController | null>(null);
  const [paneRect, setPaneRect] = useState<Rect>({ width: 0, height: 0 });

  const activeTool = isToolId(ui.activeTool) ? ui.activeTool : 'select';
  const editorOn = Boolean(sheet && model);

  // integration seam: the real CAD renderer paints here instead of injecting
  // a static SVG string. Everything else in this component stays.
  useEffect(() => {
    const host = sheetRef.current;
    if (!host) return;
    host.innerHTML = sheet ? sheet.svg : '';
    // THE DEPENDENCY IS THE SVG STRING, NOT THE SHEET OBJECT.
    //
    // The Details preview renders the same string through
    // `dangerouslySetInnerHTML`, which React re-applies whenever the STRING
    // differs. This effect used to re-run only when the sheet OBJECT changed —
    // so a rebuild that produced new markup behind a reused object left the
    // canvas holding stale DOM while Details showed the new one. That is
    // exactly the divergence that made the highlights appear in the preview
    // and not on the drawing, and depending on the string costs nothing.
  }, [sheet?.svg, sheet, sections.length]);

  // The strip's overlay toggle, written on the element itself.
  //
  // It was a CSS rule keyed on a class. That is one more selector that has to
  // match for the highlights to be visible at all, and a selector that does not
  // match looks exactly like a highlight that was never drawn — which is the
  // failure this feature has had three times. The marks now carry their own
  // colours as presentation attributes and their own visibility as an inline
  // style, so NOTHING in a stylesheet is required for them to appear.
  // TWO WAYS TO TAKE THE COLOUR OFF, and they mean the same thing to the DOM.
  //
  // The strip's toggle turns the overlay off wholesale; "Deselect all" empties
  // the selection. Both end with the reader wanting the plain drawing — the
  // outlines sit directly on the lines you check them against, so being able
  // to see the geometry underneath is a real thing to want — so both hide the
  // one group rather than one hiding it and the other dimming it to a ghost.
  const marksOff = view.pinnedSections?.length === 0;
  useEffect(() => {
    const g = sheetRef.current?.querySelector<SVGGElement>('.sheet-marks');
    if (g) g.style.display = view.sectionMarks && !marksOff ? '' : 'none';
  }, [view.sectionMarks, marksOff, sheet]);

  // ONE section singled out on the sheet — chosen by clicking its row, or
  // previewed by hovering one. A CHOICE WINS OVER A HOVER: you click a section
  // to find it, then move the mouse towards the drawing to look, and the hover
  // that ends on the way must not take the answer with it.
  //
  // A class toggle, never a re-render: the sheet SVG is multi-megabyte and
  // re-injecting it on every pointer move would be unusable.
  // What is lit: everything CHOSEN, or — when nothing is — whatever the mouse
  // is over. A choice outranks a hover, so moving the mouse away from a row to
  // look at what it lit cannot take the answer with it.
  const pinned = view.pinnedSections;
  const litKey = `${pinned === null ? '*' : pinned.join(',')}|${view.hoverSection ?? ''}`;
  useEffect(() => {
    const host = sheetRef.current;
    if (!host) return;
    const marks = host.querySelector<SVGGElement>('.sheet-marks');
    if (!marks) return;
    // `null` is the resting state — every area outlined, nothing dimmed, so it
    // is not "pinning" any more than an empty selection is.
    const pinning = (pinned?.length ?? 0) > 0;
    const lit = new Set(pinning ? pinned! : view.hoverSection ? [view.hoverSection] : []);
    // INLINE, not a class. The stylesheet no longer colours these at all —
    // the marks render from their own presentation attributes, exactly as they
    // do in the Files preview — so the emphasis is written the same way.
    for (const g of marks.querySelectorAll<SVGGElement>('g[data-section]')) {
      const on = lit.has(g.dataset.section ?? '');
      // Chosen: a heavier border. Not chosen while something is: dimmed to a
      // fifth, never hidden — the coverage picture is the reason they are all
      // drawn, and it would be lost the moment you looked at one of them.
      g.style.opacity = pinning && !on ? '0.18' : '1';
      const rect = g.querySelector('rect');
      if (rect) rect.setAttribute('stroke-width', on ? '4' : '2');
    }
    // The wash stays at the 0.3 the sheet emits — choosing a section does not
    // brighten it past the value the drawing was specified at. The emphasis
    // comes from the others receding instead: chosen 0.3, the rest 0.06.
    for (const r of marks.querySelectorAll<SVGRectElement>('[data-testid="mark-fills"] rect')) {
      const on = lit.has(r.dataset.section ?? '');
      r.style.opacity = pinning && !on ? '0.2' : '1';
    }
    // `litKey` is the STRING of what is lit. `pinned` is a fresh array on
    // every patch, so depending on it would re-run this on unrelated updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [litKey, sheet]);

  // Layer toggles switch real geometry off — the groups carry data-layer ids.
  // Per SHEET (`layersFor`): a layer hidden on one drawing must not carry
  // over and blank out a different one that was never touched.
  const sheetLayers = layersFor(view, sheets.active);
  useEffect(() => {
    const host = sheetRef.current;
    if (!host) return;
    host.querySelectorAll<SVGGElement>('[data-layer]').forEach((g) => {
      const id = g.getAttribute('data-layer') ?? '';
      g.style.display = sheetLayers[id] === false ? 'none' : '';
    });
  }, [sheetLayers, sheet]);

  // §6.3 — the one shared selection: a schedule row's handles light their
  // geometry in selection amber. Ops carry data-handle="<dxf handle>".
  useEffect(() => {
    const host = sheetRef.current;
    if (!host) return;
    host.querySelectorAll<SVGElement>('.sel[data-handle]').forEach((el) => el.classList.remove('sel'));
    if (!select.handles.length) return;
    const wanted = new Set(select.handles);
    host.querySelectorAll<SVGElement>('[data-handle]').forEach((el) => {
      if (wanted.has(el.getAttribute('data-handle') ?? '')) el.classList.add('sel');
    });
  }, [select.handles, sheet]);

  // Apply pan/zoom from the store (drag updates the DOM live, then commits).
  //
  // BOTH LAYERS, ALWAYS. The sheet and the highlight overlay are two absolutely
  // positioned siblings sharing one viewBox, and they are only in register
  // because they carry the SAME transform. Moving one and not the other is not
  // a small misalignment: at 547% zoom the marks stay at scale 1 and pan 0
  // while the drawing is scaled and translated away, so every highlight lands
  // off screen and the overlay reads as "not rendering at all".
  useEffect(() => {
    if (drag.current) return;
    applyTransform(sheetRef, marksRef, view.pan, view.zoom);
  }, [view.pan, view.zoom, sheet]);

  // A DRAWING THAT IS OPEN MUST BE ON SCREEN.
  //
  // Framing is remembered per sheet, so a drawing panned away while hunting
  // for something opens exactly where it was left — off the pane, on a black
  // canvas, indistinguishable from a drawing that failed to load. Zooming does
  // not recover it either: the wheel zooms about the pointer, so an off-screen
  // sheet stays off-screen however far you turn it.
  //
  // Only on OPENING, and only when the sheet misses the pane entirely: panning
  // a drawing off the edge on purpose is a thing people do, and this must not
  // snap it back while they are doing it.
  useEffect(() => {
    if (!sheet) return;
    const pane = paneRef.current;
    const host = sheetRef.current;
    if (!pane || !host) return;
    const p = pane.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    if (!p.width || !h.width) return;
    const overlaps = h.right > p.left && h.left < p.right && h.bottom > p.top && h.top < p.bottom;
    if (!overlaps) {
      store.setZoomPan(1, { x: 0, y: 0 });
      return;
    }
    // AND LEGIBLE. The sheet can fill the pane while the DRAWING is a speck
    // inside it: the viewBox frames what `framedBounds` decided the content
    // is, and on a drawing whose strays it cannot separate that box is a
    // couple of hundred times the ink. The result reads as a failed load, and
    // the only way out is to scroll to 3,700% by hand. Fitting is only worth
    // doing when it changes something, so this is deliberately a rescue and
    // not a policy — a drawing that already fills a quarter of the pane opens
    // exactly as it did before.
    const ink = inkRect(host);
    if (ink && ink.width < p.width * 0.25 && ink.height < p.height * 0.25) store.zoomFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  // FIT THE DRAWING, NOT THE SHEET.
  //
  // The viewBox frames what `framedBounds` decided the content is, and on a
  // drawing whose strays it cannot separate that box can be two hundred times
  // the ink. Setting zoom to 1 then frames the BOX — the drawing lands as a
  // few pixels in the middle of an empty canvas, and the only way to read it
  // is to scroll to 3,700% by hand. So "fit" asks the DOM what was actually
  // painted and frames that instead.
  //
  // Measured from client rects rather than the model, deliberately: this must
  // be right about the pixels on the screen even when the mapping that put
  // them there is not. `.sheet-marks` is excluded — a highlight's label can
  // sit outside the ink, and fitting to a label is not fitting to a drawing.
  useEffect(() => {
    if (!sheet || !view.fitRequest) return;
    const pane = paneRef.current;
    const host = sheetRef.current;
    if (!pane || !host) return;
    const p = pane.getBoundingClientRect();
    if (!p.width || !p.height) return;

    const box = inkRect(host);
    if (!box) {
      // Nothing painted to fit to. Reset rather than leaving the framing
      // wherever it was — an empty sheet at 3,700% reads as a broken one.
      store.setZoomPan(1, { x: 0, y: 0 });
      return;
    }
    const { left, top, width: w, height: h } = box;

    // The rects already carry the current transform, so the new zoom is the
    // current one times however much bigger the ink needs to be. No unbounded
    // growth: `nextZoom` guards the arithmetic's own edges (§ZOOM_FLOOR).
    const grow = Math.min((p.width * 0.9) / w, (p.height * 0.9) / h);
    const k = nextZoom(view.zoom, grow);
    // Un-transform the ink's top-left into pane space, then re-place it at the
    // new scale so its centre lands on the pane's centre.
    const ux = (left - p.left - view.pan.x) / view.zoom;
    const uy = (top - p.top - view.pan.y) / view.zoom;
    store.setZoomPan(k, {
      x: p.width / 2 - (ux + w / view.zoom / 2) * k,
      y: p.height / 2 - (uy + h / view.zoom / 2) * k,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.fitRequest]);

  // --- the overlay's view, derived from the pane's own mapping -------------

  const measurePane = useCallback((): Rect => {
    const pane = paneRef.current;
    if (!pane) return { width: 0, height: 0 };
    const r = pane.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }, []);

  useEffect(() => {
    if (!sheet) return;
    const pane = paneRef.current;
    if (!pane) return;
    setPaneRect(measurePane());
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setPaneRect(measurePane()));
    ro.observe(pane);
    return () => ro.disconnect();
  }, [sheet, measurePane]);

  /**
   * The committed view, handed to the editor as a prop: `Editor2D` adopts each
   * new one with `setView()`. Deriving it here — from the pane rect the cursor
   * readout already uses — is what keeps ONE mapping in the file.
   */
  const editorView = useMemo(
    () => (sheet ? sheetView(paneRect, sheet.model, view.zoom, view.pan) : null),
    [sheet, paneRect, view.zoom, view.pan],
  );

  // A TOOL MAY NOT ACCEPT A CLICK IT CANNOT MAP.
  //
  // Pan is the shell's gesture, and so is everything when no model is open —
  // but there is a third case, and it fails silently. `Editor2D` is given the
  // view as an optional prop; with none it falls back to its OWN default
  // mapping, which is not this drawing's. The overlay was still hot in that
  // window, so a click was accepted and turned into an element at coordinates
  // that have nothing to do with what is on screen. The tool looked dead: it
  // had drawn something, a long way from anywhere.
  //
  // `sheetView` returns null while the pane has no measured size — the first
  // paint after a sheet opens, and any time a ResizeObserver is unavailable.
  // Staying cold through it means the shell pans instead, which is wrong in a
  // small way rather than silently wrong in a large one.
  const overlayHot = editorOn && activeTool !== 'pan' && editorView !== null;

  /** Mid-drag the store has not committed yet, so push imperatively. */
  const pushLiveView = useCallback(
    (zoom: number, pan: { x: number; y: number }) => {
      const ctrl = controllerRef.current;
      if (!ctrl || !sheet) return;
      const v = sheetView(measurePane(), sheet.model, zoom, pan);
      if (v) ctrl.setView(v);
    },
    [sheet, measurePane],
  );

  // R3 "Show on the sheet" / R4a section links: a one-shot focus request asks
  // this viewport to frame a millimetre box. The mm → screen mapping inverts
  // the same fit the cursor readout uses, then pan/zoom centre the box.
  useEffect(() => {
    const f = view.focus;
    if (!f || !sheet || f.sheetId !== sheets.active) return;
    const pane = paneRef.current;
    if (!pane) return;
    const r = pane.getBoundingClientRect();
    const m = sheet.model;
    if (!r.width || !r.height || !m.mmPerUnit || !m.widthUnits || !m.heightUnits) {
      store.clearFocus();
      return;
    }
    const fit = Math.min(r.width / m.widthUnits, r.height / m.heightUnits);
    if (!fit) {
      store.clearFocus();
      return;
    }
    const offX = (r.width - m.widthUnits * fit) / 2;
    const offY = (r.height - m.heightUnits * fit) / 2;
    // mm → base screen px (pan 0, zoom 1); y is up in model space.
    const toPx = (xMm: number, yMm: number) => ({
      x: offX + ((xMm - m.x0Mm) / m.mmPerUnit) * fit,
      y: offY + (m.heightUnits - (yMm - m.y0Mm) / m.mmPerUnit) * fit,
    });
    const a = toPx(f.bounds.xMin, f.bounds.yMin);
    const b = toPx(f.bounds.xMax, f.bounds.yMax);
    const bx = Math.min(a.x, b.x);
    const by = Math.min(a.y, b.y);
    const bw = Math.max(1, Math.abs(b.x - a.x));
    const bh = Math.max(1, Math.abs(b.y - a.y));
    // NO ARTIFICIAL CEILING. This was clamped to 12x, which cannot frame a
    // section of a sheet whose viewBox is two hundred times its ink — the
    // camera stopped short and landed on empty space, which looks exactly like
    // bounds that are wrong. `nextZoom` guards the arithmetic's own edges and
    // nothing else.
    const k = nextZoom(1, 0.85 * Math.min(r.width / bw, r.height / bh));
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    store.setZoomPan(k, { x: r.width / 2 - cx * k, y: r.height / 2 - cy * k });
    store.clearFocus();
  }, [view.focus, sheet, sheets.active, store]);

  // The hint line stops meaning anything the moment the editor is not there.
  useEffect(() => {
    if (!editorOn) editorStatusBus.clear();
    return () => editorStatusBus.clear();
  }, [editorOn]);

  const readCursor = (clientX: number, clientY: number) => {
    const pane = paneRef.current;
    if (!pane || !sheet) return;
    const r = pane.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const px = clientX - r.left;
    const py = clientY - r.top;
    const pan = drag.current ? drag.current.live : view.pan;
    const ux = (px - pan.x) / view.zoom;
    const uy = (py - pan.y) / view.zoom;
    const m = sheet.model;
    const fit = Math.min(r.width / m.widthUnits, r.height / m.heightUnits);
    if (!fit) return;
    const vx = (ux - (r.width - m.widthUnits * fit) / 2) / fit;
    const vy = (uy - (r.height - m.heightUnits * fit) / 2) / fit;
    cursorBus.set({
      xMm: m.x0Mm + vx * m.mmPerUnit,
      yMm: m.y0Mm + (m.heightUnits - vy) * m.mmPerUnit,
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!sheet) return;
    const pane = paneRef.current;
    if (!pane) return;
    const r = pane.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const k = view.zoom;
    const k2 = nextZoom(k, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    if (k2 === k) return;
    store.setZoomPan(k2, {
      x: px - (px - view.pan.x) * (k2 / k),
      y: py - (py - view.pan.y) * (k2 / k),
    });
  };

  /** true when the press landed on the live overlay — the editor's business */
  const fromOverlay = (e: React.PointerEvent | React.MouseEvent): boolean =>
    overlayHot && e.target instanceof Element && e.target.hasAttribute(OVERLAY_ATTR);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!sheet || (e.button !== 0 && e.button !== 1)) return;
    // A left press on the live overlay is a tool click, not a pan. The middle
    // button always pans, under every tool — the controller stands down on it.
    if (e.button === 0 && fromOverlay(e)) return;
    drag.current = { sx: e.clientX, sy: e.clientY, ox: view.pan.x, oy: view.pan.y, live: { ...view.pan } };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    readCursor(e.clientX, e.clientY);
    const d = drag.current;
    if (!d) return;
    d.live = { x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) };
    applyTransform(sheetRef, marksRef, d.live, view.zoom);
    // The SVG moves on the DOM until the drag commits; the canvas has to move
    // with it or the two would be out of register for the whole gesture.
    pushLiveView(view.zoom, d.live);
  };

  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    store.setZoomPan(view.zoom, d.live);
  };

  return (
    <div
      className="viewport"
      data-testid="viewport"
      hidden={false}
      onDoubleClick={(e) => {
        // A double-click on the overlay ends a chain (§8.4); it must not also
        // throw the framing away.
        if (fromOverlay(e)) return;
        if (sheet) store.zoomFit();
      }}
    >
      {sheet ? (
        <div
          ref={paneRef}
          className="pane"
          data-kind="2d"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => cursorBus.set(null)}
        >
          <div
            ref={sheetRef}
            className={`sheet${view.isolate ? ' isolated' : ''}`}
            data-testid="sheet-host"
          />
          {/* The read, drawn back onto the drawing. Styled EXACTLY like the
              sheet host and carried by the same transform, so its viewBox and
              the sheet's land on the same pixels without a second mapping. */}
          {/* No overlay layer. The read-section highlights are emitted INSIDE
              the sheet's own SVG (`highlightMarkup` in studio/sheetSvg.ts), so
              they share the drawing's viewBox, its transform and its X/Y
              mapping by construction rather than by reconstruction. */}
          {editorOn && (
            <EditorOverlay
              host={host}
              controllerRef={controllerRef}
              activeTool={activeTool}
              activeLevelId={activeLevelIdOf(store.getState(), model)}
              view={editorView}
              hot={overlayHot}
            />
          )}
        </div>
      ) : (
        <div className="void">
          <span className="vt">No sheet open</span>
          <span className="vs">
            Open a drawing from the register on the left, or browse the project in Files.
          </span>
        </div>
      )}

      {sheet && (
        <div className="vp-chip">
          {select.memberId || select.handles.length || editor.selectedIds.length ? (
            <>
              <span>Selected</span>
              <b>
                {select.memberId ??
                  (editor.selectedIds.length
                    ? `${editor.selectedIds.length} element${editor.selectedIds.length === 1 ? '' : 's'}`
                    : `${select.handles.length} entities`)}
              </b>
              <span className="sep" />
              <span>
                {editor.selectedIds.length && !select.memberId && !select.handles.length
                  ? 'in the model'
                  : select.source === 'schedule'
                    ? 'from the schedule'
                    : 'on the sheet'}
                {select.rows.length ? ` · ${select.rows.length} row${select.rows.length === 1 ? '' : 's'}` : ''}
              </span>
            </>
          ) : (
            <>
              <span>Nothing selected</span>
              <span className="sep" />
              <span>click geometry, or a schedule row, to select</span>
            </>
          )}
        </div>
      )}

      {/* The window controls, in the drawing's own bottom-right corner (§4.5).
          They render with or WITHOUT a sheet: maximise, then close the last
          drawing, and this pair is the only way the title bar and the register
          come back — nothing closes without leaving a way back (§3). */}
      <div className="vp-window" data-testid="viewport-window-controls">
        <button
          type="button"
          className="vp-win"
          data-testid="stage-minimize"
          disabled={smallest}
          aria-label="Minimize the drawing"
          title={
            ui.maximized
              ? 'Minimize — give the window its title bar back'
              : smallest
                ? 'The drawing is already at its smallest'
                : 'Minimize — bring the register and the assistant back'
          }
          onClick={() => store.minimizeStage()}
        >
          <Icon name="winMin" size={14} />
        </button>
        <button
          type="button"
          className="vp-win"
          data-testid="stage-maximize"
          disabled={ui.maximized}
          aria-label="Maximize the drawing"
          title={
            ui.maximized
              ? 'The drawing already fills the window'
              : ui.treeOpen || assistantOpen
                ? 'Maximize — hide the register and the assistant'
                : 'Maximize — fill the window'
          }
          onClick={() => store.maximizeStage()}
        >
          <Icon name={ui.maximized ? 'winRestore' : 'winMax'} size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * The canvas itself. Split out so the `data-editor-overlay` attribute can be
 * stamped on the element the controller binds to — `Editor2D` forwards only a
 * className, so the attribute is set on the node once it exists.
 */
function EditorOverlay({
  host,
  controllerRef,
  activeTool,
  activeLevelId,
  view,
  hot,
}: {
  host: ReturnType<typeof createEditorHost>;
  controllerRef: React.MutableRefObject<EditorController | null>;
  activeTool: string;
  activeLevelId: string;
  view: View | null;
  hot: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    wrapRef.current?.querySelector('canvas')?.setAttribute(OVERLAY_ATTR, 'true');
  });
  return (
    <div ref={wrapRef} className={`editor-layer${hot ? ' hot' : ''}`} data-testid="editor-layer">
      <Editor2D
        host={host}
        activeTool={activeTool}
        activeLevelId={activeLevelId}
        {...(view ? { view } : {})}
        ownsViewGestures={false}
        onStatus={(s) => editorStatusBus.set(s)}
        controllerRef={controllerRef}
        className="editor-overlay"
      />
    </div>
  );
}
