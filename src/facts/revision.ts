// Revision pipeline — the data half of §5.2, producing the §5.4 impact report.
//
// A drawing is re-issued at a new revision. For every current fact sourced
// from it:
//
//   in newFacts, value changed     → recorded via recordFact (same-state,
//                                    newer-revision path — reason on the old
//                                    entry is 'newer-revision'), listed CHANGED
//   in newFacts, value identical   → recorded (source moves to the new
//                                    revision), listed UNCHANGED
//   absent from newFacts           → becomes MISSING, lookedIn recording the
//                                    new revision (it was on R1, not found on
//                                    R2), listed NOW MISSING
//   SUPPLIED                       → untouched (a human's answer does not
//                                    expire with a re-issue), listed SURVIVED
//   DERIVED                        → marked stale for recompute
//
// Facts in newFacts with no prior entry are recorded and listed ADDED.
// Nothing is lost: every replaced value stays in the ledger's history with
// its old source resolvable (factVersions).

import type { Ledger } from './ledger';
import { appendFact, factsBySource, recordFact, resolveFact } from './ledger';
import type { Fact, FactSource, FactValue } from './types';

export interface RevisionFactsInput {
  drawingNumber: string;
  oldRevision: string;
  newRevision: string;
  /** the facts read off the new revision, sources pointing at it */
  newFacts: Fact[];
}

export interface RevisionChange {
  id: string;
  oldValue: FactValue;
  newValue: FactValue;
  /** the OLD drawing + revision + handles — still resolvable (§5.4) */
  oldSource?: FactSource;
  newSource?: FactSource;
}

/** The §5.4 revision impact report — the structure the UI renders. */
export interface RevisionImpact {
  drawing: string;
  from: string;
  to: string;
  changed: RevisionChange[];
  unchanged: string[];
  added: string[];
  nowMissing: string[];
  /** SUPPLIED facts left untouched */
  survived: string[];
}

export interface RevisionResult {
  ledger: Ledger;
  impact: RevisionImpact;
}

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Apply a drawing revision to the ledger and report its impact (§5.2/§5.4).
 * Pure: returns a new ledger value; the input is never mutated.
 */
export function applyRevisionFacts(ledger: Ledger, input: RevisionFactsInput): RevisionResult {
  const { drawingNumber, oldRevision, newRevision, newFacts } = input;

  const changed: RevisionChange[] = [];
  const unchanged: string[] = [];
  const added: string[] = [];
  const nowMissing: string[] = [];
  const survived = new Set<string>();

  // Snapshot of the facts currently standing on this drawing, before any write.
  const prior = factsBySource(ledger, drawingNumber);
  const newIds = new Set(newFacts.map((f) => f.id));

  let next = ledger;

  // 1. Record every fact read off the new revision.
  for (const nf of newFacts) {
    const fact: Fact = {
      ...nf,
      source: nf.source ?? { drawingNumber, revision: newRevision },
    };
    const cur = resolveFact(next, fact.id);

    if (cur?.state === 'SUPPLIED') {
      // Survival rule 1: a human's answer about the project does not expire
      // because a drawing was reissued. The re-read is not recorded over it.
      survived.add(fact.id);
      continue;
    }

    const result = recordFact(next, fact);
    next = result.ledger;

    if (!cur) {
      added.push(fact.id);
    } else if (!result.accepted) {
      // The reading did not displace what stands (e.g. a DECLARED re-read
      // against a MEASURED value) — the current value is unchanged, and the
      // losing claim is on the record per recordFact's own bookkeeping.
      unchanged.push(fact.id);
    } else if (cur.value === fact.value) {
      unchanged.push(fact.id);
    } else {
      changed.push({
        id: fact.id,
        oldValue: cur.value,
        newValue: fact.value,
        ...(cur.source !== undefined ? { oldSource: cur.source } : {}),
        ...(fact.source !== undefined ? { newSource: fact.source } : {}),
      });
    }
  }

  // 2. Facts that were on the old revision but not found on the new one
  //    become MISSING — they were on R1, not found on R2. SUPPLIED facts
  //    survive; DERIVED facts are handled by staleness below.
  for (const p of prior) {
    if (p.state === 'SUPPLIED') {
      survived.add(p.id);
      continue;
    }
    if (newIds.has(p.id) || p.state === 'DERIVED' || p.state === 'MISSING') continue;
    const missing: Fact = {
      id: p.id,
      value: null,
      state: 'MISSING',
      neededFor: p.neededFor,
      lookedIn: [`${drawingNumber} ${newRevision}`],
      ask:
        `${p.id} was read off ${drawingNumber} ${oldRevision} ` +
        `(${String(p.value)}${p.unit ? ` ${p.unit}` : ''}) but was not found on ` +
        `${newRevision} — what is it now?`,
      readOn: today(),
    };
    next = appendFact(next, missing, 'newer-revision');
    nowMissing.push(p.id);
  }

  // 3. Survival rule 2: DERIVED facts sourced from this drawing are
  //    recomputed, not carried — mark the ones still standing stale.
  const entries = next.entries.map((e) => {
    const f = e.fact;
    if (
      f.supersededBy === undefined &&
      f.state === 'DERIVED' &&
      f.source?.drawingNumber === drawingNumber &&
      f.stale !== true
    ) {
      return { seq: e.seq, fact: { ...f, stale: true } };
    }
    return e;
  });
  next = { entries };

  return {
    ledger: next,
    impact: {
      drawing: drawingNumber,
      from: oldRevision,
      to: newRevision,
      changed,
      unchanged,
      added,
      nowMissing,
      survived: [...survived],
    },
  };
}
