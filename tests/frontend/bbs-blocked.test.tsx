// §6.4 in the interface — "an incomplete row is a question, not a blank"
// (STUDIO_DESIGN §6.1): a row whose length is UNAVAILABLE renders the formula
// with its hole named, which fact is MISSING, where the run looked and the ask,
// and can be answered where it stands — the same act as answering it in the
// Specification, into the same ledger (§4.4, one store, three doors).
//
// Plus the two totals that must never lie: a member whose every row is open has
// no subtotal, it has a question; and a schedule with nothing weighable is
// BLOCKED, not 0.0 kg of steel.

import React, { useMemo, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

afterEach(cleanup);

import { BbsSheet } from '../../src/components/BbsSheet';
import { Dock } from '../../src/components/Dock';
import { SpecificationView } from '../../src/components/SpecificationView';
import { missingFactsFromRun } from '../../src/studio/bbsFacts';
import { addFact, emptyLedger, recordFact, resolveFact, type Ledger } from '../../src/facts/ledger';
import type { Fact } from '../../src/facts/types';
import { parseFactValue } from '../../src/studio/realData';
import type { ScheduleRow } from '../../src/studio/schedule';
import { StudioDataContext, type StudioData } from '../../src/studio/data';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';

// ------------------------------------------------------------
// fixtures
// ------------------------------------------------------------

function row(partial: Partial<ScheduleRow> & Pick<ScheduleRow, 'id' | 'mark' | 'member'>): ScheduleRow {
  return {
    barType: '',
    diaMm: 16,
    shapeCode: '',
    segments: [],
    cuttingLengthMm: 4407,
    lengthWorking: '',
    lengthSource: 'SHAPE_FORMULA',
    barsPerMember: 4,
    memberCount: 24,
    totalBars: 96,
    spacingMm: null,
    occurrenceBand: null,
    totalLengthM: 423,
    unitWeightKgPerM: 1.58,
    weightKg: 668.3,
    warnings: [],
    fromCallout: null,
    handles: [],
    status: 'verified',
    ...partial,
  };
}

const C1_BLOCKED = row({
  id: 'r-c1',
  mark: 'C1-V',
  member: 'C1 column',
  diaMm: 12,
  cuttingLengthMm: null,
  lengthSource: 'UNAVAILABLE',
  totalLengthM: null,
  unitWeightKgPerM: 0.888,
  weightKg: null,
  status: 'unavailable',
  missing: 'member H dimension not on this sheet',
  blocked: {
    formula:
      'members: 5 occurrences of C1 in BAND-01\ncutting length  =  f(⟨C1.height⟩)\nweight  =  cutting length × 0.888 kg/m × 40',
    missingFactIds: ['C1.height'],
    ask: ['What is the height of C1? This sheet carries no dimension for it.'],
  },
});

const TB_BLOCKED = row({
  id: 'r-tb',
  mark: 'TB-16',
  member: 'TB tie beam',
  cuttingLengthMm: null,
  lengthSource: 'UNAVAILABLE',
  totalLengthM: null,
  weightKg: null,
  status: 'unavailable',
  blocked: {
    formula: 'cutting length  =  f(⟨wall.total_run⟩)',
    missingFactIds: ['wall.total_run'],
    ask: ['What is the total run of the wall, end to end?'],
  },
});

function ledgerWithQuestion(): Ledger {
  return addFact(emptyLedger(), {
    id: 'C1.height',
    value: null,
    unit: 'mm',
    state: 'MISSING',
    neededFor: ['C1 row C1-V'],
    lookedIn: ['GW-01 R1', '36 callouts, 41 readable dimensions'],
    ask: 'What is the height of C1? This sheet carries no dimension for it.',
    readOn: '2026-08-30',
  });
}

function openRow(id: string): void {
  fireEvent.click(screen.getByTestId(`bbs-row-${id}`));
}

// ------------------------------------------------------------
// the blocked row
// ------------------------------------------------------------

describe('a blocked row is a question (§6.4)', () => {
  it('names the hole in the cutting-length cell instead of printing a dash', () => {
    render(<BbsSheet rows={[C1_BLOCKED]} ledger={ledgerWithQuestion()} />);
    const cell = screen.getByTestId('bbs-hole-r-c1');
    expect(cell.textContent).toBe('needs C1.height');
    // the cutting-length cell itself carries the hole, never a bare dash
    expect(cell.closest('td')?.textContent).toBe('needs C1.height');
  });

  it('opens on the formula, the missing fact id, where the run looked, and the ask', () => {
    render(<BbsSheet rows={[C1_BLOCKED]} ledger={ledgerWithQuestion()} />);
    openRow('r-c1');
    const text = screen.getByTestId('bbs-blocked-formula-r-c1').textContent ?? '';
    expect(text).toContain('⟨C1.height⟩');
    expect(text).toContain('⚠ BLOCKED — C1.height is MISSING');
    expect(text).toContain('C1 row C1-V');
    expect(text).toContain('36 callouts, 41 readable dimensions');
    expect(text).toContain('What is the height of C1?');
  });

  it('answers the hole where it stands, writing SUPPLIED to the one ledger', () => {
    const answered = vi.fn();
    render(<BbsSheet rows={[C1_BLOCKED]} ledger={ledgerWithQuestion()} onAnswerFact={answered} />);
    openRow('r-c1');
    const form = screen.getByTestId('bbs-answer-C1.height');
    fireEvent.change(within(form).getByLabelText('Answer C1.height'), { target: { value: '2700' } });
    fireEvent.click(within(form).getByRole('button', { name: /Answer C1.height/ }));
    expect(answered).toHaveBeenCalledWith('C1.height', '2700');
  });

  it('stops asking once the fact is usable, and says a rebuild is what computes it', () => {
    const answered = recordFact(ledgerWithQuestion(), {
      id: 'C1.height',
      value: 2700,
      unit: 'mm',
      state: 'SUPPLIED',
      suppliedBy: 'you',
      saidAs: '2.7 m',
      readOn: '2026-08-31',
    }).ledger;
    render(<BbsSheet rows={[C1_BLOCKED]} ledger={answered} onAnswerFact={vi.fn()} />);
    openRow('r-c1');
    expect(screen.queryByTestId('bbs-answer-C1.height')).toBeNull();
    const note = screen.getByTestId('bbs-blocked-answered-r-c1').textContent ?? '';
    expect(note).toContain('C1.height = 2700');
    expect(note).toContain('Rebuild');
    expect(note).toContain('spends model calls');
  });

  it('leaves a computed row exactly as it was', () => {
    render(<BbsSheet rows={[row({ id: 'r-ok', mark: 'F1', member: 'F1 footing' })]} />);
    openRow('r-ok');
    expect(screen.queryByTestId('bbs-blocked-r-ok')).toBeNull();
  });
});

describe('a blocked total does not read as zero steel', () => {
  it('says the member is blocked, naming the fact, instead of "0.0 (+2 open)"', () => {
    render(<BbsSheet rows={[C1_BLOCKED, { ...C1_BLOCKED, id: 'r-c1b' }]} />);
    const subtotal = screen.getByTestId('bbs-subtotal-C1 column');
    expect(subtotal.textContent).toBe('blocked — 2 rows open, waiting on C1.height');
  });

  it('says the schedule is blocked, naming every fact it waits on', () => {
    render(<BbsSheet rows={[C1_BLOCKED, TB_BLOCKED]} />);
    const total = screen.getByTestId('bbs-total').textContent ?? '';
    expect(total).toContain('blocked');
    expect(total).toContain('C1.height');
    expect(total).toContain('wall.total_run');
    expect(total).not.toContain('0.0 kg');
  });

  it('still totals a schedule that computed something, and counts what stays open', () => {
    render(<BbsSheet rows={[row({ id: 'r-ok', mark: 'F1', member: 'F1 footing' }), C1_BLOCKED]} />);
    const total = screen.getByTestId('bbs-total').textContent ?? '';
    expect(total).toContain('668.3 kg');
    expect(total).toContain('1 row still open');
  });
});

// ------------------------------------------------------------
// the BBS tab: answers arrive, a rebuild is OFFERED (§6.3)
// ------------------------------------------------------------

function DockHarness({
  rows,
  initial,
  answersSince,
  onRun,
}: {
  rows: ScheduleRow[];
  initial: Ledger;
  answersSince: string[];
  onRun: () => void;
}) {
  const [ledger, setLedger] = useState(initial);
  const data = useMemo<StudioData>(
    () => ({
      projectName: 'Blocked harness',
      groups: [],
      sheets: {},
      scheduleRows: rows,
      scheduleVersion: 'v1',
      bbs: {
        blocked: null,
        running: false,
        progress: [],
        stats: 'partial · 2 rows',
        error: null,
        run: onRun,
        answersSince,
        factsUsed: 1,
        lastCostLine: 'last run: 41 model calls · $0.1900 · 620s',
        questionsFiled: 2,
      },
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
              readOn: '2026-08-31',
            };
            return recordFact(prev, fact).ledger;
          });
        },
        override: async () => undefined,
        withdraw: async () => undefined,
        open: () => undefined,
        exportCsv: () => undefined,
      },
    }),
    [ledger, rows, answersSince, onRun],
  );
  const store = useMemo(() => {
    const s = new StudioStore();
    s.setDockTab('bbs');
    return s;
  }, []);
  return (
    <StudioStoreContext.Provider value={store}>
      <StudioDataContext.Provider value={data}>
        <Dock />
      </StudioDataContext.Provider>
    </StudioStoreContext.Provider>
  );
}

