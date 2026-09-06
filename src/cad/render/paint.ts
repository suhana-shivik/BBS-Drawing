// ============================================================
// Canvas painter for a resolved CAD display list.
//
// Pure drawing: everything that decides *what* the drawing looks like
// (colour resolution, BYLAYER/BYBLOCK, block flattening, curve tessellation,
// draw order) already happened in the display-list builder. This file only
// decides how those ops reach the framebuffer, and it must not reorder them:
//
//   ops are painted in array order, always.
//
// DXF draw order is the whole reason a plan reads correctly — a wipeout, a
// solid hatch or a white-filled title block painted at the wrong moment
// erases the drawing. So the batching below is strictly order-preserving:
// consecutive stroke-only ops that share a style accumulate into one Path2D,
// and the batch is flushed the instant anything (a style change, a fill, a
// text run, the end of the list) could observe the difference.
//
// The one thing that leaves the list order is the selection highlight, and
// it does so by ADDING a pass rather than by moving anything: highlighted
// ops paint normally, in place, and are then repainted in the selection
// colour once the whole list is down. Nothing later in the list can bury a
// highlight, and the batching of unselected geometry is untouched.
//
// Coordinate space: the caller is expected to have applied the device-pixel
// transform (`ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`), as the 2D editor
// does, so one unit here is one CSS pixel and `opts.width/height` are CSS
// pixels. Line widths are clamped in those units, which is what makes a
// hairline read as the same weight as the editor's 1px strokes.
// ============================================================
import type { Vec2 } from '../../core/types';
import type {
  CadHAlign,
  CadVAlign,
  DisplayList,
  DisplayPath,
  DisplayText,
} from '../types';
import { toModel, type View } from '../../editor/view';
import { LINE_HEIGHT, listBounds, safeWidthFactor } from './bounds';

// ------------------------------------------------------------
// tunables
// ------------------------------------------------------------

/** thin lines must stay visible when zoomed out — AutoCAD does the same */
const MIN_LINE_PX = 1;
/** a lineweight wider than this is almost certainly a plot-scale artefact */
const MAX_LINE_PX = 12;
/** below this on-screen height text is unreadable and expensive to shape */
const MIN_TEXT_PX = 3;
/** a dash pattern finer than this shimmers under pan/zoom — draw solid */
const MIN_DASH_PX = 0.5;
/** collapse points that land within this many px of the previous one */
const SIMPLIFY_PX = 0.35;
/** slack around the viewport so wide strokes straddling the edge still paint */
const CULL_PAD_PX = 24;
/** cap on one batched Path2D so a huge stroke stays rasteriser-friendly */
const MAX_BATCH_POINTS = 60000;
/** an op this transparent contributes nothing */
const MIN_ALPHA = 0.002;

/** fallback selection colour when the caller does not pass one (--selection) */
const DEFAULT_HIGHLIGHT = '#ffb648';
/** extra pen width, in px, a selected op gets over its normal weight */
const HIGHLIGHT_EXTRA_PX = 2;
/** the hover pre-highlight is deliberately lighter than a real selection */
const HOVER_EXTRA_PX = 1.25;
const HOVER_ALPHA = 0.5;
/** a highlighted fill is washed rather than replaced, so the shape still reads */
const HIGHLIGHT_FILL_ALPHA = 0.3;
/**
 * Screen radius of the dot that stands in for selected text too small to draw.
 * Fixed in pixels on purpose: it must stay visible however far you zoom out,
 * which is exactly when the glyphs disappear.
 */
const MARKER_RADIUS_PX = 3.5;

const DEFAULT_FONT_FAMILY = '"Segoe UI", system-ui, sans-serif';

const NO_DASH: number[] = [];

const H_ALIGN: Record<CadHAlign, CanvasTextAlign> = {
  left: 'start',
  center: 'center',
  right: 'end',
};

const V_BASELINE: Record<CadVAlign, CanvasTextBaseline> = {
  baseline: 'alphabetic',
  bottom: 'bottom',
  middle: 'middle',
  top: 'top',
};

// ------------------------------------------------------------
// options / stats
// ------------------------------------------------------------

