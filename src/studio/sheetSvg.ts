// DisplayList → the studio sheet SVG.
//
// Same maths as src/cad/svg.ts (the ported exporter), with two additions the
// shell's Viewport contract needs and the exporter deliberately does not have:
//
//   1. every op is emitted inside one of six `<g data-layer="…">` groups —
//      CONC | RBAR | DIMS | TEXT | GRND | SHEET — so the Layers control
//      switches real geometry off (STUDIO_DESIGN §2.2). Real DXF layer names
//      are mapped onto those six ink groups by name (REINF/RFT/BAR → RBAR,
//      DIM → DIMS, …); anything unrecognised is concrete outline ink, which
//      is the safe default because CONC is never hidden by Isolate.
//   2. every op carries `data-handle="<dxf handle>"` so a schedule row's
//      handles[] can highlight its geometry (§6.3, one selection, two views).
//
// Colours are the display list's own resolved screen colours (paper: false),
// so the sheet shows what the CAD renderer resolved — not a repaint.

import { framedBounds, type Bounds } from '../cad/bounds';
import type { DisplayList, DisplayPath, DisplayText } from '../cad/types';
import type { SheetModelMap } from './data';

export type InkGroup = 'CONC' | 'RBAR' | 'DIMS' | 'TEXT' | 'GRND' | 'SHEET';

const GROUP_ORDER: InkGroup[] = ['SHEET', 'CONC', 'GRND', 'RBAR', 'DIMS', 'TEXT'];

const RBAR_RE = /(^|[^A-Z])(REBAR|REINF|RFT|R\/F|BRC|BAR|BARS|STIRRUP|LINK|MESH|STEEL)/i;
const DIMS_RE = /(^|[^A-Z])(DIM|DIMENSION|WITNESS)/i;
const TEXT_RE = /(^|[^A-Z])(TEXT|ANNO|NOTE|CALL|LABEL|LEADER|MARK)/i;
const GRND_RE = /(^|[^A-Z])(GRND|GROUND|GL\b|NGL|EGL|FGL|EARTH|LEVEL|CONTOUR)/i;
const SHEET_RE = /(^|[^A-Z])(TITLE|BORDER|FRAME|SHEET|TBLK|TITLEBLOCK|DEFPOINTS)/i;

/** Map a real DXF layer name (plus the op kind) onto one of the six ink groups. */
export function inkGroupForLayer(layer: string, kind: 'path' | 'text'): InkGroup {
  const name = layer || '';
  if (DIMS_RE.test(name)) return 'DIMS';
  if (RBAR_RE.test(name)) return 'RBAR';
  if (SHEET_RE.test(name)) return 'SHEET';
  if (GRND_RE.test(name)) return 'GRND';
  if (TEXT_RE.test(name) || kind === 'text') return 'TEXT';
  return 'CONC';
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const n = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

/** One read section, to be drawn over the geometry it was cut from. */
export interface SheetHighlight {
  id: string;
  label: string;
  /** the section's own bounds, in MILLIMETRES, exactly as the splitter filed them */
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number };
  /** 'read' is sky blue and filled; 'gap' is an amber outline, never filled */
  kind?: 'read' | 'gap';
}

export interface GroupedSvgOptions {
  /** output width in px; height follows the content aspect ratio */
  width?: number;
  /** margin in px */
  margin?: number;
  fontFamily?: string;
  /**
   * Read sections to outline, drawn INSIDE this SVG.
   *
   * They are emitted here, and not by an overlay of their own, because that is
   * the only way a highlight cannot drift from the drawing: it goes through
   * the very same `X()`/`Y()` closures as every CAD entity on the sheet, into
   * the same viewBox, under the same transform. A second layer has to
   * reconstruct that mapping, and a reconstruction can be wrong — twice it
   * was, once on the transform and once on the frame, and both times the marks
   * were nowhere near the drawing while the arithmetic looked right.
   */
  highlights?: readonly SheetHighlight[];
  /** millimetres per drawing unit — `highlights` are mm, `X`/`Y` take units */
  mmPerUnit?: number;
}

export interface GroupedSheet {
  svg: string;
  widthPx: number;
  heightPx: number;
  /** px per drawing unit, for the model map */
  scale: number;
  marginPx: number;
  /**
   * The drawing-unit box the viewBox frames — `framedBounds`, not the raw
   * extents. Every mm↔px conversion has to read THIS, not `list.min`, or the
   * cursor readout and the editor overlay sit wherever the strays put them.
   */
  frame: Bounds;
  /**
   * How many highlight rectangles were actually emitted.
   *
   * NOT how many sections were handed in. A section whose bounds are
   * degenerate, or which maps to a zero-size box, is silently dropped — and a
   * silently dropped highlight is indistinguishable from a highlight that was
   * never asked for. The count travels with the sheet so the panel can say
   * "9 read, 0 drawable" instead of showing nothing and explaining nothing.
   */
  marksDrawn: number;
}

