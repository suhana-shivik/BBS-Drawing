// ============================================================
// Callout ownership — every callout belongs to exactly one member.
//
// WHAT WENT WRONG WITHOUT THIS
//
// Assignment was asked member by member: "which of these callouts are SC's?",
// then the same question for C1, C2, TB, F1. Each answer was reasonable in
// isolation and the union was nonsense. Run 002:
//
//     32 callouts were assigned at all
//     29 of them were assigned to MORE THAN ONE member
//     CALL-010 was assigned to five: SC, TB, C1, C2, F1
//
// That is where 107 rows came from on a sheet carrying about fifteen.
//
// WHY THIS IS NOT FIRST-CLAIM-WINS
//
// The obvious repair is to let the first member to ask keep it. That fixes the
// duplication and introduces something worse: the answer then depends on the
// order the orchestrator happened to schedule its tasks. Change the priority
// function, run the passes in parallel, or add a member, and the same drawing
// yields a different schedule. Processing order would be deciding engineering
// meaning.
//
// So every claim is COLLECTED first and resolved afterwards, by evidence:
//
//     1. the callout sits inside that member's own detail region
//     2. a leader from it terminates on that member
//     3. a strong geometric relationship
//     4. proximity — and only as a last resort
//
// Resolution is a pure function of the claim set. The same claims in any order
// produce the same owner, which is the property that makes this trustworthy.
//
// AND A TIE IS NOT BROKEN. Two members with equally good evidence leave the
// callout UNRESOLVED, naming both, so a repair or a person settles it. Guessing
// between two plausible owners is how a footing's bars end up on a column.
//
// SHARING IS DECLARED, NEVER INFERRED. A note reading "ALL COLUMNS 8TOR@200
// LINKS" governs several members. That is a `shared` group, stated once with
// its member ids — not the same id quietly appearing in five answers.
// ============================================================
import type { EvidenceNode } from './evidence';
import type { BarTypeName } from './contract';
import type { CanonicalMember } from './members';

export type CalloutState = 'assigned' | 'shared' | 'excluded' | 'unresolved';

/** why a member believes a callout is its own — ordered strongest first */
export type OwnershipBasis =
  | 'in-detail'
  | 'leader-terminates'
  | 'strong-geometry'
  | 'proximity';

/** lower is stronger; the tier decides before any distance does */
const TIER: Record<OwnershipBasis, number> = {
  'in-detail': 0,
  'leader-terminates': 1,
  'strong-geometry': 2,
  proximity: 3,
};

/**
 * Two proximity claims closer than this to each other are indistinguishable.
 *
 * Expressed as a RATIO rather than millimetres so it holds at any drawing
 * scale: a callout 400 mm from one member and 420 mm from another is not
 * meaningfully nearer either.
 */
const AMBIGUITY_RATIO = 1.25;

export interface OwnershipClaim {
  calloutId: string;
  memberId: string;
  basis: OwnershipBasis;
  /** millimetres, for the proximity tiers; ignored by the stronger ones */
  distanceMm?: number;
  /** the model's stated reason, carried into the disposition */
  reason: string;
  /** what the pass returned about the bar itself — validated against BAR_TYPES at the gate */
  barType?: BarTypeName;
  distributionAxis?: 'L' | 'W' | 'H';
}

export interface CalloutDisposition {
  calloutId: string;
  state: CalloutState;
  memberId?: string;
  sharedMemberIds?: string[];
  reason: string;
  basis?: OwnershipBasis;
  /** for `unresolved` through ambiguity: who was in contention */
  contenders?: { memberId: string; basis: OwnershipBasis; distanceMm?: number }[];
  barType?: BarTypeName;
  distributionAxis?: 'L' | 'W' | 'H';
}

export interface OwnershipInput {
  /** every callout the extractor read — the denominator */
  allCalloutIds: readonly string[];
  claims: readonly OwnershipClaim[];
  /** notes explicitly declared as governing several members */
  shared?: readonly { calloutId: string; memberIds: string[]; reason: string }[];
  /** callouts a pass explicitly declined, with why */
  excluded?: readonly { calloutId: string; reason: string }[];
}

