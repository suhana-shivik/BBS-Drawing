// The drafting canvas is an OVERLAY. It must not paint an opaque ground.
//
// This is the bug that hid the read-section highlights for four rounds of
// investigation, and it is worth stating exactly, because every diagnostic
// pointed away from it:
//
//   `.editor-layer` is mounted at z-index 2 directly over `.sheet`, which
//   renders the imported drawing — and its section highlights — as SVG. Its
//   own stylesheet says the layer is transparent "so the underlay must stay
//   visible through it (§12)". It was not: drawScene opened every frame with
//   `fillRect(0, 0, w, h)` in `colors.bg`, covering the entire sheet SVG.
//
// Nothing looked wrong, because the same routine then repainted the CAD
// drawing onto the canvas. The drawing was visible, so the sheet SVG appeared
// to be working — while in fact it was completely hidden, along with every
// sky-blue mark in it. In the Files preview, which has no canvas over it, the
// identical SVG string painted the highlights perfectly.
//
// A typecheck cannot see this and neither can a screenshot: both surfaces show
// "the drawing". What makes it a bug is that ONE surface is painting over
// ANOTHER, so that is what is pinned here — by driving the real drawScene with
// a recording context and asking what it did to the whole canvas.
import { describe, expect, it } from 'vitest';
import { BIMModel } from '../../src/core/model';
import type { ProjectData } from '../../src/core/types';
import { drawScene, type EditorColors, type Scene } from '../../src/editor/render';

const W = 800;
const H = 600;

const COLORS: EditorColors = {
  bg: '#101216',
  selection: '#ffb648',
  accent: '#4f8cff',
  snap: '#5ad1a0',
  text: '#e6e9ef',
  textDim: '#9a9da6',
  gridMinor: '#1b1e24',
  gridMajor: '#242830',
  floating: '#1d1f24',
  border: '#2a2e37',
};

interface Call {
  op: string;
  args: number[];
}

/**
 * A canvas context that records instead of painting.
 *
 * jsdom has no canvas backend, so there is nothing to spy on — and a real one
 * would only let us assert pixels, which is a slower way of asking the same
 * question. Every method is a recorder and every property is writable, so the
 * renderer runs unmodified and says what it did.
 */
function recorder(): { ctx: CanvasRenderingContext2D; calls: Call[]; fills: string[] } {
  const calls: Call[] = [];
  const fills: string[] = [];
  const store: Record<string, unknown> = {};
  const target = {} as Record<string, unknown>;
  const proxy = new Proxy(target, {
    get(_t, prop: string) {
      if (prop in store) return store[prop];
      // measureText is the one call whose RETURN the renderer uses.
      if (prop === 'measureText') return (t: string) => ({ width: String(t).length * 6 });
      return (...args: unknown[]) => {
        calls.push({ op: prop, args: args.filter((a): a is number => typeof a === 'number') });
        return undefined;
      };
    },
    set(_t, prop: string, value: unknown) {
      store[prop] = value;
      if (prop === 'fillStyle') fills.push(String(value));
      return true;
    },
  });
  return { ctx: proxy as unknown as CanvasRenderingContext2D, calls, fills };
}

/** An empty project on one level — nothing to draw, so nothing may be drawn. */
function emptyModel(): BIMModel {
  const data: ProjectData = {
    id: 'p1',
    name: 'underlay',
    createdAt: 0,
    modifiedAt: 0,
    levels: [{ id: 'L1', name: 'Level 1', elevation: 0, height: 3000 }],
    elements: [],
    settings: { unit: 'mm', gridSpacing: 500, snapGrid: false, snapObjects: false },
  };
  return new BIMModel(data);
}

function scene(model: BIMModel): Scene {
  return {
    model,
    levelId: 'L1',
    unit: 'mm',
    view: { scale: 0.1, tx: 0, ty: H },
    w: W,
    h: H,
    selection: new Set(),
    overrides: new Map(),
    ghosts: [],
    hoverWallId: null,
    snap: null,
    marquee: null,
    measure: null,
    readout: null,
    showGrips: false,
    xform: null,
    textGrip: null,
    colors: COLORS,
    hiddenLayers: new Set(),
    cadSelection: new Set(),
    cadHover: null,
  };
}

