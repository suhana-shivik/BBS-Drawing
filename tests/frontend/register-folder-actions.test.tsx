// ============================================================
// Rename and Delete, on the folder's own row in the register.
//
// They already existed in the Files toolbar, behind a selection — which meant
// the folder you were looking at in the tree was not the folder the buttons
// acted on until you had walked into the Files view and clicked it. The tree
// is where a folder is named, so it is where its name is changed.
//
// The rule these tests exist to hold is WHICH folders get the menu. A folder
// someone made is a label they own. "Structural" is not: it is a consequence
// of what its drawings are, and a Rename on it would be renaming a fact about
// the drawings. Same for an Outputs folder, which is a consequence of what has
// been filed. Those get no menu at all — not a disabled one.
// ============================================================
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StudioDataContext, type StudioData, type StudioActions } from '../../src/studio/data';
import { demoStudioData } from '../../src/studio/demoData';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';
import { RegisterPanel } from '../../src/components/RegisterPanel';

afterEach(cleanup);

const actions = () =>
  ({
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    renamePdfBatch: vi.fn(),
    deletePdfBatch: vi.fn(),
  }) as unknown as StudioActions & {
    renameFolder: ReturnType<typeof vi.fn>;
    deleteFolder: ReturnType<typeof vi.fn>;
    renamePdfBatch: ReturnType<typeof vi.fn>;
    deletePdfBatch: ReturnType<typeof vi.fn>;
  };

function renderPanel(acts = actions()) {
  const data: StudioData = {
    ...demoStudioData,
    actions: acts,
    groups: [
      ...demoStudioData.groups,
      {
        id: 'g-folders',
        name: 'Folders',
        folders: [
          { kind: 'folder', id: 'uf_demo', name: 'demofolder', userMade: true, children: [] },
          { kind: 'folder', id: 'pdf-pages-1', name: 'Site survey.pdf', pdfBatchAt: 1234, children: [] },
        ],
      },
    ],
  };
  const store = new StudioStore();
  render(
    <StudioStoreContext.Provider value={store}>
      <StudioDataContext.Provider value={data}>
        <RegisterPanel />
      </StudioDataContext.Provider>
    </StudioStoreContext.Provider>,
  );
  return acts;
}

describe('the folder row menu', () => {
  it('is offered on a folder a person made', () => {
    renderPanel();
    expect(screen.getByTestId('folder-menu-uf_demo')).toBeInTheDocument();
  });

  it('is NOT offered on a derived folder — its name is a fact, not a label', () => {
    renderPanel();
    for (const folder of demoStudioData.groups.flatMap((g) => g.folders)) {
      expect(screen.queryByTestId(`folder-menu-${folder.id}`)).toBeNull();
    }
  });

  it('renames the folder it belongs to', () => {
    const acts = renderPanel();
    vi.spyOn(window, 'prompt').mockReturnValue('  WH-4 package  ');
    fireEvent.click(screen.getByTestId('folder-menu-uf_demo'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }));
    expect(acts.renameFolder).toHaveBeenCalledWith('uf_demo', 'WH-4 package');
  });

  it('does nothing when the rename is cancelled, blank, or unchanged', () => {
    const acts = renderPanel();
    for (const answer of [null, '   ', 'demofolder']) {
      vi.spyOn(window, 'prompt').mockReturnValue(answer);
      fireEvent.click(screen.getByTestId('folder-menu-uf_demo'));
      fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }));
    }
    expect(acts.renameFolder).not.toHaveBeenCalled();
  });

  it('deletes a user folder without a confirmation — it takes nothing with it', () => {
    const acts = renderPanel();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByTestId('folder-menu-uf_demo'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    expect(acts.deleteFolder).toHaveBeenCalledWith('uf_demo');
    // The drawings stay in the register, so there is nothing to warn about.
    expect(confirm).not.toHaveBeenCalled();
  });

  it('DOES confirm a PDF folder — that one really is the imported file', () => {
    const acts = renderPanel();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByTestId('folder-menu-pdf-pages-1'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    expect(confirm).toHaveBeenCalled();
    expect(acts.deletePdfBatch).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId('folder-menu-pdf-pages-1'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    expect(acts.deletePdfBatch).toHaveBeenCalledWith(1234);
  });

  it('opening the menu does not walk into the folder', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('folder-menu-uf_demo'));
    // Walking in is what clicking the NAME does; the menu button is a
    // different gesture on the same row and must not do both.
    expect(screen.getByRole('menuitem', { name: /Rename/ })).toBeInTheDocument();
  });
});