export interface OwnershipResult {
  dispositions: Map<string, CalloutDisposition>;
  /** callouts left unresolved because two members were equally credible */
  ambiguous: CalloutDisposition[];
  counts: Record<CalloutState, number>;
}

/**
 * Decide every callout's owner from the whole claim set at once.
 *
 * PURE and ORDER-INDEPENDENT: shuffle the claims and the result is identical.
 * That is the property being bought here — see the header.
 */
export function resolveOwnership(input: OwnershipInput): OwnershipResult {
  const dispositions = new Map<string, CalloutDisposition>();
  const ambiguous: CalloutDisposition[] = [];

  // explicit declarations first — they are statements, not candidates
  for (const s of input.shared ?? []) {
    dispositions.set(s.calloutId, {
      calloutId: s.calloutId,
      state: 'shared',
      sharedMemberIds: [...s.memberIds],
      reason: s.reason,
    });
  }

  const byCallout = new Map<string, OwnershipClaim[]>();
  for (const c of input.claims) {
    if (dispositions.has(c.calloutId)) continue; // already declared shared
    const list = byCallout.get(c.calloutId) ?? [];
    list.push(c);
    byCallout.set(c.calloutId, list);
  }

  for (const [calloutId, claims] of byCallout) {
    // strongest tier first; within a tier, nearest first
    const ranked = [...claims].sort((a, b) => {
      const byTier = TIER[a.basis] - TIER[b.basis];
      if (byTier) return byTier;
      return (a.distanceMm ?? 0) - (b.distanceMm ?? 0);
    });

    const best = ranked[0];
    const rivals = ranked.filter(
      (c) => c.memberId !== best.memberId && TIER[c.basis] === TIER[best.basis],
    );

    // A rival in the same tier only loses if it is meaningfully worse. For the
    // containment and leader tiers there is no distance to compare, so any
    // rival at all is a genuine tie.
    let decisive = rivals.length === 0;
    if (!decisive && best.distanceMm !== undefined) {
      const nearestRival = Math.min(...rivals.map((r) => r.distanceMm ?? Infinity));
      decisive = nearestRival > Math.max(best.distanceMm, 1) * AMBIGUITY_RATIO;
    }

    if (decisive) {
      dispositions.set(calloutId, {
        calloutId,
        state: 'assigned',
        memberId: best.memberId,
        basis: best.basis,
        reason: best.reason,
        barType: best.barType,
        distributionAxis: best.distributionAxis,
      });
      continue;
    }

    const contenders = [best, ...rivals].map((c) => ({
      memberId: c.memberId,
      basis: c.basis,
      distanceMm: c.distanceMm,
    }));
    const d: CalloutDisposition = {
      calloutId,
      state: 'unresolved',
      reason:
        `${contenders.length} members have equally good evidence for this callout ` +
        `(${contenders.map((c) => `${c.memberId} by ${c.basis}`).join(', ')}). Choosing between ` +
        'them would be a guess, and a callout on the wrong member schedules its steel there too.',
      contenders,
    };
    dispositions.set(calloutId, d);
    ambiguous.push(d);
  }

  // explicit exclusions, where nothing claimed the callout
  for (const e of input.excluded ?? []) {
    if (dispositions.has(e.calloutId)) continue;
    dispositions.set(e.calloutId, {
      calloutId: e.calloutId,
      state: 'excluded',
      reason: e.reason,
    });
  }

  const counts: Record<CalloutState, number> = {
    assigned: 0,
    shared: 0,
    excluded: 0,
    unresolved: 0,
  };
  for (const id of input.allCalloutIds) {
    const d = dispositions.get(id);
    if (!d) {
      counts.unresolved++;
      dispositions.set(id, {
        calloutId: id,
        state: 'unresolved',
        reason: 'no member claimed it and nothing excluded it — its steel is simply missing',
      });
      continue;
    }
    counts[d.state]++;
  }

  return { dispositions, ambiguous, counts };
}

