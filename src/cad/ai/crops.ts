// ============================================================
// Images for the model.
//
// A DXF legend is text plus line art. The text is harvested exactly by
// `digest.ts`; the SHAPES are not, and shape is how a legend row is matched to
// the symbol it explains. So the model gets three kinds of picture: the legend
// table, the whole sheet for context, and a thumbnail per symbol.
//
// Everything renders through `buildDisplayList` + `displayListToSVG` — the same
// resolution the screen and every export use — so a thumbnail cannot show
// something the drawing does not. Rasterisation needs a browser (`Image` +
// `<canvas>`), so this module is split: every SVG builder is pure and testable
// in node, and only the final `rasterise` step touches the DOM.
//
// Nothing here computes or transmits a quantity. Images carry shapes only.
// ============================================================
import type {
  CadDocument,
  CadInsert,
  CadLayer,
  CadStyle,
  DisplayList,
  DisplayOp,
  Vec2,
} from '../types';
import type { CropImage, Digest } from './contract';
import { buildDisplayList } from '../displayList';
import { displayListToSVG } from '../svg';
import { collectTexts, findTextCluster, isGeneratedBlock, type TextCluster } from './digest';

// ------------------------------------------------------------
// defaults
// ------------------------------------------------------------

export const SYMBOL_PX = 128;
export const LEGEND_PX = 1024;
export const OVERVIEW_PX = 768;
export const MAX_SYMBOLS = 24;
/** ceiling on the base64 bytes of every image put together */
export const MAX_PAYLOAD_BYTES = 3_500_000;

/**
 * Ops kept per image before uniform decimation kicks in. 20k strokes is more
 * than a 1024 px raster can resolve, and the number doubles as the cap on how
 * long the one unavoidable synchronous step — serialising the SVG — can run.
 */
const MAX_OPS_LARGE = 20_000;
const MAX_OPS_SYMBOL = 6_000;

// ------------------------------------------------------------
// display-list surgery (pure)
// ------------------------------------------------------------

