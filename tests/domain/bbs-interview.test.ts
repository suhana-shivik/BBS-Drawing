import { beforeEach, describe, expect, it } from 'vitest';
import {
  answersBrief,
  coverageGaps,
  applyAnswers,
  forgetInterview,
  freshReadRecord,
  loadInterview,
  parseFreeformAnswers,
  parseQuestions,
  recordExchanges,
  saveInterview,
  unaskedBlockingFacts,
  validateAnswer,
  vetQuestions,
  MAX_QUESTIONS_PER_ROUND,
  type InterviewQuestion,
} from '../../src/cad/bbs/interview';

/**
 * The interview contract (BBS_PLAN.md §2): stable ids, typed answers, every
 * question landing somewhere, answers persisting and replaying. Each test is
 * one clause of that contract, because each clause guards a specific failure —
 * an id-less question loses its answer on re-read, a target-less answer lands
 * nowhere and the user's typing was for nothing.
 */

const q = (over: Partial<InterviewQuestion> = {}): InterviewQuestion => ({
  id: 'run-total',
  text: 'Total run of the boundary wall, in metres?',
  why: 'Every quantity multiplies out of it.',
  kind: 'number',
  unit: 'm',
  writes: { scope: 'takeoff', field: 'runM' },
  ...over,
});

describe('parsing what the model emits', () => {
  it('accepts a well-formed question', () => {
    const { questions, rejected } = parseQuestions({
      questions: [
        {
          id: 'P2-height',
          text: 'Height of P2, footing top to FFL?',
          why: 'Every vertical bar is cut to it.',
          kind: 'number',
          unit: 'mm',
          writes: { scope: 'member', mark: 'P2', field: 'heightMm' },
          suggestion: { value: 2450, basis: 'the issued schedule for the sister building' },
        },
      ],
    });
    expect(rejected).toEqual([]);
    expect(questions[0]).toMatchObject({
      id: 'P2-height',
      kind: 'number',
      writes: { scope: 'member', mark: 'P2', field: 'heightMm' },
    });
  });

  it('drops a question with no id — its answer could never survive a re-read', () => {
    const { questions, rejected } = parseQuestions({
      questions: [{ text: 'how long?', kind: 'number', writes: { scope: 'takeoff', field: 'x' } }],
    });
    expect(questions).toEqual([]);
    expect(rejected[0]).toMatch(/no id/);
  });

  it('drops a question whose answer would land nowhere', () => {
    const { questions, rejected } = parseQuestions({
      questions: [{ id: 'a', text: 'b?', kind: 'number' }],
    });
    expect(questions).toEqual([]);
    expect(rejected[0]).toMatch(/land nowhere/);
  });

  it('drops an unknown kind rather than guessing an input for it', () => {
    const { rejected } = parseQuestions({
      questions: [{ id: 'a', text: 'b?', kind: 'essay', writes: { scope: 'takeoff', field: 'x' } }],
    });
    expect(rejected[0]).toMatch(/unknown kind/);
  });

  it('caps a round — more questions than the cap is a form, not an interview', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `q${i}`,
      text: `Question ${i}?`,
      kind: 'number',
      writes: { scope: 'takeoff', field: `f${i}` },
    }));
    expect(parseQuestions({ questions: many }).questions).toHaveLength(MAX_QUESTIONS_PER_ROUND);
  });

  it('keeps per_stretch columns, the shape the zone table needs', () => {
    const { questions } = parseQuestions({
      questions: [
        {
          id: 'zones',
          text: 'How does the run split?',
          kind: 'per_stretch',
          columns: ['stretch (m)', 'section', 'founding level (m)'],
          writes: { scope: 'takeoff', field: 'zones' },
        },
      ],
    });
    expect(questions[0].columns).toEqual(['stretch (m)', 'section', 'founding level (m)']);
  });
});

