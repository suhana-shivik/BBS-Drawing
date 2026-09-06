// ============================================================
// THE ENGINE, CASE BY CASE — §29 and §30 of the brief.
//
// Every shape in the library, every quantity mode, every IS rule, every
// priority the pipeline applies, and every member kind it must serve: beam,
// column, slab, wall, stair, footing, custom. No member name from any real
// drawing appears in calculation logic; the marks below are fixtures and
// could be anything.
// ============================================================
import { describe, expect, it } from 'vitest';
import {
  SHAPES,
  bendDeduction,
  countBySpacing,
  developmentLength,
  hookAllowance,
  lapLength,
  polylineLength,
  shapeLength,
  steelSummary,
  unitWeight,
} from '../../../src/domain/india/bbs';
import {
  buildSteelSummary,
  calculateQuantity,
  calculateWeight,
  reconcileRows,
  reconcileSchedule,
  resolveCuttingLength,
  resolveGeometry,
  scheduleRow,
  secondOpinionLength,
  type ScheduleRowInput,
} from '../../../calculations/schedule';
import { validateRow, validateSchedule } from '../../../calculations/validation';
import type { BbsBar, BbsMember, BbsSettings } from '../../../src/cad/bbs/types';

// ------------------------------------------------------------
// fixtures — generic, named by role
// ------------------------------------------------------------
const settings = (over: Partial<BbsSettings> = {}): BbsSettings => ({
  concreteGrade: 'M25',
  steelGrade: 'Fe500',
  coverMm: 40,
  coverSource: 'stated',
  bendMode: 'CONVENTIONAL',
  wastagePct: 3,
  ...over,
});

const member = (over: Partial<BbsMember> & { mark: string }): BbsMember => ({
  type: 'member',
  count: 1,
  source: { table: '', row: 0 },
  incomplete: false,
  missing: [],
  ...over,
});

const bar = (over: Partial<BbsBar> & { memberMark: string; diaMm: number }): BbsBar => ({
  barType: 'MAIN',
  shapeCode: '00',
  fromCallout: `${over.diaMm}@${over.spacingMm ?? 150}c/c`,
  handles: ['H1'],
  ...over,
});

const rowInput = (b: BbsBar, m: BbsMember, over: Partial<ScheduleRowInput> = {}): ScheduleRowInput => ({
  bar: b,
  member: m,
  settings: settings(),
  runMm: null,
  takeoffCount: null,
  coverTable: [],
  barMark: `${m.mark}-${b.diaMm}`,
  description: `${b.barType} T${b.diaMm}`,
  ...over,
});

// ------------------------------------------------------------
// §8 — the shape library, one case each
// ------------------------------------------------------------
describe('shape formulas', () => {
  it('00 straight: A', () => expect(shapeLength('00', { A: 2420 })).toBe(2420));
  it('11 L: A + B', () => expect(shapeLength('11', { A: 2420, B: 270 })).toBe(2690));
  it('21 U: A + B + C', () => expect(shapeLength('21', { A: 2420, B: 270, C: 270 })).toBe(2960));
  it('31 triangle: A + B + C', () => expect(shapeLength('31', { A: 300, B: 400, C: 500 })).toBe(1200));
  it('34 crank: A + C × B × tan(D/2), D defaults to 45°', () => {
    expect(shapeLength('34', { A: 1000, B: 200, C: 2 })).toBeCloseTo(1000 + 2 * 200 * Math.tan(Math.PI / 8), 6);
    expect(shapeLength('34', { A: 1000, B: 200, C: 2, D: 60 })).toBeCloseTo(1000 + 2 * 200 * Math.tan(Math.PI / 6), 6);
  });
  it('41 rectangle: 2(A + B)', () => expect(shapeLength('41', { A: 300, B: 500 })).toBe(1600));
  it('51 closed stirrup: 2(A + B)', () => expect(shapeLength('51', { A: 220, B: 420 })).toBe(1280));
  it('52 open stirrup: A + 2B', () => expect(shapeLength('52', { A: 220, B: 420 })).toBe(1060));
  it('60 ring: πA', () => expect(shapeLength('60', { A: 500 })).toBeCloseTo(Math.PI * 500, 6));
  it('POL polygon: B × A', () => expect(shapeLength('POL', { A: 300, B: 6 })).toBe(1800));
  it('77 spiral: n × √((πA)² + B²), n = C/B + 1', () => {
    const A = 400, B = 100, C = 3000;
    const n = C / B + 1;
    expect(shapeLength('77', { A, B, C })).toBeCloseTo(n * Math.sqrt((Math.PI * A) ** 2 + B ** 2), 6);
  });
  it('CUS custom: the drawn developed length, and nothing else', () => {
    expect(shapeLength('CUS', { CUS: 3141 })).toBe(3141);
    expect(shapeLength('CUS', {})).toBeNull();
    expect(SHAPES.CUS.formulaText).toMatch(/drawn geometry/);
  });
  it('a polyline is measured, open or closed', () => {
    const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect(polylineLength(square)).toBe(300);
    expect(polylineLength(square, true)).toBe(400);
    expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }])).toBe(5);
  });
});

