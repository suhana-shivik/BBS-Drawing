// The drawing page's window: the corner minimize/maximize pair, the strip's
// drag-to-reorder, and a wheel zoom with nothing in its way.

import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { nextZoom } from '../../src/components/Viewport';
import { zoomLabel } from '../../src/components/SheetStrip';
import { FILES_TAB, SPEC_TAB, tabOrderOf } from '../../src/studio/store';
import { renderStudio } from './helpers';

beforeEach(() => localStorage.clear());

/** Lay the tabs out 100px wide, side by side — jsdom has no layout. */
function layOutTabs(tabs: NodeListOf<HTMLElement> | HTMLElement[]): void {
  Array.from(tabs).forEach((el, i) => {
    el.getBoundingClientRect = () =>
      ({ x: i * 100, left: i * 100, right: i * 100 + 100, width: 100, y: 0, top: 0, bottom: 35, height: 35, toJSON: () => ({}) }) as DOMRect;
  });
}

/**
 * One pointer event on a tab.
 *
 * jsdom has no PointerEvent, and testing-library's `fireEvent.pointerDown`
 * then builds an event carrying neither `button` nor `clientX` — the two
 * things the drag reads. A MouseEvent under the pointer type carries both,
 * which is what a browser delivers anyway.
 */
function pointer(target: HTMLElement, type: string, clientX: number): void {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  fireEvent(target, ev);
}

/**
 * Drag one tab onto another: press, carry, release.
 *
 * `after` drops on the far half of the target, which lands the tab behind it
 * rather than in front.
 */
function dragTab(from: HTMLElement, to: HTMLElement, after = false): void {
  const r = to.getBoundingClientRect();
  const x = after ? r.left + r.width * 0.75 : r.left + r.width * 0.25;
  pointer(from, 'pointerdown', from.getBoundingClientRect().left + 10);
  pointer(from, 'pointermove', x);
  pointer(from, 'pointerup', x);
  fireEvent.click(from);
}

describe('the drawing window controls', () => {
  it('maximize gives up the side panels first, then the window chrome', () => {
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.toggleDock(); // the assistant open, so there is something to give up
    });
    const workbench = screen.getByTestId('workbench');
    const app = document.querySelector('.studio.app') as HTMLElement;
    const maximize = screen.getByTestId('stage-maximize');

    expect(store.getState().ui.treeOpen).toBe(true);
    fireEvent.click(maximize);
    expect(store.getState().ui.treeOpen).toBe(false);
    expect(store.getState().ui.assistantOpen).toBe(false);
    expect(store.getState().ui.maximized).toBe(false);

    fireEvent.click(maximize);
    expect(store.getState().ui.maximized).toBe(true);
    expect(workbench.classList.contains('maximized')).toBe(true);
    expect(app.classList.contains('maximized')).toBe(true);
    expect(maximize).toBeDisabled();
  });

  it('minimize walks back out, and the columns are collapsed, never removed', () => {
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.maximizeStage();
      s.maximizeStage();
    });
    const workbench = screen.getByTestId('workbench');
    expect(store.getState().ui.maximized).toBe(true);
    // §10 — four columns even with the window chrome gone.
    expect(workbench.children).toHaveLength(4);

    const minimize = screen.getByTestId('stage-minimize');
    fireEvent.click(minimize);
    expect(store.getState().ui.maximized).toBe(false);

    fireEvent.click(minimize);
    expect(store.getState().ui.treeOpen).toBe(true);
    expect(store.getState().ui.assistantOpen).toBe(true);
    // Nothing left to give back.
    expect(screen.getByTestId('stage-minimize')).toBeDisabled();
  });

  it('the corner pair is the way back once the last drawing is closed', () => {
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.maximizeStage();
      s.maximizeStage();
      s.closeSheet('gamco');
    });
    expect(store.getState().sheets.active).toBeNull();
    fireEvent.click(screen.getByTestId('stage-minimize'));
    expect(store.getState().ui.maximized).toBe(false);
  });

  it('maximizing belongs to the drawing — Files gets its window chrome back', () => {
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.maximizeStage();
      s.maximizeStage();
    });
    expect(store.getState().ui.maximized).toBe(true);

    // Files renders no viewport, so the corner pair would not be there to
    // click: the override cannot survive the move.
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(store.getState().ui.maximized).toBe(false);
    expect(document.querySelector('.studio.app')?.classList.contains('maximized')).toBe(false);
  });

  it('maximizing does not write the panel flags, so restoring returns what was open', () => {
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.toggleTree(); // register closed, assistant closed — already wide
    });
    fireEvent.click(screen.getByTestId('stage-maximize'));
    expect(store.getState().ui.maximized).toBe(true);
    fireEvent.click(screen.getByTestId('stage-minimize'));
    expect(store.getState().ui.maximized).toBe(false);
    // The register was closed before, and it is closed after.
    expect(store.getState().ui.treeOpen).toBe(false);
  });
});