describe('validating answers before they land', () => {
  it('rejects a negative dimension — the −2 cutting length must be impossible', () => {
    expect(validateAnswer(q(), -2)).toMatch(/negative/);
  });

  it('rejects zero, which would silently erase quantities', () => {
    expect(validateAnswer(q(), 0)).toMatch(/Zero/);
  });

  it('rejects a choice that is not one of the options', () => {
    const choice = q({ kind: 'choice', options: ['whole job', 'typical stretch'] });
    expect(validateAnswer(choice, 'maybe')).toMatch(/listed options/);
    expect(validateAnswer(choice, 'whole job')).toBeNull();
  });

  it('rejects an empty stretch table', () => {
    expect(validateAnswer(q({ kind: 'per_stretch' }), [])).toMatch(/at least one row/);
  });

  it('accepts a sane number', () => {
    expect(validateAnswer(q(), 320)).toBeNull();
  });
});

describe('applying answers mechanically', () => {
  it('lands a member answer on the member, a settings answer on settings', () => {
    const applied = applyAnswers([
      {
        question: q({ id: 'h', writes: { scope: 'member', mark: 'P2', field: 'heightMm' } }),
        answer: { questionId: 'h', value: 2450 },
        at: 1,
      },
      {
        question: q({ id: 'c', writes: { scope: 'settings', field: 'coverMm' } }),
        answer: { questionId: 'c', value: 40 },
        at: 1,
      },
    ]);
    expect(applied.members.P2).toEqual({ heightMm: 2450 });
    expect(applied.settings.coverMm).toBe(40);
  });

  it('records a take-off fact instead of pretending an engine consumes it', () => {
    const applied = applyAnswers([
      { question: q(), answer: { questionId: 'run-total', value: 320 }, at: 1 },
    ]);
    expect(applied.takeoff.runM).toBe(320);
    expect(applied.members).toEqual({});
  });

  it('applies nothing from a skipped question', () => {
    const applied = applyAnswers([{ question: q(), skipped: true, at: 1 }]);
    expect(applied.takeoff).toEqual({});
  });
});

describe('the record — resume, never restart', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips through storage per drawing', () => {
    const rec = recordExchanges(
      { drawingKey: 'wall.dxf', exchanges: [], updatedAt: 0 },
      [q()],
      [{ questionId: 'run-total', value: 320 }],
    );
    saveInterview(rec);
    expect(loadInterview('wall.dxf').exchanges[0].answer?.value).toBe(320);
    expect(loadInterview('other.dxf').exchanges).toEqual([]);
    forgetInterview('wall.dxf');
    expect(loadInterview('wall.dxf').exchanges).toEqual([]);
  });

  it('marks an unanswered question as declined, not lost', () => {
    const rec = recordExchanges(
      { drawingKey: 'k', exchanges: [], updatedAt: 0 },
      [q()],
      [], // the round came back with no answer for it
    );
    expect(rec.exchanges[0].skipped).toBe(true);
  });

  it('lets a later answer replace an earlier one for the same id', () => {
    let rec = recordExchanges(
      { drawingKey: 'k', exchanges: [], updatedAt: 0 },
      [q()],
      [{ questionId: 'run-total', value: 300 }],
    );
    rec = recordExchanges(rec, [q()], [{ questionId: 'run-total', value: 320 }]);
    expect(rec.exchanges).toHaveLength(1);
    expect(rec.exchanges[0].answer?.value).toBe(320);
  });

  it('briefs the next read on answers AND refusals', () => {
    const rec = recordExchanges(
      { drawingKey: 'k', exchanges: [], updatedAt: 0 },
      [q(), q({ id: 'bays', text: 'How many bays?' })],
      [{ questionId: 'run-total', value: 320 }],
    );
    const brief = answersBrief(rec);
    expect(brief).toMatch(/do NOT ask these again/);
    expect(brief).toMatch(/320 m/);
    expect(brief).toMatch(/DECLINED/);
  });

  it('briefs nothing when nothing was ever asked', () => {
    expect(answersBrief({ drawingKey: 'k', exchanges: [], updatedAt: 0 })).toBe('');
  });
});

