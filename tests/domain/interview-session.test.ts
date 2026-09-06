import { describe, expect, it, vi } from 'vitest';
import type { AskableQuestion } from '../../src/cad/bbs/askFrom';
import { InterviewSession, askUserOf, orderQuestions } from '../../src/interview/session';

const question = (over: Partial<AskableQuestion> = {}): AskableQuestion => ({
  id: 'dimension:C1:H',
  question: "What is C1's height?",
  why: 'the vertical bars are cut to it and no dimension on the sheet spans the column',
  blocks: ['C1'],
  evidence: ['DIM-017 — would give 350 mm', 'DIM-021 — rejected: it measures the section'],
  answerType: 'number-mm',
  writesTo: { memberMark: 'C1', field: 'H' },
  ...over,
});

describe('the interview session — the state machine', () => {
  it('walks idle → running → awaiting-answer → running, and answers resolve the engine', async () => {
    const session = new InterviewSession();
    expect(session.state).toBe('idle');

    const pending = session.askUser(question());
    expect(session.state).toBe('awaiting-answer');
    expect(session.pending()).toHaveLength(1);

    const outcome = session.answer('dimension:C1:H', '1200');
    expect(outcome.ok).toBe(true);
    await expect(pending).resolves.toBe('1200');
    expect(session.state).toBe('running');
    expect(session.pending()).toHaveLength(0);

    session.publish('ask-1#v1');
    expect(session.state).toBe('published');
  });

  it('ABANDONING RESOLVES EVERY PENDING QUESTION — a run finishes rather than hanging', async () => {
    const session = new InterviewSession();
    const a = session.askUser(question());
    const b = session.askUser(question({ id: 'dimension:F1:H', writesTo: { memberMark: 'F1', field: 'H' } }));

    session.abandon('the drawing was closed');

    await expect(a).resolves.toBeNull();
    await expect(b).resolves.toBeNull();
    expect(session.state).toBe('abandoned');
    expect(session.snapshot().stoppedBecause).toBe('the drawing was closed');

    // and nothing may reopen it: a later question resolves at once
    await expect(session.askUser(question({ id: 'dimension:TB:L' }))).resolves.toBeNull();
  });

  it('failing also resolves what was open, so the loop never waits on a dead run', async () => {
    const session = new InterviewSession();
    const open = session.askUser(question());
    session.fail('the model could not be reached');
    await expect(open).resolves.toBeNull();
    expect(session.state).toBe('failed');
  });

  it('is bounded — past the cap a question resolves null instead of nagging', async () => {
    // Three DIFFERENT questions — different dependencies, not merely different
    // ids. The queue is unique by the fact a question writes to, so three
    // cards for one fact would (correctly) collapse to one and never reach
    // the cap.
    const session = new InterviewSession({ maxQuestions: 2 });
    session.askUser(question({ id: 'q1', writesTo: { memberMark: 'C1', field: 'H' } }));
    session.askUser(question({ id: 'q2', writesTo: { memberMark: 'C2', field: 'H' } }));

    const third = session.askUser(question({ id: 'q3', writesTo: { memberMark: 'C3', field: 'H' } }));
    await expect(third).resolves.toBeNull();
    expect(session.pending().map((p) => p.question.id)).toEqual(['q1', 'q2']);
    expect(session.snapshot().questionsRemaining).toBe(0);
  });

  it('batches a pass and orders it by how many rows each question unblocks (§7.4)', async () => {
    const session = new InterviewSession();
    const one = question({ id: 'one', blocks: ['C1'], writesTo: { memberMark: 'C1', field: 'H' } });
    const six = question({
      id: 'six',
      blocks: ['F1', 'F2', 'F3', 'C1', 'C2', 'TB'],
      writesTo: { memberMark: 'F1', field: 'H' },
    });
    const three = question({
      id: 'three',
      blocks: ['W1', 'W2', 'W3'],
      writesTo: { memberMark: 'W1', field: 'H' },
    });

    const batch = session.askBatch([one, six, three]);

    // all three are on screen at once — never drip-fed one per turn
    expect(session.pending()).toHaveLength(3);
    expect(session.pending().map((p) => p.question.id)).toEqual(['six', 'three', 'one']);

    session.answer('six', '900');
    session.skip('three');
    session.answer('one', '1200');
    // answers keep the CALLER's order, not the display order
    await expect(batch).resolves.toEqual(['1200', '900', null]);
  });

  it('orderQuestions is stable where two questions unblock the same number of rows', () => {
    const a = question({ id: 'a', blocks: ['X'] });
    const b = question({ id: 'b', blocks: ['Y'] });
    expect(orderQuestions([a, b]).map((q) => q.id)).toEqual(['a', 'b']);
    expect(orderQuestions([b, a]).map((q) => q.id)).toEqual(['b', 'a']);
  });

  it('never asks an answered question twice — the stable id carries the answer', async () => {
    const session = new InterviewSession();
    const first = session.askUser(question());
    session.answer('dimension:C1:H', '1200 mm');
    await expect(first).resolves.toBe('1200 mm');

    const again = session.askUser(question());
    await expect(again).resolves.toBe('1200 mm');
    expect(session.pending()).toHaveLength(0);
    expect(session.snapshot().questionsAsked).toBe(1);
  });

  it('rejects prose with an error and LEAVES THE QUESTION OPEN — never a coerced number', () => {
    const session = new InterviewSession();
    session.askUser(question());

    const outcome = session.answer('dimension:C1:H', 'a bit taller than the other one');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/carries no number/i);
    expect(session.pending()).toHaveLength(1);
    expect(session.state).toBe('awaiting-answer');

    // and an impossible measurement is refused at the door too
    const misclick = session.answer('dimension:C1:H', '1');
    expect(misclick.ok).toBe(false);
    expect(session.pending()).toHaveLength(1);
  });

  it('treats a decline as a first-class answer: null to the engine, recorded as skipped', async () => {
    const session = new InterviewSession();
    const open = session.askUser(question());

    const outcome = session.answer('dimension:C1:H', "I don't know");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.answered.skipped).toBe(true);
    await expect(open).resolves.toBeNull();
    expect(session.answers()[0].raw).toBe("I don't know");
  });

  it('keeps the transcript verbatim — what §7.1 traces every relayed fact against', () => {
    const session = new InterviewSession();
    session.say('user', 'give me the BBS for the tie beam');
    session.askUser(question());
    session.answer('dimension:C1:H', '1200');

    const texts = session.transcript.map((l) => `${l.role}: ${l.text}`);
    expect(texts).toContain('user: give me the BBS for the tie beam');
    expect(texts).toContain("assistant: What is C1's height?");
    expect(texts).toContain('user: 1200');
  });

  it('notifies subscribers and unsubscribes cleanly', () => {
    const session = new InterviewSession();
    const seen = vi.fn();
    const stop = session.subscribe(seen);
    session.askUser(question());
    expect(seen).toHaveBeenCalled();
    stop();
    const calls = seen.mock.calls.length;
    session.abandon();
    expect(seen.mock.calls.length).toBe(calls);
  });

  it('askUserOf is exactly the seam the engine awaits', async () => {
    const session = new InterviewSession();
    const askUser = askUserOf(session);
    const waiting = askUser(question());
    session.answer('dimension:C1:H', '1200');
    await expect(waiting).resolves.toBe('1200');
  });
});
