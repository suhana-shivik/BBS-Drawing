// ONE FACT, ONE QUESTION.
//
// The bug this pins: nine footings each failed the extent gate, each minted a
// question with its own id — extent:F1:run, extent:F2:run, … — and all nine
// asked the identical thing and wrote to the identical fact,
// `wall.total_run`. Every dedupe in the path keyed on the ID, so the Ask panel
// showed the same question nine times and offered to "Submit all 9 answers".
//
// Identity is the DEPENDENCY: the fact the answer lands in. These tests hold
// that at all three levels it has to be true at — generation, the interview
// queue, and after an answer — because fixing only one of them leaves the
// duplicates arriving by another road.
import { describe, expect, it } from 'vitest';
import {
  countQuestion,
  coverQuestion,
  dedupeByDependency,
  dependencyKeyOf,
  dependencyOf,
  questionFrom,
  questionsFrom,
  type AskableQuestion,
} from '../../src/cad/bbs/askFrom';
import { factIdForQuestion } from '../../src/interview/facts';
import { InterviewSession } from '../../src/interview/session';
import type { VerificationFailure } from '../../src/cad/bbs/verify';

const failure = (over: Partial<VerificationFailure>): VerificationFailure =>
  ({ gate: 'extent', message: 'no run was supplied', ...over }) as VerificationFailure;

describe('the dependency key', () => {
  it('is the fact the answer lands in, and drops the member for a whole-structure fact', () => {
    // The run belongs to the STRUCTURE. Whichever member's gate noticed it was
    // missing is not part of its identity — that was the bug.
    expect(dependencyKeyOf({ memberMark: 'F1', field: 'run' })).toBe('wall.total_run');
    expect(dependencyKeyOf({ memberMark: 'F9', field: 'run' })).toBe('wall.total_run');
    expect(dependencyKeyOf({ field: 'run' })).toBe('wall.total_run');
  });

  it('keeps the member for a fact that belongs to one', () => {
    expect(dependencyKeyOf({ memberMark: 'F1', field: 'L' })).toBe('F1.length');
    expect(dependencyKeyOf({ memberMark: 'F1', field: 'W' })).toBe('F1.width');
    expect(dependencyKeyOf({ memberMark: 'PB03', field: 'H' })).toBe('PB03.height');
    expect(dependencyKeyOf({ memberMark: 'PB03', field: 'depth' })).toBe('PB03.height');
    expect(dependencyKeyOf({ memberMark: 'C12', field: 'count' })).toBe('C12.count');
  });

  it('is project-wide for a project-wide setting', () => {
    expect(dependencyKeyOf({ field: 'cover' })).toBe('settings.cover');
  });

  it('is the SAME string the answer is recorded under — one definition, no drift', () => {
    const questions: AskableQuestion[] = [
      questionFrom(failure({ memberMark: 'F1', field: 'run' })),
      questionFrom(failure({ gate: 'completeness', memberMark: 'F8', field: 'L' })),
      countQuestion('F8'),
      coverQuestion(50),
    ];
    for (const q of questions) expect(dependencyOf(q)).toBe(factIdForQuestion(q));
  });

  it('is stamped on every question at the moment it is minted', () => {
    expect(questionFrom(failure({ memberMark: 'F3', field: 'run' })).dependencyKey).toBe('wall.total_run');
    expect(countQuestion('F5').dependencyKey).toBe('F5.count');
    expect(coverQuestion(50).dependencyKey).toBe('settings.cover');
  });
});