function pathBBox(op: Extract<DisplayOp, { kind: 'path' }>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sub of op.subpaths) {
    for (const p of sub) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** ops that touch the rectangle, with the list's frame set to that rectangle */
export function cropList(list: DisplayList, min: Vec2, max: Vec2): DisplayList {
  const ops: DisplayOp[] = [];
  for (const op of list.ops) {
    if (op.kind === 'text') {
      // a text's drawn extent runs right/up from its anchor; a generous pad
      // keeps a legend row that starts just outside the box from vanishing
      const pad = op.height * 40;
      if (op.position.x < min.x - pad || op.position.x > max.x + pad) continue;
      if (op.position.y < min.y - pad || op.position.y > max.y + pad) continue;
      ops.push(op);
    } else {
      const b = pathBBox(op);
      if (!Number.isFinite(b.minX)) continue;
      if (b.maxX < min.x || b.minX > max.x || b.maxY < min.y || b.minY > max.y) continue;
      ops.push(op);
    }
  }
  return { ops, min: { ...min }, max: { ...max } };
}

/**
 * Drop what the output resolution cannot show, and thin what it can.
 *
 * A 400k-op sheet serialised verbatim is tens of megabytes of SVG string — it
 * would hang the tab before it ever reached the canvas. Sub-pixel ops are
 * invisible at the target size, and a tessellated arc carries 256 points that
 * land on the same three pixels, so both go. What survives is what a reader
 * would actually see.
 */
export function simplifyForRaster(list: DisplayList, targetPx: number, maxOps: number): DisplayList {
  const w = Math.max(1e-6, list.max.x - list.min.x);
  const scale = targetPx / w; // px per model unit
  const minFeature = 0.6 / scale;
  const minStep = 0.5 / scale;

  const kept: DisplayOp[] = [];
  for (const op of list.ops) {
    if (op.kind === 'text') {
      if (op.height * scale < 1.2) continue; // displayListToSVG drops these anyway
      kept.push(op);
      continue;
    }
    const b = pathBBox(op);
    if (!Number.isFinite(b.minX)) continue;
    const extent = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    // a filled speck still reads as a dot; an empty one does not
    if (extent < minFeature && !op.fill) continue;

    const subpaths: Vec2[][] = [];
    for (const sub of op.subpaths) {
      if (sub.length < 2) continue;
      const out: Vec2[] = [sub[0]];
      let last = sub[0];
      for (let i = 1; i < sub.length - 1; i++) {
        const p = sub[i];
        if (Math.abs(p.x - last.x) >= minStep || Math.abs(p.y - last.y) >= minStep) {
          out.push(p);
          last = p;
        }
      }
      out.push(sub[sub.length - 1]);
      if (out.length >= 2) subpaths.push(out);
    }
    if (!subpaths.length) continue;
    kept.push({ ...op, subpaths });
  }

  if (kept.length <= maxOps) return { ops: kept, min: list.min, max: list.max };
  const stride = Math.ceil(kept.length / maxOps);
  const thinned: DisplayOp[] = [];
  for (let i = 0; i < kept.length; i += stride) thinned.push(kept[i]);
  return { ops: thinned, min: list.min, max: list.max };
}

/** widen the narrow axis so a thumbnail is never a one-pixel sliver */
export function padToAspect(list: DisplayList, maxAspect: number): DisplayList {
  let w = list.max.x - list.min.x;
  let h = list.max.y - list.min.y;
  if (!(w > 0) && !(h > 0)) {
    const c = { x: list.min.x, y: list.min.y };
    return { ops: list.ops, min: { x: c.x - 1, y: c.y - 1 }, max: { x: c.x + 1, y: c.y + 1 } };
  }
  w = Math.max(w, 1e-9);
  h = Math.max(h, 1e-9);
  const min = { ...list.min };
  const max = { ...list.max };
  if (w / h > maxAspect) {
    const want = w / maxAspect;
    const grow = (want - h) / 2;
    min.y -= grow;
    max.y += grow;
  } else if (h / w > maxAspect) {
    const want = h / maxAspect;
    const grow = (want - w) / 2;
    min.x -= grow;
    max.x += grow;
  }
  return { ops: list.ops, min, max };
}

/** grow a rectangle by a fraction of its own size */
export function padBounds(min: Vec2, max: Vec2, fraction: number): { min: Vec2; max: Vec2 } {
  const w = Math.max(max.x - min.x, 1e-9);
  const h = Math.max(max.y - min.y, 1e-9);
  const dx = w * fraction;
  const dy = h * fraction;
  return {
    min: { x: min.x - dx, y: min.y - dy },
    max: { x: max.x + dx, y: max.y + dy },
  };
}

/**
 * Where to point the camera for the overview.
 *
 * This mirrors `session.cadBounds()`: drawings routinely carry a stray entity
 * kilometres from the content, and framing it renders the real drawing a few
 * pixels wide. `cadBounds()` itself reads the module-level session rather than
 * a list, so it cannot be called for an arbitrary document — see the note in
 * the module header of `index.ts`.
 */
export function frameBounds(list: DisplayList): { min: Vec2; max: Vec2 } {
  if (list.ops.length === 0) return { min: list.min, max: list.max };
  const xs: number[] = [];
  const ys: number[] = [];
  const stride = Math.max(1, Math.ceil(list.ops.length / 60_000));
  for (let i = 0; i < list.ops.length; i += stride) {
    const op = list.ops[i];
    if (op.kind === 'text') {
      xs.push(op.position.x);
      ys.push(op.position.y);
    } else {
      for (const sub of op.subpaths) {
        const p = sub[0];
        if (p) {
          xs.push(p.x);
          ys.push(p.y);
        }
      }
    }
  }
  if (xs.length < 8) return { min: list.min, max: list.max };

  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const at = (arr: number[], p: number): number =>
    arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)))];

  const core = {
    minX: at(xs, 0.01), maxX: at(xs, 0.99),
    minY: at(ys, 0.01), maxY: at(ys, 0.99),
  };
  const w = Math.max(core.maxX - core.minX, 1);
  const h = Math.max(core.maxY - core.minY, 1);
  const zone = {
    minX: core.minX - w * 3, maxX: core.maxX + w * 3,
    minY: core.minY - h * 3, maxY: core.maxY + h * 3,
  };
  const min = { x: core.minX, y: core.minY };
  const max = { x: core.maxX, y: core.maxY };
  for (const x of xs) {
    if (x >= zone.minX && x <= zone.maxX) {
      if (x < min.x) min.x = x;
      if (x > max.x) max.x = x;
    }
  }
  for (const y of ys) {
    if (y >= zone.minY && y <= zone.maxY) {
      if (y < min.y) min.y = y;
      if (y > max.y) max.y = y;
    }
  }
  if (!(max.x > min.x) || !(max.y > min.y)) return { min: list.min, max: list.max };
  return { min, max };
}