describe('the sheet strip reorders by drag', () => {
  // Two rounds of this shipped broken in the browser while passing here, both
  // for the same reason: HTML5 drag-and-drop. `draggable` is inert on a
  // <button> in Chromium, and even on a div a dragstart can be refused for
  // reasons the page never sees — while jsdom fires whatever it is told to and
  // the tests stayed green. The reorder runs on pointer events now, which
  // behave the same on every tab, so what is asserted is that every tab
  // carries the same handlers and that a NON-ACTIVE one really moves.
  it('every tab is the same kind of thing — no tab is furniture', () => {
    renderStudio((s) => {
      s.openSheet('gamco');
      s.openSheet('str002');
    });
    const tabs = screen.getByTestId('workbench').querySelectorAll<HTMLElement>('.tab-list .tab');
    layOutTabs(tabs);
    expect(tabs).toHaveLength(4); // Files, Specification, two drawings

    tabs.forEach((tab) => {
      expect(tab.tagName).toBe('DIV');
      expect(tab).toHaveAttribute('role', 'button');
      expect(tab).toHaveAttribute('tabindex', '0');
    });

    // Still reachable by name and by keyboard, which is what the tag cost.
    expect(screen.getByRole('button', { name: 'Files' })).toBe(tabs[0]);
  });

  it('an INACTIVE tab drags — not only the open one', () => {
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.openSheet('str002'); // str002 is the active sheet; the rest are not
    });
    expect(store.getState().sheets.active).toBe('str002');

    const tabs = screen.getByTestId('workbench').querySelectorAll<HTMLElement>('.tab-list .tab');
    layOutTabs(tabs);
    // Specification — not active, not a drawing — dragged past both drawings.
    dragTab(tabs[1], tabs[3], true);

    expect(tabOrderOf(store.getState())).toEqual([FILES_TAB, 'gamco', 'str002', SPEC_TAB]);
    // Dragging is not opening: the active sheet is untouched by the reorder.
    expect(store.getState().sheets.active).toBe('str002');
    expect(store.getState().ui.stageMode).toBe('sheet');
  });

  it('a drag does not also open the tab it started from, but a click still does', () => {
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.openSheet('str002');
    });
    const tabs = screen.getByTestId('workbench').querySelectorAll<HTMLElement>('.tab-list .tab');
    layOutTabs(tabs);

    // Carrying Files across the strip must not land on the Files view.
    dragTab(tabs[0], tabs[2], true);
    expect(store.getState().ui.stageMode).toBe('sheet');

    // A press with no travel is a click, and opens it.
    const files = screen.getByRole('button', { name: 'Files' });
    pointer(files, 'pointerdown', 10);
    pointer(files, 'pointerup', 10);
    fireEvent.click(files);
    expect(store.getState().ui.stageMode).toBe('files');
  });

  it('a tab opens on Enter and on Space, not only on click', () => {
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.openSheet('str002');
    });
    const tabs = screen.getByTestId('workbench').querySelectorAll<HTMLElement>('.tab-list .tab');
    layOutTabs(tabs);
    fireEvent.keyDown(tabs[2], { key: 'Enter' }); // the gamco tab
    expect(store.getState().sheets.active).toBe('gamco');

    fireEvent.keyDown(tabs[0], { key: ' ' }); // Files
    expect(store.getState().ui.stageMode).toBe('files');
  });

  it('a drawing tab can be dragged in front of Files', () => {
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.openSheet('str002');
    });
    expect(tabOrderOf(store.getState())).toEqual([FILES_TAB, SPEC_TAB, 'gamco', 'str002']);

    const tabs = screen.getByTestId('workbench').querySelectorAll<HTMLElement>('.tab-list .tab');
    layOutTabs(tabs);
    const files = tabs[0];
    const str002 = tabs[3];
    dragTab(str002, files);

    expect(tabOrderOf(store.getState())).toEqual(['str002', FILES_TAB, SPEC_TAB, 'gamco']);
  });

  it('Files itself drags — it is a tab, not furniture', () => {
    const { store } = renderStudio((s) => s.openSheet('gamco'));
    const tabs = screen.getByTestId('workbench').querySelectorAll<HTMLElement>('.tab-list .tab');
    layOutTabs(tabs);
    dragTab(tabs[0], tabs[2], true); // Files, dropped after the drawing

    expect(tabOrderOf(store.getState())).toEqual([SPEC_TAB, 'gamco', FILES_TAB]);
  });

  it('the open-sheet order follows the strip, so it stays one list', () => {
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.openSheet('str002');
      s.openSheet('oswl');
    });
    expect(store.getState().sheets.open).toEqual(['gamco', 'str002', 'oswl']);

    store.moveTab('oswl', 'gamco', false);
    expect(store.getState().sheets.open).toEqual(['oswl', 'gamco', 'str002']);
    expect(store.getState().sheets.active).toBe('oswl');
  });

  it('a dragged order survives closing a sheet and opening another', () => {
    const { store } = renderStudio((s) => {
      s.openSheet('gamco');
      s.openSheet('str002');
    });
    store.moveTab('str002', FILES_TAB, false);
    store.closeSheet('gamco');
    store.openSheet('oswl');

    // str002 keeps the front; the new sheet lands at the end; nothing hides.
    expect(tabOrderOf(store.getState())).toEqual(['str002', FILES_TAB, SPEC_TAB, 'oswl']);
  });
});

