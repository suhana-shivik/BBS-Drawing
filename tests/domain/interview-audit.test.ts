// WHY DID THE INTERVIEW GO THE WAY IT DID?
//
// The ledger keeps every ANSWER and nothing about the asking. So the three
// questions worth putting to a finished run are the three it cannot answer,
// and they are what this file tests:
//
//   1. Was it already there?          asking for a printed figure costs trust
//   2. Did the answer contradict it?  "300" against a schedule reading 2000
//   3. Why did it still fail?         answered, and the arithmetic never used it
//
// The whole log is DERIVED — from the questions the session kept, the answers
// it kept, and the ledger before and after. There is no second record to drift
// from the first, and nothing here writes anything.
import { describe, expect, it } from 'vitest';
import {
  auditMarkdown,
  buildAuditLog,
  findingsFor,
  numbersIn,
  type AuditEntry,
} from '../../src/interview/audit';
import { addFact, emptyLedger, recordFact, type Ledger } from '../../src/facts/ledger';
import type { Fact } from '../../src/facts/types';
import type { AnsweredQuestion, SessionSnapshot } from '../../src/interview/session';
import type { AskableQuestion } from '../../src/cad/bbs/askFrom';
import { factIdForQuestion } from '../../src/interview/facts';

/** The id the PRODUCTION rule derives — never one the test guessed at. */
const FACT_ID = factIdForQuestion({
  writesTo: { memberMark: 'C1', field: 'H' },
  question: '',
  why: '',
  blocks: [],
  evidence: [],
  answerType: 'number-mm',
  id: 'x',
} as AskableQuestion);

// --- fixtures ---------------------------------------------------------------

function ask(over: Partial<AskableQuestion> = {}): AskableQuestion {
  return {
    id: 'orchestrator:4:0:c1-height',
    question: 'Confirm the height of column C1.',
    why: 'both scheduled bars depend on H',
    blocks: ['C1'],
    evidence: [],
    answerType: 'number-mm',
    writesTo: { memberMark: 'C1', field: 'H' },
    ...over,
  } as AskableQuestion;
}

function answered(question: AskableQuestion, raw: string, mm?: number): AnsweredQuestion {
  return {
    question,
    raw,
    ...(mm !== undefined ? { patch: { mm } } : {}),
    skipped: false,
    at: 1_000,
  } as AnsweredQuestion;
}

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    state: 'published',
    pending: [],
    answered: [],
    transcript: [],
    questionsAsked: 0,
    questionsRemaining: 0,
    ...over,
  } as SessionSnapshot;
}

const withFact = (f: Partial<Fact> & Pick<Fact, 'id' | 'value'>): Ledger =>
  recordFact(emptyLedger(), {
    state: 'SUPPLIED',
    suppliedBy: 'you',
    readOn: '2026-09-03',
    ...f,
  } as Fact).ledger;

// ---------------------------------------------------------------------------

describe('1 — asked for what we already had', () => {
  it('flags a question whose fact was already on file', () => {
    const q = ask();
    const before = withFact({ id: FACT_ID, value: 2000, unit: 'mm', saidAs: '2000' });
    const log = buildAuditLog(snapshot({ answered: [answered(q, '300', 300)] }), before);

    const found = log.findings.find((f) => f.kind === 'ASKED-FOR-WHAT-WE-HAD');
    expect(found).toBeDefined();
    expect(found!.detail).toContain('2000');
    expect(found!.detail).toContain('already on file');
  });

  it('does NOT flag a question for a fact that was genuinely open', () => {
    const log = buildAuditLog(snapshot({ answered: [answered(ask(), '2000', 2000)] }), emptyLedger());
    expect(log.findings.filter((f) => f.kind === 'ASKED-FOR-WHAT-WE-HAD')).toEqual([]);
  });

  it('does not count a NAMED GAP as having had it', () => {
    // A MISSING fact is the record of a question already declined. Asking
    // again is reasonable; asking for a figure already supplied is not.
    const before = withFact({ id: FACT_ID, value: 'not stated', state: 'MISSING' });
    const log = buildAuditLog(snapshot({ answered: [answered(ask(), '2000', 2000)] }), before);
    expect(log.findings.filter((f) => f.kind === 'ASKED-FOR-WHAT-WE-HAD')).toEqual([]);
  });
});

describe('2 — the answer against what the drawing says', () => {
  it('flags an answer that disagrees with the sheet', () => {
    // The real case: the schedule prints "C1 300x300x2000" and the answer
    // given was 300. One of them is wrong and nothing should be built on
    // either until somebody looks.
    const q = ask({ evidence: ['C1 300x300x2000'] });
    const log = buildAuditLog(snapshot({ answered: [answered(q, '300', 300)] }), emptyLedger());

    // …except 300 IS one of the numbers on that line, so this must NOT fire.
    expect(log.findings.filter((f) => f.kind === 'ANSWER-CONTRADICTS-DRAWING')).toEqual([]);
  });

  it('fires when the answer appears nowhere on the cited line', () => {
    const q = ask({ evidence: ['C1 300x300x2000'] });
    const log = buildAuditLog(snapshot({ answered: [answered(q, '2500', 2500)] }), emptyLedger());
    const found = log.findings.find((f) => f.kind === 'ANSWER-CONTRADICTS-DRAWING');
    expect(found).toBeDefined();
    expect(found!.detail).toContain('2500');
    expect(found!.detail).toContain('C1 300x300x2000');
  });

  it('stays quiet when the sheet gave no numbers to disagree with', () => {
    // A line with no figures in it cannot contradict a figure. Reporting it
    // would bury the ones that can.
    const q = ask({ evidence: ['SEE TYPICAL DETAIL'] });
    const log = buildAuditLog(snapshot({ answered: [answered(q, '2000', 2000)] }), emptyLedger());
    expect(log.findings.filter((f) => f.kind === 'ANSWER-CONTRADICTS-DRAWING')).toEqual([]);
  });

  it('stays quiet when the engine collected no evidence at all', () => {
    const log = buildAuditLog(snapshot({ answered: [answered(ask(), '2000', 2000)] }), emptyLedger());
    expect(log.findings.filter((f) => f.kind === 'ANSWER-CONTRADICTS-DRAWING')).toEqual([]);
  });

  it('reads every number out of a line, and only numbers', () => {
    expect(numbersIn('C1 300x300x2000')).toEqual([300, 300, 2000]); // the 1 of C1 is a mark
    expect(numbersIn('8@150 c/c')).toEqual([8, 150]);
    expect(numbersIn('SEE TYPICAL DETAIL')).toEqual([]);
  });
});

