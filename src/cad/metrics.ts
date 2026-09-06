// Per-entity measurement, in millimetres.
//
// The single arithmetic authority for "how long / how big is this?". Selection
// readouts, the takeoff table and any future AI-labelled report all call in
// here, so a number shown next to a label can never disagree with the number
// in the schedule.
import type { CadDocument, CadEntity, Vec2 } from './types';
import { expandVertices } from './displayList';
import { buildOccurrenceIndex } from './occurrences';

const TAU = Math.PI * 2;

function polylineLength(pts: Vec2[], closed: boolean): number {
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    total += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  }
  if (closed && pts.length > 2) {
    const a = pts[pts.length - 1];
    const b = pts[0];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

function shoelace(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s / 2);
}

/**
 * Curve length in source units. Arcs and bulged polylines are measured along
 * the true curve, not the chord — a door swing measured as a straight line
 * would understate by roughly a third.
 */
export function entityLength(e: CadEntity): number {
  switch (e.type) {
    case 'line':
      return Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
    case 'polyline':
      return polylineLength(expandVertices(e.vertices, e.closed), e.closed);
    case 'circle':
      return TAU * e.radius;
    case 'arc': {
      let sweep = e.endAngle - e.startAngle;
      while (sweep <= 0) sweep += TAU;
      return e.radius * sweep;
    }
    case 'ellipse': {
      // Ramanujan's approximation, scaled to the swept parameter range
      const major = Math.hypot(e.major.x, e.major.y);
      const minor = major * e.ratio;
      const h = ((major - minor) ** 2) / ((major + minor) ** 2 || 1);
      const full = Math.PI * (major + minor) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
      let sweep = e.endParam - e.startParam;
      while (sweep <= 0) sweep += TAU;
      return full * Math.min(1, sweep / TAU);
    }
    case 'spline':
      return polylineLength(e.fitPoints.length ? e.fitPoints : e.controlPoints, e.closed);
    case 'hatch':
      return e.loops.reduce(
        (s, l) => s + polylineLength(expandVertices(l.vertices, true), true),
        0,
      );
    case 'solid':
      return polylineLength(e.points, true);
    default:
      return 0;
  }
}

/** Enclosed area in source units², or 0 when the entity is not closed. */
export function entityArea(e: CadEntity): number {
  switch (e.type) {
    case 'polyline':
      return e.closed ? shoelace(expandVertices(e.vertices, true)) : 0;
    case 'circle':
      return Math.PI * e.radius * e.radius;
    case 'ellipse': {
      const major = Math.hypot(e.major.x, e.major.y);
      return Math.PI * major * major * e.ratio;
    }
    case 'solid':
      return shoelace(e.points);
    case 'hatch': {
      // outer loop only; islands would double-count
      let best = 0;
      for (const l of e.loops) {
        const a = shoelace(expandVertices(l.vertices, true));
        if (a > best) best = a;
      }
      return best;
    }
    default:
      return 0;
  }
}

export interface EntityFacts {
  handle: string;
  type: CadEntity['type'];
  layer: string;
  /** block name for inserts */
  blockName?: string;
  /** mm */
  length: number;
  /** mm² */
  area: number;
  /** resolved colour, for the swatch */
  color?: string;
  /** short human description, e.g. "Polyline (12 vertices)" */
  describe: string;
}

const TYPE_LABEL: Record<CadEntity['type'], string> = {
  line: 'Line',
  polyline: 'Polyline',
  arc: 'Arc',
  circle: 'Circle',
  ellipse: 'Ellipse',
  spline: 'Spline',
  text: 'Text',
  insert: 'Block',
  hatch: 'Hatch',
  solid: 'Solid',
  point: 'Point',
};

export function describeEntity(e: CadEntity): string {
  switch (e.type) {
    case 'polyline':
      return `Polyline (${e.vertices.length} vertices${e.closed ? ', closed' : ''})`;
    case 'insert':
      return `Block “${e.blockName}”`;
    case 'text':
      return `Text “${e.text.split('\n')[0].slice(0, 40)}”`;
    case 'hatch':
      return `Hatch (${e.patternName})`;
    case 'circle':
      return 'Circle';
    default:
      return TYPE_LABEL[e.type] ?? e.type;
  }
}

/** Facts for one entity, converted into millimetres via the document scale. */
export function entityFacts(doc: CadDocument, e: CadEntity): EntityFacts {
  const k = doc.unitScale;
  const layer = doc.layers.get(e.style.layer);
  const color =
    e.style.color.kind === 'rgb'
      ? e.style.color.hex
      : layer && layer.color.kind === 'rgb'
        ? layer.color.hex
        : undefined;
  return {
    handle: e.style.handle,
    type: e.type,
    layer: e.style.layer,
    blockName: e.type === 'insert' ? e.blockName : undefined,
    length: entityLength(e) * k,
    area: entityArea(e) * k * k,
    color,
    describe: describeEntity(e),
  };
}

export interface SelectionSummary {
  count: number;
  /** mm */
  totalLength: number;
  /** mm² */
  totalArea: number;
  byType: { type: string; count: number }[];
  byLayer: { layer: string; count: number; length: number }[];
  byBlock: {
    name: string;
    /** expanded occurrences represented by the selection */
    count: number;
    placementCount: number;
    /** selectable top-level INSERT entities */
    sourceEntityCount: number;
  }[];
}

/** Roll up a set of entities into the numbers shown in the selection readout. */
export function summarise(doc: CadDocument, entities: CadEntity[]): SelectionSummary {
  const k = doc.unitScale;
  let totalLength = 0;
  let totalArea = 0;
  const types = new Map<string, number>();
  const layers = new Map<string, { count: number; length: number }>();

  for (const e of entities) {
    const len = entityLength(e) * k;
    totalLength += len;
    totalArea += entityArea(e) * k * k;
    types.set(e.type, (types.get(e.type) ?? 0) + 1);
    const l = layers.get(e.style.layer) ?? { count: 0, length: 0 };
    l.count += 1;
    l.length += len;
    layers.set(e.style.layer, l);
  }

  const selectedHandles = new Set(entities.map((e) => e.style.handle));
  const blockRows = buildOccurrenceIndex(doc, { sourceHandles: selectedHandles }).blocks;

  return {
    count: entities.length,
    totalLength,
    totalArea,
    byType: [...types].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    byLayer: [...layers]
      .map(([layer, v]) => ({ layer, count: v.count, length: v.length }))
      .sort((a, b) => b.count - a.count),
    byBlock: blockRows.map((b) => ({
      name: b.name,
      count: b.placementCount,
      placementCount: b.placementCount,
      sourceEntityCount: b.sourceEntityCount,
    })),
  };
}
