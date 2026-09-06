// What the exported schedule is allowed to say.
//
// Two rules are being defended here, and they are the whole point of the file:
//
//   1. Export mirrors the screen (STUDIO_DESIGN §6.2) — the visible columns,
//      in the visible order.
//   2. A row that could not be computed does not export as 0 (HOW_TO_BUILD_IT
//      §6.4) — its quantity cells are EMPTY and its hole is named in text.
//
// The assertions read the produced workbook rather than an intermediate, so a
// regression that only appears in the bytes cannot pass.
import { describe, expect, it } from 'vitest';
import type { BbsChatResult, BbsChatRow } from '../../src/cad/bbs/chatResult';
import {
  bbsFileName,
  buildBbsWorkbook,
  defaultColumns,
  statusText,
  steelLines,
  writeBbsXlsx,
} from '../../src/io/bbsWorkbook';
import type { BbsExportColumn } from '../../src/io/bbsWorkbook';
import { readXlsxParts } from '../../src/io/xlsx';
import type { XlsxCell, XlsxSheet } from '../../src/io/xlsx';

// ---- a schedule with one member complete and one member wholly blocked ----

const row = (over: Partial<BbsChatRow> & Pick<BbsChatRow, 'id' | 'barMark' | 'memberMark'>): BbsChatRow => ({
  description: 'Main T16',
  diameterMm: 16,
  unitWeightKgPerM: 1.578,
  working: [],
  evidenceIds: [],
  status: 'verified',
  ...over,
});

const ROWS: BbsChatRow[] = [
  row({
    id: 'TB-01',
    barMark: 'TB-01',
    memberMark: 'TB',
    description: 'Main T16 top',
    diameterMm: 16,
    spacingMm: 150,
    barsPerMember: 4,
    memberCount: 3,
    totalBars: 12,
    cuttingLengthMm: 4407,
    totalLengthM: 52.884,
    unitWeightKgPerM: 1.578,
    totalWeightKg: 83.45,
  }),
  row({
    id: 'TB-02',
    barMark: 'TB-02',
    memberMark: 'TB',
    description: 'Link T8 @ 150 c/c',
    diameterMm: 8,
    spacingMm: 150,
    barsPerMember: 28,
    memberCount: 3,
    totalBars: 84,
    cuttingLengthMm: 1180,
    totalLengthM: 99.12,
    unitWeightKgPerM: 0.395,
    totalWeightKg: 39.15,
  }),
  row({
    id: 'WALL-01',
    barMark: 'WALL-01',
    memberMark: 'WALL',
    description: 'Vertical T12 @ 200 c/c',
    diameterMm: 12,
    spacingMm: 200,
    unitWeightKgPerM: 0.888,
    status: 'unavailable',
    note: 'wall.total_run is MISSING',
  }),
];

const RESULT: BbsChatResult = {
  id: 'bbs-1',
  status: 'partial',
  project: { drawingName: 'Boundary wall — reinforcement details' },
  members: [],
  rows: ROWS,
  diameterSummary: [
    {
      diaMm: 8,
      barCount: 84,
      totalLengthM: 99.12,
      unitWeightKgPerM: 0.395,
      totalWeightKg: 39.15,
      totalWeightWithWastageKg: 40.32,
      nonStandardDiameter: false,
    lapWeightKg: 0,
    totalWeightMt: 0,
    },
    {
      diaMm: 16,
      barCount: 12,
      totalLengthM: 52.884,
      unitWeightKgPerM: 1.578,
      totalWeightKg: 83.45,
      totalWeightWithWastageKg: 85.95,
      nonStandardDiameter: false,
    lapWeightKg: 0,
    totalWeightMt: 0,
    },
  ],
  netWeightKg: 122.6,
  procurementWeightKg: 126.27,
  assumptions: [{ what: 'Cover taken flat at 50 mm', why: 'the sheet names cover in prose' }],
  warnings: [],
  gaps: [{ memberMark: 'WALL', field: 'total_run', message: 'What is the total run of the boundary wall?', askable: true }],
  extentClaims: [],
  verification: { passed: [], failures: [], ok: true },
};

const PROVENANCE = {
  drawingName: 'Boundary wall — reinforcement details',
  drawingNumber: 'ORI-NAG-TD-ST-2.1',
  revision: 'B',
  issueDate: '2026-08-14',
  exportedAt: '2026-08-31 09:00 IST',
  settings: { concreteGrade: 'M25', steelGrade: 'Fe500', coverMm: 50, wastagePct: 3, bendMode: 'IS 2502' },
  conventions: ['Ld taken as 49Ø, the project convention'],
};

