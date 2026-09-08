// ============================================================
// A RESTORED PROJECT OPENS ON ITS DRAWING.
//
// Reopening a project put the drawings back in the session and then left the
// canvas empty: the register listed four drawings, the viewport showed bare
// grid, and the only way to see anything was to know to click one. The
// restore's own result was discarded.
//
// It must not go the other way either — reopening a project while someone is
// on a sheet must not yank them back to the first drawing.
// ============================================================
import { describe, expect, it } from 'vitest';
import { StudioStore } from '../../src/studio/store';

/** the shape the restore effect works with, without the React layer around it */
interface Sheet {
  id: string;
  doc: { id: string };
}

/**
 * Exactly what the effect in `realData.ts` does once the restore resolves:
 * open the restored drawing, unless something is already open.
 */
function openRestored(
  store: StudioStore,
  doc: { id: string } | null,
  sheets: Sheet[],
  active: Sheet | null = null,
): void {
  if (!doc) return;
  if (store.getState().sheets.active) return;
  const sheet = sheets.find((s) => s.doc.id === doc.id) ?? active;
  if (sheet) store.openSheet(sheet.id);
}

const store = (): StudioStore => {
  const s = new StudioStore();
  s.openProject('proj-1');
  return s;
};

describe('reopening a project', () => {
  it('opens the drawing it restored, instead of showing bare grid', () => {
    const s = store();
    expect(s.getState().sheets.active).toBeNull();

    openRestored(s, { id: 'doc-a' }, [
      { id: 'sheet-a', doc: { id: 'doc-a' } },
      { id: 'sheet-b', doc: { id: 'doc-b' } },
    ]);

    expect(s.getState().sheets.active).toBe('sheet-a');
    expect(s.getState().sheets.open).toContain('sheet-a');
  });

  it('leaves the sheet a person is already on alone', () => {
    const s = store();
    s.openSheet('sheet-b');

    openRestored(s, { id: 'doc-a' }, [
      { id: 'sheet-a', doc: { id: 'doc-a' } },
      { id: 'sheet-b', doc: { id: 'doc-b' } },
    ]);

    expect(s.getState().sheets.active).toBe('sheet-b');
    expect(s.getState().sheets.open).not.toContain('sheet-a');
  });

  it('falls back to whatever the session made active when the ids do not line up', () => {
    const s = store();
    openRestored(s, { id: 'doc-z' }, [{ id: 'sheet-a', doc: { id: 'doc-a' } }], {
      id: 'sheet-a',
      doc: { id: 'doc-a' },
    });
    expect(s.getState().sheets.active).toBe('sheet-a');
  });

  it('opens nothing when there was nothing to restore', () => {
    const s = store();
    openRestored(s, null, [{ id: 'sheet-a', doc: { id: 'doc-a' } }]);
    expect(s.getState().sheets.active).toBeNull();
    expect(s.getState().sheets.open).toEqual([]);
  });

  it('opens nothing when the restored drawing has no sheet at all', () => {
    const s = store();
    openRestored(s, { id: 'doc-a' }, []);
    expect(s.getState().sheets.active).toBeNull();
  });
});
