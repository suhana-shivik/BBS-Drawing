// The writer is checked by reading back what it wrote.
//
// Store method is what makes this possible: `readStoredZip` walks the central
// directory the way a real reader does, verifies every CRC and returns the
// parts, with no inflate implementation standing between the assertion and the
// bytes. A test that only checked the writer's own intermediate strings would
// pass on a file Excel refuses to open.
import { describe, expect, it } from 'vitest';
import {
  columnName,
  crc32,
  escapeXml,
  readStoredZip,
  readXlsxParts,
  sanitiseSheetName,
  writeXlsx,
  XLSX_MIME,
  zipStore,
} from '../../src/io/xlsx';
import type { XlsxWorkbook } from '../../src/io/xlsx';

const REQUIRED_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/styles.xml',
  'xl/worksheets/sheet1.xml',
];

const small: XlsxWorkbook = {
  sheets: [
    {
      name: 'Schedule',
      freezeHeaderRows: 1,
      columns: [{ width: 14 }, { width: 10 }],
      rows: [
        [{ v: 'Mark', bold: true }, { v: 'Weight (kg)', bold: true, align: 'right' }],
        [{ v: 'BM-01' }, { v: 83.45, numFmt: '#,##0.00', align: 'right' }],
        [{ v: 'BM-02' }, { v: 12, numFmt: '#,##0.00', align: 'right' }],
      ],
    },
  ],
};

describe('zip container', () => {
  it('writes a stored ZIP whose central directory reads back', () => {
    const bytes = writeXlsx(small);
    // local file header signature — this is what a reader looks for first
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const parts = readStoredZip(bytes);
    // readStoredZip verifies every CRC and refuses any non-stored entry, so
    // reaching here is the assertion about sizes and checksums.
    expect(parts.size).toBe(REQUIRED_PARTS.length);
  });

  it('records true CRCs and sizes', () => {
    const data = new TextEncoder().encode('a schedule is a document');
    const archive = zipStore([{ name: 'a.txt', data }]);
    const view = new DataView(archive.buffer);
    expect(view.getUint32(14, true)).toBe(crc32(data)); // local header CRC
    expect(view.getUint32(18, true)).toBe(data.length); // compressed size
    expect(view.getUint32(22, true)).toBe(data.length); // uncompressed size
    expect(view.getUint16(8, true)).toBe(0); // method: store
    // as plain numbers: jsdom's TextEncoder and the module's Uint8Array are
    // different realms, and toEqual compares prototypes before bytes
    expect([...readStoredZip(archive).get('a.txt')!]).toEqual([...data]);
  });

  it('closes the end record so a reader can FIND the central directory', () => {
    // The regression this exists for: every part intact, every CRC right, and
    // the file refused by Excel, LibreOffice and python's zipfile alike,
    // because the recorded directory size overshot by the 12 bytes of the end
    // record itself. A reader locates the directory by subtracting.
    const bytes = writeXlsx(small);
    const view = new DataView(bytes.buffer);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    expect(eocd).toBe(bytes.length - 22);
    const size = view.getUint32(eocd + 12, true);
    const offset = view.getUint32(eocd + 16, true);
    expect(offset + size).toBe(eocd);
    expect(view.getUint32(offset, true)).toBe(0x02014b50); // central header
    expect(view.getUint16(eocd + 10, true)).toBe(REQUIRED_PARTS.length);
  });

  it('CRC-32 matches the known value for "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('rejects an archive whose bytes were tampered with', () => {
    const archive = zipStore([{ name: 'a.txt', data: new TextEncoder().encode('one hundred metres') }]);
    archive[40] = archive[40] ^ 0xff;
    expect(() => readStoredZip(archive)).toThrow(/CRC mismatch|corrupt/);
  });

  it('is byte-identical for the same workbook — no clock in the file', () => {
    expect(writeXlsx(small)).toEqual(writeXlsx(small));
  });
});

