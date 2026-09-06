// The tool state machine — EDITOR_TOOLS_NOTE §3, §6, §8 — and regression
// tests for defects D1, D2 and D5.
//
// SOURCE had no editor tests because the controller could only be built
// against a global app store. It takes an injected EditorHost here, so the
// whole machine can be driven from a fake shell: that inversion is what makes
// these regressions expressible at all.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BIMModel } from '../../src/core/model';
import type { Command } from '../../src/core/commands';
import type { ProjectData, Vec2, WallElement } from '../../src/core/types';
import { EditorController, type EditorOptions } from '../../src/editor/controller';
import type { EditorAppState, EditorHost, EditorStatus } from '../../src/editor/host';
import type { ToolId } from '../../src/editor/tools';

// jsdom without the canvas package: getContext() returns null and the
// controller's draw() bails on a zero-size canvas long before it asks. The
// state machine under test never touches pixels.
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = ((fn: FrameRequestCallback) =>
    setTimeout(() => fn(0), 0) as unknown as number) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;
}

function wall(id: string, x0: number, y0: number, x1: number, y1: number): WallElement {
  return {
    id,
    type: 'wall',
    name: 'Wall',
    levelId: 'L1',
    material: 'brick',
    start: { x: x0, y: y0 },
    end: { x: x1, y: y1 },
    thickness: 230,
    height: 3000,
  };
}

interface Rig {
  ctrl: EditorController;
  model: BIMModel;
  state: EditorAppState;
  commands: Command[];
  toolCalls: ToolId[];
  selections: string[][];
  status: () => EditorStatus;
  statuses: EditorStatus[];
  setTool: (t: ToolId) => void;
  down: (x: number, y: number, init?: MouseEventInit) => void;
  move: (x: number, y: number, init?: MouseEventInit) => void;
  up: (x: number, y: number, init?: MouseEventInit) => void;
  click: (x: number, y: number, init?: MouseEventInit) => void;
  key: (key: string, init?: KeyboardEventInit) => KeyboardEvent;
  dispose: () => void;
}

function rig(opts: { elements?: WallElement[]; options?: EditorOptions } = {}): Rig {
  const data: ProjectData = {
    id: 'p1',
    name: 'test',
    createdAt: 0,
    modifiedAt: 0,
    levels: [{ id: 'L1', name: 'Level 1', elevation: 0, height: 3000 }],
    elements: opts.elements ?? [],
    // snaps off: these tests are about the state machine, and a grid snap
    // would quietly move every point they assert on
    settings: { unit: 'mm', gridSpacing: 500, snapGrid: false, snapObjects: false },
  };
  const model = new BIMModel(data);
  const state: EditorAppState = {
    activeTool: 'select',
    activeLevelId: 'L1',
    selectedIds: [],
    activeCatalogId: null,
    toolOptions: {},
    hiddenLayers: [],
  };
  const commands: Command[] = [];
  const toolCalls: ToolId[] = [];
  const selections: string[][] = [];
  const statuses: EditorStatus[] = [];

  const host: EditorHost = {
    model: () => model,
    state: () => state,
    setSelection: (ids) => {
      selections.push(ids);
      state.selectedIds = ids;
    },
    setActiveTool: (t) => {
      toolCalls.push(t);
      state.activeTool = t;
    },
    runCommand: (cmd) => {
      commands.push(cmd);
      cmd.execute(model);
    },
    undo: () => {},
    redo: () => {},
  };

  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const ctrl = new EditorController(canvas, host, {
    // 1 px per mm, model origin at screen origin: model = (x, -y)
    view: { scale: 1, tx: 0, ty: 0 },
    onStatus: (s) => statuses.push({ ...s }),
    ...opts.options,
  });

  const fire = (type: string, x: number, y: number, init: MouseEventInit = {}): void => {
    canvas.dispatchEvent(
      new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...init }),
    );
  };

  return {
    ctrl,
    model,
    state,
    commands,
    toolCalls,
    selections,
    statuses,
    status: () => statuses[statuses.length - 1] ?? { cursor: null, hint: '' },
    setTool: (t) => {
      state.activeTool = t;
      ctrl.onToolChanged();
    },
    down: (x, y, init) => fire('pointerdown', x, y, init),
    move: (x, y, init) => fire('pointermove', x, y, init),
    up: (x, y, init) => fire('pointerup', x, y, init),
    click: (x, y, init) => {
      fire('pointerdown', x, y, init);
      fire('pointerup', x, y, init);
    },
    key: (key, init) => {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      window.dispatchEvent(e);
      return e;
    },
    dispose: () => {
      ctrl.dispose();
      canvas.remove();
    },
  };
}

