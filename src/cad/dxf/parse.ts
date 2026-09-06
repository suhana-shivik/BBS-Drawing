// DXF → CadDocument.
//
// Nothing is discarded: unhandled entity types are tallied into
// diagnostics, and far-flung geometry is clustered into regions rather
// than rejected.
import type {
  CadBlock,
  CadDiagnostic,
  CadDocument,
  CadEntity,
  CadLayer,
  CadLayout,
  CadLinetype,
  CadRegion,
  CadTextStyle,
  CadVertex,
  CadViewport,
  Vec2,
} from '../types';
import { BY_LAYER } from '../types';
import { aciToHex } from '../../io/aci';
import { newId } from '../../core/types';
import type { Pair, Record0 } from './reader';
import {
  findSection,
  headerNum,
  num,
  numOr,
  readPairs,
  splitRecords,
  val,
} from './reader';
import { convertEntity, dimensionBlockRef, ocsToWcs, readStyle } from './entities';
import { emptyAnnotations, readDimension, readLeader, type CadAnnotations } from './annotations';
import { verifyUnitScale } from './units';

const DEG = Math.PI / 180;

/** $INSUNITS → millimetres per drawing unit */
function unitScaleOf(insunits: number | undefined): number {
  switch (insunits) {
    case 1: return 25.4;      // inches
    case 2: return 304.8;     // feet
    case 4: return 1;         // mm
    case 5: return 10;        // cm
    case 6: return 1000;      // m
    case 8: return 0.0254;    // microinches… rare, kept for completeness
    case 9: return 0.001;     // mils
    case 10: return 914.4;    // yards
    default: return 1;        // unitless → assume mm
  }
}

// ------------------------------------------------------------
// tables
// ------------------------------------------------------------

function parseTables(pairs: Pair[]): {
  layers: Map<string, CadLayer>;
  linetypes: Map<string, CadLinetype>;
  textStyles: Map<string, CadTextStyle>;
} {
  const layers = new Map<string, CadLayer>();
  const linetypes = new Map<string, CadLinetype>();
  const textStyles = new Map<string, CadTextStyle>();

  const sec = findSection(pairs, 'TABLES');
  if (!sec) return { layers, linetypes, textStyles };
  const recs = splitRecords(pairs, sec[0], sec[1]);

  for (const r of recs) {
    if (r.type === 'LAYER') {
      const name = val(r, 2);
      if (!name) continue;
      const aci = numOr(r, 62, 7);
      const hex = aciToHex(Math.abs(aci)) ?? '#ffffff';
      const flags = numOr(r, 70, 0);
      const tr = num(r, 440);
      layers.set(name, {
        name,
        color: { kind: 'rgb', hex },
        lineweight: numOr(r, 370, -3),
        linetype: val(r, 6) ?? 'CONTINUOUS',
        // a negative colour index means the layer is switched off
        visible: aci >= 0,
        frozen: (flags & 1) === 1,
        transparency: tr === undefined ? 0 : Math.min(1, Math.max(0, (tr & 0xff) / 255)),
      });
    } else if (r.type === 'LTYPE') {
      const name = val(r, 2);
      if (!name) continue;
      const pattern: number[] = [];
      for (const p of r.pairs) {
        if (p.code === 49) {
          const f = Number(p.value);
          if (Number.isFinite(f)) pattern.push(f);
        }
      }
      linetypes.set(name.toUpperCase(), {
        name,
        pattern,
        length: numOr(r, 40, pattern.reduce((s, d) => s + Math.abs(d), 0)),
      });
    } else if (r.type === 'STYLE') {
      const name = val(r, 2);
      if (!name) continue;
      textStyles.set(name.toUpperCase(), {
        name,
        font: val(r, 3) ?? '',
        bigFont: val(r, 4) ?? '',
        widthFactor: numOr(r, 41, 1) || 1,
        oblique: numOr(r, 50, 0) * DEG,
        height: numOr(r, 40, 0),
      });
    }
  }
  return { layers, linetypes, textStyles };
}