// ------------------------------------------------------------
// §11 / §12 / §13 — quantity
// ------------------------------------------------------------
describe('quantity', () => {
  it('AUTO_SPACING: ceil((axis − 2·cover) / spacing) + 1 — the fencepost is kept', () => {
    const c = countBySpacing(2500, 150, 40)!;
    expect(c.count).toBe(Math.ceil(2420 / 150) + 1); // 17 + 1 = 18
    expect(countBySpacing(2500, 150, 40)!.count).not.toBe(Math.floor(2420 / 150));
  });

  it('MANUAL: an explicit count is never re-derived from spacing', () => {
    const q = calculateQuantity(rowInput(bar({ memberMark: 'X', diaMm: 12, manualCount: 6, spacingMm: 150, distributionAxis: 'L' }), member({ mark: 'X', lengthMm: 3000, widthMm: 300, heightMm: 450, count: 4 })));
    expect(q.mode).toBe('MANUAL');
    expect(q.barsPerMember).toBe(6);
  });

  it('member_count × bars_per_member = total_bar_count, kept separately', () => {
    const q = calculateQuantity(rowInput(bar({ memberMark: 'X', diaMm: 12, manualCount: 12 }), member({ mark: 'X', lengthMm: 2000, widthMm: 2000, heightMm: 400, count: 20 })));
    expect(q.barsPerMember).toBe(12);
    expect(q.memberCount).toBe(20);
    expect(q.totalBars).toBe(240);
  });

  it('a count that cannot be derived is null — never 0, never 1', () => {
    const q = calculateQuantity(rowInput(bar({ memberMark: 'X', diaMm: 10, spacingMm: 150, distributionAxis: 'L' }), member({ mark: 'X', widthMm: 2000, heightMm: 400, count: 0 })));
    expect(q.barsPerMember).toBeNull();
    expect(q.memberCount).toBeNull();
    expect(q.totalBars).toBeNull();
  });

  it('CUSTOM_FORMULA: a stated rule over the approved variables', () => {
    const q = calculateQuantity(rowInput(bar({ memberMark: 'X', diaMm: 10, spacingMm: 150, countFormula: 'CEIL((L - 2 * COVER) / S) + 1' }), member({ mark: 'X', lengthMm: 2500, widthMm: 2300, heightMm: 350, count: 2 })));
    expect(q.mode).toBe('CUSTOM_FORMULA');
    expect(q.barsPerMember).toBe(18);
    expect(q.totalBars).toBe(36);
  });

  it('CUSTOM_FORMULA that names the unknown blocks the row and says which', () => {
    const q = calculateQuantity(rowInput(bar({ memberMark: 'X', diaMm: 10, countFormula: 'L / S + 1' }), member({ mark: 'X', lengthMm: 2500, count: 2 })));
    expect(q.barsPerMember).toBeNull();
    expect(q.missing).toMatch(/S is not on record/);
  });
});