// ------------------------------------------------------------
// SVG builders (pure — node-testable)
// ------------------------------------------------------------

/**
 * Paper mode, not screen mode. The renderer's dark theme puts white lines on near
 * black, and a vision model reads dark-on-light line art markedly better; it is
 * also what the drawing looks like when plotted, which is what the legend was
 * designed for.
 */
const PAPER = { regionId: null, hiddenLayers: new Set<string>(), paper: true } as const;

const SVG_OPTS = { background: '#ffffff', margin: 8 } as const;

/**
 * A throwaway document holding one INSERT of `blockName` at the origin.
 *
 * Layers are cloned visible and unfrozen: a symbol whose geometry sits on a
 * frozen layer would otherwise thumbnail as a blank square, and a blank square
 * is worse than no image — it invites the model to guess.
 */
export function blockPreviewDoc(doc: CadDocument, blockName: string): CadDocument | null {
  const block = doc.blocks.get(blockName.toUpperCase());
  if (!block || block.entities.length === 0) return null;

  const layers = new Map<string, CadLayer>();
  for (const [name, l] of doc.layers) layers.set(name, { ...l, visible: true, frozen: false });
  if (!layers.has('0')) {
    layers.set('0', {
      name: '0',
      color: { kind: 'rgb', hex: '#ffffff' },
      lineweight: -3,
      linetype: 'CONTINUOUS',
      visible: true,
      frozen: false,
      transparency: 0,
    });
  }

  const style: CadStyle = {
    layer: '0',
    color: { kind: 'byLayer' },
    lineweight: -1,
    linetype: '',
    linetypeScale: 1,
    transparency: -1,
    normal: null,
    handle: 'ai-thumb',
  };
  const insert: CadInsert = {
    type: 'insert',
    style,
    blockName: block.name,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    cols: 1,
    rows: 1,
    colSpacing: 0,
    rowSpacing: 0,
  };

  return {
    id: `${doc.id}:thumb:${block.name}`,
    name: block.name,
    sourceFile: doc.sourceFile,
    unitScale: doc.unitScale,
    layers,
    linetypes: doc.linetypes,
    textStyles: doc.textStyles,
    blocks: doc.blocks,
    entities: [insert],
    layouts: [],
    regions: [],
    diagnostics: [],
    extents: null,
  };
}

/** SVG for one symbol, or '' when the block draws nothing */
export function blockThumbnailSvg(doc: CadDocument, blockName: string, px = SYMBOL_PX): string {
  const view = blockPreviewDoc(doc, blockName);
  if (!view) return '';
  const raw = buildDisplayList(view, PAPER);
  if (raw.ops.length === 0) return '';
  const padded = padToAspect(raw, 3);
  const list = simplifyForRaster(padded, px, MAX_OPS_SYMBOL);
  if (list.ops.length === 0) return '';
  return displayListToSVG(list, { ...SVG_OPTS, width: px, margin: Math.max(2, Math.round(px * 0.05)) });
}

/**
 * The two expensive things both sheet-wide crops need: the resolved display
 * list and the text cluster. Building the display list of a 26,000-entity
 * drawing twice costs the better part of a second for nothing, so `buildCrops`
 * computes this once and hands it to both.
 */
export interface SheetContext {
  full: DisplayList;
  cluster: TextCluster | null;
}

export function sheetContext(doc: CadDocument): SheetContext {
  return { full: buildDisplayList(doc, PAPER), cluster: findTextCluster(collectTexts(doc)) };
}

