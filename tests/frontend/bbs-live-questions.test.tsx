// ONE SUBMIT FOR EVERY OPEN QUESTION, AND THE IDS MUST BE CURRENT.
//
// The BBS run pauses mid-build to ask what the drawing cannot settle. Two
// things were wrong with that panel:
//
//   A "Continue" per card. A three-question pause was three round trips, and
//   each one re-rendered the list under the cursor while the run carried on.
//
//   And the ids it posted were stale. The seam that carries the open questions
//   is a `useMemo` whose deps did not include the interview's version counter —
//   which could not be listed, because the counter's VALUE was being discarded
//   (`const [, setBbsInterviewVersion]`). So the panel kept whichever batch was
//   open when some unrelated dependency last changed, the session settled those
//   ids, and every answer came back "no open question".
import React, { useMemo, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

afterEach(cleanup);

import { Dock } from '../../src/components/Dock';
import { StudioDataContext, type StudioData } from '../../src/studio/data';
import type { PendingQuestion } from '../../src/interview';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';

function question(id: string, q: string, options?: string[]): PendingQuestion {
  return {
    question: {
      id,
      question: q,
      why: 'the drawing does not say',
      blocks: ['C1'],
      answerType: 'number-mm',
      ...(options ? { options } : {}),
    },
  } as unknown as PendingQuestion;
}

function mount(pending: PendingQuestion[], answerQuestion: (id: string, raw: string) => unknown) {
  const store = new StudioStore();
  store.setDockTab('bbs');
  function Harness() {
    const [seen] = useState(pending);
    const data = useMemo<StudioData>(
      () => ({
        projectName: 'Live questions',
        groups: [],
        sheets: {},
        scheduleRows: [],
        scheduleVersion: 'v1',
        bbs: {
          blocked: null,
          running: true,
          progress: [],
          stats: null,
          error: null,
          run: () => undefined,
          answersSince: [],
          factsUsed: 0,
          lastCostLine: null,
          questionsFiled: 0,
          pendingQuestions: seen,
          answerQuestion: (id: string, raw: string) =>
            answerQuestion(id, raw) as never,
          skipQuestion: () => ({ ok: true }) as never,
        },
      }),
      [seen],
    );
    return (
      <StudioStoreContext.Provider value={store}>
        <StudioDataContext.Provider value={data}>
          <Dock />
        </StudioDataContext.Provider>
      </StudioStoreContext.Provider>
    );
  }
  render(<Harness />);
  return { store };
}

const boxes = () =>
  [...screen.getByTestId('bbs-live-questions').querySelectorAll('input')] as HTMLInputElement[];

describe('one submit for every open question', () => {
  const two = [question('q1', 'How tall is C1?'), question('q2', 'How many C1 columns?')];

  it('shows ONE submit, not a Continue per card', () => {
    mount(two, () => ({ ok: true }));
    expect(screen.getByTestId('bbs-live-submit-all').textContent).toContain('Submit all 2 answers');
    // the per-card Continue is gone; only "I don't know" remains beside each box
    expect(screen.queryByText('Continue')).toBeNull();
  });

  it('stays disabled until every box is filled', () => {
    mount(two, () => ({ ok: true }));
    const submit = screen.getByTestId('bbs-live-submit-all') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(boxes()[0], { target: { value: '2000' } });
    expect(submit.disabled).toBe(true); // one of two is not enough

    fireEvent.change(boxes()[1], { target: { value: '4' } });
    expect(submit.disabled).toBe(false);
  });

  it('posts every answer in one hit, each to its own question', () => {
    const answered: Array<[string, string]> = [];
    mount(two, (id, raw) => {
      answered.push([id, raw]);
      return { ok: true };
    });
    fireEvent.change(boxes()[0], { target: { value: '2000' } });
    fireEvent.change(boxes()[1], { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('bbs-live-submit-all'));

    expect(answered).toEqual([
      ['q1', '2000'],
      ['q2', '4'],
    ]);
  });

  it('Enter submits the whole set, not just the box it was pressed in', () => {
    // One question answered out of three restarted the run with the other two
    // still open — the failure the batch submit exists to prevent.
    const answered: string[] = [];
    mount(two, (id) => {
      answered.push(id);
      return { ok: true };
    });
    fireEvent.change(boxes()[0], { target: { value: '2000' } });
    fireEvent.keyDown(boxes()[0], { key: 'Enter' });
    expect(answered).toEqual([]); // not every box is filled yet

    fireEvent.change(boxes()[1], { target: { value: '4' } });
    fireEvent.keyDown(boxes()[0], { key: 'Enter' });
    expect(answered).toEqual(['q1', 'q2']);
  });

  it('surfaces a rejected answer against its own question', () => {
    // "no open question" was invisible before — the run simply carried on.
    mount(two, (id) => (id === 'q2' ? { ok: false, error: 'no open question "q2"' } : { ok: true }));
    fireEvent.change(boxes()[0], { target: { value: '2000' } });
    fireEvent.change(boxes()[1], { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('bbs-live-submit-all'));
    expect(screen.getByTestId('bbs-live-questions').textContent).toContain('no open question');
  });

  it('leaves a choice question to its own buttons', () => {
    // Clicking an option IS the answer; holding it back for a batch submit
    // would be the odd behaviour.
    const answered: string[] = [];
    mount([question('q1', 'Which grade?', ['Fe500', 'Fe550'])], (id) => {
      answered.push(id);
      return { ok: true };
    });
    expect(screen.queryByTestId('bbs-live-submit-all')).toBeNull();
    fireEvent.click(screen.getByText('Fe500'));
    expect(answered).toEqual(['q1']);
  });
});
