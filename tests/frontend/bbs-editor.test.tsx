// EXPAND / EDIT, as a person meets it.
//
// The grid must show the rows that are NOT finished — that is what it is for —
// must let the inputs be typed and refuse the outputs, must not accept a
// figure that has to be read off a drawing without a confirmation, and must
// never call a partial schedule final.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { BbsEditor } from '../../src/components/BbsEditor';
import { buildEditGrid, recalculate } from '../../calculations/bbsEdit';
import type { BbsBar, BbsMember, BbsSettings, EngineInputs } from '../../src/cad/bbs/types';

afterEach(cleanup);

const settings = (): BbsSettings => ({
  concreteGrade: 'M25',
  steelGrade: 'Fe500',
  coverMm: 50,
  // stated, so a row with everything else in place is genuinely finished and
  // the 'needs attention' filter has something to hide
  coverSource: 'stated',
  bendMode: 'CONVENTIONAL',
  wastagePct: 3,
});

const member = (over: Partial<BbsMember> & { mark: string }): BbsMember => ({
  type: 'FOOTING',
  count: 4,
  source: { table: 'SCHEDULE', row: 1 },
  incomplete: false,
  missing: [],
  dimSources: { L: 'DRAWING_READ — SCHEDULE', W: 'DRAWING_READ — SCHEDULE', H: 'DRAWING_READ — SCHEDULE' },
  ...over,
});

const bar = (over: Partial<BbsBar> & { memberMark: string; diaMm: number }): BbsBar => ({
  barType: 'MAIN',
  shapeCode: '00',
  fromCallout: `T${over.diaMm} @ 150 c/c`,
  handles: ['AA11'],
  ...over,
});

function grid(disputes: string[] = []) {
  const inputs: EngineInputs = {
    members: {
      OK: member({ mark: 'OK', lengthMm: 2500, widthMm: 2300, heightMm: 350, count: 4 }),
      NEEDSW: member({ mark: 'NEEDSW', lengthMm: 4300, heightMm: 575, count: 6, dimSources: { L: 'DRAWING_READ — SCHEDULE', H: 'DRAWING_READ — SCHEDULE' } }),
      SHAPE: member({ mark: 'SHAPE', lengthMm: 3600, widthMm: 3100, heightMm: 550, count: 3 }),
    },
    bars: {
      'OK-A': bar({ memberMark: 'OK', diaMm: 10, spacingMm: 150, distributionAxis: 'L' }),
      'NEEDSW-A': bar({ memberMark: 'NEEDSW', diaMm: 12, spacingMm: 100, distributionAxis: 'L' }),
      'SHAPE-A': bar({ memberMark: 'SHAPE', diaMm: 16, spacingMm: 200, distributionAxis: 'L', shapeCode: 'CUS' }),
    },
    settings: settings(),
    runMm: null,
    coverTable: [],
    takeoffCounts: {},
    enteredCuttingLengthMm: {},
    declaredInputs: {},
  };
  const { rows, summary, reconciliation } = recalculate(inputs);
  return buildEditGrid(rows, inputs, { summary, reconciliation, disputes });
}

const open = (over: Partial<React.ComponentProps<typeof BbsEditor>> = {}) => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(<BbsEditor grid={grid()} title="Foundations-BBS-v1.xlsx" onSave={onSave} onClose={onClose} {...over} />);
  return { onSave, onClose };
};

