// Ask's interview flow — when the engine cannot proceed without a fact, it
// asks in the chat (InterviewSession) rather than failing the run. §7.4
// batches every question raised together (interview/session.ts, rule 3); this
// covers the UI side of that promise: several questions on screen at once,
// answered with one Submit rather than a "Continue" per question, and a photo
// travelling with an answer as evidence.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAskRunForTest } from '../../src/studio/askRun';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AskableQuestion } from '../../src/cad/bbs/askFrom';
import type { BbsChatResult, BbsChatRow } from '../../src/cad/bbs/chatResult';
import { StudioShell } from '../../src/components/StudioShell';
import { StudioDataContext, type StudioData } from '../../src/studio/data';
import { demoStudioData } from '../../src/studio/demoData';
import { InterviewSession } from '../../src/interview';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';

// The Ask run is a MODULE store now — it survives unmount on purpose, which
// is the whole point of it — so a test has to end it deliberately, the same
// way the app does when a project closes.
afterEach(() => {
  cleanup();
  resetAskRunForTest();
});

const row = (): BbsChatRow =>
  ({
    id: 'TB-M1', barMark: 'TB-M1', memberMark: 'TB', description: 'main T16',
    diameterMm: 16, barsPerMember: 4, memberCount: 1, totalBars: 4,
    cuttingLengthMm: 6000, totalLengthM: 24, unitWeightKgPerM: 1.58,
    totalWeightKg: 38, working: [], evidenceIds: [], status: 'verified',
  }) as BbsChatRow;

const result = (): BbsChatResult =>
  ({
    id: 'engine-run', status: 'complete', project: { drawingName: 'GAMCO-STR-001' },
    members: [], rows: [row()], diameterSummary: [], netWeightKg: 38,
    assumptions: [], warnings: [], gaps: [], extentClaims: [],
    verification: { passed: [], failures: [], ok: true },
  }) as unknown as BbsChatResult;

const question = (id: string, text: string): AskableQuestion => ({
  id,
  question: text,
  why: 'needed to compute the cutting length',
  blocks: ['TB'],
  evidence: [],
  answerType: 'number-mm',
  writesTo: { memberMark: 'TB', field: id },
});

function mount() {
  // The engine raises two questions in one pass and awaits both without
  // resolving either first — exactly rule 3's "registered together".
  let capture: { cover?: string; run?: string } = {};
  const data: StudioData = {
    ...demoStudioData,
    ask: { blocked: null, ask: async () => 'noted' },
    chat: {
      blocked: null,
      running: false,
      start: async ({ session }) => {
        const s = session as InterviewSession;
        const [cover, run] = await Promise.all([
          s.askUser(question('cover', 'What cover does the tie beam use?')),
          s.askUser(question('run', 'What is the tie beam run length?')),
        ]);
        capture = { cover: cover ?? undefined, run: run ?? undefined };
        return { result: result() };
      },
      adaptRows: () => [],
      recordAnswers: async () => [],
    logInterview: async () => undefined,
      provenance: () => ({}),
    },
  };
  const store = new StudioStore();
  store.openProject('proj-gamco');
  store.openSheet('gamco');
  render(
    <StudioStoreContext.Provider value={store}>
      <StudioDataContext.Provider value={data}>
        <StudioShell />
      </StudioDataContext.Provider>
    </StudioStoreContext.Provider>,
  );
  fireEvent.click(screen.getByTestId('toggle-assistant'));
  fireEvent.click(screen.getByRole('tab', { name: 'Ask' }));
  return { getCapture: () => capture };
}

describe('several missing facts, asked together', () => {
  it('shows both questions at once with no per-question Continue button', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Calculate BBS/ }));
    fireEvent.click(screen.getByLabelText('Send'));

    await waitFor(() => screen.getByTestId('chat-questions'));
    expect(screen.getByTestId('chat-question-cover')).toBeInTheDocument();
    expect(screen.getByTestId('chat-question-run')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit all 2 answers/ })).toBeDisabled();
  });

  it('submits every filled answer with one press, once all of them are filled', async () => {
    const { getCapture } = mount();
    fireEvent.click(screen.getByRole('button', { name: /Calculate BBS/ }));
    fireEvent.click(screen.getByLabelText('Send'));
    await waitFor(() => screen.getByTestId('chat-questions'));

    const submit = screen.getByRole('button', { name: /Submit all 2 answers/ });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('What cover does the tie beam use?'), { target: { value: '25' } });
    expect(submit).toBeDisabled(); // one of the two still empty

    fireEvent.change(screen.getByLabelText('What is the tie beam run length?'), { target: { value: '6000' } });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByTestId('chat-questions')).not.toBeInTheDocument());
    expect(getCapture()).toEqual({ cover: '25', run: '6000' });
    await waitFor(() => screen.getByTestId('bbs-chat-artifact'));
  });

  it('a photo attached to one answer travels with it as evidence, not in place of the typed value', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Calculate BBS/ }));
    fireEvent.click(screen.getByLabelText('Send'));
    await waitFor(() => screen.getByTestId('chat-questions'));

    const coverRow = screen.getByTestId('chat-question-cover');
    const file = new File(['x'], 'nameplate.png', { type: 'image/png' });
    const picker = screen.getByLabelText('Choose a photo for this answer') as HTMLInputElement;
    fireEvent.click(within(coverRow).getByLabelText('Attach a photo to this answer'));
    fireEvent.change(picker, { target: { files: [file] } });

    await waitFor(() => within(coverRow).getByText('nameplate.png'));
    // still needs the typed value — the image is evidence, not an answer on its own
    expect(screen.getByRole('button', { name: /Submit all 2 answers/ })).toBeDisabled();
  });
});
