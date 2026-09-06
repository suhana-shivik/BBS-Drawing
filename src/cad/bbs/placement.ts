// ============================================================
// Placement — how a member repeats along the job.
//
// WHY A COUNT IS NOT A NUMBER
//
// The old contract had `count: number`, optional, defaulting to 1. On a
// typical-detail sheet nothing states a count, so every member arrived as 1 and
// a 100 m boundary wall was billed as one bay — roughly fifty times short. The
// obvious repair (let the model type a count) is the one thing this
// architecture forbids: a typed count is invention with a plausible face.
//
// The insight is that a count is never a fact about a member. It is a fact
// about how the member is PLACED, and placement is a classification a model can
// legitimately make:
//
//     "C1 sits at every main node of the layout"      — a kind
//     "the wall runs the whole length"                — a kind
//     "F1 sits under the main columns"                — a kind
//     "this one is a one-off"                         — a kind
//
// Each kind is a closed form with a deterministic count rule. The model says
// WHICH KIND and points at the evidence; this file does the arithmetic.
//
// THE FOUR RULES THAT MATTER
//
//  1. There is no field anywhere in which a count or a pitch can be typed.
//     A pitch is a pointer at a dimension; the engine reads it.
//  2. `unknown` is a first-class answer and NEVER becomes 1. It becomes a gap,
//     and a gap becomes a question.
//  3. A layout drawn on a typical-detail sheet is a TEMPLATE, not the job. Its
//     length is measured from the marks it carries, never from a panel's
//     bounding box — a box is a drafting artefact and includes the title.
//  4. Members that repeat together must be counted together. Applying one
//     pitch independently to C1, C2, SC and F1 double-counts every node: they
//     are one sequence, and the sequence is what repeats.
// ============================================================
import type { EvidenceGraph, EvidenceNode } from './evidence';
import { resolveScalar, type ResolveContext, type ScalarRef } from './refs';

/** two positions closer than this along the layout axis are the same node */
const NODE_TOL_MM = 25;
/** a remainder smaller than this is drafting noise, not a partial bay */
const BAY_TOL_MM = 5;

export type MemberPlacement =
  /** runs the whole job — a wall, a tie beam. Length comes from the run. */
  | { kind: 'continuous'; runFactId: string }
  /** at a regular pitch along an axis; the pitch is POINTED AT, never typed */
  | {
      kind: 'uniform';
      pitchRef: ScalarRef;
      along: 'run' | 'x' | 'y';
      boundaryRule: 'both-ends' | 'start-only' | 'end-only';
      /** required when `along` is 'run' */
      runFactId?: string;
    }
  /** the drawn layout IS the job — count the tags and stop */
  | { kind: 'marks'; markEvidenceIds: string[] }
  /** the drawn layout is one TEMPLATE of a longer job; it tiles along the run */
  | {
      kind: 'template-repeat';
      panelId: string;
      runFactId: string;
      orderedOccurrenceIds: string[];
    }
  /** as template-repeat, but this member appears only at certain nodes of a cycle */
  | {
      kind: 'periodic-pattern';
      panelId: string;
      runFactId: string;
      orderedOccurrenceIds: string[];
      /** the marks forming one full cycle, in order */
      cycleMemberIds: string[];
    }
  /** genuinely a one-off, asserted against evidence — not a default */
  | { kind: 'once'; evidenceId: string }
  /**
   * Its count FOLLOWS another member's.
   *
   * A footing exists because a column stands on it. Tiling the two
   * independently lets their phases drift — on a real sheet that produced 25
   * footings under 26 columns, each answer defensible on its own and the pair
   * impossible. A dependent member is never counted; it is DERIVED, and its
   * provenance names the parent instances that created it.
   */
  | {
      kind: 'dependent';
      /** member ids, never drawing mark strings — see resolveAll */
      parentMemberIds: string[];
      relation: 'one-per-parent' | 'one-per-bay' | 'same-as-parent' | 'custom';
    }
  /**
   * A PERSON counted them and said so.
   *
   * Every other kind derives a count from marks on the sheet, a run, or a
   * parent member — evidence the harness can re-read. This one cannot be
   * re-derived, and that is exactly why it exists: when the sheet is silent and
   * the layout proves nothing, the person who knows the job is the only
   * remaining authority, and the alternative is not a better count but no
   * schedule at all.
   *
   * It is never a default and never inferred. It arrives only from an answer to
   * a question this harness put, and it carries `saidAs` so the schedule can
   * always show that a human asserted this rather than the drawing stating it.
   */
  | { kind: 'stated'; count: number; saidAs: string }
  /** not established. Becomes a gap, then a question. NEVER 1. */
  | { kind: 'unknown'; reason: string };

