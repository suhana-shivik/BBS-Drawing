// Shared mounting helper for studio shell tests.

import React from 'react';
import { afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

// Without vitest globals, RTL cannot self-register its cleanup.
afterEach(cleanup);
import type { BIMModel } from '../../src/core/model';
import type { ProjectData } from '../../src/core/types';
import { StudioDataContext } from '../../src/studio/data';
import { demoStudioData } from '../../src/studio/demoData';
import { closeEditorModel, openEditorModel } from '../../src/studio/editorHost';
import { StudioStore, StudioStoreContext } from '../../src/studio/store';
import { StudioShell } from '../../src/components/StudioShell';

export function renderStudio(prepare?: (store: StudioStore) => void) {
  const store = new StudioStore();
  prepare?.(store);
  const utils = render(
    <StudioStoreContext.Provider value={store}>
      <StudioDataContext.Provider value={demoStudioData}>
        <StudioShell />
      </StudioDataContext.Provider>
    </StudioStoreContext.Provider>,
  );
  return { store, ...utils };
}

// --- the BIM model the drafting tools write into ---------------------------
//
// `src/core/modelStore` is a module singleton, exactly as the app uses it, so
// a test opens and closes it around itself. Without a model open the editor
// deliberately does nothing — that is the "no project model is open" state the
// status bar reports, not a broken test setup.

export const TEST_LEVEL_ID = 'lvl-test';

export function openTestModel(patch: Partial<ProjectData> = {}): BIMModel {
  return openEditorModel({
    id: 'proj-test',
    name: 'Test project',
    createdAt: 0,
    modifiedAt: 0,
    levels: [{ id: TEST_LEVEL_ID, name: 'Ground Floor', elevation: 0, height: 3000 }],
    elements: [],
    // Snapping off by default so a test's click lands where the test put it.
    settings: { unit: 'mm', gridSpacing: 500, snapGrid: false, snapObjects: false },
    ...patch,
  });
}

afterEach(() => closeEditorModel());

/**
 * jsdom has no layout, so every getBoundingClientRect is 0×0 and the viewport
 * cannot derive a view to hand the editor. Give the pane a size for the length
 * of one test. Returns the restore function; also restored by `afterEach`.
 */
let restoreRects: (() => void) | null = null;

export function givePaneSize(width = 1000, height = 700): void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  restoreRects = () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

afterEach(() => {
  restoreRects?.();
  restoreRects = null;
});

// --- pointer events on the editor overlay ----------------------------------
//
// jsdom has no `PointerEvent`, and testing-library's `fireEvent.pointerDown`
// then falls back to an event carrying no `button` — which the controller
// reads as "not the left button" and ignores. A MouseEvent carries clientX,
// clientY and button, and the controller's listeners are plain `pointerdown`
// listeners, so dispatching one under that type is what a browser delivers.

export function pointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  button = 0,
): void {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button,
  });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  fireEvent(target, ev);
}

export function overlayCanvas(): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>('canvas.editor-overlay');
  if (!canvas) throw new Error('the editor overlay is not mounted');
  return canvas;
}

/** One tool click on the overlay: hover, press, release at the same point. */
export function clickOverlay(x: number, y: number): void {
  const canvas = overlayCanvas();
  pointer(canvas, 'pointermove', x, y);
  pointer(canvas, 'pointerdown', x, y);
  pointer(canvas, 'pointerup', x, y);
}
