import { describe, expect, it } from 'vitest';
import { buildBbs, groundDeclaredDims, DEFAULT_SETTINGS } from '../../src/cad/bbs/build';
import { findGaps } from '../../src/cad/bbs/gaps';
import type { BbsInterpretation, BbsMember, DrawingExtract } from '../../src/cad/bbs/types';

/**
 * "TYPICAL DETAIL OF C1-350x350" is the drawing stating C1's size. Before
 * these tests, a member the model failed to dimension left every link
 * UNAVAILABLE and the gap panel asked the user for a number printed on the
 * sheet — the exact "dumb question" this system must never ask.
 */

const C1_DECLARED = {
  name: 'C1',
  sizeText: '350x350',
  dimsMm: [350, 350],
  occurrences: 16,
  raw: 'TYPICAL DETAIL OF C1-350x350',
  handles: [],
};

const member = (over: Partial<BbsMember>): BbsMember => ({
  mark: 'C1',
  type: 'column',
  count: 15,
  source: { table: '', row: -1 },
  incomplete: true,
  missing: ['L', 'W'],
  ...over,
});

const reading = (m: BbsMember): BbsInterpretation => ({
  members: [m],
  bars: [
    {
      barMark: 'C1-T1',
      memberMark: 'C1',
      barType: 'TIE',
      diaMm: 8,
      shapeCode: '51',
      spacingMm: 200,
      distributionAxis: 'H',
      fromCallout: '8TOR@200C/C(LINK)',
      handles: [],
    },
  ],
  unresolved: [],
});

const extract = (declared = [C1_DECLARED]): DrawingExtract => ({
  drawingName: 'g',
  sourceFile: 'g.dxf',
  tables: [],
  callouts: [],
  notes: { notes: [] },
  marks: ['C1'],
  declared,
  unitScale: 1,
});

describe('declared sizes feed the schedule', () => {
  it('fills the axes the model left blank, and clears them from missing', () => {
    const out = groundDeclaredDims(reading(member({})), [C1_DECLARED]);
    expect(out.members[0]).toMatchObject({
      lengthMm: 350,
      widthMm: 350,
      incomplete: false,
      missing: [],
    });
  });

  it('never overwrites a dimension somebody already grounded', () => {
    const out = groundDeclaredDims(
      reading(member({ lengthMm: 525, missing: ['W'] })),
      [{ ...C1_DECLARED, dimsMm: [350, 350] }],
    );
    expect(out.members[0].lengthMm).toBe(525);
    expect(out.members[0].widthMm).toBe(350);
  });

  it('takes a third declared dimension as the height', () => {
    const out = groundDeclaredDims(
      reading(member({ mark: 'H-POLE', missing: ['L', 'W', 'H'] })),
      [{ ...C1_DECLARED, name: 'H-POLE', dimsMm: [150, 150, 2400] }],
    );
    expect(out.members[0]).toMatchObject({ lengthMm: 150, widthMm: 150, heightMm: 2400 });
  });

  it('computes the link that was UNAVAILABLE before', () => {
    // the whole point: the row completes without anyone being asked anything
    const grounded = groundDeclaredDims(reading(member({})), [C1_DECLARED]);
    const result = buildBbs(extract(), grounded, DEFAULT_SETTINGS, { members: {}, bars: {} });
    const row = result.rows.find((r) => r.barMark === 'C1-T1');
    expect(row?.cuttingLengthMm).not.toBeNull();
    expect(row?.lengthSource).toBe('SHAPE_FORMULA');
  });

  it('the gap panel no longer asks for a declared cross-section', () => {
    // backstop: even if grounding were skipped, the question must not render
    const ungrounded = buildBbs(extract(), reading(member({})), DEFAULT_SETTINGS, {
      members: {},
      bars: {},
    });
    const gaps = findGaps(ungrounded, DEFAULT_SETTINGS, true, [C1_DECLARED]);
    expect(gaps.filter((g) => g.subject === 'C1' && (g.field === 'lengthMm' || g.field === 'widthMm')))
      .toEqual([]);
  });

  it('still asks about a member the sheet declares nowhere', () => {
    const ungrounded = buildBbs(extract([]), reading(member({})), DEFAULT_SETTINGS, {
      members: {},
      bars: {},
    });
    const gaps = findGaps(ungrounded, DEFAULT_SETTINGS, true, []);
    expect(gaps.some((g) => g.subject === 'C1' && g.field === 'lengthMm')).toBe(true);
  });
});

describe('locating dotted marks', () => {
  it('counts "S.C" tags for the mark SC — dots are typography, not identity', async () => {
    const { locateMembers } = await import('../../src/cad/bbs/locate');
    const doc = {
      entities: [
        { type: 'text', text: 'S.C', position: { x: 0, y: 0 }, style: { handle: 'a', layer: '' } },
        { type: 'text', text: 'S.C', position: { x: 10, y: 0 }, style: { handle: 'b', layer: '' } },
        { type: 'text', text: 'SC', position: { x: 20, y: 0 }, style: { handle: 'c', layer: '' } },
        // a sentence mentioning it is not a tag
        { type: 'text', text: 'S.C TYPICAL', position: { x: 30, y: 0 }, style: { handle: 'd', layer: '' } },
      ],
    } as never;
    const found = locateMembers(doc, extract([]), ['SC']);
    expect(found.get('SC')?.count).toBe(3);
  });
});

describe('healing a poisoned cached reading', () => {
  it('strips an impossible cached dimension so the declaration can fill it', () => {
    // the cached GAMCO reading carries widthMm: 2 — read off the mark "C2"
    // before the plausibility gate existed. Without this, only a paid
    // re-read would fix it.
    const poisoned = reading(member({ widthMm: 2, lengthMm: 525, missing: [] }));
    const out = groundDeclaredDims(poisoned, [{ ...C1_DECLARED, name: 'C1', dimsMm: [350, 350] }]);
    expect(out.members[0].widthMm).toBe(350);
    expect(out.members[0].lengthMm).toBe(525);
  });
});

describe('typing the height completes the member', () => {
  // The promise the settled panel makes: answer the question and its rows
  // fill in. C1 with its declared 350x350 plus ONE typed height must compute
  // everything — vertical length AND tie count — with no further asks.
  it('computes vertical length and tie count from one answered height', () => {
    // the height arrives on the member the same way the panel lands it:
    // applyOverrides patches the interpretation BEFORE buildBbs runs
    const grounded = groundDeclaredDims(reading(member({ heightMm: 2400 })), [C1_DECLARED]);
    const result = buildBbs(extract(), grounded, DEFAULT_SETTINGS, { members: {}, bars: {} });
    const tie = result.rows.find((r) => r.barMark === 'C1-T1');
    // span 2400 − 2×50 cover = 2300; ceil(2300/200) = 12 gaps → 13 ties
    expect(tie?.barsPerMember).toBe(13);
    expect(tie?.cuttingLengthMm).not.toBeNull();
    expect(result.incomplete).toEqual([]);
  });
});
