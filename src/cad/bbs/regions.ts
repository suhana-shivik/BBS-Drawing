// ============================================================
// Drawing regions — where one detail ends and the next begins.
//
// WHY THIS IS NOT THE SAME AS BANDS
//
// `bands.ts` recovers LAYOUTS: rows of mark tags along a run. That is the right
// object for counting how many columns exist. It is the wrong object for
// ownership, because a section detail carries no mark tags at all — it carries
// a declaration, some callouts, some leaders and a dimension chain.
//
// Run 004 measured the consequence: 32 callouts, 0 with a detail region, so
// containment could never fire and every candidate fell to proximity. TB's
// nearest offer sat 12,068 mm away in a different detail.
//
// WHAT A REGION IS HERE
//
// A cluster of drawn things separated from its neighbours by whitespace. That
// is how a drafter lays out a sheet and how a reader parses one: not by
// coordinates, but by "these things are together, and that gap means the next
// thing is separate".
//
// AND IT IS A HYPOTHESIS, NOT A FACT. A region computed from whitespace says
// where the ink clusters, not what the cluster means. `kind` is inferred from
// what the region contains and is labelled as inference; anything that turns a
// region into ownership must carry that provenance with it.
// ============================================================
import type { EvidenceGraph, EvidenceNode } from './evidence';
import type { Bounds } from './render';

export type RegionKind = 'layout' | 'section' | 'detail' | 'notes' | 'table' | 'unknown';

export interface DrawingRegion {
  id: string;
  bounds: Bounds;
  evidenceIds: string[];
  /** the region's own caption, when one sits inside it */
  label?: string;
  kind: RegionKind;
  /** why it was classified that way — never presented as measured fact */
  basis: string;
  counts: Record<string, number>;
}

/**
 * A gap this many times the typical spacing separates two regions.
 *
 * Derived from the sheet's own spacing rather than fixed, so the same rule
 * holds for a detail drawn at 1:10 and a layout at 1:100.
 */
const GAP_FACTOR = 4;
/** a region needs this much in it to be a region rather than a stray */
const MIN_NODES = 4;

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** split a sorted list of positions wherever the gap is unusually large */
function splitOnGaps(sorted: readonly number[], factor = GAP_FACTOR): number[] {
  if (sorted.length < 2) return [];
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  const typical = median(gaps.filter((g) => g > 0)) || 1;
  const threshold = typical * factor;
  const cuts: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > threshold) cuts.push((sorted[i] + sorted[i - 1]) / 2);
  }
  return cuts;
}

function bucket(value: number, cuts: readonly number[]): number {
  let i = 0;
  while (i < cuts.length && value > cuts[i]) i++;
  return i;
}

/**
 * What a cluster of evidence most likely is.
 *
 * Inference from composition, stated as such. A cluster of marks along one axis
 * is a layout; a cluster of callouts and dimensions around a declaration is a
 * detail; prose with no callouts is notes.
 */
function classify(nodes: readonly EvidenceNode[]): { kind: RegionKind; basis: string } {
  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
  const marks = counts.mark ?? 0;
  const callouts = counts.callout ?? 0;
  const dims = counts.dimension ?? 0;
  const decls = counts.declaration ?? 0;
  const total = nodes.length;

  if (marks >= 4 && callouts === 0) {
    return { kind: 'layout', basis: `${marks} mark tags and no callouts — reads as a layout plan` };
  }
  if (callouts >= 2 && (dims >= 2 || decls >= 1)) {
    return {
      kind: 'detail',
      basis: `${callouts} callout(s), ${dims} dimension(s), ${decls} declaration(s) — reads as a detail or section`,
    };
  }
  if (dims >= 4 && callouts >= 1) {
    return { kind: 'section', basis: `${dims} dimensions with callouts — reads as a section` };
  }
  if (callouts === 0 && marks === 0 && total >= MIN_NODES) {
    return { kind: 'notes', basis: 'text with no reinforcement callouts and no marks' };
  }
  return { kind: 'unknown', basis: `mixed contents: ${JSON.stringify(counts)}` };
}

export interface RegionResult {
  regions: DrawingRegion[];
  /** evidence that reached no region, and why */
  diagnostics: string[];
}

/**
 * Cut the sheet into regions by whitespace, in both axes.
 *
 * Pure and deterministic — no model call. Same sheet in, same regions out, so
 * a region id means the same thing across runs and can be cited as provenance.
 */