let r: Rig;

beforeEach(() => {
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------- §6 angles

describe('angle constraint is per tool, and Shift inverts it (§6)', () => {
  it('a wall chain locks to 45°', () => {
    r = rig();
    r.setTool('wall');
    r.click(0, 0); // start the chain at model (0,0)
    // model (1000, 364) is 20° above +x: nearest 45° step is 0°
    r.move(1000, -364);
    const c = r.status().cursor!;
    expect(c.x).toBeCloseTo(1000, 6);
    expect(c.y).toBeCloseTo(0, 6);
    r.dispose();
  });

  it('a line locks to 15°, not 45° — the increment is per tool', () => {
    r = rig();
    r.setTool('line');
    r.click(0, 0);
    r.move(1000, -364);
    const c = r.status().cursor!;
    // 20° rounds to 15°, so the point leaves the axis
    const t = 1000 * Math.cos(Math.PI / 12) + 364 * Math.sin(Math.PI / 12);
    expect(c.x).toBeCloseTo(t * Math.cos(Math.PI / 12), 6);
    expect(c.y).toBeCloseTo(t * Math.sin(Math.PI / 12), 6);
    r.dispose();
  });

  it('Shift frees the angle — the constraint is on by default', () => {
    r = rig();
    r.setTool('wall');
    r.click(0, 0);
    r.move(1000, -364, { shiftKey: true });
    const c = r.status().cursor!;
    expect(c.x).toBeCloseTo(1000, 6);
    expect(c.y).toBeCloseTo(364, 6);
    // and the hint says so
    expect(r.status().hint).toContain('Shift = free angle');
    r.dispose();
  });

  it('is not armed before the first point, and never for the other tools', () => {
    r = rig();
    r.setTool('wall'); // chain not open yet
    r.move(1000, -364);
    expect(r.status().cursor!.y).toBeCloseTo(364, 6);

    r.setTool('rectangle');
    r.click(0, 0);
    r.move(1000, -364);
    expect(r.status().cursor!.y).toBeCloseTo(364, 6);
    r.dispose();
  });
});

// ------------------------------------------------------- §3 the `two` state

describe('the `two` state commits by its tool field (§3)', () => {
  const cases: [ToolId, (m: BIMModel) => unknown][] = [
    ['line', (m) => m.byType('refline')[0]],
    ['rectangle', (m) => m.byType('refline')[0]],
    ['circle', (m) => m.byType('refline')[0]],
    ['beam', (m) => m.byType('beam')[0]],
    ['slab', (m) => m.byType('slab')[0]],
  ];

  it('six tools share one state and each produces its own element', () => {
    for (const [tool] of cases) {
      r = rig();
      r.setTool(tool);
      r.click(0, 0);
      r.click(2000, -1000);
      expect(r.commands).toHaveLength(1);
      r.dispose();
    }
  });

  it('line → an open 2-point refline; rectangle → a closed 4-point one', () => {
    r = rig();
    r.setTool('line');
    r.click(0, 0);
    r.click(2000, 0);
    const line = r.model.byType('refline')[0] as { points: unknown[]; closed: boolean };
    expect(line.points).toHaveLength(2);
    expect(line.closed).toBe(false);

    r.setTool('rectangle');
    r.click(0, 0);
    r.click(2000, -1000);
    const rect = r.model.byType('refline')[1] as { points: unknown[]; closed: boolean };
    expect(rect.points).toHaveLength(4);
    expect(rect.closed).toBe(true);
    r.dispose();
  });

  it('a circle is stored as 48 points, not a centre and radius (§8.4)', () => {
    r = rig();
    r.setTool('circle');
    r.click(0, 0);
    r.click(2000, 0);
    expect((r.model.byType('refline')[0] as { points: unknown[] }).points).toHaveLength(48);
    r.dispose();
  });

  it('measure is the only tool that creates nothing (§8.7)', () => {
    r = rig();
    r.setTool('measure');
    r.click(0, 0);
    r.click(2000, 0);
    expect(r.commands).toHaveLength(0);
    expect(r.status().hint).toContain('Distance:');
    r.dispose();
  });

  it('refuses a degenerate second click rather than making a 0 mm element', () => {
    r = rig();
    r.setTool('line');
    r.click(1000, 0);
    r.click(1000.5, 0); // < 1 mm
    expect(r.commands).toHaveLength(0);
    r.dispose();
  });

  it('switching tools abandons whatever was half-drawn (§1)', () => {
    r = rig();
    r.setTool('line');
    r.click(0, 0);
    r.setTool('beam'); // onToolChanged() resets the pending op
    r.click(2000, 0); // this is a FIRST click again, not a commit
    expect(r.commands).toHaveLength(0);
    r.dispose();
  });
});

// -------------------------------------------------------------- §8.1 marquee

describe('marquee direction is meaningful (§8.1)', () => {
  it('left→right contains, right→left crosses', () => {
    // 0.01 px/mm, model y=0 at screen y=500; the wall spans model x 0..10000
    const opts = { view: { scale: 0.01, tx: 0, ty: 500 } };

    r = rig({ elements: [wall('w1', 0, 0, 10000, 0)], options: opts });
    r.setTool('select');
    r.down(10, 400); // model (1000, 10000)
    r.move(60, 600);
    r.up(60, 600); // model (6000, -10000) — rect does not contain the wall
    expect(r.selections[r.selections.length - 1]).toEqual([]);
    r.dispose();

    r = rig({ elements: [wall('w1', 0, 0, 10000, 0)], options: opts });
    r.setTool('select');
    r.down(60, 400);
    r.move(10, 600);
    r.up(10, 600); // right→left over the same rect — crossing
    expect(r.selections[r.selections.length - 1]).toEqual(['w1']);
    r.dispose();
  });

  it('says which is which in the hint', () => {
    r = rig();
    r.setTool('select');
    r.down(10, 10);
    r.move(60, 60);
    expect(r.status().hint).toContain('left→right contains, right→left crosses');
    r.dispose();
  });
});

// ------------------------------------------------------- §8.3 transform tools

describe('a degenerate transform gesture commits nothing (§8.3)', () => {
  it('rotate: a second click on the base point yields no transform', () => {
    r = rig({ elements: [wall('w1', 0, 0, 1000, 0)] });
    r.state.selectedIds = ['w1'];
    r.setTool('rotate');
    r.click(0, 0); // base
    r.click(0, 0); // zero-length drag — currentXform() is null
    expect(r.commands).toHaveLength(0);
    r.click(0, -1000); // 90° — now it commits, as one cmdUpdateMany
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].name).toBe('Rotate');
    r.dispose();
  });

  it('scale: a degenerate reference click is ignored, not committed', () => {
    r = rig({ elements: [wall('w1', 0, 0, 1000, 0)] });
    r.state.selectedIds = ['w1'];
    r.setTool('scale');
    r.click(0, 0); // base
    r.click(0, 0); // degenerate reference — refDist stays null
    expect(r.commands).toHaveLength(0);
    r.click(1000, 0); // reference distance = 1000 ("1×")
    expect(r.commands).toHaveLength(0);
    r.click(2000, 0); // target distance = 2000 → factor 2
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].name).toBe('Scale');
    r.dispose();
  });

  it('refuses to start with nothing selected, and says why', () => {
    r = rig({ elements: [wall('w1', 0, 0, 1000, 0)] });
    r.setTool('mirror');
    expect(r.status().hint).toBe('Select objects first, then pick a base point');
    r.click(0, 0);
    r.click(1000, 0);
    expect(r.commands).toHaveLength(0);
    r.dispose();
  });

  it('freezes the id list at the first click (§8.3)', () => {
    r = rig({ elements: [wall('w1', 0, 0, 1000, 0), wall('w2', 0, 2000, 1000, 2000)] });
    r.state.selectedIds = ['w1'];
    r.setTool('rotate');
    r.click(0, 0);
    r.state.selectedIds = ['w1', 'w2']; // selection changes mid-gesture
    r.click(0, -1000);
    // w2 must be untouched — the gesture owns the ids it started with
    expect(r.model.get('w2')).toMatchObject({ start: { x: 0, y: 2000 } });
    r.dispose();
  });
});

