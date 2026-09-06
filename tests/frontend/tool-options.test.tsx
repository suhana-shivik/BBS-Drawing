// Arming the tools — the half of EDITOR_TOOLS_NOTE the shell did not have.
//
// The controller always read what a tool was armed with; nothing could write
// it. These tests hold the two ends together:
//   §8.4  a drafting primitive lands on the ACTIVE CAD LAYER, not always "0"
//   §8.5  size precedence — catalogue item → tool option → DEFAULTS
//   §8.6  the Library is what makes Furniture placeable at all;
//         "Add level above" is what makes Stair placeable at all
//   §5    GRID snaps to a spacing somebody chose
//   §11   the hint follows a pick made in a PANEL, not only a pointer event

import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { DoorElement, FurnitureElement, RefLineElement, StairElement, WallElement } from '../../src/core/types';
import { clickOverlay as clickAt, givePaneSize, openTestModel, renderStudio, TEST_LEVEL_ID } from './helpers';

beforeEach(() => localStorage.clear());

function renderArmed() {
  givePaneSize(1000, 700);
  const model = openTestModel();
  const utils = renderStudio((s) => {
    s.openSheet('gamco');
    s.setEditorLevel(TEST_LEVEL_ID);
    // the strip is collapsed by default (D4), and `toolsOpen` is persisted
    if (!s.getState().ui.toolsOpen) s.toggleTools();
  });
  return { model, ...utils };
}

function pickTool(name: string) {
  fireEvent.click(screen.getByLabelText(name));
}

/** Type into an arming field and commit it the way Enter does. */
function setField(label: string, value: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  return input;
}

function hint(): string {
  return screen.getByTestId('tool-hint').textContent ?? '';
}

/**
 * Open the Library the way the arming row does: its "Pick an item…" button
 * asks for the `library` dock tab — a tab of its own, to the right of Ask.
 * One path from the refusal to the fix.
 */
function openLibrary() {
  fireEvent.click(screen.getByTestId('armed-item'));
}

/** Draw one wall across the middle of the canvas and leave the chain. */
function drawWall() {
  pickTool('Wall');
  clickAt(200, 200);
  clickAt(600, 200);
  pickTool('Select'); // switching tools abandons the chain (§1)
}

describe('the arming row', () => {
  it('is under the strip only when the strip is open and a model is there to arm', () => {
    givePaneSize(1000, 700);
    // sheet open, NO model: the flags have nowhere to live and neither do the
    // options — the status bar already says why.
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.toggleTools();
    });
    expect(screen.queryByTestId('tool-options')).toBeNull();

    openTestModel();
    store.setEditorLevel(TEST_LEVEL_ID);
    // a model arriving is a store change away; re-render by toggling the strip
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    expect(screen.getByTestId('tool-options')).toBeInTheDocument();
  });

  it('arms the Wall tool with a thickness the drawn wall actually carries', () => {
    const { model, store } = renderArmed();
    pickTool('Wall');

    setField('Thickness (mm)', '115');
    expect(store.getState().editor.toolOptions.wallThickness).toBe(115);

    clickAt(200, 200);
    clickAt(600, 200);
    const wall = model.all().find((el): el is WallElement => el.type === 'wall');
    expect(wall?.thickness).toBe(115);
    expect(wall?.height).toBe(3000); // untouched fields keep the default
  });

  it('clamps a typo into the field range rather than putting it into geometry', () => {
    const { store } = renderArmed();
    pickTool('Wall');
    setField('Thickness (mm)', '23000'); // 230 with a slipped finger; max is 2000
    expect(store.getState().editor.toolOptions.wallThickness).toBe(2000);
  });

  it('§8.4 — a drafting primitive lands on the active CAD layer', () => {
    const { model } = renderArmed();
    pickTool('Rectangle');

    fireEvent.change(screen.getByLabelText('Active layer'), { target: { value: 'GRND' } });
    clickAt(150, 150);
    clickAt(450, 350);

    const ref = model.all().find((el): el is RefLineElement => el.type === 'refline');
    expect(ref?.name).toBe('Rectangle');
    expect(ref?.layer).toBe('GRND');
  });

  it('§5 — the grid spacing GRID snaps to is a number somebody can set', () => {
    const { model } = renderArmed();
    fireEvent.change(screen.getByLabelText('Grid spacing (mm)'), { target: { value: '250' } });
    expect(model.settings.gridSpacing).toBe(250);
  });
});

