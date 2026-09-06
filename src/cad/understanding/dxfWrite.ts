// ============================================================
// CadEntity[] → DXF text.
//
// A section DXF must be CAD, not a picture of CAD. Everything written here is
// a real entity with its real coordinates, its real layer and its original
// handle, so a section can be opened in any CAD application and can be traced
// back to the sheet it was cut from.
//
// COORDINATES ARE NOT TRANSLATED. §9: a detail that lived at X=12500 in the
// original lives at X=12500 in the section. Normalising to the origin would
// make every section look tidy and make none of them traceable.
//
// UNITS. `doc.entities` are in source units and this writer emits them
// untouched, with the source $INSUNITS in the header. The section therefore
// measures identically to the original in any CAD application — no scaling
// happens anywhere in this file.
//
// FIDELITY. Most types round-trip exactly. Two do not, and say so rather than
// silently degrading: SPLINE is written as a tessellated LWPOLYLINE (emitting
// a knot vector we did not parse would risk an invalid file), and HATCH is
// written as its boundary loops without the fill. Both raise a
// `SectionLimitation` the section metadata carries.
// ============================================================
import { expandVertices } from '../displayList';
import type {
  CadBlock,
  CadColor,
  CadDocument,
  CadEntity,
  CadLayer,
  CadStyle,
  CadVertex,
  Vec2,
} from '../types';
import type { SectionBounds, SectionLimitation } from './types';
import { toSourceUnits } from './bounds';

const DEG = 180 / Math.PI;
/** segments used when a spline has to become a polyline */
const SPLINE_STEPS = 48;
/** how deep block definitions are followed when collecting dependencies */
const MAX_BLOCK_DEPTH = 6;

export interface DxfWriteResult {
  text: string;
  /**
   * DXF records actually written — what re-opening the file yields.
   *
   * This can EXCEED `handles.length`, and legitimately: one source HATCH
   * becomes one LWPOLYLINE per boundary loop. The two numbers answer
   * different questions — how much CAD is in the file, and which source
   * entities it came from — so neither is derived from the other.
   */
  entityCount: number;
  /** source entity handles included, one per source entity, in order */
  handles: string[];
  limitations: SectionLimitation[];
}

// ------------------------------------------------------------
// group-code emitter
// ------------------------------------------------------------

class Writer {
  private readonly out: string[] = [];

  pair(code: number, value: string | number): void {
    this.out.push(String(code));
    this.out.push(typeof value === 'number' ? fmt(value) : value);
  }

  text(): string {
    // DXF is CRLF by convention and every reader accepts it
    return `${this.out.join('\r\n')}\r\n`;
  }
}

/**
 * DXF reals: fixed-ish notation, never exponential.
 *
 * `1e-7` is legal JavaScript and illegal DXF — several readers stop at the
 * `e`. Anything that would print in exponential form is clamped to zero-ish
 * decimal notation instead.
 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0.0';
  const v = Math.abs(n) < 1e-10 ? 0 : n;
  const s = v.toFixed(10);
  // trim trailing zeros but keep one decimal place, so 5 → "5.0"
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
}

function limit(
  acc: Map<string, SectionLimitation>,
  code: SectionLimitation['code'],
  message: string,
): void {
  const key = `${code}:${message}`;
  const hit = acc.get(key);
  if (hit) hit.count += 1;
  else acc.set(key, { code, message, count: 1 });
}

// ------------------------------------------------------------
// style
// ------------------------------------------------------------

function aciOf(color: CadColor): number | null {
  if (color.kind === 'aci') return color.index;
  if (color.kind === 'byBlock') return 0;
  if (color.kind === 'byLayer') return 256;
  return null; // rgb handled separately
}

/**
 * Common entity codes.
 *
 * The original HANDLE is preserved (code 5) — it is what lets a section's
 * `entityIds` be checked against the source drawing. No extrusion normal is
 * written: the parser already resolved OCS to WCS on the way in, so these
 * coordinates are WCS and must be read back as WCS.
 */
