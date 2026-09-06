// calculations/schedule.ts — the one place a reinforcement row becomes a
// BbsRow, stage by stage, with its trace. Nothing here re-derives a number:
// the assertions are about which stage stopped a row, what it names as
// missing, what cover it says it was cut to, and that Σ rows reconciles.
import { describe, expect, it } from 'vitest';
import {
  ROW_STAGES,
  buildSteelSummary,
  calculateQuantity,
  calculateWeight,
  reconcileSchedule,
  resolveCuttingLength,
  resolveGeometry,
  scheduleRow,
  scheduleSnapshot,
  type ScheduleRowInput,
} from '../../calculations/schedule';
import { DEFAULT_SETTINGS } from '../../src/cad/bbs/build';
import type { BbsBar, BbsMember, BbsSettings } from '../../src/cad/bbs/types';

const member = (over: Partial<BbsMember> = {}): BbsMember => ({
  mark: 'F8',
  type: 'footing',
  lengthMm: 3500,
  widthMm: 3200,
  heightMm: 575,
  count: 8,
  dimSources: { L: 'DRAWING_READ — FOOTING SCHEDULE row F8, column "L" = 3500', W: 'DRAWING_READ — FOOTING SCHEDULE row F8, column "W SIZE" = 3200' },
  source: { table: 'FOOTING SCHEDULE', row: 7 },
  incomplete: false,
  missing: [],
  ...over,
});

const bar = (over: Partial<BbsBar> = {}): BbsBar =>
  ({
    memberMark: 'F8',
    barType: 'BOTTOM',
    diaMm: 10,
    shapeCode: '00',
    spacingMm: 100,
    distributionAxis: 'W',
    fromCallout: '10@100c/c',
    handles: ['52F00E'],
    ...over,
  }) as BbsBar;

/** cover stated by a person — 50 mm — so the rows compute */
const STATED: BbsSettings = { ...DEFAULT_SETTINGS, coverSource: 'stated' };
/** cover nobody stated — the caller has established that */
const UNSTATED: BbsSettings = { ...DEFAULT_SETTINGS, coverSource: 'default' };

const input = (over: Partial<ScheduleRowInput> = {}): ScheduleRowInput => ({
  bar: bar(),
  member: member(),
  settings: STATED,
  runMm: null,
  takeoffCount: null,
  coverTable: [],
  barMark: 'F8-M1',
  description: 'Long bar T10 @ 100c/c (Btm)',
  ...over,
});

