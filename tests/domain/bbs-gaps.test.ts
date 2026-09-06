import { describe, expect, it } from 'vitest';
import { blockedRowCount, findGaps, type Gap } from '../../src/cad/bbs/gaps';
import type { BbsBar, BbsMember, BbsResult, BbsRow, BbsSettings } from '../../src/cad/bbs/types';

/**
 * Written against the real Pedestal.dxf failure.
 *
 * Our schedule came out at 4.42 MT against the issued 30.72 MT. Fifteen rows
 * read "member cross-section (width × length) not on this sheet" while the
 * drawing plainly says "1115x1275" beside the mark — because the second plan
 * dimension had been filed as the pedestal's HEIGHT. Nothing was missing; one
 * number was in the wrong slot, and no part of the system could say so.
 */

const SETTINGS: BbsSettings = {
  concreteGrade: 'M25',
  steelGrade: 'Fe500',
  coverMm: 50,
  bendMode: 'CONVENTIONAL',
  wastagePct: 0,
};

function member(over: Partial<BbsMember>): BbsMember {
  return {
    mark: 'P2',
    type: 'pedestal',
    count: 2,
    source: { table: '', row: 0 },
    incomplete: false,
    missing: [],
    ...over,
  };
}

function bar(over: Partial<BbsBar>): BbsBar {
  return {
    barMark: 'P2-M1',
    memberMark: 'P2',
    barType: 'MAIN',
    diaMm: 20,
    shapeCode: '00',
    fromCallout: '12- 20+16- 16',
    handles: [],
    ...over,
  };
}

function row(over: Partial<BbsRow>): BbsRow {
  return {
    barMark: 'P2-M1',
    description: 'Vertical T20',
    memberMark: 'P2',
    barType: 'MAIN',
    diaMm: 20,
    shapeCode: '00',
    cuttingLengthMm: null,
    lengthSource: 'UNAVAILABLE',
    barsPerMember: 12,
    memberCount: 2,
    totalBars: 24,
    totalLengthM: null,
    unitWeightKgPerM: null,
    weightKg: null,
    weightWithWastageKg: null,
    warnings: [],
    handles: [],
    fromCallout: '12- 20+16- 16',
    ...over,
  };
}

function result(over: Partial<BbsResult> & { members: BbsMember[] }): BbsResult {
  return {
    settings: SETTINGS,
    rows: [],
    summary: [],
    incomplete: [],
    interpretation: { members: over.members, bars: [], unresolved: [] },
    ...over,
  };
}

/** The exact P2 state: plan width and plan length read, one filed as height. */
function mislabelledPedestal(): BbsResult {
  const members = [member({ mark: 'P2', widthMm: 1115, heightMm: 1275, count: 2 })];
  const bars = [
    bar({ barMark: 'P2-M1', barType: 'MAIN', diaMm: 20, distributionAxis: 'H' }),
    bar({ barMark: 'P2-T1', barType: 'TIE', diaMm: 10, shapeCode: '51', spacingMm: 100 }),
    bar({ barMark: 'P2-T2', barType: 'TIE', diaMm: 8, shapeCode: '51', spacingMm: 100 }),
  ];
  return result({
    members,
    rows: [
      row({ barMark: 'P2-M1', lengthSource: 'SHAPE_FORMULA', cuttingLengthMm: 1175 }),
      row({ barMark: 'P2-T1', barType: 'TIE' }),
      row({ barMark: 'P2-T2', barType: 'TIE' }),
    ],
    interpretation: { members, bars, unresolved: [] },
  });
}

const byId = (gaps: Gap[], id: string): Gap | undefined => gaps.find((g) => g.id === id);

describe('finding what the drawing did not say', () => {
  it('asks which of the two numbers is the plan length', () => {
    const gaps = findGaps(mislabelledPedestal(), SETTINGS, true);
    const gap = byId(gaps, 'P2:plan');

    expect(gap).toBeDefined();
    expect(gap?.kind).toBe('ambiguous-dimension');
    expect(gap?.field).toBe('lengthMm');
    // both numbers are quoted back, so the answer can be checked against the sheet
    expect(gap?.because).toContain('1115');
    expect(gap?.because).toContain('1275');
  });

  it('asks for the real height, and says why a plan cannot carry it', () => {
    const gap = byId(findGaps(mislabelledPedestal(), SETTINGS, true), 'P2:height');
    expect(gap).toBeDefined();
    expect(gap?.because).toMatch(/level/i);
    expect(gap?.unit).toBe('mm');
  });

  it('names the rows each question is holding up', () => {
    // "answer this and eleven rows complete" is the only thing that makes a
    // question worth a person's time.
    const gaps = findGaps(mislabelledPedestal(), SETTINGS, true);
    expect(byId(gaps, 'P2:plan')?.blocks).toEqual(['P2-T1', 'P2-T2']);
    expect(byId(gaps, 'P2:height')?.blocks).toEqual(['P2-M1']);
  });

  it('never answers itself — a suggestion carries its basis and stays a suggestion', () => {
    const gap = byId(findGaps(mislabelledPedestal(), SETTINGS, true), 'P2:plan');
    expect(gap?.suggestion?.value).toBe(1275);
    expect(gap?.suggestion?.basis).toMatch(/read off the plan/);
    // the height question gets no suggestion at all, because nothing on a plan
    // is evidence for it
    expect(byId(findGaps(mislabelledPedestal(), SETTINGS, true), 'P2:height')?.suggestion)
      .toBeUndefined();
  });

  it('shows what is already known, so a typed answer can be sanity-checked', () => {
    const gap = byId(findGaps(mislabelledPedestal(), SETTINGS, true), 'P2:plan');
    expect(gap?.known).toEqual([
      { label: 'W', value: 1115 },
      { label: 'H', value: 1275 },
    ]);
  });

  it('puts the most blocking question first', () => {
    const gaps = findGaps(mislabelledPedestal(), SETTINGS, true);
    expect(gaps[0].id).toBe('P2:plan');
  });
});