describe('the editable schedule', () => {
  it('says INCOMPLETE and shows what is unfinished', () => {
    open();
    expect(screen.getByText(/INCOMPLETE — ACTION REQUIRED/)).toBeTruthy();
    const issues = screen.getByTestId('bbs-editor-issues');
    expect(within(issues).getAllByText('BLOCKED').length).toBeGreaterThan(0);
    expect(issues.textContent).toMatch(/NEEDSW-A/);
    expect(issues.textContent).toMatch(/SHAPE-A/);
  });

  it('shows the blocked rows rather than hiding them', () => {
    open();
    expect(screen.getByTestId('bbsed-row-NEEDSW-A')).toBeTruthy();
    expect(screen.getByTestId('bbsed-row-SHAPE-A')).toBeTruthy();
  });

  it('counts what is calculated, open, assumed and mismatched', () => {
    open();
    const tally = screen.getByTestId('bbs-editor-tally');
    expect(tally.textContent).toMatch(/Rows\s*3/);
    expect(tally.textContent).toMatch(/Calculated\s*1/);
    expect(tally.textContent).toMatch(/Open\s*2/);
    expect(tally.textContent).toMatch(/Assumed inputs\s*0/);
  });

  it('lists the gates that are keeping it from FINAL', () => {
    open();
    const gates = screen.getByTestId('bbs-editor-gates');
    expect(gates.textContent).toMatch(/not final/i);
    expect(gates.textContent).toMatch(/blocked rows = 0/);
  });

  it('marks the cell a blocked row is waiting on', () => {
    open();
    const width = screen.getByLabelText('NEEDSW-A Member width W') as HTMLInputElement;
    expect(width.value).toBe('');
    expect(width.placeholder).toBe('needed');
    expect(width.closest('td')!.className).toMatch(/is-wanted/);
  });

  it('offers no cell for a calculated output', () => {
    open();
    expect(screen.queryByLabelText('OK-A Cutting length')).toBeNull();
    expect(screen.queryByLabelText('OK-A Weight')).toBeNull();
    // the computed figures are on the row, read-only
    const row = screen.getByTestId('bbsed-row-OK-A');
    expect(row.querySelectorAll('td.bbsed-out').length).toBeGreaterThan(4);
  });

  it('will not save until a bad value is corrected', () => {
    const { onSave } = open();
    const width = screen.getByLabelText('NEEDSW-A Member width W');
    fireEvent.change(width, { target: { value: 'wide-ish' } });
    const save = screen.getByTestId('bbs-editor-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/is not a number/)).toBeTruthy();

    fireEvent.change(width, { target: { value: '2900' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith([{ barMark: 'NEEDSW-A', field: 'memberWidth', value: '2900' }]);
  });

  it('holds back a figure that must be read from the drawing until it is confirmed', () => {
    const { onSave } = open();
    const shape = screen.getByLabelText('SHAPE-A Shape code');
    fireEvent.change(shape, { target: { value: '11' } });

    const save = screen.getByTestId('bbs-editor-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/confirm this comes from the drawing/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Confirm SHAPE-A Shape code comes from the drawing'));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith([{ barMark: 'SHAPE-A', field: 'shapeCode', value: '11', confirmed: true }]);
  });

  it('shows the reason a save was refused, against the cell', () => {
    open({ rejected: [{ barMark: 'NEEDSW-A', field: 'memberWidth', value: '0', reason: 'never entered as zero' }] });
    expect(screen.getByText('never entered as zero')).toBeTruthy();
  });

  it('shows EVERY row by default — the finished ones are the context', () => {
    open();
    const toggle = screen.getByLabelText(/Show only rows needing attention/) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    for (const mark of ['OK-A', 'NEEDSW-A', 'SHAPE-A']) {
      expect(screen.getByTestId(`bbsed-row-${mark}`), mark).toBeTruthy();
    }
    expect(screen.getByText('Showing 3 of 3 rows')).toBeTruthy();

    // and can narrow to the ones that need work
    fireEvent.click(toggle);
    expect(screen.queryByTestId('bbsed-row-OK-A')).toBeNull();
    expect(screen.getByTestId('bbsed-row-NEEDSW-A')).toBeTruthy();
  });

  it('carries every column the downloaded workbook prints', () => {
    open();
    const headers = Array.from(document.querySelectorAll('.bbsed-grid thead tr:nth-child(2) th')).map(
      (th) => th.textContent?.replace(/\s*⚑$/, '').trim(),
    );
    for (const label of [
      'S.No', 'Member Mark', 'Member Type', 'Bar Mark', 'Location', 'Status',
      'Shape code', 'Diameter', 'Spacing c/c', 'Clear cover', 'Cover source',
      'Cutting Length (mm)', 'Length by', 'Bars/Member', 'Member Count', 'Total Bars',
      'Total Length (m)', 'Unit Weight (kg/m)', 'Net Weight (kg)', 'Wastage (kg)', 'Gross Weight (kg)',
      'Source Section', 'Source Callout', 'Source Entity/Handle', 'Fact IDs', 'Confidence', 'Validation',
    ]) {
      expect(headers, label).toContain(label);
    }
  });

  it('shows the calculated figures beside the inputs, read-only', () => {
    open();
    const row = screen.getByTestId('bbsed-row-OK-A');
    const cells = Array.from(row.querySelectorAll('td.bbsed-out')).map((td) => td.textContent?.trim());
    // OK-A: 2300 − 2×50 cut, 17 bars per member, 4 members, 68 bars
    expect(cells).toContain('2200');
    expect(cells).toContain('68');
    expect(cells).toContain('SHAPE_FORMULA');
    // and none of those cells is editable
    expect(row.querySelectorAll('td.bbsed-out input').length).toBe(0);
  });

  it('offers two saves: correct this schedule, or file a new version', () => {
    const { onSave } = open();
    fireEvent.change(screen.getByLabelText('NEEDSW-A Member width W'), { target: { value: '2900' } });

    // the primary action CORRECTS the schedule that was opened
    fireEvent.click(screen.getByTestId('bbs-editor-save'));
    expect(onSave).toHaveBeenLastCalledWith([{ barMark: 'NEEDSW-A', field: 'memberWidth', value: '2900' }]);

    // filing a revision is a separate, deliberate act
    fireEvent.click(screen.getByTestId('bbs-editor-save-new'));
    expect(onSave).toHaveBeenLastCalledWith(
      [{ barMark: 'NEEDSW-A', field: 'memberWidth', value: '2900' }],
      { asNewVersion: true },
    );
  });

  it('shows what the schedule disputes, and will not call it final until they are checked', () => {
    const onSave = vi.fn();
    const disputes = [
      'SANITY: 118 kg over a 160 m run is 0.7 kg/m — steel is MISSING from this schedule.',
      'Independent verifier disputes the reading: the placement count of 4 is not supported.',
    ];
    render(
      <BbsEditor grid={grid(disputes)} title="BBS-TEST-columns-BBS-v1.xlsx" onSave={onSave} onClose={vi.fn()} />,
    );

    const panel = screen.getByTestId('bbs-editor-disputes');
    expect(panel.textContent).toMatch(/2 unresolved disputes/);
    expect(panel.textContent).toMatch(/steel is MISSING/);
    expect(screen.getByText(/INCOMPLETE — ACTION REQUIRED/)).toBeTruthy();

    // nothing to type, but there IS something to do: check them
    const save = screen.getByTestId('bbs-editor-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    for (const d of disputes) fireEvent.click(screen.getByLabelText(`I have checked: ${d.slice(0, 60)}`));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith([], { acknowledged: disputes });
  });
});