/** SVG of the densest text cluster — the legend — or '' when there isn't one */
export function legendSvg(doc: CadDocument, px = LEGEND_PX, ctx?: SheetContext): string {
  const { full, cluster } = ctx ?? sheetContext(doc);
  if (!cluster) return '';
  if (full.ops.length === 0) return '';

  // If the "cluster" covers most of the sheet it is not a legend, it is the
  // drawing — the overview already shows that, and a duplicate image is spent
  // payload for no new evidence.
  const frame = frameBounds(full);
  const fw = Math.max(frame.max.x - frame.min.x, 1e-9);
  const fh = Math.max(frame.max.y - frame.min.y, 1e-9);
  const cw = cluster.max.x - cluster.min.x;
  const ch = cluster.max.y - cluster.min.y;
  if (cw > fw * 0.6 && ch > fh * 0.6) return '';

  const box = padBounds(cluster.min, cluster.max, 0.12);
  const cropped = padToAspect(cropList(full, box.min, box.max), 3);
  const list = simplifyForRaster(cropped, px, MAX_OPS_LARGE);
  if (list.ops.length === 0) return '';
  return displayListToSVG(list, { ...SVG_OPTS, width: px });
}

/** SVG of the whole sheet, framed the way the editor frames it */
export function overviewSvg(doc: CadDocument, px = OVERVIEW_PX, ctx?: SheetContext): string {
  const full = ctx ? ctx.full : buildDisplayList(doc, PAPER);
  if (full.ops.length === 0) return '';
  const frame = frameBounds(full);
  const cropped = padToAspect(cropList(full, frame.min, frame.max), 2.5);
  const list = simplifyForRaster(cropped, px, MAX_OPS_LARGE);
  if (list.ops.length === 0) return '';
  return displayListToSVG(list, { ...SVG_OPTS, width: px });
}

// ------------------------------------------------------------
// rasterisation (browser only)
// ------------------------------------------------------------

/** hand the event loop back so a long crop run cannot freeze the UI */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** an image decode that never comes back is a read that never starts */
const DECODE_TIMEOUT_MS = 15_000;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // A decode that fires NEITHER onload nor onerror hangs this promise
    // forever, and `renderOverview` is awaited before the agentic read makes
    // its first request — so the whole BBS read stops with no Stop button to
    // press, because there is no fetch to abort yet. Every caller already
    // treats a failure as "no image, carry on with the text", so a timeout is
    // strictly better than waiting.
    const timer = setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      reject(new Error('The SVG took too long to decode.'));
    }, DECODE_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('The SVG could not be decoded as an image.'));
    };
    img.src = url;
  });
}

/**
 * SVG string → PNG data URL.
 *
 * Blob URL first (no base64 round trip for the source), falling back to a data
 * URL because a few environments refuse to load a blob into an `Image`. The
 * SVG is entirely self-contained, so the canvas is never tainted and
 * `toDataURL` is always allowed.
 *
 * Returns '' on any failure — a missing thumbnail costs the model one piece of
 * evidence, while a thrown error would cost the user the whole analysis.
 */
export async function rasterise(svg: string, maxPx: number): Promise<string> {
  if (!svg) return '';
  if (typeof document === 'undefined' || typeof Image === 'undefined') return '';

  let url = '';
  let revoke = false;
  try {
    try {
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      url = URL.createObjectURL(blob);
      revoke = true;
    } catch {
      url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }

    let img: HTMLImageElement;
    try {
      img = await loadImage(url);
    } catch {
      if (!revoke) return '';
      URL.revokeObjectURL(url);
      revoke = false;
      url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      img = await loadImage(url);
    }

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return '';
    const s = Math.min(1, maxPx / w, maxPx / h);
    const cw = Math.max(1, Math.round(w * s));
    const ch = Math.max(1, Math.round(h * s));

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    // opaque white behind the art: a transparent PNG composites to black in
    // several model pipelines, which turns line art into a solid rectangle
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  } finally {
    if (revoke && url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already gone */
      }
    }
  }
}

export async function renderBlockThumbnail(
  doc: CadDocument,
  blockName: string,
  px = SYMBOL_PX,
): Promise<string> {
  return rasterise(blockThumbnailSvg(doc, blockName, px * 2), px);
}

export async function renderLegendCrop(
  doc: CadDocument,
  px = LEGEND_PX,
  ctx?: SheetContext,
): Promise<string> {
  return rasterise(legendSvg(doc, px, ctx), px);
}

export async function renderOverview(
  doc: CadDocument,
  px = OVERVIEW_PX,
  ctx?: SheetContext,
): Promise<string> {
  return rasterise(overviewSvg(doc, px, ctx), px);
}

