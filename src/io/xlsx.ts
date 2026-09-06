// ============================================================
// A minimal XLSX (Office Open XML SpreadsheetML) writer — no dependencies.
//
// WHY THIS EXISTS, AND WHY IT IS HAND-ROLLED
//
// This codebase already parses DXF and writes DXF by hand. A schedule that a
// fabricator opens in Excel is the same kind of problem: a well-specified
// container format, a small subset of which we actually need. Pulling in a
// spreadsheet library to emit six XML parts would add megabytes to the bundle
// and put the honesty rules of §6.4 behind someone else's cell model.
//
// THE ZIP IS STORED, NOT DEFLATED.
//
// An .xlsx is a ZIP. Store method (no compression) costs a few hundred KB on a
// large schedule and buys two things: no inflate/deflate implementation to get
// wrong in the browser, and a file whose parts a test can read straight back
// out of the bytes. `readStoredZip` below is that inverse — it exists so the
// writer is checkable by reading what it wrote, rather than by trusting it.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// No sharedStrings (inline strings instead — one less part to keep in sync),
// no cell comments, no charts, no formulas. A cell comment is a hidden place
// to put something, and the one thing this file is used for — saying that a
// number could NOT be computed — must never be hidden. See bbsWorkbook.ts.
// ============================================================

export type XlsxValue = string | number | null;

export type XlsxAlign = 'left' | 'center' | 'right';

export interface XlsxCell {
  /** A number is written as a NUMBER. A string is written as text. Never mixed. */
  v: XlsxValue;
  bold?: boolean;
  italic?: boolean;
  align?: XlsxAlign;
  /** Excel format code, e.g. '#,##0.00'. Ignored for text cells. */
  numFmt?: string;
  /** Grey text — for a row that is not a quantity (a note, a blocked row). */
  muted?: boolean;
  /** Solid background as 'RRGGBB'. */
  fill?: string;
}

export type XlsxRow = readonly XlsxCell[];

export interface XlsxColumn {
  /** Width in Excel's character units. Omit to leave the column at default. */
  width?: number;
}

export interface XlsxSheet {
  name: string;
  columns?: readonly XlsxColumn[];
  /** Rows to keep on screen while the rest scrolls. */
  freezeHeaderRows?: number;
  rows: readonly XlsxRow[];
}

export interface XlsxWorkbook {
  sheets: readonly XlsxSheet[];
}

/** The MIME type of the bytes `writeXlsx` returns. */
export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ------------------------------------------------------------
// text: escaping, sheet names, cell references
// ------------------------------------------------------------

/**
 * XML text escaping.
 *
 * `&<>"'` all become entities — quotes included, so the same function is safe
 * for attribute values. Characters XML 1.0 cannot carry at all (the C0 control
 * range other than tab/LF/CR, and the two non-characters) are STRIPPED rather
 * than escaped: `&#x1;` is not valid XML either, and one stray control byte in
 * a callout string would make the whole workbook unopenable.
 */
export function escapeXml(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += ch;
      continue;
    }
    if (code < 0x20 || code === 0xfffe || code === 0xffff) continue;
    switch (ch) {
      case '&': out += '&amp;'; break;
      case '<': out += '&lt;'; break;
      case '>': out += '&gt;'; break;
      case '"': out += '&quot;'; break;
      case "'": out += '&apos;'; break;
      default: out += ch;
    }
  }
  return out;
}

const FORBIDDEN_IN_SHEET_NAME = /[[\]:*?/\\]/g;

/**
 * Excel's rules for a sheet name: at most 31 characters, none of `[]:*?/\`,
 * not empty, and not wrapped in apostrophes. A name that breaks one of these
 * is not a warning — Excel refuses to open the file.
 */
export function sanitiseSheetName(name: string): string {
  let out = '';
  // Control characters are dropped rather than escaped (see escapeXml), so
  // they are dropped HERE too — otherwise the 31-character limit would be
  // measured on characters that never reach the file.
  for (const ch of name ?? '') {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  out = out.replace(FORBIDDEN_IN_SHEET_NAME, '-');
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/^'+|'+$/g, '').trim();
  if (!out) out = 'Sheet';
  return out.slice(0, 31);
}

/** 0 → 'A', 25 → 'Z', 26 → 'AA'. */
export function columnName(index: number): string {
  let n = Math.max(0, Math.trunc(index));
  let out = '';
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return out;
}