// ------------------------------------------------------------
// entity streams (shared by modelspace, blocks and layouts)
// ------------------------------------------------------------

interface ConvertResult {
  entities: CadEntity[];
  unsupported: Map<string, number>;
  /**
   * Structured annotation, collected ALONGSIDE the geometry rather than
   * instead of it. The renderer still gets the anonymous block and the leader
   * polyline exactly as before; this carries the structure those two throw
   * away. See dxf/annotations.ts.
   */
  annotations: CadAnnotations;
}

/** legacy POLYLINE spans following VERTEX records up to SEQEND */
function readLegacyPolyline(recs: Record0[], start: number): { entity: CadEntity | null; next: number } {
  const head = recs[start];
  const style = readStyle(head);
  const flags = numOr(head, 70, 0);
  const verts: CadVertex[] = [];
  let i = start + 1;
  while (i < recs.length && recs[i].type !== 'SEQEND') {
    const r = recs[i];
    if (r.type === 'VERTEX') {
      const x = num(r, 10);
      const y = num(r, 20);
      if (x !== undefined && y !== undefined) {
        const p = ocsToWcs({ x, y }, style.normal);
        const b = num(r, 42);
        verts.push(b ? { x: p.x, y: p.y, bulge: b } : { x: p.x, y: p.y });
      }
    }
    i++;
  }
  if (i < recs.length) i++; // consume SEQEND
  if (verts.length < 2) return { entity: null, next: i };
  return {
    entity: { type: 'polyline', style, vertices: verts, closed: (flags & 1) === 1 },
    next: i,
  };
}

function convertStream(
  recs: Record0[],
  opts: { shouldCancel?: () => boolean } = {},
): ConvertResult {
  const entities: CadEntity[] = [];
  const unsupported = new Map<string, number>();
  const annotations = emptyAnnotations();
  const NOISE = new Set(['SEQEND', 'VERTEX', 'ATTDEF', 'ENDBLK', 'BLOCK', 'VIEWPORT']);

  let i = 0;
  while (i < recs.length) {
    if ((i & 1023) === 0 && opts.shouldCancel?.()) break;
    const r = recs[i];

    if (r.type === 'POLYLINE') {
      const { entity, next } = readLegacyPolyline(recs, i);
      if (entity) entities.push(entity);
      i = next;
      continue;
    }

    // ATTRIB carries visible block attribute text
    if (r.type === 'ATTRIB') {
      const e = convertEntity({ ...r, type: 'TEXT' });
      if (e) entities.push(e);
      i++;
      continue;
    }

    // DIMENSION renders through the anonymous block the CAD app generated —
    // and its STRUCTURE (what it spans, what it measures) is kept too, because
    // the block alone is a number floating near some linework.
    if (r.type === 'DIMENSION') {
      const e = dimensionBlockRef(r);
      if (e) entities.push(e);
      else unsupported.set('DIMENSION', (unsupported.get('DIMENSION') ?? 0) + 1);
      const d = readDimension(r);
      if (d) annotations.dimensions.push(d);
      i++;
      continue;
    }

    // A LEADER draws as a polyline and MEANS "this text refers to that point".
    if (r.type === 'LEADER') {
      const l = readLeader(r);
      if (l) annotations.leaders.push(l);
      const e = convertEntity(r);
      if (e) entities.push(e);
      i++;
      continue;
    }

    const e = convertEntity(r);
    if (e) {
      entities.push(e);
    } else if (!NOISE.has(r.type)) {
      unsupported.set(r.type, (unsupported.get(r.type) ?? 0) + 1);
    }
    i++;
  }
  return { entities, unsupported, annotations };
}

// ------------------------------------------------------------
// blocks
// ------------------------------------------------------------

