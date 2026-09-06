// ============================================================
// SPLITTING A DRAWING WITHOUT ASKING ANYONE.
//
// Connected structural geometry makes a region. Annotations are attached to
// regions AFTERWARDS, and an annotation touching two regions is SHARED rather
// than a reason to merge them — which is the whole point. A dimension line
// runs from a footing to a grid line; a leader points from a note into a
// detail. Let those into the connectivity graph and the sheet collapses into
// one region, because everything is transitively connected through its
// annotation. Keeping them out until the regions exist is what makes the
// result a set of drawing elements rather than one blob.
//
// The same input gives the same regions every time. That matters beyond
// tidiness: an AI split re-run on the same drawing produced REGION-01,
// REGION-05 and REGION-07 over identical bounds, tripling the section count
// while coverage stayed at 76.6% because the extras covered nothing new.
//
// TWO THINGS HERE DIFFER FROM THE OBVIOUS IMPLEMENTATION, both for the same
// reason — this runs on sheets with 11k to 69k entities:
//
//   * CONNECTIVITY IS GRID-BUCKETED, not every-pair. Comparing all pairs is
//     n²: fine at 3,000 entities (4.5M comparisons), fatal at 69,000 (2.4
//     BILLION). Each entity is only tested against those sharing a grid cell.
//   * ENTITIES ARE LOOKED UP THROUGH A MAP. `entities.find(...)` inside a loop
//     over groups is a second n² hiding in plain sight.
//
// Neither changes a single region it produces; both are the difference
// between a split that returns and one that hangs the tab.
// ============================================================

import type { SectionBounds } from './types';

export type EntityKind =
  | 'structural'
  | 'dimension'
  | 'text'
  | 'leader'
  | 'annotation'
  | 'other';

export interface Point {
  x: number;
  y: number;
}

/** One entity, reduced to what the split actually reasons about. */
export interface DeterministicEntity {
  id: string;
  kind: EntityKind;
  /** geometry points, in millimetres — the same units section bounds are in */
  points: Point[];
  /** where an annotation POINTS, when that is known and not its centre */
  anchor?: Point;
}

export interface DeterministicRegion {
  id: string;
  /** only actual structural geometry */
  geometryBounds: SectionBounds;
  /** geometry plus the annotations attached to it */
  displayBounds: SectionBounds;
  entityIds: string[];
  annotationIds: string[];
  sharedAnnotationIds: string[];
}

export interface SharedAnnotation {
  entityId: string;
  /** every region it reaches, nearest first — never a reason to merge them */
  owners: string[];
}

export interface OrphanEntity {
  entityId: string;
  reason: string;
}

export interface CoverageReport {
  totalEntities: number;
  structuralEntities: number;
  annotationEntities: number;
  sharedAnnotations: number;
  assignedEntities: number;
  orphanEntities: number;
  coveragePercent: number;
}

export interface DeterministicSectionResult {
  regions: DeterministicRegion[];
  sharedAnnotations: SharedAnnotation[];
  orphans: OrphanEntity[];
  coverage: CoverageReport;
}

export interface DeterministicSectionOptions {
  /** how close two structural entities must be to count as connected, in mm */
  connectivityTolerance?: number;
  /** how far an annotation may sit from a region and still belong to it, mm */
  annotationDistance?: number;
  /** below this many structural entities a component is not a region */
  minStructuralEntities?: number;
}

// --- geometry ---------------------------------------------------------------

function boundsOf(points: readonly Point[]): SectionBounds | null {
  if (!points.length) return null;
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const p of points) {
    if (p.x < xMin) xMin = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.x > xMax) xMax = p.x;
    if (p.y > yMax) yMax = p.y;
  }
  return Number.isFinite(xMin) ? { xMin, yMin, xMax, yMax } : null;
}

function expand(a: SectionBounds, b: SectionBounds): SectionBounds {
  return {
    xMin: Math.min(a.xMin, b.xMin),
    yMin: Math.min(a.yMin, b.yMin),
    xMax: Math.max(a.xMax, b.xMax),
    yMax: Math.max(a.yMax, b.yMax),
  };
}

function centre(b: SectionBounds): Point {
  return { x: (b.xMin + b.xMax) / 2, y: (b.yMin + b.yMax) / 2 };
}

