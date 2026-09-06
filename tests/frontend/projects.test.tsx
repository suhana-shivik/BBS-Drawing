// R1/R2 — projects: boot states (§2.3), the title-bar switcher (§1.3), and the
// audit rule that NOTHING sheet-shaped survives a project switch (§1.2).

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import App from '../../src/App';
import { StudioShell } from '../../src/components/StudioShell';
import { createStudioProject, resetStudioProjectsForTest } from '../../src/studio/projects';
import { StudioDataContext } from '../../src/studio/data';
import { demoStudioData } from '../../src/studio/demoData';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';
import { signedInAdapter } from '../helpers/auth';

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  resetStudioProjectsForTest();
});

describe('boot (§2.3)', () => {
  it('no projects → the Projects home empty state, whose one action is New project', async () => {
    render(<App authAdapter={signedInAdapter()} />);
    await waitFor(() => {
      expect(screen.getByTestId('projects-empty')).toBeTruthy();
    });
    expect(screen.getAllByRole('button', { name: 'New project' }).length).toBeGreaterThan(0);
  });

  it('projects but none open → the card grid, not the shell', async () => {
    await createStudioProject({ name: 'GAMCO Boundary Wall', client: 'GAMCO Infratech' });
    await createStudioProject({ name: 'Second Site' });
    render(<App authAdapter={signedInAdapter()} />);
    await waitFor(() => {
      expect(screen.getByTestId('projects-grid')).toBeTruthy();
    });
    expect(screen.getByText('GAMCO Boundary Wall')).toBeTruthy();
    expect(screen.getByText('Second Site')).toBeTruthy();
    expect(screen.queryByTestId('workbench')).toBeNull();
  });

  it('opening a card lands in the Files view of the shell and names the project in the window title', async () => {
    const p = await createStudioProject({ name: 'GAMCO Boundary Wall' });
    render(<App authAdapter={signedInAdapter()} />);
    await waitFor(() => screen.getByTestId(`project-card-${p.id}`));
    fireEvent.click(screen.getByTestId(`project-card-${p.id}`));
    await waitFor(() => {
      expect(screen.getByTestId('workbench')).toBeTruthy();
    });
    // R2 — Files view is the landing surface; nothing on the canvas.
    expect(screen.getByTestId('files-view')).toBeTruthy();
    await waitFor(() => {
      expect(document.title).toBe('GAMCO Boundary Wall — BIMCAD Studio');
    });
  });
});

describe('project switcher (§1.3)', () => {
  function renderShell() {
    const store = new StudioStore();
    store.openProject('proj-a');
    render(
      <StudioStoreContext.Provider value={store}>
        <StudioDataContext.Provider value={demoStudioData}>
          <StudioShell />
        </StudioDataContext.Provider>
      </StudioStoreContext.Provider>,
    );
    return store;
  }

  it('the project name in the title bar opens the switcher menu', async () => {
    renderShell();
    fireEvent.click(screen.getByTestId('project-switcher'));
    await waitFor(() => {
      expect(screen.getByText('All projects…')).toBeTruthy();
    });
    expect(screen.getByText('New project…')).toBeTruthy();
  });

  it('Ctrl+P opens it too', async () => {
    const store = renderShell();
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    expect(store.getState().ui.switcherOpen).toBe(true);
    await waitFor(() => {
      expect(screen.getByText('All projects…')).toBeTruthy();
    });
  });

  it('All projects… closes the project back to the Projects home state', async () => {
    const store = renderShell();
    fireEvent.click(screen.getByTestId('project-switcher'));
    await waitFor(() => screen.getByText('All projects…'));
    fireEvent.click(screen.getByText('All projects…'));
    expect(store.getState().project.activeId).toBeNull();
    expect(store.getState().project.wantNew).toBe(false);
  });

  it('New project… closes with the new-project form requested', async () => {
    const store = renderShell();
    fireEvent.click(screen.getByTestId('project-switcher'));
    await waitFor(() => screen.getByText('New project…'));
    fireEvent.click(screen.getByText('New project…'));
    expect(store.getState().project.activeId).toBeNull();
    expect(store.getState().project.wantNew).toBe(true);
  });
});

describe('switch isolation (§1.2/§1.4)', () => {
  it('nothing sheet-shaped survives a project switch', () => {
    const store = new StudioStore();
    store.openProject('proj-a');
    store.openSheet('sheet-1');
    store.setSelection({ handles: ['79A47'], memberId: 'TB', source: 'schedule' });
    store.revealFact('wall.total_run');
    expect(store.getState().sheets.open).toEqual(['sheet-1']);

    store.openProject('proj-b');
    const s = store.getState();
    expect(s.project.activeId).toBe('proj-b');
    expect(s.sheets.open).toEqual([]);
    expect(s.sheets.active).toBeNull();
    expect(s.select.handles).toEqual([]);
    expect(s.select.memberId).toBeNull();
    expect(s.spec.reveal).toBeNull();
    expect(s.view.focus).toBeNull();
    expect(s.ui.stageMode).toBe('files');
    expect(s.browse.path).toEqual([]);
    expect(s.history.past).toEqual([]);
  });

  it('closing a project clears the boot record so the next boot lands on the Projects home', () => {
    const store = new StudioStore();
    store.openProject('proj-a', ['f-str']);
    expect(JSON.parse(localStorage.getItem('studio.boot.v1')!)).toEqual({
      lastProjectId: 'proj-a',
      lastFolderPath: ['f-str'],
    });
    store.closeProject();
    expect(JSON.parse(localStorage.getItem('studio.boot.v1')!)).toEqual({
      lastProjectId: null,
      lastFolderPath: [],
    });
  });
});