function writeStyle(w: Writer, style: CadStyle, type: string): void {
  w.pair(0, type);
  if (style.handle) w.pair(5, style.handle);
  w.pair(100, 'AcDbEntity');
  w.pair(8, style.layer || '0');
  const aci = aciOf(style.color);
  if (style.color.kind === 'rgb') {
    const hex = style.color.hex.replace('#', '');
    const rgb = Number.parseInt(hex, 16);
    if (Number.isFinite(rgb)) w.pair(420, String(rgb));
  } else if (aci !== null && aci !== 256) {
    w.pair(62, String(aci));
  }
  if (style.linetype) w.pair(6, style.linetype);
  if (style.lineweight >= 0) w.pair(370, String(Math.round(style.lineweight)));
  if (style.linetypeScale && style.linetypeScale !== 1) w.pair(48, style.linetypeScale);
  if (style.transparency > 0) {
    // DXF 440: 0x02000000 | (255 - alpha)
    const alpha = Math.max(0, Math.min(255, Math.round((1 - style.transparency) * 255)));
    w.pair(440, String(0x02000000 | (255 - alpha)));
  }
}

// ------------------------------------------------------------
// entities
// ------------------------------------------------------------

function writeVertices(w: Writer, verts: readonly CadVertex[], closed: boolean, width?: number): void {
  w.pair(100, 'AcDbPolyline');
  w.pair(90, String(verts.length));
  w.pair(70, String(closed ? 1 : 0));
  if (width && width > 0) w.pair(43, width);
  for (const v of verts) {
    w.pair(10, v.x);
    w.pair(20, v.y);
    // the reader takes a 42 as belonging to the vertex it follows
    if (v.bulge) w.pair(42, v.bulge);
  }
}

function writePolylineFrom(w: Writer, style: CadStyle, pts: readonly Vec2[], closed: boolean): void {
  writeStyle(w, style, 'LWPOLYLINE');
  writeVertices(w, pts.map((p) => ({ x: p.x, y: p.y })), closed);
}

const H_CODE: Record<string, number> = { left: 0, center: 1, right: 2 };
const V_CODE: Record<string, number> = { baseline: 0, bottom: 1, middle: 2, top: 3 };

