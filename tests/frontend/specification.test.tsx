// R4/R4a/R5 — the Specification: rows grouped by subject with trust-ordered
// state chips (§4.3), expansion per state, the provenance chain (§4.4),
// answering a missing fact (§4.4 "three doors to one act"), supplied editing
// and withdrawal (§4.5), history with the old value struck through and the
// R1 → R2 revision chip (§5.5), and the §5.4 impact report.

import React, { useMemo, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { SpecificationView } from '../../src/components/SpecificationView';
import {
  addFact,
  emptyLedger,
  overrideFact,
  recordFact,
  resolveFact,
  withdrawFact,
  type Ledger,
} from '../../src/facts/ledger';
import { applyRevisionFacts, type RevisionImpact } from '../../src/facts/revision';
import type { Fact } from '../../src/facts/types';
import { parseFactValue } from '../../src/studio/realData';
import {
  StudioDataContext,
  type RevisionImpactRecord,
  type SourceLevel,
  type StudioData,
} from '../../src/studio/data';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';

afterEach(cleanup);

// ------------------------------------------------------------
// a small in-memory harness implementing the facts seam over the real ledger
// ------------------------------------------------------------

function seedLedger(): Ledger {
  let l = emptyLedger();
  l = addFact(l, {
    id: 'TB.section',
    value: '350x400',
    state: 'DECLARED',
    source: {
      drawingNumber: 'GW-01',
      revision: 'R1',
      sectionId: 'REGION-12',
      handles: ['79A47'],
      rawText: '350X400',
    },
    readOn: '2026-08-01',
  });
  l = addFact(l, {
    id: 'wall.total_run',
    value: 100000,
    unit: 'mm',
    state: 'SUPPLIED',
    suppliedBy: 'you',
    saidAs: 'the wall is 100 m',
    readOn: '2026-08-29',
  });
  l = addFact(l, {
    id: 'wall.corners',
    value: null,
    state: 'MISSING',
    neededFor: ['corner bars'],
    lookedIn: ['GW-01 R1', 'the site plan'],
    ask: 'How many corners does the wall turn?',
    readOn: '2026-08-29',
  });
  l = addFact(l, {
    id: 'columns.main_pitch',
    value: 4157,
    unit: 'mm',
    state: 'MEASURED',
    method: 'buildPlacementBands() over C1×5 (BAND-01, axis x)',
    readOn: '2026-08-01',
  });
  l = addFact(l, {
    id: 'wall.height',
    value: 1200,
    unit: 'mm',
    state: 'DERIVED',
    basis: '900 + 300 · from wall.lvl_diff, TB.depth',
    dependsOn: ['wall.lvl_diff', 'TB.depth'],
    readOn: '2026-08-29',
  });
  return l;
}

const openSource = vi.fn<(source: Fact['source'], level: SourceLevel) => void>();

function Harness({
  initial,
  impact,
  store,
}: {
  initial: Ledger;
  impact?: RevisionImpactRecord | null;
  store: StudioStore;
}) {
  const [ledger, setLedger] = useState(initial);
  const [show, setShow] = useState(!!impact);
  const data = useMemo<StudioData>(
    () => ({
      projectName: 'Spec Harness',
      groups: [],
      sheets: {},
      scheduleRows: [],
      scheduleVersion: '—',
      facts: {
        loaded: true,
        ledger,
        answer: async (id, value, saidAs) => {
          setLedger((prev) => {
            const cur = resolveFact(prev, id);
            const fact: Fact = {
              id,
              value: parseFactValue(value),
              ...(cur?.unit !== undefined ? { unit: cur.unit } : {}),
              state: 'SUPPLIED',
              suppliedBy: 'you',
              saidAs: saidAs ?? value,
              readOn: '2026-08-30',
            };
            return recordFact(prev, fact).ledger;
          });
        },
        override: async (id, value) => {
          setLedger((prev) =>
            overrideFact(prev, id, { value: parseFactValue(value), suppliedBy: 'you' }),
          );
        },
        withdraw: async (id) => {
          setLedger((prev) => withdrawFact(prev, id).ledger);
        },
        open: (source, level) => openSource(source, level),
        exportCsv: vi.fn(),
        aboutDrawing: {
          drawingName: 'GW-01.dxf',
          updatedAt: 1,
          note: 'RCC WALL owns CALL-002 and runs continuously.',
          conclusionCount: 2,
          sectionNotes: [{
            sectionId: 'REGION-12',
            label: 'WALL SECTION',
            kind: 'section',
            note: 'callouts seen: T10@200',
          }],
        },
      },
      revision: impact
        ? { latest: impact, showReport: show, dismissReport: () => setShow(false) }
        : { latest: null, showReport: false, dismissReport: () => undefined },
    }),
    [ledger, impact, show],
  );
  return (
    <StudioStoreContext.Provider value={store}>
      <StudioDataContext.Provider value={data}>
        <SpecificationView />
      </StudioDataContext.Provider>
    </StudioStoreContext.Provider>
  );
}

function mount(initial: Ledger, impact?: RevisionImpactRecord | null) {
  const store = new StudioStore();
  render(<Harness initial={initial} impact={impact} store={store} />);
  return store;
}

// ------------------------------------------------------------

describe('rows and chips (§4.3)', () => {
  it('shows the persistent About Drawing reading and its section notes', () => {
    mount(seedLedger());
    const about = screen.getByTestId('about-drawing');
    expect(about.textContent).toContain('GW-01.dxf');
    expect(about.textContent).toContain('2 validated conclusions');
    fireEvent.click(within(about).getByText(/About Drawing/));
    expect(about.textContent).toContain('RCC WALL owns CALL-002');
    expect(about.textContent).toContain('REGION-12');
  });

  it('groups by subject and stamps every row with its state chip', () => {
    mount(seedLedger());
    const rows = screen.getByTestId('spec-rows');
    // subjects, uppercased
    expect(within(rows).getByText('TB')).toBeTruthy();
    expect(within(rows).getByText('WALL')).toBeTruthy();
    expect(within(rows).getByText('COLUMNS')).toBeTruthy();
    // one chip per state, on its row
    expect(within(screen.getByTestId('fact-TB.section')).getByTestId('fact-chip').textContent).toBe('declared');
    expect(within(screen.getByTestId('fact-wall.total_run')).getByTestId('fact-chip').textContent).toBe('supplied');
    expect(within(screen.getByTestId('fact-wall.corners')).getByTestId('fact-chip').textContent).toBe('missing');
    expect(within(screen.getByTestId('fact-columns.main_pitch')).getByTestId('fact-chip').textContent).toBe('measured');
    expect(within(screen.getByTestId('fact-wall.height')).getByTestId('fact-chip').textContent).toBe('derived');
  });

  it('expands in place per state: derived shows basis, supplied shows saidAs, measured shows method', () => {
    mount(seedLedger());
    fireEvent.click(within(screen.getByTestId('fact-wall.height')).getByRole('button', { name: /height/ }));
    expect(screen.getByTestId('fact-detail-wall.height').textContent).toContain('900 + 300');
    expect(screen.getByTestId('fact-detail-wall.height').textContent).toContain('wall.lvl_diff');

    fireEvent.click(within(screen.getByTestId('fact-wall.total_run')).getByRole('button', { name: /total_run/ }));
    expect(screen.getByTestId('fact-detail-wall.total_run').textContent).toContain('the wall is 100 m');

    fireEvent.click(within(screen.getByTestId('fact-columns.main_pitch')).getByRole('button', { name: /main_pitch/ }));
    expect(screen.getByTestId('fact-detail-columns.main_pitch').textContent).toContain('buildPlacementBands()');
  });

  it('a missing fact expands to lookedIn and the ask (§4.4)', () => {
    mount(seedLedger());
    fireEvent.click(within(screen.getByTestId('fact-wall.corners')).getByRole('button', { name: /corners/ }));
    const detail = screen.getByTestId('fact-detail-wall.corners');
    expect(detail.textContent).toContain('GW-01 R1');
    expect(detail.textContent).toContain('the site plan');
    expect(screen.getByTestId('fact-ask-wall.corners').textContent).toContain(
      'How many corners does the wall turn?',
    );
  });
});

describe('provenance chain (§4.4)', () => {
  it('renders drawing › section › handles, each segment resolving', () => {
    openSource.mockClear();
    mount(seedLedger());
    fireEvent.click(within(screen.getByTestId('fact-TB.section')).getByRole('button', { name: /section/ }));
    const chain = within(screen.getByTestId('fact-detail-TB.section')).getByTestId('source-chain');
    const segments = within(chain).getAllByRole('button');
    expect(segments.map((s) => s.textContent)).toEqual(['GW-01 R1', 'REGION-12', '79A47']);
    // hover shows the raw text, verbatim
    expect(chain.getAttribute('title')).toBe('as drawn: "350X400"');
    fireEvent.click(segments[0]);
    expect(openSource).toHaveBeenLastCalledWith(expect.objectContaining({ drawingNumber: 'GW-01' }), 'drawing');
    fireEvent.click(segments[1]);
    expect(openSource).toHaveBeenLastCalledWith(expect.anything(), 'section');
    fireEvent.click(segments[2]);
    expect(openSource).toHaveBeenLastCalledWith(expect.anything(), 'handles');
  });
});

describe('answering and editing (§4.4/§4.5)', () => {
  it('answering a missing fact records SUPPLIED and the row updates', async () => {
    mount(seedLedger());
    fireEvent.click(within(screen.getByTestId('fact-wall.corners')).getByRole('button', { name: /corners/ }));
    const input = screen.getByLabelText('Answer');
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() => {
      expect(within(screen.getByTestId('fact-wall.corners')).getByTestId('fact-chip').textContent).toBe('supplied');
    });
    // the answered value shows; the MISSING entry is history now
    expect(within(screen.getByTestId('fact-wall.corners')).getByText('4')).toBeTruthy();
    expect(screen.getByTestId('fact-history').textContent).toContain('missing');
  });

  it('a supplied fact can be withdrawn — it returns to MISSING and blocks again', async () => {
    mount(seedLedger());
    fireEvent.click(within(screen.getByTestId('fact-wall.total_run')).getByRole('button', { name: /total_run/ }));
    fireEvent.click(screen.getByTestId('withdraw-wall.total_run'));
    await waitFor(() => {
      expect(within(screen.getByTestId('fact-wall.total_run')).getByTestId('fact-chip').textContent).toBe('missing');
    });
  });

  it('measured and declared facts offer Override, never Edit — the reading is kept in history', async () => {
    mount(seedLedger());
    fireEvent.click(within(screen.getByTestId('fact-TB.section')).getByRole('button', { name: /section/ }));
    const detail = screen.getByTestId('fact-detail-TB.section');
    expect(within(detail).queryByTestId('withdraw-TB.section')).toBeNull();
    const input = within(detail).getByLabelText('Override');
    fireEvent.change(input, { target: { value: '350x450' } });
    fireEvent.click(within(detail).getByRole('button', { name: 'Override' }));
    await waitFor(() => {
      expect(within(screen.getByTestId('fact-TB.section')).getByTestId('fact-chip').textContent).toBe('supplied');
    });
    // the drawing's reading survives, struck through, its source still on it
    const history = screen.getByTestId('fact-history');
    expect(history.textContent).toContain('350x400');
    expect(history.textContent).toContain('declared');
    expect(history.textContent).toContain('user-override');
  });
});