describe('questions that belong to the job, not to one member', () => {
  it('asks for cover only when the sheet never stated one', () => {
    expect(byId(findGaps(mislabelledPedestal(), SETTINGS, false), 'project:cover')).toBeDefined();
    expect(byId(findGaps(mislabelledPedestal(), SETTINGS, true), 'project:cover')).toBeUndefined();
  });

  it('asks for the bottom L and the lap once a vertical member exists', () => {
    const gaps = findGaps(mislabelledPedestal(), SETTINGS, true);
    expect(byId(gaps, 'project:anchorage')).toBeDefined();
    expect(byId(gaps, 'project:lap')).toBeDefined();
  });

  it('states plainly that the bottom L is not the development length', () => {
    // Conflating the two is the standard mistake, and it lengthens every
    // starter bar on the job.
    const gap = byId(findGaps(mislabelledPedestal(), SETTINGS, true), 'project:anchorage');
    expect(gap?.because).toMatch(/NOT the development length/);
  });

  it('marks a question the engine cannot yet act on rather than pretending it can', () => {
    const gaps = findGaps(mislabelledPedestal(), SETTINGS, true);
    expect(byId(gaps, 'project:anchorage')?.advisory).toBe(true);
    expect(byId(gaps, 'P2:height')?.advisory).toBeUndefined();
  });

  it('sinks advisory questions below ones that unblock a row', () => {
    const gaps = findGaps(mislabelledPedestal(), SETTINGS, false);
    const firstAdvisory = gaps.findIndex((g) => g.advisory);
    const lastActionable = gaps.map((g) => !g.advisory).lastIndexOf(true);
    expect(firstAdvisory).toBeGreaterThan(lastActionable);
  });

  it('asks nothing about starter bars on a job with no vertical members', () => {
    const members = [member({ mark: 'F1', type: 'footing', lengthMm: 2000, widthMm: 2000, count: 9 })];
    const gaps = findGaps(result({ members }), SETTINGS, true);
    expect(byId(gaps, 'project:anchorage')).toBeUndefined();
    expect(byId(gaps, 'project:lap')).toBeUndefined();
  });
});

describe('counts', () => {
  it('asks when a count of one was assumed rather than read', () => {
    // The quietest error in a schedule: the arithmetic is right and the steel
    // order is short by a factor of twenty.
    const members = [member({ mark: 'P9', widthMm: 600, lengthMm: 600, heightMm: 2000, count: 1 })];
    const gap = byId(findGaps(result({ members }), SETTINGS, true), 'P9:count');
    expect(gap).toBeDefined();
    expect(gap?.because).toMatch(/one was assumed/);
  });

  it('stays quiet when tags were counted, even if no schedule stated the number', () => {
    // Counted tags are a fact — the same way a QS gets the figure. Asking
    // "how many?" about five members whose tags sit on the layout was
    // reported, rightly, as the panel looking like it cannot count. Whether
    // the layout is the whole job is the INTERVIEW's question, asked once.
    const members = [member({ mark: 'P1', widthMm: 730, lengthMm: 1275, heightMm: 2275, count: 19 })];
    const gaps = findGaps(
      result({
        members,
        interpretation: {
          members,
          bars: [],
          unresolved: ['Member P1: the number of members was not identified on this sheet — 1 assumed.'],
        },
      }),
      SETTINGS,
      true,
    );
    expect(byId(gaps, 'P1:count')).toBeUndefined();
  });

  it('stays quiet about a count the schedule table gave', () => {
    const members = [member({ mark: 'P3', widthMm: 730, lengthMm: 1275, heightMm: 2374, count: 20 })];
    expect(byId(findGaps(result({ members }), SETTINGS, true), 'P3:count')).toBeUndefined();
  });
});