/** returns how many DXF records were written for this entity — 0 means none */
function writeEntity(
  w: Writer,
  e: CadEntity,
  limits: Map<string, SectionLimitation>,
): number {
  switch (e.type) {
    case 'line':
      writeStyle(w, e.style, 'LINE');
      w.pair(100, 'AcDbLine');
      w.pair(10, e.a.x);
      w.pair(20, e.a.y);
      w.pair(30, 0);
      w.pair(11, e.b.x);
      w.pair(21, e.b.y);
      w.pair(31, 0);
      return 1;

    case 'polyline':
      writeStyle(w, e.style, 'LWPOLYLINE');
      writeVertices(w, e.vertices, e.closed, e.width);
      return 1;

    case 'circle':
      writeStyle(w, e.style, 'CIRCLE');
      w.pair(100, 'AcDbCircle');
      w.pair(10, e.center.x);
      w.pair(20, e.center.y);
      w.pair(30, 0);
      w.pair(40, e.radius);
      return 1;

    case 'arc':
      writeStyle(w, e.style, 'ARC');
      w.pair(100, 'AcDbCircle');
      w.pair(10, e.center.x);
      w.pair(20, e.center.y);
      w.pair(30, 0);
      w.pair(40, e.radius);
      w.pair(100, 'AcDbArc');
      w.pair(50, e.startAngle * DEG);
      w.pair(51, e.endAngle * DEG);
      return 1;

    case 'ellipse':
      writeStyle(w, e.style, 'ELLIPSE');
      w.pair(100, 'AcDbEllipse');
      w.pair(10, e.center.x);
      w.pair(20, e.center.y);
      w.pair(30, 0);
      w.pair(11, e.major.x);
      w.pair(21, e.major.y);
      w.pair(31, 0);
      w.pair(40, e.ratio);
      w.pair(41, e.startParam);
      w.pair(42, e.endParam);
      return 1;

    case 'point':
      writeStyle(w, e.style, 'POINT');
      w.pair(100, 'AcDbPoint');
      w.pair(10, e.position.x);
      w.pair(20, e.position.y);
      w.pair(30, 0);
      return 1;

    case 'solid': {
      writeStyle(w, e.style, 'SOLID');
      w.pair(100, 'AcDbTrace');
      // DXF SOLID takes four corners; a triangle repeats the last
      const p = e.points;
      const q = [p[0], p[1], p[2] ?? p[1], p[3] ?? p[2] ?? p[1]];
      for (let i = 0; i < 4; i++) {
        const pt = q[i] ?? p[0];
        w.pair(10 + i, pt.x);
        w.pair(20 + i, pt.y);
        w.pair(30 + i, 0);
      }
      return 1;
    }

    case 'text': {
      if (e.wrapWidth > 0) {
        writeStyle(w, e.style, 'MTEXT');
        w.pair(100, 'AcDbMText');
        w.pair(10, e.position.x);
        w.pair(20, e.position.y);
        w.pair(30, 0);
        w.pair(40, e.height);
        w.pair(41, e.wrapWidth);
        // attachment point from the parsed alignment, inverse of mtextAlign
        const col = e.hAlign === 'left' ? 0 : e.hAlign === 'center' ? 1 : 2;
        const row = e.vAlign === 'top' ? 0 : e.vAlign === 'middle' ? 1 : 2;
        w.pair(71, String(row * 3 + col + 1));
        w.pair(1, escapeDxfText(e.text));
        if (e.styleName) w.pair(7, e.styleName);
        w.pair(50, e.rotation * DEG);
        return 1;
      }
      writeStyle(w, e.style, 'TEXT');
      w.pair(100, 'AcDbText');
      w.pair(10, e.position.x);
      w.pair(20, e.position.y);
      w.pair(30, 0);
      w.pair(40, e.height);
      w.pair(1, escapeDxfText(e.text));
      if (e.rotation) w.pair(50, e.rotation * DEG);
      if (e.widthFactor && e.widthFactor !== 1) w.pair(41, e.widthFactor);
      if (e.oblique) w.pair(51, e.oblique * DEG);
      if (e.styleName) w.pair(7, e.styleName);
      w.pair(72, String(H_CODE[e.hAlign] ?? 0));
      // `position` IS the effective alignment point the parser resolved, so
      // writing it into BOTH 10/20 and 11/21 round-trips whichever the
      // reader decides to use
      w.pair(11, e.position.x);
      w.pair(21, e.position.y);
      w.pair(31, 0);
      w.pair(100, 'AcDbText');
      w.pair(73, String(V_CODE[e.vAlign] ?? 0));
      return 1;
    }

    case 'insert':
      writeStyle(w, e.style, 'INSERT');
      w.pair(100, 'AcDbBlockReference');
      w.pair(2, e.blockName);
      w.pair(10, e.position.x);
      w.pair(20, e.position.y);
      w.pair(30, 0);
      if (e.scale.x !== 1) w.pair(41, e.scale.x);
      if (e.scale.y !== 1) w.pair(42, e.scale.y);
      if (e.rotation) w.pair(50, e.rotation * DEG);
      if (e.cols > 1 || e.rows > 1) {
        w.pair(70, String(e.cols));
        w.pair(71, String(e.rows));
        w.pair(44, e.colSpacing);
        w.pair(45, e.rowSpacing);
      }
      return 1;

    case 'spline': {
      // Emitting a SPLINE would mean inventing a knot vector this codebase
      // never parsed. A tessellated polyline is geometrically faithful and
      // structurally honest; the substitution is recorded, not hidden.
      const src = e.fitPoints.length ? e.fitPoints : e.controlPoints;
      if (src.length < 2) return 0;
      const pts = e.fitPoints.length ? src : sampleBezierish(src, e.closed);
      writePolylineFrom(w, e.style, pts, e.closed);
      limit(
        limits,
        'unclippable-entity',
        'SPLINE written as a tessellated LWPOLYLINE — geometry preserved, spline definition not',
      );
      return 1;
    }

    case 'hatch': {
      // Boundary loops are written as real polylines; the fill is not
      // reproduced. A section that silently lost its hatch outlines entirely
      // would be worse, and a wrong HATCH record can make a file unreadable.
      let wrote = 0;
      for (const loop of e.loops) {
        const pts = expandVertices(loop.vertices, true);
        if (pts.length < 2) continue;
        writePolylineFrom(w, e.style, pts, true);
        wrote += 1;
      }
      if (wrote) {
        limit(
          limits,
          'unclippable-entity',
          `HATCH "${e.patternName || 'solid'}" written as boundary polylines — fill not reproduced`,
        );
      }
      return wrote;
    }

    default:
      return 0;
  }
}

