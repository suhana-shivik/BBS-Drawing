// ============================================================
// Placement bands — layouts recovered from geometry alone.
//
// WHY THIS MUST NOT NEED A MODEL
//
// Counting how many columns exist is arithmetic over tag positions. It was
// nonetheless gated behind a vision call, because the only thing that grouped
// tags into layouts was model segmentation. Two consequences, both bad:
//
//   · a request must be spent before any count can be produced at all
//   · when segmentation had not run, `template-repeat` fell through to every
//     mark on the sheet, measured a "template" spanning four stacked layouts,
//     and inflated every count by roughly half — silently
//
// A layout is a geometric object: a row of tags sharing a cross-axis position,
// separated from the next layout by a gap much larger than the gaps within it.
// That is computable, and computing it is what this file does.
//
// MODEL PANELS ARE NOT REPLACED. They remain the right tool for READING a
// detail — deciding what a section shows. They are simply no longer required
// for counting, which is measurement.
//
// AMBIGUITY IS AN ANSWER. Where two bands could equally serve a placement, the
// caller is told so and refuses. Choosing the larger one silently is how a
// count ends up describing the wrong layout.
// ============================================================
import type { EvidenceGraph, EvidenceNode } from './evidence';
import { detectCycle } from './sequence';

export interface PlacementBand {
  id: string;
  /** the axis the layout runs along */
  axis: 'x' | 'y';
  occurrenceIds: string[];
  /** the extent across the band — how thick the row of tags is */
  crossAxisRange: [number, number];
  /** the extent along the band — the drawn length of the layout */
  longitudinalRange: [number, number];
  source: 'geometry';
  /** what was excluded from this band, and why */
  diagnostics: string[];
  /** the marks it carries, with how many of each */
  tally: Record<string, number>;
}

export interface BandsResult {
  bands: PlacementBand[];
  /** occurrences that reached no band, each with a reason */
  diagnostics: string[];
}

/** two tags closer than this along the run are the same node */
const NODE_TOL_MM = 25;
/** a band needs at least this many occurrences to be a layout rather than a stray */
const MIN_OCCURRENCES = 3;
/** a cross-axis gap this many times the typical one starts a new band */
const SPLIT_FACTOR = 3;

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * A layout is long and thin, so a cross-axis gap this large starts a new one.
 *
 * Expressed as a fraction of how far the tags spread ALONG the axis, which
 * makes it scale-free: the same rule holds for a 25 m wall and a 300 m one.
 * A median-of-gaps rule was tried and does not work — when layouts are evenly
 * stacked, the inter-layout gaps ARE the median, so nothing ever splits.
 */
const CROSS_SPLIT_FRACTION = 0.05;

interface Clustering {
  axis: 'x' | 'y';
  clusters: EvidenceNode[][];
  /** how many clusters are big enough to be a layout */
  valid: number;
  /** how many of them carry a repeating labelled sequence */
  cyclic: number;
  /** total drawn extent along the axis — the tie-break */
  alongTotal: number;
}

/** cluster the marks across one candidate axis */
function clusterOn(marks: readonly EvidenceNode[], axis: 'x' | 'y'): Clustering {
  const cross = axis === 'x' ? 'y' : 'x';
  const alongVals = marks.map((m) => m.position![axis]);
  const alongSpread = Math.max(...alongVals) - Math.min(...alongVals);
  const threshold = Math.max(alongSpread * CROSS_SPLIT_FRACTION, 1);

  const sorted = [...marks].sort((a, b) => a.position![cross] - b.position![cross]);
  const clusters: EvidenceNode[][] = [];
  let current: EvidenceNode[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].position![cross] - sorted[i - 1].position![cross];
    if (gap > threshold) {
      clusters.push(current);
      current = [];
    }
    current.push(sorted[i]);
  }
  clusters.push(current);

  // The discriminator is the STRUCTURE, not the shape.
  //
  // Counting clusters prefers the wrong axis whenever tags line up in a grid:
  // four layouts stacked vertically slice into ten tidy vertical columns, and
  // ten beats four. Aspect ratio fails the same way, because a column of tags
  // sharing one x is infinitely "thin".
  //
  // What actually separates a layout from a slice through several layouts is
  // that a layout REPEATS: C1·SC·C2·SC along a wall is a cycle, while
  // F1·C1·C1·C1 read down through four stacked plans is not. So the cycle
  // detector — the thing that has to work on these bands anyway — decides
  // which axis produced them.
  let valid = 0;
  let cyclic = 0;
  let alongTotal = 0;
  for (const c of clusters) {
    if (c.length < MIN_OCCURRENCES) continue;
    valid++;
    const a = c.map((n) => n.position![axis]);
    alongTotal += Math.max(...a) - Math.min(...a);
    const ordered = [...c].sort((p, q) => p.position![axis] - q.position![axis]);
    const found = detectCycle(
      ordered.map((n) => ({
        id: n.id,
        label: String(n.metadata.mark ?? '?'),
        at: n.position![axis],
      })),
    );
    if (found.ok) cyclic++;
  }
  return { axis, clusters, valid, cyclic, alongTotal };
}

