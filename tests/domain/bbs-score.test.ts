// The scorer is the instrument. An instrument that has not been calibrated
// against known-wrong inputs measures nothing.
//
// Every test here mutates a KNOWN-GOOD run in exactly one way and asserts the
// scorer notices that one thing — because the failure mode that matters is a
// scorer that reports green while the read regresses.
import { describe, expect, it } from 'vitest';
import {
  formatScore,
  mergeRepeats,
  refMatches,
  scoreRun,
  type RunObserved,
  type Truth,
} from '../../src/cad/bbs/score';
import type { BbsInterpretation } from '../../src/cad/bbs/types';

const truth: Truth = {
  sheet: 'synthetic',
  allowedQuestions: ['run'],
  members: [
    {
      mark: 'C1',
      type: 'column',
      dims: {
        L: { mm: 350, refs: [{ handle: 'AAA', part: 1 }] },
        H: { mm: 2700, refs: [{ op: 'diff', a: { handle: 'TOP', part: 1 }, b: { handle: 'BOT', part: 1 } }] },
      },
      count: { kind: 'rule', pitchMm: 2050 },
    },
  ],
  bars: [{ fromCallout: '8-12TOR', memberMark: 'C1', barType: 'MAIN', diaMm: 12 }],
};

function interpretation(over: Partial<BbsInterpretation['members'][0]> = {}): BbsInterpretation {
  return {
    members: [
      {
        mark: 'C1',
        type: 'column',
        lengthMm: 350,
        heightMm: 2700,
        count: 49,
        countRule: { pitchMm: 2050, endsInclusive: true },
        source: { table: '', row: -1 },
        incomplete: false,
        missing: [],
        ...over,
      },
    ],
    bars: [
      {
        memberMark: 'C1',
        barType: 'MAIN',
        diaMm: 12,
        shapeCode: '00',
        fromCallout: '8-12TOR',
        handles: [],
      },
    ],
    unresolved: [],
  };
}

const raw = {
  members: [
    {
      mark: 'C1',
      dims: {
        L: { handle: 'AAA', part: 1 },
        H: { op: 'diff', a: { handle: 'TOP', part: 1 }, b: { handle: 'BOT', part: 1 } },
      },
      count: { kind: 'rule', along: 'run' },
    },
  ],
};

const good: RunObserved = { interpretation: interpretation(), raw, questionsAsked: ['run'], questionsVetoed: [] };

const failing = (r: ReturnType<typeof scoreRun>) => r.fields.filter((f) => !f.ok).map((f) => f.field);

describe('the interpretation scorer', () => {
  it('passes a run that matches the truth', () => {
    const r = scoreRun(truth, good);
    expect(failing(r)).toEqual([]);
    expect(r.passed).toBe(r.total);
  });

  it('catches a missing member', () => {
    const r = scoreRun(truth, { ...good, interpretation: { members: [], bars: [], unresolved: [] } });
    expect(failing(r)).toContain('C1.present');
  });

  it('catches a wrong value even when something resolved', () => {
    const r = scoreRun(truth, { ...good, interpretation: interpretation({ lengthMm: 150 }) });
    expect(failing(r)).toContain('C1.L.value');
    expect(failing(r)).not.toContain('C1.L.resolved');
  });

  it('catches an unresolved dim', () => {
    const r = scoreRun(truth, { ...good, interpretation: interpretation({ heightMm: undefined }) });
    expect(failing(r)).toContain('C1.H.resolved');
  });

  it('catches a right value reached through a pointer the truth does not allow', () => {
    // the number is correct and the provenance is not — exactly the mis-pointing
    // a target-seeking model produces
    const r = scoreRun(truth, {
      ...good,
      raw: { members: [{ mark: 'C1', dims: { L: { handle: 'ZZZ', part: 1 }, H: raw.members[0].dims.H } }] },
    });
    expect(failing(r)).toContain('C1.L.ref');
    expect(failing(r)).not.toContain('C1.L.value');
  });

  it('accepts any of several allowed pointers', () => {
    const many: Truth = {
      ...truth,
      members: [{ ...truth.members[0], dims: { L: { mm: 350, refs: [{ handle: 'AAA' }, { handle: 'BBB' }] } } }],
    };
    const r = scoreRun(many, {
      ...good,
      raw: { members: [{ mark: 'C1', dims: { L: { handle: 'BBB', part: 1 } } }] },
    });
    expect(failing(r)).not.toContain('C1.L.ref');
  });

  it('catches the wrong count kind', () => {
    const r = scoreRun(truth, {
      ...good,
      interpretation: interpretation({ count: 1, countRule: undefined }),
      raw: { members: [{ mark: 'C1', dims: raw.members[0].dims, count: { kind: 'once' } }] },
    });
    expect(failing(r)).toContain('C1.count.kind');
  });

  it('infers a pre-union run’s count kind, so before/after can be compared', () => {
    // no `count` object at all — the shape that existed before Change 2
    const r = scoreRun(truth, {
      ...good,
      raw: { members: [{ mark: 'C1', dims: raw.members[0].dims }] },
    });
    expect(failing(r)).not.toContain('C1.count.kind');
  });

  it('catches an extra question', () => {
    const r = scoreRun(truth, { ...good, questionsAsked: ['run', 'levels'] });
    const q = r.fields.find((f) => f.field === 'questions.subset');
    expect(q?.ok).toBe(false);
    expect(q?.got).toMatch(/levels/);
  });

  it('counts a vetoed question as a finding', () => {
    const r = scoreRun(truth, { ...good, questionsVetoed: ['height-of-C1'] });
    expect(failing(r)).toContain('questions.vetoed');
  });

  it('catches a bar tied to the wrong member', () => {
    const bad = interpretation();
    bad.bars[0].memberMark = 'C2';
    const r = scoreRun(truth, { ...good, interpretation: bad });
    expect(failing(r)).toContain('bar[8-12TOR].member');
  });

  it('never mentions a tonnage or a target', () => {
    const text = formatScore('synthetic', mergeRepeats([scoreRun(truth, good)]));
    expect(text).not.toMatch(/\bkg\b|\bton|\bMT\b|tonnage/i);
  });
});

describe('repeats', () => {
  it('reports per-field stability rather than a single sample', () => {
    const pass = scoreRun(truth, good);
    const fail = scoreRun(truth, { ...good, interpretation: interpretation({ heightMm: undefined }) });
    const merged = mergeRepeats([pass, fail, pass]);
    const h = merged.find((f) => f.field === 'C1.H.resolved');
    expect(h).toMatchObject({ passes: 2, runs: 3 });
    expect(formatScore('synthetic', merged)).toContain('2/3');
  });
});

describe('ref matching', () => {
  it('matches a diff structurally, both sides', () => {
    const want = { op: 'diff' as const, a: { handle: 'A', part: 1 }, b: { handle: 'B', part: 2 } };
    expect(refMatches(want, { op: 'diff', a: { handle: 'a', part: 1 }, b: { handle: 'b', part: 2 } })).toBe(true);
    expect(refMatches(want, { op: 'diff', a: { handle: 'A', part: 1 }, b: { handle: 'X', part: 2 } })).toBe(false);
    expect(refMatches(want, { handle: 'A', part: 1 })).toBe(false);
  });

  it('defaults part to 1 when the truth does not pin it', () => {
    expect(refMatches({ handle: 'A' }, { handle: 'A', part: 3 })).toBe(true);
    expect(refMatches({ handle: 'A', part: 1 }, { handle: 'A' })).toBe(true);
    expect(refMatches({ handle: 'A', part: 2 }, { handle: 'A' })).toBe(false);
  });
});
