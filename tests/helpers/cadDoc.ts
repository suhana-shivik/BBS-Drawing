// Synthetic CadDocuments for the drawing-splitter tests.
//
// Built by hand rather than parsed, so a test can state exactly where every
// entity is and assert exactly which section should contain it. The unit
// scale is a parameter because the source-units/millimetres split is the
// single most dangerous thing in this area of the codebase: entity
// coordinates are SOURCE units, extents and section bounds are MILLIMETRES,
// and a fixture that only ever uses scale 1 proves nothing about that.
import type {
  CadBlock,
  CadDocument,
  CadEntity,
  CadLayer,
  CadStyle,
  Vec2,
} from '../../src/cad/types';
import { BY_LAYER } from '../../src/cad/types';

let handleSeq = 0;

export function resetHandles(): void {
  handleSeq = 0;
}

export function style(layer = '0', handle?: string): CadStyle {
  handleSeq += 1;
  return {
    layer,
    color: BY_LAYER,
    lineweight: -1,
    linetype: '',
    linetypeScale: 1,
    transparency: -1,
    normal: null,
    handle: handle ?? `H${handleSeq.toString(16).toUpperCase().padStart(4, '0')}`,
  };
}

export function line(a: Vec2, b: Vec2, layer = '0', handle?: string): CadEntity {
  return { type: 'line', style: style(layer, handle), a, b };
}

export function text(
  position: Vec2,
  value: string,
  height = 10,
  layer = 'TEXT',
  handle?: string,
): CadEntity {
  return {
    type: 'text',
    style: style(layer, handle),
    position,
    text: value,
    height,
    rotation: 0,
    hAlign: 'left',
    vAlign: 'baseline',
    widthFactor: 1,
    oblique: 0,
    styleName: 'STANDARD',
    wrapWidth: 0,
  };
}

export function circle(center: Vec2, radius: number, layer = '0', handle?: string): CadEntity {
  return { type: 'circle', style: style(layer, handle), center, radius };
}

export function polyline(
  points: Vec2[],
  closed = false,
  layer = '0',
  handle?: string,
): CadEntity {
  return {
    type: 'polyline',
    style: style(layer, handle),
    vertices: points.map((p) => ({ x: p.x, y: p.y })),
    closed,
  };
}

export function insert(
  blockName: string,
  position: Vec2,
  layer = 'SYMBOLS',
  handle?: string,
): CadEntity {
  return {
    type: 'insert',
    style: style(layer, handle),
    blockName,
    position,
    scale: { x: 1, y: 1 },
    rotation: 0,
    cols: 1,
    rows: 1,
    colSpacing: 0,
    rowSpacing: 0,
  };
}

function layer(name: string, color = 7): CadLayer {
  return {
    name,
    color: { kind: 'aci', index: color },
    lineweight: -3,
    linetype: 'CONTINUOUS',
    visible: true,
    frozen: false,
    transparency: 0,
  };
}

export interface DocOptions {
  unitScale?: number;
  entities?: CadEntity[];
  blocks?: CadBlock[];
  layers?: string[];
  name?: string;
  id?: string;
}

/** Extents in MILLIMETRES, from source-unit entity coordinates. */
function extentsOf(entities: CadEntity[], unitScale: number): CadDocument['extents'] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (p: Vec2): void => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const e of entities) {
    if (e.type === 'line') {
      add(e.a);
      add(e.b);
    } else if (e.type === 'text' || e.type === 'insert' || e.type === 'point') {
      add(e.position);
    } else if (e.type === 'circle' || e.type === 'arc') {
      add({ x: e.center.x - e.radius, y: e.center.y - e.radius });
      add({ x: e.center.x + e.radius, y: e.center.y + e.radius });
    } else if (e.type === 'polyline') {
      for (const v of e.vertices) add({ x: v.x, y: v.y });
    }
  }
  if (!Number.isFinite(minX)) return null;
  const k = unitScale;
  return { min: { x: minX * k, y: minY * k }, max: { x: maxX * k, y: maxY * k } };
}

