// The schedule: rows expand IN PLACE into their derivation, never re-sorting;
// one open at a time unless Alt is held; Enter/Space toggles the focused row;
// columns derive from what the rows can evidence.

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

afterEach(cleanup);
import { BbsSheet } from '../../src/components/BbsSheet';
import { deriveColumns, type ScheduleRow } from '../../src/studio/schedule';

let seq = 0;
function makeRow(partial: Partial<ScheduleRow> & Pick<ScheduleRow, 'mark' | 'member' | 'diaMm'>): ScheduleRow {
  seq += 1;
  return {
    id: `r${seq}`,
    barType: 'Fe500D',
    shapeCode: '00',
    segments: [{ label: 'a', mm: 1000 }],
    cuttingLengthMm: 1000,
    lengthWorking: '1000 = 1000',
    lengthSource: 'SHAPE_FORMULA',
    barsPerMember: 2,
    memberCount: 5,
    totalBars: 10,
    spacingMm: null,
    occurrenceBand: null,
    totalLengthM: 10,
    unitWeightKgPerM: 0.617,
    weightKg: 6.2,
    warnings: [],
    fromCallout: 'CALL-001',
    handles: ['H1'],
    status: 'verified',
    ...partial,
  };
}

const rows: ScheduleRow[] = [
  makeRow({ mark: 'C1', member: 'C1 column', diaMm: 16 }),
  makeRow({
    mark: 'C1',
    member: 'C1 column',
    diaMm: 8,
    shapeCode: '51',
    segments: [
      { label: 'a', mm: 380 },
      { label: 'b', mm: 180 },
      { label: '—', mm: -36, note: 'bend deduction, 2 × 90° · IS 2502 Table 1' },
    ],
    spacingMm: 150,
  }),
  makeRow({ mark: 'TB', member: 'TB tie beam', diaMm: 12 }),
];

const rowOrder = () =>
  screen.getAllByTestId(/^bbs-row-/).map((el) => el.getAttribute('data-testid'));

describe('schedule rows', () => {
  it('a row expands in place, directly below itself, without re-sorting', () => {
    render(<BbsSheet rows={rows} />);
    const before = rowOrder();

    const row = screen.getByTestId('bbs-row-r2');
    fireEvent.click(row);

    // The derivation is the row's immediate next sibling — in place, not a modal.
    const derivation = screen.getByTestId('bbs-derivation-r2');
    expect(row.nextElementSibling).toBe(derivation);
    expect(within(derivation).getByText(/bend deduction, 2 × 90°/)).toBeInTheDocument();
    expect(within(derivation).getByText('source: SHAPE_FORMULA')).toBeInTheDocument();

    // Expanding never re-sorts, never moves the row.
    expect(rowOrder()).toEqual(before);
  });

  it('one row open at a time by default; Alt-click keeps the others', () => {
    render(<BbsSheet rows={rows} />);
    fireEvent.click(screen.getByTestId('bbs-row-r1'));
    expect(screen.getByTestId('bbs-derivation-r1')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('bbs-row-r3'));
    expect(screen.queryByTestId('bbs-derivation-r1')).not.toBeInTheDocument();
    expect(screen.getByTestId('bbs-derivation-r3')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('bbs-row-r1'), { altKey: true });
    expect(screen.getByTestId('bbs-derivation-r1')).toBeInTheDocument();
    expect(screen.getByTestId('bbs-derivation-r3')).toBeInTheDocument();
  });

  it('Enter and Space toggle the focused row; the disclosure triangle is a real button', () => {
    render(<BbsSheet rows={rows} />);
    const row = screen.getByTestId('bbs-row-r1');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.getByTestId('bbs-derivation-r1')).toBeInTheDocument();
    fireEvent.keyDown(row, { key: ' ' });
    expect(screen.queryByTestId('bbs-derivation-r1')).not.toBeInTheDocument();

    const disclose = within(row).getByRole('button', { name: /open the derivation/i });
    fireEvent.click(disclose);
    expect(screen.getByTestId('bbs-derivation-r1')).toBeInTheDocument();
  });

  it('an UNAVAILABLE row still opens and says what is missing', () => {
    const blocked = makeRow({
      mark: 'WALL',
      member: 'WALL panel',
      diaMm: 10,
      lengthSource: 'UNAVAILABLE',
      cuttingLengthMm: null,
      weightKg: null,
      status: 'unavailable',
      missing: 'Panel height above GL would complete this row.',
    });
    render(<BbsSheet rows={[...rows, blocked]} />);
    fireEvent.click(screen.getByTestId(`bbs-row-${blocked.id}`));
    const derivation = screen.getByTestId(`bbs-derivation-${blocked.id}`);
    expect(within(derivation).getByText(/Panel height above GL/)).toBeInTheDocument();
    expect(within(derivation).getByText('source: UNAVAILABLE')).toBeInTheDocument();
  });

  it('groups by member with subtotals and a steel summary by diameter', () => {
    render(<BbsSheet rows={rows} />);
    expect(screen.getByTestId('bbs-group-C1 column')).toBeInTheDocument();
    expect(screen.getByTestId('bbs-group-TB tie beam')).toBeInTheDocument();
    expect(screen.getByText('C1 column subtotal')).toBeInTheDocument();
    expect(screen.getByText('Steel summary by diameter')).toBeInTheDocument();
  });
});

describe('derived columns (§6.2)', () => {
  it('leg columns expand to the longest segments and no further', () => {
    const cols = deriveColumns(rows).map((c) => c.id);
    expect(cols).toContain('leg:a');
    expect(cols).toContain('leg:b');
    expect(cols).not.toContain('leg:c');
  });

  it('a schedule of straight bars shows leg a alone and no Shape column', () => {
    const straight = [
      makeRow({ mark: 'W1', member: 'WALL', diaMm: 10 }),
      makeRow({ mark: 'W2', member: 'WALL', diaMm: 12 }),
    ];
    const cols = deriveColumns(straight).map((c) => c.id);
    expect(cols).toContain('leg:a');
    expect(cols).not.toContain('leg:b');
    expect(cols).not.toContain('shape');
  });

  it('Spacing appears only where a count was derived from spacing', () => {
    const noSpacing = [makeRow({ mark: 'X', member: 'X', diaMm: 8 })];
    expect(deriveColumns(noSpacing).map((c) => c.id)).not.toContain('spacing');
    expect(deriveColumns(rows).map((c) => c.id)).toContain('spacing');
  });

  it('column order follows the Indian commercial convention', () => {
    const cols = deriveColumns(rows).map((c) => c.id);
    const order = ['mark', 'member', 'barType', 'dia', 'shape', 'leg:a', 'cuttingLength', 'barsPerMember', 'memberCount', 'totalBars', 'totalLength', 'unitWeight', 'weight'];
    const positions = order.map((id) => cols.indexOf(id));
    expect(positions.every((p, i) => i === 0 || p > positions[i - 1])).toBe(true);
  });
});
