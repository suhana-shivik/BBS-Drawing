// Register tree: folder counts are the number of children, chevron expands in
// place, the folder NAME walks into the Files view.

import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderStudio } from './helpers';
import { demoStudioData } from '../../src/studio/demoData';
import type { RegisterFolderNode } from '../../src/studio/data';

beforeEach(() => localStorage.clear());

describe('register tree', () => {
  it('every folder count equals the number of its children', () => {
    renderStudio();
    const walk = (folders: RegisterFolderNode[]) => {
      folders.forEach((f) => {
        expect(screen.getByTestId(`count-${f.id}`)).toHaveTextContent(String(f.children.length));
        walk(f.children.filter((c): c is RegisterFolderNode => c.kind === 'folder'));
      });
    };
    demoStudioData.groups.forEach((g) => walk(g.folders));
  });

  it('the chevron expands a folder in place without leaving the register', () => {
    renderStudio();
    const chevron = screen.getByRole('button', { name: 'Expand Architectural' });
    fireEvent.click(chevron);
    expect(screen.getByText('GAMCO-ARC-001 site layout plan')).toBeVisible();
    // Still in sheet mode — expanding is not navigation.
    expect(screen.queryByTestId('files-view')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Architectural' }));
    expect(screen.getByText('GAMCO-ARC-001 site layout plan')).not.toBeVisible();
  });

  it('clicking the folder name walks into it in the Files view', () => {
    renderStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Open Architectural in Files' }));
    const files = screen.getByTestId('files-view');
    expect(files).toBeVisible();
    // Breadcrumb ends at the folder we walked into.
    expect(within(files).getByRole('button', { name: 'Architectural' })).toBeInTheDocument();
    expect(screen.getByTestId('status-bar')).toHaveTextContent('2 items in Architectural');
  });

  it('clicking a parsed drawing opens its sheet', () => {
    renderStudio();
    // The name also appears under Superseded (R1) — take the current one.
    fireEvent.click(screen.getAllByText('GAMCO-STR-001 boundary wall')[0]);
    expect(screen.getByTestId('sheet-host')).toBeInTheDocument();
    expect(screen.getByTestId('tb-title')).toHaveTextContent('boundary wall');
  });

  it('file rows carry a revision chip and a state dot', () => {
    renderStudio();
    const row = screen.getAllByText('GAMCO-STR-001 boundary wall')[0].closest('.node')!;
    expect(row.querySelector('.rev')).toHaveTextContent('R2');
    expect(row.querySelector('.state.ok')).toBeInTheDocument();
  });
});