const cellsOf = (sheet: XlsxSheet): XlsxCell[][] => sheet.rows.map((r) => [...r]);
const textAt = (sheet: XlsxSheet, r: number, c: number): string => {
  const v = sheet.rows[r]?.[c]?.v;
  return typeof v === 'string' ? v : '';
};
const flat = (sheet: XlsxSheet): string =>
  sheet.rows.map((r) => r.map((c) => (typeof c.v === 'string' ? c.v : c.v === null ? '' : String(c.v))).join('\t')).join('\n');

function headerIndex(sheet: XlsxSheet, labels: readonly string[]): number {
  return sheet.rows.findIndex((r) => labels.every((label, i) => r[i]?.v === label));
}

describe('the visible columns, in the visible order', () => {
  it('uses exactly the columns it was given, in the order it was given them', () => {
    // A deliberately un-conventional order, so "mirrors the screen" cannot be
    // satisfied by accident from the module's own default.
    const columns: BbsExportColumn[] = [
      { id: 'weight', label: 'Weight', numeric: true },
      { id: 'mark', label: 'Mark', numeric: false },
      { id: 'dia', label: 'Ø', numeric: true },
      { id: 'totalBars', label: 'Total no.', numeric: true },
    ];
    const sheet = buildBbsWorkbook({ result: RESULT, columns, provenance: PROVENANCE }).sheets[0];
    const at = headerIndex(sheet, ['Weight', 'Mark', 'Ø', 'Total no.']);
    expect(at).toBeGreaterThan(0);
    // the header carries the given columns first, in the given order
    const header = sheet.rows[at].slice(0, 4).map((c) => c.v);
    expect(header).toEqual(['Weight', 'Mark', 'Ø', 'Total no.']);
    // and nothing the screen did not show, beyond the one appended status
    // column that carries the holes (see below)
    const labels = sheet.rows[at].map((c) => c.v).filter((v) => typeof v === 'string' && v);
    expect(labels).toEqual(['Weight', 'Mark', 'Ø', 'Total no.', 'Status / open question']);
  });

  it('does not append a status column when nothing is blocked', () => {
    const clean: BbsChatResult = { ...RESULT, status: 'complete', rows: ROWS.slice(0, 2), gaps: [] };
    const sheet = buildBbsWorkbook({ result: clean, provenance: PROVENANCE }).sheets[0];
    expect(flat(sheet)).not.toContain('Status / open question');
  });

  it('falls back to the commercial order when no table is on screen', () => {
    const all = defaultColumns(RESULT).map((c) => c.id);
    // the A/B/C/D leg columns appear only for the legs some row actually has
    const legs = all.filter((id) => id.startsWith('leg:'));
    for (const leg of legs) expect(RESULT.rows.some((r) => r.segments?.some((sg) => `leg:${sg.label}` === leg))).toBe(true);
    const ids = all.filter((id) => !id.startsWith('leg:'));
    // §31 — the columns a final BBS carries, in this order
    expect(ids).toEqual([
      'sno',
      'drawing',
      'revision',
      'member',
      'memberType',
      'mark',
      'location',
      'shape',
      'dia',
      'spacing',
      // every cutting length shows the cover it was cut to and its status
      'cover',
      'coverSource',
      'cuttingLength',
      'lengthSource',
      'barsPerMember',
      'memberCount',
      'totalBars',
      'totalLength',
      'unitWeight',
      'weight',
      'wastage',
      'weightWithWastage',
      'sourceSection',
      'sourceCallout',
      'sourceHandle',
      'factIds',
      'confidence',
      'engineering',
    ]);
    // §6.2 rule 1: a column no row can fill is absent, not blank
    const noSpacing = { ...RESULT, rows: ROWS.map((r) => ({ ...r, spacingMm: undefined })) };
    expect(defaultColumns(noSpacing).map((c) => c.id)).not.toContain('spacing');
  });
});

