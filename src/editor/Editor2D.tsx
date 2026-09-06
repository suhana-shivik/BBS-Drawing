// The 2D CAD plan editor. A single canvas driven by EditorController;
// React only wires lifecycle + re-render triggers. It holds no tool state.
//
// ============================ integration seam ============================
// Everything the wiring agent needs, in one place. SOURCE's version imported
// the old app store; this one takes a `host` prop, so the shell decides where
// state lives (src/studio/store.ts) and this file stays lifecycle-only.
//
// 1. CONSTRUCT THE CONTROLLER
//      <Editor2D host={host} />
//    where `host` implements EditorHost (host.ts): model(), state(),
//    setSelection(), setActiveTool(), runCommand(), undo(), redo(), and
//    optionally setToolOption(), catalogItem(), promptText().
//    `state()` must return the LIVE shell state each call — it is read on
//    every pointer and key event, never cached.
//    Keep `host` referentially stable (useMemo/useRef): a new identity
//    re-creates the controller and abandons any half-drawn gesture.
//
// 2. FEED IT A VIEW (optional)
//    Omit `view` and the editor fits content itself and owns pan/zoom.
//    Pass `view` + `ownsViewGestures={false}` when the shell's viewport owns
//    pan/zoom; then push every change with the same prop, and the editor
//    re-renders against it without ever moving the view on its own.
//    Let the editor own gestures and subscribe with `onViewChanged` to keep a
//    host-side minimap or scrollbar in step.
//
// 3. FORWARD POINTER EVENTS
//    Nothing to forward: the controller binds pointerdown/move/up/cancel/
//    leave, mousedown, auxclick, dblclick, contextmenu and wheel to THIS
//    canvas itself. A host that overlays its own hit layer must not swallow
//    them — put the overlay behind the canvas or make it pointer-events:none.
//
// 4. SUBSCRIBE TO HINTS
//    Pass `onStatus` and render `{cursor, hint}` in the status bar. It fires
//    with the current value on subscribe and on every phase change, so the bar
//    shows the per-tool, per-phase text of §11 without importing anything.
//
// 5. GET THE CANVAS DRAWN
//    The controller schedules its own frames; this component calls
//    `refresh()` after every React render (model version, selection, tool
//    options, catalogue pick, a new level all funnel through here), which
//    redraws AND re-publishes the hint. Call `refit()` on the ref when a
//    drawing is imported, `zoomToCadSelection()` from a toolbar button.
//
// 6. KEYBOARD — do NOT add a second listener for tool letters. The controller
//    owns them (TOOL_KEYS in tools.ts), listens in the CAPTURE phase at the
//    window so it is first in the propagation path whoever registered first,
//    and stops propagation on what it consumes; a strip renders TOOL_DEFS for
//    its tooltips only. This is the D1/D2 fix and it survives only as long as
//    it stays the one owner — so the shell's own bare-letter branch in
//    StudioShell.tsx's document keydown handler must be deleted when this is
//    wired in, leaving that handler its non-tool shortcuts ('/', Ctrl+K, …).
//    Pass `ownsKeyboard: false` and forward keys to `controller.handleKeyDown`
//    only if the shell needs to route them itself; there is still one owner.
// =========================================================================
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { EditorController, type EditorOptions } from './controller';
import type { EditorHost, EditorStatus } from './host';
import type { View } from './view';
import './editor.css';

export interface Editor2DProps {
  /** the shell adapter — see seam 1 */
  host: EditorHost;
  /** re-arms the tool state machine; pass the shell's active tool id */
  activeTool?: string;
  /** re-arms on a level switch; pass the shell's active level id */
  activeLevelId?: string;
  /** bump to re-frame the view, e.g. after a drawing import (cad.fitNonce) */
  fitNonce?: number;
  /** view owned by the host viewport — see seam 2 */
  view?: View;
  ownsViewGestures?: boolean;
  onViewChanged?: (v: View) => void;
  /** hint + cursor for the status bar — see seam 4 */
  onStatus?: (s: EditorStatus) => void;
  /** imperative handle: refit(), zoomToCadSelection(), setView(), … */
  controllerRef?: Ref<EditorController | null>;
  className?: string;
}

export default function Editor2D({
  host,
  activeTool,
  activeLevelId,
  fitNonce = 0,
  view,
  ownsViewGestures,
  onViewChanged,
  onStatus,
  controllerRef,
  className,
}: Editor2DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctrlRef = useRef<EditorController | null>(null);

  // Callbacks are read through refs so a new inline arrow from the parent
  // never tears down and rebuilds the controller mid-gesture.
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const viewChangedRef = useRef(onViewChanged);
  viewChangedRef.current = onViewChanged;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const options: EditorOptions = {
      view,
      ownsViewGestures,
      onStatus: (s) => statusRef.current?.(s),
      onViewChanged: (v) => viewChangedRef.current?.(v),
    };
    const ctrl = new EditorController(canvas, host, options);
    ctrlRef.current = ctrl;
    return () => {
      ctrl.dispose();
      ctrlRef.current = null;
    };
    // `view` is the INITIAL view only; later changes arrive through setView below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, ownsViewGestures]);

  useImperativeHandle(controllerRef, () => ctrlRef.current, [ctrlRef.current]);

  // §1 — switching tools always abandons whatever was half-drawn
  useEffect(() => {
    ctrlRef.current?.onToolChanged();
  }, [activeTool]);

  useEffect(() => {
    ctrlRef.current?.onLevelChanged();
  }, [activeLevelId]);

  // seam 2 — the host owns the transform: adopt each new one
  useEffect(() => {
    if (view) ctrlRef.current?.setView(view);
  }, [view]);

  // an imported drawing sits at its own coordinates — reframe onto it
  useEffect(() => {
    if (fitNonce > 0) ctrlRef.current?.refit();
  }, [fitNonce]);

  // Redraw AND re-publish the hint after every render (model version,
  // selection, tool options, catalogue pick, a new level ... all funnel
  // through here). Drawing alone was not enough: the hint is written off shell
  // state too, and a pick made in a panel fires no pointer event on the canvas.
  useEffect(() => {
    ctrlRef.current?.refresh();
  });

  return <canvas ref={canvasRef} className={className ?? 'editor2d-canvas'} />;
}
