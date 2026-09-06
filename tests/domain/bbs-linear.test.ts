import { describe, expect, it } from 'vitest';
import {
  buildBbs,
  isLinearMember,
  runMmFromTakeoff,
  DEFAULT_SETTINGS,
} from '../../src/cad/bbs/build';
import type { BbsBar, BbsInterpretation, BbsMember, DrawingExtract } from '../../src/cad/bbs/types';

/**
 * The linear engine, first slice — written against the GAMCO failure it ends.
 *
 * The tie beam was scheduled as a counted object 0.4 m long: its CROSS-SECTION
 * swallowed as its LENGTH, printing 0.25 m T16 longitudinals as computed rows,
 * and a 100 m boundary wall totalled 0.731 MT with every figure locally
 * defensible. A linear member's steel runs the STRUCTURE: longitudinals are
 * the run plus a lap at every stock length, stirrups march the run.
 */

const SETTINGS = { ...DEFAULT_SETTINGS, coverMm: 30, ldMultiple: 50, wastagePct: 0 };

const EXTRACT: DrawingExtract = {
  drawingName: 'g',
  sourceFile: 'g.dxf',
  tables: [],
  callouts: [],
  notes: { notes: [] },
  marks: ['TB'],
  declared: [],
  unitScale: 1,
};

const TB: BbsMember = {
  mark: 'TB',
  type: 'tie beam',
  lengthMm: 400,
  widthMm: 350,
  heightMm: 400,
  count: 1,
  source: { table: '', row: -1 },
  incomplete: false,
  missing: [],
};

const bars: BbsBar[] = [
  {
    barMark: 'TB-M1',
    memberMark: 'TB',
    barType: 'MAIN',
    diaMm: 16,
    shapeCode: '00',
    manualCount: 2,
    fromCallout: '2-16TOR+2-12TOR',
    handles: [],
  },
  {
    barMark: 'TB-S1',
    memberMark: 'TB',
    barType: 'STIRRUP',
    diaMm: 8,
    shapeCode: '51',
    spacingMm: 150,
    fromCallout: '4L-8TOR@150C/C',
    handles: [],
  },
];

const READING: BbsInterpretation = { members: [TB], bars, unresolved: [] };

const build = (takeoff?: Record<string, unknown>) =>
  buildBbs(EXTRACT, READING, SETTINGS, { members: {}, bars: {} }, takeoff);

describe('recognising a linear member', () => {
  it('knows a tie beam and a wall run; a pedestal does not', () => {
    expect(isLinearMember(TB)).toBe(true);
    expect(isLinearMember({ ...TB, mark: 'W1', type: 'rcc wall' })).toBe(true);
    expect(isLinearMember({ ...TB, mark: 'P2', type: 'pedestal' })).toBe(false);
  });

  it('reads the answered run in metres or millimetres', () => {
    expect(runMmFromTakeoff({ totalRunM: 100 })).toBe(100_000);
    expect(runMmFromTakeoff({ 'wall run': 96_500 })).toBe(96_500);
    expect(runMmFromTakeoff({ scopeType: 'whole job' })).toBeNull();
    expect(runMmFromTakeoff(undefined)).toBeNull();
  });
});

describe('with the run answered: 100 m of tie beam', () => {
  it('cuts a longitudinal as the run plus a lap at every stock length', () => {
    // 100 m in 12 m stock → 8 laps of 50φ = 8 × 800 = 6.4 m; 106.4 m per bar
    const row = build({ totalRunM: 100 }).rows.find((r) => r.barMark === 'TB-M1');
    expect(row?.cuttingLengthMm).toBe(106_400);
    expect(row?.lengthWorking).toMatch(/8 laps/);
    expect(row?.lengthWorking).toMatch(/50φ/);
  });

  it('marches the stirrups down the run, not the member height', () => {
    // floor(100000/150) + 1 = 667 — the 0.4 m "member" gave 3
    const row = build({ totalRunM: 100 }).rows.find((r) => r.barMark === 'TB-S1');
    expect(row?.barsPerMember).toBe(667);
    // the stirrup itself still wraps the REAL cross-section
    expect(row?.cuttingLengthMm).not.toBeNull();
  });

  it('produces a tonnage in the right order of magnitude', () => {
    // 2 × 106.4 m of T16 ≈ 336 kg; 667 stirrups ≈ 1.36 m × 0.395 ≈ 358 kg
    const result = build({ totalRunM: 100 });
    const totalKg = result.summary.reduce((a, s) => a + s.totalWeightWithWastageKg, 0);
    expect(totalKg).toBeGreaterThan(500);
    expect(totalKg).toBeLessThan(1200);
  });
});