// --------------------------------------------------------------- D1, D2, D5

describe('defect D1 — R rotates a ghost without switching to Room', () => {
  it('does not reach a second window listener, and does not change tool', () => {
    r = rig();
    r.setTool('stair');
    // a stand-in for SOURCE's ToolPalette listener: registered on window
    // AFTER the controller, exactly as a later-mounting UI strip would be
    const other = vi.fn();
    window.addEventListener('keydown', other);

    const e = r.key('r');
    expect(r.toolCalls).toEqual([]); // the tool did NOT become Room
    expect(other).not.toHaveBeenCalled(); // stopImmediatePropagation held
    expect(e.defaultPrevented).toBe(true);

    window.removeEventListener('keydown', other);
    r.dispose();
  });

  it('wins against a listener on document, whoever registered first', () => {
    // the shell keeps a document-level keydown handler (StudioShell.tsx) that
    // maps bare letters to tools — the same second owner that caused D1/D2.
    // The controller captures at the window, which is the first position in
    // the propagation path, so registration order cannot decide the winner.
    const shellListener = vi.fn();
    document.addEventListener('keydown', shellListener);
    r = rig();
    r.setTool('stair');
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true }),
    );
    expect(shellListener).not.toHaveBeenCalled();
    expect(r.toolCalls).toEqual([]);
    document.removeEventListener('keydown', shellListener);
    r.dispose();
  });

  it('still reaches the Room tool when no ghost is armed', () => {
    r = rig();
    r.setTool('select');
    r.key('r');
    expect(r.toolCalls).toEqual(['room']);
    r.dispose();
  });

  it('the promise in the hint is now true', () => {
    r = rig();
    r.setTool('furniture');
    r.state.activeCatalogId = 'chair';
    r.ctrl.onToolChanged();
    expect(r.status().hint).toContain('R rotates');
    r.key('r');
    expect(r.toolCalls).toEqual([]);
    r.dispose();
  });
});

