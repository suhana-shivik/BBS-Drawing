// ============================================================
// Structured annotation — what a DIMENSION and a LEADER MEAN.
//
// WHY THIS FILE EXISTS
//
// `entities.ts` turns a DIMENSION into the anonymous block that draws it, and
// a LEADER into a plain polyline. For RENDERING that is exactly right: the CAD
// app already generated truer geometry than we could re-derive, and this file
// does not change any of it.
//
// But it throws away the only structure that makes a dimension usable as
// EVIDENCE:
//
//   code 13 / 14   the two points the dimension actually spans
//   code 42        the measurement the CAD app computed
//   code 50 / 70   its orientation and kind
//   code 340       the entity a leader points at
//
// Without those, a dimension is a number floating near some linework. A
// schedule cannot ask "which two points does this 1500 span, and does it
// connect to the 900 above it" — which is precisely the question a chained
// height depends on, and precisely why heights could only ever be asked for
// rather than read.
//
// So the geometry keeps going to the renderer untouched, and the STRUCTURE is
// collected here alongside it. Nothing downstream is obliged to use it.
//
// UNITS: every coordinate and measurement below is in SOURCE units, exactly as
// the file states them. `unitScale` is applied by the consumer, once, the same
// way `harvestTexts` does it — scaling here would double-scale anything that
// later goes through the display list.
import type { Vec2 } from '../types';
import { num, points, val, type Record0 } from './reader';
import { ocsToWcs, readStyle } from './entities';
import { cleanMText } from './mtext';

/** DXF dimension kinds we can reason about; the rest are recorded as `other` */
export type DimensionKind =
  | 'linear-rotated'
  | 'aligned'
  | 'angular'
  | 'diameter'
  | 'radius'
  | 'ordinate'
  | 'other';

export interface CadDimensionRecord {
  handle: string;
  layer: string;
  /** the anonymous block that draws it, so evidence can be tied to what is on screen */
  block?: string;
  kind: DimensionKind;
  /** where the dimension line sits (code 10) */
  linePoint?: Vec2;
  /** middle of the measurement text (code 11) — where the number is drawn */
  textPoint?: Vec2;
  /** the two points the dimension SPANS (codes 13 and 14) */
  from?: Vec2;
  to?: Vec2;
  /** the CAD app's own computed measurement (code 42), source units */
  measurement?: number;
  /**
   * Text override (code 1). Empty or absent means "print the measurement";
   * "<>" embeds it. Anything else is a detailer overriding what is drawn, and
   * a schedule must prefer what is WRITTEN over what is measured — the written
   * value is what the yard cuts to.
   */
  textOverride?: string;
  /** rotation of a linear dimension, degrees (code 50) */
  rotationDeg?: number;
}

export interface CadLeaderRecord {
  handle: string;
  layer: string;
  /** the leader's vertices, source units; [0] is the arrow end */
  vertices: Vec2[];
  /** hard pointer to the annotation it carries (code 340), when the file states one */
  annotationHandle?: string;
}

export interface CadAnnotations {
  dimensions: CadDimensionRecord[];
  leaders: CadLeaderRecord[];
}

export const emptyAnnotations = (): CadAnnotations => ({ dimensions: [], leaders: [] });

/** code 70, low three bits — the DXF dimension type */
function kindOf(flags: number | undefined): DimensionKind {
  switch ((flags ?? 0) & 7) {
    case 0:
      return 'linear-rotated';
    case 1:
      return 'aligned';
    case 2:
      return 'angular';
    case 3:
      return 'diameter';
    case 4:
      return 'radius';
    case 5:
      return 'angular';
    case 6:
      return 'ordinate';
    default:
      return 'other';
  }
}

function normal(r: Record0): [number, number, number] | null {
  const x = num(r, 210);
  const y = num(r, 220);
  const z = num(r, 230);
  return x === undefined && y === undefined && z === undefined
    ? null
    : [x ?? 0, y ?? 0, z ?? 1];
}

/**
 * The structure of one DIMENSION record.
 *
 * Returns null only when the record carries nothing usable — a dimension with
 * neither a measurement nor a spanned pair cannot be evidence for anything.
 */