/**
 * A CLAIM ABOUT EXTENT THAT NOTHING EVIDENCED.
 *
 * `marks` says "the drawn layout IS the whole job". When a run fact exists the
 * engine checks that claim against it and refuses when the two disagree (see
 * the `marks` branch). When NO run fact exists there is nothing to check it
 * against — and the schedule that comes out is a real, arithmetically clean
 * schedule for a stretch of wall nobody said was the whole wall.
 *
 * That is not a reason to refuse. A member genuinely drawn once IS the job, and
 * blocking there would make the engine useless on the sheets it handles best.
 * The distinction this type encodes is narrower: a layout BAND of repeated
 * marks, read as the whole job, with no extent anywhere, is an assertion about
 * how much of the structure exists that came from nobody. It computes, so it
 * must announce itself.
 *
 * It names the drawn extent in mm and the question that settles it. It names no
 * target and no total — a reader told "the answer should be nearer X" finds X.
 */
export interface UnverifiedExtent {
  /** how far the drawn tags reach along their own axis, mm, plus the closing bay */
  drawnExtentMm: number;
  /** how many distinct tag positions were counted */
  nodes: number;
  /** the measured pitch between them, mm */
  pitchMm: number;
  /** the fact whose absence makes this unverifiable — always the run */
  field: 'run';
  /** the question a person can answer */
  ask: string;
}

export interface PlacementResult {
  ok: boolean;
  /** for a dependent member: which parents produced it */
  derivedFrom?: { memberId: string; count: number }[];
  /** how many of this member exist over the whole job */
  count?: number;
  /** true when the member runs continuously rather than repeating */
  continuous?: boolean;
  /** the length one instance spans, mm — set only for continuous members */
  spanMm?: number;
  reason?: string;
  working?: string;
  evidenceIds: string[];
  /**
   * Set when this count was produced by reading a repeating drawn layout as
   * the whole job with no extent fact to check it against. `ok` is still true —
   * the count is what the drawing shows — but the SCOPE it covers is a claim,
   * and the caller must carry it into the result where it cannot be missed.
   */
  unverifiedExtent?: UnverifiedExtent;
}

const fail = (reason: string, evidenceIds: string[] = []): PlacementResult => ({
  ok: false,
  reason,
  evidenceIds,
});

// ------------------------------------------------------------
// layout geometry
// ------------------------------------------------------------

/** the axis a set of positions actually varies along */
function dominantAxis(points: readonly { x: number; y: number }[]): 'x' | 'y' {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return maxX - minX >= maxY - minY ? 'x' : 'y';
}

/** distinct node positions along an axis, in order, collapsing coincident tags */
/**
 * Do these tags spread in TWO dimensions? A band lies along one axis with
 * drafting scatter across it; a plan reaches across the sheet both ways. The
 * cross-axis spread is compared with the along-axis extent — a quarter of it,
 * and more than tag-placement noise, is a second dimension.
 */
export function isPlanSpread(nodes: readonly EvidenceNode[], axis: 'x' | 'y'): boolean {
  const other = axis === 'x' ? 'y' : 'x';
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  let n = 0;
  for (const node of nodes) {
    const p = node.position;
    if (!p) continue;
    n++;
    minA = Math.min(minA, p[axis]); maxA = Math.max(maxA, p[axis]);
    minB = Math.min(minB, p[other]); maxB = Math.max(maxB, p[other]);
  }
  if (n < 3) return false;
  const along = maxA - minA;
  const across = maxB - minB;
  return across > NODE_TOL_MM * 4 && across > 0.25 * along;
}