describe('requirement 8 — four rows blocked on one fact ask ONE question', () => {
  it('collapses the run question however many members raise it', () => {
    // Exactly the shape that shipped the bug: one gate, four members, one fact.
    const failures = ['F1', 'F2', 'F3', 'F8'].map((memberMark) =>
      failure({ memberMark, field: 'run' }),
    );
    const questions = questionsFrom(failures, new Map(), { max: 20 });

    expect(questions).toHaveLength(1);
    expect(dependencyOf(questions[0])).toBe('wall.total_run');
    expect(questions[0].question).toMatch(/total run/i);
  });

  it('collapses them in the interview queue too, and every asker gets the one answer', async () => {
    const session = new InterviewSession();
    const asks = ['F1', 'F2', 'F3', 'F8'].map((memberMark) =>
      session.askUser(questionFrom(failure({ memberMark, field: 'run' }))),
    );

    // ONE card on screen, not four — and therefore "Submit all 1 answer".
    expect(session.pending()).toHaveLength(1);
    expect(session.snapshot().questionsAsked).toBe(1);

    const card = session.pending()[0].question;
    expect(session.answer(card.id, '160').ok).toBe(true);

    // all four rows that were waiting get the same answer
    await expect(Promise.all(asks)).resolves.toEqual(['160', '160', '160', '160']);
    expect(session.pending()).toHaveLength(0);
  });

  it('collapses a batch put in one pass', async () => {
    const session = new InterviewSession();
    const questions = ['F1', 'F2', 'F3', 'F8'].map((memberMark) =>
      questionFrom(failure({ memberMark, field: 'run' })),
    );
    const batch = session.askBatch(questions);

    expect(session.pending()).toHaveLength(1);
    session.answer(session.pending()[0].question.id, '160');
    await expect(batch).resolves.toEqual(['160', '160', '160', '160']);
  });

  it('does NOT collapse questions that are genuinely different', () => {
    const questions = questionsFrom(
      [
        failure({ gate: 'completeness', memberMark: 'F1', field: 'L' }),
        failure({ gate: 'completeness', memberMark: 'F2', field: 'L' }),
        failure({ gate: 'completeness', memberMark: 'F1', field: 'W' }),
        failure({ memberMark: 'F1', field: 'run' }),
      ],
      new Map(),
      { max: 20 },
    );
    expect(questions.map(dependencyOf).sort()).toEqual([
      'F1.length',
      'F1.width',
      'F2.length',
      'wall.total_run',
    ]);
  });
});

describe('requirement 9 — an answered dependency is never asked again', () => {
  it('hands back the recorded answer instead of putting a second card up', async () => {
    const session = new InterviewSession();
    const first = session.askUser(questionFrom(failure({ memberMark: 'F1', field: 'run' })));
    session.answer(session.pending()[0].question.id, '160');
    await expect(first).resolves.toBe('160');
    expect(session.pending()).toHaveLength(0);

    // A rebuild rediscovers the same hole from a different member. It must not
    // reach the person: the answer is already on the record.
    const again = await session.askUser(questionFrom(failure({ memberMark: 'F9', field: 'run' })));
    expect(again).toBe('160');
    expect(session.pending()).toHaveLength(0);
    expect(session.snapshot().questionsAsked).toBe(1);
  });

  it('a declined dependency is also settled — it is not asked again either', async () => {
    const session = new InterviewSession();
    const first = session.askUser(coverQuestion(50));
    session.skip(session.pending()[0].question.id, 'skip');
    await expect(first).resolves.toBeNull();

    await expect(session.askUser(coverQuestion(50))).resolves.toBeNull();
    expect(session.pending()).toHaveLength(0);
    expect(session.snapshot().questionsAsked).toBe(1);
  });

  it('generation skips a dependency already asked in an earlier round', () => {
    const asked = new Set(['wall.total_run']);
    const questions = questionsFrom(
      [failure({ memberMark: 'F4', field: 'run' }), failure({ gate: 'completeness', memberMark: 'F4', field: 'L' })],
      new Map(),
      { max: 20, alreadyAsked: asked },
    );
    expect(questions.map(dependencyOf)).toEqual(['F4.length']);
  });
});

describe('requirement 7 — rebuilds are idempotent', () => {
  it('generating ten times over the same failures yields the same one question', () => {
    const failures = ['F1', 'F2', 'F3', 'F8', 'F9'].map((memberMark) => failure({ memberMark, field: 'run' }));
    const runs = Array.from({ length: 10 }, () => questionsFrom(failures, new Map(), { max: 20 }));
    for (const questions of runs) {
      expect(questions).toHaveLength(1);
      expect(dependencyOf(questions[0])).toBe('wall.total_run');
    }
  });

  it('asking ten times over the same session never adds a card', async () => {
    const session = new InterviewSession();
    const asks = Array.from({ length: 10 }, (_, i) =>
      session.askUser(questionFrom(failure({ memberMark: `F${i + 1}`, field: 'run' }))),
    );
    expect(session.pending()).toHaveLength(1);
    session.answer(session.pending()[0].question.id, '160');
    const answers = await Promise.all(asks);
    expect(new Set(answers)).toEqual(new Set(['160']));
  });
});

describe('dedupeByDependency', () => {
  it('keeps the first of each dependency, in order', () => {
    const a = questionFrom(failure({ memberMark: 'F1', field: 'run' }));
    const b = questionFrom(failure({ memberMark: 'F2', field: 'run' }));
    const c = questionFrom(failure({ gate: 'completeness', memberMark: 'F1', field: 'L' }));
    expect(dedupeByDependency([a, b, c]).map((q) => q.id)).toEqual([a.id, c.id]);
  });

  it('honours an already-asked set', () => {
    const a = questionFrom(failure({ memberMark: 'F1', field: 'run' }));
    expect(dedupeByDependency([a], new Set(['wall.total_run']))).toEqual([]);
  });
});