function parseBlocks(
  pairs: Pair[],
  unsupported: Map<string, number>,
  shouldCancel?: () => boolean,
): Map<string, CadBlock> {
  const blocks = new Map<string, CadBlock>();
  const sec = findSection(pairs, 'BLOCKS');
  if (!sec) return blocks;
  const recs = splitRecords(pairs, sec[0], sec[1]);

  let i = 0;
  while (i < recs.length) {
    if (recs[i].type !== 'BLOCK') { i++; continue; }
    const head = recs[i];
    const name = val(head, 2) ?? '';
    const basePoint: Vec2 = { x: numOr(head, 10, 0), y: numOr(head, 20, 0) };
    // collect until ENDBLK
    let j = i + 1;
    const body: Record0[] = [];
    while (j < recs.length && recs[j].type !== 'ENDBLK') {
      body.push(recs[j]);
      j++;
    }
    const res = convertStream(body, { shouldCancel });
    for (const [k, v] of res.unsupported) unsupported.set(k, (unsupported.get(k) ?? 0) + v);
    if (name) blocks.set(name.toUpperCase(), { name, basePoint, entities: res.entities });
    i = j + 1;
  }
  return blocks;
}

// ------------------------------------------------------------
// layouts (paperspace)
// ------------------------------------------------------------

function parseLayouts(
  pairs: Pair[],
  entityRecs: Record0[],
  unsupported: Map<string, number>,
): CadLayout[] {
  // Layout names/paper sizes live in OBJECTS; paperspace geometry lives in
  // ENTITIES flagged 67=1. We keep it simple: one layout bucket per
  // paperspace owner, named from the OBJECTS records when available.
  const names: string[] = [];
  const sizes: { w: number; h: number }[] = [];
  const objSec = findSection(pairs, 'OBJECTS');
  if (objSec) {
    for (const r of splitRecords(pairs, objSec[0], objSec[1])) {
      if (r.type !== 'LAYOUT') continue;
      const n = val(r, 1) ?? val(r, 2);
      if (!n) continue;
      names.push(n);
      // 10/20 = paper size (mm) in the plot settings block
      sizes.push({ w: numOr(r, 10, 0), h: numOr(r, 20, 0) });
    }
  }

  const paperRecs = entityRecs.filter((r) => numOr(r, 67, 0) === 1);
  if (paperRecs.length === 0 && names.length === 0) return [];

  const res = convertStream(paperRecs);
  for (const [k, v] of res.unsupported) unsupported.set(k, (unsupported.get(k) ?? 0) + v);

  const viewports: CadViewport[] = [];
  for (const r of entityRecs) {
    if (r.type !== 'VIEWPORT') continue;
    const cx = num(r, 10), cy = num(r, 20);
    const w = num(r, 40), h = num(r, 41);
    if (cx === undefined || cy === undefined || w === undefined || h === undefined) continue;
    const vh = numOr(r, 45, 0); // view height in model units
    viewports.push({
      center: { x: cx, y: cy },
      width: w,
      height: h,
      viewCenter: { x: numOr(r, 12, 0), y: numOr(r, 22, 0) },
      scale: vh > 0 ? h / vh : 1,
      twist: numOr(r, 51, 0) * DEG,
      frozenLayers: r.pairs.filter((p) => p.code === 331).map((p) => p.value),
    });
  }

  const name = names[0] ?? 'Layout1';
  const size = sizes[0] ?? { w: 0, h: 0 };
  return [
    {
      name,
      paperWidth: size.w,
      paperHeight: size.h,
      entities: res.entities,
      viewports,
    },
  ];
}

// ------------------------------------------------------------
// extents + region clustering
// ------------------------------------------------------------