// ------------------------------------------------------------
// the same questions, in the Specification (§4.2 — two surfaces, one store)
// ------------------------------------------------------------

describe("a run's escalations reach the Specification as answerable questions", () => {
  const run = {
    result: {
      members: [{ mark: 'C1', dims: { L: 350, W: 350 } }],
      rows: [
        {
          id: 'C1-V',
          barMark: 'C1-V',
          memberMark: 'C1',
          description: 'vertical T12',
          diameterMm: 12,
          unitWeightKgPerM: 0.888,
          working: [],
          evidenceIds: [],
          status: 'unavailable' as const,
          note: 'member H dimension not on this sheet',
        },
      ],
    },
    escalations: [{ question: 'Does the wall turn any corners?', whyNeeded: 'corner bar counts' }],
    unresolved: [],
    lookedIn: ['GW-01 R1', '36 callouts, 41 readable dimensions'],
    readOn: '2026-08-30',
  };

  it('shows each one with its ask, where the run looked, and an answer input', () => {
    let ledger = emptyLedger();
    for (const fact of missingFactsFromRun(run, ledger)) ledger = recordFact(ledger, fact).ledger;

    render(
      <StudioStoreContext.Provider value={new StudioStore()}>
        <StudioDataContext.Provider
          value={
            {
              projectName: 'p',
              groups: [],
              sheets: {},
              scheduleRows: [],
              scheduleVersion: '—',
              facts: {
                loaded: true,
                ledger,
                answer: async () => undefined,
                override: async () => undefined,
                withdraw: async () => undefined,
                open: () => undefined,
                exportCsv: () => undefined,
              },
            } as StudioData
          }
        >
          <SpecificationView />
        </StudioDataContext.Provider>
      </StudioStoreContext.Provider>,
    );

    expect(screen.getByTestId('spec-view').textContent).toContain('2 open questions');
    const heightRow = screen.getByTestId('fact-C1.height');
    expect(within(heightRow).getByTestId('fact-chip').textContent).toBe('missing');
    fireEvent.click(within(heightRow).getByRole('button', { name: /height/ }));
    const detail = screen.getByTestId('fact-detail-C1.height').textContent ?? '';
    expect(detail).toContain('C1 row C1-V');
    expect(detail).toContain('36 callouts, 41 readable dimensions');
    expect(detail).toContain('height of C1');
    expect(within(screen.getByTestId('fact-detail-C1.height')).getByRole('button', { name: 'Answer' })).toBeTruthy();
  });
});