describe('without the run: refusal, never the cross-section', () => {
  it('refuses the longitudinal and names the answer that unblocks it', () => {
    const row = build().rows.find((r) => r.barMark === 'TB-M1');
    expect(row?.cuttingLengthMm).toBeNull();
    expect(build().incomplete.map((i) => i.reason).join(' ')).toMatch(/TOTAL RUN/i);
  });

  it('refuses the stirrup count the same way — as a HOLE, not as a zero', () => {
    // CHANGED DELIBERATELY. This used to assert 0, which is what the engine
    // wrote for a count it could not derive — and a 0 is the same silent
    // failure as the 1 this whole file exists to prevent. It weighs nothing,
    // it reconciles against every arithmetic check (0 × anything is 0), and on
    // the live GAMCO run every link row read "No. per member 0 · total 0 ·
    // 0.000 kg" while the schedule called itself complete. An underived count
    // is now null, and the row says which answer it waits on.
    const result = build();
    const row = result.rows.find((r) => r.barMark === 'TB-S1');
    expect(row?.barsPerMember).toBeNull();
    expect(row?.totalBars).toBeNull();
    expect(row?.missing).toMatch(/TOTAL RUN/i);
  });

  it('never prints the 0.25 m bar again', () => {
    // the exact GAMCO garbage: section-minus-cover masquerading as a length
    const row = build().rows.find((r) => r.barMark === 'TB-M1');
    expect(row?.cuttingLengthMm).not.toBe(250);
    expect(row?.cuttingLengthMm).not.toBe(340);
  });
});

describe('the output sanity gate', () => {
  it('flags a total that is impossibly light for the run', () => {
    // 100 m of boundary wall carrying under ~700 kg of steel is missing rows,
    // not cheap — 0.731 MT sat on screen without one figure looking wrong
    const result = build({ totalRunM: 100 });
    expect(result.sanity?.join(' ')).toMatch(/kg\/m|kg per metre/i);
    expect(result.sanity?.join(' ')).toMatch(/MISSING/);
  });

  it('says plainly when typical-stretch counts were never scaled', () => {
    const result = build({ totalRunM: 100, scopeType: 'typical stretch to be multiplied' });
    expect(result.sanity?.join(' ')).toMatch(/ONE TYPICAL STRETCH/);
  });

  it('stays silent when there is no run to judge against', () => {
    expect(build().sanity ?? []).toEqual([]);
  });
});

describe('the wall: transverse verticals vs horizontal run-bars', () => {
  // The near-miss: every non-link bar on a linear member took the run path,
  // so answering "100 m" would have cut each wall vertical at 106.4 m. A
  // vertical runs the HEIGHT and marches the run; a horizontal runs the run
  // and climbs the height.
  const WALL: BbsMember = {
    mark: 'RCC WALL',
    type: 'rcc wall',
    widthMm: 200,
    heightMm: 1200,
    count: 1,
    source: { table: '', row: -1 },
    incomplete: false,
    missing: [],
  };
  const wallBars: BbsBar[] = [
    {
      barMark: 'W-V1',
      memberMark: 'RCC WALL',
      barType: 'DISTRIBUTION',
      diaMm: 10,
      shapeCode: '00',
      spacingMm: 200,
      distributionAxis: 'L', // spaced along the run
      fromCallout: '10TOR@200C/C',
      handles: [],
    },
    {
      barMark: 'W-H1',
      memberMark: 'RCC WALL',
      barType: 'DISTRIBUTION',
      diaMm: 8,
      shapeCode: '00',
      spacingMm: 250,
      distributionAxis: 'H', // climbing the face
      fromCallout: '8@250C/C',
      handles: [],
    },
  ];
  const buildWall = (m: BbsMember, takeoff?: Record<string, unknown>) =>
    buildBbs(
      { ...EXTRACT, marks: ['RCC WALL'] },
      { members: [m], bars: wallBars, unresolved: [] },
      SETTINGS,
      { members: {}, bars: {} },
      takeoff,
    );

  it('cuts a vertical to the HEIGHT and counts it along the run', () => {
    const rows = buildWall(WALL, { totalRunM: 100 }).rows;
    const v = rows.find((r) => r.barMark === 'W-V1');
    expect(v?.cuttingLengthMm).toBe(1140); // 1200 − 2×30 cover — never 100 m
    expect(v?.barsPerMember).toBe(501); // floor(100000/200) + 1
  });

  it('cuts a horizontal to the RUN and counts it up the height', () => {
    const rows = buildWall(WALL, { totalRunM: 100 }).rows;
    const h = rows.find((r) => r.barMark === 'W-H1');
    expect(h?.cuttingLengthMm).toBe(103_200); // 100 m + 8 laps × 50×8
    expect(h?.barsPerMember).toBe(6); // ceil((1200−100)/250) + 1
  });

  it('refuses a vertical when the height is unanswered, naming the height', () => {
    const noHeight = buildWall({ ...WALL, heightMm: undefined }, { totalRunM: 100 });
    const v = noHeight.rows.find((r) => r.barMark === 'W-V1');
    expect(v?.cuttingLengthMm).toBeNull();
    expect(noHeight.incomplete.map((i) => i.reason).join(' ')).toMatch(/HEIGHT/);
  });
});