export function detectRegions(graph: EvidenceGraph): RegionResult {
  const placed = graph.nodes.filter((n) => n.position);
  const diagnostics: string[] = [];
  if (placed.length < MIN_NODES) {
    return { regions: [], diagnostics: [`only ${placed.length} positioned node(s) — too few to cluster`] };
  }

  const xs = [...new Set(placed.map((n) => n.position!.x))].sort((a, b) => a - b);
  const ys = [...new Set(placed.map((n) => n.position!.y))].sort((a, b) => a - b);
  const xCuts = splitOnGaps(xs);
  const yCuts = splitOnGaps(ys);

  const cells = new Map<string, EvidenceNode[]>();
  for (const n of placed) {
    const key = `${bucket(n.position!.x, xCuts)}:${bucket(n.position!.y, yCuts)}`;
    const list = cells.get(key) ?? [];
    list.push(n);
    cells.set(key, list);
  }

  const regions: DrawingRegion[] = [];
  // stable order: by y then x, so ids do not shuffle between runs
  const ordered = [...cells.entries()].sort((a, b) => {
    const [ax, ay] = a[0].split(':').map(Number);
    const [bx, by] = b[0].split(':').map(Number);
    return ay - by || ax - bx;
  });

  for (const [, nodes] of ordered) {
    if (nodes.length < MIN_NODES) {
      diagnostics.push(
        `${nodes.length} node(s) near (${nodes[0].position!.x.toFixed(0)}, ${nodes[0].position!.y.toFixed(0)}) ` +
          `— too few to be a region; left unassigned rather than merged`,
      );
      continue;
    }
    const px = nodes.map((n) => n.position!.x);
    const py = nodes.map((n) => n.position!.y);
    const { kind, basis } = classify(nodes);
    const counts: Record<string, number> = {};
    for (const n of nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;

    // the region's caption: the declaration inside it, if any
    const decl = nodes.find((n) => n.kind === 'declaration');
    regions.push({
      id: `REGION-${String(regions.length + 1).padStart(2, '0')}`,
      bounds: { x1: Math.min(...px), y1: Math.min(...py), x2: Math.max(...px), y2: Math.max(...py) },
      evidenceIds: nodes.map((n) => n.id),
      label: decl?.rawText,
      kind,
      basis,
      counts,
    });
  }

  return { regions, diagnostics };
}

/** the region containing a node, if any */
export function regionOf(regions: readonly DrawingRegion[], evidenceId: string): DrawingRegion | undefined {
  return regions.find((r) => r.evidenceIds.includes(evidenceId));
}

/**
 * Resolve a semantic hint to a region.
 *
 * The orchestrator should be able to say "the TB detail" rather than inventing
 * coordinates. Matching is over the region's own caption and the evidence it
 * contains — never over a name the model supplied, which is how caption text
 * became members in run 003.
 */
export function resolveHint(
  regions: readonly DrawingRegion[],
  hint: string,
  graph: EvidenceGraph,
): { region?: DrawingRegion; candidates: DrawingRegion[]; reason?: string } {
  const needle = hint.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  if (!needle) return { candidates: [], reason: 'an empty hint matches nothing' };
  const words = needle.split(' ').filter(Boolean);

  const scored = regions
    .map((r) => {
      const text = [
        r.label ?? '',
        r.kind,
        ...r.evidenceIds.map((id) => {
          const n = graph.byId.get(id);
          return `${n?.rawText ?? ''} ${n?.metadata.mark ?? ''} ${n?.metadata.name ?? ''}`;
        }),
      ]
        .join(' ')
        .toUpperCase();
      const hits = words.filter((w) => text.includes(w)).length;
      return { r, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  if (!scored.length) return { candidates: [], reason: `nothing on this sheet matches "${hint}"` };
  const best = scored[0].hits;
  const top = scored.filter((x) => x.hits === best).map((x) => x.r);
  if (top.length === 1) return { region: top[0], candidates: top };
  return {
    candidates: top,
    reason: `"${hint}" matches ${top.length} regions equally (${top.map((r) => r.id).join(', ')}) — name one, or give bounds`,
  };
}

/** how the regions read to an orchestrator deciding where to look */
export function renderRegions(regions: readonly DrawingRegion[]): string {
  if (!regions.length) return '(no regions could be separated on this sheet)';
  return regions
    .map(
      (r) =>
        `${r.id}  ${r.kind}${r.label ? `  "${r.label}"` : ''}  ` +
        `${Math.round(r.bounds.x2 - r.bounds.x1)}×${Math.round(r.bounds.y2 - r.bounds.y1)} mm  ` +
        `${JSON.stringify(r.counts)}  — ${r.basis}`,
    )
    .join('\n');
}
