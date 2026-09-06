// Dock tab strip: Details · Ask on the left, the strip's own business —
// Library, Specification, Log — right-aligned after Ask (STUDIO_DESIGN §4.1
// trim). Ask keeps only the two calculation shortcuts; a drafting tool or a
// BBS run's escalations are reached from the side tabs, not from inside Ask.

import { afterEach, describe, expect, it } from 'vitest';
import { InterviewSession } from '../../src/interview';
import {
  askRunState,
  endAskRun,
  patchAskRun,
  resetAskRunForTest,
  setAskThread,
} from '../../src/studio/askRun';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StudioShell } from '../../src/components/StudioShell';
import { StudioDataContext, type StudioData } from '../../src/studio/data';
import { demoStudioData } from '../../src/studio/demoData';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';

// The Ask run is a MODULE store now — it survives unmount on purpose, which
// is the whole point of it — so a test has to end it deliberately, the same
// way the app does when a project closes.
afterEach(() => {
  cleanup();
  resetAskRunForTest();
});

// The demo data wires no ask/chat seam, so Ask renders its "not connected"
// void — enough for most tests, but not for asserting what its chips are.
const data: StudioData = {
  ...demoStudioData,
  ask: { blocked: null, ask: async () => 'noted' },
  chat: {
    blocked: null,
    running: false,
    start: async () => {
      throw new Error('not exercised in this test');
    },
    adaptRows: () => [],
    recordAnswers: async () => [],
    logInterview: async () => undefined,
    provenance: () => ({}),
  },
};

function mount() {
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
}

describe('the dock tab strip with a drawing open', () => {
  it('shows Details and Ask as the primary tabs, and three utilities to their right', () => {
    mount();
    const primary = screen.getAllByRole('tab', { name: /^(Details|Ask)$/ });
    expect(primary.map((t) => t.textContent)).toEqual(['Details', 'Ask']);
    for (const name of ['Library', 'Specification', 'Log']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
  });

  it('Ask carries only the two calculation shortcuts — no Library or About chip', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Ask' }));
    expect(screen.getByRole('button', { name: /Calculate BBS/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Calculate quantities/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Library$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /About drawing/ })).not.toBeInTheDocument();
  });

  it('Library, Specification and Log each open their own panel, not a drawer inside Ask', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Library' }));
    expect(screen.getByTestId('library-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('ask-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Specification' }));
    expect(screen.getByTestId('memory-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Log' }));
    expect(screen.getByTestId('log-panel')).toBeInTheDocument();
  });
});

describe('a BBS run survives navigating away from the Ask panel', () => {
  // THE BUG THIS REPLACES. `AskPanel` is rendered conditionally, so it unmounts
  // the moment you open Details, Library, Specification or Log — and its
  // unmount effect ABANDONED the session and ABORTED the request:
  //
  //     sessionRef.current?.abandon('the chat panel was closed');
  //     requestRef.current?.abort('the chat panel was closed');
  //
  // A run minutes and eight questions deep was destroyed by clicking a tab to
  // look at the drawing it was asking about. A run is work in flight, not view
  // state, so it lives in a module store and the panel is a window onto it.
  it('keeps the session alive when the panel unmounts', () => {
    const session = new InterviewSession();
    session.start();
    patchAskRun({ session, busy: true, startedAt: Date.now() });

    // the panel goes away, as it does on every tab switch
    cleanup();

    expect(askRunState().session).toBe(session);
    expect(askRunState().session!.snapshot().state).not.toBe('abandoned');
    expect(askRunState().busy).toBe(true);
  });

  it('keeps the conversation, so the answers you gave are still there', () => {
    setAskThread([{ id: '1', role: 'you', text: 'build the BBS' }]);
    cleanup();
    expect(askRunState<{ text: string }>().thread.map((m) => m.text)).toEqual(['build the BBS']);
  });

  it('does NOT abort the request in flight', () => {
    const controller = new AbortController();
    patchAskRun({ controller });
    cleanup();
    expect(controller.signal.aborted).toBe(false);
  });

  it('ends the run when somebody actually decides to', () => {
    // Abandoning is an ACT — a new run, or the project closing. The distinction
    // is the whole fix: navigating is not a decision about the run.
    const session = new InterviewSession();
    session.start();
    const controller = new AbortController();
    patchAskRun({ session, controller, busy: true });

    endAskRun('a new BBS request was started');

    expect(session.snapshot().state).toBe('abandoned');
    expect(controller.signal.aborted).toBe(true);
    expect(askRunState().busy).toBe(false);
    expect(askRunState().session).toBeNull();
  });
});