describe('defect D2 — a tool letter cannot interrupt typed input', () => {
  it('typing 500 then w keeps the buffer and keeps the tool', () => {
    r = rig();
    r.setTool('wall');
    r.click(0, 0); // a chain is open, so a point is awaited
    const other = vi.fn();
    window.addEventListener('keydown', other);

    r.key('5');
    r.key('0');
    r.key('0');
    expect(r.status().hint).toContain('Coordinate: 500');

    const e = r.key('w'); // reaching for the Wall tool mid-entry
    expect(r.toolCalls).toEqual([]);
    expect(other).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    expect(r.status().hint).toContain('Coordinate: 500');

    window.removeEventListener('keydown', other);
    r.dispose();
  });

  it('Backspace edits the buffer, Enter commits it through the same click path', () => {
    r = rig();
    r.setTool('wall');
    r.click(0, 0);
    r.key('5');
    r.key('0');
    r.key('0');
    r.key('Backspace');
    expect(r.status().hint).toContain('Coordinate: 50');
    r.key('0');
    r.move(1000, 0); // implied direction: +x
    r.key('Enter');
    expect(r.commands).toHaveLength(1);
    expect(r.model.byType('wall')[0]).toMatchObject({ end: { x: 500, y: 0 } });
    r.dispose();
  });

  it('Escape drops the buffer and returns to the mouse', () => {
    r = rig();
    r.setTool('wall');
    r.click(0, 0);
    r.key('5');
    expect(r.status().hint).toContain('Coordinate: 5');
    r.key('Escape');
    expect(r.status().hint).not.toContain('Coordinate');
    r.dispose();
  });
});