// ------------------------------------------------------------
// §14 – §17 — IS 456 / IS 2502
// ------------------------------------------------------------
describe('IS rules', () => {
  it('development length Ld = φ·0.87fy / (4·τbd·1.6) for deformed bars', () => {
    const ld = developmentLength(16, 'M25', 'Fe500')!;
    expect(ld.ldMm).toBeCloseTo((16 * 0.87 * 500) / (4 * 1.4 * 1.6), 3);
    expect(ld.working).toContain('1.6');
  });
  it('bond stress is not extrapolated past M40', () => {
    expect(developmentLength(16, 'M50', 'Fe500')!.ldMm).toBeCloseTo(developmentLength(16, 'M40', 'Fe500')!.ldMm, 6);
  });
  it('compression bond is 25 % higher', () => {
    const t = developmentLength(16, 'M25', 'Fe500')!.ldMm;
    const c = developmentLength(16, 'M25', 'Fe500', { compression: true } as never)!;
    expect(c.ldMm).toBeLessThan(t);
  });
  it('lap: tension max(Ld, 30φ); compression max(Ld, 24φ)', () => {
    expect(lapLength(12, 300).lapMm).toBe(360);
    expect(lapLength(12, 300).governedBy).toBe('minimum');
    expect(lapLength(12, 600).lapMm).toBe(600);
    expect(lapLength(12, 200, true).lapMm).toBe(288);
  });
  it('hooks: 90° 8φ, 135° 10φ, 180° 9φ, all at least 75 mm', () => {
    expect(hookAllowance(10, 'hook90')).toBe(80);
    expect(hookAllowance(10, 'hook135')).toBe(100);
    expect(hookAllowance(10, 'hook180')).toBe(90);
    expect(hookAllowance(6, 'hook90')).toBe(75);
    expect(hookAllowance(10, 'none')).toBe(0);
  });
  it('bend deduction, conventional: 45° 1φ, 90° 2φ, 135° 3φ', () => {
    expect(bendDeduction(12, 45, 'CONVENTIONAL').deductionMm).toBe(12);
    expect(bendDeduction(12, 90, 'CONVENTIONAL').deductionMm).toBe(24);
    expect(bendDeduction(12, 135, 'CONVENTIONAL').deductionMm).toBe(36);
  });
  it('bend deduction, arc-exact: R(2·tan(θ/2) − θ) with R = r + φ/2; stirrups 2φ, main 4φ', () => {
    const main = bendDeduction(12, 90, 'ARC_EXACT');
    const R = 4 * 12 + 6;
    expect(main.deductionMm).toBeCloseTo(R * (2 - Math.PI / 2), 6);
    const link = bendDeduction(12, 90, 'ARC_EXACT', { stirrup: true });
    expect(link.deductionMm).toBeCloseTo((2 * 12 + 6) * (2 - Math.PI / 2), 6);
    expect(link.deductionMm).toBeLessThan(main.deductionMm);
  });
});