/**
 * Render the display list into six data-layer groups. Transparent background:
 * the Viewport supplies CAD black itself.
 *
 * The viewBox frames `framedBounds(list)` — the content — and NOT the raw
 * extents. A single entity left at the origin of a drawing that sits at
 * x = 10,240,531 used to take it down to 0.4% of the sheet width: a speck in
 * the corner of a black canvas, indistinguishable from a drawing that failed
 * to load. Everything is still emitted; a stray simply lands outside the
 * viewBox, which is why the svg is `overflow: visible` — the pane clips it,
 * so panning still reaches it (§ src/cad/bounds.ts).
 */
export function groupedSheetSvg(list: DisplayList, opts: GroupedSvgOptions = {}): GroupedSheet {
  const width = opts.width ?? 2000;
  const margin = opts.margin ?? 20;
  const font = opts.fontFamily ?? 'IBM Plex Mono, Helvetica, Arial, sans-serif';

  const frame = framedBounds(list) ?? { min: { ...list.min }, max: { ...list.max } };
  const w = Math.max(1e-6, frame.max.x - frame.min.x);
  const h = Math.max(1e-6, frame.max.y - frame.min.y);
  const scale = (width - margin * 2) / w;
  const height = Math.round(h * scale + margin * 2);

  // model → paper: y flips, because SVG y grows downward
  const X = (x: number): number => margin + (x - frame.min.x) * scale;
  const Y = (y: number): number => margin + (frame.max.y - y) * scale;

  const buckets = new Map<InkGroup, string[]>();
  for (const g of GROUP_ORDER) buckets.set(g, []);

  for (const op of list.ops) {
    const group = inkGroupForLayer(op.layer, op.kind);
    const out = buckets.get(group)!;
    if (op.kind === 'path') {
      const p = op as DisplayPath;
      let d = '';
      for (const sub of p.subpaths) {
        if (sub.length < 2) continue;
        d += `M${n(X(sub[0].x))} ${n(Y(sub[0].y))}`;
        for (let i = 1; i < sub.length; i++) d += `L${n(X(sub[i].x))} ${n(Y(sub[i].y))}`;
        if (p.closed) d += 'Z';
      }
      if (!d) continue;
      const lw = p.lineweight > 0 ? Math.max(0.1, p.lineweight * scale) : 0.5;
      const attrs: string[] = [
        `d="${d}"`,
        `fill="${p.fill ?? 'none'}"`,
        p.fill ? 'fill-rule="evenodd"' : '',
        `stroke="${p.stroke ?? 'none'}"`,
        `stroke-width="${n(lw)}"`,
        'stroke-linecap="round"',
        'stroke-linejoin="round"',
        p.handle ? `data-handle="${esc(p.handle)}"` : '',
      ];
      if (p.dash.length) {
        attrs.push(`stroke-dasharray="${p.dash.map((v) => n(Math.max(0.1, v * scale))).join(' ')}"`);
      }
      if (p.alpha < 1) attrs.push(`opacity="${n(p.alpha)}"`);
      out.push(`<path ${attrs.filter(Boolean).join(' ')}/>`);
    } else {
      const t = op as DisplayText;
      const size = t.height * scale;
      if (size < 1.1) continue; // unreadable at this scale
      const anchor = t.hAlign === 'left' ? 'start' : t.hAlign === 'right' ? 'end' : 'middle';
      const baseline =
        t.vAlign === 'top' ? 'hanging' : t.vAlign === 'middle' ? 'central' : 'alphabetic';
      const x = X(t.position.x);
      const y = Y(t.position.y);
      const lines = t.text.split('\n');
      const lh = size * 1.25;
      const y0 =
        lines.length > 1
          ? t.vAlign === 'middle'
            ? -((lines.length - 1) * lh) / 2
            : t.vAlign === 'bottom' || t.vAlign === 'baseline'
              ? -(lines.length - 1) * lh
              : 0
          : 0;
      const spans = lines
        .map((ln, i) => `<tspan x="${n(x)}" dy="${n(i === 0 ? y0 : lh)}">${esc(ln)}</tspan>`)
        .join('');
      const rot = -(t.rotation * 180) / Math.PI;
      const transform = Math.abs(rot) > 0.01 ? ` transform="rotate(${n(rot)} ${n(x)} ${n(y)})"` : '';
      out.push(
        `<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" fill="${t.color}" ` +
          `text-anchor="${anchor}" dominant-baseline="${baseline}"` +
          (t.alpha < 1 ? ` opacity="${n(t.alpha)}"` : '') +
          transform +
          (t.handle ? ` data-handle="${esc(t.handle)}"` : '') +
          `>${spans}</text>`,
      );
    }
  }

  const body = GROUP_ORDER.map(
    (g) => `<g data-layer="${g}">${buckets.get(g)!.join('')}</g>`,
  ).join('');

  // The read sections, over the ink, in the same coordinate space as the ink.
  // Label size in viewBox units. At width/900 this was 2.4 units — which on a
  // 2200-unit sheet fitted into a ~1000px pane is ONE PIXEL TALL, so every
  // mark has been carrying a name nobody could read. A sheet fits at roughly
  // 0.45 px per unit, so ~30 units is a ~14px label at fit.
  const marks = highlightMarkup(opts.highlights ?? [], X, Y, opts.mmPerUnit ?? 1, width / 70);
  const marksDrawn = (marks.match(/<g class="mark[ "]/g) ?? []).length;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}" ` +
    `preserveAspectRatio="xMidYMid meet" overflow="visible" font-family="${font}">${body}${marks}</svg>`;

  return { svg, widthPx: width, heightPx: height, scale, marginPx: margin, frame, marksDrawn };
}

