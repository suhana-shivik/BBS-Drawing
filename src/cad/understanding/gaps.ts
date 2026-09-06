// ============================================================
// WHAT THE READ DID NOT READ — as places, not as a percentage.
//
// `coverage.ts` answers "how much of this drawing is in no section" and groups
// the answer BY LAYER. That is the right shape for an audit line and the wrong
// shape for a person looking at a drawing: a layer's uncovered entities can be
// scattered across the whole sheet, so their union is a box containing the gap
// rather than the gap itself, and six sample handles are not a location.
//
// This file answers the other half: WHERE the unread geometry is, as clusters
// of entities that sit together, and — for each one — whether it is joined to
// anything that WAS read.
//
// THE POINT IS THE CONNECTIVITY. A strip of footings the splitter missed at
// the bottom edge of a layout plan is not the same problem as a detail sitting
// on its own in the corner of the sheet. The first is a section that got cut
// short; the second is a whole drawing element nobody looked at. Only the
// geometry can tell them apart, and it can tell them apart exactly.
//
// NO MODEL RUNS HERE. Entity bounds and box intersection — deterministic,
// cheap, and needing no API key. Once a drawing has been split, its gaps can
// be found, drawn and judged offline, forever.
//
// WHAT THIS DOES NOT DECIDE. Whether a gap MATTERS is a judgement, and
// `coverage.ts` is explicit that this project does not encode that as a layer-
// name heuristic ("wrong on the next drawing's layer names"). So a cluster
// carries EVIDENCE — the layers it is on and the text it contains, verbatim —
// and never a verdict.
//
// AND IT DOES NOT READ THE TEXT EITHER. Deciding which of those strings is a
// bar callout is the BBS grammar's job, and `understanding/` does not import
// `bbs/` — the splitter is its own capability and the module graph is where
// that is enforced (tests/domain/drawing-splitter.test.ts). The text comes out
// of here as text; the studio layer, which may see both, is where it is read.
// ============================================================

import type { CadDocument } from '../types';
import { boundsIntersect, entityBoundsMm, unionBounds } from './bounds';
import type { SectionBounds } from './types';

/** Cluster join distance, as a fraction of the sheet's diagonal. */
const JOIN_FRACTION = 0.015;

/** Above this many uncovered entities the clustering is not attempted. */
const MAX_UNCOVERED = 20_000;

/**
 * Text kept per cluster. Generous, because the studio layer sorts these into
 * "the bar grammar read this" and "everything else" afterwards — a cap that
 * fit only six would let ordinary labels crowd out the callout that matters.
 */
const MAX_SAMPLES = 12;

export interface GapCluster {
  /** GAP-01, GAP-02 … numbered largest first, stable for one package */
  id: string;
  bounds: SectionBounds;
  entityCount: number;
  /** layers present, largest first */
  layers: { layer: string; count: number }[];
  /**
   * Sections this cluster touches — their boxes intersect it once the cluster
   * is grown by the join distance. Empty means it is joined to nothing that
   * was read.
   */
  touches: string[];
  /** Nearest section by edge-to-edge distance, when it touches none. */
  nearest: { sectionId: string; distanceMm: number } | null;
  /** Text found inside the cluster, verbatim and unclassified. Evidence. */
  sampleText: string[];
}

/** Edge-to-edge distance between two boxes; 0 when they touch or overlap. */
export function boundsDistance(a: SectionBounds, b: SectionBounds): number {
  const dx = Math.max(0, Math.max(a.xMin - b.xMax, b.xMin - a.xMax));
  const dy = Math.max(0, Math.max(a.yMin - b.yMax, b.yMin - a.yMax));
  return Math.hypot(dx, dy);
}

function grow(b: SectionBounds, by: number): SectionBounds {
  return { xMin: b.xMin - by, yMin: b.yMin - by, xMax: b.xMax + by, yMax: b.yMax + by };
}

interface Building {
  bounds: SectionBounds;
  count: number;
  layers: Map<string, number>;
  texts: string[];
}

/**
 * The unread parts of a drawing, clustered, with what each one is next to.
 *
 * `sections` are the boxes the read produced, in millimetres. Returns [] when
 * the read covered everything, or when there is too much uncovered geometry
 * for clustering to describe a place rather than a mess (the caller still has
 * `coverage.gaps`, which is by layer and always present).
 */
