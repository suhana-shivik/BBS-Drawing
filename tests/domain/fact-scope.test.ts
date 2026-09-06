// ONE DRAWING'S SPECIFICATION SHOWS ONE DRAWING'S FACTS.
//
// The ledger is PROJECT-wide on purpose — one drawing's schedule can be
// blocked by a fact read off another. But a Specification listing every
// drawing's facts at once is not any one drawing's specification, and that is
// what a person opening a drawing is asking for.
//
// The bug: `Supplier.askedAbout` carries the drawing a question was raised on
// and NOTHING RECORDED IT. An answered fact reached the ledger with no
// `source` and no `lookedIn`, and `factOnDrawing` deliberately shows an
// unplaceable fact on every drawing — so opening a second drawing listed the
// first one's answers as if they were its own.
//
// The fix goes in `lookedIn`, never in `source`. That distinction is the whole
// of §7.1: `source` would claim the drawing SAYS this; `lookedIn` says only
// that this is where the question came up. A user's answer is not a reading of
// a sheet and must not be recorded as one.
import { describe, expect, it } from 'vitest';
import { factFromAnswer, namedGap, type Supplier } from '../../src/interview/facts';
import { factOnDrawing } from '../../src/facts/types';
import type { AnsweredQuestion } from '../../src/interview/session';
import type { AskableQuestion } from '../../src/cad/bbs/askFrom';

const COLUMNS = 'BBS-TEST-COLUMNS';
const FOUNDATIONS = 'PCD-IND-B300-S-803-R0';

const ask = (over: Partial<AskableQuestion> = {}): AskableQuestion =>
  ({
    id: 'q1',
    question: 'Confirm the height of column C1.',
    why: 'both scheduled bars depend on H',
    blocks: ['C1'],
    evidence: [],
    answerType: 'number-mm',
    writesTo: { memberMark: 'C1', field: 'H' },
    ...over,
  }) as AskableQuestion;

const answered = (q: AskableQuestion, raw: string, skipped = false): AnsweredQuestion =>
  ({ question: q, raw, ...(skipped ? {} : { patch: { mm: 300 } }), skipped, at: 1_000 }) as AnsweredQuestion;

const who = (drawingNumber?: string, revision = 'R0'): Supplier => ({
  suppliedBy: 'you',
  ...(drawingNumber ? { askedAbout: { drawingNumber, revision } as never } : {}),
});

// ---------------------------------------------------------------------------

describe('an answer belongs to the drawing it was asked on', () => {
  it('shows on that drawing', () => {
    const fact = factFromAnswer(answered(ask(), '300'), who(COLUMNS));
    expect(factOnDrawing(fact, COLUMNS)).toBe(true);
  });

  it('does NOT show on a different drawing', () => {
    // THE BUG, exactly as reported: open Foundations, and the Specification
    // listed C1.height and wall.total_run answered on the columns sheet.
    const fact = factFromAnswer(answered(ask(), '300'), who(COLUMNS));
    expect(factOnDrawing(fact, FOUNDATIONS)).toBe(false);
  });

  it('records it as CONTEXT, not as a reading of the sheet', () => {
    // §7.1 — the two kinds of evidence stay apart. A `source` here would say
    // the drawing states 300 mm. It does not; a person did.
    const fact = factFromAnswer(answered(ask(), '300'), who(COLUMNS));
    expect(fact.source).toBeUndefined();
    expect(fact.state).toBe('SUPPLIED');
    expect(fact.lookedIn?.[0]).toContain(COLUMNS);
    expect(fact.lookedIn?.[0]).toContain('open when this was asked');
  });

  it('still shows everywhere when nothing can place it', () => {
    // Case 3 of `factOnDrawing` is deliberate: hiding a fact nothing can place
    // makes it unreachable from every surface, and an open question nobody can
    // find is worse than one listed twice.
    const fact = factFromAnswer(answered(ask(), '300'), who());
    expect(factOnDrawing(fact, COLUMNS)).toBe(true);
    expect(factOnDrawing(fact, FOUNDATIONS)).toBe(true);
  });

  it('shows everywhere when no drawing is in scope at all', () => {
    const fact = factFromAnswer(answered(ask(), '300'), who(COLUMNS));
    expect(factOnDrawing(fact, '')).toBe(true);
  });
});

describe('a declined question is placed the same way', () => {
  it('puts the drawing FIRST, ahead of the evidence lines', () => {
    // `factOnDrawing` matches on the LEADING drawing number, and an evidence
    // line does not start with one — so a gap whose trail began with evidence
    // was unplaceable however much it knew.
    const gap = namedGap(
      answered(ask({ evidence: ['C1 300x300x2000'] }), "I don't know", true),
      who(COLUMNS),
    );
    expect(gap.state).toBe('MISSING');
    expect(gap.lookedIn?.[0]).toContain(COLUMNS);
    expect(gap.lookedIn).toContain('C1 300x300x2000'); // and the evidence survives
    expect(factOnDrawing(gap, COLUMNS)).toBe(true);
    expect(factOnDrawing(gap, FOUNDATIONS)).toBe(false);
  });

  it('keeps the "searched before asking" line when there was no evidence', () => {
    const gap = namedGap(answered(ask(), "I don't know", true), who(COLUMNS));
    expect(gap.lookedIn).toContain('the drawing was searched before asking');
  });
});
