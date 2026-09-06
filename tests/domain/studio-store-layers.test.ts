// Layer visibility used to be one Record<string, boolean> shared by the whole
// window: hiding CONC while looking at one drawing hid it on every other
// sheet too — one opened later, that had never been touched, went blank for
// a layer nobody ever toggled on it. `layersBySheet` (src/studio/store.ts)
// makes it per-sheet, the same way `frames` already keeps zoom/pan per-sheet.
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LAYERS, layersFor, StudioStore } from '../../src/studio/store';

beforeEach(() => localStorage.clear());

describe('per-sheet layer visibility', () => {
  it('a sheet with no toggles of its own reads as fully visible', () => {
    const store = new StudioStore();
    expect(layersFor(store.getState().view, 'sheet-a')).toBe(DEFAULT_LAYERS);
  });

  it('hiding a layer on one sheet leaves a DIFFERENT sheet untouched', () => {
    const store = new StudioStore();
    store.openSheet('sheet-a');
    store.setLayer('CONC', false, 'Concrete outline');
    expect(layersFor(store.getState().view, 'sheet-a').CONC).toBe(false);

    store.openSheet('sheet-b');
    // Sheet B was never touched — it must not inherit A's hidden layer.
    expect(layersFor(store.getState().view, 'sheet-b').CONC).not.toBe(false);
    expect(layersFor(store.getState().view, 'sheet-b')).toBe(DEFAULT_LAYERS);

    // Switching back, A still remembers its own toggle.
    store.openSheet('sheet-a');
    expect(layersFor(store.getState().view, 'sheet-a').CONC).toBe(false);
  });

  it('Ctrl+Z-style undo restores the toggle on the sheet it was made on, not the one now active', () => {
    const store = new StudioStore();
    store.openSheet('sheet-a');
    store.setLayer('RBAR', false, 'Reinforcement');
    store.openSheet('sheet-b');
    // Undo fires while sheet B is active; it must still undo A's own toggle.
    const label = store.undo();
    expect(label).toBe('hiding Reinforcement');
    expect(layersFor(store.getState().view, 'sheet-a').RBAR).toBe(true);
    expect(layersFor(store.getState().view, 'sheet-b')).toBe(DEFAULT_LAYERS);
  });
});
