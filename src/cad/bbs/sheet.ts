// ============================================================
// The schedule as a sheet — one grid, rendered two ways
//
// WHY THIS EXISTS
//
// The screen and the CSV were built by separate code from the same result, and
// they drifted: the screen showed six rows with alternate bars split out while
// the download showed four. Two renderers of one truth will always find a way
// to disagree, and the one people send to a steel yard is the one nobody
// checks on screen first.
//
// So the grid is built ONCE, here. `BbsSheet` paints it and `sheetToCsv`
// serialises it, and neither knows anything the other does not. What you see
// is what downloads, by construction rather than by discipline.
//
// Cells carry three things beyond their text:
//   · `edit`  — where a typed value goes, for the cells a person may correct
//   · `formula` — the substituted arithmetic behind a computed number
//   · `source` — read, computed, or typed by a person
// ============================================================
import { UNIT_WEIGHT_KG_PER_M } from '../../domain/india/bbs';
import type { BbsResult, BbsRow, BbsSettings } from './types';

export const DIAMETERS = [6, 8, 10, 12, 16, 20, 25, 32, 40];
const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f'];

export const SHEET_COLUMNS = [
  'Sl No.', 'Description', 'L (m)', 'B (m)', 'Nos', 'D (m)',
  'Dia', 'C/C', 'Nos. of bars', 'Ld (m)',
  ...SEGMENTS,
  'Bend deduction (m)', 'Cutting Length (m)', 'Total Length (m)',
  ...DIAMETERS.map((d) => `${d} mm`),
  'Weight (kg)', 'Shape', 'From callout', 'Source',
];

export type CellSource = 'read' | 'computed' | 'user' | 'unavailable';

export interface SheetCell {
  text: string;
  /** right-align: every number, so a column can be scanned */
  numeric?: boolean;
  strong?: boolean;
  dim?: boolean;
  source?: CellSource;
  /** the arithmetic behind the figure, shown rather than hidden */
  formula?: string;
  /** where a typed value is written; absent when the cell is not editable */
  edit?: {
    scope: 'member' | 'bar';
    key: string;
    field: string;
    /** the current value in the unit the input takes (mm, or a bare count) */
    value?: number;
  };
}

export interface SheetRow {
  kind: 'member' | 'bar' | 'blank' | 'label' | 'total' | 'note';
  cells: SheetCell[];
  /** for click-to-locate and row highlighting */
  memberMark?: string;
  barMark?: string;
  /** the row could not be completed */
  unavailable?: boolean;
}

export interface Sheet {
  title: string;
  subtitle: string;
  columns: string[];
  rows: SheetRow[];
}

const cell = (text: string, over: Partial<SheetCell> = {}): SheetCell => ({ text, ...over });
const n = (text: string, over: Partial<SheetCell> = {}): SheetCell =>
  ({ text, numeric: true, ...over });
const blank = (count: number): SheetCell[] => Array.from({ length: count }, () => cell(''));

const m3 = (mm: number | null | undefined): string =>
  typeof mm === 'number' ? (mm / 1000).toFixed(3) : '';

/** Ld is carried on the row as a warning string; pull it back out for its column. */
function ldOf(row: BbsRow): string {
  const hit = row.warnings.find((w) => w.startsWith('Ld '))?.match(/Ld ([\d.]+) mm/);
  return hit ? (Number(hit[1]) / 1000).toFixed(3) : '';
}