describe('the OOXML part set', () => {
  const parts = readXlsxParts(writeXlsx({ sheets: [small.sheets[0], { name: 'Steel summary', rows: [[{ v: 1 }]] }] }));

  it('carries every required part, and a worksheet per sheet', () => {
    for (const name of REQUIRED_PARTS) expect(parts.has(name)).toBe(true);
    expect(parts.has('xl/worksheets/sheet2.xml')).toBe(true);
  });

  it('points the package at the workbook', () => {
    expect(parts.get('_rels/.rels')).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"',
    );
  });

  it('declares a content type for every part', () => {
    const types = parts.get('[Content_Types].xml')!;
    expect(types).toContain('PartName="/xl/workbook.xml"');
    expect(types).toContain('PartName="/xl/worksheets/sheet1.xml"');
    expect(types).toContain('PartName="/xl/worksheets/sheet2.xml"');
    expect(types).toContain('PartName="/xl/styles.xml"');
    expect(types).toContain('Extension="rels"');
  });

  it('relates each sheet id to the worksheet part it names, plus styles', () => {
    const rels = parts.get('xl/_rels/workbook.xml.rels')!;
    expect(rels).toContain('Id="rId1"');
    expect(rels).toContain('Target="worksheets/sheet1.xml"');
    expect(rels).toContain('Target="worksheets/sheet2.xml"');
    expect(rels).toContain('Target="styles.xml"');
    const workbook = parts.get('xl/workbook.xml')!;
    expect(workbook).toContain('<sheet name="Schedule" sheetId="1" r:id="rId1"/>');
    expect(workbook).toContain('<sheet name="Steel summary" sheetId="2" r:id="rId2"/>');
  });

  it('declares the styles Excel expects, in the order it expects them', () => {
    const styles = parts.get('xl/styles.xml')!;
    const order = ['<fonts', '<fills', '<borders', '<cellStyleXfs', '<cellXfs', '<cellStyles', '<dxfs'];
    let at = -1;
    for (const tag of order) {
      const next = styles.indexOf(tag);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    // fill 0 must be none and fill 1 gray125 — Excel assumes both exist
    expect(styles.indexOf('patternType="none"')).toBeLessThan(styles.indexOf('patternType="gray125"'));
  });

  it('names the MIME type a download needs', () => {
    expect(XLSX_MIME).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
});

describe('cells', () => {
  it('writes numbers as numbers and text as inline strings', () => {
    const sheet = readXlsxParts(writeXlsx(small)).get('xl/worksheets/sheet1.xml')!;
    // a number carries no t attribute (the default is "n") and holds a <v>
    expect(sheet).toMatch(/<c r="B2"[^>]*><v>83\.45<\/v><\/c>/);
    expect(/<c r="B2"[^>]*t="[^"]*"/.test(sheet)).toBe(false);
    // text is an inline string — no sharedStrings part to keep in sync
    expect(sheet).toMatch(/<c r="A2"[^>]*t="inlineStr"><is><t[^>]*>BM-01<\/t><\/is><\/c>/);
  });

  it('never writes a number as text — a fabricator sums this column', () => {
    const sheet = readXlsxParts(
      writeXlsx({ sheets: [{ name: 'S', rows: [[{ v: 0 }, { v: -12.5 }, { v: 1e-7 }]] }] }),
    ).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<v>0</v>');
    expect(sheet).toContain('<v>-12.5</v>');
    expect(sheet).not.toContain('t="inlineStr"');
  });

  it('leaves a null cell empty rather than writing a zero', () => {
    const sheet = readXlsxParts(
      writeXlsx({ sheets: [{ name: 'S', rows: [[{ v: null, numFmt: '#,##0.00' }, { v: 5 }]] }] }),
    ).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).not.toContain('<v>0</v>');
    expect(sheet).toContain('<v>5</v>');
  });

  it('drops a non-finite number rather than writing NaN into a workbook', () => {
    const sheet = readXlsxParts(
      writeXlsx({ sheets: [{ name: 'S', rows: [[{ v: Number.NaN }, { v: Number.POSITIVE_INFINITY }]] }] }),
    ).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).not.toMatch(/NaN|Infinity/);
  });

  it('freezes the header rows and sets the column widths', () => {
    const sheet = readXlsxParts(writeXlsx(small)).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<col min="1" max="1" width="14" customWidth="1"/>');
    expect(sheet).toContain('<dimension ref="A1:B3"/>');
  });
});