describe('the vet — questions the sheet answers never reach the user', () => {
  // One visibly dumb question poisons trust in every good one. The vet is
  // deterministic and conservative: it refuses only what the extract proves,
  // and each refusal tells the model where the answer is.
  const extract = {
    declared: [
      { name: 'TB', sizeText: '(350X400)', dimsMm: [350, 400], occurrences: 12, raw: 'TB-(350X400)', handles: [] },
      { name: 'H-POLE', sizeText: '(150X150X2400)', dimsMm: [150, 150, 2400], occurrences: 2, raw: '', handles: [] },
    ],
    notes: {
      notes: [],
      coverByMember: [{ member: 'COLUMN', coversMm: [40], raw: 'b. COLUMN' }],
      globalRules: [{ kind: 'lap' as const, multiple: 50, raw: 'LAPS 50 D' }],
    },
  };

  it('refuses a cover question when the sheet tabulates cover', () => {
    const { ask, refused } = vetQuestions(
      [q({ id: 'cover', writes: { scope: 'settings', field: 'coverMm' } })],
      extract,
    );
    expect(ask).toEqual([]);
    expect(refused[0].reason).toMatch(/TABULATES cover/);
    expect(refused[0].reason).toMatch(/COLUMN 40/);
  });

  it('refuses an Ld question when the notes state the multiple', () => {
    const { refused } = vetQuestions(
      [q({ id: 'ld', writes: { scope: 'settings', field: 'ldMultiple' } })],
      extract,
    );
    expect(refused[0].reason).toMatch(/LAPS 50 D/);
  });

  it('refuses a cross-section question for a member the sheet declares', () => {
    const { refused } = vetQuestions(
      [q({ id: 'tb-w', writes: { scope: 'member', mark: 'TB', field: 'widthMm' } })],
      extract,
    );
    expect(refused[0].reason).toMatch(/350X400/);
  });

  it('refuses a height question only when the declaration carries three dims', () => {
    const pole = vetQuestions(
      [q({ id: 'pole-h', writes: { scope: 'member', mark: 'H-POLE', field: 'heightMm' } })],
      extract,
    );
    expect(pole.refused).toHaveLength(1);
    // TB is declared 350×400 — two dims. Its HEIGHT is genuinely unknown,
    // and refusing that question would silence a legitimate one.
    const tb = vetQuestions(
      [q({ id: 'tb-h', writes: { scope: 'member', mark: 'TB', field: 'heightMm' } })],
      extract,
    );
    expect(tb.ask).toHaveLength(1);
  });

  it('passes the questions no extract can answer — the run, the bays', () => {
    const { ask, refused } = vetQuestions(
      [q(), q({ id: 'bays', writes: { scope: 'takeoff', field: 'bays' } })],
      extract,
    );
    expect(ask).toHaveLength(2);
    expect(refused).toEqual([]);
  });
});

describe('the completeness gate — the user is the final stop', () => {
  // "The model should not stop questioning till the NOT AVAILABLE didn't
  // finish." A read whose own answer lists blocking unknowns, with rounds to
  // spare and no question ever asked, is bounced back with the exact list.
  // The model's answer, as it actually failed: C1's height simply left null
  // WITHOUT being declared in `missing` — the first gate trusted that list
  // and waved the read through. Need is derived from the bars, absence from
  // the refs; the model's self-report is corroboration, never the test.
  const answer = JSON.stringify({
    members: [
      { mark: 'C1', dims: { L: { column: 1, part: 1 }, W: { column: 1, part: 2 }, H: null } },
      { mark: 'F1', dims: {}, missing: [] },
      { mark: 'TB', dims: {}, missing: ['H'] },
    ],
    bars: [
      { memberMark: 'C1', barType: 'MAIN', fromCallout: 'x' },
      { memberMark: 'F1', barType: 'BOTTOM', distributionAxis: 'W', shapeCode: '21', fromCallout: 'y' },
      // TB deliberately has no bars
    ],
    unresolved: [],
  });

  const empty = { drawingKey: 'k', exchanges: [], updatedAt: 0 };

  it('catches a null dim the model never declared missing', () => {
    const out = unaskedBlockingFacts(answer, empty);
    expect(out).toContainEqual({ mark: 'C1', axis: 'H', field: 'heightMm' });
  });

  it('derives what a mat bar needs — both plan axes and the depth its legs stand in', () => {
    const out = unaskedBlockingFacts(answer, empty);
    expect(out).toContainEqual({ mark: 'F1', axis: 'L', field: 'lengthMm' });
    expect(out).toContainEqual({ mark: 'F1', axis: 'W', field: 'widthMm' });
    expect(out).toContainEqual({ mark: 'F1', axis: 'H', field: 'heightMm' });
  });

  it('does not flag an axis whose reference actually resolved', () => {
    expect(unaskedBlockingFacts(answer, empty).some((u) => u.mark === 'C1' && u.axis === 'L')).toBe(false);
  });

  it('does not nag about a member with no bars — nothing is blocked', () => {
    expect(unaskedBlockingFacts(answer, empty).some((u) => u.mark === 'TB')).toBe(false);
  });

  it('counts an ASKED fact as asked, whether answered or declined', () => {
    const rec = recordExchanges(
      empty,
      [
        q({ id: 'c1-h', writes: { scope: 'member', mark: 'C1', field: 'heightMm' } }),
        q({ id: 'f1-l', writes: { scope: 'member', mark: 'F1', field: 'lengthMm' } }),
      ],
      [{ questionId: 'c1-h', value: 2400 }], // f1-l left blank = declined
    );
    const out = unaskedBlockingFacts(answer, rec);
    // C1 answered, F1-L declined — neither is nagged again
    expect(out.some((u) => u.mark === 'C1')).toBe(false);
    expect(out.some((u) => u.mark === 'F1' && u.axis === 'L')).toBe(false);
    expect(out).toContainEqual({ mark: 'F1', axis: 'W', field: 'widthMm' });
  });
});

