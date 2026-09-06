// A PDF page enters the studio as a raster underlay plus a text index — it
// joins the register (identity read off its text runs), can be viewed, and
// feeds the splitter by image. It NEVER produces CadDocument entities:
// vector-PDF-to-entities conversion is out of scope in v1 and the UI must say
// so rather than fake it.
//
// Coordinates are PDF page points (1/72 inch) in PDF user space: origin at the
// page's bottom-left, y-up.

export interface PdfTextRun {
  text: string;
  /** Left edge of the run's baseline origin, page points. */
  x: number;
  /** Baseline y of the run, page points, y-up. */
  y: number;
  /** Nominal glyph height (≈ font size) in page points. */
  height: number;
}

export interface PdfSheet {
  /** Zero-based page index within the source file. */
  pageIndex: number;
  widthPt: number;
  heightPt: number;
  /**
   * PNG data URL of the rendered page. Empty string when rasterisation is
   * unavailable (no browser canvas — e.g. under jsdom); `rasterNote` then
   * states the limitation so the UI can show it instead of a blank underlay.
   */
  rasterDataUrl: string;
  /** Present only when rasterDataUrl is empty: why no raster was produced. */
  rasterNote?: string;
  texts: PdfTextRun[];
}

export interface PdfImportResult {
  fileName: string;
  sheets: PdfSheet[];
}