describe('a blocked row', () => {
  const sheet = buildBbsWorkbook({ result: RESULT, provenance: PROVENANCE }).sheets[0];
  const columns = [...defaultColumns(RESULT), { id: 'status', label: 'Status / open question', numeric: false }];
  const headerAt = headerIndex(sheet, columns.map((c) => c.label));
  const colAt = (id: string): number => columns.findIndex((c) => c.id === id);
  // the bar mark is no longer the first column — S.No, drawing and revision precede it
  const bodyAt = sheet.rows.findIndex((r) => r[colAt('mark')]?.v === 'WALL-01');

  it('leaves every quantity cell EMPTY — never 0', () => {
    expect(headerAt).toBeGreaterThan(0);
    expect(bodyAt).toBeGreaterThan(headerAt);
    for (const id of ['cuttingLength', 'barsPerMember', 'memberCount', 'totalBars', 'totalLength', 'weight']) {
      const cell = sheet.rows[bodyAt][colAt(id)];
      expect(cell.v, `${id} must be empty on a blocked row`).toBeNull();
    }
  });

  it('keeps the facts the drawing DID state — Ø, spacing, unit weight', () => {
    expect(sheet.rows[bodyAt][colAt('dia')].v).toBe(12);
    expect(sheet.rows[bodyAt][colAt('spacing')].v).toBe(200);
    expect(sheet.rows[bodyAt][colAt('unitWeight')].v).toBe(0.888);
  });

  it('names the hole in a visible text cell', () => {
    expect(sheet.rows[bodyAt][colAt('status')].v).toBe('BLOCKED — wall.total_run is MISSING');
    expect(statusText(ROWS[2])).toBe('BLOCKED — wall.total_run is MISSING');
  });

  it('is marked so it cannot be mistaken for a computed row', () => {
    const cell = sheet.rows[bodyAt][colAt('status')];
    expect(cell.bold).toBe(true);
    expect(sheet.rows[bodyAt][colAt('mark')].muted).toBe(true);
  });

  it('is listed again as an open row, with the question that would settle it', () => {
    const body = flat(sheet);
    expect(body).toContain('OPEN ROWS — 1 row not scheduled');
    expect(body).toContain('OPEN QUESTIONS');
    expect(body).toContain('What is the total run of the boundary wall?');
  });

  it('does not double the prefix when the engine already said BLOCKED', () => {
    const already = { ...ROWS[2], note: 'BLOCKED — wall.total_run is MISSING' };
    expect(statusText(already)).toBe('BLOCKED — wall.total_run is MISSING');
  });
});

describe('totals', () => {
  it('a subtotal over a mixed group is stated and flagged partial', () => {
    const sheet = buildBbsWorkbook({ result: RESULT, provenance: PROVENANCE }).sheets[0];
    const tb = sheet.rows.find((r) => r[0]?.v === 'Subtotal — TB')!;
    expect(tb.find((c) => typeof c.v === 'number' && Math.abs(c.v - 122.6) < 0.001)).toBeTruthy();
  });

  it('a subtotal over a wholly blocked group prints NO figure', () => {
    const sheet = buildBbsWorkbook({ result: RESULT, provenance: PROVENANCE }).sheets[0];
    const wall = sheet.rows.find((r) => r[0]?.v === 'Subtotal — WALL')!;
    expect(wall.every((c) => typeof c.v !== 'number')).toBe(true);
    expect(wall.map((c) => c.v).join(' ')).toContain('BLOCKED — 1 row not computed');
  });

  it('the schedule total says how much of it is computed', () => {
    const sheet = buildBbsWorkbook({ result: RESULT, provenance: PROVENANCE }).sheets[0];
    const total = sheet.rows.find((r) => r[0]?.v === 'SCHEDULE TOTAL (kg)')!;
    expect(total.some((c) => c.v === 122.6)).toBe(true);
    expect(total.map((c) => c.v).join(' ')).toContain('PARTIAL — 2 of 3 rows computed, 1 open');
  });

  it('a fully blocked schedule does not read as 0.0', () => {
    const blockedAll: BbsChatResult = {
      ...RESULT,
      status: 'blocked',
      rows: [ROWS[2]],
      diameterSummary: [],
      netWeightKg: undefined,
      procurementWeightKg: undefined,
    };
    const book = buildBbsWorkbook({ result: blockedAll, provenance: PROVENANCE });
    const schedule = flat(book.sheets[0]);
    const steel = flat(book.sheets[1]);
    // no zero anywhere that could be summed as a quantity
    for (const sheet of book.sheets) {
      for (const r of sheet.rows) {
        for (const c of r) expect(c.v === 0).toBe(false);
      }
    }
    expect(schedule).toContain('BLOCKED — 1 row not computed, no total can be stated');
    expect(schedule).toContain('nothing to order — every row is blocked');
    expect(steel).toContain('BLOCKED — no row in this schedule could be computed');
  });

  it('foots in MT, the way the CSV does', () => {
    const sheet = buildBbsWorkbook({ result: RESULT, provenance: PROVENANCE }).sheets[0];
    const mt = sheet.rows.find((r) => r[0]?.v === 'TOTAL QUANTITY')!;
    expect(mt[1].v).toBeCloseTo(0.12627, 6);
    expect(mt[2].v).toBe('MT');
    expect(mt[3].v).toBe('incl 3% wastage');
  });
});