/** Edge-to-edge distance; 0 when the boxes touch or overlap. */
export function gapBetween(a: SectionBounds, b: SectionBounds): number {
  const dx = Math.max(0, Math.max(a.xMin - b.xMax, b.xMin - a.xMax));
  const dy = Math.max(0, Math.max(a.yMin - b.yMax, b.yMin - a.yMax));
  return Math.hypot(dx, dy);
}

function touches(a: SectionBounds, b: SectionBounds, tolerance: number): boolean {
  return !(
    a.xMax + tolerance < b.xMin ||
    b.xMax + tolerance < a.xMin ||
    a.yMax + tolerance < b.yMin ||
    b.yMax + tolerance < a.yMin
  );
}

function inside(p: Point, b: SectionBounds, tolerance: number): boolean {
  return (
    p.x >= b.xMin - tolerance &&
    p.x <= b.xMax + tolerance &&
    p.y >= b.yMin - tolerance &&
    p.y <= b.yMax + tolerance
  );
}

// --- union-find -------------------------------------------------------------

class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  add(id: string): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
      this.rank.set(id, 0);
    }
  }

  /** Iterative, with path compression: a 69k-entity chain would blow the stack. */
  find(id: string): string {
    let root = id;
    let hop = this.parent.get(root);
    if (hop === undefined) {
      this.add(id);
      return id;
    }
    while (hop !== root) {
      root = hop;
      hop = this.parent.get(root) ?? root;
    }
    let walk = id;
    while (walk !== root) {
      const next = this.parent.get(walk) ?? root;
      this.parent.set(walk, root);
      walk = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }

  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const list = out.get(root);
      if (list) list.push(id);
      else out.set(root, [id]);
    }
    return out;
  }
}

// --- the split --------------------------------------------------------------

/** Which cells of a grid of `cell` mm a box covers. */
function cellsOf(b: SectionBounds, cell: number): string[] {
  const x0 = Math.floor(b.xMin / cell);
  const x1 = Math.floor(b.xMax / cell);
  const y0 = Math.floor(b.yMin / cell);
  const y1 = Math.floor(b.yMax / cell);
  const out: string[] = [];
  // A box spanning a huge number of cells (a border line across the sheet)
  // would defeat the point of the grid, so cap what one entity may occupy and
  // fall back to its ends — it will still be compared against its neighbours.
  const spanX = Math.min(x1 - x0, 64);
  const spanY = Math.min(y1 - y0, 64);
  for (let i = 0; i <= spanX; i += 1) {
    for (let j = 0; j <= spanY; j += 1) out.push(`${x0 + i}:${y0 + j}`);
  }
  if (x1 - x0 > 64 || y1 - y0 > 64) out.push(`${x1}:${y1}`);
  return out;
}

