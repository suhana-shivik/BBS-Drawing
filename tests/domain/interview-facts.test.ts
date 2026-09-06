import { describe, expect, it } from 'vitest';
import type { AskableQuestion } from '../../src/cad/bbs/askFrom';
import { addFact, emptyLedger, resolveFact } from '../../src/facts/ledger';
import { InterviewSession } from '../../src/interview/session';
import {
  engineKeyForQuestion,
  escalationQuestion,
  factFromAnswer,
  factIdForQuestion,
  inferWritesTo,
  isDecline,
  projectFactsFromAnswers,
  recordAnswers,
  toInterviewQuestion,
  typeAnswer,
} from '../../src/interview/facts';

const WHO = { suppliedBy: 'hello@shivik.in', on: '2026-08-31' };

const question = (over: Partial<AskableQuestion> = {}): AskableQuestion => ({
  id: 'dimension:C1:H',
  question: "What is C1's height?",
  why: 'the verticals are cut to it',
  blocks: ['C1', 'C2'],
  evidence: ['DIM-017 — would give 350 mm'],
  answerType: 'number-mm',
  writesTo: { memberMark: 'C1', field: 'H' },
  ...over,
});

const runQuestion = question({
  id: 'placement:-:run',
  question: 'What is the total run of this structure, in metres?',
  answerType: 'number-m',
  blocks: ['WALL'],
  writesTo: { field: 'run' },
});

/** answer one question through the session, so the answers are the real shape */
function answerOf(q: AskableQuestion, raw: string) {
  const session = new InterviewSession({ now: () => 1_770_000_000_000 });
  session.askUser(q);
  const outcome = session.answer(q.id, raw);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.answered;
}

describe('where an answer lands', () => {
  it('maps a question to the ledger id and the engine key, reusing one translation table', () => {
    expect(factIdForQuestion(question())).toBe('C1.height');
    expect(engineKeyForQuestion(question())).toBe('c1_height');

    expect(factIdForQuestion(runQuestion)).toBe('wall.total_run');
    expect(engineKeyForQuestion(runQuestion)).toBe('run');

    expect(factIdForQuestion(question({ writesTo: { field: 'cover' } }))).toBe('settings.cover');
    expect(
      factIdForQuestion(question({ writesTo: { memberMark: 'f1', field: 'disposition' } })),
    ).toBe('F1.disposition');
  });

  it('translates into the vocabulary interview.ts already validates', () => {
    const iq = toInterviewQuestion(question());
    expect(iq.kind).toBe('number');
    expect(iq.unit).toBe('mm');
    expect(iq.writes).toEqual({ scope: 'member', mark: 'C1', field: 'heightMm' });
  });
});

describe('lifting an escalation into something that can be answered', () => {
  it('reads a writesTo out of the question the lead actually asked', () => {
    expect(inferWritesTo('What is the total run of the wall?')).toEqual({ field: 'run' });
    expect(inferWritesTo('How deep is F1 below ground?', ['F1', 'C1'])).toEqual({
      memberMark: 'F1',
      field: 'H',
    });
    expect(inferWritesTo('What clear cover applies to the retaining wall?')).toEqual({
      field: 'cover',
    });
  });

  it('returns null when a question would land nowhere — it stays an escalation', () => {
    expect(inferWritesTo('Is the north elevation part of this contract?', ['F1'])).toBeNull();
    expect(
      escalationQuestion(
        { question: 'Is the north elevation part of this contract?', whyNeeded: '…' },
        { id: 'esc-1', marks: ['F1'] },
      ),
    ).toBeNull();
  });

  it('builds a question carrying everything askFrom.ts requires', () => {
    const lifted = escalationQuestion(
      { question: 'What is the total run of the wall?', whyNeeded: 'every quantity multiplies out of it' },
      { id: 'esc-0', blocks: ['WALL'], evidence: ['the sheet says "TYPICAL PANEL"'] },
    );
    expect(lifted).toMatchObject({
      id: 'esc-0',
      answerType: 'number-m',
      writesTo: { field: 'run' },
      blocks: ['WALL'],
    });
    expect(factIdForQuestion(lifted!)).toBe('wall.total_run');
  });
});

describe('typed validation — free prose never reaches arithmetic', () => {
  it('types a measurement and normalises the unit the question was ASKED in', () => {
    const mm = typeAnswer(question(), '1200');
    expect('patch' in mm && mm.patch.mm).toBe(1200);

    const metres = typeAnswer(runQuestion, '100');
    expect('patch' in metres && metres.patch.mm).toBe(100000);
  });

  it('returns an error to re-ask with, never a coerced number', () => {
    const prose = typeAnswer(question(), 'about as tall as the wall');
    expect('error' in prose && prose.error).toMatch(/carries no number/);
    // A hedge over a real figure is refused too: "about 1200" used to be taken
    // as 1200, which puts an estimate in a cell nothing can tell from a
    // measurement (see askFrom.ts's HEDGED).
    const hedged = typeAnswer(question(), 'about 1200');
    expect('error' in hedged && hedged.error).toMatch(/estimate, not a measurement/);
    const misclick = typeAnswer(question(), '1');
    expect('error' in misclick && misclick.error).toMatch(/not a member dimension/);
  });

  it('knows a decline from an answer', () => {
    for (const said of ['skip', 'I don\'t know', 'dunno', 'no idea', 'n/a', 'not sure']) {
      expect(isDecline(said)).toBe(true);
    }
    expect(isDecline('1200')).toBe(false);
    expect(isDecline('it repeats at a regular pitch')).toBe(false);
  });
});