/** How many distinct spots these tags occupy — tags within tolerance of each other are one. */
export function distinctPositions(nodes: readonly EvidenceNode[]): number {
  const kept: { x: number; y: number }[] = [];
  let unplaced = 0;
  for (const n of nodes) {
    const p = n.position;
    if (!p) { unplaced++; continue; }
    if (!kept.some((k) => Math.abs(k.x - p.x) <= NODE_TOL_MM && Math.abs(k.y - p.y) <= NODE_TOL_MM)) kept.push(p);
  }
  return kept.length + unplaced;
}

/**
 * Is this set of tags laid out as a PLAN — spread in two dimensions along
 * its own dominant axis? A sheet on which any mark is laid out this way is a
 * plan drawing, and every mark on it is counted from what is drawn: a mark
 * that happens to sit in one row of a grid is not a band of a longer job.
 */
export function isPlanLayout(nodes: readonly EvidenceNode[]): boolean {
  const placed = nodes.filter((n) => n.position);
  if (placed.length < 3) return false;
  return isPlanSpread(placed, dominantAxis(placed.map((n) => n.position!)));
}

function orderedNodes(nodes: readonly EvidenceNode[], axis: 'x' | 'y'): number[] {
  const at = nodes
    .map((n) => n.position?.[axis])
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of at) {
    if (!out.length || Math.abs(v - out[out.length - 1]) > NODE_TOL_MM) out.push(v);
  }
  return out;
}

/**
 * How long one drawn template is, measured from the marks it carries.
 *
 * NOT from the panel's bounding box. A box includes the caption, the dimension
 * chain above the layout and whatever whitespace the drafter left, and using it
 * as a structural length silently rescales the whole job.
 *
 * The template spans its first node to its last, plus one more pitch — that
 * final pitch is the gap to the first node of the NEXT repeat, and omitting it
 * makes the template tile with its nodes touching.
 */
function templateLength(nodesAt: readonly number[]): { lengthMm: number; pitchMm: number } | null {
  if (nodesAt.length < 2) return null;
  const span = nodesAt[nodesAt.length - 1] - nodesAt[0];
  if (!(span > 0)) return null;
  const pitch = span / (nodesAt.length - 1);
  return { lengthMm: span + pitch, pitchMm: pitch };
}

// ------------------------------------------------------------
// the count rules
// ------------------------------------------------------------

/**
 * Positions at a pitch over a span — the fence-post, written once.
 *
 * Eight 150 mm gaps carry nine bars. `boundaryRule` says which ends are
 * occupied, and a short final bay still gets its closing member.
 */
export function countAtPitch(
  spanMm: number,
  pitchMm: number,
  boundaryRule: 'both-ends' | 'start-only' | 'end-only',
): { count: number; bays: number; partial: boolean } {
  const bays = Math.floor(spanMm / pitchMm);
  const remainder = spanMm - bays * pitchMm;
  const partial = remainder > BAY_TOL_MM;
  const count =
    boundaryRule === 'both-ends' ? bays + 1 + (partial ? 1 : 0) : bays + (partial ? 1 : 0);
  return { count: Math.max(count, 0), bays, partial };
}

function runOf(factId: string | undefined, ctx: ResolveContext): { mm: number } | { err: string } {
  if (!factId) return { err: 'no run was named, and this placement is measured along the run' };
  const r = resolveScalar({ kind: 'user-fact', factId }, ctx);
  if (!r.ok || !(r.mm! > 0)) {
    return { err: `the run could not be read — ${r.reason ?? 'it resolved to nothing'}` };
  }
  return { mm: r.mm! };
}

// ------------------------------------------------------------
// resolve
// ------------------------------------------------------------