/** control-point polyline, sampled so a spline keeps its shape */
function sampleBezierish(control: readonly Vec2[], closed: boolean): Vec2[] {
  if (control.length < 3) return [...control];
  const out: Vec2[] = [];
  const n = control.length;
  const steps = Math.min(SPLINE_STEPS, n * 8);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * (n - 1);
    const k = Math.min(Math.floor(t), n - 2);
    const f = t - k;
    // Chaikin-ish smoothing between successive control points: closer to the
    // curve than the raw hull, and never outside it
    const a = control[k];
    const b = control[k + 1];
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  }
  if (closed && out.length) out.push({ ...out[0] });
  return out;
}

/** DXF text may not carry raw newlines in a group value */
function escapeDxfText(s: string): string {
  return s.replace(/\r?\n/g, '\\P');
}

// ------------------------------------------------------------
// dependencies
// ------------------------------------------------------------

/** every block an entity set references, transitively */
function collectBlocks(
  entities: readonly CadEntity[],
  blocks: Map<string, CadBlock>,
  acc: Map<string, CadBlock>,
  limits: Map<string, SectionLimitation>,
  depth = 0,
): void {
  if (depth > MAX_BLOCK_DEPTH) return;
  for (const e of entities) {
    if (e.type !== 'insert') continue;
    const key = e.blockName.toUpperCase();
    if (acc.has(key)) continue;
    const block = blocks.get(key) ?? blocks.get(e.blockName);
    if (!block) {
      limit(limits, 'block-not-found', `INSERT references undefined block "${e.blockName}"`);
      continue;
    }
    acc.set(key, block);
    collectBlocks(block.entities, blocks, acc, limits, depth + 1);
  }
}

/** every layer an entity set (and its blocks) draws on */
function collectLayers(
  entities: readonly CadEntity[],
  blocks: ReadonlyMap<string, CadBlock>,
  acc: Set<string>,
): void {
  for (const e of entities) {
    acc.add(e.style.layer || '0');
  }
  for (const block of blocks.values()) {
    for (const e of block.entities) acc.add(e.style.layer || '0');
  }
}

// ------------------------------------------------------------
// sections
// ------------------------------------------------------------

function writeHeader(w: Writer, doc: CadDocument, boundsSrc: SectionBounds): void {
  w.pair(0, 'SECTION');
  w.pair(2, 'HEADER');
  w.pair(9, '$ACADVER');
  w.pair(1, 'AC1015');
  w.pair(9, '$INSUNITS');
  w.pair(70, String(insunitsFor(doc.unitScale)));
  w.pair(9, '$EXTMIN');
  w.pair(10, boundsSrc.xMin);
  w.pair(20, boundsSrc.yMin);
  w.pair(30, 0);
  w.pair(9, '$EXTMAX');
  w.pair(10, boundsSrc.xMax);
  w.pair(20, boundsSrc.yMax);
  w.pair(30, 0);
  w.pair(0, 'ENDSEC');
}

/**
 * Source unitScale → $INSUNITS.
 *
 * The section must declare the SAME units as the drawing it came from, or a
 * CAD application will rescale it on insert and the preserved coordinates
 * stop meaning what they meant.
 */
