// The 22-tool strip, wired: the shell's ToolStrip / Viewport / StatusBar over
// the real EditorController (src/editor) and the real BIM model
// (src/core/modelStore).
//
// What each block is defending, in the language of EDITOR_TOOLS_NOTE:
//   §14.1  the per-tool, per-phase hint reaches the status bar
//   §14.2  one keyboard owner — the controller (D1/D2 at the shell end)
//   §14.3  the snap flags are MODEL state, so the two surfaces cannot drift
//   D3     one tool table: all 22 nameable in the strip AND the status bar
//   D4     the strip's default agrees with its own copy — collapsed
//   §12    a CAD sheet is an underlay; tools make BIM elements, and where the
//          project lacks what a tool needs the sentence reaches the user

import { describe, expect, it, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { TOOL_DEFS } from '../../src/editor/tools';
import { editorNotice } from '../../src/studio/editorHost';
import { undoHistory } from '../../src/core/modelStore';
import {
  clickOverlay as clickAt,
  givePaneSize,
  openTestModel,
  overlayCanvas,
  pointer,
  renderStudio,
  TEST_LEVEL_ID,
} from './helpers';

beforeEach(() => localStorage.clear());

/** Open a sheet, open the model, size the pane: the editor's live state. */
function renderWithEditor() {
  givePaneSize(1000, 700);
  const model = openTestModel();
  const utils = renderStudio((s) => {
    s.openSheet('gamco');
    s.setEditorLevel(TEST_LEVEL_ID);
  });
  return { model, ...utils };
}

function openStrip() {
  fireEvent.click(screen.getByTestId('toggle-tools'));
}

function hint(): string {
  return screen.getByTestId('tool-hint').textContent ?? '';
}

describe('the tool strip is wired to the editor', () => {
  it('D4 — the strip is collapsed by default and still shows its way back', () => {
    renderStudio((s) => s.openSheet('gamco'));
    const handle = screen.getByRole('button', { name: 'Tools' });
    expect(handle).toHaveAttribute('aria-expanded', 'false');
    // Collapsed, it keeps the handle, the active tool and the snap flags.
    expect(document.querySelector('.strip-active')).toHaveTextContent('Pan');
    expect(screen.getByLabelText('Grid snap')).toBeInTheDocument();
    expect(screen.getByLabelText('Object snap')).toBeInTheDocument();
  });

  it('D3 — all 22 tools name themselves in the strip and in the status bar', () => {
    renderWithEditor();
    openStrip();
    expect(TOOL_DEFS).toHaveLength(22);
    for (const def of TOOL_DEFS) {
      const button = screen.getByLabelText(def.name);
      expect(button).toHaveAttribute('title', `${def.name} · ${def.key}`);
      fireEvent.click(button);
      // The status bar reads the SAME table — no lowercase raw id survives.
      expect(screen.getByTestId('active-tool')).toHaveTextContent(def.name);
      expect(screen.getByTestId('active-tool').textContent).not.toBe(def.id);
    }
  });

  it('§14.1 — a tool button arms the tool and its hint reaches the status bar', () => {
    const { store } = renderWithEditor();
    expect(hint()).toBe('Drag to pan · scroll to zoom');
    openStrip();
    fireEvent.click(screen.getByLabelText('Rectangle'));
    expect(store.getState().ui.activeTool).toBe('rectangle');
    expect(hint()).toContain('Click the first corner');
    // Per PHASE, not just per tool: the second click's hint is different.
    clickAt(120, 120);
    expect(hint()).toContain('hold Shift for a square');
  });

  it('a two-click line draws on the overlay, commits ONE command, and is named in the visible undo history', () => {
    const { store, model } = renderWithEditor();
    openStrip();
    fireEvent.click(screen.getByLabelText('Line'));

    clickAt(100, 100);
    expect(model.all()).toHaveLength(0); // one click is not a line
    clickAt(300, 100);

    const lines = model.all().filter((el) => el.type === 'refline');
    expect(lines).toHaveLength(1);
    expect(lines[0].levelId).toBe(TEST_LEVEL_ID);

    // ONE command on the model stack …
    expect(undoHistory()).toEqual(['Add line']);
    // … and ONE named entry on the shell's visible history: one Ctrl+Z.
    const past = store.getState().history.past;
    expect(past.map((e) => e.label)).toEqual(['Add line']);

    // and that entry really drives the model stack
    act(() => void store.undo());
    expect(model.all()).toHaveLength(0);
    act(() => void store.redo());
    expect(model.all()).toHaveLength(1);
  });

  it('Measure creates nothing and carries the live distance in the hint (§8.7)', () => {
    const { model, store } = renderWithEditor();
    openStrip();
    fireEvent.click(screen.getByLabelText('Measure'));
    clickAt(100, 100);
    pointer(overlayCanvas(), 'pointermove', 300, 100);
    // 200 px at 1/120 px per mm — the mapping is the viewport's own.
    expect(hint()).toBe('Distance: 24000 mm · Type a length, or click');
    // Measure is the one tool that creates nothing, and records nothing.
    expect(model.all()).toHaveLength(0);
    expect(store.getState().history.past).toEqual([]);
  });

  it('§14.3 — GRID writes model settings, and both surfaces read the same flag', () => {
    const { model } = renderWithEditor();
    openStrip();
    expect(model.settings.snapGrid).toBe(false);

    // Toggle it from the strip …
    fireEvent.click(screen.getByLabelText('Grid snap'));
    expect(model.settings.snapGrid).toBe(true);
    expect(screen.getByLabelText('Grid snap')).toHaveAttribute('aria-pressed', 'true');
    // … and the status bar's chip agrees, because it read the model too.
    const barGrid = screen.getByRole('button', { name: 'GRID' });
    expect(barGrid.className).toContain('on');

    // Toggle it back from the status bar; the strip follows.
    fireEvent.click(barGrid);
    expect(model.settings.snapGrid).toBe(false);
    expect(screen.getByLabelText('Grid snap')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'GRID' }).className).not.toContain('on');
  });

  it('§12 — with no model open the strip still arms, and the shell says why nothing draws', () => {
    givePaneSize(1000, 700);
    renderStudio((s) => s.openSheet('gamco'));
    expect(document.querySelector('canvas.editor-overlay')).toBeNull();
    expect(screen.getByTestId('editor-notice')).toHaveTextContent(
      'No project model is open',
    );
    // A snap flag with nowhere to live says so instead of toggling.
    expect(screen.getByLabelText('Grid snap')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'GRID' })).toBeDisabled();
  });

  // `hasGeometry` is the ENTITY COUNT, not `hasModel` (StatusBar reads the
  // count precisely because `hasModel` is false on every DXF sheet and used to
  // call them all raster pages). gamco carries 48,213 entities, so the shell
  // owes it the underlay sentence — the raster branch has no demo sheet to
  // reach it through, so it is pinned on the pure function below instead.
  it('§12 — a CAD sheet is told its underlay is never edited', () => {
    renderWithEditor();
    expect(screen.getByTestId('editor-notice').textContent).toMatch(/never edited/i);
  });

  it('§12 — a raster PDF page says it has nothing to snap to', () => {
    const model = openTestModel();
    expect(editorNotice({ open: true, hasGeometry: false }, model)).toMatch(/no CAD entities/i);
    expect(editorNotice({ open: true, hasGeometry: true }, model)).toMatch(/never edited/i);
    // Nothing open is nothing to say — the bar drops the note entirely.
    expect(editorNotice({ open: false, hasGeometry: false }, model)).toBeNull();
  });

  it('the shell keeps navigation: the overlay is inert under Pan, live under a drawing tool', () => {
    const { store } = renderWithEditor();
    // Pan is the default tool — the shell owns drag-to-pan exactly as before.
    expect(document.querySelector('.editor-layer')?.className).not.toContain('hot');
    act(() => store.setActiveTool('wall'));
    expect(document.querySelector('.editor-layer')?.className).toContain('hot');
  });

  it('section focus framing still works with the overlay mounted', () => {
    // (The amber `data-handle` highlight needs a real imported drawing and is
    //  covered end-to-end in import.test.tsx — the demo SVG carries no
    //  handles, so asserting it here would assert nothing.)
    const { store } = renderWithEditor();
    act(() => store.focusOn('gamco', { xMin: 1000, yMin: 1000, xMax: 4000, yMax: 3000 }));
    // The one-shot request was consumed and turned into a real framing.
    expect(store.getState().view.focus).toBeNull();
    expect(store.getState().view.zoom).not.toBe(1);
  });
});