describe('the BBS tab notices an answer and offers a rebuild (§6.3)', () => {
  it('offers nothing until an answer has arrived — the run is never re-fired', () => {
    render(<DockHarness rows={[C1_BLOCKED]} initial={ledgerWithQuestion()} answersSince={[]} onRun={vi.fn()} />);
    expect(screen.queryByTestId('bbs-answers-since')).toBeNull();
    expect(screen.getByRole('button', { name: 'Build schedule' })).toBeTruthy();
    // it does say the questions are waiting in the Specification
    expect(screen.getByTestId('bbs-questions-filed').textContent).toContain('Specification');
  });

  it('says how many answers arrived, what a rebuild costs, and rebuilds only when asked', () => {
    const run = vi.fn();
    render(
      <DockHarness
        rows={[C1_BLOCKED]}
        initial={ledgerWithQuestion()}
        answersSince={['C1.height']}
        onRun={run}
      />,
    );
    const notice = screen.getByTestId('bbs-answers-since').textContent ?? '';
    expect(notice).toContain('1 answer');
    expect(notice).toContain('C1.height');
    expect(notice).toContain('spends model calls');
    expect(notice).toContain('$0.1900');
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild schedule' }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports a fully blocked schedule as blocked, not as 0 t of steel', () => {
    render(
      <DockHarness rows={[C1_BLOCKED, TB_BLOCKED]} initial={ledgerWithQuestion()} answersSince={[]} onRun={vi.fn()} />,
    );
    const chip = screen.getByTestId('bbs-tonnage').textContent ?? '';
    expect(chip).toContain('blocked');
    expect(chip).not.toContain('0 t');
  });

  it('answering on the row writes through the facts seam — one store, three doors', () => {
    render(
      <DockHarness rows={[C1_BLOCKED]} initial={ledgerWithQuestion()} answersSince={[]} onRun={vi.fn()} />,
    );
    openRow('r-c1');
    const form = screen.getByTestId('bbs-answer-C1.height');
    fireEvent.change(within(form).getByLabelText('Answer C1.height'), { target: { value: '2700' } });
    fireEvent.click(within(form).getByRole('button', { name: /Answer C1.height/ }));
    // the ledger now carries a SUPPLIED answer, and the row stops asking
    expect(screen.getByTestId('bbs-blocked-answered-r-c1').textContent).toContain('C1.height = 2700');
  });
});