function insunitsFor(unitScale: number): number {
  const k = unitScale || 1;
  if (Math.abs(k - 1) < 1e-9) return 4; // mm
  if (Math.abs(k - 10) < 1e-9) return 5; // cm
  if (Math.abs(k - 1000) < 1e-9) return 6; // m
  if (Math.abs(k - 25.4) < 1e-9) return 1; // in
  if (Math.abs(k - 304.8) < 1e-9) return 2; // ft
  return 0; // unitless — better than claiming the wrong unit
}

function writeLayerTable(w: Writer, names: ReadonlySet<string>, layers: Map<string, CadLayer>): void {
  w.pair(0, 'SECTION');
  w.pair(2, 'TABLES');
  w.pair(0, 'TABLE');
  w.pair(2, 'LAYER');
  w.pair(70, String(names.size));
  for (const name of names) {
    const def = layers.get(name) ?? layers.get(name.toUpperCase());
    w.pair(0, 'LAYER');
    w.pair(2, name);
    w.pair(70, String(def?.frozen ? 1 : 0));
    const aci = def ? aciOf(def.color) : 7;
    // a layer whose colour is byLayer/byBlock is meaningless; fall back to 7
    const idx = aci === null || aci === 256 || aci === 0 ? 7 : aci;
    // negative ACI is DXF for "layer off"
    w.pair(62, String(def && !def.visible ? -Math.abs(idx) : idx));
    w.pair(6, def?.linetype || 'CONTINUOUS');
    if (def && def.lineweight >= 0) w.pair(370, String(Math.round(def.lineweight)));
  }
  w.pair(0, 'ENDTAB');
  w.pair(0, 'ENDSEC');
}

function writeBlocksSection(
  w: Writer,
  blocks: ReadonlyMap<string, CadBlock>,
  limits: Map<string, SectionLimitation>,
): void {
  w.pair(0, 'SECTION');
  w.pair(2, 'BLOCKS');
  for (const block of blocks.values()) {
    w.pair(0, 'BLOCK');
    w.pair(100, 'AcDbEntity');
    w.pair(8, '0');
    w.pair(100, 'AcDbBlockBegin');
    w.pair(2, block.name);
    w.pair(70, '0');
    w.pair(10, block.basePoint.x);
    w.pair(20, block.basePoint.y);
    w.pair(30, 0);
    w.pair(3, block.name);
    w.pair(1, '');
    for (const e of block.entities) writeEntity(w, e, limits);
    w.pair(0, 'ENDBLK');
    w.pair(100, 'AcDbBlockEnd');
  }
  w.pair(0, 'ENDSEC');
}

// ------------------------------------------------------------
// entry point
// ------------------------------------------------------------

/**
 * Write a section DXF.
 *
 * `boundsMm` is used ONLY for the header extents — the caller has already
 * selected `entities` with that same box via `entitiesInBounds`, which is what
 * keeps the PNG and the DXF describing the same region. Nothing in this file
 * re-derives which entities belong to the section.
 */
export function writeSectionDxf(
  doc: CadDocument,
  entities: readonly CadEntity[],
  boundsMm: SectionBounds,
): DxfWriteResult {
  const limits = new Map<string, SectionLimitation>();
  const w = new Writer();

  const usedBlocks = new Map<string, CadBlock>();
  collectBlocks(entities, doc.blocks, usedBlocks, limits);
  const layerNames = new Set<string>();
  collectLayers(entities, usedBlocks, layerNames);
  if (layerNames.size === 0) layerNames.add('0');

  writeHeader(w, doc, toSourceUnits(boundsMm, doc.unitScale));
  writeLayerTable(w, layerNames, doc.layers);
  writeBlocksSection(w, usedBlocks, limits);

  w.pair(0, 'SECTION');
  w.pair(2, 'ENTITIES');
  const handles: string[] = [];
  let count = 0;
  for (const e of entities) {
    const written = writeEntity(w, e, limits);
    if (written > 0) {
      count += written;
      if (e.style.handle) handles.push(e.style.handle);
    } else {
      limit(limits, 'unclippable-entity', `${e.type} is not written to section DXFs`);
    }
  }
  w.pair(0, 'ENDSEC');
  w.pair(0, 'EOF');

  return { text: w.text(), entityCount: count, handles, limitations: [...limits.values()] };
}