describe('counting the damage', () => {
  it('reports how many rows are waiting on an answer', () => {
    const gaps = findGaps(mislabelledPedestal(), SETTINGS, true);
    expect(blockedRowCount(gaps)).toBe(3);
  });

  it('counts a row once even when two questions hold it up', () => {
    const members = [member({ mark: 'P9', type: 'pedestal', count: 1 })];
    const bars = [bar({ barMark: 'P9-T1', memberMark: 'P9', barType: 'TIE', shapeCode: '51' })];
    const gaps = findGaps(
      result({ members, interpretation: { members, bars, unresolved: [] } }),
      SETTINGS,
      true,
    );
    expect(blockedRowCount(gaps)).toBe(1);
  });
});

describe('the safety net defers to the interview and the drawing', () => {
  // Asking three members for a height the user just described stretch by
  // stretch reads as the panel not listening to its own interview.
  const heightGapFor = (gaps: Gap[], mark: string) =>
    gaps.find((g) => g.subject === mark && g.field === 'heightMm');

  const answeredZones = [
    {
      question: {
        id: 'zones',
        text: 'How does the run split?',
        why: '',
        kind: 'per_stretch' as const,
        writes: { scope: 'takeoff' as const, field: 'zones' },
      },
      answer: { questionId: 'zones', value: [{ 'stretch (m)': 40 }] },
      at: 1,
    },
  ];

  it('drops height questions once the user has answered a stretch table', () => {
    const gaps = findGaps(mislabelledPedestal(), SETTINGS, true, [], answeredZones);
    expect(heightGapFor(gaps, 'P2')).toBeUndefined();
  });

  it('keeps height questions when nothing about levels was ever answered', () => {
    const gaps = findGaps(mislabelledPedestal(), SETTINGS, true, [], []);
    expect(heightGapFor(gaps, 'P2')).toBeDefined();
  });
});

describe('a refused row always has a question that unblocks it', () => {
  // F1's footing mats were dead — no size, no rows — and NOTHING on screen
  // asked for the size, because plan-dimension questions fired only for
  // links. A refusal with no request is a dead end.
  const footing = (): BbsResult => {
    const members = [member({ mark: 'F1', type: 'footing', count: 7 })];
    const bars = [
      bar({
        barMark: 'F1-M1',
        memberMark: 'F1',
        barType: 'BOTTOM',
        diaMm: 12,
        shapeCode: '21',
        spacingMm: 100,
        distributionAxis: 'W',
      }),
    ];
    return result({
      members,
      rows: [row({ barMark: 'F1-M1', memberMark: 'F1', barType: 'BOTTOM' })],
      interpretation: { members, bars, unresolved: [] },
    });
  };

  it('asks for both plan dimensions when a MAT bar needs them, not only links', () => {
    const gaps = findGaps(footing(), SETTINGS, true);
    expect(byId(gaps, 'F1:L')).toBeDefined();
    expect(byId(gaps, 'F1:W')).toBeDefined();
    expect(byId(gaps, 'F1:L')?.blocks).toContain('F1-M1');
  });

  it('asks for the depth a bent mat bar stands its legs in', () => {
    const gaps = findGaps(footing(), SETTINGS, true);
    expect(byId(gaps, 'F1:D')).toBeDefined();
    expect(byId(gaps, 'F1:D')?.field).toBe('heightMm');
  });
});

describe('the run question exists even when the model forgot to ask it', () => {
  // Rows died naming "the run question" while no such question existed
  // anywhere on screen — the run lived only in the model's vocabulary.
  const tieBeam = (): BbsResult => {
    const members = [member({ mark: 'TB', type: 'tie beam', lengthMm: 400, widthMm: 350, heightMm: 400, count: 2 })];
    return result({
      members,
      rows: [
        row({ barMark: 'TB-M1', memberMark: 'TB', cuttingLengthMm: null, lengthSource: 'UNAVAILABLE' }),
        row({ barMark: 'TB-T1', memberMark: 'TB', barType: 'STIRRUP', barsPerMember: 0 }),
      ],
      interpretation: { members, bars: [], unresolved: [] },
    });
  };

  it('asks for the total run when linear rows are starving and no run is answered', () => {
    const gaps = findGaps(tieBeam(), SETTINGS, true, [], [], {});
    const runGap = byId(gaps, 'project:run');
    expect(runGap).toBeDefined();
    expect(runGap?.unit).toBe('m');
    expect(runGap?.blocks).toEqual(['TB-M1', 'TB-T1']);
  });

  it('stays quiet once the run is answered', () => {
    const gaps = findGaps(tieBeam(), SETTINGS, true, [], [], { totalRunM: 100 });
    expect(byId(gaps, 'project:run')).toBeUndefined();
  });

  it('never asks on a job with no linear members', () => {
    const gaps = findGaps(mislabelledPedestal(), SETTINGS, true, [], [], {});
    expect(byId(gaps, 'project:run')).toBeUndefined();
  });
});