function barRow(row: BbsRow): SheetRow {
  const positive = (row.segments ?? []).filter((s) => s.mm >= 0);
  const deduction = (row.segments ?? [])
    .filter((s) => s.mm < 0)
    .reduce((a, s) => a + s.mm, 0);

  const segmentCells = SEGMENTS.map((label, i) => {
    const seg = positive[i];
    return n(seg ? (seg.mm / 1000).toFixed(3) : '', {
      dim: true,
      formula: seg ? `${label} = ${seg.label}` : undefined,
    });
  });

  const perDia = DIAMETERS.map((d) =>
    n(d === row.diaMm && row.totalLengthM !== null ? row.totalLengthM.toFixed(2) : '', {
      strong: d === row.diaMm,
    }),
  );

  // A row is NOT AVAILABLE when either half of `length × count` is absent —
  // a printed "0" for a count nobody could derive is a wrong number wearing
  // the face of a right one.
  const unavailable = row.cuttingLengthMm === null || row.totalBars === null;
  const totalNo = row.totalBars === null ? 'NOT AVAILABLE' : String(row.totalBars);

  return {
    kind: 'bar',
    memberMark: row.memberMark,
    barMark: row.barMark,
    unavailable,
    cells: [
      cell(''),
      cell(row.description || row.barMark, { strong: true }),
      cell(''), cell(''), cell(''), cell(''),
      n(String(row.diaMm), {
        edit: { scope: 'bar', key: row.barMark, field: 'diaMm', value: row.diaMm },
      }),
      n(row.spacingMm ? (row.spacingMm / 1000).toFixed(3) : '', {
        edit: { scope: 'bar', key: row.barMark, field: 'spacingMm', value: row.spacingMm },
      }),
      n(totalNo, {
        formula:
          row.barsPerMember === null
            ? (row.missing ?? 'the number of bars could not be derived')
            : `${row.barsPerMember} per member × ${row.memberCount} members`,
        edit: {
          scope: 'bar',
          key: row.barMark,
          field: 'manualCount',
          value: row.barsPerMember ?? undefined,
        },
      }),
      n(ldOf(row), { dim: true }),
      ...segmentCells,
      n(deduction ? (deduction / 1000).toFixed(3) : '', { dim: true }),
      n(unavailable ? 'NOT AVAILABLE' : (row.cuttingLengthMm! / 1000).toFixed(3), {
        strong: true,
        source: unavailable
          ? 'unavailable'
          : row.lengthSource === 'ENTERED'
            ? 'user'
            : 'computed',
        formula: row.lengthWorking,
        edit: {
          scope: 'bar',
          key: row.barMark,
          field: 'cuttingLengthMm',
          value: row.cuttingLengthMm ?? undefined,
        },
      }),
      n(row.totalLengthM === null ? '' : row.totalLengthM.toFixed(2), {
        formula:
          row.cuttingLengthMm === null || row.totalBars === null
            ? undefined
            : `${(row.cuttingLengthMm / 1000).toFixed(3)} m × ${row.totalBars} bars`,
      }),
      ...perDia,
      n(row.weightWithWastageKg === null ? '—' : row.weightWithWastageKg.toFixed(2), {
        formula:
          row.totalLengthM !== null && row.unitWeightKgPerM !== null
            ? `${row.totalLengthM.toFixed(2)} m × ${row.unitWeightKgPerM} kg/m`
            : undefined,
      }),
      cell(row.shapeCode, { dim: true }),
      cell(row.fromCallout, { dim: true }),
      cell(row.lengthSource, { dim: true }),
    ],
  };
}

/**
 * Build the whole schedule as a grid.
 *
 * The layout is the commercial one: a member line carrying its dimensions,
 * then one line per bar run, then totals by diameter, then anything the engine
 * refused to schedule.
 */