export interface PaintOptions {
  /** viewport width in the ctx's user units (CSS px under a dpr transform) */
  width: number;
  /** viewport height, same units */
  height: number;
  /** multiplies every op's alpha — underlay dimming; default 1 */
  opacity?: number;
  /** layers hidden without rebuilding the display list */
  hiddenLayers?: ReadonlySet<string> | null;
  /** floor for stroke width in px; default 1 */
  minLineWidth?: number;
  /** ceiling for stroke width in px; default 12 */
  maxLineWidth?: number;
  /** text smaller than this many px is skipped; default 3 */
  minTextPx?: number;
  /** viewport slack in px; default 24 */
  cullPadPx?: number;
  /** point-collapse tolerance in px; 0 disables; default 0.35 */
  simplifyPx?: number;
  /** css font family for text ops; default the app UI stack */
  fontFamily?: string;
  /**
   * Handles (matched against `op.handle`) to draw as selected. Highlighted
   * ops are painted a second time, after the whole normal pass, so nothing
   * drawn later in the list can bury the highlight.
   */
  highlight?: ReadonlySet<string> | null;
  /** css colour for the highlight pass; default the app selection amber */
  highlightColor?: string;
  /** single handle under the cursor, drawn as a lighter pre-highlight */
  hoverHandle?: string | null;
  /** css colour for the hover pass; defaults to `highlightColor` */
  hoverColor?: string;
}

export interface PaintStats {
  /** ops in the list */
  ops: number;
  /** ops that reached the canvas */
  painted: number;
  /** ops rejected by the viewport / layer / alpha tests */
  culled: number;
  /** stroke() calls — the number that says whether batching is working */
  strokes: number;
  fills: number;
  texts: number;
  /** path points sent to the canvas after simplification */
  points: number;
  /** ops repainted by the selection / hover highlight passes */
  highlighted: number;
}

// ------------------------------------------------------------
// style helpers
// ------------------------------------------------------------

/**
 * mm lineweight -> px stroke width. 0 (and anything malformed) is a
 * hairline, which is always exactly the minimum.
 */
function lineWidthPx(mm: number, scale: number, min: number, max: number): number {
  if (!(mm > 0)) return min;
  const px = mm * scale;
  return px < min ? min : px > max ? max : px;
}

/**
 * mm dash pattern -> px, at a given pen width.
 *
 * Returns null for "draw this solid": either the pattern is empty, or every
 * run has collapsed below half a pixel, at which point a dashed line is just
 * a shimmering grey smear that pulses as you pan.
 *
 * Two CAD details the raw conversion gets wrong:
 *  - a linetype dot is a zero-length (or near-zero) run, which canvas draws
 *    as nothing at all. Marks shorter than the pen width are widened to the
 *    pen width, so DOT / DASHDOT / CENTER keep their dots.
 *  - canvas flips the mark/gap roles on every repeat of an odd-length
 *    pattern; CAD restarts the pattern instead. A trailing zero gap keeps
 *    the parity stable, which is what CAD's repeat looks like.
 */
function toDashPx(mm: number[], scale: number, width: number): number[] | null {
  const n = mm.length;
  if (n === 0) return null;
  const px = new Array<number>(n % 2 === 0 ? n : n + 1);
  let widest = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(mm[i]) * scale;
    if (d > widest) widest = d;
    // even entries are the marks, odd are the gaps
    px[i] = (i & 1) === 0 && d < width ? width : d;
  }
  if (widest < MIN_DASH_PX) return null;
  if (n % 2 === 1) px[n] = 0;
  return px;
}

