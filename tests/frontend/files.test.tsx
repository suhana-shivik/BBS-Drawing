// The Files view as a file manager (§4.3): a details list whose headers sort,
// and a properties pane in the dock over whatever the browser has selected.

import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderStudio } from './helpers';

beforeEach(() => localStorage.clear());

function openFiles() {
  const utils = renderStudio((store) => store.browseTo(['f-str']));
  return { ...utils, files: screen.getByTestId('files-view') };
}

describe('Files view — the details list', () => {
  it('lands in the details list and names every column', () => {
    const { files } = openFiles();
    const headers = within(files)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual([
      'Name',
      'Rev',
      'Drawing no.',
      'Type',
      'Discipline',
      'Size',
      'Status',
      'Added',
    ]);
  });

  it('every row says when it arrived, and a folder says it too', () => {
    const { files } = openFiles();
    const row = within(files).getByText('GAMCO-STR-001 boundary wall').closest('tr')!;
    const when = row.querySelector('td.when')!.textContent!;
    // "12 Aug 2026, 09:24" — the reader's own zone, so only the shape is fixed.
    expect(when).toMatch(/^\d{2} \w{3} \d{4}, \d{2}:\d{2}$/);
  });

  it('a row states what the file is, not just its name', () => {
    const { files } = openFiles();
    const row = within(files).getByText('GAMCO-STR-001 boundary wall').closest('tr')!;
    const cells = Array.from(row.querySelectorAll('td')).map((c) => c.textContent);
    // rev · drawing number off the sheet · Explorer's own type phrasing
    expect(cells.slice(1, 5)).toEqual(['R2', 'GAMCO-STR-001', 'DXF file', 'Structural']);
  });

  it('the column header is the sort control and a second click reverses it', () => {
    const { files } = openFiles();
    const names = () =>
      Array.from(files.querySelectorAll('tbody td.n')).map((c) => c.textContent);
    const header = within(files).getByRole('button', { name: /Name/ });

    const ascending = names();
    expect(ascending[0]).toContain('GAMCO-STR-001');

    fireEvent.click(header);
    expect(within(files).getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(names()).toEqual([...ascending].reverse());

    fireEvent.click(header);
    expect(names()).toEqual(ascending);
  });

  it('sorts on a column other than the name without losing folders-first order', () => {
    const { store, files } = openFiles();
    store.browseTo([]);
    fireEvent.click(within(screen.getByTestId('files-view')).getByRole('button', { name: /Type/ }));
    const rows = Array.from(
      screen.getByTestId('files-view').querySelectorAll('tbody td:nth-child(4)'),
    ).map((c) => c.textContent);
    expect(rows.every((r) => r === 'Folder')).toBe(true);
    expect(files).toBeTruthy();
  });

  it('the toolbar does not repeat the count the status bar already states', () => {
    const { files } = openFiles();
    expect(screen.getByTestId('status-bar')).toHaveTextContent('4 items in Structural');
    expect(files.querySelector('.btools')).not.toHaveTextContent(/\d+ items?$/);
  });
});

describe('Files view — the properties pane', () => {
  it('with nothing selected it describes the folder you are standing in', () => {
    openFiles();
    const pane = screen.getByTestId('file-properties');
    expect(pane).toHaveTextContent('Structural');
    expect(pane).toHaveTextContent('Contains');
    expect(pane).toHaveTextContent('4 files');
    // Its children are listed and are a way into them.
    expect(within(pane).getByRole('button', { name: /GAMCO-STR-002/ })).toBeInTheDocument();
  });

  it('selecting a drawing swaps the pane to that drawing', () => {
    const { files } = openFiles();
    fireEvent.click(within(files).getByText('GAMCO-STR-001 boundary wall'));
    const pane = screen.getByTestId('file-properties');
    expect(pane).toHaveTextContent('DXF file · Structural');
    expect(pane).toHaveTextContent('GAMCO-STR-001');
    expect(pane).toHaveTextContent('Entities');
  });

  it('browsing shows the properties tab alone — Ask and Log are about an open drawing', () => {
    openFiles();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Details']);
    expect(screen.queryByTestId('ask-panel')).not.toBeInTheDocument();
  });

  it('the pane closes from its own header and the title bar brings it back', () => {
    openFiles();
    fireEvent.click(screen.getByRole('button', { name: 'Close the properties pane' }));
    expect(screen.getByTestId('workbench').classList.contains('dock-closed')).toBe(true);
    fireEvent.click(screen.getByTestId('toggle-dock'));
    expect(screen.getByTestId('workbench').classList.contains('dock-closed')).toBe(false);
  });
});
