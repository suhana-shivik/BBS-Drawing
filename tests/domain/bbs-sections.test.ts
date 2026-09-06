import { describe, expect, it } from 'vitest';
import {
  buildSections,
  concreteVolumeM3,
  dimViolations,
  elementKind,
  enforceDimBands,
  sectionsSummary,
} from '../../src/cad/bbs/sections';
import type { BbsMember, BbsResult, BbsRow } from '../../src/cad/bbs/types';

/**
 * The Re-Verification Protocol's foundation (BBS_PLAN.md Part II).
 *
 * Three wrong totals in one day shared one absence: nobody owned "is this
 * section's steel roughly what this drawing implies?" The referee here is the
 * industry's own cross-check — kg of steel per m³ of concrete by element
 * kind — deterministic, quantum-derived, uncorrelated with the engine's row
 * arithmetic. Each test pins one clause of that ownership.
 */

const member = (over: Partial<BbsMember>): BbsMember => ({
  mark: 'F1',
  type: 'footing',
  count: 7,
  source: { table: '', row: -1 },
  incomplete: false,
  missing: [],
  ...over,
});

const row = (over: Partial<BbsRow>): BbsRow => ({
  barMark: 'F1-M1',
  description: 'Bar T12',
  memberMark: 'F1',
  barType: 'BOTTOM',
  diaMm: 12,
  shapeCode: '21',
  cuttingLengthMm: 2000,
  lengthSource: 'SHAPE_FORMULA',
  barsPerMember: 10,
  memberCount: 7,
  totalBars: 70,
  totalLengthM: 140,
  unitWeightKgPerM: 0.888,
  weightKg: 124,
  weightWithWastageKg: 124,
  warnings: [],
  handles: [],
  fromCallout: '12TOR@100C/C',
  ...over,
});

const result = (members: BbsMember[], rows: BbsRow[]): BbsResult => ({
  settings: {
    concreteGrade: 'M25',
    steelGrade: 'Fe500',
    coverMm: 50,
    bendMode: 'CONVENTIONAL',
    wastagePct: 0,
  },
  members,
  rows,
  summary: [],
  incomplete: [],
  interpretation: { members, bars: [], unresolved: [] },
});

describe('element kinds', () => {
  it('classifies the GAMCO cast', () => {
    expect(elementKind(member({ mark: 'F1', type: 'footing' }))).toBe('footing');
    expect(elementKind(member({ mark: 'C1', type: 'column' }))).toBe('column');
    expect(elementKind(member({ mark: 'SC', type: 'stub column' }))).toBe('column');
    expect(elementKind(member({ mark: 'TB', type: 'tie beam' }))).toBe('beam');
    expect(elementKind(member({ mark: 'RCC WALL', type: 'rcc wall' }))).toBe('wall');
    expect(elementKind(member({ mark: 'H-POLE', type: 'pole' }))).toBe('pole');
  });
});

describe('dimension bands by kind', () => {
  it('refuses the 150 mm footing width that the global gate waved through', () => {
    // 150 mm is a fine slab thickness and an impossible footing side —
    // plausibility belongs to the KIND, not to numbers in general
    const bad = dimViolations(member({ lengthMm: 1800, widthMm: 150, heightMm: 400 }));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ axis: 'W', value: 150 });
  });

  it('accepts the same 150 mm on a pole, where it is normal', () => {
    expect(
      dimViolations(member({ mark: 'H-POLE', type: 'pole', lengthMm: 150, widthMm: 150, heightMm: 2400 })),
    ).toHaveLength(0);
  });

  it('does not band a linear member’s length — that is a run, not a section', () => {
    const tb = member({ mark: 'TB', type: 'tie beam', lengthMm: 100_000, widthMm: 350, heightMm: 400 });
    expect(dimViolations(tb)).toHaveLength(0);
  });

  it('strips a violating dim into an honest MISSING axis', () => {
    const { members, violations } = enforceDimBands({
      members: [member({ lengthMm: 1800, widthMm: 150, heightMm: 400 })],
    });
    expect(violations).toHaveLength(1);
    expect(members[0].widthMm).toBeUndefined();
    expect(members[0].missing).toContain('W');
    expect(members[0].incomplete).toBe(true);
  });
});