describe('the steel summary', () => {
  it('matches the schedule, diameter by diameter', () => {
    const { lines, mismatchKg } = steelLines(RESULT);
    expect(mismatchKg).toBe(0);
    const byDia = new Map(lines.map((l) => [l.diaMm, l]));
    const fromRows = new Map<number, number>();
    for (const r of ROWS) {
      if (r.status === 'unavailable') continue;
      fromRows.set(r.diameterMm, (fromRows.get(r.diameterMm) ?? 0) + (r.totalWeightKg ?? 0));
    }
    for (const [dia, kg] of fromRows) expect(byDia.get(dia)!.totalWeightKg).toBeCloseTo(kg, 2);
    // and the summary total is the schedule total
    const summed = lines.reduce((n, l) => n + (l.totalWeightKg ?? 0), 0);
    expect(summed).toBeCloseTo(122.6, 2);
  });

  it('lists a diameter whose rows are all blocked, with empty quantities', () => {
    const { lines } = steelLines(RESULT);
    const twelve = lines.find((l) => l.diaMm === 12)!;
    expect(twelve.openRows).toBe(1);
    expect(twelve.totalWeightKg).toBeNull();
    expect(twelve.totalLengthM).toBeNull();
    expect(twelve.barCount).toBeNull();
  });

  it('says an engine summary that does not reconcile, rather than picking a side', () => {
    const drifted: BbsChatResult = {
      ...RESULT,
      diameterSummary: RESULT.diameterSummary.map((s) => (s.diaMm === 16 ? { ...s, totalWeightKg: 90 } : s)),
    };
    const { mismatchKg } = steelLines(drifted);
    expect(mismatchKg).toBeCloseTo(6.55, 2);
    expect(flat(buildBbsWorkbook({ result: drifted }).sheets[1])).toContain('NOT RECONCILED');
  });

  it('is a second sheet a fabricator can order from', () => {
    const sheet = buildBbsWorkbook({ result: RESULT, provenance: PROVENANCE }).sheets[1];
    expect(sheet.name).toBe('Steel summary');
    const at = headerIndex(sheet, ['Ø (mm)', 'Bars', 'Total length (m)']);
    expect(at).toBeGreaterThan(0);
    const total = sheet.rows.find((r) => r[0]?.v === 'TOTAL')!;
    expect(total[4].v).toBeCloseTo(122.6, 2);
    expect(total[5].v).toBeCloseTo(126.27, 2);
  });
});

describe('provenance', () => {
  const sheet = buildBbsWorkbook({ result: RESULT, provenance: PROVENANCE }).sheets[0];
  const body = flat(sheet);

  it('names the drawing, its revision and when it was exported', () => {
    expect(body).toContain('ORI-NAG-TD-ST-2.1');
    expect(body).toContain('Revision\tB');
    expect(body).toContain('2026-08-31 09:00 IST');
    expect(textAt(sheet, 0, 0)).toBe('BAR BENDING SCHEDULE');
  });

  it('states what the numbers were computed under', () => {
    expect(body).toContain('M25');
    expect(body).toContain('Fe500');
    expect(body).toContain('Clear cover (mm)');
    expect(body).toContain('Ld taken as 49Ø, the project convention');
    expect(body).toContain('IS 1786 nominal mass');
  });

  it('says so plainly when a field was never stated', () => {
    const bare = flat(buildBbsWorkbook({ result: RESULT }).sheets[0]);
    expect(bare).toContain('not stated');
    expect(bare).not.toContain('undefined');
  });

  it('carries the open count into the header', () => {
    expect(body).toContain('PARTIAL — 1 of 3 rows open');
  });

  it('says when the schedule only covers what is drawn', () => {
    const claimed: BbsChatResult = {
      ...RESULT,
      coversDrawnExtentMm: 24948,
      extentClaims: [
        {
          memberMark: 'WALL',
          drawnExtentMm: 24948,
          nodes: 7,
          pitchMm: 4158,
          field: 'run',
          ask: 'What is the total run of the boundary wall?',
        },
      ],
    };
    const claimedBody = flat(buildBbsWorkbook({ result: claimed, provenance: PROVENANCE }).sheets[0]);
    expect(claimedBody).toContain('COVERS ONLY WHAT IS DRAWN');
    expect(claimedBody).toContain('24,948 mm');
  });

  it('freezes the header row so the columns stay on screen', () => {
    expect(sheet.freezeHeaderRows).toBeGreaterThan(0);
    const header = sheet.rows[sheet.freezeHeaderRows! - 1];
    expect(header.map((c) => c.v)).toContain('Bar Mark');
  });
});