export function buildSheet(
  result: BbsResult,
  settings: BbsSettings,
  drawingName: string,
  conventionNotes: string[] = [],
): Sheet {
  const rows: SheetRow[] = [];
  const width = SHEET_COLUMNS.length;

  let sl = 0;
  for (const member of result.members) {
    sl += 1;
    const mine = result.rows.filter((r) => r.memberMark === member.mark);
    const editMember = (field: string, value: number | undefined): SheetCell['edit'] => ({
      scope: 'member',
      key: member.mark,
      field,
      value,
    });

    rows.push({
      kind: 'member',
      memberMark: member.mark,
      cells: [
        n(String(sl)),
        cell(member.mark, { strong: true }),
        n(m3(member.lengthMm), { edit: editMember('lengthMm', member.lengthMm) }),
        n(m3(member.widthMm), { edit: editMember('widthMm', member.widthMm) }),
        n(String(member.count), { edit: editMember('count', member.count) }),
        n(m3(member.heightMm), { edit: editMember('heightMm', member.heightMm) }),
        ...blank(width - 6),
      ],
    });

    for (const row of mine) rows.push(barRow(row));
  }

  // ---- totals by diameter ----
  const byDia = new Map(result.summary.map((s) => [s.diaMm, s]));
  const lead = (label: string): SheetCell[] => [
    cell(''),
    cell(label, { strong: true }),
    ...blank(12),
  ];

  rows.push({ kind: 'blank', cells: blank(width) });
  rows.push({
    kind: 'label',
    cells: [
      ...lead('TOTAL BY DIAMETER'),
      cell('Total Length (m)'),
      ...DIAMETERS.map((d) => n(`${d} mm`)),
      ...blank(4),
    ],
  });
  rows.push({
    kind: 'total',
    cells: [
      ...lead('Length (m)'),
      cell(''),
      // 0.00 rather than blank: a blank reads as "not looked at", a zero says
      // "checked, none required" — and it lets the row foot as a formula.
      ...DIAMETERS.map((d) => n((byDia.get(d)?.totalLengthM ?? 0).toFixed(2))),
      ...blank(4),
    ],
  });
  rows.push({
    kind: 'total',
    cells: [
      ...lead('Weight (kg)'),
      cell(''),
      ...DIAMETERS.map((d) => n((byDia.get(d)?.totalWeightWithWastageKg ?? 0).toFixed(2), { strong: true })),
      ...blank(4),
    ],
  });
  rows.push({
    kind: 'note',
    cells: [
      ...lead('Unit weight (kg/m)'),
      cell('IS 1786 nominal mass', { dim: true }),
      ...DIAMETERS.map((d) => n((UNIT_WEIGHT_KG_PER_M[d] ?? 0).toFixed(3), { dim: true })),
      ...blank(4),
    ],
  });

  const totalKg = result.rows.reduce((a, r) => a + (r.weightWithWastageKg ?? 0), 0);
  rows.push({ kind: 'blank', cells: blank(width) });
  rows.push({
    kind: 'total',
    cells: [
      cell(''),
      cell('TOTAL QUANTITY', { strong: true }),
      n((totalKg / 1000).toFixed(3), { strong: true }),
      cell('MT'),
      cell(`incl ${settings.wastagePct}% wastage`, { dim: true }),
      ...blank(width - 5),
    ],
  });

  // the practice that produced the figure travels with it
  for (const note of conventionNotes) {
    rows.push({ kind: 'note', cells: [cell(''), cell(''), cell(note, { dim: true }), ...blank(width - 3)] });
  }

  if (result.incomplete.length) {
    rows.push({ kind: 'blank', cells: blank(width) });
    rows.push({
      kind: 'label',
      cells: [
        cell(''),
        cell('NOT SCHEDULED — a dimension was not on this sheet and nothing was assumed', {
          strong: true,
        }),
        ...blank(width - 2),
      ],
    });
    for (const item of result.incomplete) {
      rows.push({
        kind: 'note',
        barMark: item.barMark,
        unavailable: true,
        cells: [cell(''), cell(item.barMark), cell(item.reason, { dim: true }), ...blank(width - 3)],
      });
    }
  }

  return {
    title: 'Bar Bending Schedule',
    subtitle: drawingName,
    columns: SHEET_COLUMNS,
    rows,
  };
}

/** Serialise the very same grid the screen is showing. */
export function sheetToCsv(sheet: Sheet, settings: BbsSettings): string {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [
    `${sheet.title},${q(sheet.subtitle)}`,
    `Concrete,${settings.concreteGrade},Steel,${settings.steelGrade},Clear cover (mm),${settings.coverMm},Wastage %,${settings.wastagePct}`,
    '',
    sheet.columns.map(q).join(','),
  ];
  for (const row of sheet.rows) {
    lines.push(row.cells.map((c) => q(c.text)).join(','));
  }
  return lines.join('\n');
}