describe('defect D5 — Backspace never deletes geometry', () => {
  it('Backspace outside a buffer leaves the selection alone', () => {
    r = rig({ elements: [wall('w1', 0, 0, 1000, 0)] });
    r.state.selectedIds = ['w1'];
    const e = r.key('Backspace');
    expect(r.commands).toHaveLength(0);
    expect(r.model.get('w1')).toBeTruthy();
    // still swallowed, so the browser cannot navigate back
    expect(e.defaultPrevented).toBe(true);
    r.dispose();
  });

  it('Del alone deletes', () => {
    r = rig({ elements: [wall('w1', 0, 0, 1000, 0)] });
    r.state.selectedIds = ['w1'];
    r.key('Delete');
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].name).toBe('Delete');
    expect(r.model.get('w1')).toBeUndefined();
    expect(r.selections[r.selections.length - 1]).toEqual([]);
    r.dispose();
  });
});

// ----------------------------------------------- §8.7 / §12 the snap is kept

describe('the snap that was used is recorded (§8.7, §12)', () => {
  /** dimension over a wall, snapping to both of its endpoints */
  function dimensionOverWall(): Rig {
    const rr = rig({ elements: [wall('w1', 0, 0, 2000, 0)] });
    rr.model.settings.snapObjects = true; // snap flags are MODEL state (§5)
    rr.setTool('dimension');
    return rr;
  }

  it('an endpoint snap makes the dimension associative', () => {
    r = dimensionOverWall();
    r.click(3, 0); // 3 mm from the wall start — inside the 12 px aperture
    r.click(1998, 0); // near the wall end
    r.click(1000, -500); // the offset side
    const dim = r.model.byType('dimension')[0] as {
      anchors?: { elementId: string; end: string }[];
    };
    expect(dim.anchors).toEqual([
      { elementId: 'w1', end: 'start' },
      { elementId: 'w1', end: 'end' },
    ]);
    r.dispose();
  });

  it('empty space makes it a static annotation instead', () => {
    r = dimensionOverWall();
    r.click(0, -9000);
    r.click(2000, -9000);
    r.click(1000, -9500);
    const dim = r.model.byType('dimension')[0] as { anchors?: unknown };
    expect(dim.anchors).toBeUndefined();
    r.dispose();
  });

  // The anchors were being RECORDED and never READ: §8.7 promises "move the
  // wall and the dimension follows", and nothing moved it. It follows now,
  // inside the same command — one undo puts both back (§9).
  it('an anchored dimension follows the wall it is bound to', () => {
    r = dimensionOverWall();
    r.click(3, 0);
    r.click(1998, 0);
    r.click(1000, -500);
    const dim = r.model.byType('dimension')[0] as { id: string; start: Vec2; end: Vec2 };
    expect(dim.start).toEqual({ x: 0, y: 0 });

    // drag the wall 500 mm up the screen — i.e. +500 mm in model y
    r.setTool('select');
    r.model.settings.snapObjects = false;
    r.click(1000, 0); // pick the wall
    r.down(1000, 0);
    r.move(1000, -500);
    r.up(1000, -500);

    const moved = r.model.get('w1') as WallElement;
    expect(moved.start).toEqual({ x: 0, y: 500 });
    const after = r.model.get(dim.id) as { start: Vec2; end: Vec2 };
    expect(after.start).toEqual({ x: 0, y: 500 });
    expect(after.end).toEqual({ x: 2000, y: 500 });

    // ONE command for the wall and the dimension it carries
    const last = r.commands[r.commands.length - 1];
    expect(last.name).toBe('Move');
    last.undo(r.model);
    expect((r.model.get(dim.id) as { start: Vec2 }).start).toEqual({ x: 0, y: 0 });
    r.dispose();
  });

  it('a static dimension stays where it was put', () => {
    r = rig({ elements: [wall('w1', 0, 0, 2000, 0)] });
    r.setTool('dimension');
    r.click(0, 0);
    r.click(2000, 0);
    r.click(1000, -500);
    const dim = r.model.byType('dimension')[0] as { id: string; start: Vec2 };

    r.setTool('select');
    r.click(1000, 0);
    r.down(1000, 0);
    r.move(1000, -500);
    r.up(1000, -500);

    expect((r.model.get('w1') as WallElement).start).toEqual({ x: 0, y: 500 });
    expect((r.model.get(dim.id) as { start: Vec2 }).start).toEqual({ x: 0, y: 0 });
    r.dispose();
  });
});

