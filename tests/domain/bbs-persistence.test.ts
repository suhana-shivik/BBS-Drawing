// A schedule row, as the database holds it.
//
// The row that is stored has to carry the DERIVATION, not just the numbers:
// which facts it read, which stage it reached, what stopped it and what would
// unblock it. A stored schedule without that cannot be audited a month later,
// and a changed fact cannot name the rows it invalidates.
//
// Also pinned here: none of it knows what kind of member it is looking at.
import { describe, expect, it } from 'vitest';
import { rowStatusOf, runStatusOf, toRowRecord } from '../../src/data/bbs';
import type { BbsChatResult, BbsChatRow } from '../../src/cad/bbs/chatResult';
import type { RowStageTrace } from '../../calculations/schedule';

const CTX = {
  projectId: 'p-1',
  drawingId: 'd-1',
  drawingHash: 'doc:abc123',
  userId: 'u-1',
};

const trace = (over: Partial<RowStageTrace> = {}): RowStageTrace => ({
  stages: ['INPUT_RESOLVED', 'GEOMETRY_RESOLVED', 'CUTTING_LENGTH_RESOLVED', 'QUANTITY_RESOLVED',
    'TOTAL_BARS_RESOLVED', 'TOTAL_LENGTH_RESOLVED', 'UNIT_WEIGHT_RESOLVED', 'WEIGHT_RESOLVED', 'VALIDATED'],
  factsUsed: ['PB03.span', 'PB03.count', 'settings.cover'],
  coverMm: 40,
  coverSource: 'member-cover-table',
  coverStatus: 'DRAWING_READ',
  sourceText: '2-16 TOP',
  sourceHandles: ['1A2B'],
  method: { cuttingLength: 'SHAPE_FORMULA', quantity: 'MANUAL', unitWeight: 'IS_1786_NOMINAL' },
  formula: 'A = 4500 − 2×40 = 4420  →  4420 mm',
  dimSources: { L: 'DRAWING_READ — BEAM SCHEDULE row PB03, column "SPAN" = 4500' },
  ...over,
});

const row = (over: Partial<BbsChatRow> = {}): BbsChatRow => ({
  id: 'PB03-M1',
  barMark: 'PB03-M1',
  memberMark: 'PB03',
  description: 'Top bar T16',
  diameterMm: 16,
  spacingMm: undefined,
  memberCount: 6,
  barsPerMember: 2,
  totalBars: 12,
  cuttingLengthMm: 4420,
  totalLengthM: 53.04,
  unitWeightKgPerM: 1.578,
  totalWeightKg: 83.7,
  coverMm: 40,
  coverSource: 'member-cover-table',
  coverStatus: 'DRAWING_READ',
  working: ['A = 4500 − 2×40 = 4420'],
  evidenceIds: ['CALL-001'],
  status: 'verified',
  trace: trace(),
  ...over,
});

describe('a computed row', () => {
  it('stores every figure and the derivation behind it', () => {
    const record = toRowRecord(row(), 0, 'run-1', CTX);
    expect(record).toMatchObject({
      run_id: 'run-1',
      project_id: 'p-1',
      drawing_id: 'd-1',
      user_id: 'u-1',
      row_index: 0,
      member_id: 'PB03',
      bar_mark: 'PB03-M1',
      dia_mm: 16,
      bars_per_member: 2,
      member_count: 6,
      total_bars: 12,
      cutting_length_mm: 4420,
      total_length_m: 53.04,
      unit_weight_kg_per_m: 1.578,
      weight_kg: 83.7,
      cover_mm: 40,
      cover_status: 'DRAWING_READ',
      length_source: 'SHAPE_FORMULA',
      quantity_method: 'MANUAL',
      unit_weight_method: 'IS_1786_NOMINAL',
      stage: 'VALIDATED',
      status: 'CALCULATED',
      drawing_hash: 'doc:abc123',
    });
    expect(record.fact_ids).toEqual(['PB03.span', 'PB03.count', 'settings.cover']);
    expect(record.source_text).toBe('2-16 TOP');
    expect(record.source_entity_handles).toEqual(['1A2B']);
    expect(record.formula).toMatch(/4500 − 2×40/);
    expect(record.failed_stage).toBeNull();
  });

  it('never invents a number for a figure that is absent', () => {
    const record = toRowRecord(
      row({ cuttingLengthMm: undefined, totalBars: undefined, totalWeightKg: undefined, unitWeightKgPerM: null }),
      0,
      'run-1',
      CTX,
    );
    expect(record.cutting_length_mm).toBeNull();
    expect(record.total_bars).toBeNull();
    expect(record.weight_kg).toBeNull();
    expect(record.unit_weight_kg_per_m).toBeNull();
  });
});

