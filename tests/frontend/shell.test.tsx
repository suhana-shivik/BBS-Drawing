// Shell anatomy: four grid columns always, collapse-to-zero (never
// display:none), and nothing closes without leaving a way back.

import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderStudio } from './helpers';

beforeEach(() => localStorage.clear());

describe('studio shell', () => {
  it('renders the four grid columns: register, stage, dock, rail', () => {
    renderStudio();
    const workbench = screen.getByTestId('workbench');
    expect(workbench.children).toHaveLength(4);
    expect(workbench.querySelector('.tree-pane')).toBeInTheDocument();
    expect(workbench.querySelector('.stage')).toBeInTheDocument();
    expect(workbench.querySelector('.dock')).toBeInTheDocument();
    expect(workbench.querySelector('.dock-rail')).toBeInTheDocument();
  });

  it('the drawing page keeps the whole canvas until the assistant is asked for', () => {
    renderStudio((store) => store.openSheet('gamco'));
    const workbench = screen.getByTestId('workbench');

    // Nothing slides in on its own — but the column is still a column.
    expect(workbench.classList.contains('dock-closed')).toBe(true);
    expect(workbench.querySelector('.dock')).toBeInTheDocument();
    expect(workbench.children).toHaveLength(4);

    const assistant = screen.getByTestId('toggle-assistant');
    expect(assistant).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(assistant);
    expect(workbench.classList.contains('dock-closed')).toBe(false);
    expect(assistant).toHaveAttribute('aria-pressed', 'true');

    // And it closes the same way it opened.
    fireEvent.click(assistant);
    expect(workbench.classList.contains('dock-closed')).toBe(true);
  });

  it('the assistant button belongs to the drawing page — browsing keeps the panel toggle', () => {
    renderStudio((s) => s.openSheet('gamco'));
    expect(screen.getByTestId('toggle-assistant')).toBeInTheDocument();
    expect(screen.queryByTestId('toggle-dock')).toBeNull();
  });

  it('collapsing the dock keeps the element in the grid and leaves the rail as a way back', () => {
    renderStudio((s) => s.setStageMode('files'));
    const workbench = screen.getByTestId('workbench');
    fireEvent.click(screen.getByTestId('toggle-dock'));

    // Collapse = a zero-width track via a class, never removal from the DOM.
    expect(workbench.classList.contains('dock-closed')).toBe(true);
    expect(workbench.querySelector('.dock')).toBeInTheDocument();
    expect(workbench.children).toHaveLength(4);

    // The rail's Detail button is the way back.
    const railButton = screen.getByRole('button', { name: 'Detail' });
    expect(railButton).toBeVisible();
    fireEvent.click(railButton);
    expect(workbench.classList.contains('dock-closed')).toBe(false);
  });

  it('collapsing the register keeps the element and the title-bar toggle stays as the way back', () => {
    renderStudio();
    const workbench = screen.getByTestId('workbench');
    fireEvent.click(screen.getByTestId('toggle-tree'));
    expect(workbench.classList.contains('tree-closed')).toBe(true);
    expect(workbench.querySelector('.tree-pane')).toBeInTheDocument();

    const toggle = screen.getByTestId('toggle-tree');
    expect(toggle).toBeVisible();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(workbench.classList.contains('tree-closed')).toBe(false);
  });

  it('the tool strip appears only where a drawing is open', () => {
    renderStudio();
    // Browsing, the tools have no surface to apply to — no strip at all.
    expect(screen.queryByRole('button', { name: 'Tools' })).toBeNull();
    expect(document.querySelector('.toolstrip')).toBeNull();
  });

  it('the collapsed tool strip keeps its handle and the active tool name on screen', () => {
    renderStudio((store) => store.openSheet('gamco'));
    // DEFECT D4: the strip's own copy says drafting tools are hidden by
    // default "because this is not a drawing tool", and the default now
    // agrees — it starts collapsed.
    const handle = screen.getByRole('button', { name: 'Tools' });
    expect(handle).toBeVisible();
    expect(handle).toHaveAttribute('aria-expanded', 'false');
    // The collapsed strip still names the active tool.
    expect(document.querySelector('.strip-active')).toHaveTextContent('Pan');
    fireEvent.click(handle);
    expect(handle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByTestId('toggle-tools'));
    expect(handle).toHaveAttribute('aria-expanded', 'false');
  });

  it('opening a drawing shows its sheet tab and names it once in the title bar', () => {
    renderStudio((store) => store.openSheet('gamco'));
    expect(screen.getByTestId('tb-title')).toHaveTextContent('GAMCO-STR-001 R2 boundary wall');
    expect(screen.getByTestId('sheet-host')).toBeInTheDocument();
  });

  it('the Files tab swaps the viewport for the browser without unmounting the stage bands', () => {
    renderStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.getByTestId('files-view')).toBeVisible();
    // Status bar goes mode-aware: folder count, no canvas readouts.
    expect(screen.getByTestId('status-bar')).toHaveTextContent(/items in Files/);
    expect(screen.getByTestId('status-bar')).not.toHaveTextContent('GRID');
  });
});