export interface PlacementContext extends ResolveContext {
  graph: EvidenceGraph;
  /** the member's own measured extent, when the engine knows it */
  memberSpanMm?: Partial<Record<'x' | 'y', number>>;
  /**
   * IS A RUN A DIMENSION OF THIS MEMBER?
   *
   * A run is the extent of a RUNNING structure — a wall, a beam, a fence —
   * along which the same bars repeat. It is not a dimension of a footing, a
   * column or a slab panel: those are counted, and nothing about a "total
   * run" bears on how many of them there are. So a run is a ROW-SPECIFIC
   * dependency, never a global one, and the two places this file reasons
   * about a run — asking for one, and comparing the drawn layout against one
   * — are switched off for a member that has none.
   *
   *   true       a run applies: with none supplied, a band of tags is a claim
   *              about extent and is reported as such; with one supplied, a
   *              layout shorter than it is a template.
   *   false      the drawn tags ARE the count. No run question, no template
   *              guard, and a run fact on the record is not consulted.
   *   undefined  the caller has not said. The conservative reading is kept:
   *              a claim rather than a silent under-count.
   *
   * `resolveAllPlacements` fills it per member from `runAppliesTo`.
   */
  runApplies?: boolean;
  /** the per-member answer, for the batch resolver — see `runApplies` */
  runAppliesTo?: (memberId: string) => boolean | undefined;
}