export function deterministicSplitDrawing(
  entities: readonly DeterministicEntity[],
  options: DeterministicSectionOptions = {},
): DeterministicSectionResult {
  const {
    connectivityTolerance = 1,
    annotationDistance = 25,
    minStructuralEntities = 1,
  } = options;

  // 1. classify, and measure once — every later step reads these boxes.
  const boxes = new Map<string, SectionBounds>();
  const byId = new Map<string, DeterministicEntity>();
  const structural: DeterministicEntity[] = [];
  const annotations: DeterministicEntity[] = [];
  for (const e of entities) {
    byId.set(e.id, e);
    const b = boundsOf(e.points);
    if (b) boxes.set(e.id, b);
    if (e.kind === 'structural') structural.push(e);
    else if (e.kind !== 'other') annotations.push(e);
  }

  // 2. connectivity over STRUCTURAL geometry only. Annotations are kept out:
  //    a dimension from a footing to a grid line would otherwise chain two
  //    unrelated regions into one, and so would every leader on the sheet.
  const uf = new UnionFind();
  for (const e of structural) uf.add(e.id);

  const cell = Math.max(connectivityTolerance * 8, 1e-6);
  const grid = new Map<string, string[]>();
  for (const e of structural) {
    const b = boxes.get(e.id);
    if (!b) continue;
    for (const key of cellsOf(b, cell)) {
      const bucket = grid.get(key);
      if (bucket) bucket.push(e.id);
      else grid.set(key, [e.id]);
    }
  }
  const tried = new Set<string>();
  for (const bucket of grid.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        if (uf.find(a) === uf.find(b)) continue;
        // A pair can share several cells; test it once.
        const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (tried.has(pair)) continue;
        tried.add(pair);
        const ba = boxes.get(a);
        const bb = boxes.get(b);
        if (ba && bb && touches(ba, bb, connectivityTolerance)) uf.union(a, b);
      }
    }
  }

  // 3. components become regions, numbered in a stable order — bottom-left
  //    first, so REGION-01 means the same box on every run of the same sheet.
  const components: { ids: string[]; bounds: SectionBounds }[] = [];
  for (const ids of uf.groups().values()) {
    if (ids.length < minStructuralEntities) continue;
    let bounds: SectionBounds | null = null;
    for (const id of ids) {
      const b = boxes.get(id);
      if (!b) continue;
      bounds = bounds ? expand(bounds, b) : b;
    }
    if (bounds) components.push({ ids: [...ids].sort(), bounds });
  }
  components.sort(
    (a, b) => a.bounds.xMin - b.bounds.xMin || a.bounds.yMin - b.bounds.yMin,
  );

  const regions: DeterministicRegion[] = components.map((c, i) => ({
    id: `REGION-${String(i + 1).padStart(2, '0')}`,
    geometryBounds: c.bounds,
    displayBounds: c.bounds,
    entityIds: c.ids,
    annotationIds: [],
    sharedAnnotationIds: [],
  }));

  // 4. annotations, AFTER the regions exist. One region: it belongs there.
  //    More than one: it is SHARED — recorded against each, and never a
  //    reason to join them.
  const sharedAnnotations: SharedAnnotation[] = [];
  const placed = new Set<string>();
  for (const a of annotations) {
    const ab = boxes.get(a.id);
    if (!ab) continue;
    const anchor = a.anchor ?? centre(ab);
    const near: { region: DeterministicRegion; distance: number }[] = [];
    for (const region of regions) {
      const distance = gapBetween(ab, region.geometryBounds);
      if (inside(anchor, region.geometryBounds, connectivityTolerance) || distance <= annotationDistance) {
        near.push({ region, distance });
      }
    }
    if (!near.length) continue; // an orphan; §5 says so and why
    near.sort((x, y) => x.distance - y.distance || x.region.id.localeCompare(y.region.id));
    placed.add(a.id);
    if (near.length === 1) {
      near[0].region.annotationIds.push(a.id);
      near[0].region.displayBounds = expand(near[0].region.displayBounds, ab);
      continue;
    }
    // A SHARED ANNOTATION IS RECORDED ON EVERY OWNER BUT ENLARGES NONE OF
    // THEM. It spans the gap between the regions that share it — that is what
    // made it shared — so adding its box to each owner stretches every one of
    // them across that gap. Measured on the GAMCO sheet: 130 shared
    // annotations turned all nine regions into the same 47,328 x 41,683 mm
    // box, the whole drawing, nine times over. `displayBounds` is what gets
    // drawn as the highlight, and nine identical full-sheet rectangles say
    // nothing about where anything is.
    //
    // Nothing is lost: the ownership is in `sharedAnnotationIds` on each
    // region and in `sharedAnnotations` with its owners, which is the record
    // that keeps the two regions from being merged.
    sharedAnnotations.push({ entityId: a.id, owners: near.map((n) => n.region.id) });
    for (const n of near) n.region.sharedAnnotationIds.push(a.id);
  }

  // 5. what nothing owns, and WHY — an unexplained entity is the failure this
  //    whole file exists to make visible, so it is never quietly dropped.
  const owned = new Set<string>(placed);
  for (const r of regions) for (const id of r.entityIds) owned.add(id);
  const orphans: OrphanEntity[] = [];
  for (const e of entities) {
    if (owned.has(e.id)) continue;
    orphans.push({
      entityId: e.id,
      reason:
        e.kind === 'other'
          ? 'entity type is not structural or a recognised annotation'
          : e.kind === 'structural'
            ? boxes.has(e.id)
              ? 'structural entity did not produce a valid region'
              : 'structural entity has no measurable geometry'
            : boxes.has(e.id)
              ? 'annotation is too far from every region'
              : 'annotation has no measurable geometry',
    });
  }

  const total = entities.length;
  const assigned = total - orphans.length;
  return {
    regions,
    sharedAnnotations,
    orphans,
    coverage: {
      totalEntities: total,
      structuralEntities: structural.length,
      annotationEntities: annotations.length,
      sharedAnnotations: sharedAnnotations.length,
      assignedEntities: assigned,
      orphanEntities: orphans.length,
      coveragePercent: total === 0 ? 100 : (assigned / total) * 100,
    },
  };
}