describe('a spinner click cannot answer a dimension', () => {
  it('refuses 1 mm for a member axis, matching the engine gate', () => {
    const height = q({ id: 'h', writes: { scope: 'member', mark: 'C1', field: 'heightMm' } });
    expect(validateAnswer(height, 1)).toMatch(/not a member dimension/);
    expect(validateAnswer(height, 2400)).toBeNull();
  });

  it('still accepts a small cover, which is a setting, not a member axis', () => {
    const cover = q({ id: 'c', writes: { scope: 'settings', field: 'coverMm' } });
    expect(validateAnswer(cover, 20)).toBeNull();
  });
});

describe('the coverage critic — nothing declared may silently vanish', () => {
  // The GAMCO wall: declared sixteen times, 34 callouts on the sheet, and the
  // answer contained no wall — and the read completed. The critic diffs the
  // sheet's declarations against the answer's members, deterministically.
  const extract = {
    declared: [
      { name: 'RCC WALL', sizeText: '200THK', dimsMm: [200], occurrences: 16, raw: '', handles: [] },
      { name: 'TB', sizeText: '(350X400)', dimsMm: [350, 400], occurrences: 12, raw: '', handles: [] },
      // seen once — a stray, not a member the critic should die on
      { name: 'ODDITY', sizeText: '100x100', dimsMm: [100, 100], occurrences: 1, raw: '', handles: [] },
    ],
    callouts: [
      { raw: '10TOR@200C/C', diaMm: 10, position: { x: 0, y: 0 }, handle: 'a', layer: '' },
      { raw: '8-12TOR', diaMm: 12, position: { x: 0, y: 0 }, handle: 'b', layer: '' },
      { raw: 'SOME NOTE', position: { x: 0, y: 0 }, handle: 'c', layer: '' }, // unparsed
    ],
  };

  it('names a declared member the answer left out', () => {
    const answer = JSON.stringify({
      members: [{ mark: 'TB' }],
      bars: [{ memberMark: 'TB', fromCallout: '8-12TOR' }],
    });
    const { missingMembers } = coverageGaps(answer, extract);
    expect(missingMembers).toEqual(['RCC WALL (200THK, seen 16×)']);
  });

  it('names the parsed callouts assigned to nothing', () => {
    const answer = JSON.stringify({ members: [{ mark: 'TB' }], bars: [] });
    const { unassignedCallouts } = coverageGaps(answer, extract);
    expect(unassignedCallouts).toContain('10TOR@200C/C');
    // an unparsed string is not a bar and is not nagged about
    expect(unassignedCallouts).not.toContain('SOME NOTE');
  });

  it('stays silent when the answer covers the sheet', () => {
    const answer = JSON.stringify({
      members: [{ mark: 'TB' }, { mark: 'RCC WALL' }],
      bars: [
        { memberMark: 'TB', fromCallout: '8-12TOR' },
        { memberMark: 'RCC WALL', fromCallout: '10TOR@200C/C' },
      ],
    });
    const out = coverageGaps(answer, extract);
    expect(out.missingMembers).toEqual([]);
    expect(out.unassignedCallouts).toEqual([]);
  });
});