describe('a tool never accepts a click it cannot map', () => {
  // THE SILENT FAILURE. `Editor2D` takes the view as an OPTIONAL prop, and
  // with none it falls back to its own default mapping — which is not this
  // drawing's. The overlay was hot in that window, so a click was accepted and
  // turned into an element at coordinates with no relation to what is on
  // screen. The tool looked dead: it had drawn something, a long way away.
  //
  // `sheetView` returns null while the pane has no measured size, so the
  // window is the first paint after a sheet opens and any environment with no
  // ResizeObserver. Staying cold through it means the shell pans instead —
  // wrong in a small way rather than silently wrong in a large one.
  function unmeasuredPane() {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
      const zero = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      return { ...zero, toJSON: () => ({}) } as DOMRect;
    };
    return () => {
      Element.prototype.getBoundingClientRect = original;
    };
  }

  it('stays cold while the pane has no size', () => {
    // Composed by hand rather than through `renderWithEditor`, which calls
    // `givePaneSize` and would overwrite the very mock under test.
    openTestModel();
    const restore = unmeasuredPane();
    try {
      const { store } = renderStudio((s) => {
        s.openSheet('gamco');
        s.setEditorLevel(TEST_LEVEL_ID);
      });
      // a drawing tool is chosen and the overlay STILL refuses the click,
      // because it has no mapping to turn that click into a point
      act(() => store.setActiveTool('wall'));
      expect(document.querySelector('.editor-layer')?.className).not.toContain('hot');
    } finally {
      restore();
    }
  });

  it('goes hot again as soon as the pane can be measured', () => {
    // The guard must not become "the editor never works". With a real pane the
    // view resolves and the tool is live, which is what every other test here
    // depends on.
    const { store } = renderWithEditor();
    act(() => store.setActiveTool('wall'));
    expect(document.querySelector('.editor-layer')?.className).toContain('hot');
  });

  it('still creates the element it was asked for', () => {
    // The guard is about WHEN a click is accepted, not whether the tool works.
    const { store, model } = renderWithEditor();
    act(() => store.setActiveTool('line'));
    clickAt(100, 100);
    clickAt(300, 100);
    expect(model.all().filter((el) => el.type === 'refline')).toHaveLength(1);
  });
});
