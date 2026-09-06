// Keyboard: shortcuts work on the shell and are suppressed while typing.
//
// EDITOR_TOOLS_NOTE §14.2 — ONE KEYBOARD OWNER. The bare-letter tool branch
// that used to live in StudioShell's document handler is gone; the
// EditorController owns the tool letters, listening at the window in the
// CAPTURE phase and consuming what it acts on. That single change is the fix
// for D1 (`R` rotating a ghost AND switching to Room) and D2 (a tool letter
// interrupting typed precision entry), so the assertion that a bare letter
// switches tools now has to travel end-to-end through the editor.

import { describe, expect, it, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { layersFor } from '../../src/studio/store';
import {
  clickOverlay,
  givePaneSize,
  openTestModel,
  renderStudio,
  TEST_LEVEL_ID,
} from './helpers';

beforeEach(() => localStorage.clear());

describe('keyboard shortcuts', () => {
  it('a bare letter switches the active tool — through the controller, with a sheet open', () => {
    givePaneSize(1000, 700);
    openTestModel();
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.setEditorLevel(TEST_LEVEL_ID);
    });
    fireEvent.keyDown(document, { key: 'l' });
    expect(store.getState().ui.activeTool).toBe('line');
    fireEvent.keyDown(document, { key: 'V' });
    expect(store.getState().ui.activeTool).toBe('select');
    // …and the status bar picks up the new tool's hint, not a stale one.
    expect(screen.getByTestId('active-tool')).toHaveTextContent('Select');
  });

  it('D2 — a tool letter cannot interrupt a typed coordinate', () => {
    givePaneSize(1000, 700);
    openTestModel();
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.setEditorLevel(TEST_LEVEL_ID);
    });
    act(() => store.setActiveTool('line'));
    clickOverlay(100, 100);

    // Start typing a length, then reach for the Wall tool mid-entry.
    fireEvent.keyDown(document, { key: '5' });
    fireEvent.keyDown(document, { key: '0' });
    fireEvent.keyDown(document, { key: '0' });
    expect(screen.getByTestId('tool-hint')).toHaveTextContent('Coordinate: 500');
    fireEvent.keyDown(document, { key: 'w' });
    expect(store.getState().ui.activeTool).toBe('line');
    expect(screen.getByTestId('tool-hint')).toHaveTextContent('Coordinate: 500');
  });

  it('the shell no longer owns tool letters — with no editor, a bare letter does nothing', () => {
    const { store } = renderStudio();
    fireEvent.keyDown(document, { key: 'l' });
    expect(store.getState().ui.activeTool).toBe('pan');
  });

  it('"/" focuses the register search', () => {
    renderStudio();
    fireEvent.keyDown(document, { key: '/' });
    expect(screen.getByLabelText('Find a drawing or mark')).toHaveFocus();
  });

  it('shortcuts are suppressed while typing in an input', () => {
    givePaneSize(1000, 700);
    openTestModel();
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.setEditorLevel(TEST_LEVEL_ID);
    });
    const search = screen.getByLabelText('Find a drawing or mark');
    search.focus();
    // The controller bails on an editable target before it reads TOOL_KEYS,
    // so the letter types into the field instead of arming the Line tool.
    fireEvent.keyDown(search, { key: 'l' });
    expect(store.getState().ui.activeTool).toBe('pan');
    // '/' inside the input types a slash, it does not steal focus handling.
    fireEvent.keyDown(search, { key: '/' });
    expect(search).toHaveFocus();
  });

  it('Ctrl+Z undoes the last named entry', () => {
    const { store } = renderStudio((s) => s.openSheet('gamco'));
    act(() => store.setLayer('DIMS', false, 'Dimensions'));
    expect(layersFor(store.getState().view, 'gamco').DIMS).toBe(false);
    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    expect(layersFor(store.getState().view, 'gamco').DIMS).toBe(true);
    // The stack names its entries.
    const future = store.getState().history.future;
    expect(future[future.length - 1]?.label).toBe('hiding Dimensions');
  });

  it('one Ctrl+Z, one visible stack: the editor undoes through the shell history', () => {
    givePaneSize(1000, 700);
    const model = openTestModel();
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.setEditorLevel(TEST_LEVEL_ID);
    });
    act(() => store.setActiveTool('line'));
    clickOverlay(100, 100);
    clickOverlay(300, 100);
    expect(model.all()).toHaveLength(1);
    expect(store.getState().history.past.map((e) => e.label)).toEqual(['Add line']);
    // The controller consumes Ctrl+Z (capture phase) and routes it to the
    // SAME store.undo() the shell's own handler would have called.
    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    expect(model.all()).toHaveLength(0);
    expect(store.getState().history.past).toHaveLength(0);
  });
});
