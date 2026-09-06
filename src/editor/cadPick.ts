// Resolving a picked CAD handle back to the entity behind it, and turning
// that entity into the one-line readout the status bar shows on hover.
//
// Every number in the string comes from `cad/metrics.ts` (`entityFacts`), so
// a hover readout can never disagree with the selection panel or the takeoff
// table — they are all reading the same arithmetic.
import type { Unit } from '../core/types';
import type { CadDocument, CadEntity } from '../cad/types';
import { entityFacts } from '../cad/metrics';
import { formatArea, formatLength } from '../core/format';

/**
 * handle -> entity, built once per document.
 *
 * Modelspace entities are indexed first and win, then block definitions:
 * the display list flattens INSERTs, so an op's handle is often the handle
 * of an entity that lives inside a block definition and never appears in
 * `doc.entities` at all. Without the block pass, clicking any symbol on an
 * electrical drawing would resolve to nothing.
 *
 * Keyed by the document in a WeakMap: a re-import produces a new document,
 * which drops the old index for free, and the build is O(entities) once
 * rather than per pick.
 */
const indexes = new WeakMap<CadDocument, Map<string, CadEntity>>();

export function cadEntityIndex(doc: CadDocument): Map<string, CadEntity> {
  let index = indexes.get(doc);
  if (index) return index;
  index = new Map<string, CadEntity>();
  for (const e of doc.entities) {
    const h = e.style.handle;
    if (h && !index.has(h)) index.set(h, e);
  }
  for (const block of doc.blocks.values()) {
    for (const e of block.entities) {
      const h = e.style.handle;
      if (h && !index.has(h)) index.set(h, e);
    }
  }
  indexes.set(doc, index);
  return index;
}

export function cadEntityByHandle(doc: CadDocument, handle: string): CadEntity | null {
  return cadEntityIndex(doc).get(handle) ?? null;
}

/**
 * Status-bar line for one entity, e.g.
 *   `Polyline (4 vertices) · layer "light" · 4.35 m`
 *
 * Length is preferred; a shape that encloses something but runs nowhere (a
 * solid hatch) reports its area instead, and a symbol or a label that
 * measures neither just names itself and its layer.
 */
export function cadHoverHint(doc: CadDocument, e: CadEntity, unit: Unit): string {
  const f = entityFacts(doc, e);
  const parts = [f.describe, `layer "${f.layer}"`];
  if (f.length > 0) parts.push(formatLength(f.length, unit));
  else if (f.area > 0) parts.push(formatArea(f.area, unit));
  return parts.join(' · ');
}
