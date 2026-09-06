// BLOCKED rows (HOW_TO_BUILD_IT §6.4).
//
// The rule that makes the schedule honest:
//
//   A quantity may only be computed when every fact it depends on is
//   MEASURED, DECLARED, SUPPLIED or DERIVED. If any dependency is MISSING,
//   the row is emitted as a formula with a hole — never as a number.
//
// A blocked row is a useful document: the formula with the hole named, where
// it was searched, and exactly what to ask. The moment someone supplies the
// fact, computeWhenResolved computes the number with no re-reading.

import type { Ledger } from './ledger';
import { resolveFact } from './ledger';
import type { Fact } from './types';
import { isUsable } from './types';

export interface BlockedRow {
  /** The formula text with the hole named in it, e.g. "4 × ⌈ wall.total_run / 4157 ⌉". */
  formula: string;
  /** Fact ids the formula depends on that are (or were) MISSING. */
  missingFactIds: string[];
  /** Questions to put to a human, one per hole. */
  ask: string[];
}

/**
 * Render the §6.4 shape: the formula, then for each hole a BLOCKED block
 * naming the missing fact, what was searched (from the ledger's MISSING
 * entry), and what to ask. Ask text comes from the ledger fact when present,
 * falling back to the row's own ask list.
 */
export function renderBlockedRow(row: BlockedRow, ledger: Ledger): string {
  const lines: string[] = [row.formula];
  row.missingFactIds.forEach((id, i) => {
    const fact = resolveFact(ledger, id);
    lines.push(`⚠ BLOCKED — ${id} is MISSING`);
    if (fact?.neededFor?.length) lines.push(`  needed for:  ${fact.neededFor.join(', ')}`);
    if (fact?.lookedIn?.length) lines.push(`  searched:    ${fact.lookedIn.join(', ')}`);
    const ask = fact?.ask ?? row.ask[i];
    if (ask) lines.push(`  ask:         "${ask}"`);
  });
  return lines.join('\n');
}

export type ResolvedComputation<T> =
  | { computed: true; value: T; facts: Record<string, Fact> }
  | { computed: false; missing: string[] };

/**
 * The §6.4 gate. Checks every dependency of the row against the ledger: if
 * each one now resolves to a usable (non-MISSING) fact, the supplied compute
 * callback runs over the resolved facts and the number appears — no
 * re-reading of any drawing. If any dependency is still MISSING (or absent),
 * nothing is computed and the remaining holes are named.
 */
export function computeWhenResolved<T>(
  row: BlockedRow,
  ledger: Ledger,
  compute: (facts: Record<string, Fact>) => T,
): ResolvedComputation<T> {
  const facts: Record<string, Fact> = {};
  const missing: string[] = [];
  for (const id of row.missingFactIds) {
    const fact = resolveFact(ledger, id);
    if (!fact || !isUsable(fact)) missing.push(id);
    else facts[id] = fact;
  }
  if (missing.length > 0) return { computed: false, missing };
  return { computed: true, value: compute(facts), facts };
}
