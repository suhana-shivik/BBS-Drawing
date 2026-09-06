// R6 — the command palette: Ctrl+K opens it, results come grouped by kind
// with the top hit selected (§6.2), and selecting any result NAVIGATES —
// never merely filters (§6.4). A fake index; the real ranking has its own
// domain tests (search-ranking.test.ts).

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { StudioShell } from '../../src/components/StudioShell';
import type { SearchHit } from '../../src/search/types';
import { demoStudioData } from '../../src/studio/demoData';
import { StudioDataContext, type StudioData } from '../../src/studio/data';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';

afterEach(cleanup);

const HITS: SearchHit[] = [
  {
    kind: 'mark',
    text: 'C1',
    documentId: 'd1',
    handles: ['H1', 'H2'],
    score: 1090,
    matchedOn: 'mark',
    snippet: 'C1',
  },
  {
    kind: 'drawing',
    documentId: 'd1',
    fileName: 'GW-01 BOUNDARY WALL R1.dxf',
    drawingNumber: 'GW-01',
    revision: 'R1',
    superseded: false,
    score: 890,
    matchedOn: 'drawingNumber',
    snippet: 'GW-01',
  },
  {
    kind: 'section',
    sectionId: 'REGION-12',
    label: 'C/S OF TB-(350X400)',
    parentDocumentId: 'd1',
    bounds: { xMin: 0, yMin: 0, xMax: 1000, yMax: 800 },
    score: 690,
    matchedOn: 'label',
    snippet: 'C/S OF TB-(350X400)',
  },
  {
    kind: 'fact',
    factId: 'wall.total_run',
    state: 'SUPPLIED',
    score: 490,
    matchedOn: 'factKey',
    snippet: 'wall.total_run',
  },
];

function mount(goTo?: (hit: SearchHit) => void) {
  const store = new StudioStore();
  store.openProject('proj-a');
  const goToFn = vi.fn<(hit: SearchHit) => void>(goTo);
  const data: StudioData = {
    ...demoStudioData,
    search: {
      query: (q: string) => (q.trim() ? HITS : []),
      goTo: goToFn,
    },
  };
  render(
    <StudioStoreContext.Provider value={store}>
      <StudioDataContext.Provider value={data}>
        <StudioShell />
      </StudioDataContext.Provider>
    </StudioStoreContext.Provider>,
  );
  return { store, goTo: goToFn };
}

function openAndType(query: string) {
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  const input = screen.getByLabelText('Search the project');
  fireEvent.change(input, { target: { value: query } });
  return input;
}

describe('command palette (R6)', () => {
  it('Ctrl+K opens it; Escape closes it', async () => {
    const { store } = mount();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(store.getState().ui.paletteOpen).toBe(true);
    await waitFor(() => screen.getByTestId('command-palette'));
    fireEvent.keyDown(screen.getByLabelText('Search the project'), { key: 'Escape' });
    expect(store.getState().ui.paletteOpen).toBe(false);
  });

  it('returns all four kinds, grouped, with the top hit selected', async () => {
    mount();
    openAndType('c1');
    const palette = screen.getByTestId('command-palette');
    await waitFor(() => {
      expect(within(palette).getByText('Marks & callouts')).toBeTruthy();
    });
    expect(within(palette).getByText('Drawings')).toBeTruthy();
    expect(within(palette).getByText('Sections')).toBeTruthy();
    expect(within(palette).getByText('Facts')).toBeTruthy();
    // top hit (the exact mark match) starts selected
    const selected = palette.querySelector('[data-selected="true"]');
    expect(selected?.textContent).toContain('C1');
  });

  it('Enter navigates to the selected (top) hit and closes', async () => {
    const { store, goTo } = mount();
    const input = openAndType('c1');
    await waitFor(() => screen.getByText('Marks & callouts'));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(goTo).toHaveBeenCalledTimes(1);
    expect(goTo.mock.calls[0][0]).toMatchObject({ kind: 'mark', text: 'C1' });
    expect(store.getState().ui.paletteOpen).toBe(false);
  });

  it('every kind of result navigates on click — drawing, section, fact, mark', async () => {
    const { goTo } = mount();
    for (const [label, expected] of [
      ['GW-01 BOUNDARY WALL R1.dxf', { kind: 'drawing', documentId: 'd1' }],
      ['REGION-12 · C/S OF TB-(350X400)', { kind: 'section', sectionId: 'REGION-12' }],
      ['wall.total_run supplied', { kind: 'fact', factId: 'wall.total_run' }],
      ['C1 mark', { kind: 'mark', text: 'C1' }],
    ] as const) {
      const input = openAndType('anything');
      await waitFor(() => screen.getByText('Marks & callouts'));
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(goTo.mock.calls[goTo.mock.calls.length - 1][0]).toMatchObject(expected);
      // palette closed itself; reset for the next kind
      expect(screen.queryByTestId('command-palette')).toBeNull();
      void input;
    }
  });

  it('a fact hit is a location: goTo lands the shell on the Specification, scrolled to the fact', async () => {
    // the realData goTo for a fact calls store.revealFact — emulate that here
    // and assert the shell actually swaps its stage (§6.4: navigate, not filter)
    const captured: { store?: StudioStore } = {};
    const { store } = mount((hit) => {
      if (hit.kind === 'fact') captured.store?.revealFact(hit.factId);
    });
    captured.store = store;
    openAndType('total_run');
    await waitFor(() => screen.getByText('Facts'));
    fireEvent.click(screen.getByRole('button', { name: 'wall.total_run supplied' }));
    expect(store.getState().ui.stageMode).toBe('spec');
    await waitFor(() => {
      expect(screen.getByTestId('spec-view')).toBeTruthy();
    });
  });
});