// ------------------------------------------------------------------ §11 hints

describe('the hint line is per tool AND per phase (§11)', () => {
  it('changes as the rectangle gesture advances', () => {
    r = rig();
    r.setTool('rectangle');
    expect(r.status().hint).toBe('Click the first corner');
    r.click(0, 0);
    expect(r.status().hint).toContain('Click the opposite corner · hold Shift for a square');
    r.dispose();
  });

  it('refuses an invalid host with a sentence, not a silent no-op (§12)', () => {
    r = rig();
    r.setTool('stair'); // no level above
    r.click(0, 0);
    expect(r.commands).toHaveLength(0);
    expect(r.status().hint).toBe('Add a level above first');

    r.setTool('furniture'); // nothing armed in the Library tab
    r.click(0, 0);
    expect(r.commands).toHaveLength(0);
    expect(r.status().hint).toBe('Pick an item from the Library tab');
    r.dispose();
  });

  it('is published to subscribers, and a late subscriber gets the current value', () => {
    r = rig();
    r.setTool('column');
    const seen: string[] = [];
    const off = r.ctrl.onStatus((s) => seen.push(s.hint));
    expect(seen).toEqual(['Click to place column']);
    r.setTool('pan');
    expect(seen[seen.length - 1]).toBe('Drag to pan · scroll to zoom');
    off();
    r.setTool('text');
    expect(seen[seen.length - 1]).toBe('Drag to pan · scroll to zoom'); // unsubscribed
    r.dispose();
  });
});

// ------------------------------------------------------------- the view seam

describe('the host can own the view transform', () => {
  it('adopts a view pushed in by the host', () => {
    r = rig();
    r.ctrl.setView({ scale: 0.5, tx: 100, ty: 200 });
    expect(r.ctrl.getView()).toEqual({ scale: 0.5, tx: 100, ty: 200 });
    r.dispose();
  });

  it('leaves the view alone when the host owns the gestures', () => {
    const seen: unknown[] = [];
    r = rig({
      options: {
        view: { scale: 1, tx: 0, ty: 0 },
        ownsViewGestures: false,
        onViewChanged: (v) => seen.push(v),
      },
    });
    r.setTool('select');
    r.down(10, 10, { button: 1 }); // middle drag
    r.move(200, 200, { button: 1 });
    expect(r.ctrl.getView()).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(seen).toHaveLength(0);
    r.dispose();
  });
});
