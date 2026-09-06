// ============================================================
// Rendering the drawing for an orchestrator that can look at it.
//
// WHY RUN 005 NEEDED THIS
//
// The free-hand orchestrator investigated for twenty steps and committed to
// nothing. Its objectives show why: it went looking for the one relationship
// that settles ownership — what a leader terminates on — and asked for it nine
// times. Every call returned nothing, because the graph holds 56 leaders and
// ZERO `points-at` edges. The DXF extractor found the leaders and could not
// resolve their arrowheads.
//
// "Structured extraction could not determine the target" is not the same fact
// as "the drawing has no leader target". On the sheet the line is plainly
// drawn; it simply did not survive parsing. A reader who could SEE it would
// settle the question in a second.
//
// So the orchestrator gets eyes. Not to replace the evidence graph — the graph
// says which objects are in a region and where — but to answer the questions
// the graph cannot: what connects to what, where one detail ends and the next
// begins, which member a leader actually reaches.
//
// RASTERISATION IS INJECTED. SVG generation is pure and runs anywhere; turning
// SVG into pixels needs a DOM in the browser and resvg in Node. Keeping that
// seam explicit is what lets the same renderer serve the app, a test and a
// live run.
// ============================================================
import type { CadDocument, Vec2 } from '../types';
import { buildDisplayList } from '../displayList';
import { displayListToSVG } from '../svg';
import { cropList, frameBounds, padBounds, padToAspect, simplifyForRaster } from '../ai/crops';

export interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** how the sheet is laid out, computed once and reused across crops */
export interface SheetFrame {
  /** where the drawing actually is, strays excluded */
  min: Vec2;
  max: Vec2;
  widthMm: number;
  heightMm: number;
}

/** the same view spec crops.ts renders with — paper space, nothing hidden */
const PAPER = { regionId: null, hiddenLayers: new Set<string>(), paper: true } as const;
const SVG_OPTS = { background: '#ffffff', stroke: '#111111', lineWidth: 1 } as const;
/** ops kept in one raster — beyond this a crop is illegible anyway */
const MAX_OPS = 60_000;

/**
 * Where the drawing is, ignoring strays.
 *
 * `doc.extents` lies on real sheets — the benchmark reports eighteen
 * kilometres because a few orphaned entities sit far outside the frame. The
 * percentile trim in `frameBounds` is what makes a "full sheet" render actually
 * show the sheet.
 */
export function sheetFrame(doc: CadDocument): SheetFrame {
  const list = buildDisplayList(doc, PAPER);
  const f = frameBounds(list);
  return {
    min: f.min,
    max: f.max,
    widthMm: f.max.x - f.min.x,
    heightMm: f.max.y - f.min.y,
  };
}

export interface RenderOptions {
  /** longest edge, pixels */
  px?: number;
  /** grow the box by this fraction, so a crop is not cut at the object edge */
  padFraction?: number;
}

/**
 * One region of the drawing, as SVG.
 *
 * Pure and synchronous. A caller that wants pixels passes the result to a
 * rasteriser for its environment.
 */
export function regionSvg(doc: CadDocument, bounds: Bounds, opts: RenderOptions = {}): string {
  const px = opts.px ?? 1400;
  const full = buildDisplayList(doc, PAPER);
  if (full.ops.length === 0) return '';

  const min = { x: Math.min(bounds.x1, bounds.x2), y: Math.min(bounds.y1, bounds.y2) };
  const max = { x: Math.max(bounds.x1, bounds.x2), y: Math.max(bounds.y1, bounds.y2) };
  const padded = padBounds(min, max, opts.padFraction ?? 0.06);

  const cropped = cropList(full, padded.min, padded.max);
  if (cropped.ops.length === 0) return '';
  const shaped = padToAspect(cropped, 2.5);
  const list = simplifyForRaster(shaped, px, MAX_OPS);
  if (list.ops.length === 0) return '';
  return displayListToSVG(list, { ...SVG_OPTS, width: px });
}

/** The whole sheet, framed on what is actually drawn. */
export function fullSheetSvg(doc: CadDocument, opts: RenderOptions = {}): string {
  const f = sheetFrame(doc);
  return regionSvg(doc, { x1: f.min.x, y1: f.min.y, x2: f.max.x, y2: f.max.y }, {
    px: opts.px ?? 1600,
    padFraction: opts.padFraction ?? 0.02,
  });
}

// ------------------------------------------------------------
// rasterisation — one seam, two implementations
// ------------------------------------------------------------

export type Rasteriser = (svg: string, maxPx: number) => Promise<string>;

/** true when a data URL is a picture rather than an empty string or a stub */
export function validImage(url: string | null | undefined): url is string {
  return typeof url === 'string' && url.startsWith('data:image/') && url.length > 512;
}