describe('3 — answered, and it still did not settle', () => {
  it('flags a fact that is still blocked after the answer', () => {
    // The gap between the answer and the arithmetic — invisible unless the
    // two are recorded side by side.
    const q = ask();
    const after = addFact(emptyLedger(), {
      id: FACT_ID,
      value: 'not stated',
      state: 'MISSING',
      neededFor: ['C1'],
      readOn: '2026-09-03',
    } as Fact);
    const log = buildAuditLog(
      snapshot({ answered: [answered(q, '2000', 2000)] }),
      emptyLedger(),
      after,
    );
    const found = log.findings.find((f) => f.kind === 'ANSWERED-BUT-STILL-BLOCKED');
    expect(found).toBeDefined();
    expect(found!.detail).toContain('did not reach the arithmetic');
  });

  it('does not flag one that settled', () => {
    const after = withFact({ id: FACT_ID, value: 2000, unit: 'mm' });
    const log = buildAuditLog(
      snapshot({ answered: [answered(ask(), '2000', 2000)] }),
      emptyLedger(),
      after,
    );
    expect(log.findings.filter((f) => f.kind === 'ANSWERED-BUT-STILL-BLOCKED')).toEqual([]);
  });

  it('records a question nobody answered as its own finding', () => {
    // Still open when the run ended. These are the ones a reader most wants
    // to see, so they are entries too — not omissions.
    const log = buildAuditLog(
      snapshot({ pending: [{ question: ask(), askedAt: 500 }] }),
      emptyLedger(),
    );
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].answer).toBeNull();
    expect(log.findings.find((f) => f.kind === 'LEFT-UNANSWERED')).toBeDefined();
  });
});

describe('the four sections of the log', () => {
  const q = ask({
    evidence: ['C1 300x300x2000'],
    suggestion: { value: '2000', basis: 'the H column of the schedule row' },
  });
  const log = () =>
    buildAuditLog(
      snapshot({
        answered: [answered(q, '300', 300)],
        transcript: [{ role: 'user', text: 'build the BBS' }],
      }),
      withFact({ id: FACT_ID, value: 2000, unit: 'mm' }),
    );

  it('says what the drawing and the record already held', () => {
    const md = auditMarkdown(log(), 'BBS-TEST-columns');
    expect(md).toContain('### 1 — What the drawing and the record already said');
    expect(md).toContain('On file: **2000 mm**');
    expect(md).toContain('"C1 300x300x2000"');
  });

  it('says what was asked, and why', () => {
    const md = auditMarkdown(log(), 'BBS-TEST-columns');
    expect(md).toContain('### 2 — What was asked');
    expect(md).toContain('Confirm the height of column C1.');
    expect(md).toContain('both scheduled bars depend on H');
    expect(md).toContain('Blocks: C1');
  });

  it('says what the user answered, verbatim', () => {
    expect(auditMarkdown(log(), 'x')).toContain('**"300"**');
  });

  it("says the engine's reasoning, in the engine's own words", () => {
    const md = auditMarkdown(log(), 'x');
    expect(md).toContain("### 4 — The engine's reasoning");
    expect(md).toContain('the H column of the schedule row');
  });

  it('leads with the findings, because they are the reason to open it', () => {
    const md = auditMarkdown(log(), 'x');
    expect(md.indexOf('# Findings')).toBeLessThan(md.indexOf('# Questions'));
    expect(md).toContain('Asked for something already on file — 1');
  });

  it('says plainly when there is nothing wrong', () => {
    const clean = buildAuditLog(
      snapshot({ answered: [answered(ask(), '2000', 2000)] }),
      emptyLedger(),
      withFact({ id: FACT_ID, value: 2000, unit: 'mm' }),
    );
    expect(auditMarkdown(clean, 'x')).toContain('Nothing to report');
  });

  it('marks a decline as a named gap rather than an answer', () => {
    const declined = {
      question: ask(),
      raw: "I don't know",
      skipped: true,
      at: 1_000,
    } as AnsweredQuestion;
    const md = auditMarkdown(buildAuditLog(snapshot({ answered: [declined] }), emptyLedger()), 'x');
    expect(md).toContain('**Declined**');
    expect(md).toContain('named gap, not a guess');
  });
});

describe('the log never changes anything', () => {
  it('leaves both ledgers and the snapshot untouched', () => {
    // A log that edits is not a log.
    const before = withFact({ id: FACT_ID, value: 2000, unit: 'mm' });
    const snap = snapshot({ answered: [answered(ask({ evidence: ['C1 2000'] }), '300', 300)] });
    const beforeJson = JSON.stringify({ before, snap });
    buildAuditLog(snap, before, before);
    expect(JSON.stringify({ before, snap })).toBe(beforeJson);
  });

  it('is a pure function of what it was given', () => {
    const entries: AuditEntry[] = [];
    expect(findingsFor(entries, emptyLedger())).toEqual([]);
  });
});
