// The exported workbook carries what the schedule was computed with: the
// settings the arithmetic spent (not a defaults table), the cover status on
// every row, and a Calculation trace sheet naming each row's stages, its
// missing fact, source, reason and action.
import { describe, expect, it } from 'vitest';
import { buildBbsWorkbook, coverSourceText, defaultColumns, statusText } from '../../src/io/bbsWorkbook';
import type { BbsChatResult, BbsChatRow } from '../../src/cad/bbs/chatResult';
import type { RowStageTrace } from '../../calculations/schedule';

const traceDone: RowStageTrace = {
  stages: [
    'INPUT_RESOLVED',
    'GEOMETRY_RESOLVED',
    'CUTTING_LENGTH_RESOLVED',
    'QUANTITY_RESOLVED',
    'TOTAL_BARS_RESOLVED',
    'TOTAL_LENGTH_RESOLVED',
    'UNIT_WEIGHT_RESOLVED',
    'WEIGHT_RESOLVED',
    'VALIDATED',
  ],
  factsUsed: ['F8.length', 'F8.width', 'F8.count', 'settings.cover'],
  coverMm: 50,
  coverSource: 'settings-default',
  coverStatus: 'ASSUMED',
  measuredAlong: 'L',
  sourceText: '10@100c/c',
  sourceHandles: ['52F00E'],
  method: { cuttingLength: 'SHAPE_FORMULA', quantity: 'AUTO_SPACING', unitWeight: 'IS_1786_NOMINAL' },
  formula: 'A = 3500 − 2×50 = 3400  →  3400 mm',
  dimSources: { L: 'DRAWING_READ — FOOTING SCHEDULE row F8, column "L" = 3500' },
};

const traceOpen: RowStageTrace = {
  stages: ['INPUT_RESOLVED'],
  failedStage: 'GEOMETRY_RESOLVED',
  missingFact: 'F3.width',
  source: 'F3 dimensions as resolved: L=4300 (DRAWING_READ — FOOTING SCHEDULE row F3), W=not on record, H=575',
  reason: 'member W dimension not on this sheet',
  action: 'Provide F3.width in mm (or correct the axis this bar runs along) and this row recalculates.',
  factsUsed: ['F3.length', 'F3.count', 'settings.cover'],
  coverMm: 50,
  coverSource: 'settings-default',
  coverStatus: 'ASSUMED',
  sourceText: '12@100c/c',
  sourceHandles: ['52EF7D'],
  method: { cuttingLength: 'BLOCKED', quantity: 'AUTO_SPACING', unitWeight: 'NONE' },
  dimSources: { L: 'DRAWING_READ — FOOTING SCHEDULE row F3' },
};

const row = (over: Partial<BbsChatRow>): BbsChatRow => ({
  id: 'F8-M1',
  barMark: 'F8-M1',
  memberMark: 'F8',
  description: 'Long bar T10 @ 100c/c (Btm)',
  diameterMm: 10,
  spacingMm: 100,
  memberCount: 8,
  barsPerMember: 32,
  totalBars: 256,
  cuttingLengthMm: 3400,
  totalLengthM: 870.4,
  unitWeightKgPerM: 0.617,
  totalWeightKg: 537.04,
  coverMm: 50,
  coverSource: 'settings-default',
  coverStatus: 'ASSUMED',
  working: ['A = 3500 − 2×50 = 3400'],
  evidenceIds: ['CALL-015'],
  status: 'inferred',
  note: 'Cover 50 mm ASSUMED — the 50 mm project default: this sheet states no cover for F8, and none was supplied.',
  trace: traceDone,
  ...over,
});

const RESULT: BbsChatResult = {
  id: 'orchestrated-1',
  status: 'partial',
  project: { drawingName: 'FOUNDATION LAYOUT PLAN' },
  members: [
    { mark: 'F8', type: 'footing', count: 8, dims: { L: 3500, W: 3200, H: 575 }, rowIds: ['F8-M1'], weightKg: 537.04 },
    { mark: 'F3', type: 'footing', count: 4, dims: { L: 4300, H: 575 }, rowIds: ['F3-M1'], weightKg: 0 },
  ],
  rows: [
    row({}),
    row({
      id: 'F3-M1',
      barMark: 'F3-M1',
      memberMark: 'F3',
      diameterMm: 12,
      cuttingLengthMm: undefined,
      totalLengthM: undefined,
      unitWeightKgPerM: null,
      totalWeightKg: undefined,
      barsPerMember: undefined,
      totalBars: undefined,
      status: 'unavailable',
      note: 'member W dimension not on this sheet',
      trace: traceOpen,
    }),
  ],
  diameterSummary: [
    { diaMm: 10, barCount: 256, totalLengthM: 870.4, unitWeightKgPerM: 0.617, totalWeightKg: 537.04, totalWeightWithWastageKg: 553.15, nonStandardDiameter: false, lapWeightKg: 0, totalWeightMt: 0, },
  ],
  netWeightKg: 537.04,
  procurementWeightKg: 553.15,
  assumptions: [],
  warnings: [],
  gaps: [],
  extentClaims: [],
  verification: { passed: [], failures: [], ok: false },
  settings: { concreteGrade: 'M25', steelGrade: 'Fe500', coverMm: 50, bendMode: 'CONVENTIONAL', wastagePct: 3, coverSource: 'default' },
  settingSources: { concreteGrade: 'default', steelGrade: 'default', coverMm: 'default', ldMultiple: 'default' },
  reconciliation: {
    ok: true,
    rowsTotalLengthM: 870.4,
    summaryTotalLengthM: 870.4,
    rowsTotalWeightKg: 537.04,
    summaryTotalWeightKg: 537.04,
    differences: [],
    openRows: ['F3-M1'],
  },
};