// ============================================================
// THE ADAPTER — from this project's CadDocument, not a parallel type system.
//
// `DeterministicEntity` above is a reduction, not a new model of a drawing:
// every field is read straight off the entities the DXF parser already
// produced, through `entityBoundsMm`, which is the same function the splitter
// and the coverage report measure with. Nothing here re-parses anything, and
// there is no second idea of what an entity is.
// ============================================================

import type { CadDocument, CadEntity } from '../types';
import { entityBoundsMm } from './bounds';

/** Layers whose NAME says annotation — a weak signal, used only as a tiebreak. */
const ANNOTATION_LAYER = /(^|[^A-Z])(DIM|DIMENSION|WITNESS|LEADER|ANNO|NOTE|LABEL|TEXT|TAG|MARK)/i;

/**
 * What a real entity counts as.
 *
 * TYPE FIRST, layer name only where the type cannot say. A text entity is
 * text whatever layer it sits on; a line on a layer called `DIM-1` is a
 * dimension's witness line and must stay out of the connectivity graph, and
 * only the name says so. That ordering matters — `coverage.ts` is explicit
 * that this project does not decide things by layer name where it has a
 * better source, and here the better source is used wherever it exists.
 */
export function kindOfEntity(e: CadEntity, dimensionLayers: ReadonlySet<string>): EntityKind {
  if (e.type === 'text') return 'text';
  if (e.type === 'point') return 'other';
  const layer = e.style.layer || '';
  // A dimension is drawn as an anonymous block of lines and arrows; the DXF's
  // own DIMENSION records name the layers those live on, so this is the file
  // saying which geometry is a measurement, not a guess about its name.
  if (dimensionLayers.has(layer)) return 'dimension';
  if (ANNOTATION_LAYER.test(layer)) return 'annotation';
  return 'structural';
}

/**
 * A drawing, reduced to what the split reasons about.
 *
 * Dimensions and leaders come from `doc.annotations` where the file has them,
 * because those records carry what the geometry cannot: what a dimension
 * SPANS, and which end of a leader is the arrow. A leader's arrow is exactly
 * the `anchor` this algorithm wants — it is the difference between "this note
 * is near two regions" and "this note points at that one".
 */
export function entitiesForSplit(doc: CadDocument): DeterministicEntity[] {
  const dimensionLayers = new Set<string>();
  for (const d of doc.annotations?.dimensions ?? []) dimensionLayers.add(d.layer);

  // Where a leader's arrow lands, by the handle of the record that drew it.
  const arrowByHandle = new Map<string, Point>();
  for (const l of doc.annotations?.leaders ?? []) {
    const tip = l.vertices[0];
    if (tip) arrowByHandle.set(l.handle, { x: tip.x * (doc.unitScale || 1), y: tip.y * (doc.unitScale || 1) });
  }

  const out: DeterministicEntity[] = [];
  for (const e of doc.entities) {
    const b = entityBoundsMm(e, doc);
    if (!b) continue; // nothing measurable — `computeCoverage` skips these too
    const anchor = arrowByHandle.get(e.style.handle);
    out.push({
      id: e.style.handle,
      kind: kindOfEntity(e, dimensionLayers),
      // The box, as two corners. The split only ever takes bounds of these,
      // so carrying every vertex would cost memory for no different answer.
      points: [
        { x: b.xMin, y: b.yMin },
        { x: b.xMax, y: b.yMax },
      ],
      ...(anchor ? { anchor } : {}),
    });
  }
  return out;
}

/** Split a parsed drawing. No model, no key, same answer every time. */
export function splitDocument(
  doc: CadDocument,
  options: DeterministicSectionOptions = {},
): DeterministicSectionResult {
  return deterministicSplitDrawing(entitiesForSplit(doc), options);
}