function sameNums(a: number[], b: number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** the builder hands out a fresh dash array per entity, so equal-but-distinct
 *  patterns must still batch together — compare by value, not identity */
function sameDash(a: number[] | null, b: number[] | null): boolean {
  if (a === null || b === null) return a === b;
  return sameNums(a, b);
}

// ------------------------------------------------------------
// geometry -> Path2D
// ------------------------------------------------------------

/**
 * Append an op's subpaths to `path`, model -> screen inline (the same maths
 * as `toScreen`, without the per-point object it allocates — this loop runs
 * millions of times on a real drawing).
 *
 * Points that land within `tol` px of the previously emitted point are
 * dropped: a 400-segment tessellated circle three pixels across becomes two
 * segments, which is the difference between a dense drawing panning at 60fps
 * and at 6. The first and last point of every subpath always survive, so
 * shape and closure are preserved.
 *
 * Returns the number of points emitted.
 */
function addSubpaths(
  path: Path2D,
  op: DisplayPath,
  scale: number,
  tx: number,
  ty: number,
  tol: number,
): number {
  let emitted = 0;
  const subs = op.subpaths;
  for (let s = 0; s < subs.length; s++) {
    const pts = subs[s];
    const n = pts.length;
    if (n === 0) continue;
    const p0 = pts[0];
    let lx = p0.x * scale + tx;
    let ly = ty - p0.y * scale;
    path.moveTo(lx, ly);
    emitted++;
    let kept = 1;
    const last = n - 1;
    for (let i = 1; i < n; i++) {
      const q = pts[i];
      const x = q.x * scale + tx;
      const y = ty - q.y * scale;
      if (i !== last && x - lx < tol && lx - x < tol && y - ly < tol && ly - y < tol) {
        continue;
      }
      path.lineTo(x, y);
      lx = x;
      ly = y;
      kept++;
      emitted++;
    }
    if (kept === 1) {
      // a single-point subpath (a DXF POINT, or geometry collapsed by the
      // simplifier) still has to leave ink behind
      path.lineTo(lx + 0.6, ly);
      emitted++;
    } else if (op.closed) {
      path.closePath();
    }
  }
  return emitted;
}

// ------------------------------------------------------------
// text
// ------------------------------------------------------------

interface TextCtx {
  family: string;
  /** last font string set, keyed by rounded px size */
  fontKey: number;
  fontStr: string;
}

function paintText(
  ctx: CanvasRenderingContext2D,
  t: DisplayText,
  view: View,
  alpha: number,
  minTextPx: number,
  tc: TextCtx,
  /** highlight pass: paint the glyphs in the selection colour instead */
  colorOverride?: string,
): boolean {
  const px = Math.abs(t.height) * view.scale;
  if (!(px >= minTextPx)) return false;

  // font strings are cached by size: a drawing's text clusters into a
  // handful of heights, and `ctx.font = ...` parsing is not free
  const key = Math.round(px * 10);
  if (key !== tc.fontKey) {
    tc.fontKey = key;
    tc.fontStr = `${key / 10}px ${tc.family}`;
  }
  ctx.font = tc.fontStr;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colorOverride ?? t.color;
  ctx.textAlign = H_ALIGN[t.hAlign] ?? 'start';
  ctx.textBaseline = V_BASELINE[t.vAlign] ?? 'alphabetic';

  const sx = t.position.x * view.scale + view.tx;
  const sy = view.ty - t.position.y * view.scale;
  const wf = safeWidthFactor(t.widthFactor);
  const multiline = t.text.indexOf('\n') >= 0;

  // fast path: unrotated, unstretched, single line — the overwhelming
  // majority of annotation. No transform stack, no split.
  if (!multiline && t.rotation === 0 && wf === 1) {
    ctx.fillText(t.text, sx, sy);
    return true;
  }

  ctx.save();
  ctx.translate(sx, sy);
  // screen y is flipped relative to model y, so a CCW model rotation is a
  // CW canvas rotation
  if (t.rotation !== 0) ctx.rotate(-t.rotation);
  // width factor is a horizontal stretch about the anchor. Text is drawn at
  // local x = 0 (textAlign does the justification), so the "divide x by the
  // width factor" correction is exactly 0 here — any future x offset would
  // have to be divided by `wf` to survive this scale.
  if (wf !== 1) ctx.scale(wf, 1);

  if (!multiline) {
    ctx.fillText(t.text, 0, 0);
    ctx.restore();
    return true;
  }

  const lines = t.text.split('\n');
  const lh = px * LINE_HEIGHT;
  // MTEXT grows downward from the attachment point; middle and bottom
  // attachments shift the block so the anchor lands where CAD puts it
  let y0 = 0;
  if (t.vAlign === 'middle') y0 = -((lines.length - 1) * lh) / 2;
  else if (t.vAlign === 'bottom' || t.vAlign === 'baseline') {
    y0 = -(lines.length - 1) * lh;
  }
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], 0, y0 + i * lh);
  ctx.restore();
  return true;
}