function entityPoints(
  e: CadEntity,
  out: Vec2[],
  blocks?: Map<string, CadBlock>,
  depth = 0,
): void {
  switch (e.type) {
    case 'line': out.push(e.a, e.b); break;
    case 'polyline': for (const v of e.vertices) out.push({ x: v.x, y: v.y }); break;
    case 'circle':
    case 'arc':
      out.push(
        { x: e.center.x - e.radius, y: e.center.y - e.radius },
        { x: e.center.x + e.radius, y: e.center.y + e.radius },
      );
      break;
    case 'ellipse': {
      const r = Math.hypot(e.major.x, e.major.y);
      out.push({ x: e.center.x - r, y: e.center.y - r }, { x: e.center.x + r, y: e.center.y + r });
      break;
    }
    case 'spline':
      for (const p of e.fitPoints.length ? e.fitPoints : e.controlPoints) out.push(p);
      break;
    case 'text': out.push(e.position); break;
    case 'insert': {
      out.push(e.position);
      // A block's contents usually extend well past its insertion point.
      // Ignoring that makes region bounds too small and misclusters drawings.
      const block = blocks?.get(e.blockName.toUpperCase());
      if (!block || depth > 3) break;
      const inner: Vec2[] = [];
      for (const child of block.entities) entityPoints(child, inner, blocks, depth + 1);
      const bb = bboxOf(inner);
      if (!bb) break;
      const cos = Math.cos(e.rotation);
      const sin = Math.sin(e.rotation);
      const sx = e.scale.x || 1;
      const sy = e.scale.y || 1;
      for (const corner of [
        bb.min,
        { x: bb.max.x, y: bb.min.y },
        bb.max,
        { x: bb.min.x, y: bb.max.y },
      ]) {
        const lx = (corner.x - block.basePoint.x) * sx;
        const ly = (corner.y - block.basePoint.y) * sy;
        out.push({
          x: e.position.x + lx * cos - ly * sin,
          y: e.position.y + lx * sin + ly * cos,
        });
      }
      break;
    }
    case 'solid': for (const p of e.points) out.push(p); break;
    case 'point': out.push(e.position); break;
    case 'hatch':
      for (const l of e.loops) for (const v of l.vertices) out.push({ x: v.x, y: v.y });
      break;
  }
}

