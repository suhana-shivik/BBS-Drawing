// Required-fact lists per quantity kind (HOW_TO_BUILD_IT §6.3).
//
// "compute the required-fact list for the target quantity" — this module is the
// data-driven table that produces it. Deliberately minimal for v1: a BBS on a
// linear member requires the member's run/extent (bars repeat per running
// metre); the per-member detail facts (sections, callouts, spacings) come from
// reading the drawing itself and are appended to the ledger as they are found,
// not demanded up front.

export type QuantityKind = 'bbs' | 'concrete' | 'formwork' | 'boq';

export interface RequiredFact {
  /** Fact id, e.g. "wall.total_run". */
  id: string;
  /** Why the quantity cannot be computed without it. */
  reason: string;
}

export interface RequiredContext {
  /** Subject of the take-off, e.g. "wall" for a boundary wall. */
  subject: string;
  /** Linear members (walls, fences, tie beams) are measured per running metre. */
  memberKind?: 'linear' | 'discrete';
  /** Member subjects whose cross-sections enter volume/area, e.g. ["TB", "SC"]. */
  members?: string[];
}

/** One data row of the requirements table. */
interface Rule {
  kinds: QuantityKind[];
  applies: (ctx: RequiredContext) => boolean;
  facts: (ctx: RequiredContext) => RequiredFact[];
}

const RULES: Rule[] = [
  {
    // Any take-off on a linear member needs its extent: bar counts, concrete
    // volume, formwork area and BOQ items all multiply by the run.
    kinds: ['bbs', 'concrete', 'formwork', 'boq'],
    applies: (ctx) => ctx.memberKind === 'linear',
    facts: (ctx) => [
      {
        id: `${ctx.subject}.total_run`,
        reason:
          'extent of the linear member — every per-running-metre quantity ' +
          'multiplies by the total run',
      },
    ],
  },
  {
    // Volume and shuttering need each member's cross-section.
    kinds: ['concrete', 'formwork'],
    applies: (ctx) => (ctx.members?.length ?? 0) > 0,
    facts: (ctx) =>
      (ctx.members ?? []).map((m) => ({
        id: `${m}.section`,
        reason: `cross-section of ${m} — enters volume/shuttering area directly`,
      })),
  },
];

/**
 * The facts a quantity of the given kind requires before it may be computed,
 * each with the reason it is required. Ids are stable "<subject>.<name>" so
 * they can be looked up in / recorded into the ledger directly.
 */
export function requiredFactsFor(
  quantityKind: QuantityKind,
  context: RequiredContext,
): RequiredFact[] {
  const out: RequiredFact[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    if (!rule.kinds.includes(quantityKind) || !rule.applies(context)) continue;
    for (const f of rule.facts(context)) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
    }
  }
  return out;
}