describe('the Library arms the tools that cannot work without it (§8.6)', () => {
  it('Furniture refuses until an item is picked, then places that item', () => {
    const { model } = renderArmed();
    pickTool('Furniture');
    expect(hint()).toContain('Pick an item from the Library tab');

    clickAt(300, 300);
    expect(model.all()).toHaveLength(0); // it really did refuse

    // The arming row points at the Library, and the Library arms the tool.
    openLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'Armchair' }));

    // Picking arms the tool that places it — §11: the hint follows a pick made
    // in a panel, with no pointer event on the canvas.
    expect(screen.getByTestId('active-tool')).toHaveTextContent('Furniture');
    expect(hint()).toContain('R rotates');

    clickAt(300, 300);
    const f = model.all().find((el): el is FurnitureElement => el.type === 'furniture');
    expect(f?.name).toBe('Armchair');
    expect(f?.catalogId).toBe('armchair');
    expect(f?.levelId).toBe(TEST_LEVEL_ID);
  });

  it('§8.5 — a catalogue item outranks the tool option, and the field says so', () => {
    const { model } = renderArmed();
    drawWall();

    // armed by the field: 1100 mm
    pickTool('Door');
    setField('Width (mm)', '1100');
    clickAt(400, 200);
    const first = model.all().filter((el): el is DoorElement => el.type === 'door');
    expect(first).toHaveLength(1);
    expect(first[0].width).toBe(1100);

    // armed by the catalogue: 750 mm, and the field stops pretending to matter
    openLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'Narrow Door 750' }));
    expect(screen.getByTestId('active-tool')).toHaveTextContent('Door');
    const width = screen.getByLabelText('Width (mm)') as HTMLInputElement;
    expect(width).toBeDisabled();
    expect(width.value).toBe('750');

    clickAt(400, 200);
    const doors = model.all().filter((el): el is DoorElement => el.type === 'door');
    expect(doors).toHaveLength(2);
    expect(doors[1].width).toBe(750);
    expect(doors[1].height).toBe(2100);
    expect(doors[1].name).toBe('Narrow Door 750');
  });

  it('clearing the armed item hands the size back to the field', () => {
    renderArmed();
    pickTool('Door');
    openLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'Narrow Door 750' }));
    expect(screen.getByLabelText('Width (mm)')).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Clear the armed library item'));
    const width = screen.getByLabelText('Width (mm)') as HTMLInputElement;
    expect(width).toBeEnabled();
    expect(width.value).toBe('900'); // back to DEFAULTS.doorWidth
  });
});

describe('the level control (§8.6)', () => {
  it('Stair refuses until there is a storey above, and "Add level above" is that storey', () => {
    const { model, store } = renderArmed();
    pickTool('Stair');
    expect(hint()).toBe('Add a level above first');
    clickAt(300, 300);
    expect(model.all()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('level-picker'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Add level above/ }));

    expect(model.levels).toHaveLength(2);
    const above = model.levelAbove(TEST_LEVEL_ID);
    expect(above?.elevation).toBe(3000);
    // one named entry on the visible history, like any other command (§9)
    expect(store.getState().history.past.map((e) => e.label)).toEqual(['Add level']);

    expect(hint()).toContain('Click to place stair');
    clickAt(300, 300);
    const stair = model.all().find((el): el is StairElement => el.type === 'stair');
    expect(stair?.levelId).toBe(TEST_LEVEL_ID);
    expect(stair?.toLevelId).toBe(above?.id);
  });

  it('switching level switches what the tools draw on', () => {
    const { model, store } = renderArmed();
    fireEvent.click(screen.getByTestId('level-picker'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Add level above/ }));
    const above = model.levelAbove(TEST_LEVEL_ID)!;

    fireEvent.click(screen.getByTestId('level-picker'));
    // the accessible name carries the elevation hint too, so match loosely
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(above.name) }));
    expect(store.getState().editor.levelId).toBe(above.id);

    pickTool('Line');
    clickAt(200, 200);
    clickAt(500, 200);
    const ref = model.all().find((el): el is RefLineElement => el.type === 'refline');
    expect(ref?.levelId).toBe(above.id);
  });
});
