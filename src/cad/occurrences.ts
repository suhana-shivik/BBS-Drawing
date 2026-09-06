// Canonical CAD block-occurrence index.
//
// A DXF INSERT is a selectable source entity, but it can represent many real
// placements through MINSERT arrays and nested block definitions. Quantity
// consumers use placementCount; canvas selection uses sourceHandles. Keeping
// both in one index prevents each screen inventing its own meaning of "count".
import type { CadDocument, CadEntity, CadInsert, Vec2 } from './types';
import { apply, compose, type Xform } from './displayList';

const MAX_DEPTH = 8;
const MAX_ARRAY = 1_000_000;
const MAX_MATERIALISED = 250_000;

export interface CadOccurrence {
  id: string;
  blockName: string;
  /** top-level INSERT handle that can be selected in the source drawing */
  sourceHandle: string;
  /** handle of the INSERT definition encountered at this nesting level */
  definitionHandle: string;
  path: string[];
  row: number;
  col: number;
  depth: number;
  effectiveLayer: string;
  transform: Xform;
  /** final insertion/base point in millimetres */
  position: Vec2;
}

export interface CadOccurrenceBlockSummary {
  name: string;
  placementCount: number;
  sourceEntityCount: number;
  sourceHandles: string[];
  layers: string[];
}

export interface CadOccurrenceIndex {
  occurrences: CadOccurrence[];
  blocks: CadOccurrenceBlockSummary[];
  placementCount: number;
  sourceEntityCount: number;
  truncated: boolean;
}

export interface CadOccurrenceOptions {
  regionId?: string | null;
  layers?: ReadonlySet<string>;
  /** restrict roots to selected top-level INSERT handles */
  sourceHandles?: ReadonlySet<string>;
}

interface SummaryAcc {
  name: string;
  placementCount: number;
  sourceHandles: Set<string>;
  layers: Set<string>;
}

function localTransform(insert: CadInsert, base: Vec2, col: number, row: number): Xform {
  const cos = Math.cos(insert.rotation);
  const sin = Math.sin(insert.rotation);
  const sx = insert.scale.x || 1;
  const sy = insert.scale.y || 1;
  const ox = insert.position.x + col * insert.colSpacing;
  const oy = insert.position.y + row * insert.rowSpacing;
  return {
    a: cos * sx,
    b: sin * sx,
    c: -sin * sy,
    d: cos * sy,
    e: ox - (cos * sx * base.x - sin * sy * base.y),
    f: oy - (sin * sx * base.x + cos * sy * base.y),
  };
}

function scopedEntities(doc: CadDocument, regionId?: string | null): CadEntity[] {
  if (!regionId) return doc.entities;
  const region = doc.regions.find((r) => r.id === regionId);
  return region ? region.indices.map((i) => doc.entities[i]).filter(Boolean) : [];
}

