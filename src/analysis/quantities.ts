// Quantity takeoff over the model. All values stay in raw model units
// (mm / mm² / mm³) — the UI is responsible for formatting/conversion.
import type { BIMModel } from '../core/model';
import type {
  BeamElement,
  ColumnElement,
  DoorElement,
  FurnitureElement,
  RoomElement,
  SlabElement,
  StairElement,
  WallElement,
  WindowElement,
} from '../core/types';
import { dist, polygonAreaAbs, wallLength } from '../core/geometry';

export interface QuantityRow {
  label: string;
  count?: number;
  /** mm */
  length?: number;
  /** mm² */
  area?: number;
  /** mm³ */
  volume?: number;
}

export interface QuantityReport {
  rows: QuantityRow[];
}

/** levelId undefined → whole project */
export function computeQuantities(model: BIMModel, levelId?: string): QuantityReport {
  const onLevel = <T extends { levelId: string }>(els: T[]): T[] =>
    levelId === undefined ? els : els.filter((e) => e.levelId === levelId);

  const walls = onLevel(model.byType<WallElement>('wall'));
  const doors = onLevel(model.byType<DoorElement>('door'));
  const windows = onLevel(model.byType<WindowElement>('window'));
  const slabs = onLevel(model.byType<SlabElement>('slab'));
  const columns = onLevel(model.byType<ColumnElement>('column'));
  const beams = onLevel(model.byType<BeamElement>('beam'));
  const rooms = onLevel(model.byType<RoomElement>('room'));
  const stairs = onLevel(model.byType<StairElement>('stair'));
  const furniture = onLevel(model.byType<FurnitureElement>('furniture'));

  // ---- walls: length, one-face area, net volume (openings subtracted) ----
  let wallLen = 0;
  let wallArea = 0;
  let wallVol = 0;
  for (const w of walls) {
    const L = wallLength(w);
    wallLen += L;
    wallArea += L * w.height;
    let vol = L * w.thickness * w.height;
    for (const op of model.hosted(w.id)) {
      vol -= op.width * op.height * w.thickness;
    }
    wallVol += Math.max(0, vol);
  }

  // ---- slabs ----
  let slabArea = 0;
  let slabVol = 0;
  for (const s of slabs) {
    const a = polygonAreaAbs(s.outline);
    slabArea += a;
    slabVol += a * s.thickness;
  }

  // ---- columns ----
  let colVol = 0;
  for (const c of columns) {
    colVol += c.width * c.depth * c.height;
  }

  // ---- beams ----
  let beamLen = 0;
  let beamVol = 0;
  for (const b of beams) {
    const L = dist(b.start, b.end);
    beamLen += L;
    beamVol += L * b.width * b.depth;
  }

  // ---- rooms: plan area, volume = area × storey height of the room's level ----
  let roomArea = 0;
  let roomVol = 0;
  for (const r of rooms) {
    const a = polygonAreaAbs(r.boundary);
    roomArea += a;
    roomVol += a * (model.getLevel(r.levelId)?.height ?? 0);
  }

  const rows: QuantityRow[] = [];
  const push = (row: QuantityRow): void => {
    const vals = [row.count, row.length, row.area, row.volume];
    if (vals.some((x) => (x ?? 0) > 0)) rows.push(row);
  };

  push({ label: 'Walls', count: walls.length, length: wallLen, area: wallArea, volume: wallVol });
  push({ label: 'Doors', count: doors.length });
  push({ label: 'Windows', count: windows.length });
  push({ label: 'Slabs', count: slabs.length, area: slabArea, volume: slabVol });
  push({ label: 'Columns', count: columns.length, volume: colVol });
  push({ label: 'Beams', count: beams.length, length: beamLen, volume: beamVol });
  push({ label: 'Rooms', count: rooms.length, area: roomArea, volume: roomVol });
  push({ label: 'Stairs', count: stairs.length });
  push({ label: 'Furniture', count: furniture.length });

  return { rows };
}