describe('zoom has no floor and no ceiling', () => {
  it('the wheel keeps going past the old 0.3×–12× fence', () => {
    // 12× was the ceiling and 0.3× the floor; both are ordinary steps now.
    expect(nextZoom(12, 1.12)).toBeCloseTo(13.44, 4);
    expect(nextZoom(0.3, 1 / 1.12)).toBeCloseTo(0.2679, 4);
    expect(nextZoom(4000, 1.12)).toBeCloseTo(4480, 1);
    expect(nextZoom(0.0001, 1 / 1.12)).toBeCloseTo(0.0000893, 7);
  });

  it('but nothing reaches zero, Infinity or NaN', () => {
    expect(nextZoom(1, Infinity)).toBe(1);
    expect(nextZoom(1, NaN)).toBe(1);
    expect(nextZoom(1, 0)).toBe(1);
    expect(nextZoom(1e-6, 1 / 1.12)).toBe(1e-6);
    expect(nextZoom(1e7, 1.12)).toBe(1e7);
  });

  it('the badge stays readable at every scale', () => {
    expect(zoomLabel(1)).toBe('100%');
    expect(zoomLabel(0.5)).toBe('50%');
    // The old badge rounded all of these to "0%".
    expect(zoomLabel(0.037)).toBe('3.7%');
    expect(zoomLabel(0.0004)).toBe('0.04%');
    expect(zoomLabel(250)).toBe('25,000%');
  });

  it('the wheel on the drawing zooms about the pointer', () => {
    const { store } = renderStudio((s) => s.openSheet('gamco'));
    const pane = screen.getByTestId('viewport').querySelector('.pane') as HTMLElement;

    for (let i = 0; i < 40; i += 1) fireEvent.wheel(pane, { deltaY: -100, clientX: 0, clientY: 0 });
    // 1.12^40 ≈ 93 — far past the old ceiling of 12.
    expect(store.getState().view.zoom).toBeGreaterThan(80);

    for (let i = 0; i < 100; i += 1) fireEvent.wheel(pane, { deltaY: 100, clientX: 0, clientY: 0 });
    // …and far below the old floor of 0.3.
    expect(store.getState().view.zoom).toBeLessThan(0.01);
  });
});