/**
 * Sky blue over every read section — all of them, always, at once.
 *
 * Not conditional on hover or selection: the point is to see what the drawing
 * HAS been read, which is a property of the sheet, not of the pointer.
 *
 * The fills sit in ONE group carrying the opacity, because sections overlap —
 * a dozen translucent rects stacked compound towards opaque and bury the
 * drawing the wash is describing. A group composites once.
 *
 * A section outside the viewBox is still emitted. The svg is `overflow:
 * visible`, so it paints where it belongs and can be panned to; silently
 * dropping it would be the one thing worse than drawing it off-sheet.
 */
function highlightMarkup(
  highlights: readonly SheetHighlight[],
  X: (x: number) => number,
  Y: (y: number) => number,
  mmPerUnit: number,
  labelSize: number,
): string {
  if (!highlights.length) return '';
  const u = mmPerUnit || 1;

  const boxes = highlights
    .map((h) => {
      // mm -> drawing units -> the sheet's own px, via the SAME X/Y the
      // geometry above went through.
      const xa = X(h.bounds.xMin / u);
      const xb = X(h.bounds.xMax / u);
      const ya = Y(h.bounds.yMax / u);
      const yb = Y(h.bounds.yMin / u);
      return {
        h,
        x: Math.min(xa, xb),
        y: Math.min(ya, yb),
        w: Math.abs(xb - xa),
        hh: Math.abs(yb - ya),
      };
    })
    .filter((b) => b.w > 0 && b.hh > 0);
  if (!boxes.length) return '';

  const rect = (b: (typeof boxes)[number], attrs = ''): string =>
    `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.hh)}"${attrs}/>`;

  // EVERY COLOUR IS A PRESENTATION ATTRIBUTE, not a stylesheet rule.
  //
  // The marks used to be styled entirely from Viewport.css, which made a
  // selector that does not match indistinguishable from a mark that was never
  // emitted — and this overlay has now failed silently three times for three
  // different reasons. Inline attributes mean the highlight is visible from
  // the moment the string is in the DOM, with no stylesheet in the path. The
  // CSS still overrides these for the hover state and the strip's toggle;
  // it is no longer load-bearing for "can you see it at all".
  const SKY = '#0ea5e9';
  const SKY_EDGE = '#38bdf8';
  const AMBER_EDGE = '#fb923c';

  // Only READ sections are filled. A gap is what the read did not reach, and
  // washing it in the colour that means "read" would say the opposite.
  const filled = boxes.filter((b) => b.h.kind !== 'gap');
  const fills = filled.length
    ? // Opacity on the GROUP: sections overlap, and stacked translucent rects
      // compound towards opaque and bury the drawing they describe.
      `<g class="mark-fills" data-testid="mark-fills" opacity="0.3">` +
      filled.map((b) => rect(b, ` fill="${SKY}" stroke="none" data-section="${esc(b.h.id)}"`)).join('') +
      `</g>`
    : '';

  const outlines = boxes
    .map((b) => {
      const gap = b.h.kind === 'gap';
      const edge = gap ? AMBER_EDGE : SKY_EDGE;
      return (
        `<g class="mark${gap ? ' gap' : ''}" data-section="${esc(b.h.id)}" ` +
        `data-mm="${n(b.h.bounds.xMin)},${n(b.h.bounds.yMin)},${n(b.h.bounds.xMax)},${n(b.h.bounds.yMax)}">` +
        rect(
          b,
          ` fill="none" stroke="${edge}" stroke-width="2" vector-effect="non-scaling-stroke"` +
            (gap ? ' stroke-dasharray="6 4"' : ''),
        ) +
        // A LABEL ONLY WHERE ONE FITS. Fitted to a pane, a 700 mm region of a
        // 47 m sheet is fifteen pixels; captioning it writes a name three
        // times wider than the thing it names, and a dozen of those is a wall
        // of text over the drawing. The box is still there, and clicking its
        // row takes the camera to it, which is where the name belongs.
        (b.w > labelSize * 3
          ? `<text x="${n(b.x + labelSize * 0.3)}" y="${n(b.y - labelSize * 0.3)}" ` +
            `font-size="${n(labelSize)}" fill="${edge}" stroke="none">` +
            `${esc(b.h.id)} · ${esc(b.h.label)}</text>`
          : '') +
        `</g>`
      );
    })
    .join('');

  return `<g class="sheet-marks" data-testid="section-marks">${fills}${outlines}</g>`;
}

