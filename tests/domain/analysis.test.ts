import { describe, expect, it } from 'vitest';
import { BIMModel } from '../../src/core/model';
import type { RoomElement, SlabElement, WallElement } from '../../src/core/types';
import { computeQuantities } from '../../src/analysis/quantities';
import { detectRoomBoundary } from '../../src/analysis/rooms';
import { validateModel } from '../../src/analysis/validation';
import { door, ground, projectData, wall, windowElement } from '../helpers/project';

describe('derived BIM analysis', () => {
  it('computes net wall volume after hosted openings and includes slab/room quantities', () => {
    const slab: SlabElement = {
      id: 'slab-1',
      type: 'slab',
      name: 'Ground Slab',
      levelId: ground.id,
      outline: [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 4000 }, { x: 0, y: 4000 }],
      thickness: 150,
    };
    const room: RoomElement = {
      id: 'room-1',
      type: 'room',
      name: 'Room',
      number: '101',
      levelId: ground.id,
      boundary: slab.outline,
    };
    const model = new BIMModel(projectData({ elements: [wall(), door(), windowElement(), slab, room] }));

    const report = computeQuantities(model);
    const walls = report.rows.find((row) => row.label === 'Walls');
    const slabs = report.rows.find((row) => row.label === 'Slabs');
    const rooms = report.rows.find((row) => row.label === 'Rooms');

    expect(walls).toMatchObject({ count: 1, length: 5000, area: 15_000_000 });
    expect(walls?.volume).toBe(2_340_000_000);
    expect(slabs).toMatchObject({ count: 1, area: 20_000_000, volume: 3_000_000_000 });
    expect(rooms).toMatchObject({ count: 1, area: 20_000_000, volume: 60_000_000_000 });
  });

  it('detects an enclosed room boundary and rejects an exterior point', () => {
    const walls: WallElement[] = [
      wall({ id: 'south', start: { x: 0, y: 0 }, end: { x: 5000, y: 0 } }),
      wall({ id: 'east', start: { x: 5000, y: 0 }, end: { x: 5000, y: 4000 } }),
      wall({ id: 'north', start: { x: 5000, y: 4000 }, end: { x: 0, y: 4000 } }),
      wall({ id: 'west', start: { x: 0, y: 4000 }, end: { x: 0, y: 0 } }),
    ];
    const model = new BIMModel(projectData({ elements: walls }));

    const boundary = detectRoomBoundary(model, ground.id, { x: 2500, y: 2000 });
    expect(boundary).not.toBeNull();
    expect(boundary!.length).toBeGreaterThanOrEqual(4);
    expect(detectRoomBoundary(model, ground.id, { x: 6000, y: 2000 })).toBeNull();
  });

  it('reports orphan and out-of-bounds openings plus missing levels', () => {
    const model = new BIMModel(projectData({
      elements: [
        wall(),
        door({ id: 'orphan', hostWallId: 'missing-wall' }),
        windowElement({ id: 'overrun', offset: 4900, width: 1000 }),
        wall({ id: 'bad-level', levelId: 'missing-level' }),
      ],
    }));

    const messages = validateModel(model).map((issue) => issue.message);
    expect(messages.some((message) => message.includes('has no host wall'))).toBe(true);
    expect(messages.some((message) => message.includes('extends beyond the end'))).toBe(true);
    expect(messages.some((message) => message.includes('level that does not exist'))).toBe(true);
  });
});