export function findGapClusters(
  doc: CadDocument,
  sections: readonly { sectionId: string; bounds: SectionBounds }[],
  sheet: SectionBounds | null,
): GapCluster[] {
  // 1. every entity in no section at all — the same test coverage.ts makes,
  //    so the two can never disagree about what "uncovered" means.
  const loose: { bounds: SectionBounds; layer: string; text: string | null }[] = [];
  for (const e of doc.entities) {
    const b = entityBoundsMm(e, doc);
    if (!b) continue;
    if (sections.some((s) => boundsIntersect(s.bounds, b))) continue;
    loose.push({
      bounds: b,
      layer: e.style.layer || '0',
      text: e.type === 'text' ? e.text.trim() : null,
    });
    if (loose.length > MAX_UNCOVERED) return [];
  }
  if (!loose.length) return [];

  // 2. the join distance comes from the drawing, not from a constant in mm:
  //    the same sheet drawn in metres and in millimetres must cluster alike.
  const span = sheet
    ? Math.hypot(sheet.xMax - sheet.xMin, sheet.yMax - sheet.yMin)
    : Math.hypot(
        Math.max(...loose.map((l) => l.bounds.xMax)) - Math.min(...loose.map((l) => l.bounds.xMin)),
        Math.max(...loose.map((l) => l.bounds.yMax)) - Math.min(...loose.map((l) => l.bounds.yMin)),
      );
  const join = Math.max(span * JOIN_FRACTION, 1e-6);

  // 3. grow-and-merge. Each entity joins the first cluster it reaches; the
  //    clusters are then merged until nothing more touches, so the result does
  //    not depend on the order the entities happened to arrive in.
  const built: Building[] = [];
  for (const item of loose) {
    const hit = built.find((c) => boundsIntersect(grow(c.bounds, join), item.bounds));
    if (hit) {
      hit.bounds = unionBounds(hit.bounds, item.bounds);
      hit.count += 1;
      hit.layers.set(item.layer, (hit.layers.get(item.layer) ?? 0) + 1);
      collect(hit, item.text);
    } else {
      const made: Building = {
        bounds: item.bounds,
        count: 1,
        layers: new Map([[item.layer, 1]]),
        texts: [],
      };
      collect(made, item.text);
      built.push(made);
    }
  }
  mergeUntilStable(built, join);

  // 4. what each cluster is joined to. This is the answer the reader wants:
  //    a cluster touching a section is that section cut short; a cluster
  //    touching nothing is a part of the drawing nobody looked at.
  return built
    .sort((a, b) => b.count - a.count)
    .map((c, i) => {
      const grown = grow(c.bounds, join);
      const touches = sections.filter((s) => boundsIntersect(grown, s.bounds)).map((s) => s.sectionId);
      let nearest: GapCluster['nearest'] = null;
      if (!touches.length) {
        for (const s of sections) {
          const d = boundsDistance(c.bounds, s.bounds);
          if (!nearest || d < nearest.distanceMm) nearest = { sectionId: s.sectionId, distanceMm: d };
        }
      }
      return {
        id: `GAP-${String(i + 1).padStart(2, '0')}`,
        bounds: c.bounds,
        entityCount: c.count,
        layers: [...c.layers.entries()]
          .map(([layer, count]) => ({ layer, count }))
          .sort((a, b) => b.count - a.count),
        touches,
        nearest,
        sampleText: c.texts,
      };
    });
}

/** Keep the text verbatim. What it MEANS is not this module's business. */
function collect(c: Building, text: string | null): void {
  if (!text) return;
  const short = text.slice(0, 60);
  if (c.texts.length < MAX_SAMPLES && !c.texts.includes(short)) c.texts.push(short);
}

/** Merge clusters that reach each other, until none do. */
function mergeUntilStable(built: Building[], join: number): void {
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < built.length; i += 1) {
      for (let j = i + 1; j < built.length; j += 1) {
        if (!boundsIntersect(grow(built[i].bounds, join), built[j].bounds)) continue;
        const a = built[i];
        const b = built[j];
        a.bounds = unionBounds(a.bounds, b.bounds);
        a.count += b.count;
        for (const [layer, n] of b.layers) a.layers.set(layer, (a.layers.get(layer) ?? 0) + n);
        for (const t of b.texts) if (a.texts.length < MAX_SAMPLES && !a.texts.includes(t)) a.texts.push(t);
        built.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
}