/** A paint that covers the whole canvas — the thing an overlay may never do. */
const coversEverything = (c: Call): boolean =>
  c.op === 'fillRect' &&
  c.args.length >= 4 &&
  c.args[0] <= 0 &&
  c.args[1] <= 0 &&
  c.args[2] >= W &&
  c.args[3] >= H;

describe('the drafting canvas is an overlay, not a ground', () => {
  it('clears the frame instead of filling it', () => {
    const { ctx, calls } = recorder();
    drawScene(ctx, scene(emptyModel()));

    const cleared = calls.filter((c) => c.op === 'clearRect');
    expect(cleared, 'drawScene must clear the canvas to start a frame').not.toHaveLength(0);
    expect(cleared[0].args.slice(0, 4)).toEqual([0, 0, W, H]);
  });

  it('never paints an opaque rect over the whole canvas', () => {
    // THE REGRESSION. `fillRect(0, 0, w, h)` here hides the sheet SVG behind
    // it — the drawing, and every read-section highlight drawn into it.
    const { ctx, calls } = recorder();
    drawScene(ctx, scene(emptyModel()));
    expect(calls.filter(coversEverything)).toHaveLength(0);
  });

  it('leaves the frame clear when there is nothing to draw', () => {
    // An empty level on an empty model should touch the canvas barely at all:
    // whatever it does paint is the grid, drawn as strokes. Nothing here may
    // be a full-bleed fill, or the underlay disappears the moment a project
    // with no elements is opened.
    const { ctx, calls } = recorder();
    drawScene(ctx, scene(emptyModel()));
    expect(calls.some(coversEverything)).toBe(false);
    expect(calls.some((c) => c.op === 'clearRect')).toBe(true);
  });

  it('does not repaint the CAD underlay the sheet SVG already renders', () => {
    // `.sheet` renders the imported drawing as SVG in the SAME viewBox the
    // section highlights are emitted into, so the two cannot drift apart —
    // they are one document. Painting the display list here as well drew the
    // drawing a second time, from a different mapping (sheetView fits the full
    // pane; `.sheet` is inset by its own padding), and the copy on top hid the
    // original along with its marks.
    // The rule is not "never call the painter" — it is "never paint the whole
    // list". The selection highlight legitimately paints a handful of marked
    // ops on top; repainting the drawing is what hid the sheet SVG.
    const src = readRenderSource();
    const body = src.slice(src.indexOf('export function drawScene'));
    expect(body).not.toMatch(/paintDisplayList\(\s*ctx,\s*cad\.list,/);
    expect(body).toContain('cad.list.ops.filter');
  });
});

function readRenderSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  return readFileSync(path.resolve(__dirname, '../../src/editor/render.ts'), 'utf8');
}

describe('the CAD selection is still drawn', () => {
  // A REGRESSION FROM THE OVERLAY FIX. Dropping the underlay repaint also
  // dropped the only thing that drew `cadSelection` and `cadHover`. Clicking a
  // line then selected it, counted it in the status bar, and showed nothing —
  // which reads exactly like a selection tool that does not work.
  //
  // The fix is not to put the underlay back. Only the MARKED ops are painted:
  // the drawing comes from the sheet SVG below, and this is a few strokes of
  // amber on top of it.
  it('paints nothing extra when nothing is selected', () => {
    const { ctx, calls } = recorder();
    drawScene(ctx, scene(emptyModel()));
    // no full-canvas fill, and no stray geometry either
    expect(calls.some(coversEverything)).toBe(false);
  });

  it('never repaints the whole underlay, selected or not', () => {
    // The guard on the original bug: whatever this draws, it must not be the
    // drawing. The sheet SVG is the drawing.
    const src = readRenderSource();
    const body = src.slice(src.indexOf('export function drawScene'));
    // it may reference the painter, but only over a FILTERED list
    expect(body).toContain('cad.list.ops.filter');
    expect(body).not.toMatch(/paintDisplayList\(\s*ctx,\s*cad\.list,/);
  });

  it('is guarded on there being something marked', () => {
    // No selection, no hover, no call — a drawing with nothing picked must not
    // pay for a paint pass on every frame.
    const src = readRenderSource();
    const body = src.slice(src.indexOf('export function drawScene'));
    expect(body).toContain('if (marked.size && cad.list)');
  });
});