describe('history and revisions (R5 §5.4/§5.5)', () => {
  function revisedLedger(): { ledger: Ledger; impact: RevisionImpact } {
    const seeded = seedLedger();
    const { ledger, impact } = applyRevisionFacts(seeded, {
      drawingNumber: 'GW-01',
      oldRevision: 'R1',
      newRevision: 'R2',
      newFacts: [
        {
          id: 'TB.section',
          value: '350x450',
          state: 'DECLARED',
          source: {
            drawingNumber: 'GW-01',
            revision: 'R2',
            sectionId: 'REGION-12',
            handles: ['79A47'],
            rawText: '350X450',
          },
          readOn: '2026-08-30',
        },
      ],
    });
    return { ledger, impact };
  }

  it('a fact changed at the last revision carries the R1 → R2 chip and its struck-through past', () => {
    const { ledger } = revisedLedger();
    mount(ledger);
    const row = screen.getByTestId('fact-TB.section');
    expect(within(row).getByTestId('rev-chip').textContent).toBe('R1 → R2');
    fireEvent.click(within(row).getByRole('button', { name: /section/ }));
    const history = screen.getByTestId('fact-history');
    expect(history.textContent).toContain('350x400');
    expect(history.textContent).toContain('newer-revision');
    // the OLD source is still a resolvable chain
    expect(within(history).getByText('GW-01 R1')).toBeTruthy();
  });

  it('renders the §5.4 impact report and the changed-since filter narrows to it', async () => {
    const { ledger, impact } = revisedLedger();
    mount(ledger, { id: 'imp-1', createdAt: Date.now(), impact });
    const report = screen.getByTestId('impact-report');
    expect(report.textContent).toContain('GW-01 R1 → R2');
    expect(report.textContent).toContain('CHANGED');
    expect(report.textContent).toContain('350x400');
    expect(report.textContent).toContain('350x450');
    expect(report.textContent).toContain('SURVIVED');

    // Changed since… narrows the rows to the revision's footprint
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => {
      expect(screen.getByTestId('fact-TB.section')).toBeTruthy();
      expect(screen.queryByTestId('fact-wall.total_run')).toBeNull();
    });
  });
});
