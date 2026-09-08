// Delete/Rename in the Files toolbar act on the drawing itself, never on a
// Sections folder or a filed output that merely sits beside it in the same
// listing — `entryId` (set only on the register entry's own row, §fileNodeFor
// in src/studio/realData.ts) is what tells the two apart.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { StudioDataContext, type StudioData } from '../../src/studio/data';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';
import { StudioShell } from '../../src/components/StudioShell';

afterEach(cleanup);

function buildData(actions: StudioData['actions']): StudioData {
  return {
    projectName: 'Test project',
    groups: [
      {
        id: 'g-drawings',
        name: 'Drawings',
        folders: [
          {
            kind: 'folder',
            id: 'f-disc-structural',
            name: 'Structural',
            children: [
              {
                kind: 'file',
                id: 'drw-1',
                entryId: 'drw-1',
                name: 'Foundations drawings.dxf',
                rev: 'R0',
                current: true,
                state: 'ok',
                sheetId: 'sh1',
                discipline: 'Structural',
              },
              {
                kind: 'folder',
                id: 'f-sections-doc1',
                name: 'section-Foundations drawings',
                children: [
                  {
                    kind: 'file',
                    id: 'sec:doc1:REGION-01',
                    name: 'REGION-01 · Footing detail',
                    state: 'ok',
                    sheetId: 'sec:doc1:REGION-01',
                    ext: 'dxf',
                  },
                ],
              },
              {
                kind: 'file',
                id: 'artifact-1',
                name: 'Foundations-BBS-v1.xlsx',
                tag: 'v1',
                state: 'ok',
                dockTab: 'bbs',
                artifactId: 'artifact-1',
                ext: 'xlsx',
              },
              {
                kind: 'file',
                id: 'pdf-1',
                pdfId: 'pdf-1',
                name: 'Site photos.pdf',
                state: 'ok',
                sheetId: 'pdf-1',
                ext: 'pdf',
              },
              {
                kind: 'folder',
                id: 'f-pdf-pages-1000',
                name: 'Pages — harness2.pdf',
                meta: '3 pages',
                pdfBatchAt: 1000,
                children: [
                  { kind: 'file', id: 'pdf-p1', pdfId: 'pdf-p1', name: 'Page 1', state: 'ok', sheetId: 'pdf-p1', ext: 'pdf' },
                  { kind: 'file', id: 'pdf-p2', pdfId: 'pdf-p2', name: 'Page 2', state: 'ok', sheetId: 'pdf-p2', ext: 'pdf' },
                  { kind: 'file', id: 'pdf-p3', pdfId: 'pdf-p3', name: 'Page 3', state: 'ok', sheetId: 'pdf-p3', ext: 'pdf' },
                ],
              },
            ],
          },
        ],
      },
    ],
    sheets: {},
    scheduleRows: [],
    scheduleVersion: '—',
    ...(actions ? { actions } : {}),
  };
}

function mount(actions: StudioData['actions']) {
  const store = new StudioStore();
  store.openProject('proj-test', ['f-disc-structural']);
  render(
    <StudioStoreContext.Provider value={store}>
      <StudioDataContext.Provider value={buildData(actions)}>
        <StudioShell />
      </StudioDataContext.Provider>
    </StudioStoreContext.Provider>,
  );
  return { store, files: screen.getByTestId('files-view') };
}

const noopActions = (): StudioData['actions'] => ({
  importDrawing: vi.fn(),
  downloadArtifact: vi.fn(),
  deleteDrawing: vi.fn(),
  renameDrawing: vi.fn(),
  deleteArtifact: vi.fn(),
  deletePdf: vi.fn(),
  renamePdf: vi.fn(),
  deletePdfBatch: vi.fn(),
  renamePdfBatch: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  fileInFolder: vi.fn(),
  moveToFolder: vi.fn(),
    bbsEditorGrid: vi.fn(() => null),
    saveBbsEdits: vi.fn(async () => null),
});

function renameButton() {
  return screen.getByRole('button', { name: /rename/i });
}
function deleteButton() {
  return screen.getByRole('button', { name: /delete/i });
}