export function resolvePlacement(
  placement: MemberPlacement,
  ctx: PlacementContext,
): PlacementResult {
  switch (placement.kind) {
    // ----------------------------------------------------------
    case 'dependent':
      // A dependent placement is meaningless on its own — it needs its parents
      // resolved first, which only `resolveAllPlacements` can guarantee.
      // Reached directly, it refuses rather than quietly returning a count of
      // its own, because a count of its own is exactly what it must not have.
      return fail(
        `${placement.relation} depends on ${placement.parentMemberIds.join(', ')} and cannot be ` +
          'resolved alone — resolve the whole job so parents come first',
      );

    // ----------------------------------------------------------
    case 'unknown':
      // The whole point. A count nobody established is not 1.
      return fail(
        `placement not established — ${placement.reason}. No count was assumed; this becomes a gap.`,
      );

    // ----------------------------------------------------------
    case 'stated': {
      // Guarded even though the answer was already typed: a placement can be
      // rebuilt from a cached run, and a count of 0 or 2.5 columns must fail
      // loudly here rather than multiply quietly through the schedule.
      if (!Number.isInteger(placement.count) || placement.count < 1) {
        return fail(
          `a stated count must be a whole number of one or more — ${JSON.stringify(placement.saidAs)} ` +
            `was read as ${placement.count}`,
        );
      }
      return {
        ok: true,
        count: placement.count,
        evidenceIds: [],
        working: `${placement.count} — stated by the user as ${JSON.stringify(placement.saidAs)}; the sheet does not say`,
      };
    }

    // ----------------------------------------------------------
    case 'once': {
      const node = ctx.graph.byId.get(placement.evidenceId);
      if (!node) {
        return fail(
          `"once" was asserted against ${placement.evidenceId}, which is not evidence on this sheet`,
        );
      }
      return {
        ok: true,
        count: 1,
        evidenceIds: [placement.evidenceId],
        working: `1 — asserted as a one-off against ${placement.evidenceId}`,
      };
    }

    // ----------------------------------------------------------
    case 'continuous': {
      const run = runOf(placement.runFactId, ctx);
      if ('err' in run) return fail(`continuous placement: ${run.err}`);
      return {
        ok: true,
        count: 1,
        continuous: true,
        spanMm: run.mm,
        evidenceIds: [`FACT-${placement.runFactId}`],
        working: `runs continuously for ${run.mm} mm (the stated run)`,
      };
    }

    // ----------------------------------------------------------
    case 'marks': {
      const nodes = placement.markEvidenceIds
        .map((id) => ctx.graph.byId.get(id))
        .filter((n): n is EvidenceNode => !!n);
      if (nodes.length !== placement.markEvidenceIds.length) {
        const missing = placement.markEvidenceIds.filter((id) => !ctx.graph.byId.get(id));
        return fail(
          `mark placement names ${missing.length} occurrence(s) that are not evidence on this ` +
            `sheet: ${missing.join(', ')}`,
          placement.markEvidenceIds,
        );
      }
      // A mark printed inside a schedule table is the row's label, not a
      // placement on the layout — see evidence.ts. It is dropped here whatever
      // the model listed, so a table row can never add one member to a count.
      const onLayout = nodes.filter((n) => n.metadata?.inTable !== true);
      if (!onLayout.length) {
        return fail(
          'mark placement named only occurrences printed inside a schedule table — those are row ' +
            'labels, not locations; point at the tags on the layout',
          placement.markEvidenceIds,
        );
      }
      const nodesOnLayout = onLayout;
      const axis = dominantAxis(nodesOnLayout.map((n) => n.position ?? { x: 0, y: 0 }));
      const at = orderedNodes(nodesOnLayout, axis);
      // THE COUNT IS TWO-DIMENSIONAL. `at` collapses tags along the dominant
      // axis for pitch and extent arithmetic; it is not the count. A 5 × 8
      // grid of footings has eight distinct x-positions and forty footings,
      // and reading the first as the second scheduled a fifth of the steel.
      // Two tags are one footing only when they sit on the same spot.
      const count = distinctPositions(nodesOnLayout);

      // A LAYOUT SHORTER THAN THE RUN IS A TEMPLATE, and the engine can prove
      // it without asking anyone.
      //
      // "marks" asserts that the drawn layout IS the whole job. On the
      // benchmark sheet the model chose it for C1, C2, SC and F1 — giving
      // 5, 2, 6 and 7 — because it was shown the tags and never told the run is
      // 100 m. It had no way to notice that 24.9 m of drawn layout cannot be a
      // 100 m wall. This is not a judgement call: it is a comparison of two
      // measured numbers, so the engine makes it rather than hoping.
      // A run is consulted only for a member a run is a dimension of. For an
      // isolated member — a footing, a column, a pedestal — the drawn tags are
      // the count, and a run on the record (answered for some other member,
      // or for a question that should never have been put) does not touch it.
      //
      // When the caller has not said, the LAYOUT decides. A band — tags in a
      // line at a pitch — could be a module of a longer thing, and the run
      // question stands. Tags spread across the sheet in two dimensions are
      // a PLAN: the building's footings on their grid, columns on a floor.
      // A plan is the whole job by construction, and a "total run" is not a
      // dimension of it. The spread is measured, not judged.
      const layoutIsPlan = ctx.runApplies === undefined && isPlanSpread(nodesOnLayout, axis);
      const runMatters = ctx.runApplies !== false && !layoutIsPlan;
      const runFact = runMatters ? ctx.userFacts?.run : undefined;

      if (!runMatters && at.length > 1) {
        return {
          ok: true,
          count,
          evidenceIds: placement.markEvidenceIds,
          working:
            `${count} — tags counted on the layout, coincident tags collapsed. ` +
            (layoutIsPlan
              ? 'The tags spread across the sheet in two dimensions — a plan, not a band — so the drawn layout is the job and no run applies.'
              : 'This member is not on a running structure, so its count is the tags drawn and no run applies.'),
        };
      }

      // NO RUN FACT AT ALL — the hole the guard below cannot see.
      //
      // The guard exists because 24.9 m of drawn layout cannot be a 100 m wall.
      // It fires only when a run fact exists to disagree with. With no extent
      // anywhere, nothing can tell a 25 m module from a 100 m job: the same
      // five tags are counted, the arithmetic is clean, and the schedule
      // under-reports by however many modules the job actually has, in silence.
      //
      // A single tag is left alone. One drawn instance is a member drawn once,
      // and there is no repetition to have mis-read. Two or more tags at a
      // pitch is a BAND — a module of a longer thing far more often than it is
      // the thing — and reading it as the whole job is a claim.
      if (!runFact && at.length > 1) {
        const extent = at[at.length - 1] - at[0];
        const pitch = extent / (at.length - 1);
        const covered = extent + pitch;
        return {
          ok: true,
          count,
          evidenceIds: placement.markEvidenceIds,
          working:
            `${count} — tags counted on the layout, coincident tags collapsed. ` +
            `This is the count over the ${Math.round(covered)} mm the layout is drawn across; ` +
            'no run was supplied, so nothing establishes that this is the whole job.',
          unverifiedExtent: {
            drawnExtentMm: Math.round(covered),
            nodes: count,
            pitchMm: Math.round(pitch),
            field: 'run',
            ask: 'What is the total run of this structure, in metres?',
          },
        };
      }

      if (runFact && runFact.mm > 0 && at.length > 1) {
        const extent = at[at.length - 1] - at[0];
        const pitch = extent / (at.length - 1);
        // the layout's own reach, including the bay past its last tag
        const covered = extent + pitch;
        if (covered < runFact.mm - NODE_TOL_MM) {
          return fail(
            `this layout covers about ${Math.round(covered)} mm, but the job runs ` +
              `${runFact.mm} mm${runFact.saidAs ? ` (${runFact.saidAs})` : ''}. Counting its tags ` +
              `would schedule ${count} where the run needs roughly ` +
              `${Math.round(runFact.mm / pitch)}. The drawn layout is a TEMPLATE of a longer job, ` +
              'not the job — use template-repeat, or say which band covers the whole run.',
            placement.markEvidenceIds,
          );
        }
      }

      return {
        ok: true,
        count,
        evidenceIds: placement.markEvidenceIds,
        working: `${count} — tags counted on the layout, coincident tags collapsed`,
      };
    }

    // ----------------------------------------------------------
    case 'uniform': {
      const pitch = resolveScalar(placement.pitchRef, ctx);
      if (!pitch.ok) return fail(`uniform placement: the pitch failed — ${pitch.reason}`, pitch.evidenceIds);
      const pitchMm = pitch.mm!;
      if (!(pitchMm > 0)) {
        return fail(
          `uniform placement: the pitch resolved to ${pitchMm}, which cannot space anything`,
          pitch.evidenceIds,
        );
      }

      let spanMm: number;
      const ids = [...pitch.evidenceIds];
      if (placement.along === 'run') {
        const run = runOf(placement.runFactId, ctx);
        if ('err' in run) return fail(`uniform placement: ${run.err}`, ids);
        spanMm = run.mm;
        ids.push(`FACT-${placement.runFactId}`);
      } else {
        const s = ctx.memberSpanMm?.[placement.along];
        if (!(typeof s === 'number' && s > 0)) {
          return fail(
            `uniform placement along ${placement.along}: the member's own extent on that axis ` +
              'is not known, so there is nothing to divide',
            ids,
          );
        }
        spanMm = s;
      }

      const { count, bays, partial } = countAtPitch(spanMm, pitchMm, placement.boundaryRule);
      if (count <= 0) {
        return fail(
          `uniform placement: ${spanMm} mm at ${pitchMm} mm produced no positions`,
          ids,
        );
      }
      return {
        ok: true,
        count,
        evidenceIds: ids,
        working:
          `${spanMm} mm ÷ ${pitchMm} mm = ${bays} bay(s)${partial ? ' + a short final bay' : ''}` +
          `, ${placement.boundaryRule} → ${count}`,
      };
    }

    // ----------------------------------------------------------
    case 'template-repeat':
    case 'periodic-pattern': {
      const run = runOf(placement.runFactId, ctx);
      if ('err' in run) return fail(`${placement.kind}: ${run.err}`);

      // The panel must be a REAL panel. Without this guard, a placement naming
      // a panel that does not exist — the usual cause being that segmentation
      // never ran — fell through to every mark on the sheet, which on a sheet
      // carrying four stacked layouts measured a "template" spanning all four
      // and produced counts roughly 50% high with no complaint. A wrong number
      // delivered confidently is the exact failure this file exists to
      // prevent, so an absent panel is refused by name.
      const panelNode = ctx.graph.byId.get(placement.panelId);
      if (!panelNode || panelNode.kind !== 'panel') {
        return fail(
          `${placement.kind}: "${placement.panelId}" is not a panel on this sheet. A template is ` +
            'measured from the marks of ONE layout; without a panel there is no way to tell which ' +
            'marks belong to it, and counting across several layouts at once would inflate every ' +
            'count. Segment the sheet first.',
        );
      }

      // The template's length comes from EVERY node on the layout, not from
      // this member's own occurrences: C2 appears twice in a template whose
      // sequence has thirteen nodes, and measuring the template from C2 alone
      // would make it three times too long.
      const inPanel = ctx.graph.inPanel(placement.panelId).filter((n) => n.kind === 'mark');
      if (inPanel.length < 2) {
        return fail(
          `${placement.kind}: ${placement.panelId} carries ${inPanel.length} mark occurrence(s), ` +
            'so there is no drawn sequence to repeat',
        );
      }
      const axis = dominantAxis(inPanel.map((n) => n.position ?? { x: 0, y: 0 }));
      const allNodes = orderedNodes(inPanel, axis);
      const tpl = templateLength(allNodes);
      if (!tpl) return fail(`${placement.kind}: the layout in ${placement.panelId} has no measurable span`);

      const own = placement.orderedOccurrenceIds
        .map((id) => ctx.graph.byId.get(id))
        .filter((n): n is EvidenceNode => !!n);
      if (!own.length) {
        return fail(
          `${placement.kind}: none of the named occurrences are evidence on this sheet`,
          placement.orderedOccurrenceIds,
        );
      }
      const ownAt = orderedNodes(own, axis);
      const perTemplate = ownAt.length;

      // How many whole templates fit, and what the tail carries. The tail is
      // counted by POSITION, not by proportion: a member sitting at the start
      // of the template appears in a short tail, one sitting at the end does
      // not. That is what preserves the phase of an alternating layout.
      const whole = Math.floor(run.mm / tpl.lengthMm);
      const tail = run.mm - whole * tpl.lengthMm;
      const origin = allNodes[0];
      const inTail = tail > BAY_TOL_MM ? ownAt.filter((v) => v - origin <= tail + NODE_TOL_MM).length : 0;
      const count = whole * perTemplate + inTail;

      if (count <= 0) {
        return fail(
          `${placement.kind}: a ${run.mm} mm run over a ${Math.round(tpl.lengthMm)} mm template ` +
            'produced no occurrences',
          placement.orderedOccurrenceIds,
        );
      }
      return {
        ok: true,
        count,
        evidenceIds: [...placement.orderedOccurrenceIds, `FACT-${placement.runFactId}`],
        working:
          `template ${Math.round(tpl.lengthMm)} mm (${allNodes.length} nodes at ~${Math.round(tpl.pitchMm)} mm) ` +
          `carries ${perTemplate}; ${run.mm} mm run = ${whole} whole template(s)` +
          (inTail ? ` + ${inTail} in a ${Math.round(tail)} mm tail` : '') +
          ` → ${count}`,
      };
    }
  }
}