// ------------------------------------------------------------
// highlight pass
// ------------------------------------------------------------

interface HighlightPass {
  /** indices into `ops`, collected by the normal pass */
  idx: number[];
  color: string;
  alpha: number;
  /** px added to each op's own pen width */
  extraPx: number;
}

/**
 * Repaint a handful of ops in the selection colour.
 *
 * Runs AFTER the whole normal pass, so a wipeout or a solid hatch drawn later
 * in the list can never bury the highlight. The normal pass is untouched:
 * highlighted ops still paint in their own colour and still merge into the
 * ordinary stroke batches, so batching for unselected geometry is unaffected.
 *
 * Strokes are bucketed by resulting pen width rather than drawn one at a
 * time — "select all" on a 68k-op drawing then costs a handful of stroke()
 * calls instead of 68k of them.
 */
function paintHighlight(
  ctx: CanvasRenderingContext2D,
  ops: DisplayList['ops'],
  pass: HighlightPass,
  view: View,
  minLW: number,
  maxLW: number,
  minTextPx: number,
  simplify: number,
  tc: TextCtx,
  stats: PaintStats,
): void {
  const { scale, tx, ty } = view;
  const { color, alpha, extraPx } = pass;
  const buckets = new Map<number, Path2D>();

  ctx.setLineDash(NO_DASH);
  ctx.lineCap = 'round';
  ctx.globalAlpha = alpha;

  for (let k = 0; k < pass.idx.length; k++) {
    const op = ops[pass.idx[k]];
    stats.highlighted++;
    if (op.kind === 'text') {
      if (paintText(ctx, op, view, alpha, minTextPx, tc, color)) {
        stats.texts++;
        continue;
      }
      // The glyphs were culled for being too small to read — but a SELECTED
      // op must still be findable. This is the common case, not an edge one:
      // selecting every "F5" tag on a plan then zooming to fit them makes the
      // text tiny by construction, so the highlight would silently draw
      // nothing and the selection would look broken.
      //
      // A marker at the text's own position keeps it visible at any zoom, and
      // is drawn at a fixed screen size so it does not vanish as you zoom out.
      const mx = op.position.x * scale + tx;
      const my = ty - op.position.y * scale;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(mx, my, MARKER_RADIUS_PX, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    const w = lineWidthPx(op.lineweight, scale, minLW, maxLW) + extraPx;
    let path = buckets.get(w);
    if (!path) buckets.set(w, (path = new Path2D()));
    const n = addSubpaths(path, op, scale, tx, ty, simplify);
    stats.points += n;
    if (op.fill !== null && n > 0) {
      // a filled op only reads as selected if its fill changes too — washed,
      // not replaced, so a hatch pattern is still recognisable underneath
      const solo = new Path2D();
      addSubpaths(solo, op, scale, tx, ty, simplify);
      ctx.globalAlpha = alpha * HIGHLIGHT_FILL_ALPHA;
      ctx.fillStyle = color;
      ctx.fill(solo, 'evenodd');
      stats.fills++;
    }
  }

  // outlines last, so they sit on top of every wash laid down above
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  for (const [w, path] of buckets) {
    ctx.lineWidth = w;
    ctx.stroke(path);
    stats.strokes++;
  }
}

// ------------------------------------------------------------
// main entry
// ------------------------------------------------------------

/**
 * Paint a resolved display list. `view` is the shared editor transform, so
 * the underlay and the BIM plan stay locked together pixel for pixel.
 *
 * The caller owns clearing / background: this only adds ink.
 */
export function paintDisplayList(
  ctx: CanvasRenderingContext2D,
  list: DisplayList,
  view: View,
  opts: PaintOptions,
): PaintStats {
  const ops = list.ops;
  const stats: PaintStats = {
    ops: ops.length,
    painted: 0,
    culled: 0,
    strokes: 0,
    fills: 0,
    texts: 0,
    points: 0,
    highlighted: 0,
  };
  if (ops.length === 0) return stats;

  const opacity = opts.opacity ?? 1;
  if (opacity <= MIN_ALPHA) return stats;
  const minLW = opts.minLineWidth ?? MIN_LINE_PX;
  const maxLW = opts.maxLineWidth ?? MAX_LINE_PX;
  const minTextPx = opts.minTextPx ?? MIN_TEXT_PX;
  const simplify = opts.simplifyPx ?? SIMPLIFY_PX;
  const hidden = opts.hiddenLayers ?? null;
  const { scale, tx, ty } = view;

  // selection / hover are collected during the normal walk (so the viewport,
  // layer and alpha culls apply to them for free) and repainted afterwards
  const highlight = opts.highlight && opts.highlight.size > 0 ? opts.highlight : null;
  const hoverHandle = opts.hoverHandle ?? null;
  const marking = highlight !== null || hoverHandle !== null;
  const hlIdx: number[] = [];
  const hoverIdx: number[] = [];

  // visible model rect, padded for wide strokes and text that straddles the
  // edge (same idea as src/editor/render.ts:viewRect)
  const a: Vec2 = toModel(view, { x: 0, y: 0 });
  const b: Vec2 = toModel(view, { x: opts.width, y: opts.height });
  const pad = ((opts.cullPadPx ?? CULL_PAD_PX) + maxLW) / scale;
  const rMinX = Math.min(a.x, b.x) - pad;
  const rMaxX = Math.max(a.x, b.x) + pad;
  const rMinY = Math.min(a.y, b.y) - pad;
  const rMaxY = Math.max(a.y, b.y) + pad;

  const bounds = listBounds(list);
  const tc: TextCtx = {
    family: opts.fontFamily ?? DEFAULT_FONT_FAMILY,
    fontKey: -1,
    fontStr: '',
  };

  ctx.save();
  // CAD screen display rounds the joints of wide lineweights; a miter would
  // spike on the sharp corners tessellated curves produce
  ctx.lineJoin = 'round';
  ctx.miterLimit = 4;
  ctx.lineDashOffset = 0;

  // ---- order-preserving stroke batch ----
  let batch: Path2D | null = null;
  let bStroke = '';
  let bWidth = 0;
  let bAlpha = 0;
  let bDash: number[] | null = null;
  let bPoints = 0;

  // one-entry memo for the mm -> px dash conversion. Dashed ops arrive in
  // runs of the same linetype, so this removes the per-op array allocation
  // without a map lookup.
  let memoMm: number[] | null = null;
  let memoWidth = -1;
  let memoPx: number[] | null = null;

  const flush = (): void => {
    if (!batch) return;
    ctx.globalAlpha = bAlpha;
    ctx.strokeStyle = bStroke;
    ctx.lineWidth = bWidth;
    if (bDash) {
      ctx.setLineDash(bDash);
      // butt caps keep dash lengths honest — a round cap would stretch every
      // mark by the pen width and close up the gaps
      ctx.lineCap = 'butt';
    } else {
      ctx.setLineDash(NO_DASH);
      // wide solid strokes get rounded ends, matching AutoCAD's display of
      // lineweights; hairlines stay butt so they meet cleanly
      ctx.lineCap = bWidth > 1.5 ? 'round' : 'butt';
    }
    ctx.stroke(batch);
    stats.strokes++;
    batch = null;
    bPoints = 0;
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];

    if (hidden !== null && hidden.has(op.layer)) {
      stats.culled++;
      continue;
    }
    const alpha = op.alpha * opacity;
    if (!(alpha > MIN_ALPHA)) {
      stats.culled++;
      continue;
    }
    const bi = i * 4;
    if (
      bounds[bi] > rMaxX ||
      bounds[bi + 2] < rMinX ||
      bounds[bi + 1] > rMaxY ||
      bounds[bi + 3] < rMinY
    ) {
      stats.culled++;
      continue;
    }

    // this op survived every cull, so it is genuinely on screen
    if (marking && (op.kind === 'text' || op.stroke !== null || op.fill !== null)) {
      if (highlight !== null && highlight.has(op.handle)) hlIdx.push(i);
      else if (op.handle === hoverHandle) hoverIdx.push(i);
    }

    if (op.kind === 'text') {
      // text can only be drawn once everything queued before it is down
      flush();
      if (paintText(ctx, op, view, alpha, minTextPx, tc)) {
        stats.painted++;
        stats.texts++;
      } else {
        stats.culled++;
      }
      continue;
    }

    const fill = op.fill;
    const stroke = op.stroke;
    if (fill === null && stroke === null) {
      stats.culled++;
      continue;
    }

    const width = lineWidthPx(op.lineweight, scale, minLW, maxLW);
    let dash: number[] | null = null;
    if (stroke !== null && op.dash.length > 0) {
      if (memoMm !== null && width === memoWidth && sameNums(op.dash, memoMm)) {
        dash = memoPx;
      } else {
        dash = toDashPx(op.dash, scale, width);
        memoMm = op.dash;
        memoWidth = width;
        memoPx = dash;
      }
    }

    if (fill !== null) {
      // a filled op needs its own path so it can be filled on its own, and
      // it has to land on top of every stroke queued ahead of it
      const p = new Path2D();
      const n = addSubpaths(p, op, scale, tx, ty, simplify);
      if (n === 0) {
        stats.culled++;
        continue;
      }
      stats.points += n;
      flush();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      // even-odd: hatch islands and donuts are expressed as nested loops in
      // one op and only read correctly under this rule
      ctx.fill(p, 'evenodd');
      stats.fills++;
      stats.painted++;
      if (stroke !== null) {
        // the outline goes into a fresh batch so it still draws over its own
        // fill while remaining mergeable with the ops that follow
        batch = new Path2D();
        batch.addPath(p);
        bStroke = stroke;
        bWidth = width;
        bAlpha = alpha;
        bDash = dash;
        bPoints = n;
      }
      continue;
    }

    // everything from here is stroke-only (a fill-only op returned above)
    if (stroke === null) continue;

    // merge into the running batch when nothing observable changes,
    // otherwise flush and start a new one
    if (
      batch !== null &&
      (bStroke !== stroke ||
        bWidth !== width ||
        bAlpha !== alpha ||
        !sameDash(bDash, dash))
    ) {
      flush();
    }
    if (batch === null) {
      batch = new Path2D();
      bStroke = stroke;
      bWidth = width;
      bAlpha = alpha;
      bDash = dash;
      bPoints = 0;
    }
    const n = addSubpaths(batch, op, scale, tx, ty, simplify);
    if (n === 0) {
      stats.culled++;
      continue;
    }
    stats.points += n;
    bPoints += n;
    stats.painted++;
    if (bPoints >= MAX_BATCH_POINTS) flush();
  }

  flush();

  // hover first, selection over it — a selected op under the cursor must
  // still read as selected
  if (hoverIdx.length > 0 || hlIdx.length > 0) {
    const color = opts.highlightColor ?? DEFAULT_HIGHLIGHT;
    if (hoverIdx.length > 0) {
      paintHighlight(
        ctx,
        ops,
        { idx: hoverIdx, color: opts.hoverColor ?? color, alpha: HOVER_ALPHA, extraPx: HOVER_EXTRA_PX },
        view,
        minLW,
        maxLW,
        minTextPx,
        simplify,
        tc,
        stats,
      );
    }
    if (hlIdx.length > 0) {
      paintHighlight(
        ctx,
        ops,
        { idx: hlIdx, color, alpha: 1, extraPx: HIGHLIGHT_EXTRA_PX },
        view,
        minLW,
        maxLW,
        minTextPx,
        simplify,
        tc,
        stats,
      );
    }
  }

  ctx.globalAlpha = 1;
  ctx.setLineDash(NO_DASH);
  ctx.lineDashOffset = 0;
  ctx.restore();
  return stats;
}