export function ownedBy(result: OwnershipResult, memberId: string): CalloutDisposition[] {
  return [...result.dispositions.values()].filter(
    (d) =>
      (d.state === 'assigned' && d.memberId === memberId) ||
      (d.state === 'shared' && d.sharedMemberIds?.includes(memberId)),
  );
}

/** The invariant: exactly one terminal disposition per callout, no double ownership. */
export function auditOwnership(result: OwnershipResult, allIds: readonly string[]): {
  ok: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  const owners = new Map<string, string[]>();
  for (const d of result.dispositions.values()) {
    if (d.state === 'assigned') {
      if (!d.memberId) problems.push(`${d.calloutId} is assigned but names no member`);
      else owners.set(d.calloutId, [d.memberId]);
    }
    if (d.state === 'shared' && !(d.sharedMemberIds?.length ?? 0)) {
      problems.push(`${d.calloutId} is shared but names no members`);
    }
  }
  for (const id of allIds) {
    if (!result.dispositions.has(id)) problems.push(`${id} has no disposition at all`);
  }
  for (const [id, list] of owners) {
    if (list.length > 1) problems.push(`${id} is assigned to ${list.length} members`);
  }
  return { ok: problems.length === 0, problems };
}

// ------------------------------------------------------------
// candidate restriction — what a member may even be offered
// ------------------------------------------------------------

export interface CandidateContext {
  member: CanonicalMember;
  /** the detail region(s) that draw this member */
  detailIds: readonly string[];
  /** ids a leader from this member terminates on */
  leaderTargets?: readonly string[];
}

export interface Candidate {
  node: EvidenceNode;
  basis: OwnershipBasis;
  distanceMm?: number;
}

/**
 * Which callouts a member may be OFFERED — not every callout on the sheet.
 *
 * Showing all of them to all members is what produced 29 duplicate claims: a
 * model asked "is this SC's?" about a footing callout, with no way to see it
 * sits in another detail entirely, will often say yes.
 */
export function candidatesFor(
  ctx: CandidateContext,
  callouts: readonly EvidenceNode[],
  anchor: { x: number; y: number } | undefined,
  limit = 14,
): Candidate[] {
  const details = new Set(ctx.detailIds);
  const leaders = new Set(ctx.leaderTargets ?? []);
  const out: Candidate[] = [];

  for (const c of callouts) {
    if (c.panelId && details.has(c.panelId)) {
      out.push({ node: c, basis: 'in-detail' });
      continue;
    }
    if (leaders.has(c.id)) {
      out.push({ node: c, basis: 'leader-terminates' });
      continue;
    }
    if (anchor && c.position) {
      out.push({
        node: c,
        basis: 'proximity',
        distanceMm: Math.hypot(c.position.x - anchor.x, c.position.y - anchor.y),
      });
    }
  }

  return out
    .sort((a, b) => {
      const byTier = TIER[a.basis] - TIER[b.basis];
      if (byTier) return byTier;
      return (a.distanceMm ?? 0) - (b.distanceMm ?? 0);
    })
    .slice(0, limit);
}

/** How the candidates read to the pass — with the basis, never a bare list. */
export function renderCandidates(cands: readonly Candidate[]): string {
  if (!cands.length) return '(no callout is near this member — say so rather than reaching)';
  return cands
    .map(
      (c) =>
        `${c.node.id}  ${JSON.stringify(c.node.rawText ?? '')}  — offered because it is ` +
        (c.basis === 'in-detail'
          ? 'inside the detail that draws this member'
          : c.basis === 'leader-terminates'
            ? 'the target of a leader from this member'
            : c.basis === 'strong-geometry'
              ? 'geometrically tied to it'
              : `${Math.round(c.distanceMm ?? 0)} mm from it`),
    )
    .join('\n');
}

/** The basis a candidate was offered under, so a claim inherits it. */
export function basisOf(cands: readonly Candidate[], calloutId: string): Candidate | undefined {
  return cands.find((c) => c.node.id === calloutId);
}
