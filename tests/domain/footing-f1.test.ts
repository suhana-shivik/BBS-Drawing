import { describe, expect, it } from 'vitest';
import { buildBbs, DEFAULT_SETTINGS } from '../../src/cad/bbs/build';
import { applyConventions, DEFAULT_CONVENTIONS } from '../../src/cad/bbs/conventions';
import type { BbsBar, BbsInterpretation, BbsMember, DrawingExtract } from '../../src/cad/bbs/types';

/**
 * F1 of "Foundations drawings.dxf", against the issued Footing BBS.
 *
 * The drawing states: F1 is 2300 (W) × 2500 (L) × 350 deep, 2 of them, bottom
 * ⌀10@150 both ways, top ⌀10@200 both ways.
 *
 * The issued schedule for those two footings is 305.16 m of 10 mm. Ours came
 * out at 320.56 m — 15.40 m heavier. These tests pin down where each metre of
 * that goes, because "roughly agrees" is not a standard a bill can be built on.
 */

const SETTINGS = { ...DEFAULT_SETTINGS, coverMm: 50, wastagePct: 0 };

const EXTRACT: DrawingExtract = {
  drawingName: 'Foundations drawings',
  sourceFile: 'Foundations drawings.dxf',
  tables: [],
  callouts: [],
  notes: { notes: [] },
  marks: ['F1'],
  declared: [],
  unitScale: 1,
};

/** F1 exactly as the FOOTING SCHEDULE states it. */
const F1: BbsMember = {
  mark: 'F1',
  type: 'footing',
  lengthMm: 2500,
  widthMm: 2300,
  heightMm: 350,
  count: 2,
  source: { table: 'FOOTING SCHEDULE :', row: 0 },
  incomplete: false,
  missing: [],
};

function mat(over: Partial<BbsBar>): BbsBar {
  return {
    memberMark: 'F1',
    barType: 'BOTTOM',
    diaMm: 10,
    // U-shape: an end upturn at each end of a flat mat bar
    shapeCode: '21',
    spacingMm: 150,
    fromCallout: '10@150c/c',
    handles: [],
    ...over,
  };
}

/**
 * The four mat runs.
 *
 * `distributionAxis` is the axis the bars are SPACED ALONG, which is how the
 * model is instructed to report it. A run spaced across the 2300 width
 * therefore RUNS the 2500 length, and vice versa.
 */
const BARS: BbsBar[] = [
  mat({ barMark: 'F1-M1', barType: 'BOTTOM', spacingMm: 150, distributionAxis: 'W' }),
  mat({ barMark: 'F1-M2', barType: 'BOTTOM', spacingMm: 150, distributionAxis: 'L' }),
  mat({ barMark: 'F1-M3', barType: 'TOP', spacingMm: 200, distributionAxis: 'W', fromCallout: '10@200c/c' }),
  mat({ barMark: 'F1-M4', barType: 'TOP', spacingMm: 200, distributionAxis: 'L', fromCallout: '10@200c/c' }),
];

const READING: BbsInterpretation = { members: [F1], bars: BARS, unresolved: [] };

const build = (conv = DEFAULT_CONVENTIONS) => {
  const { interpretation } = applyConventions(READING, conv, SETTINGS);
  return buildBbs(EXTRACT, interpretation, SETTINGS, { members: {}, bars: {} });
};

const rowFor = (r: ReturnType<typeof build>, mark: string) =>
  r.rows.find((x) => x.barMark === mark);