/** Build the one block-placement index used by takeoff, BOQ and selection. */
export function buildOccurrenceIndex(
  doc: CadDocument,
  opts: CadOccurrenceOptions = {},
): CadOccurrenceIndex {
  const summaries = new Map<string, SummaryAcc>();
  const occurrences: CadOccurrence[] = [];
  let truncated = false;
  const filter = opts.layers ?? null;
  const k = doc.unitScale || 1;
  const unit: Xform = { a: k, b: 0, c: 0, d: k, e: 0, f: 0 };

  const addSummary = (
    insert: CadInsert,
    layer: string,
    sourceHandle: string,
    multiplier: number,
  ) => {
    const key = insert.blockName.toUpperCase();
    let row = summaries.get(key);
    if (!row) {
      row = {
        name: doc.blocks.get(key)?.name ?? insert.blockName,
        placementCount: 0,
        sourceHandles: new Set(),
        layers: new Set(),
      };
      summaries.set(key, row);
    }
    row.placementCount += multiplier;
    row.sourceHandles.add(sourceHandle);
    row.layers.add(layer);
  };

  // Exact weighted count: does not materialise every array cell.
  const count = (
    e: CadEntity,
    weight: number,
    depth: number,
    ancestors: ReadonlySet<string>,
    parentLayer: string,
    sourceHandle: string,
  ) => {
    if (e.type !== 'insert') return;
    const layer = e.style.layer === '0' && parentLayer ? parentLayer : e.style.layer;
    if (filter && !filter.has(layer)) return;
    const key = e.blockName.toUpperCase();
    const copies = Math.min(MAX_ARRAY, Math.max(1, e.cols * e.rows));
    const placements = weight * copies;
    addSummary(e, layer, sourceHandle, placements);
    const block = doc.blocks.get(key);
    if (!block || depth >= MAX_DEPTH || ancestors.has(key)) return;
    const nextAncestors = new Set(ancestors).add(key);
    for (const child of block.entities) {
      count(child, placements, depth + 1, nextAncestors, layer, sourceHandle);
    }
  };

  // Materialised positions: used by highlighting and future room assignment.
  const materialise = (
    e: CadEntity,
    xf: Xform,
    depth: number,
    ancestors: ReadonlySet<string>,
    parentLayer: string,
    sourceHandle: string,
    path: string[],
  ) => {
    if (e.type !== 'insert') return;
    const layer = e.style.layer === '0' && parentLayer ? parentLayer : e.style.layer;
    if (filter && !filter.has(layer)) return;
    const key = e.blockName.toUpperCase();
    const block = doc.blocks.get(key);
    const cols = Math.max(1, e.cols);
    const rows = Math.max(1, e.rows);
    for (let col = 0; col < cols; col++) {
      for (let row = 0; row < rows; row++) {
        if (occurrences.length >= MAX_MATERIALISED) {
          truncated = true;
          return;
        }
        const next = compose(xf, localTransform(e, block?.basePoint ?? { x: 0, y: 0 }, col, row));
        const part = `${e.style.handle || key}[${row},${col}]`;
        const nextPath = [...path, part];
        occurrences.push({
          id: `${sourceHandle}/${nextPath.join('/')}`,
          blockName: block?.name ?? e.blockName,
          sourceHandle,
          definitionHandle: e.style.handle,
          path: nextPath,
          row,
          col,
          depth,
          effectiveLayer: layer,
          transform: next,
          position: apply(next, block?.basePoint ?? { x: 0, y: 0 }),
        });
        if (!block || depth >= MAX_DEPTH || ancestors.has(key)) continue;
        const nextAncestors = new Set(ancestors).add(key);
        for (const child of block.entities) {
          materialise(child, next, depth + 1, nextAncestors, layer, sourceHandle, nextPath);
          if (truncated) return;
        }
      }
    }
  };

  const roots = scopedEntities(doc, opts.regionId).filter(
    (e): e is CadInsert =>
      e.type === 'insert' && (!opts.sourceHandles || opts.sourceHandles.has(e.style.handle)),
  );
  for (const root of roots) {
    const handle = root.style.handle;
    count(root, 1, 0, new Set(), '', handle);
    if (!truncated) materialise(root, unit, 0, new Set(), '', handle, []);
  }

  const blocks = [...summaries.values()]
    .map((s) => ({
      name: s.name,
      placementCount: s.placementCount,
      sourceEntityCount: s.sourceHandles.size,
      sourceHandles: [...s.sourceHandles],
      layers: [...s.layers].sort(),
    }))
    .sort((a, b) => b.placementCount - a.placementCount || a.name.localeCompare(b.name));

  return {
    occurrences,
    blocks,
    placementCount: blocks.reduce((n, b) => n + b.placementCount, 0),
    sourceEntityCount: new Set(blocks.flatMap((b) => b.sourceHandles)).size,
    truncated,
  };
}

export function occurrencesForHandles(
  index: CadOccurrenceIndex,
  handles: ReadonlySet<string>,
): CadOccurrence[] {
  return index.occurrences.filter((o) => handles.has(o.sourceHandle));
}
