// ============================================================
// Canvas host for the CAD underlay.
//
// React owns the element and the lifecycle; every pixel comes from
// paintDisplayList. The display list arrives fully built (displayList.ts
// owns that) — this component never inspects or rebuilds it, it only asks
// for a frame when something it draws with has changed.
//
// One frame at a time: prop churn during a drag collapses into a single
// requestAnimationFrame, and the frame reads the latest props from a ref
// rather than whatever was current when it was scheduled.
// ============================================================
import { useCallback, useEffect, useRef } from 'react';
import type { CadDocument, DisplayList, ViewSpec } from '../types';
import type { View } from '../../editor/view';
import { paintDisplayList, type PaintStats } from './paint';
import './cad.css';

export interface CadUnderlayProps {
  /** source document — identity / diagnostics only, geometry comes from `list` */
  document?: CadDocument | null;
  /** already-resolved draw list, built by displayList.ts */
  list: DisplayList;
  /** shared editor transform, so the underlay tracks the BIM plan exactly */
  view: View;
  /** what the list was built for; its hiddenLayers are honoured live */
  viewSpec?: ViewSpec | null;
  /** dims the whole underlay so BIM geometry reads on top; default 1 */
  opacity?: number;
  /** extra class on the host element */
  className?: string;
  /** fired after the first frame in which a given `list` reached the canvas */
  onReady?: () => void;
  /** per-frame paint counters, for the perf overlay */
  onStats?: (stats: PaintStats) => void;
}

export default function CadUnderlay(props: CadUnderlayProps): JSX.Element {
  const { className, viewSpec } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  /** latest props, so a queued frame never paints a stale view */
  const propsRef = useRef(props);
  propsRef.current = props;
  /** the list whose first frame has already been announced */
  const readyRef = useRef<DisplayList | null>(null);

  const draw = useCallback((): void => {
    rafRef.current = 0;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const cw = host.clientWidth;
    const ch = host.clientHeight;
    if (cw < 2 || ch < 2) return;

    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(cw * dpr);
    const ph = Math.round(ch * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // paint in CSS pixels; the device-pixel ratio lives in the transform
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const p = propsRef.current;
    const stats = paintDisplayList(ctx, p.list, p.view, {
      width: cw,
      height: ch,
      opacity: p.opacity ?? 1,
      hiddenLayers: p.viewSpec?.hiddenLayers ?? null,
    });
    p.onStats?.(stats);
    if (readyRef.current !== p.list) {
      readyRef.current = p.list;
      p.onReady?.();
    }
  }, []);

  const schedule = useCallback((): void => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  // container resize + display change (monitor swap alters devicePixelRatio)
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [schedule]);

  // anything the painter reads changed -> one coalesced frame
  useEffect(schedule, [
    schedule,
    props.list,
    props.view,
    props.viewSpec,
    props.opacity,
  ]);

  const cls = ['cad-underlay'];
  if (viewSpec?.paper) cls.push('cad-underlay--paper');
  if (className) cls.push(className);

  return (
    <div ref={hostRef} className={cls.join(' ')} data-cad-doc={props.document?.id}>
      <canvas ref={canvasRef} className="cad-underlay-canvas" />
    </div>
  );
}

export { CadUnderlay };
