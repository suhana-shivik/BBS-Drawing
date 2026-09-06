// ============================================================
// CAD document model.
//
// Three representations, deliberately not collapsed into one:
//
//   CadDocument   parsed source. Blocks stay definitions, INSERTs stay
//                 instances, curves stay curves, styles stay BYLAYER/
//                 BYBLOCK. Nothing is flattened or discarded here.
//   DisplayList   one fully-resolved, flat draw list for a given view.
//                 Colors resolved, transforms applied, curves tessellated.
//                 The screen renderer AND every exporter consume this —
//                 that is what keeps screen and export from diverging.
//   BIM elements  unrelated; CAD content never enters ProjectData.elements.
//
// Units: the parser converts to millimetres via CadDocument.unitScale.
// Plan axes match the BIM model (x right, y north).
// ============================================================
import type { Vec2 } from '../core/types';

export type { Vec2 };

// ------------------------------------------------------------
// styling primitives
// ------------------------------------------------------------

/** ACI index, or a resolved 24-bit color, or inherit */
export type CadColor =
  | { kind: 'aci'; index: number }
  | { kind: 'rgb'; hex: string }
  | { kind: 'byLayer' }
  | { kind: 'byBlock' };

export const BY_LAYER: CadColor = { kind: 'byLayer' };
export const BY_BLOCK: CadColor = { kind: 'byBlock' };

export interface CadLayer {
  name: string;
  color: CadColor;
  /** mm; -1 = default, -3 = by-layer-default */
  lineweight: number;
  linetype: string;
  visible: boolean;
  frozen: boolean;
  /** 0..1, 0 = opaque */
  transparency: number;
}

export interface CadLinetype {
  name: string;
  /** dash pattern in drawing units: +draw, -gap, 0 = dot */
  pattern: number[];
  /** total pattern length */
  length: number;
}

export interface CadTextStyle {
  name: string;
  font: string;
  bigFont: string;
  widthFactor: number;
  /** radians */
  oblique: number;
  /** fixed height, 0 = per-entity */
  height: number;
}

// ------------------------------------------------------------
// entity style block (common to every entity)
// ------------------------------------------------------------

export interface CadStyle {
  layer: string;
  color: CadColor;
  /** -1 = by layer */
  lineweight: number;
  /** empty = by layer */
  linetype: string;
  linetypeScale: number;
  /** 0..1; -1 = by layer */
  transparency: number;
  /** OCS extrusion normal; null when the default (0,0,1) */
  normal: [number, number, number] | null;
  handle: string;
}

// ------------------------------------------------------------
// entities — source semantics preserved
// ------------------------------------------------------------

/** polyline vertex; `bulge` is the DXF arc bulge to the NEXT vertex */
export interface CadVertex {
  x: number;
  y: number;
  bulge?: number;
  /** variable-width polylines */
  startWidth?: number;
  endWidth?: number;
}

export interface CadEntityBase {
  style: CadStyle;
}

export interface CadLine extends CadEntityBase {
  type: 'line';
  a: Vec2;
  b: Vec2;
}

export interface CadPolyline extends CadEntityBase {
  type: 'polyline';
  vertices: CadVertex[];
  closed: boolean;
  /** constant width, if set */
  width?: number;
}

export interface CadArc extends CadEntityBase {
  type: 'arc';
  center: Vec2;
  radius: number;
  /** radians, CCW from +x */
  startAngle: number;
  endAngle: number;
}

export interface CadCircle extends CadEntityBase {
  type: 'circle';
  center: Vec2;
  radius: number;
}

export interface CadEllipse extends CadEntityBase {
  type: 'ellipse';
  center: Vec2;
  /** major axis endpoint RELATIVE to center */
  major: Vec2;
  /** minor/major */
  ratio: number;
  /** parameters in radians */
  startParam: number;
  endParam: number;
}

export interface CadSpline extends CadEntityBase {
  type: 'spline';
  /** fit points preferred when present, else control points */
  fitPoints: Vec2[];
  controlPoints: Vec2[];
  degree: number;
  closed: boolean;
}

export type CadHAlign = 'left' | 'center' | 'right';
export type CadVAlign = 'baseline' | 'bottom' | 'middle' | 'top';

export interface CadText extends CadEntityBase {
  type: 'text';
  position: Vec2;
  text: string;
  height: number;
  /** radians */
  rotation: number;
  hAlign: CadHAlign;
  vAlign: CadVAlign;
  widthFactor: number;
  oblique: number;
  styleName: string;
  /** MTEXT wrap width, 0 = none */
  wrapWidth: number;
}

export interface CadInsert extends CadEntityBase {
  type: 'insert';
  blockName: string;
  position: Vec2;
  scale: Vec2;
  /** radians */
  rotation: number;
  /** MINSERT array */
  cols: number;
  rows: number;
  colSpacing: number;
  rowSpacing: number;
}

/** one closed boundary loop of a hatch */
export interface CadHatchLoop {
  vertices: CadVertex[];
  /** true when this loop came from an edge-type boundary already closed */
  closed: boolean;
  /** DXF boundary path type flags (bit 1 = external, bit 16 = outermost) */
  flags: number;
}

/** one line family of a hatch pattern definition (inline in the DXF) */
export interface CadHatchPatternLine {
  /** radians */
  angle: number;
  baseX: number;
  baseY: number;
  offsetX: number;
  offsetY: number;
  dashes: number[];
}