describe('XML safety', () => {
  it('escapes & < > " and \' in a value', () => {
    const value = `M25 & Fe500 <top> "as drawn" 'rev A'`;
    const sheet = readXlsxParts(writeXlsx({ sheets: [{ name: 'S', rows: [[{ v: value }]] }] })).get(
      'xl/worksheets/sheet1.xml',
    )!;
    expect(sheet).toContain('M25 &amp; Fe500 &lt;top&gt; &quot;as drawn&quot; &apos;rev A&apos;');
    expect(sheet).not.toContain('<top>');
    // and the escaping is the standard one, so it parses back
    expect(escapeXml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('strips control characters XML cannot carry at all', () => {
    // built with fromCharCode so the bytes under test are unambiguous
    const value = 'bad' + String.fromCharCode(0x01) + 'byte' + String.fromCharCode(0x1f) + 'here';
    const sheet = readXlsxParts(writeXlsx({ sheets: [{ name: 'S', rows: [[{ v: value }]] }] })).get(
      'xl/worksheets/sheet1.xml',
    )!;
    expect(sheet).toContain('badbytehere');
    expect(sheet).not.toContain(String.fromCharCode(0x01));
    expect(sheet).not.toContain('&#x0');
  });

  it('keeps tab, newline and carriage return, which XML does carry', () => {
    expect(escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('escapes a sheet name in the workbook part', () => {
    const parts = readXlsxParts(writeXlsx({ sheets: [{ name: 'A & B', rows: [] }] }));
    expect(parts.get('xl/workbook.xml')).toContain('name="A &amp; B"');
  });
});

describe('sheet names', () => {
  it("removes the characters Excel refuses: [ ] : * ? / \\", () => {
    const out = sanitiseSheetName('Sched/ule:[2024]*?');
    expect(out).not.toMatch(/[[\]:*?/\\]/);
    expect(out).toBe('Sched-ule--2024---');
  });

  it('truncates to 31 characters', () => {
    const out = sanitiseSheetName('a'.repeat(60));
    expect(out).toHaveLength(31);
  });

  it('never returns an empty name, and never one wrapped in apostrophes', () => {
    expect(sanitiseSheetName('   ')).toBe('Sheet');
    expect(sanitiseSheetName("'quoted'")).toBe('quoted');
  });

  it('makes duplicate names unique — Excel refuses a workbook with two', () => {
    const parts = readXlsxParts(
      writeXlsx({ sheets: [{ name: 'Schedule', rows: [] }, { name: 'Schedule', rows: [] }] }),
    );
    const workbook = parts.get('xl/workbook.xml')!;
    expect(workbook).toContain('name="Schedule"');
    expect(workbook).toContain('name="Schedule (2)"');
  });
});

describe('column references', () => {
  it('counts A..Z then AA', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(51)).toBe('AZ');
    expect(columnName(52)).toBe('BA');
  });
});

describe('round trip', () => {
  it('a small workbook survives being written and read back', () => {
    const book: XlsxWorkbook = {
      sheets: [
        {
          name: 'One',
          rows: [
            [{ v: 'Ø' }, { v: 16 }],
            [{ v: 'kg' }, { v: 83.45 }],
          ],
        },
        { name: 'Two', rows: [[{ v: 'note', muted: true }]] },
      ],
    };
    const parts = readXlsxParts(writeXlsx(book));
    const one = parts.get('xl/worksheets/sheet1.xml')!;
    expect(one).toContain('<t xml:space="preserve">Ø</t>');
    expect(one).toContain('<v>16</v>');
    expect(one).toContain('<v>83.45</v>');
    expect(parts.get('xl/worksheets/sheet2.xml')).toContain('note');
    // every part is well-formed XML
    for (const [name, xml] of parts) {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      expect(doc.querySelector('parsererror'), `${name} did not parse`).toBeNull();
    }
  });
});