export function readDimension(r: Record0): CadDimensionRecord | null {
  const style = readStyle(r);
  const N = normal(r);
  const at = (code: number): Vec2 | undefined => {
    const x = num(r, code);
    const y = num(r, code + 10);
    if (x === undefined || y === undefined) return undefined;
    return ocsToWcs({ x, y }, N);
  };

  const from = at(13);
  const to = at(14);
  const measurement = num(r, 42);
  if (measurement === undefined && !(from && to)) return null;

  const raw = val(r, 1);
  return {
    handle: style.handle,
    layer: style.layer,
    block: val(r, 2),
    kind: kindOf(num(r, 70)),
    linePoint: at(10),
    textPoint: at(11),
    from,
    to,
    measurement,
    textOverride: overrideText(raw),
    rotationDeg: num(r, 50),
  };
}

/**
 * A dimension override as the sheet READS, not as the file encodes it.
 *
 * DXF stores group 1 with MTEXT formatting in it, and this was being kept raw.
 * Two consequences, and only the first is cosmetic:
 *
 *   The panel printed `{\Fsimplex.shx|c228;L (LENGTH)}` where the sheet says
 *   "L (LENGTH)".
 *
 *   `dimensionValue` reads the FIRST NUMBER out of this string, so
 *   `\A1;{\Fsimplex.shx|c228;2000}` returned 1 — the digit in `\A1` — for a
 *   dimension the sheet writes as 2000. That number reaches a cutting length.
 *
 * `<>` SURVIVES CLEANING. It is not decoration: it is the sheet saying "print
 * the measured value here", and `dimensionValue` needs to see it to know the
 * measurement is what was meant. An override of `<>` alone adds nothing and
 * stays `undefined`, exactly as before.
 */
function overrideText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = cleanMText(raw)
    // `\X` — BACKSLASH-X, not the letter X — splits the text above and below
    // the dimension line. It is a break, not a character, and `cleanMText`
    // leaves it because it is not an MTEXT formatting code. Written `\\X` in
    // the pattern: `/\X/` is just `X`, and would gut every word containing one.
    .replace(/\\X/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text && text !== '<>' ? text : undefined;
}

/** The structure of one LEADER record — the arrow end first. */
export function readLeader(r: Record0): CadLeaderRecord | null {
  const style = readStyle(r);
  const N = normal(r);
  const verts = points(r, 10, 20).map((p) => ocsToWcs(p, N));
  if (verts.length < 2) return null;
  return {
    handle: style.handle,
    layer: style.layer,
    vertices: verts,
    annotationHandle: val(r, 340),
  };
}

/**
 * The measurement a dimension asserts, in source units.
 *
 * A detailer's text override WINS over the computed measurement: the sheet is
 * the contract and the yard cuts to what is printed. When the override carries
 * no number — "TYP.", "EQ" — there is nothing to assert and this returns null
 * rather than falling back to a figure the sheet does not show.
 */
export function dimensionValue(d: CadDimensionRecord): number | null {
  if (d.textOverride !== undefined) {
    // `<>` in the override means "print the measured value" — the sheet is
    // annotating the measurement, not replacing it, so the measurement is
    // what was written. Reading a number out of the note beside it ("2000
    // (O/O OF PEDESTAL LINE)") would take whichever digit came first.
    if (d.textOverride.includes('<>')) {
      return d.measurement !== undefined && Number.isFinite(d.measurement) ? d.measurement : null;
    }
    const m = /-?\d+(?:\.\d+)?/.exec(d.textOverride.replace(/,/g, ''));
    return m ? Number(m[0]) : null;
  }
  return d.measurement !== undefined && Number.isFinite(d.measurement) ? d.measurement : null;
}

/** Which axis a dimension measures along, when it is unambiguous. */
export function dimensionAxis(d: CadDimensionRecord): 'x' | 'y' | null {
  if (!d.from || !d.to) return null;
  const dx = Math.abs(d.to.x - d.from.x);
  const dy = Math.abs(d.to.y - d.from.y);
  // A rotated linear dimension measures along its own rotation, not along the
  // span between its extension origins — 0/180 is horizontal, 90/270 vertical.
  if (d.kind === 'linear-rotated' && d.rotationDeg !== undefined) {
    const a = ((d.rotationDeg % 180) + 180) % 180;
    if (a < 15 || a > 165) return 'x';
    if (a > 75 && a < 105) return 'y';
  }
  if (dx > dy * 4) return 'x';
  if (dy > dx * 4) return 'y';
  return null;
}