describe('the referee — kg per m³ of concrete', () => {
  it('computes a counted member’s volume from its box × count', () => {
    // 1.8 × 1.5 × 0.4 m × 7 nos = 7.56 m³
    const v = concreteVolumeM3(
      member({ lengthMm: 1800, widthMm: 1500, heightMm: 400, count: 7 }),
      'footing',
      null,
    );
    expect(v).toBeCloseTo(7.56, 2);
  });

  it('computes a wall from thickness × height × run', () => {
    const wall = member({ mark: 'RCC WALL', type: 'rcc wall', widthMm: 200, heightMm: 1200, count: 1 });
    expect(concreteVolumeM3(wall, 'wall', 100_000)).toBeCloseTo(24, 1);
  });

  it('returns null — not a guess — when the quantum is incomplete', () => {
    const wall = member({ mark: 'RCC WALL', type: 'rcc wall', widthMm: 200 });
    expect(concreteVolumeM3(wall, 'wall', 100_000)).toBeNull(); // height unknown
    expect(concreteVolumeM3(wall, 'wall', null)).toBeNull(); // run unanswered
  });
});

describe('section verdicts', () => {
  const F1 = member({ lengthMm: 1800, widthMm: 1500, heightMm: 400, count: 7 });

  it('calls the 0.668 MT class of failure SHORT, with the arithmetic shown', () => {
    // 7.56 m³ of footing wants 378–756 kg; the engine produced 124
    const [s] = buildSections(result([F1], [row({})]));
    expect(s.verdict).toBe('short');
    expect(s.expectedKg?.min).toBeCloseTo(378, 0);
    expect(s.causes.join(' ')).toMatch(/steel is missing, not cheap/);
  });

  it('verifies a section whose engine lands inside the band', () => {
    const [s] = buildSections(result([F1], [row({ weightWithWastageKg: 500 })]));
    expect(s.verdict).toBe('verified');
    expect(s.causes).toEqual([]);
  });

  it('flags OVER as possible double counting', () => {
    const [s] = buildSections(result([F1], [row({ weightWithWastageKg: 2000 })]));
    expect(s.verdict).toBe('over');
    expect(s.causes.join(' ')).toMatch(/double counting/);
  });

  it('reports a wall with no rows as NOT-SCHEDULED — the vanishing wall gets a name', () => {
    const wall = member({ mark: 'RCC WALL', type: 'rcc wall', widthMm: 200, heightMm: 1200 });
    const [, s] = buildSections(result([F1, wall], [row({})]), { totalRunM: 100 });
    expect(s.verdict).toBe('not-scheduled');
    expect(s.causes[0]).toMatch(/has no rows/);
  });

  it('says UNVERIFIABLE when the quantum is incomplete, naming the reason', () => {
    const wall = member({ mark: 'RCC WALL', type: 'rcc wall', widthMm: 200 });
    const [, s] = buildSections(
      result([F1, wall], [row({}), row({ barMark: 'W-1', memberMark: 'RCC WALL', weightWithWastageKg: 50 })]),
    );
    expect(s.verdict).toBe('unverifiable');
    expect(s.causes.join(' ')).toMatch(/quantum incomplete/);
  });
});

describe('the verdict the total must carry', () => {
  it('names every unverified section', () => {
    const F1 = member({ lengthMm: 1800, widthMm: 1500, heightMm: 400, count: 7 });
    const wall = member({ mark: 'RCC WALL', type: 'rcc wall', widthMm: 200, heightMm: 1200 });
    const sections = buildSections(result([F1, wall], [row({})]), { totalRunM: 100 });
    expect(sectionsSummary(sections)).toMatch(/2 of 2 sections unverified/);
    expect(sectionsSummary(sections)).toMatch(/RCC WALL not scheduled/);
  });

  it('is silent when everything verifies', () => {
    const F1 = member({ lengthMm: 1800, widthMm: 1500, heightMm: 400, count: 7 });
    const sections = buildSections(result([F1], [row({ weightWithWastageKg: 500 })]));
    expect(sectionsSummary(sections)).toBeNull();
  });
});