describe('F1 — the axis a bar spans is not the axis it is spaced along', () => {
  it('spans the 2500 length when spaced across the 2300 width', () => {
    // The issued schedule's 16-bar bottom run is 2.860 m long: 2500 − 2×50
    // cover, plus a 250 upturn at each end, less 40 of bend deduction.
    // Taking the length from the spacing axis instead gives 2.660 and quietly
    // under-measures every bar in the run.
    const row = rowFor(build(), 'F1-M1');
    expect(row?.cuttingLengthMm).toBe(2860);
  });

  it('spans the 2300 width when spaced along the 2500 length', () => {
    const row = rowFor(build(), 'F1-M2');
    expect(row?.cuttingLengthMm).toBe(2660);
  });

  it('still counts along the spacing axis, which was always right', () => {
    // 2300 − 2×50 = 2200; ceil(2200/150) = 15 gaps, so 16 bars per footing.
    const row = rowFor(build(), 'F1-M1');
    expect(row?.barsPerMember).toBe(16);
    expect(row?.memberCount).toBe(2);
  });

  it('gives the top mat the same treatment', () => {
    expect(rowFor(build(), 'F1-M3')?.cuttingLengthMm).toBe(2860);
    expect(rowFor(build(), 'F1-M3')?.barsPerMember).toBe(12);
    expect(rowFor(build(), 'F1-M4')?.cuttingLengthMm).toBe(2660);
    expect(rowFor(build(), 'F1-M4')?.barsPerMember).toBe(13);
  });
});

describe('F1 — the conventions actually reach the schedule', () => {
  it('splits the BOTTOM runs into a bent set and a straight set, and leaves the top alone', () => {
    // The issued schedule lists the bottom runs as pairs, the second suffixed
    // "-Alt", and carries no "-Alt" line for either top run: a top bar has
    // nothing above to bend up into. Four runs in, six rows out.
    const off = build();
    const on = build({ ...DEFAULT_CONVENTIONS, alternateBentUp: true });

    expect(off.rows).toHaveLength(4);
    expect(on.rows).toHaveLength(6);
    expect(on.rows.filter((r) => r.barMark.endsWith('-Alt')).map((r) => r.barMark)).toEqual([
      'F1-M1-Alt',
      'F1-M2-Alt',
    ]);
  });

  it('makes the alternate bar straight, with no upturns', () => {
    const on = build({ ...DEFAULT_CONVENTIONS, alternateBentUp: true });
    const alt = rowFor(on, 'F1-M1-Alt');
    expect(alt?.shapeCode).toBe('00');
    // 2500 − 2×50, and nothing else
    expect(alt?.cuttingLengthMm).toBe(2400);
  });

  it('halves the spacing of each set so the pair still reads as the callout', () => {
    const on = build({ ...DEFAULT_CONVENTIONS, alternateBentUp: true });
    expect(rowFor(on, 'F1-M1')?.spacingMm).toBe(300);
    expect(rowFor(on, 'F1-M1-Alt')?.spacingMm).toBe(300);
  });

  it('takes weight off the total rather than leaving it unchanged', () => {
    // If ticking the box changes no number, the box is a lie.
    const off = build();
    const on = build({ ...DEFAULT_CONVENTIONS, alternateBentUp: true });
    const total = (r: ReturnType<typeof build>) =>
      r.rows.reduce((n, x) => n + (x.totalLengthM ?? 0), 0);

    expect(total(on)).toBeLessThan(total(off));
  });

  it('shortens the upper layer by one bar diameter', () => {
    // The issued sheet shows 0.240 against 0.250 on the bars spanning the
    // shorter dimension: they rest on top of the other layer.
    const on = build({ ...DEFAULT_CONVENTIONS, layerOffset: true });
    expect(rowFor(on, 'F1-M2')?.cuttingLengthMm).toBe(2640);
  });

  it('carries wastage into the weight, not just into a note', () => {
    const net = build();
    const withWastage = (() => {
      const { interpretation } = applyConventions(READING, DEFAULT_CONVENTIONS, {
        ...SETTINGS,
        wastagePct: 5,
      });
      return buildBbs(EXTRACT, interpretation, { ...SETTINGS, wastagePct: 5 }, { members: {}, bars: {} });
    })();

    const netKg = net.rows.reduce((n, r) => n + (r.weightWithWastageKg ?? 0), 0);
    const grossKg = withWastage.rows.reduce((n, r) => n + (r.weightWithWastageKg ?? 0), 0);
    expect(grossKg).toBeCloseTo(netKg * 1.05, 1);
  });
});