const cellsOf = (rows: readonly (readonly { v: unknown }[])[]): string[][] =>
  rows.map((r) => r.map((c) => (c && c.v !== null && c.v !== undefined ? String(c.v) : '')));

describe('the workbook says what the schedule was computed with', () => {
  it('prints the settings the arithmetic spent, with their status — never a defaults table', () => {
    const wb = buildBbsWorkbook({ result: RESULT, provenance: { settings: { coverMm: 999 } } });
    const flat = cellsOf(wb.sheets[0].rows).flat().join(' | ');
    expect(flat).toMatch(/Clear cover \(mm\) \| 50/);
    expect(flat).not.toMatch(/999/);
    expect(flat).toMatch(/Cover status \| ASSUMED — project default, not stated on the drawing, not supplied/);
    expect(flat).toMatch(/M25 \(ASSUMED — project default\)/);
  });

  it('puts the cover and its status beside every cutting length', () => {
    const ids = defaultColumns(RESULT).map((c) => c.id);
    // §31 order: Cover, Cover source, then the Cutting Length they produced
    expect(ids.indexOf('coverSource')).toBe(ids.indexOf('cover') + 1);
    expect(ids.indexOf('cuttingLength')).toBe(ids.indexOf('coverSource') + 1);
    expect(coverSourceText(RESULT.rows[0])).toBe('ASSUMED (project default)');
    expect(coverSourceText(row({ coverStatus: 'USER_INPUT', coverSource: 'user-override' }))).toBe('USER_INPUT (your answer)');
    expect(coverSourceText(row({ coverStatus: 'DRAWING_READ', coverSource: 'member-cover-table' }))).toBe('DRAWING_READ (cover table)');
  });

  it('marks an assumed-cover row INFERRED with the assumption in the status cell', () => {
    expect(statusText(RESULT.rows[0])).toMatch(/^INFERRED — Cover 50 mm ASSUMED/);
    expect(statusText(RESULT.rows[1])).toMatch(/^BLOCKED — member W dimension not on this sheet/);
  });

  it('adds a Calculation trace sheet with FAILED_STAGE / MISSING_FACT / SOURCE / REASON / ACTION per row', () => {
    const wb = buildBbsWorkbook({ result: RESULT });
    expect(wb.sheets.map((s) => s.name)).toEqual(['Schedule', 'Steel summary', 'Calculation trace', 'Validation', 'Unresolved']);
    const trace = cellsOf(wb.sheets[2].rows);
    const header = trace.find((r) => r[0] === 'Mark')!;
    expect(header).toEqual([
      'Mark', 'Member', 'Stage reached', 'Failed stage', 'Missing fact', 'Source', 'Reason', 'Action',
      'Cover (mm)', 'Cover status', 'Measured along', 'Facts used',
    ]);
    const done = trace.find((r) => r[0] === 'F8-M1')!;
    expect(done[2]).toBe('VALIDATED');
    expect(done[3]).toBe('');
    expect(done[8]).toBe('50');
    expect(done[9]).toBe('ASSUMED (project default)');
    expect(done[10]).toBe('L');
    expect(done[11]).toBe('F8.length, F8.width, F8.count, settings.cover');
    const open = trace.find((r) => r[0] === 'F3-M1')!;
    expect(open[2]).toBe('INPUT_RESOLVED');
    expect(open[3]).toBe('GEOMETRY_RESOLVED');
    expect(open[4]).toBe('F3.width');
    expect(open[5]).toMatch(/W=not on record/);
    expect(open[6]).toBe('member W dimension not on this sheet');
    expect(open[7]).toMatch(/Provide F3.width in mm/);
    const rec = trace.find((r) => r[0] === 'Reconciliation')!;
    expect(rec[1]).toMatch(/^RECONCILED — rows 870.40 m \/ 537.04 kg equal the summary 870.40 m \/ 537.04 kg; 1 open row\(s\) in no total: F3-M1/);
  });

  it('says NOT RECONCILED on the trace sheet when the engine could not reconcile', () => {
    const bad: BbsChatResult = {
      ...RESULT,
      reconciliation: { ...RESULT.reconciliation!, ok: false, differences: [{ diaMm: 10, lengthDiffM: 1.5, weightDiffKg: 0.93 }] },
    };
    const wb = buildBbsWorkbook({ result: bad });
    const rec = cellsOf(wb.sheets[2].rows).find((r) => r[0] === 'Reconciliation')!;
    expect(rec[1]).toMatch(/^NOT RECONCILED — T10: Δ1.50 m \/ Δ0.93 kg/);
  });
});