// ------------------------------------------------------------
// §19 / §20 — weight and summary
// ------------------------------------------------------------
describe('weight and summary', () => {
  it('IS 1786 nominal masses, and density for anything else, marked DERIVED', () => {
    expect(unitWeight(10)).toEqual({ kgPerM: 0.617, source: 'IS_1786' });
    expect(unitWeight(32)).toEqual({ kgPerM: 6.31, source: 'IS_1786' });
    const odd = unitWeight(14)!;
    expect(odd.source).toBe('DENSITY_FALLBACK');
    expect(odd.kgPerM).toBeCloseTo((Math.PI / 4) * 0.014 ** 2 * 7850, 6);
  });
  it('total length = CL × bars / 1000; weight = m × kg/m; wastage on top', () => {
    const w = calculateWeight(2420, 36, 10, 3);
    expect(w.totalLengthM).toBeCloseTo(87.12, 6);
    expect(w.weightKg).toBeCloseTo(87.12 * 0.617, 6);
    expect(w.weightWithWastageKg).toBeCloseTo(87.12 * 0.617 * 1.03, 6);
  });
  it('the summary groups by diameter only and reports the lap share inside the total', () => {
    const lines = steelSummary(
      [
        { diaMm: 10, cuttingLengthMm: 2000, totalBars: 10 },
        { diaMm: 10, cuttingLengthMm: 3000, totalBars: 10, lapMm: 500 },
        { diaMm: 12, cuttingLengthMm: 1000, totalBars: 5 },
      ],
      5,
    );
    expect(lines.map((l) => l.diaMm)).toEqual([10, 12]);
    const t10 = lines[0];
    expect(t10.barCount).toBe(20);
    expect(t10.totalLengthM).toBe(50);
    expect(t10.totalWeightKg).toBeCloseTo(50 * 0.617, 6);
    expect(t10.totalWeightWithWastageKg).toBeCloseTo(50 * 0.617 * 1.05, 6);
    expect(t10.lapWeightKg).toBeCloseTo(5 * 0.617, 6);
    expect(t10.totalWeightMt).toBeCloseTo(t10.totalWeightKg / 1000, 9);
    // lap is a SHARE of the total, not an addition to it
    expect(t10.lapWeightKg).toBeLessThan(t10.totalWeightKg);
  });
});

// ------------------------------------------------------------
// §9 — cutting-length priority
// ------------------------------------------------------------
describe('cutting-length priority', () => {
  const m = member({ mark: 'X', lengthMm: 2500, widthMm: 2300, heightMm: 350, count: 2 });
  const straight = bar({ memberMark: 'X', diaMm: 10, spacingMm: 150, distributionAxis: 'W' });

  it('1. an entered length wins over everything', () => {
    const input = rowInput({ ...straight, drawnGeometry: { developedLengthMm: 9999, source: 'detail' } }, m, { enteredCuttingLengthMm: 2400 });
    const r = resolveCuttingLength(input, resolveGeometry(input));
    expect(r.by).toBe('ENTERED');
    expect(r.cuttingLengthMm).toBe(2400);
  });

  it('2. drawn geometry wins over the shape formula — a developed length as stated', () => {
    const input = rowInput({ ...straight, shapeCode: '11', drawnGeometry: { developedLengthMm: 2870, source: 'SECTION A-A' } }, m);
    const r = resolveCuttingLength(input, resolveGeometry(input));
    expect(r.by).toBe('DRAWN_GEOMETRY');
    expect(r.cuttingLengthMm).toBe(2870);
    expect(r.working).toMatch(/no shape formula applied/);
  });

  it('2. drawn geometry wins over the shape formula — a polyline summed', () => {
    const input = rowInput(
      { ...straight, drawnGeometry: { vertices: [{ x: 0, y: 0 }, { x: 2420, y: 0 }, { x: 2420, y: 270 }], source: 'SECTION A-A' } },
      m,
    );
    const r = resolveCuttingLength(input, resolveGeometry(input));
    expect(r.by).toBe('DRAWN_GEOMETRY');
    expect(r.cuttingLengthMm).toBe(2690);
  });

  it('3. a stated length formula', () => {
    const input = rowInput({ ...straight, lengthFormula: 'W - 2 * COVER + 2 * 8 * DIA' }, m);
    const r = resolveCuttingLength(input, resolveGeometry(input));
    expect(r.by).toBe('CUSTOM_FORMULA');
    expect(r.cuttingLengthMm).toBe(2300 - 80 + 160);
  });

  it('4. the shape formula, cut to the cover', () => {
    const input = rowInput(straight, m);
    const r = resolveCuttingLength(input, resolveGeometry(input));
    expect(r.by).toBe('SHAPE_FORMULA');
    // spaced along W, so it runs along L and is cut to L − 2·cover
    expect(r.cuttingLengthMm).toBe(2500 - 2 * 40);
  });

  it('5. otherwise unresolved — never zero, never invented', () => {
    const input = rowInput(straight, member({ mark: 'X', count: 2 }));
    const r = resolveCuttingLength(input, resolveGeometry(input));
    expect(r.by).toBe('BLOCKED');
    expect(r.cuttingLengthMm).toBeNull();
    expect(r.missing).toBeTruthy();
  });

  it('a custom shape with nothing drawn is unresolved, and says what to do', () => {
    const input = rowInput({ ...straight, shapeCode: 'CUS' }, m);
    const r = resolveCuttingLength(input, resolveGeometry(input));
    expect(r.by).toBe('BLOCKED');
    expect(r.missing).toMatch(/trace the bar on the detail/);
  });
});

