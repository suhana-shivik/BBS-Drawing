import type {
  DoorElement,
  Level,
  ProjectData,
  WallElement,
  WindowElement,
} from '../../src/core/types';

export const ground: Level = {
  id: 'level-ground',
  name: 'Ground Floor',
  elevation: 0,
  height: 3000,
};

export function projectData(overrides: Partial<ProjectData> = {}): ProjectData {
  return {
    id: 'project-test',
    name: 'Test Project',
    createdAt: 1,
    modifiedAt: 1,
    levels: [ground],
    elements: [],
    settings: {
      unit: 'mm',
      gridSpacing: 500,
      snapGrid: true,
      snapObjects: true,
    },
    ...overrides,
  };
}

export function wall(overrides: Partial<WallElement> = {}): WallElement {
  return {
    id: 'wall-1',
    type: 'wall',
    name: 'Exterior Wall',
    levelId: ground.id,
    material: 'brick',
    start: { x: 0, y: 0 },
    end: { x: 5000, y: 0 },
    thickness: 200,
    height: 3000,
    ...overrides,
  };
}

export function door(overrides: Partial<DoorElement> = {}): DoorElement {
  return {
    id: 'door-1',
    type: 'door',
    name: 'Main Door',
    levelId: ground.id,
    material: 'wood',
    hostWallId: 'wall-1',
    offset: 2500,
    width: 1000,
    height: 2100,
    flip: false,
    ...overrides,
  };
}

export function windowElement(overrides: Partial<WindowElement> = {}): WindowElement {
  return {
    id: 'window-1',
    type: 'window',
    name: 'Window',
    levelId: ground.id,
    material: 'glass',
    hostWallId: 'wall-1',
    offset: 3800,
    width: 1000,
    height: 1200,
    sillHeight: 900,
    ...overrides,
  };
}