describe('the stage pipeline', () => {
  it('lists the stages in the order the contract names them', () => {
    expect([...ROW_STAGES]).toEqual([
      'INPUT_RESOLVED',
      'GEOMETRY_RESOLVED',
      'CUTTING_LENGTH_RESOLVED',
      'QUANTITY_RESOLVED',
      'TOTAL_BARS_RESOLVED',
      'TOTAL_LENGTH_RESOLVED',
      'UNIT_WEIGHT_RESOLVED',
      'WEIGHT_RESOLVED',
      'VALIDATED',
    ]);
  });

  it('carries a complete row through every stage and names the facts it rests on', () => {
    const { row, trace } = scheduleRow(input());
    expect(trace.stages).toEqual([...ROW_STAGES]);
    expect(trace.failedStage).toBeUndefined();
    // geometry: a long bar spaced along W runs along L
    expect(row.cuttingLengthMm).toBe(3500 - 2 * 50);
    expect(row.lengthSource).toBe('SHAPE_FORMULA');
    // quantity: ⌈(3200 − 2×50) / 100⌉ + 1 = 32 per footing, × 8 footings
    expect(row.barsPerMember).toBe(32);
    expect(row.memberCount).toBe(8);
    expect(row.totalBars).toBe(256);
    // weight: 3400 × 256 / 1000 = 870.4 m × 0.617
    expect(row.totalLengthM).toBeCloseTo(870.4, 3);
    expect(row.unitWeightKgPerM).toBeCloseTo(0.617, 3);
    expect(row.weightKg).toBeCloseTo(870.4 * 0.617, 2);
    expect(trace.factsUsed).toEqual(expect.arrayContaining(['F8.length', 'F8.width', 'F8.height', 'F8.count', 'settings.cover']));
    expect(trace.coverStatus).toBe('USER_INPUT');
    expect(trace.measuredAlong).toBe('L');
    expect(row.trace).toBe(trace);
  });

  it('holds a row open at GEOMETRY_RESOLVED when the axis it runs along is not on record — and names it', () => {
    const { row, trace } = scheduleRow(input({ member: member({ lengthMm: undefined, dimSources: {} }) }));
    expect(row.cuttingLengthMm).toBeNull();
    expect(row.weightKg).toBeNull();
    expect(trace.failedStage).toBe('GEOMETRY_RESOLVED');
    expect(trace.missingFact).toBe('F8.length');
    expect(trace.source).toMatch(/L=not on record/);
    expect(trace.reason).toMatch(/member L dimension not on this sheet/);
    expect(trace.action).toMatch(/Provide F8.length in mm/);
    expect(trace.stages).not.toContain('CUTTING_LENGTH_RESOLVED');
    // the count still stands: it owes nothing to L
    expect(row.barsPerMember).toBe(32);
  });

  it('names the spacing axis when only the count is missing', () => {
    const { row, trace } = scheduleRow(input({ member: member({ widthMm: undefined }) }));
    expect(row.cuttingLengthMm).toBe(3400);
    expect(row.barsPerMember).toBeNull();
    expect(row.totalBars).toBeNull();
    expect(trace.failedStage).toBe('QUANTITY_RESOLVED');
    expect(trace.missingFact).toBe('F8.width');
    expect(trace.reason).toMatch(/Resolve F8\.W/);
  });

  it('holds a row open on settings.cover when nobody stated the cover, and never zeros it', () => {
    const { row, trace } = scheduleRow(input({ settings: UNSTATED }));
    expect(row.cuttingLengthMm).toBeNull();
    expect(row.weightKg).toBeNull();
    expect(row.totalLengthM).toBeNull();
    expect(trace.failedStage).toBe('CUTTING_LENGTH_RESOLVED');
    expect(trace.missingFact).toBe('settings.cover');
    expect(trace.coverStatus).toBe('ASSUMED');
    expect(trace.action).toMatch(/clear cover/i);
    expect(row.missing).toMatch(/50 mm project default was NOT used/);
  });

  it('computes with an ASSUMED cover only when the caller never established the source, and says so on the row', () => {
    const settings: BbsSettings = { ...DEFAULT_SETTINGS };
    delete (settings as Partial<BbsSettings>).coverSource;
    const { row, trace } = scheduleRow(input({ settings }));
    expect(row.cuttingLengthMm).toBe(3400);
    expect(row.lengthSource).toBe('SHAPE_FORMULA'); // an assumption is not a different derivation
    expect(row.coverStatus).toBe('ASSUMED');
    expect(trace.coverStatus).toBe('ASSUMED');
    expect(row.warnings.join('\n')).toMatch(/Cover 50 mm ASSUMED — the 50 mm project default/);
  });

  it('reports a cover read off the sheet as DRAWING_READ', () => {
    const { row } = scheduleRow(input({ member: member({ coverMm: 40, coverSource: 'member-cover-table' }) }));
    expect(row.coverMm).toBe(40);
    expect(row.coverStatus).toBe('DRAWING_READ');
    expect(row.cuttingLengthMm).toBe(3500 - 80);
  });

  it('prefers an entered cutting length over the formula, marked ENTERED', () => {
    const { row, trace } = scheduleRow(input({ enteredCuttingLengthMm: 3600 }));
    expect(row.cuttingLengthMm).toBe(3600);
    expect(row.lengthSource).toBe('ENTERED');
    expect(trace.stages).toContain('VALIDATED');
  });

  it('DISPUTES the axis when a bar comes out under its own anchorage — never declares the callout a dimension', () => {
    const { row, trace } = scheduleRow(
      input({
        bar: bar({ barType: 'MAIN', diaMm: 16, distributionAxis: undefined, spacingMm: undefined, manualCount: 4 }),
        member: member({ mark: 'P1', heightMm: 300, lengthMm: 1000, widthMm: 1000 }),
      }),
    );
    expect(row.cuttingLengthMm).toBeNull();
    expect(row.disputedAxis).toBe('H');
    expect(row.missing).toMatch(/AXIS DISPUTED \(P1\.height\)/);
    expect(row.missing).toMatch(/measured along the member's H = 300 mm/);
    expect(row.missing).toMatch(/still a reinforcement bar/);
    expect(row.missing).not.toMatch(/not a bar/);
    expect(trace.missingFact).toBe('P1.height');
    expect(trace.action).toMatch(/P1\.height/);
  });
});

describe('the stages on their own', () => {
  it('resolveGeometry names what a bar needs and what is absent', () => {
    const g = resolveGeometry({ bar: bar(), member: member({ lengthMm: undefined }), settings: STATED });
    expect(g.ok).toBe(false);
    expect(g.runsAlong).toBe('L');
    expect(g.spacedAlong).toBe('W');
    expect(g.missingAxes).toEqual(['L']);
    expect(g.coverStatus).toBe('USER_INPUT');
  });

  it('resolveCuttingLength states the priority it cut by', () => {
    const g = resolveGeometry({ bar: bar(), member: member(), settings: STATED });
    expect(resolveCuttingLength({ bar: bar(), member: member(), settings: STATED, runMm: null, enteredCuttingLengthMm: 3600 }, g).by).toBe('ENTERED');
    expect(resolveCuttingLength({ bar: bar(), member: member(), settings: STATED, runMm: null }, g).by).toBe('SHAPE_FORMULA');
    expect(resolveCuttingLength({ bar: bar(), member: member(), settings: UNSTATED, runMm: null }, g).by).toBe('BLOCKED');
  });

  it('calculateQuantity never re-derives an explicit count from spacing', () => {
    const q = calculateQuantity({ bar: bar({ manualCount: 6 }), member: member(), settings: STATED, runMm: null, takeoffCount: null });
    expect(q.mode).toBe('MANUAL');
    expect(q.barsPerMember).toBe(6);
    expect(q.totalBars).toBe(48);
    const auto = calculateQuantity({ bar: bar(), member: member(), settings: STATED, runMm: null, takeoffCount: null });
    expect(auto.mode).toBe('AUTO_SPACING');
    expect(auto.factsUsed).toContain('F8.width');
  });

  it('calculateWeight is null all the way down without a length or a count', () => {
    expect(calculateWeight(null, 10, 10, 3).weightKg).toBeNull();
    expect(calculateWeight(3400, null, 10, 3).weightKg).toBeNull();
    const w = calculateWeight(3400, 256, 10, 3);
    expect(w.totalLengthM).toBeCloseTo(870.4, 3);
    expect(w.weightWithWastageKg).toBeCloseTo(870.4 * 0.617 * 1.03, 2);
  });
});

describe('summary and reconciliation', () => {
  it('groups by diameter only and reconciles against the rows, with open rows listed not zeroed', () => {
    const a = scheduleRow(input()).row;
    const b = scheduleRow(input({ bar: bar({ diaMm: 12, spacingMm: 200 }), barMark: 'F8-M2' })).row;
    const open = scheduleRow(input({ member: member({ lengthMm: undefined }), barMark: 'F8-M3' })).row;
    const rows = [a, b, open];
    const summary = buildSteelSummary(rows, 3);
    expect(summary.map((s) => s.diaMm)).toEqual([10, 12]);
    const rec = reconcileSchedule(rows, summary);
    expect(rec.ok).toBe(true);
    expect(rec.openRows).toEqual(['F8-M3']);
    expect(rec.rowsTotalWeightKg).toBeCloseTo((a.weightKg ?? 0) + (b.weightKg ?? 0), 6);
    expect(rec.summaryTotalWeightKg).toBeCloseTo(rec.rowsTotalWeightKg, 6);
    expect(rec.rowsTotalLengthM).toBeCloseTo(rec.summaryTotalLengthM, 6);
  });

  it('says NOT RECONCILED when the summary disagrees with its rows', () => {
    const a = scheduleRow(input()).row;
    const summary = buildSteelSummary([a], 3).map((s) => ({ ...s, totalWeightKg: s.totalWeightKg + 5 }));
    const rec = reconcileSchedule([a], summary);
    expect(rec.ok).toBe(false);
    expect(rec.differences).toHaveLength(1);
    expect(rec.differences[0].weightDiffKg).toBeCloseTo(5, 6);
  });

  it('prints the snapshot the run hands over before returning', () => {
    const a = scheduleRow(input()).row;
    const open = scheduleRow(input({ member: member({ lengthMm: undefined }), barMark: 'F8-M3' })).row;
    const summary = buildSteelSummary([a, open], 3);
    const lines = scheduleSnapshot({
      drawing: 'Foundations drawings',
      drawingHash: 'abc123',
      factVersion: 42,
      rows: [a, open],
      reconciliation: reconcileSchedule([a, open], summary),
    });
    expect(lines[0]).toMatch(/^CURRENT DRAWING\s+Foundations drawings/);
    expect(lines[1]).toMatch(/^DRAWING HASH\s+abc123/);
    expect(lines[2]).toMatch(/^FACT VERSION\s+42/);
    expect(lines[3]).toMatch(/^TOTAL ROWS\s+2/);
    expect(lines[4]).toMatch(/^CALCULATED ROWS\s+1/);
    expect(lines[5]).toMatch(/^BLOCKED ROWS\s+1/);
    expect(lines[6]).toMatch(/^STALE ROWS\s+0/);
    expect(lines[7]).toMatch(/^MISSING FACTS\s+1 — F8\.length/);
    expect(lines[8]).toMatch(/^UNREADABLE FACTS\s+0/);
    expect(lines[9]).toMatch(/^RECONCILED/);
  });
});