// ------------------------------------------------------------
// §18 — the second opinion
// ------------------------------------------------------------
describe('the second opinion', () => {
  it('corroborates a straight bar to within tolerance and shows its terms', () => {
    const m = member({ mark: 'X', lengthMm: 2500, widthMm: 2300, heightMm: 350, count: 2 });
    const out = scheduleRow(rowInput(bar({ memberMark: 'X', diaMm: 10, spacingMm: 150, distributionAxis: 'W' }), m));
    const so = out.row.secondOpinion!;
    expect(so.withinTolerance).toBe(true);
    expect(so.terms.map((t) => t.term)).toContain('arm A');
    expect(so.primaryMm).toBe(out.row.cuttingLengthMm);
    expect(out.row.engineering).toBe('VALIDATED');
  });

  it('corroborates a closed link in exact-arc geometry against the conventional primary', () => {
    const m = member({ mark: 'B', lengthMm: 6000, widthMm: 300, heightMm: 500, count: 1, type: 'beam' });
    const link = bar({ memberMark: 'B', diaMm: 8, barType: 'STIRRUP', shapeCode: '51', spacingMm: 150, distributionAxis: 'L', hookStart: 'hook135', hookEnd: 'hook135' });
    const out = scheduleRow(rowInput(link, m));
    const so = out.row.secondOpinion!;
    expect(so.terms.map((t) => t.term).join(' ')).toMatch(/bend deduction/);
    expect(so.terms.map((t) => t.term).join(' ')).toMatch(/bend allowance/);
    expect(so.terms.map((t) => t.term).join(' ')).toMatch(/hook135/);
    expect(so.withinTolerance).toBe(true);
  });

  it('rejects a row whose entered length the geometry cannot support', () => {
    // A typed length is not second-guessed; a formula the drawing contradicts is.
    const m = member({ mark: 'X', lengthMm: 2500, widthMm: 2300, heightMm: 350, count: 2 });
    const wrong = bar({ memberMark: 'X', diaMm: 10, spacingMm: 150, distributionAxis: 'W', lengthFormula: 'W' }); // forgot the cover
    const out = scheduleRow(rowInput(wrong, m));
    expect(out.row.secondOpinion!.withinTolerance).toBe(false);
    expect(out.row.engineering).toBe('REJECTED');
    expect(out.row.warnings.join(' ')).toMatch(/SECOND OPINION disagrees/);
  });

  it('is an independent derivation — it exists without the primary', () => {
    const m = member({ mark: 'X', lengthMm: 2500, widthMm: 2300, heightMm: 350, count: 2 });
    const so = secondOpinionLength(bar({ memberMark: 'X', diaMm: 10, distributionAxis: 'W', shapeCode: '11' }), m, settings());
    expect(so).not.toBeNull();
    expect(so!.terms.length).toBeGreaterThanOrEqual(3);
  });
});