/** A finite number, or null for anything a spreadsheet cannot hold. */
function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function numberText(v: number): string {
  // JS's shortest round-trip form. Both plain and exponential notation are
  // valid xsd:double, which is what <v> holds — so nothing is rounded on the
  // way out. Rounding is the number format's job, and a format never changes
  // the value a fabricator's SUM adds up.
  return String(v);
}

// ------------------------------------------------------------
// styles
// ------------------------------------------------------------

interface StyleKey {
  bold: boolean;
  italic: boolean;
  muted: boolean;
  align: XlsxAlign | '';
  numFmt: string;
  fill: string;
}

const MUTED_RGB = 'FF6B7A92'; // theme's "dim" text — a note is not a quantity

class StyleTable {
  private readonly index = new Map<string, number>();
  private readonly keys: StyleKey[] = [];
  private readonly numFmts = new Map<string, number>();

  constructor() {
    // xf 0 is the default cell format and must exist; a plain cell hashes to
    // it, so an unstyled workbook carries exactly one xf.
    const plain: StyleKey = { bold: false, italic: false, muted: false, align: '', numFmt: '', fill: '' };
    this.keys.push(plain);
    this.index.set(StyleTable.hash(plain), 0);
  }

  private static hash(k: StyleKey): string {
    return `${k.bold ? 'b' : ''}|${k.italic ? 'i' : ''}|${k.muted ? 'm' : ''}|${k.align}|${k.numFmt}|${k.fill}`;
  }

