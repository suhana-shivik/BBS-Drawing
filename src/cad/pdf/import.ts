// PDF import: pdfjs-dist loads the file; each page becomes a PdfSheet — a
// raster underlay plus a text index in page points (y-up). Two halves, kept
// apart on purpose:
//
//   - text extraction is pure (`textRunsFromItems`, `sheetFromPage` over a
//     structural page-like object) so it runs and tests under vitest/jsdom;
//   - rasterisation needs a real browser canvas. Where none exists (jsdom has
//     no 2d context without the optional `canvas` package) the sheet carries
//     an empty rasterDataUrl and a rasterNote stating the limitation — it
//     never throws and never fakes an image.
//
// Worker wiring is deferred until importPdf actually runs: under Vite the
// worker script is resolved with a `?url` asset import; where that fails or no
// real Worker exists (vitest/jsdom, plain node) the bare module specifier is
// handed to pdf.js, whose "fake worker" dynamic-imports it on the main thread
// (pdfjs-dist ships no exports map, so the subpath resolves in node).
import type { PdfImportResult, PdfSheet, PdfTextRun } from './types';

/** The slice of a pdf.js TextContent item the text index reads. */
export interface PdfTextItemLike {
  str?: string;
  /** pdf.js text matrix [a, b, c, d, e, f] in PDF user space (y-up, points). */
  transform?: number[];
  height?: number;
}

/** The slice of a pdf.js PDFPageProxy the importer touches — mockable in tests. */
export interface PdfPageLike {
  getViewport(params: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: PdfTextItemLike[] }>;
  render?(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): {
    promise: Promise<void>;
  };
}

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * Pure conversion of pdf.js text items to PdfTextRun[]. Positions come off the
 * item's text matrix translation (e, f) — already PDF user space, y-up, points.
 * Whitespace-only items (pdf.js emits many) are dropped; a missing or
 * degenerate height falls back to the matrix's vertical scale.
 */
export function textRunsFromItems(items: PdfTextItemLike[]): PdfTextRun[] {
  const runs: PdfTextRun[] = [];
  for (const item of items) {
    const text = collapse(item.str ?? '');
    if (!text) continue;
    const t = item.transform;
    if (!t || t.length < 6) continue;
    const height =
      typeof item.height === 'number' && item.height > 0 ? item.height : Math.hypot(t[2], t[3]);
    runs.push({ text, x: t[4], y: t[5], height });
  }
  return runs;
}

interface RasterOutcome {
  rasterDataUrl: string;
  rasterNote?: string;
}

/**
 * Browser-only half. Returns an empty data URL with a stated limitation when
 * no 2d canvas exists (jsdom, node) or rendering fails — never throws.
 */
async function rasterisePage(page: PdfPageLike, scale: number): Promise<RasterOutcome> {
  if (typeof document === 'undefined') {
    return { rasterDataUrl: '', rasterNote: 'no DOM: PDF pages rasterise in the browser only' };
  }
  if (typeof page.render !== 'function') {
    return { rasterDataUrl: '', rasterNote: 'page object cannot render (no render method)' };
  }
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom')) {
    // jsdom's getContext both returns null AND logs a not-implemented error;
    // short-circuit so test output stays clean.
    return {
      rasterDataUrl: '',
      rasterNote: 'jsdom: canvas 2d unavailable — text index only, no raster underlay',
    };
  }
  try {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return {
        rasterDataUrl: '',
        rasterNote: 'canvas 2d context unavailable (jsdom/headless): text index only, no raster underlay',
      };
    }
    await page.render({ canvasContext: ctx, viewport }).promise;
    return { rasterDataUrl: canvas.toDataURL('image/png') };
  } catch (err) {
    return {
      rasterDataUrl: '',
      rasterNote: `rasterisation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * One page → one PdfSheet. Width/height are the unscaled (scale 1) viewport,
 * i.e. the page size in points; `scale` affects only raster resolution.
 */
export async function sheetFromPage(
  page: PdfPageLike,
  pageIndex: number,
  scale = 2,
): Promise<PdfSheet> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const texts = textRunsFromItems(content.items);
  const raster = await rasterisePage(page, scale);
  return {
    pageIndex,
    widthPt: viewport.width,
    heightPt: viewport.height,
    rasterDataUrl: raster.rasterDataUrl,
    ...(raster.rasterNote ? { rasterNote: raster.rasterNote } : {}),
    texts,
  };
}

type PdfjsModule = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
          // Real browser under Vite: bundle the worker as an asset URL.
          const mod = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
          pdfjs.GlobalWorkerOptions.workerSrc = mod.default;
        } else {
          // vitest/jsdom or node: no Worker. pdf.js falls back to its fake
          // worker, which dynamic-imports workerSrc on the main thread; the
          // bare specifier resolves through node module resolution.
          pdfjs.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/build/pdf.worker.min.mjs';
        }
      }
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

/**
 * Import a PDF file. `opts.scale` sets raster resolution (default 2 ≈ 144dpi);
 * `opts.fileName` is carried through for register identity fallbacks.
 */
export async function importPdf(
  bytes: ArrayBuffer,
  opts?: { scale?: number; fileName?: string },
): Promise<PdfImportResult> {
  const pdfjs = await loadPdfjs();
  // pdf.js transfers (neuters) the buffer it is given — hand it a copy.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  try {
    const sheets: PdfSheet[] = [];
    for (let i = 0; i < doc.numPages; i += 1) {
      const page = (await doc.getPage(i + 1)) as unknown as PdfPageLike;
      sheets.push(await sheetFromPage(page, i, opts?.scale ?? 2));
    }
    return { fileName: opts?.fileName ?? '', sheets };
  } finally {
    await doc.destroy();
  }
}