function bboxOf(pts: Vec2[]): { min: Vec2; max: Vec2 } | null {
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return null;
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/**
 * Cluster entities into spatially separated regions.
 *
 * Real files park unrelated drawings (schedules, details, legends) far apart
 * in modelspace, and some carry stray geometry kilometres away. Fitting the
 * union renders the real drawing a few pixels wide. We therefore CLASSIFY
 * rather than reject: every entity stays in the document and lands in some
 * region; the UI opens on the densest one and can always show all.
 */
function detectRegions(
  entities: CadEntity[],
  blocks: Map<string, CadBlock>,
): CadRegion[] {
  const boxes: ({ min: Vec2; max: Vec2 } | null)[] = entities.map((e) => {
    const pts: Vec2[] = [];
    entityPoints(e, pts, blocks);
    return bboxOf(pts);
  });

  const idx: number[] = [];
  for (let i = 0; i < boxes.length; i++) if (boxes[i]) idx.push(i);
  if (idx.length === 0) return [];

  // Proximity clustering: entities join the same region when they sit within
  // `reach` of each other, where reach is derived from the drawing's own
  // typical entity size. Unrelated drawings parked side by side in modelspace
  // are separated by voids far larger than that, so they fall out as distinct
  // regions while a single drawing stays whole.
  const diags: number[] = [];
  for (const i of idx) {
    const b = boxes[i]!;
    diags.push(Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y));
  }
  const sortedDiag = [...diags].sort((a, b) => a - b);
  // a low percentile, not the median: block-expanded bounding boxes skew the
  // upper half badly, and a reach derived from those bridges the very voids
  // we are trying to detect
  const typical = sortedDiag[Math.floor(sortedDiag.length * 0.35)] || 0;
  let spanX = 0;
  let spanY = 0;
  {
    const all: Vec2[] = [];
    for (const i of idx) { all.push(boxes[i]!.min, boxes[i]!.max); }
    const bb = bboxOf(all)!;
    spanX = bb.max.x - bb.min.x;
    spanY = bb.max.y - bb.min.y;
  }
  const diag = Math.hypot(spanX, spanY);
  // generous enough to keep a plan together, tight enough to cut real voids
  const reach = Math.max(typical * 3, diag * 0.0015, 1e-6);

  // union-find over a uniform grid, so this stays near-linear
  const parent = new Int32Array(boxes.length).fill(-1);
  for (const i of idx) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const cell = reach;
  const key = (cx: number, cy: number): string => `${cx},${cy}`;
  const grid = new Map<string, number[]>();
  const cellsOf = (i: number): { x0: number; y0: number; x1: number; y1: number } => {
    const b = boxes[i]!;
    return {
      x0: Math.floor(b.min.x / cell), y0: Math.floor(b.min.y / cell),
      x1: Math.floor(b.max.x / cell), y1: Math.floor(b.max.y / cell),
    };
  };
  // huge entities would blanket the grid; cap how many cells one may occupy
  const MAX_CELLS = 400;
  for (const i of idx) {
    const c = cellsOf(i);
    const nx = c.x1 - c.x0 + 1;
    const ny = c.y1 - c.y0 + 1;
    if (nx * ny > MAX_CELLS) {
      // register only its corners; big items still link what they touch
      for (const [cx, cy] of [[c.x0, c.y0], [c.x1, c.y0], [c.x0, c.y1], [c.x1, c.y1]]) {
        const k = key(cx, cy);
        const list = grid.get(k);
        if (list) list.push(i); else grid.set(k, [i]);
      }
      continue;
    }
    for (let cx = c.x0; cx <= c.x1; cx++) {
      for (let cy = c.y0; cy <= c.y1; cy++) {
        const k = key(cx, cy);
        const list = grid.get(k);
        if (list) list.push(i); else grid.set(k, [i]);
      }
    }
  }

  const near = (a: number, b: number): boolean => {
    const A = boxes[a]!, B = boxes[b]!;
    const dx = Math.max(0, Math.max(A.min.x - B.max.x, B.min.x - A.max.x));
    const dy = Math.max(0, Math.max(A.min.y - B.max.y, B.min.y - A.max.y));
    return dx <= reach && dy <= reach;
  };

  for (const [k, list] of grid) {
    const [cxs, cys] = k.split(',');
    const cx = Number(cxs), cy = Number(cys);
    for (let dx = 0; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy < 0) continue; // each neighbour pair once
        const other = grid.get(key(cx + dx, cy + dy));
        if (!other) continue;
        for (const a of list) {
          for (const b of other) {
            if (a !== b && find(a) !== find(b) && near(a, b)) union(a, b);
          }
        }
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  for (const i of idx) {
    const r = find(i);
    const list = byRoot.get(r);
    if (list) list.push(i); else byRoot.set(r, [i]);
  }
  let groups = [...byRoot.values()];

  // A drawing shouldn't shatter into hundreds of slivers: fold tiny
  // fragments into the nearest substantial group so nothing is orphaned.
  if (groups.length > 12) {
    groups.sort((a, b) => b.length - a.length);
    const keep = groups.slice(0, 12);
    const rest = groups.slice(12).flat();
    if (rest.length) {
      const centreOf = (g: number[]): Vec2 => {
        const pts: Vec2[] = [];
        for (const i of g) { pts.push(boxes[i]!.min, boxes[i]!.max); }
        const bb = bboxOf(pts)!;
        return { x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2 };
      };
      const centres = keep.map(centreOf);
      for (const i of rest) {
        const b = boxes[i]!;
        const c = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
        let best = 0;
        let bestD = Infinity;
        for (let k = 0; k < centres.length; k++) {
          const d = Math.hypot(centres[k].x - c.x, centres[k].y - c.y);
          if (d < bestD) { bestD = d; best = k; }
        }
        keep[best].push(i);
      }
    }
    groups = keep;
  }

  const regions: CadRegion[] = groups.map((g) => {
    const pts: Vec2[] = [];
    for (const i of g) {
      const b = boxes[i]!;
      pts.push(b.min, b.max);
    }
    const bb = bboxOf(pts)!;
    return {
      id: newId('rgn'),
      label: '',
      min: bb.min,
      max: bb.max,
      entityCount: g.length,
      indices: g,
    };
  });

  // biggest first, so the UI's default is the main drawing
  regions.sort((a, b) => b.entityCount - a.entityCount);
  regions.forEach((r, i) => {
    r.label = i === 0 ? 'Main drawing' : `Region ${i + 1}`;
  });
  return regions;
}

// ------------------------------------------------------------
// entry point
// ------------------------------------------------------------

export function parseDXF(
  text: string,
  fileName: string,
  onProgress?: (phase: string, pct: number) => void,
  shouldCancel?: () => boolean,
): CadDocument {
  const report = (phase: string, pct: number): void => onProgress?.(phase, pct);

  report('Reading file', 0);
  const pairs = readPairs(text);
  if (pairs.length === 0) throw new Error('This file does not look like a DXF drawing.');

  report('Reading tables', 12);
  const { layers, linetypes, textStyles } = parseTables(pairs);
  if (!layers.has('0')) {
    layers.set('0', {
      name: '0',
      color: { kind: 'rgb', hex: '#ffffff' },
      lineweight: -3,
      linetype: 'CONTINUOUS',
      visible: true,
      frozen: false,
      transparency: 0,
    });
  }

  const unsupported = new Map<string, number>();

  report('Reading blocks', 25);
  const blocks = parseBlocks(pairs, unsupported, shouldCancel);

  report('Reading entities', 45);
  const entSec = findSection(pairs, 'ENTITIES');
  const entRecs = entSec ? splitRecords(pairs, entSec[0], entSec[1]) : [];
  // modelspace only; paperspace records (67=1) go to layouts
  const modelRecs = entRecs.filter((r) => numOr(r, 67, 0) !== 1);
  const res = convertStream(modelRecs, { shouldCancel });
  for (const [k, v] of res.unsupported) unsupported.set(k, (unsupported.get(k) ?? 0) + v);

  report('Reading layouts', 72);
  const layouts = parseLayouts(pairs, entRecs, unsupported);

  report('Analysing regions', 85);
  const regions = detectRegions(res.entities, blocks);

  const allPts: Vec2[] = [];
  for (const e of res.entities) entityPoints(e, allPts, blocks);
  const rawExtents = bboxOf(allPts);

  // $INSUNITS is a claim, not a fact — check it against the drawing itself
  const declared = unitScaleOf(headerNum(pairs, '$INSUNITS', 70));
  const verdict = verifyUnitScale(declared, res.entities);
  const unitScale = verdict.unitScale;


  // Entity coordinates stay in source units (the display list applies the
  // unit transform), but extents and region bounds are published in mm so
  // callers can compare them directly with model-space geometry.
  const toMm = (p: Vec2): Vec2 => ({ x: p.x * unitScale, y: p.y * unitScale });
  const extents = rawExtents
    ? { min: toMm(rawExtents.min), max: toMm(rawExtents.max) }
    : null;
  for (const r of regions) {
    r.min = toMm(r.min);
    r.max = toMm(r.max);
  }

  const diagnostics: CadDiagnostic[] = [];
  if (verdict.overridden) {
    diagnostics.push({
      severity: 'warning',
      code: 'unit-override',
      message: verdict.reason,
      count: 1,
    });
  }
  for (const [type, count] of [...unsupported].sort((a, b) => b[1] - a[1])) {
    diagnostics.push({
      severity: 'warning',
      code: 'unsupported-entity',
      message: `${type} is not rendered`,
      count,
    });
  }
  if (regions.length > 1) {
    diagnostics.push({
      severity: 'info',
      code: 'multiple-regions',
      message: `${regions.length} separate drawing regions found in modelspace — all kept`,
      count: regions.length,
    });
  }

  report('Done', 100);

  return {
    id: newId('cad'),
    name: fileName.replace(/\.[^.]+$/, ''),
    sourceFile: fileName,
    unitScale,
    layers,
    linetypes,
    textStyles,
    blocks,
    entities: res.entities,
    annotations: res.annotations,
    layouts,
    regions,
    diagnostics,
    extents,
  };
}