describe('an answer becomes a SUPPLIED fact carrying the words it was given in', () => {
  it('records saidAs, provenance and what it was needed for', () => {
    const fact = factFromAnswer(answerOf(question(), '1200 mm'), WHO);
    expect(fact.state).toBe('SUPPLIED');
    expect(fact.id).toBe('C1.height');
    expect(fact.value).toBe(1200);
    expect(fact.unit).toBe('mm');
    expect(fact.saidAs).toBe('1200 mm');
    expect(fact.suppliedBy).toBe('hello@shivik.in');
    expect(fact.neededFor).toEqual(['C1', 'C2']);
    expect(fact.evidence?.[0]).toMatch(/asked: "What is C1's height\?"/);
  });

  it('lands in the ledger through recordFact, so the trust rule applies to a person too', () => {
    const { ledger, applied } = recordAnswers(emptyLedger(), [answerOf(question(), '1200')], WHO);
    expect(applied).toHaveLength(1);
    expect(resolveFact(ledger, 'C1.height')?.value).toBe(1200);
    expect(resolveFact(ledger, 'C1.height')?.state).toBe('SUPPLIED');
  });

  it('does not let a supplied answer silently displace a MEASURED reading', () => {
    const seeded = addFact(emptyLedger(), {
      id: 'C1.height',
      value: 3000,
      unit: 'mm',
      state: 'MEASURED',
      method: 'dimension chain DIM-017 + DIM-018',
      readOn: '2026-08-30',
    });
    const { ledger, applied, rejected } = recordAnswers(seeded, [answerOf(question(), '1200')], WHO);
    expect(applied).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/lower trust/);
    // the losing claim is on the record, and the measured value still governs
    expect(resolveFact(ledger, 'C1.height')?.value).toBe(3000);
    expect(resolveFact(ledger, 'C1.height')?.contradictedBy?.length).toBe(1);
  });

  it('hands the engine the projectFacts shape runOrchestrator consumes', () => {
    const answers = [answerOf(question(), '1200'), answerOf(runQuestion, '100 m')];
    expect(projectFactsFromAnswers(answers)).toEqual({
      c1_height: { mm: 1200, saidAs: '1200' },
      run: { mm: 100000, saidAs: '100 m' },
    });
  });

  it('keeps a choice out of arithmetic — a real answer, but not a millimetre', () => {
    const placement = question({
      id: 'placement:C1:placement',
      answerType: 'choice',
      options: ['it repeats at a regular pitch', 'there is only one'],
      writesTo: { memberMark: 'C1', field: 'placement' },
    });
    const answered = answerOf(placement, 'it repeats at a regular pitch');
    expect(factFromAnswer(answered, WHO).value).toBe('it repeats at a regular pitch');
    expect(projectFactsFromAnswers([answered])).toEqual({});
  });
});

describe('§7.4 — declining is a first-class answer, recorded as a NAMED GAP', () => {
  it('records a MISSING fact carrying the question, and never a default', () => {
    const session = new InterviewSession({ now: () => 1_770_000_000_000 });
    session.askUser(question());
    const outcome = session.skip('dimension:C1:H', "I don't know");
    if (!outcome.ok) throw new Error(outcome.error);

    const fact = factFromAnswer(outcome.answered, WHO);
    expect(fact.state).toBe('MISSING');
    expect(fact.value).toBeNull();
    expect(fact.ask).toBe("What is C1's height?");
    expect(fact.neededFor).toEqual(['C1', 'C2']);
    expect(fact.lookedIn).toEqual(['DIM-017 — would give 350 mm']);
    expect(fact.saidAs).toBe("I don't know");

    const { ledger, gaps } = recordAnswers(emptyLedger(), [outcome.answered], WHO);
    expect(gaps.map((g) => g.id)).toEqual(['C1.height']);
    expect(resolveFact(ledger, 'C1.height')?.state).toBe('MISSING');
    // and nothing reaches the engine — the row stays unavailable
    expect(projectFactsFromAnswers([outcome.answered])).toEqual({});
  });

  it('a named gap never overwrites a value the drawing already gave', () => {
    const seeded = addFact(emptyLedger(), {
      id: 'C1.height',
      value: 3000,
      unit: 'mm',
      state: 'DECLARED',
      readOn: '2026-08-30',
    });
    const session = new InterviewSession();
    session.askUser(question());
    const outcome = session.skip('dimension:C1:H');
    if (!outcome.ok) throw new Error(outcome.error);
    const { ledger } = recordAnswers(seeded, [outcome.answered], WHO);
    expect(resolveFact(ledger, 'C1.height')?.value).toBe(3000);
  });
});