describe('a blocked row', () => {
  it('stores what stopped it, on what fact, and what would unblock it', () => {
    const blocked = row({
      status: 'unavailable',
      cuttingLengthMm: undefined,
      totalWeightKg: undefined,
      note: 'member W dimension not on this sheet',
      trace: trace({
        stages: ['INPUT_RESOLVED'],
        failedStage: 'GEOMETRY_RESOLVED',
        missingFact: 'PB03.width',
        source: 'PB03 dimensions as resolved: L=4500, W=not on record',
        reason: 'member W dimension not on this sheet',
        action: 'Provide PB03.width in mm and this row recalculates.',
        method: { cuttingLength: 'BLOCKED', quantity: 'AUTO_SPACING', unitWeight: 'NONE' },
      }),
    });
    const record = toRowRecord(blocked, 3, 'run-1', CTX);
    expect(record.status).toBe('BLOCKED');
    expect(record.stage).toBe('INPUT_RESOLVED');
    expect(record.failed_stage).toBe('GEOMETRY_RESOLVED');
    expect(record.missing_fact).toBe('PB03.width');
    expect(record.reason).toMatch(/W dimension not on this sheet/);
    expect(record.action).toMatch(/Provide PB03.width/);
    expect(record.weight_kg).toBeNull();
    expect(record.row_index).toBe(3);
  });

  it('an inferred row is recorded as inferred, not as verified', () => {
    expect(rowStatusOf(row({ status: 'inferred' }))).toBe('INFERRED');
    expect(rowStatusOf(row({ status: 'verified' }))).toBe('CALCULATED');
    expect(rowStatusOf(row({ status: 'unavailable' }))).toBe('BLOCKED');
  });
});

describe('the run status', () => {
  const result = (rows: BbsChatRow[], ok = true): BbsChatResult =>
    ({ rows, verification: { ok, passed: [], failures: [] } }) as unknown as BbsChatResult;

  it('is BLOCKED only when nothing at all could be computed', () => {
    expect(runStatusOf(result([row({ status: 'unavailable' })]))).toBe('BLOCKED');
    expect(runStatusOf(result([]))).toBe('BLOCKED');
  });

  it('is CALCULATED when some rows are open — the usable part is not thrown away', () => {
    expect(runStatusOf(result([row(), row({ status: 'unavailable' })]))).toBe('CALCULATED');
  });

  it('is FINAL only when every row computed and every gate passed', () => {
    expect(runStatusOf(result([row(), row()]))).toBe('FINAL');
    expect(runStatusOf(result([row(), row()], false))).toBe('CALCULATED');
  });
});

describe('it is generic', () => {
  it('stores a footing, a beam, a column and an unfamiliar mark identically', () => {
    const marks = [
      { member: 'F8', bar: 'F8-M1' },
      { member: 'PB03', bar: 'PB03-S1' },
      { member: 'C12', bar: 'C12-T1' },
      { member: 'RW-7A', bar: 'RW-7A-M1' },
      { member: 'SLAB-2A', bar: 'SLAB-2A-B1' },
    ];
    for (const { member, bar } of marks) {
      const record = toRowRecord(row({ memberMark: member, barMark: bar }), 0, 'run-1', CTX);
      expect(record.member_id).toBe(member);
      expect(record.bar_mark).toBe(bar);
      expect(record.status).toBe('CALCULATED');
    }
  });

  it('stamps the owner and project from the caller, never from the row', () => {
    const record = toRowRecord(row(), 0, 'run-1', CTX);
    expect(record.user_id).toBe('u-1');
    expect(record.project_id).toBe('p-1');
  });
});