/**
 * A placement is required on every member — that is the point.
 *
 * An absent placement is not an empty field to be filled with 1; it is a
 * schema violation, and this is what the verifier calls to say so.
 */
export function requirePlacement(value: unknown, memberMark: string): MemberPlacement {
  if (value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string') {
    return value as MemberPlacement;
  }
  return {
    kind: 'unknown',
    reason: `no placement was given for ${memberMark}`,
  };
}

// ------------------------------------------------------------
// dependent placement
// ------------------------------------------------------------

export interface MemberPlacementSpec {
  /** stable id — NOT the drawing's mark string, which repeats across sheets */
  memberId: string;
  placement: MemberPlacement;
  /** the member's own bay count, when a 'one-per-bay' relation needs it */
  baysHint?: number;
}

export type PlacementResults = Map<string, PlacementResult>;

/**
 * Resolve every member's placement, parents before children.
 *
 * A dependent member is not counted at all — it is derived from its parents'
 * resolved counts. That is the whole point: a footing and its column can never
 * disagree, because only one of them was ever counted.
 *
 * Cycles are detected and refused. A member that depends on itself, directly or
 * through a chain, has no base case, and the alternative to refusing is a
 * silent zero or an infinite loop.
 */
export function resolveAllPlacements(
  specs: readonly MemberPlacementSpec[],
  ctx: PlacementContext,
): PlacementResults {
  const byId = new Map(specs.map((s) => [s.memberId, s]));
  const out: PlacementResults = new Map();
  const state = new Map<string, 'visiting' | 'done'>();

  const resolveOne = (id: string, trail: string[]): PlacementResult => {
    const done = out.get(id);
    if (done) return done;

    const spec = byId.get(id);
    if (!spec) {
      const r = fail(`"${id}" has no placement on this job, so nothing can depend on it`);
      out.set(id, r);
      return r;
    }

    if (state.get(id) === 'visiting') {
      const r = fail(
        `placement cycle: ${[...trail, id].join(' → ')}. A member cannot ultimately depend on ` +
          'itself; no count was produced for any member in the cycle.',
      );
      out.set(id, r);
      return r;
    }
    state.set(id, 'visiting');

    let result: PlacementResult;
    if (spec.placement.kind === 'dependent') {
      const p = spec.placement;
      // Run 014 died HERE: a model-shaped dependent arrived with no
      // parentMemberIds at all and `.length` threw four turns after the
      // conclusion was accepted. The schema gate now refuses that shape at
      // conclusion time; this guard is the second line, because a raw
      // TypeError is the least useful way for a schedule to fail.
      if (!Array.isArray(p.parentMemberIds) || !p.parentMemberIds.length) {
        result = fail(`${id} is dependent but names no parent — "parentMemberIds" must list at least one member id`);
      } else if (p.relation === 'custom') {
        // deliberately not implemented: 'custom' exists so a sheet needing a
        // relation this file does not model is REPORTED rather than forced
        // into the nearest one that happens to compile
        result = fail(
          `${id} uses a custom dependent relation, which has no engine rule — it must be ` +
            'given explicitly or asked about',
        );
      } else {
        const parents = p.parentMemberIds.map((pid) => ({
          memberId: pid,
          res: resolveOne(pid, [...trail, id]),
        }));
        const broken = parents.filter((x) => !x.res.ok);
        if (broken.length) {
          result = fail(
            `${id} depends on ${broken.map((b) => b.memberId).join(', ')}, whose placement did ` +
              `not resolve — ${broken[0].res.reason}. No independent count was substituted.`,
          );
        } else {
          const derivedFrom = parents.map((x) => ({
            memberId: x.memberId,
            count: x.res.count ?? 0,
          }));
          const total = derivedFrom.reduce((n, d) => n + d.count, 0);
          // A count derived from a parent inherits the parent's SCOPE. If the
          // columns were counted off a drawn band nobody established as the
          // whole job, the footings under them cover exactly that same stretch,
          // and losing the caveat on the way down is how a warned number
          // becomes an unwarned one.
          const inherited = parents.find((x) => x.res.unverifiedExtent)?.res.unverifiedExtent;
          if (p.relation === 'one-per-bay') {
            // bays are the gaps BETWEEN parents, one fewer than the parents
            const bays = spec.baysHint ?? Math.max(total - 1, 0);
            result = {
              ok: true,
              count: bays,
              derivedFrom,
              evidenceIds: [],
              working: `${bays} — one per bay between ${total} ${p.parentMemberIds.join(' + ')}`,
              ...(inherited ? { unverifiedExtent: inherited } : {}),
            };
          } else {
            // one-per-parent and same-as-parent agree on the arithmetic and
            // differ only in what they assert; both are the parents' total
            result = {
              ok: true,
              count: total,
              derivedFrom,
              evidenceIds: [],
              working:
                `${total} — ${p.relation === 'same-as-parent' ? 'the same occurrences as' : 'one per'} ` +
                derivedFrom.map((d) => `${d.memberId} (${d.count})`).join(' + '),
              ...(inherited ? { unverifiedExtent: inherited } : {}),
            };
          }
        }
      }
    } else {
      result = resolvePlacement(
        spec.placement,
        ctx.runAppliesTo && ctx.runApplies === undefined
          ? { ...ctx, ...(ctx.runAppliesTo(id) === undefined ? {} : { runApplies: ctx.runAppliesTo(id) }) }
          : ctx,
      );
    }

    state.set(id, 'done');
    out.set(id, result);
    return result;
  };

  for (const s of specs) resolveOne(s.memberId, []);
  return out;
}