/**
 * Which axis the layouts run along — decided by trying both.
 *
 * Taking the axis of greatest overall spread is wrong, and wrong in the common
 * case: three layouts stacked 40 m apart, each 6 m long, spread further
 * vertically than horizontally, yet they plainly run horizontally. The
 * clustering itself is the evidence — the correct axis is the one that
 * resolves the sheet into several long, thin layouts.
 */
function bestClustering(marks: readonly EvidenceNode[]): Clustering {
  const byX = clusterOn(marks, 'x');
  const byY = clusterOn(marks, 'y');
  if (byX.cyclic !== byY.cyclic) return byX.cyclic > byY.cyclic ? byX : byY;
  if (byX.valid !== byY.valid) return byX.valid > byY.valid ? byX : byY;
  return byX.alongTotal >= byY.alongTotal ? byX : byY;
}

export interface BuildBandsOptions {
  /**
   * Text that belongs to a reconstructed table or schedule. Tags inside a
   * schedule are a LEGEND, not a layout — counting them counts the drawing's
   * own index of itself.
   */
  excludeIds?: ReadonlySet<string>;
}

/**
 * Recover every layout on a sheet, deterministically.
 *
 * Pure: same evidence in, same bands out, no request spent.
 */
export function buildPlacementBands(
  graph: EvidenceGraph,
  opts: BuildBandsOptions = {},
): BandsResult {
  const diagnostics: string[] = [];
  const all = graph.nodes.filter((n) => n.kind === 'mark' && n.position);

  const marks: EvidenceNode[] = [];
  for (const m of all) {
    if (opts.excludeIds?.has(m.id)) {
      diagnostics.push(`${m.id} (${m.metadata.mark ?? '?'}) sits inside a schedule table — a legend, not a layout`);
      continue;
    }
    marks.push(m);
  }
  if (marks.length < MIN_OCCURRENCES) {
    diagnostics.push(
      `only ${marks.length} usable mark occurrence(s) on this sheet — too few to identify a layout`,
    );
    return { bands: [], diagnostics };
  }

  const { axis, clusters } = bestClustering(marks);
  const cross = axis === 'x' ? 'y' : 'x';

  const bands: PlacementBand[] = [];
  clusters.forEach((cluster, i) => {
    if (cluster.length < MIN_OCCURRENCES) {
      diagnostics.push(
        `${cluster.length} occurrence(s) near ${cross}=${cluster[0].position![cross].toFixed(0)} ` +
          `(${cluster.map((n) => n.metadata.mark ?? '?').join(', ')}) — too few to be a layout; ` +
          'left out of every band rather than merged into a neighbour',
      );
      return;
    }
    const along = [...cluster].sort((a, b) => a.position![axis] - b.position![axis]);
    const tally: Record<string, number> = {};
    for (const n of along) {
      const mark = String(n.metadata.mark ?? '?');
      tally[mark] = (tally[mark] ?? 0) + 1;
    }
    const alongVals = along.map((n) => n.position![axis]);
    const crossVals = cluster.map((n) => n.position![cross]);
    bands.push({
      id: `BAND-${String(bands.length + 1).padStart(2, '0')}`,
      axis,
      occurrenceIds: along.map((n) => n.id),
      crossAxisRange: [Math.min(...crossVals), Math.max(...crossVals)],
      longitudinalRange: [Math.min(...alongVals), Math.max(...alongVals)],
      source: 'geometry',
      diagnostics: [],
      tally,
    });
  });

  return { bands, diagnostics };
}

export interface BandLookup {
  band?: PlacementBand;
  /** more than one band carries this mark and none is clearly the layout */
  ambiguous?: PlacementBand[];
  reason?: string;
}