export interface CadHatch extends CadEntityBase {
  type: 'hatch';
  loops: CadHatchLoop[];
  solid: boolean;
  patternName: string;
  /** radians */
  patternAngle: number;
  patternScale: number;
  /** 0 odd-parity, 1 outermost, 2 ignore */
  islandStyle: number;
  lines: CadHatchPatternLine[];
}

/** DXF SOLID/TRACE — already reordered to true polygon winding by the parser */
export interface CadSolid extends CadEntityBase {
  type: 'solid';
  points: Vec2[];
}

export interface CadPoint extends CadEntityBase {
  type: 'point';
  position: Vec2;
}

export type CadEntity =
  | CadLine
  | CadPolyline
  | CadArc
  | CadCircle
  | CadEllipse
  | CadSpline
  | CadText
  | CadInsert
  | CadHatch
  | CadSolid
  | CadPoint;

// ------------------------------------------------------------
// blocks, layouts, regions
// ------------------------------------------------------------

export interface CadBlock {
  name: string;
  basePoint: Vec2;
  entities: CadEntity[];
}

export interface CadViewport {
  /** center of the viewport on the paper, paper units */
  center: Vec2;
  width: number;
  height: number;
  /** modelspace point shown at the viewport center */
  viewCenter: Vec2;
  /** paper units per model unit */
  scale: number;
  /** radians */
  twist: number;
  frozenLayers: string[];
}

export interface CadLayout {
  name: string;
  /** paper size in mm, when declared */
  paperWidth: number;
  paperHeight: number;
  entities: CadEntity[];
  viewports: CadViewport[];
}

/** a spatially-clustered part of modelspace. No geometry is ever discarded. */
export interface CadRegion {
  id: string;
  label: string;
  min: Vec2;
  max: Vec2;
  entityCount: number;
  /** indices into CadDocument.entities */
  indices: number[];
}

export interface CadDiagnostic {
  severity: 'info' | 'warning';
  code: string;
  message: string;
  count: number;
}

export interface CadDocument {
  id: string;
  name: string;
  sourceFile: string;
  /** multiply source units by this to get mm */
  unitScale: number;
  layers: Map<string, CadLayer>;
  linetypes: Map<string, CadLinetype>;
  textStyles: Map<string, CadTextStyle>;
  blocks: Map<string, CadBlock>;
  /** modelspace */
  entities: CadEntity[];
  /**
   * Structured annotation the geometry cannot carry: what each DIMENSION
   * SPANS and MEASURES, and what each LEADER points at. Optional because a
   * document can be built by hand (tests, synthetic fixtures) and nothing is
   * entitled to assume it exists. See dxf/annotations.ts for why the geometry
   * alone is not enough.
   */
  annotations?: import('./dxf/annotations').CadAnnotations;
  layouts: CadLayout[];
  regions: CadRegion[];
  diagnostics: CadDiagnostic[];
  /** full geometric extents of modelspace, mm */
  extents: { min: Vec2; max: Vec2 } | null;
}

// ------------------------------------------------------------
// display list — fully resolved, flat, ready to draw
// ------------------------------------------------------------

/** a resolved stroke/fill path; `subpaths` are already tessellated polylines */
export interface DisplayPath {
  kind: 'path';
  subpaths: Vec2[][];
  closed: boolean;
  /** css color or null for no stroke */
  stroke: string | null;
  /** css color or null for no fill */
  fill: string | null;
  /** mm; 0 = hairline */
  lineweight: number;
  /** dash pattern in mm, empty = solid */
  dash: number[];
  /** 0..1 */
  alpha: number;
  /** source entity handle for hit-test / diagnostics */
  handle: string;
  layer: string;
}

export interface DisplayText {
  kind: 'text';
  position: Vec2;
  text: string;
  height: number;
  rotation: number;
  hAlign: CadHAlign;
  vAlign: CadVAlign;
  widthFactor: number;
  color: string;
  alpha: number;
  handle: string;
  layer: string;
}

export type DisplayOp = DisplayPath | DisplayText;

export interface DisplayList {
  ops: DisplayOp[];
  min: Vec2;
  max: Vec2;
}

/** what a display list is built for */
export interface ViewSpec {
  /** null = whole modelspace */
  regionId: string | null;
  /**
   * Layer names hidden in THIS viewer. The only gate on what gets drawn — a
   * layer's own `visible`/`frozen` state in the DXF is the file author's
   * last save-time preference, not a say in what the viewer shows (§ emit
   * in displayList.ts).
   */
  hiddenLayers: ReadonlySet<string>;
  /** background is dark (screen) or light (paper) — drives white/black flip */
  paper: boolean;
}

// ------------------------------------------------------------
// semantic labels
// ------------------------------------------------------------

/**
 * Meaning assigned to a block or layer name.
 *
 * Deliberately carries NO quantities. The AI pass may say what something is;
 * every count, length and area is computed from geometry by `metrics.ts`, so a
 * mislabel is a visible, one-click-fixable naming error rather than a wrong
 * number buried in a bill of quantities.
 */
export interface CadLabel {
  /** human name, e.g. "Supply air diffuser" */
  label: string;
  /** e.g. "electrical" | "hvac" | "architectural" | "structural" */
  discipline?: string;
  /** what the label was inferred from, e.g. "legend row 07 + symbol shape" */
  evidence?: string;
  /** 0..1 as reported by the model */
  confidence?: number;
  /** true when a human set or corrected this */
  userSet?: boolean;
}