// ------------------------------------------------------------
// §24 / §25 — calculated is not validated
// ------------------------------------------------------------
describe('validation', () => {
  const m = member({ mark: 'X', lengthMm: 2500, widthMm: 2300, heightMm: 350, count: 2 });

  it('a row cut to an ASSUMED cover computes and is PARTIALLY_VALIDATED, not VALIDATED', () => {
    const out = scheduleRow(rowInput(bar({ memberMark: 'X', diaMm: 10, spacingMm: 150, distributionAxis: 'W' }), m, { settings: settings({ coverMm: 50, coverSource: undefined }) }));
    expect(out.row.weightKg).not.toBeNull();
    expect(out.row.coverStatus).toBe('ASSUMED');
    expect(out.row.engineering).toBe('PARTIALLY_VALIDATED');
    const v = validateRow(out.row);
    expect(v.assumed.join(' ')).toMatch(/cover 50 mm/);
  });

  it('a row with no member count is UNVALIDATED and names the fact', () => {
    const out = scheduleRow(rowInput(bar({ memberMark: 'X', diaMm: 10, spacingMm: 150, distributionAxis: 'W' }), member({ ...m, count: 0 })));
    expect(out.row.engineering).toBe('UNVALIDATED');
    expect(validateRow(out.row).unresolved).toContain('X.count');
  });

  it('the schedule is FINAL only when every row is VALIDATED and nothing is stale', () => {
    const good = scheduleRow(rowInput(bar({ memberMark: 'X', diaMm: 10, spacingMm: 150, distributionAxis: 'W' }), m)).row;
    const assumed = scheduleRow(rowInput(bar({ memberMark: 'X', diaMm: 12, spacingMm: 200, distributionAxis: 'L' }), m, { settings: settings({ coverMm: 50, coverSource: undefined }) })).row;
    const open = scheduleRow(rowInput(bar({ memberMark: 'Y', diaMm: 10, spacingMm: 150, distributionAxis: 'W' }), member({ mark: 'Y', count: 3 }))).row;

    const all = validateSchedule([good, good, good]);
    expect(all.final).toBe(true);
    expect(all.status).toBe('VALIDATED');
    expect(all.counts).toMatchObject({ rows: 3, calculated: 3, open: 0, validated: 3 });

    const mixed = validateSchedule([good, assumed, open]);
    expect(mixed.final).toBe(false);
    expect(mixed.counts).toMatchObject({ calculated: 2, open: 1, assumedInputs: 1, unvalidated: 1, partiallyValidated: 1 });
    expect(mixed.blockers.join(' ')).toMatch(/unresolved/);
    expect(mixed.blockers.join(' ')).toMatch(/assumption/);

    // "34/34 calculated" is NOT final when a dependency changed underneath it
    const stale = validateSchedule([good, good], { stale: true });
    expect(stale.final).toBe(false);
    expect(stale.blockers.join(' ')).toMatch(/changed since/);
    const moved = validateSchedule([good], { drawingHashMatches: false });
    expect(moved.final).toBe(false);
  });

  it('one open row does not block the rows that can compute', () => {
    const rows = [
      scheduleRow(rowInput(bar({ memberMark: 'X', diaMm: 10, spacingMm: 150, distributionAxis: 'W' }), m)).row,
      scheduleRow(rowInput(bar({ memberMark: 'Y', diaMm: 10, spacingMm: 150, distributionAxis: 'W' }), member({ mark: 'Y', count: 3 }))).row,
    ];
    expect(rows[0].weightKg).not.toBeNull();
    expect(rows[1].weightKg).toBeNull();
    const summary = buildSteelSummary(rows, 3);
    expect(summary[0].barCount).toBe(rows[0].totalBars);
    expect(reconcileSchedule(rows, summary).openRows).toEqual([rows[1].barMark]);
  });
});

// ------------------------------------------------------------
// §22 — reconciliation shows DRIFT
// ------------------------------------------------------------
describe('drift', () => {
  it('stored rows that differ from a fresh pass are reported field by field', () => {
    const m = member({ mark: 'X', lengthMm: 2500, widthMm: 2300, heightMm: 350, count: 2 });
    const fresh = scheduleRow(rowInput(bar({ memberMark: 'X', diaMm: 10, spacingMm: 150, distributionAxis: 'W' }), m)).row;
    const stored = { ...fresh, cuttingLengthMm: fresh.cuttingLengthMm! + 100, weightKg: fresh.weightKg! * 2 };
    const drift = reconcileRows([stored], [fresh]);
    expect(drift.map((d) => d.field).sort()).toEqual(['cuttingLengthMm', 'weightKg']);
    expect(reconcileRows([fresh], [fresh])).toEqual([]);
  });
  it('a row on one side only is drift on every field', () => {
    const m = member({ mark: 'X', lengthMm: 2500, widthMm: 2300, heightMm: 350, count: 2 });
    const fresh = scheduleRow(rowInput(bar({ memberMark: 'X', diaMm: 10, spacingMm: 150, distributionAxis: 'W' }), m)).row;
    expect(reconcileRows([], [fresh]).length).toBeGreaterThan(5);
  });
});

