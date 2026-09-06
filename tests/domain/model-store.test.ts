// The seam between the BIM model and the studio shell: src/core/modelStore.ts
// holds the active model and the command stack, and nothing else. These tests
// pin the three things the shell and the editor depend on — one subscribe
// function that also fires on a model swap, a write path that runs only
// through runCommand, and undo/redo that NAME what they moved.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canRedo,
  canUndo,
  closeModel,
  commandStack,
  getModel,
  maybeModel,
  openModel,
  redo,
  redoLabel,
  revision,
  runCommand,
  subscribe,
  undo,
  undoHistory,
  undoLabel,
} from '../../src/core/modelStore';
import { cmdAddElements, cmdUpdateElement } from '../../src/core/commands';
import { ground, projectData, wall } from '../helpers/project';

afterEach(() => {
  closeModel();
});

describe('the model store seam', () => {
  it('refuses to invent a model when no project is open', () => {
    closeModel();
    expect(maybeModel()).toBeNull();
    expect(() => getModel()).toThrow(/No project is open/);
    expect(canUndo()).toBe(false);
    expect(undoLabel()).toBeNull();
  });

  it('notifies one subscriber on a mutation and again on a model swap', () => {
    openModel(projectData());
    const listener = vi.fn();
    const off = subscribe(listener);

    runCommand(cmdAddElements([wall()], 'Draw wall'));
    const afterCommand = listener.mock.calls.length;
    expect(afterCommand).toBeGreaterThan(0);

    // a fresh model restarts model.version at 0 — revision() must not
    openModel(projectData({ id: 'other' }));
    expect(listener.mock.calls.length).toBeGreaterThan(afterCommand);
    expect(revision()).toBeGreaterThan(0);
    expect(getModel().id).toBe('other');

    off();
    runCommand(cmdAddElements([wall()], 'Draw wall'));
    expect(listener.mock.calls.length).toBeGreaterThan(afterCommand);
  });

  it('names what undo and redo will move', () => {
    openModel(projectData());
    runCommand(cmdAddElements([wall()], 'Draw wall'));
    runCommand(cmdUpdateElement('wall-1', { height: 4200 }, 'Raise wall'));

    expect(undoHistory()).toEqual(['Draw wall', 'Raise wall']);
    expect(undoLabel()).toBe('Raise wall');
    expect(redoLabel()).toBeNull();

    expect(undo()).toBe('Raise wall');
    expect(getModel().get('wall-1')).toMatchObject({ height: 3000 });
    expect(redoLabel()).toBe('Raise wall');
    expect(undoLabel()).toBe('Draw wall');

    expect(redo()).toBe('Raise wall');
    expect(getModel().get('wall-1')).toMatchObject({ height: 4200 });

    expect(undo()).toBe('Raise wall');
    expect(undo()).toBe('Draw wall');
    expect(undo()).toBeNull();
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(true);
  });

  it('clears the stack across a project boundary — undo never reaches the last project', () => {
    openModel(projectData());
    runCommand(cmdAddElements([wall()], 'Draw wall'));
    expect(canUndo()).toBe(true);

    openModel(projectData({ id: 'second' }));
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
    expect(commandStack.history).toEqual([]);
  });

  it('carries the studio project identity through a model round trip', () => {
    openModel(
      projectData({ client: 'Shivik', projectNumber: 'P-104', archived: false }),
    );
    runCommand(cmdAddElements([wall()], 'Draw wall'));

    const saved = getModel().toJSON();
    expect(saved).toMatchObject({ client: 'Shivik', projectNumber: 'P-104', archived: false });
    expect(saved.elements).toHaveLength(1);
    expect(saved.levels[0].id).toBe(ground.id);

    // absent identity stays absent rather than becoming an explicit undefined
    openModel(projectData());
    expect('client' in getModel().toJSON()).toBe(false);
  });
});