/**
 * The band a mark should be counted from.
 *
 * A mark drawn on several layouts — a column appearing on the footing plan,
 * the tie-beam plan and the top-of-column plan — has one count, not three. The
 * band carrying the most DISTINCT marks is the fullest description of the
 * sequence and is preferred; when two are equally full, that is reported as
 * ambiguity rather than settled by an arbitrary tiebreak.
 */
export function bandForMark(bands: readonly PlacementBand[], mark: string): BandLookup {
  const carrying = bands.filter((b) => (b.tally[mark] ?? 0) > 0);
  if (!carrying.length) {
    return { reason: `no layout band carries "${mark}"` };
  }
  if (carrying.length === 1) return { band: carrying[0] };

  const richness = (b: PlacementBand): number => Object.keys(b.tally).length;
  const best = Math.max(...carrying.map(richness));
  const top = carrying.filter((b) => richness(b) === best);
  if (top.length > 1) {
    // equally rich bands: only a tie in OCCURRENCE COUNT is truly ambiguous —
    // a fuller sequence of the same marks is still the better description
    const most = Math.max(...top.map((b) => b.occurrenceIds.length));
    const finalists = top.filter((b) => b.occurrenceIds.length === most);
    if (finalists.length > 1) {
      // Ambiguity means DISAGREEMENT, not multiplicity.
      //
      // A sheet routinely draws the same sequence of columns on several plans —
      // the footing plan, the tie-beam plan, the top-of-column plan. Those are
      // one layout seen three times, and they cannot disagree about a count.
      // Refusing there would block a schedule over a distinction with no
      // consequence. Two bands are ambiguous only when counting from one would
      // give a different answer from the other.
      const signature = (b: PlacementBand): string =>
        `${JSON.stringify(Object.entries(b.tally).sort())}|${Math.round(
          b.longitudinalRange[1] - b.longitudinalRange[0],
        )}`;
      const agree = new Set(finalists.map(signature)).size === 1;
      if (agree) return { band: finalists[0] };
      return {
        ambiguous: finalists,
        reason:
          `"${mark}" appears on ${finalists.length} layouts that describe it equally fully but ` +
          `DIFFERENTLY (${finalists.map((b) => `${b.id} ${JSON.stringify(b.tally)}`).join(' vs ')}). ` +
          'Counting from either would be a guess; name the band explicitly.',
      };
    }
    return { band: finalists[0] };
  }
  return { band: top[0] };
}

// ------------------------------------------------------------
// looking at a band
// ------------------------------------------------------------

/**
 * A band as a box that can actually be rendered.
 *
 * WHY THIS IS NOT JUST THE TWO RANGES
 *
 * A row of tags sitting on one line has a cross-axis range of ZERO, and a
 * zero-height crop renders nothing at all. Both `getPlacementEvidence` and the
 * stage-1 package shipped exactly that bug, independently, because each built
 * the box from the raw ranges — which is the argument for the geometry living
 * in one place rather than at every call site.
 *
 * The view opens to the layout's own module: the pitch between its nodes, which
 * is the drawing's own statement of how big the things it draws are. That is a
 * STARTING view and not a claim about the layout's true height — a crop showing
 * too little should be asked for again, wider.
 */
export function bandViewBox(
  band: PlacementBand,
  graph: EvidenceGraph,
): { x1: number; y1: number; x2: number; y2: number } {
  const at = [
    ...new Set(
      band.occurrenceIds
        .map((id) => graph.byId.get(id)?.position?.[band.axis])
        .filter((v): v is number => typeof v === 'number')
        .map((v) => Math.round(v)),
    ),
  ].sort((p, q) => p - q);

  const longitudinal = band.longitudinalRange[1] - band.longitudinalRange[0];
  const pitch = at.length > 1 ? (at[at.length - 1] - at[0]) / (at.length - 1) : longitudinal;
  const mid = (band.crossAxisRange[0] + band.crossAxisRange[1]) / 2;
  const half = Math.max((band.crossAxisRange[1] - band.crossAxisRange[0]) / 2, Math.abs(pitch) / 2);

  return band.axis === 'x'
    ? { x1: band.longitudinalRange[0], y1: mid - half, x2: band.longitudinalRange[1], y2: mid + half }
    : { x1: mid - half, y1: band.longitudinalRange[0], x2: mid + half, y2: band.longitudinalRange[1] };
}