  idFor(cell: XlsxCell): number {
    const key: StyleKey = {
      bold: !!cell.bold,
      italic: !!cell.italic,
      muted: !!cell.muted,
      align: cell.align ?? '',
      // A format code is meaningless on a text cell; dropping it here keeps
      // the style table from splitting on something invisible.
      numFmt: typeof cell.v === 'number' ? (cell.numFmt ?? '') : '',
      fill: (cell.fill ?? '').replace(/^#/, '').toUpperCase(),
    };
    const hash = StyleTable.hash(key);
    const hit = this.index.get(hash);
    if (hit !== undefined) return hit;
    const id = this.keys.length;
    this.keys.push(key);
    this.index.set(hash, id);
    if (key.numFmt && !this.numFmts.has(key.numFmt)) {
      this.numFmts.set(key.numFmt, 164 + this.numFmts.size);
    }
    return id;
  }

  xml(): string {
    // fonts: 0 is the default; each distinct (bold, italic, muted) combination
    // gets one more.
    const fontKeys: string[] = ['|'];
    const fontIndex = new Map<string, number>([['|', 0]]);
    const fillKeys: string[] = ['', '']; // 0 none, 1 gray125 — Excel requires both
    const fillIndex = new Map<string, number>();

    const fontOf = (k: StyleKey): number => {
      const hash = `${k.bold ? 'b' : ''}${k.italic ? 'i' : ''}|${k.muted ? 'm' : ''}`;
      const hit = fontIndex.get(hash);
      if (hit !== undefined) return hit;
      const id = fontKeys.length;
      fontKeys.push(hash);
      fontIndex.set(hash, id);
      return id;
    };
    const fillOf = (rgb: string): number => {
      if (!rgb) return 0;
      const hit = fillIndex.get(rgb);
      if (hit !== undefined) return hit;
      const id = fillKeys.length;
      fillKeys.push(rgb);
      fillIndex.set(rgb, id);
      return id;
    };

    const xfs = this.keys.map((k) => {
      const fontId = fontOf(k);
      const fillId = fillOf(k.fill);
      const numFmtId = k.numFmt ? this.numFmts.get(k.numFmt)! : 0;
      const attrs = [
        `numFmtId="${numFmtId}"`,
        `fontId="${fontId}"`,
        `fillId="${fillId}"`,
        'borderId="0"',
        'xfId="0"',
      ];
      if (numFmtId) attrs.push('applyNumberFormat="1"');
      if (fontId) attrs.push('applyFont="1"');
      if (fillId) attrs.push('applyFill="1"');
      if (k.align) attrs.push('applyAlignment="1"');
      return k.align
        ? `<xf ${attrs.join(' ')}><alignment horizontal="${k.align}" vertical="center"/></xf>`
        : `<xf ${attrs.join(' ')}/>`;
    });

    const fonts = fontKeys.map((hash) => {
      const bold = hash.includes('b');
      const italic = hash.includes('i');
      const muted = hash.includes('m');
      return (
        '<font>' +
        (bold ? '<b/>' : '') +
        (italic ? '<i/>' : '') +
        '<sz val="11"/>' +
        (muted ? `<color rgb="${MUTED_RGB}"/>` : '<color theme="1"/>') +
        '<name val="Calibri"/><family val="2"/><scheme val="minor"/>' +
        '</font>'
      );
    });

    const fills = fillKeys.map((rgb, i) => {
      if (i === 0) return '<fill><patternFill patternType="none"/></fill>';
      if (i === 1) return '<fill><patternFill patternType="gray125"/></fill>';
      return `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
    });

    const numFmtXml = this.numFmts.size
      ? `<numFmts count="${this.numFmts.size}">${[...this.numFmts]
          .map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`)
          .join('')}</numFmts>`
      : '';

    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      numFmtXml +
      `<fonts count="${fonts.length}">${fonts.join('')}</fonts>` +
      `<fills count="${fills.length}">${fills.join('')}</fills>` +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '<dxfs count="0"/>' +
      '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
      '</styleSheet>'
    );
  }
}

// ------------------------------------------------------------
// worksheet
// ------------------------------------------------------------

function sheetXml(sheet: XlsxSheet, styles: StyleTable): string {
  const rows: string[] = [];
  let maxCol = 0;

  sheet.rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((cell, c) => {
      const s = styles.idFor(cell);
      const ref = `${columnName(c)}${r + 1}`;
      const numeric = finite(cell.v);
      if (numeric !== null) {
        cells.push(`<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${numberText(numeric)}</v></c>`);
        maxCol = Math.max(maxCol, c + 1);
        return;
      }
      const text = typeof cell.v === 'string' ? cell.v : '';
      if (text) {
        // xml:space="preserve" so a leading indent in a note survives.
        cells.push(
          `<c r="${ref}"${s ? ` s="${s}"` : ''} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`,
        );
        maxCol = Math.max(maxCol, c + 1);
        return;
      }
      // Empty. Emitted only when it carries a style (a shaded or greyed blank
      // still has to look like part of its row); otherwise it costs nothing to
      // leave out entirely.
      if (s) {
        cells.push(`<c r="${ref}" s="${s}"/>`);
        maxCol = Math.max(maxCol, c + 1);
      }
    });
    if (cells.length) rows.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });

  const lastRow = Math.max(1, sheet.rows.length);
  const dimension = `<dimension ref="A1:${columnName(Math.max(0, maxCol - 1))}${lastRow}"/>`;

  const freeze = Math.max(0, Math.trunc(sheet.freezeHeaderRows ?? 0));
  const pane = freeze
    ? `<pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${freeze + 1}" sqref="A${freeze + 1}"/>`
    : '';
  const views = `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>`;

  const cols = (sheet.columns ?? [])
    .map((col, i) =>
      col?.width
        ? `<col min="${i + 1}" max="${i + 1}" width="${col.width}" customWidth="1"/>`
        : '',
    )
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    dimension +
    views +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${rows.join('')}</sheetData>` +
    '</worksheet>'
  );
}

// ------------------------------------------------------------
// the package
// ------------------------------------------------------------

const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Unique, sanitised sheet names — Excel refuses a workbook with a duplicate. */
function uniqueNames(sheets: readonly XlsxSheet[]): string[] {
  const seen = new Set<string>();
  return sheets.map((sheet, i) => {
    const base = sanitiseSheetName(sheet.name || `Sheet${i + 1}`);
    if (!seen.has(base.toLowerCase())) {
      seen.add(base.toLowerCase());
      return base;
    }
    for (let n = 2; ; n += 1) {
      const suffix = ` (${n})`;
      const candidate = base.slice(0, 31 - suffix.length) + suffix;
      if (!seen.has(candidate.toLowerCase())) {
        seen.add(candidate.toLowerCase());
        return candidate;
      }
    }
  });
}

/**
 * Render a workbook to .xlsx bytes.
 *
 * Returns bytes rather than a Blob so this module stays pure and testable in
 * node. The caller wraps: `new Blob([writeXlsx(book)], { type: XLSX_MIME })`.
 */
export function writeXlsx(book: XlsxWorkbook): Uint8Array {
  const sheets = book.sheets.length ? book.sheets : [{ name: 'Sheet1', rows: [] }];
  const names = uniqueNames(sheets);
  const styles = new StyleTable();
  // Sheets first: building them fills the style table the styles part needs.
  const sheetParts = sheets.map((sheet) => sheetXml(sheet, styles));

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Types xmlns="${CONTENT_TYPES_NS}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets
      .map(
        (_s, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${REL_NS}">` +
    `<Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    '</Relationships>';

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_REL}">` +
    '<sheets>' +
    names
      .map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('') +
    '</sheets>' +
    '</workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${REL_NS}">` +
    sheets
      .map(
        (_s, i) =>
          `<Relationship Id="rId${i + 1}" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="${OFFICE_REL}/styles" Target="styles.xml"/>` +
    '</Relationships>';

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: utf8(contentTypes) },
    { name: '_rels/.rels', data: utf8(rootRels) },
    { name: 'xl/workbook.xml', data: utf8(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRels) },
    { name: 'xl/styles.xml', data: utf8(styles.xml()) },
    ...sheetParts.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(xml) })),
  ];

  return zipStore(entries);
}