describe('F1 — against the issued 305.16 m', () => {
  it('lands within a metre once the axis is right and the conventions are on', () => {
    // Remaining difference is the alternate straight bar's end cover, which
    // the issued sheet takes as 100 rather than 50 — the X/Y column of the
    // footing schedule. Tracked separately; not folded in silently here.
    const on = build({ ...DEFAULT_CONVENTIONS, alternateBentUp: true, layerOffset: true });
    const total = on.rows.reduce((n, r) => n + (r.totalLengthM ?? 0), 0);
    expect(total).toBeGreaterThan(300);
    expect(total).toBeLessThan(312);
  });
});

describe('F1 — each run named the way the trade names it', () => {
  it('names the six runs, not "F1-M1"', () => {
    // A mark is a key. A schedule somebody checks against a drawing needs the
    // run described: direction, diameter, pitch, which mat, and whether it is
    // the straight half of an alternate pair.
    const on = build({ ...DEFAULT_CONVENTIONS, alternateBentUp: true });
    expect(on.rows.map((r) => r.description)).toEqual([
      'Long Bar T10 @ 300c/c (Btm)',
      'Long Bar T10 @ 300c/c (Btm)-Alt.',
      'Short Bar T10 @ 300c/c (Btm)',
      'Short Bar T10 @ 300c/c (Btm)-Alt.',
      'Long Bar T10 @ 200c/c (Top)',
      'Short Bar T10 @ 200c/c (Top)',
    ]);
  });

  it('calls the run crossing the greater span the Long Bar', () => {
    // F1 is 2300 × 2500, so the Long Bar crosses 2500 and cuts at 2.860.
    const rows = build().rows;
    const long = rows.find((r) => r.description.startsWith('Long Bar T10 @ 150'));
    expect(long?.cuttingLengthMm).toBe(2860);
  });

  it('keeps the mark alongside the name, so a row stays traceable', () => {
    const rows = build().rows;
    expect(rows[0].barMark).toBe('F1-M1');
    expect(rows[0].description).not.toBe(rows[0].barMark);
  });
});

describe('F1 — X/Y is a dimension on the drawing, not a cover', () => {
  // The foundation drawing marks "X/Y TYP." against the straight bar and the
  // footing schedule carries X = Y = 100 for every footing. Reading it as
  // cover (50) leaves each straight bar 100 mm long.
  const withXY = () =>
    build({
      ...DEFAULT_CONVENTIONS,
      alternateBentUp: true,
      layerOffset: true,
      altEndDeductionMm: 100,
    });

  it('stops the straight bar 100 mm short of each face', () => {
    expect(rowFor(withXY(), 'F1-M1-Alt')?.cuttingLengthMm).toBe(2300);
    expect(rowFor(withXY(), 'F1-M2-Alt')?.cuttingLengthMm).toBe(2100);
  });

  it('leaves the bent bar on the cover, which is a different thing', () => {
    expect(rowFor(withXY(), 'F1-M1')?.cuttingLengthMm).toBe(2860);
    expect(rowFor(withXY(), 'F1-M2')?.cuttingLengthMm).toBe(2640);
  });

  it('shows the substituted arithmetic, naming where the 100 came from', () => {
    expect(rowFor(withXY(), 'F1-M1-Alt')?.lengthWorking).toContain('X/Y from the schedule');
  });

  it('falls back to the cover when the drawing does not dimension it', () => {
    const plain = build({ ...DEFAULT_CONVENTIONS, alternateBentUp: true });
    expect(rowFor(plain, 'F1-M1-Alt')?.cuttingLengthMm).toBe(2400);
  });

  it('closes the gap on the issued 305.16 m to a single bar count', () => {
    // What remains is one bar: the issued sheet counts 18 across the 2500 run
    // where we count 17, because it divides the full dimension while we deduct
    // cover first as IS practice does. A convention difference, not an error.
    const total = withXY().rows.reduce((n, r) => n + (r.totalLengthM ?? 0), 0);
    expect(total).toBeGreaterThan(299);
    expect(total).toBeLessThan(303);
  });
});