// ------------------------------------------------------------
// §30 — every member kind through the same pipeline
// ------------------------------------------------------------
describe('universal members — one engine, no names in the logic', () => {
  const s = settings();

  it('FOOTING: bottom mat both ways, cut to cover, spaced by ceil+1', () => {
    const f = member({ mark: 'PAD-3', lengthMm: 2500, widthMm: 2300, heightMm: 350, count: 4 });
    const alongW = scheduleRow(rowInput(bar({ memberMark: 'PAD-3', diaMm: 10, spacingMm: 150, distributionAxis: 'L' }), f, { settings: s })).row;
    // spaced along L, so it runs along W and is cut to W − 2·cover
    expect(alongW.cuttingLengthMm).toBe(2300 - 80);
    expect(alongW.barsPerMember).toBe(Math.ceil((2500 - 80) / 150) + 1);
    expect(alongW.totalBars).toBe(alongW.barsPerMember! * 4);
    expect(alongW.engineering).toBe('VALIDATED');
  });

  it('COLUMN: verticals run the height; ties wrap the section', () => {
    const c = member({ mark: 'COL-A', type: 'column', lengthMm: 300, widthMm: 400, heightMm: 3000, count: 6 });
    const vertical = scheduleRow(rowInput(bar({ memberMark: 'COL-A', diaMm: 16, manualCount: 8, distributionAxis: 'H' }), c, { settings: s })).row;
    expect(vertical.cuttingLengthMm).toBe(3000 - 80);
    expect(vertical.totalBars).toBe(48);
    const tie = scheduleRow(rowInput(bar({ memberMark: 'COL-A', diaMm: 8, barType: 'TIE', shapeCode: '51', spacingMm: 150, distributionAxis: 'H', hookStart: 'hook135', hookEnd: 'hook135' }), c, { settings: s })).row;
    const A = 300 - 80 - 8, B = 400 - 80 - 8;
    // hook135 on T8 is 10φ = 80; four 90° corners at 2φ each
    expect(tie.cuttingLengthMm).toBeCloseTo(2 * (A + B) + 2 * 80 - 4 * 16, 6);
    expect(tie.barsPerMember).toBe(Math.ceil((3000 - 80) / 150) + 1);
  });

  it('BEAM: stirrups along the span, cut from the section', () => {
    // a running member's length must be a STATED fact for bars to be counted along it
    const b = member({ mark: 'B-12', type: 'beam', lengthMm: 6000, widthMm: 300, heightMm: 500, count: 3, dimSources: { L: 'DRAWING_READ — beam schedule' } });
    const stirrup = scheduleRow(rowInput(bar({ memberMark: 'B-12', diaMm: 8, barType: 'STIRRUP', shapeCode: '51', spacingMm: 150, distributionAxis: 'L' }), b, { settings: s })).row;
    expect(stirrup.cuttingLengthMm).toBeCloseTo(2 * (300 - 88 + 500 - 88) - 4 * 16, 6);
    expect(stirrup.barsPerMember).toBeGreaterThan(30);
    expect(stirrup.engineering).toBe('VALIDATED');
  });

  it('SLAB: main and distribution mats over the panel', () => {
    const panel = member({ mark: 'S-2', type: 'slab panel', lengthMm: 4000, widthMm: 3000, heightMm: 150, count: 2 });
    const mainBar = scheduleRow(rowInput(bar({ memberMark: 'S-2', diaMm: 10, spacingMm: 150, distributionAxis: 'L' }), panel, { settings: s })).row;
    const dist = scheduleRow(rowInput(bar({ memberMark: 'S-2', diaMm: 8, barType: 'DISTRIBUTION', spacingMm: 200, distributionAxis: 'W' }), panel, { settings: s })).row;
    expect(mainBar.cuttingLengthMm).toBe(3000 - 80);
    expect(dist.cuttingLengthMm).toBe(4000 - 80);
    expect(mainBar.barsPerMember).toBe(Math.ceil((4000 - 80) / 150) + 1);
    expect(dist.barsPerMember).toBe(Math.ceil((3000 - 80) / 200) + 1);
  });

  it('WALL: a running structure — verticals from the height, horizontals from the run with laps', () => {
    const w = member({ mark: 'RCC WALL', type: 'wall', widthMm: 200, heightMm: 1800, count: 1 });
    const vertical = scheduleRow(rowInput(bar({ memberMark: 'RCC WALL', diaMm: 10, spacingMm: 200, distributionAxis: 'L' }), w, { settings: s, runMm: 24_000 })).row;
    expect(vertical.cuttingLengthMm).toBe(1800 - 80);
    expect(vertical.barsPerMember).toBe(Math.floor(24_000 / 200) + 1);
    const horizontal = scheduleRow(rowInput(bar({ memberMark: 'RCC WALL', diaMm: 10, manualCount: 6, distributionAxis: 'H' }), w, { settings: s, runMm: 24_000 })).row;
    expect(horizontal.lapMm).toBeGreaterThan(0);
    expect(horizontal.cuttingLengthMm).toBe(24_000 + horizontal.lapMm!);
    // the lap is inside the length, and the summary reports it as a share
    const summary = buildSteelSummary([horizontal], 0);
    expect(summary[0].lapWeightKg).toBeCloseTo((horizontal.lapMm! * 6) / 1000 * 0.617, 6);
    expect(summary[0].totalWeightKg).toBeCloseTo((horizontal.cuttingLengthMm! * 6) / 1000 * 0.617, 6);
  });

  it('WALL without a run and without a length is unresolved, not guessed', () => {
    const w = member({ mark: 'RCC WALL', type: 'wall', widthMm: 200, heightMm: 1800, count: 1 });
    const horizontal = scheduleRow(rowInput(bar({ memberMark: 'RCC WALL', diaMm: 10, manualCount: 6, distributionAxis: 'H' }), w, { settings: s })).row;
    expect(horizontal.cuttingLengthMm).toBeNull();
    expect(horizontal.missing).toMatch(/TOTAL RUN/);
    expect(horizontal.engineering).toBe('UNVALIDATED');
  });

  it('STAIR: a waist slab with a stated formula for the inclined length', () => {
    const flight = member({ mark: 'ST-1', type: 'stair flight', lengthMm: 3000, widthMm: 1200, heightMm: 1500, count: 2 });
    const waist = scheduleRow(rowInput(bar({ memberMark: 'ST-1', diaMm: 12, spacingMm: 150, distributionAxis: 'W', lengthFormula: 'SQRT(L^2 + H^2) - 2 * COVER + 2 * 8 * DIA' }), flight, { settings: s })).row;
    expect(waist.lengthSource).toBe('CUSTOM_FORMULA');
    expect(waist.cuttingLengthMm).toBeCloseTo(Math.sqrt(3000 ** 2 + 1500 ** 2) - 80 + 192, 6);
    expect(waist.barsPerMember).toBe(Math.ceil((1200 - 80) / 150) + 1);
  });

  it('CUSTOM SHAPE: the drawn geometry, not a library formula', () => {
    const m = member({ mark: 'ANY', lengthMm: 2500, widthMm: 2300, heightMm: 350, count: 1 });
    const custom = scheduleRow(rowInput(bar({ memberMark: 'ANY', diaMm: 12, manualCount: 4, shapeCode: 'CUS', drawnGeometry: { vertices: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1300, y: 400 }, { x: 2300, y: 400 }], source: 'DETAIL 3' } }), m, { settings: s })).row;
    expect(custom.lengthSource).toBe('DRAWN_GEOMETRY');
    expect(custom.cuttingLengthMm).toBe(2500);
    expect(custom.totalBars).toBe(4);
  });
});
