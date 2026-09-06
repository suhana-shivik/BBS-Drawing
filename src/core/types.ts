// ============================================================
// Core BIM data types — the single source of truth for the app.
// Coordinate system (model space): x = east/right, y = north/up
// in plan, z = vertical elevation. All lengths in millimetres.
// ============================================================

export type Unit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export interface Vec2 {
  x: number;
  y: number;
}

export type ElementType =
  | 'wall'
  | 'door'
  | 'window'
  | 'slab'
  | 'column'
  | 'beam'
  | 'room'
  | 'stair'
  | 'furniture'
  | 'dimension'
  | 'text'
  | 'refline';

export interface Level {
  id: string;
  name: string;
  /** mm above project zero */
  elevation: number;
  /** storey height in mm */
  height: number;
}

export interface ElementBase {
  id: string;
  type: ElementType;
  name: string;
  levelId: string;
  /** key into MATERIALS */
  material?: string;
  properties?: Record<string, string | number | boolean>;
}

export interface WallElement extends ElementBase {
  type: 'wall';
  start: Vec2;
  end: Vec2;
  thickness: number;
  height: number;
}

export interface DoorElement extends ElementBase {
  type: 'door';
  hostWallId: string;
  /** mm from wall start point to door centre, along the wall axis */
  offset: number;
  width: number;
  height: number;
  /** swing side */
  flip: boolean;
}

export interface WindowElement extends ElementBase {
  type: 'window';
  hostWallId: string;
  /** mm from wall start point to window centre, along the wall axis */
  offset: number;
  width: number;
  height: number;
  sillHeight: number;
}

export interface SlabElement extends ElementBase {
  type: 'slab';
  /** closed polygon, last point NOT repeated */
  outline: Vec2[];
  thickness: number;
}

export interface ColumnElement extends ElementBase {
  type: 'column';
  position: Vec2;
  width: number;
  depth: number;
  height: number;
  /** radians */
  rotation: number;
}

export interface BeamElement extends ElementBase {
  type: 'beam';
  start: Vec2;
  end: Vec2;
  width: number;
  /** vertical size */
  depth: number;
  /** top of beam sits at level.elevation + level.height + offset */
  offset: number;
}

export interface RoomElement extends ElementBase {
  type: 'room';
  number: string;
  /** closed polygon, last point NOT repeated */
  boundary: Vec2[];
}

export interface StairElement extends ElementBase {
  type: 'stair';
  /** corner of the stair footprint (start of the run) */
  position: Vec2;
  /** radians, direction of ascent */
  rotation: number;
  width: number;
  /** run length in plan */
  length: number;
  /** level the stair rises to; levelId is the level it starts from */
  toLevelId: string;
}

export interface FurnitureElement extends ElementBase {
  type: 'furniture';
  /** key into library CATALOG */
  catalogId: string;
  position: Vec2;
  rotation: number;
  width: number;
  depth: number;
  height: number;
}

export interface DimensionElement extends ElementBase {
  type: 'dimension';
  start: Vec2;
  end: Vec2;
  /** perpendicular offset of the dimension line from the measured segment, mm */
  offsetDist: number;
  /** optional anchors: keep endpoints glued to element geometry */
  anchors?: { elementId: string; end: 'start' | 'end' }[];
}

export interface TextElement extends ElementBase {
  type: 'text';
  position: Vec2;
  text: string;
  /** text height in model mm */
  size: number;
  rotation: number;
  /** explicit CSS color (imported CAD text); falls back to the theme colour */
  color?: string;
  /**
   * Which part of the text `position` anchors. CAD text is left/baseline by
   * default; text placed with the text tool is centred. Undefined = centred,
   * so tool-placed text keeps its behaviour.
   */
  hAlign?: 'left' | 'center' | 'right';
  vAlign?: 'baseline' | 'bottom' | 'middle' | 'top';
  /** CAD layer this text belongs to (drives layer visibility) */
  layer?: string;
}

/** Imported reference geometry (from DXF etc.) — displayed, snappable, not BIM */
export interface RefLineElement extends ElementBase {
  type: 'refline';
  points: Vec2[];
  closed: boolean;
  layer?: string;
  /** explicit CSS color from the source CAD file (ACI → RGB) */
  color?: string;
  /** solid-filled region (DXF SOLID / HATCH) rather than an outline */
  filled?: boolean;
}

export type AnyElement =
  | WallElement
  | DoorElement
  | WindowElement
  | SlabElement
  | ColumnElement
  | BeamElement
  | RoomElement
  | StairElement
  | FurnitureElement
  | DimensionElement
  | TextElement
  | RefLineElement;

export interface ProjectSettings {
  unit: Unit;
  /** mm */
  gridSpacing: number;
  snapGrid: boolean;
  snapObjects: boolean;
}

export interface ProjectData {
  id: string;
  name: string;
  createdAt: number;
  modifiedAt: number;
  levels: Level[];
  elements: AnyElement[];
  settings: ProjectSettings;
  /** R1 — optional studio-project identity; absent on older records. */
  client?: string;
  projectNumber?: string;
  archived?: boolean;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  modifiedAt: number;
  levelCount: number;
  elementCount: number;
  /** R1 — carried through from ProjectData when present. */
  client?: string;
  projectNumber?: string;
  archived?: boolean;
}

// ------------------------------------------------------------
// Materials
// ------------------------------------------------------------

export interface MaterialDef {
  key: string;
  name: string;
  /** 2D plan fill */
  color: string;
  /** 3D surface color */
  color3d: string;
  opacity?: number;
}

export const MATERIALS: Record<string, MaterialDef> = {
  brick: { key: 'brick', name: 'Brick', color: '#a8604a', color3d: '#b3705a' },
  concrete: { key: 'concrete', name: 'Concrete', color: '#9a9aa0', color3d: '#a5a5ab' },
  plaster: { key: 'plaster', name: 'Plaster', color: '#d8d4c8', color3d: '#e2ded2' },
  wood: { key: 'wood', name: 'Wood', color: '#a97742', color3d: '#b5854f' },
  glass: { key: 'glass', name: 'Glass', color: '#7fb3d5', color3d: '#9cc8e4', opacity: 0.45 },
  steel: { key: 'steel', name: 'Steel', color: '#7f8c9b', color3d: '#8b98a7' },
  stone: { key: 'stone', name: 'Stone', color: '#8d8578', color3d: '#999183' },
  generic: { key: 'generic', name: 'Generic', color: '#8f939c', color3d: '#9ba0aa' },
};

export function materialOf(el: { material?: string }): MaterialDef {
  return MATERIALS[el.material ?? ''] ?? MATERIALS.generic;
}

// ------------------------------------------------------------
// Defaults (mm)
// ------------------------------------------------------------

export const DEFAULTS = {
  wallThickness: 230,
  wallHeight: 3000,
  doorWidth: 900,
  doorHeight: 2100,
  windowWidth: 1200,
  windowHeight: 1200,
  sillHeight: 900,
  slabThickness: 150,
  columnSize: 300,
  columnHeight: 3000,
  beamWidth: 230,
  beamDepth: 450,
  stairWidth: 1000,
  stairLength: 3600,
  levelHeight: 3000,
  gridSpacing: 500,
  textSize: 200,
};

// ------------------------------------------------------------
// Ids
// ------------------------------------------------------------

let idCounter = Math.floor(Math.random() * 1e6);

export function newId(prefix = 'el'): string {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