export function makeDoc(opts: DocOptions = {}): CadDocument {
  const unitScale = opts.unitScale ?? 1;
  const entities = opts.entities ?? [];
  const layers = new Map<string, CadLayer>();
  for (const name of opts.layers ?? ['0', 'TEXT', 'SYMBOLS', 'STEEL']) {
    layers.set(name, layer(name, name === 'STEEL' ? 1 : 7));
  }
  const blocks = new Map<string, CadBlock>();
  for (const b of opts.blocks ?? []) blocks.set(b.name.toUpperCase(), b);

  return {
    id: opts.id ?? 'doc-test',
    name: opts.name ?? 'test-sheet',
    sourceFile: `${opts.name ?? 'test-sheet'}.dxf`,
    unitScale,
    layers,
    linetypes: new Map(),
    textStyles: new Map(),
    blocks,
    entities,
    layouts: [],
    regions: [],
    diagnostics: [],
    extents: extentsOf(entities, unitScale),
  };
}

/**
 * A sheet with three clearly separated areas plus one line that spans two of
 * them — the case §7 names: an entity crossing a section boundary.
 *
 * Layout, in SOURCE units:
 *   left   x    0..200    "SECTION AT 1-1"   (detail)
 *   middle x  400..600    "FOOTING LAYOUT"   (layout)
 *   right  x  800..1000   "GENERAL NOTES"    (note)
 *   a grid line runs x=100..900 at y=-50, crossing left→right
 */
export function threeAreaDoc(unitScale = 1): CadDocument {
  resetHandles();
  const entities: CadEntity[] = [
    // left area
    text({ x: 10, y: 180 }, 'SECTION AT 1-1', 12, 'TEXT', 'AAA1'),
    text({ x: 10, y: 150 }, '300x1400', 8, 'TEXT', 'AAA2'),
    line({ x: 0, y: 0 }, { x: 200, y: 0 }, 'STEEL', 'AAA3'),
    line({ x: 0, y: 0 }, { x: 0, y: 200 }, 'STEEL', 'AAA4'),
    circle({ x: 100, y: 100 }, 40, 'STEEL', 'AAA5'),

    // middle area
    text({ x: 410, y: 180 }, 'FOOTING LAYOUT', 12, 'TEXT', 'BBB1'),
    text({ x: 410, y: 150 }, 'F1 TYP.', 8, 'TEXT', 'BBB2'),
    polyline(
      [
        { x: 400, y: 0 },
        { x: 600, y: 0 },
        { x: 600, y: 120 },
        { x: 400, y: 120 },
      ],
      true,
      'STEEL',
      'BBB3',
    ),

    // right area
    text({ x: 810, y: 180 }, 'GENERAL NOTES', 12, 'TEXT', 'CCC1'),
    text({ x: 810, y: 150 }, 'CONCRETE M25', 8, 'TEXT', 'CCC2'),
    text({ x: 810, y: 120 }, 'CLEAR COVER 50', 8, 'TEXT', 'CCC3'),

    // the boundary-crossing grid line: starts inside the left area and ends
    // inside the right one
    line({ x: 100, y: -50 }, { x: 900, y: -50 }, '0', 'GRID1'),
  ];
  return makeDoc({ unitScale, entities, name: 'three-area' });
}

/** A block definition plus an INSERT that places it away from its anchor. */
export function blockDoc(unitScale = 1): CadDocument {
  resetHandles();
  const block: CadBlock = {
    name: 'MARKER',
    basePoint: { x: 0, y: 0 },
    entities: [
      line({ x: 0, y: 0 }, { x: 60, y: 0 }, 'SYMBOLS', 'BLK1'),
      line({ x: 60, y: 0 }, { x: 60, y: 60 }, 'SYMBOLS', 'BLK2'),
    ],
  };
  const entities: CadEntity[] = [
    // insertion point sits OUTSIDE the section box; its geometry reaches in
    insert('MARKER', { x: 90, y: 10 }, 'SYMBOLS', 'INS1'),
    text({ x: 20, y: 20 }, 'DETAIL A', 10, 'TEXT', 'TXT1'),
    text({ x: 20, y: 40 }, 'SCALE 1:10', 10, 'TEXT', 'TXT2'),
  ];
  return makeDoc({ unitScale, entities, blocks: [block], name: 'block-sheet' });
}