// ------------------------------------------------------------
// selection + assembly
// ------------------------------------------------------------

const alnum = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]+/g, '');

/**
 * True when the harvested text already spells this block out.
 *
 * If the legend says "MCB — Miniature circuit breaker" then the block called
 * MCB needs no picture: the model can read it. A picture is worth spending on
 * the blocks the text does NOT explain — the `A$C64AE5EFA` cases, which are
 * exactly the ones this whole feature exists for.
 */
export function explainedByText(key: string, samples: readonly string[]): boolean {
  const k = alnum(key);
  if (k.length < 3) return false;
  // a mangled autogenerated name is never "explained" by matching itself
  if (/^A\$[A-Z0-9]{6,}$/i.test(key.trim())) return false;
  for (const s of samples) {
    const t = alnum(s);
    if (t.length > k.length && t.includes(k)) return true;
  }
  return false;
}

/** high-instance blocks the text does not already explain, best first */
export function chooseSymbolKeys(digest: Digest, limit: number): string[] {
  const blocks = digest.items.filter((i) => i.kind === 'block' && !isGeneratedBlock(i.key));
  const scored = blocks.map((i) => ({
    key: i.key,
    count: i.count,
    explained: explainedByText(i.key, digest.textSamples),
  }));
  scored.sort((a, b) => {
    if (a.explained !== b.explained) return a.explained ? 1 : -1;
    return b.count - a.count || a.key.localeCompare(b.key);
  });
  return scored.slice(0, limit).map((s) => s.key);
}

export interface CropOptions {
  maxSymbols?: number;
  symbolPx?: number;
  legendPx?: number;
  overviewPx?: number;
  /** ceiling on the total base64 payload */
  maxBytes?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted;
}

/**
 * Legend, overview, and up to ~24 symbol thumbnails.
 *
 * Yields between images so a 24-symbol run never blocks a frame, and stops
 * adding thumbnails once the payload ceiling is reached — the legend and the
 * overview are rendered first precisely because they are the two images worth
 * keeping when the budget is tight.
 */
export async function buildCrops(
  doc: CadDocument,
  digest: Digest,
  opts: CropOptions = {},
): Promise<CropImage[]> {
  const maxSymbols = opts.maxSymbols ?? MAX_SYMBOLS;
  const symbolPx = opts.symbolPx ?? SYMBOL_PX;
  const maxBytes = opts.maxBytes ?? MAX_PAYLOAD_BYTES;
  const out: CropImage[] = [];
  let bytes = 0;

  const keys = chooseSymbolKeys(digest, maxSymbols);
  const total = 2 + keys.length;
  let done = 0;
  const step = (): void => opts.onProgress?.(++done, total);

  const push = (crop: CropImage): boolean => {
    if (!crop.dataUrl) return false;
    if (bytes + crop.dataUrl.length > maxBytes) return false;
    bytes += crop.dataUrl.length;
    out.push(crop);
    return true;
  };

  if (aborted(opts.signal)) return out;
  // one resolve pass feeds both sheet-wide images
  const ctx = sheetContext(doc);
  await yieldToUi();

  if (aborted(opts.signal)) return out;
  push({ role: 'legend', dataUrl: await renderLegendCrop(doc, opts.legendPx ?? LEGEND_PX, ctx) });
  step();
  await yieldToUi();

  if (aborted(opts.signal)) return out;
  push({ role: 'overview', dataUrl: await renderOverview(doc, opts.overviewPx ?? OVERVIEW_PX, ctx) });
  step();
  await yieldToUi();

  for (const key of keys) {
    if (aborted(opts.signal)) break;
    const dataUrl = await renderBlockThumbnail(doc, key, symbolPx);
    const added = push({ role: 'symbol', key, dataUrl });
    step();
    // a block that draws nothing just yields no image; only a full payload
    // stops the run
    if (!added && bytes > maxBytes * 0.9) break;
    await yieldToUi();
  }

  return out;
}

/** rough transfer size of a crop set, for the progress readout and tests */
export function payloadBytes(crops: readonly CropImage[]): number {
  return crops.reduce((n, c) => n + c.dataUrl.length, 0);
}
