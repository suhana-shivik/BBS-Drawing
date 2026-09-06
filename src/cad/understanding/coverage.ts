// ============================================================
// Does the package account for the drawing? — the OTHER failure mode.
//
// `bounds.ts`'s `connectedEntitiesInBounds` fixes BLOAT: a section whose box
// spans two disconnected things because a handle list mixed in a stray
// caption from a neighbour. This file fixes the opposite failure: a GAP —
// real geometry that ended up in NO section at all, silently.
//
// The two are independent and one does not imply the other. A run can have
// zero bloat and still lose a strip of the drawing between two adjacent,
// individually-correct cuts — measured on the real GAMCO sheet, a 1.9 m
// strip between two tie-beam sections dropped seven entities on the `col`,
// `REIN` and `BEAM` layers: column lines, a beam line, and two reinforcement
// lines. Nothing about either section was wrong; the SPACE BETWEEN them was
// never anyone's job. Coverage is the check that gives that space an owner.
//
// WHAT THIS DOES NOT DO. It does not try to guess which orphaned layer
// matters and which is title-block noise — that classification is exactly
// the kind of judgement call this project always defers to a human rather
// than encoding as a naming heuristic that will be wrong on the next
// drawing's layer names. Every orphan is reported, grouped by layer with
// example handles, and the reader decides what to do with a `NAMEPL` layer
// showing up next to a `REIN` layer in the same list.
// ============================================================
import type { CadDocument } from '../types';
import { boundsIntersect, entityBoundsMm, unionBounds } from './bounds';
import type { SectionBounds } from './types';

/** past this many examples per layer, the report just gives a count */
const MAX_SAMPLE_HANDLES_PER_LAYER = 6;

export interface CoverageGap {
  layer: string;
  count: number;
  /** a handful of handles, so a person can find one on the canvas and look */
  sampleHandles: string[];
  /** for text entities among the samples — the fastest way to recognise a gap by eye */
  sampleText: string[];
  /**
   * The union of every uncovered entity on this layer, in millimetres.
   *
   * Not just the samples — the whole gap, so a consumer that wants to LOOK
   * at it (a remediation prompt handing this to `look_at`, or a UI wanting
   * to jump the canvas there) has a real box, not a guess built from six
   * examples out of sixteen.
   */
  bounds: SectionBounds;
}

export interface CoverageSummary {
  /** entities with measurable geometry — an entity `entitiesInBounds` could never have selected either way is not counted */
  measurableEntities: number;
  coveredEntities: number;
  /** measurableEntities - coveredEntities */
  uncoveredEntities: number;
  /** by layer, largest first */
  gaps: CoverageGap[];
}

/**
 * Which entities, of everything the drawing carries, sit outside every
 * section box.
 *
 * Pure geometry — the same `entityBoundsMm` every section is cut with — so
 * it costs nothing to run after a split, needs no model, and cannot disagree
 * with what the sections themselves measure.
 */
export function computeCoverage(
  doc: CadDocument,
  sectionBoundsList: readonly SectionBounds[],
): CoverageSummary {
  let measurable = 0;
  let covered = 0;
  const byLayer = new Map<
    string,
    { count: number; handles: string[]; texts: string[]; bounds: SectionBounds }
  >();

  for (const e of doc.entities) {
    const b = entityBoundsMm(e, doc);
    if (!b) continue; // never selectable by any section either — not this check's concern
    measurable += 1;

    if (sectionBoundsList.some((box) => boundsIntersect(box, b))) {
      covered += 1;
      continue;
    }

    const layer = e.style.layer || '0';
    const bucket = byLayer.get(layer) ?? { count: 0, handles: [], texts: [], bounds: b };
    bucket.count += 1;
    bucket.bounds = unionBounds(bucket.bounds, b);
    if (bucket.handles.length < MAX_SAMPLE_HANDLES_PER_LAYER) bucket.handles.push(e.style.handle);
    if (e.type === 'text' && bucket.texts.length < MAX_SAMPLE_HANDLES_PER_LAYER) {
      bucket.texts.push(e.text.trim().slice(0, 60));
    }
    byLayer.set(layer, bucket);
  }

  const gaps: CoverageGap[] = [...byLayer.entries()]
    .map(([layer, b]) => ({
      layer,
      count: b.count,
      sampleHandles: b.handles,
      sampleText: b.texts,
      bounds: b.bounds,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    measurableEntities: measurable,
    coveredEntities: covered,
    uncoveredEntities: measurable - covered,
    gaps,
  };
}

/**
 * One line per layer, worst first — what a package's `unresolved` list folds
 * this into, so a plain-text reader sees it without needing the structured
 * `CoverageSummary` the UI renders richly.
 *
 * Returns [] when coverage is complete; a caller should not add an empty
 * "nothing is wrong" line to a list that is supposed to name problems.
 */
export function coverageSummaryLines(summary: CoverageSummary, maxLayers = 6): string[] {
  if (summary.uncoveredEntities === 0) return [];
  const pct = summary.measurableEntities > 0
    ? (summary.uncoveredEntities / summary.measurableEntities) * 100
    : 0;
  const lines = [
    `${summary.uncoveredEntities} of ${summary.measurableEntities} entities ` +
      `(${pct.toFixed(1)}%) are in no section — ` +
      summary.gaps
        .slice(0, maxLayers)
        .map((g) => `${g.layer} (${g.count})`)
        .join(', ') +
      (summary.gaps.length > maxLayers ? `, +${summary.gaps.length - maxLayers} more layers` : ''),
  ];
  for (const g of summary.gaps.slice(0, maxLayers)) {
    if (g.sampleText.length) {
      lines.push(`  ${g.layer}: e.g. ${g.sampleText.map((t) => `"${t}"`).join(', ')}`);
    }
  }
  return lines;
}