/**
 * The Viewport's coordinate readout inverts the fitted viewBox back to sheet
 * units, then maps to model millimetres with this. Solving its equations
 * against the transform above:
 *
 *   xMm = x0Mm + vx · mmPerUnit,  with vx in viewBox px
 *   yMm = y0Mm + (heightUnits − vy) · mmPerUnit
 */
export function modelMapFor(list: DisplayList, sheet: GroupedSheet, mmPerDrawingUnit: number): SheetModelMap {
  const mmPerPx = mmPerDrawingUnit / sheet.scale;
  // `sheet.frame`, NOT `list.min` — the transform above is written against the
  // frame, and reading the raw extents here would put every coordinate the
  // status bar shows, and every point the editor draws at, off by the whole
  // distance to the furthest stray in the file.
  return {
    widthUnits: sheet.widthPx,
    heightUnits: sheet.heightPx,
    mmPerUnit: mmPerPx,
    x0Mm: sheet.frame.min.x * mmPerDrawingUnit - sheet.marginPx * mmPerPx,
    // at vy = heightPx − margin the model y is frame.min.y:
    // y0Mm + margin · mmPerPx = min.y · mm  ⇒
    y0Mm: sheet.frame.min.y * mmPerDrawingUnit - sheet.marginPx * mmPerPx,
  };
}

// --- PDF raster underlay ----------------------------------------------------

export interface PdfSheetSvgInput {
  widthPt: number;
  heightPt: number;
  rasterDataUrl: string;
  rasterNote?: string;
}

const PT_TO_MM = 25.4 / 72;

/**
 * A PDF page as a sheet: the raster underlay inside the SHEET group on CAD
 * black. When rasterisation was unavailable the note is shown in place of a
 * blank underlay — the limitation is stated, never faked.
 */
export function pdfSheetSvg(input: PdfSheetSvgInput): { svg: string; model: SheetModelMap } {
  const w = Math.max(1, input.widthPt);
  const h = Math.max(1, input.heightPt);
  const body = input.rasterDataUrl
    ? `<image href="${esc(input.rasterDataUrl)}" x="0" y="0" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"/>`
    : `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" fill="none" stroke="#7f8794" stroke-width="1"/>` +
      `<text x="${n(w / 2)}" y="${n(h / 2)}" fill="#a2a6b0" font-size="${n(Math.max(10, w / 60))}" text-anchor="middle">` +
      `No raster underlay — ${esc(input.rasterNote ?? 'rasterisation unavailable')}</text>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" ` +
    `preserveAspectRatio="xMidYMid meet" font-family="IBM Plex Mono, monospace">` +
    `<g data-layer="SHEET">${body}</g></svg>`;
  return {
    svg,
    // page points → paper millimetres; y-up handled by the Viewport's flip.
    model: { widthUnits: w, heightUnits: h, mmPerUnit: PT_TO_MM, x0Mm: 0, y0Mm: 0 },
  };
}
