// The Specification is READ PER DRAWING.
//
// It rendered the whole project ledger on every visit, so opening one drawing
// and asking for its specification answered with every drawing's facts and
// every project-wide open question interleaved — 13 facts and 12 open
// questions under a heading naming one drawing, none of which said which
// drawing they belonged to.
//
// The open-question half was the worse half, and it had a cause: the scope
// filter was `f.source?.drawingNumber === num || !isUsable(f)`, and a MISSING
// fact is never usable — so every gap in the project passed the filter for
// every drawing. Gaps now carry the source of the run that raised them, and
// one predicate (`factOnDrawing`) decides for both surfaces.

import React, { useMemo, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { SpecificationView } from '../../src/components/SpecificationView';
import { addFact, emptyLedger, type Ledger } from '../../src/facts/ledger';
import { factOnDrawing, type Fact } from '../../src/facts/types';
import { StudioDataContext, type StudioData, type StudioSheet } from '../../src/studio/data';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';

afterEach(cleanup);

function sheet(id: string, number: string, extra: Partial<StudioSheet> = {}): StudioSheet {
  return {
    id,
    tab: `${number}.dxf`,
    title: number,
    number,
    rev: 'R1',
    discipline: 'Structural',
    entities: 100,
    grounded: false,
    issues: 0,
    hasModel: false,
    panels: [],
    model: { widthUnits: 100, heightUnits: 100, mmPerUnit: 1, x0Mm: 0, y0Mm: 0 },
    svg: '<svg/>',
    ...extra,
  };
}

/** Two drawings, each with a fact of its own and a gap of its own. */
function twoDrawings(): Ledger {
  let l = emptyLedger();
  l = addFact(l, {
    id: 'F1.width',
    value: 1200,
    unit: 'mm',
    state: 'DECLARED',
    source: { drawingNumber: 'FOUND-01', revision: 'R1' },
    readOn: '2026-09-01',
  });
  l = addFact(l, {
    id: 'F1.cover',
    value: null,
    state: 'MISSING',
    ask: 'What cover applies to F1?',
    neededFor: ['F1 row F1-M1'],
    source: { drawingNumber: 'FOUND-01', revision: 'R1' },
    readOn: '2026-09-01',
  });
  l = addFact(l, {
    id: 'C1.section',
    value: '300x300',
    state: 'DECLARED',
    source: { drawingNumber: 'COL-02', revision: 'R1' },
    readOn: '2026-09-01',
  });
  l = addFact(l, {
    id: 'C1.laps',
    value: null,
    state: 'MISSING',
    ask: 'What lap length applies to C1?',
    neededFor: ['C1 row C1-M1'],
    source: { drawingNumber: 'COL-02', revision: 'R1' },
    readOn: '2026-09-01',
  });
  return l;
}

function mount(ledger: Ledger, activeSheetId: string | null) {
  const store = new StudioStore();
  if (activeSheetId) store.openSheet(activeSheetId);

  function Harness() {
    const [l] = useState(ledger);
    const data = useMemo<StudioData>(
      () => ({
        projectName: 'Scope Harness',
        groups: [],
        sheets: {
          'sheet-found': sheet('sheet-found', 'FOUND-01'),
          'sheet-col': sheet('sheet-col', 'COL-02'),
          'sheet-section': sheet('sheet-section', 'SEC-01', {
            section: {
              sectionId: 'REGION-03',
              label: 'Footing detail',
              kind: 'detail',
              memberHints: [],
              calloutHints: [],
              bounds: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
              widthMm: 1,
              heightMm: 1,
              entityCount: 1,
              evidenceIds: [],
              confidence: 1,
              limitations: [],
              orchestratorStep: 0,
              parentSheetId: 'sheet-found',
              parentName: 'FOUND-01',
            },
          }),
        },
        scheduleRows: [],
        scheduleVersion: '—',
        facts: {
          loaded: true,
          ledger: l,
          answer: vi.fn(),
          override: vi.fn(),
          withdraw: vi.fn(),
          open: vi.fn(),
          exportCsv: vi.fn(),
        },
        revision: { latest: null, showReport: false, dismissReport: () => undefined },
      }),
      [l],
    );
    return (
      <StudioStoreContext.Provider value={store}>
        <StudioDataContext.Provider value={data}>
          <SpecificationView />
        </StudioDataContext.Provider>
      </StudioStoreContext.Provider>
    );
  }
  render(<Harness />);
  return store;
}

describe('the specification is scoped to the open drawing', () => {
  it('shows this drawing’s facts and gaps, and not the other drawing’s', () => {
    mount(twoDrawings(), 'sheet-found');

    expect(screen.getByTestId('fact-F1.width')).toBeInTheDocument();
    expect(screen.getByTestId('fact-F1.cover')).toBeInTheDocument();
    // The whole point: COL-02's fact AND its open question stay on COL-02.
    expect(screen.queryByTestId('fact-C1.section')).toBeNull();
    expect(screen.queryByTestId('fact-C1.laps')).toBeNull();
  });

  it('the header counts what the list shows, and names the drawing', () => {
    mount(twoDrawings(), 'sheet-found');
    // Two facts, one of them open — not four and two.
    expect(screen.getByTestId('spec-scope')).toHaveTextContent(
      'FOUND-01 · 2 facts on file · 1 open question',
    );
  });

  it('opening the other drawing swaps the specification with it', () => {
    const store = mount(twoDrawings(), 'sheet-found');
    expect(screen.getByTestId('fact-F1.width')).toBeInTheDocument();

    act(() => store.openSheet('sheet-col'));
    expect(screen.getByTestId('fact-C1.section')).toBeInTheDocument();
    expect(screen.queryByTestId('fact-F1.width')).toBeNull();
    expect(screen.getByTestId('spec-scope')).toHaveTextContent('COL-02 ·');
  });

  it('a section reads as its parent drawing, not as a drawing of its own', () => {
    mount(twoDrawings(), 'sheet-section');
    // The section was cut from FOUND-01, so FOUND-01's facts are its facts.
    expect(screen.getByTestId('fact-F1.width')).toBeInTheDocument();
    expect(screen.queryByTestId('fact-C1.section')).toBeNull();
  });

  it('“Every drawing” is still one click away — the project view is not lost', () => {
    mount(twoDrawings(), 'sheet-found');
    expect(screen.queryByTestId('fact-C1.section')).toBeNull();

    fireEvent.click(screen.getByTestId('spec-whole-project'));
    expect(screen.getByTestId('fact-F1.width')).toBeInTheDocument();
    expect(screen.getByTestId('fact-C1.section')).toBeInTheDocument();
    expect(screen.getByTestId('spec-scope')).toHaveTextContent('every drawing · 4 facts on file');
  });

  it('with no drawing open it is the whole project, with nothing to scope to', () => {
    mount(twoDrawings(), null);
    expect(screen.getByTestId('fact-F1.width')).toBeInTheDocument();
    expect(screen.getByTestId('fact-C1.section')).toBeInTheDocument();
    expect(screen.queryByTestId('spec-whole-project')).toBeNull();
  });
});

describe('a fact nothing can place is gathered, not interleaved', () => {
  /** The shape every ledger written before answers were placed still holds. */
  function withLooseAnswer(): Ledger {
    return addFact(twoDrawings(), {
      id: 'C1.height',
      value: 300,
      unit: 'mm',
      state: 'SUPPLIED',
      suppliedBy: 'you',
      readOn: '2026-09-03',
    });
  }

  it('keeps it out of the open drawing’s own list, and says why', () => {
    mount(withLooseAnswer(), 'sheet-found');
    const loose = screen.getByTestId('spec-unplaced');
    // Still reachable — hiding it makes it findable from nowhere.
    expect(within(loose).getByTestId('fact-C1.height')).toBeInTheDocument();
    expect(loose.textContent).toContain('Not tied to a drawing');
    expect(loose.textContent).toContain('FOUND-01');
    // And not standing among FOUND-01's rows as if it were one of them.
    expect(within(screen.getByTestId('fact-F1.width').parentElement!).queryByTestId('fact-C1.height')).toBeNull();
  });

  it('does not gather anything when every drawing is showing', () => {
    mount(withLooseAnswer(), 'sheet-found');
    fireEvent.click(screen.getByTestId('spec-whole-project'));
    // Nothing is claiming to be one drawing's, so there is nothing to separate.
    expect(screen.queryByTestId('spec-unplaced')).toBeNull();
    expect(screen.getByTestId('fact-C1.height')).toBeInTheDocument();
  });
});

describe('factOnDrawing — one rule, three cases', () => {
  const base = { id: 'x.y', value: null, state: 'MISSING' as const, readOn: '2026-09-01' };

  it('a sourced fact belongs to the drawing it was read from', () => {
    const f: Fact = { ...base, source: { drawingNumber: 'FOUND-01', revision: 'R1' } };
    expect(factOnDrawing(f, 'FOUND-01')).toBe(true);
    expect(factOnDrawing(f, 'COL-02')).toBe(false);
  });

  it('a gap filed before sources were stamped falls back to where the run looked', () => {
    // This is the shape every question already in a user's ledger has.
    const f: Fact = { ...base, lookedIn: ['FOUND-01 R1', '12 callouts on this sheet'] };
    expect(factOnDrawing(f, 'FOUND-01')).toBe(true);
    expect(factOnDrawing(f, 'COL-02')).toBe(false);
  });

  it('a fact nothing can place shows everywhere rather than nowhere', () => {
    const f: Fact = { ...base, value: 25, state: 'SUPPLIED', suppliedBy: 'you' };
    expect(factOnDrawing(f, 'FOUND-01')).toBe(true);
    expect(factOnDrawing(f, 'COL-02')).toBe(true);
    // And an empty drawing number scopes nothing at all.
    expect(factOnDrawing({ ...base, source: { drawingNumber: 'A', revision: '' } }, '')).toBe(true);
  });
});