// ------------------------------------------------------------
// ZIP — store method, written by hand
// ------------------------------------------------------------

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const encoder = new TextEncoder();
const utf8 = (s: string): Uint8Array => encoder.encode(s);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A fixed DOS timestamp (1980-01-01 00:00). The same workbook must produce the
// same bytes twice — a file that differs only by the second it was written
// cannot be compared against the one that was checked.
const DOS_TIME = 0;
const DOS_DATE = 33; // (0 << 9) | (1 << 5) | 1

/** ZIP archive, store method only. */
export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  const names = entries.map((e) => utf8(e.name));
  const crcs = entries.map((e) => crc32(e.data));

  let localSize = 0;
  for (let i = 0; i < entries.length; i += 1) localSize += 30 + names[i].length + entries[i].data.length;
  let centralSize = 0;
  for (let i = 0; i < entries.length; i += 1) centralSize += 46 + names[i].length;

  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];

  const u16 = (v: number) => {
    view.setUint16(at, v, true);
    at += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(at, v >>> 0, true);
    at += 4;
  };
  const bytes = (b: Uint8Array) => {
    out.set(b, at);
    at += b.length;
  };

  entries.forEach((entry, i) => {
    offsets.push(at);
    u32(0x04034b50); // local file header
    u16(20); // version needed
    u16(0); // flags — names are ASCII, so no UTF-8 flag needed
    u16(0); // method: store
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(crcs[i]);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(names[i].length);
    u16(0); // extra
    bytes(names[i]);
    bytes(entry.data);
  });

  const centralStart = at;
  entries.forEach((entry, i) => {
    u32(0x02014b50); // central directory header
    u16(20); // version made by
    u16(20); // version needed
    u16(0);
    u16(0);
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(crcs[i]);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(names[i].length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attrs
    u32(0); // external attrs
    u32(offsets[i]);
    bytes(names[i]);
  });

  // Taken BEFORE the record is written: `at` moves as the record is laid down,
  // and reading it inside the record made the directory 12 bytes longer than
  // it is. This writer's own reader did not care — it walks from the offset —
  // but Excel, LibreOffice and every real ZIP reader locate the directory by
  // subtracting this size, and all of them refused the file.
  const centralEnd = at;
  u32(0x06054b50); // end of central directory
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(centralEnd - centralStart);
  u32(centralStart);
  u16(0); // comment length

  return out;
}

const decoder = new TextDecoder();

/**
 * Read a stored ZIP back into its parts.
 *
 * The inverse of `zipStore`, and the reason the writer stores rather than
 * deflates: the output can be verified by reading it, not by trusting it.
 * Walks the CENTRAL DIRECTORY (as a real reader does) rather than scanning for
 * local headers, so a malformed directory is caught rather than skipped.
 */
export function readStoredZip(archive: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let eocd = -1;
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP: no end-of-central-directory record');

  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  // A real reader FINDS the directory by subtracting this size from the end
  // record, so a size that does not agree with the offset is a file Excel
  // rejects even though every byte of every part is intact. Checked here so
  // the writer cannot get it wrong unnoticed again.
  if (centralOffset + centralSize !== eocd) {
    throw new Error(
      `central directory size ${centralSize} does not reach the end record from offset ${centralOffset}`,
    );
  }
  const out = new Map<string, Uint8Array>();

  let at = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) {
      throw new Error(`corrupt central directory at entry ${i}`);
    }
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLen));
    if (method !== 0) throw new Error(`${name}: not stored (method ${method})`);

    if (view.getUint32(localAt, true) !== 0x04034b50) {
      throw new Error(`${name}: corrupt local file header`);
    }
    const localNameLen = view.getUint16(localAt + 26, true);
    const localExtraLen = view.getUint16(localAt + 28, true);
    const start = localAt + 30 + localNameLen + localExtraLen;
    const data = archive.slice(start, start + size);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC mismatch`);
    out.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Convenience for tests and inspection: the parts of an .xlsx as text. */
export function readXlsxParts(archive: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, data] of readStoredZip(archive)) out.set(name, decoder.decode(data));
  return out;
}
