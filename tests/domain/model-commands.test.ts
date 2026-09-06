import { describe, expect, it, vi } from 'vitest';
import { BIMModel } from '../../src/core/model';
import {
  CommandStack,
  cmdAddElements,
  cmdDeleteElements,
  cmdUpdateElement,
} from '../../src/core/commands';
import { door, projectData, wall } from '../helpers/project';

describe('BIM model and command layer', () => {
  it('batches a transaction into one subscriber notification', () => {
    const model = new BIMModel(projectData());
    const listener = vi.fn();
    model.subscribe(listener);

    model.transaction(() => {
      model.add([wall()]);
      model.add([wall({ id: 'wall-2', start: { x: 0, y: 3000 }, end: { x: 5000, y: 3000 } })]);
    });

    expect(model.all()).toHaveLength(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('undoes and redoes element creation and edits', () => {
    const model = new BIMModel(projectData());
    const stack = new CommandStack();

    stack.run(model, cmdAddElements([wall()], 'Create wall'));
    stack.run(model, cmdUpdateElement('wall-1', { height: 4200 }, 'Raise wall'));
    expect(model.get('wall-1')).toMatchObject({ height: 4200 });

    stack.undo(model);
    expect(model.get('wall-1')).toMatchObject({ height: 3000 });
    stack.undo(model);
    expect(model.get('wall-1')).toBeUndefined();

    stack.redo(model);
    stack.redo(model);
    expect(model.get('wall-1')).toMatchObject({ height: 4200 });
  });

  it('deletes hosted openings with their wall and restores the full relationship on undo', () => {
    const model = new BIMModel(projectData({ elements: [wall(), door()] }));
    const stack = new CommandStack();

    stack.run(model, cmdDeleteElements(['wall-1'], 'Delete wall'));
    expect(model.get('wall-1')).toBeUndefined();
    expect(model.get('door-1')).toBeUndefined();

    stack.undo(model);
    expect(model.get('wall-1')?.type).toBe('wall');
    expect(model.get('door-1')).toMatchObject({ type: 'door', hostWallId: 'wall-1' });
  });

  it('serializes a detached copy rather than leaking mutable model references', () => {
    const model = new BIMModel(projectData({ elements: [wall()] }));
    const json = model.toJSON();
    const exportedWall = json.elements[0];
    if (exportedWall.type !== 'wall') throw new Error('Expected wall');
    exportedWall.start.x = 9999;

    expect(model.get('wall-1')).toMatchObject({ start: { x: 0, y: 0 } });
  });
});
