// PDF import, tested without a real PDF. jsdom cannot run pdf.js rendering
// (no 2d canvas without the optional `canvas` package, no Worker), so:
//
// COVERED here:
//   - textRunsFromItems: pure conversion of pdf.js text items (transform
//     matrix, y-up user space) to PdfTextRun[], whitespace/degenerate handling;
//   - sheetFromPage over a mocked page object: page size from the scale-1
//     viewport, text index, and the stated-limitation raster path (empty
//     rasterDataUrl + rasterNote, never a throw, never a fake image);
//   - importPdf page loop and worker guard via a mocked pdfjs-dist module:
//     per-page sheets, fileName carry-through, buffer copy, destroy.
//
// NOT covered (needs a real browser): actual pdf.js parsing of PDF bytes,
// worker wiring through the Vite `?url` asset import, and real rasterisation
// to a PNG data URL.
import { describe, expect, it, vi } from 'vitest';
import { importPdf, sheetFromPage, textRunsFromItems } from '../../src/cad/pdf/import';
import type { PdfPageLike, PdfTextItemLike } from '../../src/cad/pdf/import';

const mockPages: PdfPageLike[] = [];
const getDocumentCalls: unknown[] = [];

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (params: unknown) => {
    getDocumentCalls.push(params);
    return {
      promise: Promise.resolve({
        numPages: mockPages.length,
        getPage: async (n: number) => mockPages[n - 1],
        destroy: async () => {},
      }),
    };
  },
}));

function makePage(items: PdfTextItemLike[]): PdfPageLike {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 841.89 * scale,
      height: 595.28 * scale,
    }),
    getTextContent: async () => ({ items }),
    render: () => ({ promise: Promise.resolve() }),
  };
}

describe('textRunsFromItems', () => {
  it('reads position off the text matrix and keeps y-up page points', () => {
    const runs = textRunsFromItems([
      { str: 'DWG NO. GAMCO-STR-001', transform: [12, 0, 0, 12, 700, 20], height: 12 },
    ]);
    expect(runs).toEqual([{ text: 'DWG NO. GAMCO-STR-001', x: 700, y: 20, height: 12 }]);
  });

  it('drops whitespace-only and transform-less items', () => {
    const runs = textRunsFromItems([
      { str: '   ', transform: [10, 0, 0, 10, 5, 5], height: 10 },
      { str: 'no transform' },
      { str: 'kept', transform: [10, 0, 0, 10, 1, 2], height: 10 },
    ]);
    expect(runs.map((r) => r.text)).toEqual(['kept']);
  });

  it('collapses internal whitespace and falls back to matrix height', () => {
    const runs = textRunsFromItems([{ str: 'REV:   R2', transform: [10, 0, 0, 9, 5, 5], height: 0 }]);
    expect(runs[0].text).toBe('REV: R2');
    expect(runs[0].height).toBe(9);
  });
});

describe('sheetFromPage (jsdom: text index only)', () => {
  const items: PdfTextItemLike[] = [
    { str: 'TITLE: FOOTING DETAILS', transform: [10, 0, 0, 10, 700, 40], height: 10 },
  ];

  it('sizes the sheet at scale 1 and states the raster limitation', async () => {
    const sheet = await sheetFromPage(makePage(items), 0, 2);
    expect(sheet.pageIndex).toBe(0);
    expect(sheet.widthPt).toBeCloseTo(841.89);
    expect(sheet.heightPt).toBeCloseTo(595.28);
    expect(sheet.texts).toEqual([{ text: 'TITLE: FOOTING DETAILS', x: 700, y: 40, height: 10 }]);
    // jsdom has no 2d canvas: the raster is absent and says why.
    expect(sheet.rasterDataUrl).toBe('');
    expect(sheet.rasterNote).toMatch(/canvas|context/i);
  });

  it('handles a page that cannot render at all without throwing', async () => {
    const page: PdfPageLike = {
      getViewport: ({ scale }) => ({ width: 100 * scale, height: 50 * scale }),
      getTextContent: async () => ({ items }),
    };
    const sheet = await sheetFromPage(page, 3, 2);
    expect(sheet.pageIndex).toBe(3);
    expect(sheet.rasterDataUrl).toBe('');
    expect(sheet.rasterNote).toBeTruthy();
  });
});

describe('importPdf (mocked pdfjs-dist)', () => {
  it('emits one sheet per page and carries the file name', async () => {
    mockPages.length = 0;
    mockPages.push(
      makePage([{ str: 'PAGE ONE', transform: [10, 0, 0, 10, 10, 10], height: 10 }]),
      makePage([{ str: 'PAGE TWO', transform: [10, 0, 0, 10, 20, 20], height: 10 }]),
    );
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = await importPdf(bytes, { fileName: 'GAMCO-STR-001 R0.pdf' });

    expect(result.fileName).toBe('GAMCO-STR-001 R0.pdf');
    expect(result.sheets.map((s) => s.pageIndex)).toEqual([0, 1]);
    expect(result.sheets[0].texts[0].text).toBe('PAGE ONE');
    expect(result.sheets[1].texts[0].text).toBe('PAGE TWO');

    // pdf.js neuters the buffer it is handed — importPdf must pass a copy.
    const params = getDocumentCalls[0] as { data: Uint8Array };
    expect(params.data).toBeInstanceOf(Uint8Array);
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
