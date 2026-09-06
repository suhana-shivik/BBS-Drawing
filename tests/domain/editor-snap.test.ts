// Snapping rules — EDITOR_TOOLS_NOTE §5.
//
// SOURCE shipped no tests for the editor at all, which is how five defects
// survived in a 4,700-line machine. The ranking rule below is the one a
// refactor is most likely to "simplify" into nearest-wins, so it is pinned
// first: LOWER RANK ALWAYS WINS, distance only breaks ties WITHIN a rank.
import { describe, expect, it } from 'vitest';
import { BIMModel } from '../../src/core/model';
import type { ProjectData, WallElement } from '../../src/core/types';
import { computeSnap } from '../../src/editor/snap';

function modelWith(walls: WallElement[], gridSpacing = 500): BIMModel {
  const data: ProjectData = {
    id: 'p1',
    name: 'test',
    createdAt: 0,
    modifiedAt: 0,
    levels: [{ id: 'L1', name: 'Level 1', elevation: 0, height: 3000 }],
    elements: walls,
    settings: { unit: 'mm', gridSpacing, snapGrid: true, snapObjects: true },
  };
  return new BIMModel(data);
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

describe('snap ranking (§5)', () => {
  it('an endpoint 120 mm away beats a grid point 2 mm away', () => {
    // grid 500 → a grid node sits at (5000,0); the wall end sits at (5122,0).
    const m = modelWith([wall('w1', 5122, 0, 9000, 0)]);
    // aperture = 12px / scale = 240 mm, so both candidates are in range
    const s = computeSnap(m, 'L1', { x: 5002, y: 0 }, { scale: 0.05 });
    expect(s).not.toBeNull();
    expect(s!.kind).toBe('endpoint');
    expect(s!.point).toEqual({ x: 5122, y: 0 });
  });

  it('falls back to the grid when no object snap is in range', () => {
    const m = modelWith([wall('w1', 90000, 0, 99000, 0)]);
    const s = computeSnap(m, 'L1', { x: 5002, y: 3 }, { scale: 0.05 });
    expect(s!.kind).toBe('grid');
    expect(s!.point).toEqual({ x: 5000, y: 0 });
  });

  it('the aperture is screen-space: zooming in shrinks it in model space', () => {
    const m = modelWith([wall('w1', 5122, 0, 9000, 0)], 0);
    // at scale 0.05 the 120 mm endpoint is inside the 240 mm aperture …
    expect(computeSnap(m, 'L1', { x: 5002, y: 0 }, { scale: 0.05 })?.kind).toBe('endpoint');
    // … at scale 0.5 the aperture is 24 mm and nothing is close enough.
    // gridSpacing 0 falls back to 500 mm, whose node at 5000 is 2 mm away.
    const zoomed = computeSnap(m, 'L1', { x: 5002, y: 0 }, { scale: 0.5 });
    expect(zoomed!.kind).toBe('grid');
  });

  it('ties within a rank are broken by distance', () => {
    const m = modelWith([wall('w1', 5100, 0, 9000, 0), wall('w2', 5040, 0, 9000, 400)], 0);
    const s = computeSnap(m, 'L1', { x: 5000, y: 0 }, { scale: 0.05 });
    expect(s!.kind).toBe('endpoint');
    expect(s!.refId).toBe('w2');
  });

  it('records refId and end on a wall endpoint — associative dimensions need it (§8.7)', () => {
    const m = modelWith([wall('w1', 5000, 0, 9000, 0)], 0);
    const start = computeSnap(m, 'L1', { x: 5010, y: 0 }, { scale: 0.05 });
    expect(start).toMatchObject({ kind: 'endpoint', refId: 'w1', end: 'start' });
    const end = computeSnap(m, 'L1', { x: 8990, y: 0 }, { scale: 0.05 });
    expect(end).toMatchObject({ kind: 'endpoint', refId: 'w1', end: 'end' });
  });

  it('exclude suppresses the geometry being dragged — nothing snaps to itself', () => {
    const m = modelWith([wall('w1', 5000, 0, 9000, 0)], 0);
    const s = computeSnap(m, 'L1', { x: 5010, y: 0 }, {
      scale: 0.05,
      exclude: new Set(['w1']),
    });
    expect(s?.kind).not.toBe('endpoint');
  });

  it('honours the model-side snap flags, not a UI flag (§5, §14.3)', () => {
    const m = modelWith([wall('w1', 5000, 0, 9000, 0)], 500);
    m.settings.snapObjects = false;
    expect(computeSnap(m, 'L1', { x: 5010, y: 0 }, { scale: 0.05 })!.kind).toBe('grid');
    m.settings.snapGrid = false;
    expect(computeSnap(m, 'L1', { x: 5010, y: 0 }, { scale: 0.05 })).toBeNull();
  });
});