describe('Files toolbar — Rename and Delete', () => {
  it('are disabled with nothing selected', () => {
    mount(noopActions());
    expect(renameButton()).toBeDisabled();
    expect(deleteButton()).toBeDisabled();
  });

  it('stay disabled for a Sections folder — it is a projection, not a register entry', () => {
    const { files } = mount(noopActions());
    fireEvent.click(within(files).getByText('section-Foundations drawings'));
    expect(renameButton()).toBeDisabled();
    expect(deleteButton()).toBeDisabled();
  });

  it('a filed BBS output cannot be renamed (its name is computed, not stored) but can be deleted on its own', () => {
    const actions = noopActions()!;
    const { files } = mount(actions);
    fireEvent.click(within(files).getByText('Foundations-BBS-v1.xlsx'));
    expect(renameButton()).toBeDisabled();
    expect(deleteButton()).not.toBeDisabled();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(deleteButton());
    expect(actions.deleteArtifact).toHaveBeenCalledWith('artifact-1');
    expect(actions.deleteDrawing).not.toHaveBeenCalled();
  });

  it('enable for the drawing row and call renameDrawing/deleteDrawing with its entry id', () => {
    const actions = noopActions()!;
    const { files } = mount(actions);
    fireEvent.click(within(files).getByText('Foundations drawings.dxf'));

    expect(renameButton()).not.toBeDisabled();
    expect(deleteButton()).not.toBeDisabled();

    vi.spyOn(window, 'prompt').mockReturnValue('Renamed foundations.dxf');
    fireEvent.click(renameButton());
    expect(actions.renameDrawing).toHaveBeenCalledWith('drw-1', 'Renamed foundations.dxf');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(deleteButton());
    expect(actions.deleteDrawing).toHaveBeenCalledWith('drw-1');
  });

  it('a PDF page can be renamed and deleted on its own', () => {
    const actions = noopActions()!;
    const { files } = mount(actions);
    fireEvent.click(within(files).getByText('Site photos.pdf'));

    expect(renameButton()).not.toBeDisabled();
    expect(deleteButton()).not.toBeDisabled();

    vi.spyOn(window, 'prompt').mockReturnValue('Site photos — revised.pdf');
    fireEvent.click(renameButton());
    expect(actions.renamePdf).toHaveBeenCalledWith('pdf-1', 'Site photos — revised.pdf');
    expect(actions.renameDrawing).not.toHaveBeenCalled();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(deleteButton());
    expect(actions.deletePdf).toHaveBeenCalledWith('pdf-1');
    expect(actions.deleteDrawing).not.toHaveBeenCalled();
    expect(actions.deleteArtifact).not.toHaveBeenCalled();
  });

  it('a multi-page PDF\'s Pages/ folder can be renamed and deleted as a whole — the folder IS the file', () => {
    const actions = noopActions()!;
    const { files } = mount(actions);
    fireEvent.click(within(files).getByText('Pages — harness2.pdf'));

    expect(renameButton()).not.toBeDisabled();
    expect(deleteButton()).not.toBeDisabled();

    vi.spyOn(window, 'prompt').mockReturnValue('harness2 — revised.pdf');
    fireEvent.click(renameButton());
    expect(actions.renamePdfBatch).toHaveBeenCalledWith(1000, 'harness2 — revised.pdf');
    expect(actions.renamePdf).not.toHaveBeenCalled();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(deleteButton());
    expect(actions.deletePdfBatch).toHaveBeenCalledWith(1000);
    expect(actions.deletePdf).not.toHaveBeenCalled();
    expect(actions.deleteFolder).not.toHaveBeenCalled();
  });

  it('a declined confirm does not call deleteDrawing', () => {
    const actions = noopActions()!;
    const { files } = mount(actions);
    fireEvent.click(within(files).getByText('Foundations drawings.dxf'));

    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(deleteButton());
    expect(actions.deleteDrawing).not.toHaveBeenCalled();
  });

  it('a blank rename does not call renameDrawing', () => {
    const actions = noopActions()!;
    const { files } = mount(actions);
    fireEvent.click(within(files).getByText('Foundations drawings.dxf'));

    vi.spyOn(window, 'prompt').mockReturnValue('   ');
    fireEvent.click(renameButton());
    expect(actions.renameDrawing).not.toHaveBeenCalled();
  });
});