describe('a skip means "not now", never "never"', () => {
  // One skipped round in an earlier session silenced eleven questions in
  // every session after it: the declines replayed as "asked", the gate
  // counted them satisfied, and the user faced a 0 kg schedule wondering why
  // nothing ever asked them anything.
  it('drops declines from the record a new read starts with', () => {
    const rec = recordExchanges(
      { drawingKey: 'k', exchanges: [], updatedAt: 0 },
      [q({ id: 'a' }), q({ id: 'b', writes: { scope: 'member', mark: 'C1', field: 'heightMm' } })],
      [{ questionId: 'a', value: 100 }], // b left blank = declined
    );
    const fresh = freshReadRecord(rec);
    expect(fresh.exchanges).toHaveLength(1);
    expect(fresh.exchanges[0].answer?.value).toBe(100);
  });

  it('so a previously declined fact becomes askable again', () => {
    const rec = recordExchanges(
      { drawingKey: 'k', exchanges: [], updatedAt: 0 },
      [q({ id: 'c1-h', writes: { scope: 'member', mark: 'C1', field: 'heightMm' } })],
      [], // declined
    );
    const answer = JSON.stringify({
      members: [{ mark: 'C1', dims: { H: null } }],
      bars: [{ memberMark: 'C1', barType: 'MAIN' }],
    });
    // against the stale record the gate stays silent; against a fresh read it fires
    expect(unaskedBlockingFacts(answer, rec)).toEqual([]);
    expect(unaskedBlockingFacts(answer, freshReadRecord(rec))).toContainEqual({
      mark: 'C1',
      axis: 'H',
      field: 'heightMm',
    });
  });
});

describe('free-text answers — typed only when unambiguous', () => {
  const open = [
    q({ id: 'run', text: 'Total run of the linear work (wall / tie beam), in metres', unit: 'm', writes: { scope: 'takeoff', field: 'runM' } }),
    q({ id: 'c2h', text: 'C2 — height in mm', unit: 'mm', writes: { scope: 'member', mark: 'C2', field: 'heightMm' } }),
    q({ id: 'sch', text: 'SC — height in mm', unit: 'mm', writes: { scope: 'member', mark: 'SC', field: 'heightMm' } }),
  ];

  it('types the site engineer’s sentence: run and heights in one line', () => {
    const { answers, unmatched } = parseFreeformAnswers('run is 100m, C2 height 1.2m and SC height 1200mm', open);
    expect(answers).toContainEqual({ questionId: 'run', value: 100 });
    expect(answers).toContainEqual({ questionId: 'c2h', value: 1200 }); // 1.2 m → mm
    expect(answers).toContainEqual({ questionId: 'sch', value: 1200 });
    expect(unmatched).toBe('');
  });

  it('reads a bare small number against a mm question as metres', () => {
    // nobody answers a wall height as 1.2 millimetres
    const { answers } = parseFreeformAnswers('C2 height 1.2', open);
    expect(answers).toContainEqual({ questionId: 'c2h', value: 1200 });
  });

  it('refuses a clause two questions could claim', () => {
    const { answers, unmatched } = parseFreeformAnswers('height is 1200', open);
    // C2 or SC? Not ours to guess — the model gets it verbatim instead
    expect(answers).toEqual([]);
    expect(unmatched).toMatch(/height is 1200/);
  });

  it('refuses a clause with two numbers', () => {
    const { answers, unmatched } = parseFreeformAnswers('C2 is 350 x 1200', open);
    expect(answers).toEqual([]);
    expect(unmatched).toMatch(/350 x 1200/);
  });

  it('a value the cards would reject stays unmatched too', () => {
    const { answers, unmatched } = parseFreeformAnswers('SC height 5mm', open);
    expect(answers).toEqual([]);
    expect(unmatched).toMatch(/SC height 5/);
  });
});