describe('the file itself', () => {
  it('writes a workbook a spreadsheet can open, with both sheets', () => {
    const bytes = writeBbsXlsx({ result: RESULT, provenance: PROVENANCE });
    const parts = readXlsxParts(bytes);
    expect(parts.has('xl/worksheets/sheet1.xml')).toBe(true);
    expect(parts.has('xl/worksheets/sheet2.xml')).toBe(true);
    expect(parts.get('xl/workbook.xml')).toContain('name="Schedule"');
    expect(parts.get('xl/workbook.xml')).toContain('name="Steel summary"');
  });

  it('writes weights as numbers, not as text a SUM would ignore', () => {
    const sheet = readXlsxParts(writeBbsXlsx({ result: RESULT, provenance: PROVENANCE })).get(
      'xl/worksheets/sheet1.xml',
    )!;
    expect(sheet).toContain('<v>83.45</v>');
    expect(sheet).not.toContain('>83.45</t>');
  });

  it('names itself after the drawing it was built from, then the revision', () => {
    // The stem is the SOURCE DRAWING's file, without its extension — the name
    // the person who ran it recognises. The number is metadata, not the label.
    expect(
      bbsFileName({ ...PROVENANCE, drawingFile: 'Foundations drawings.dxf' }, { version: 1 }),
    ).toBe('Foundations_drawings-RevB-BBS-v1.xlsx');
    // Number, then title, are the fallbacks for an artifact with no file name.
    expect(bbsFileName(PROVENANCE)).toBe('ORI-NAG-TD-ST-2_1-RevB-BBS.xlsx');
    expect(bbsFileName(PROVENANCE, { version: 3 })).toBe('ORI-NAG-TD-ST-2_1-RevB-BBS-v3.xlsx');
    expect(bbsFileName({ drawingName: 'Boundary wall' })).toBe('Boundary_wall-BBS.xlsx');
    expect(bbsFileName({})).toBe('drawing-BBS.xlsx');
  });

  it('keeps the title and the number in the header the filename dropped', () => {
    // Naming the export after the drawing file must not remove the drawing
    // number from the document itself — that is what identifies it.
    const sheet = buildBbsWorkbook({
      result: RESULT,
      provenance: { ...PROVENANCE, drawingFile: 'Foundations drawings.dxf' },
    }).sheets[0];
    const header = sheet.rows
      .slice(0, 8)
      .flatMap((row) => row.map((cell) => String(cell.v ?? '')))
      .join(' | ');
    expect(header).toContain('ORI-NAG-TD-ST-2.1');
    expect(header).toContain('Boundary wall — reinforcement details');
  });

  it('escapes a drawing name carrying XML metacharacters', () => {
    const odd = { ...PROVENANCE, drawingName: 'Wall & fence <rev "A"> 1/2' };
    const sheet = readXlsxParts(writeBbsXlsx({ result: RESULT, provenance: odd })).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('Wall &amp; fence &lt;rev &quot;A&quot;&gt; 1/2');
  });

  it('is stable — the same schedule exports the same bytes', () => {
    const a = writeBbsXlsx({ result: RESULT, provenance: PROVENANCE });
    const b = writeBbsXlsx({ result: RESULT, provenance: PROVENANCE });
    expect(a).toEqual(b);
  });

  it('groups by diameter when the table was grouped that way', () => {
    const sheet = buildBbsWorkbook({ result: RESULT, provenance: PROVENANCE, groupBy: 'dia' }).sheets[0];
    const labels = cellsOf(sheet)
      .map((r) => r[0]?.v)
      .filter((v) => typeof v === 'string' && v.startsWith('Subtotal'));
    expect(labels).toEqual(['Subtotal — 16 mm', 'Subtotal — 8 mm', 'Subtotal — 12 mm']);
  });
});
