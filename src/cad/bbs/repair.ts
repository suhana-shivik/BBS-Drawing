// ============================================================
// Targeted repair — fix the field, not the drawing.
//
// A verification failure names one field of one member. The old loop's only
// response was to read the whole sheet again, which is slow, costs a full
// request, and — because the read is not deterministic — is as likely to break
// something that was already right as to fix the thing that was wrong.
//
// A repair is therefore scoped to exactly one field, shown exactly the evidence
// that could settle it, and re-verified immediately. Everything else that
// passed stays passed.
//
// THE REJECTED CANDIDATES ARE PART OF THE BRIEF. A repair that is told only
// "pick a length for F1" can pick the same wrong 150 mm again — it has no way
// to know that was the answer that just failed. Telling it what was rejected
// AND WHY is what makes a second attempt different from a retry.
//
// ATTEMPTS ARE BOUNDED AND ESCALATE. After the limit the field becomes a
// question for a person, or a visible gap. It never becomes a guess, and it
// never loops.
// ============================================================
import type { EvidenceNode } from './evidence';
import type { VerificationFailure } from './verify';

// v1: hoisted from the legacy orchestrator (not ported).
export const MAX_REPAIR_ATTEMPTS = 2;

export interface RepairCandidate {
  evidenceId: string;
  /** what it says, verbatim */
  text?: string;
  /** the value it would produce, mm — computed by the engine, not offered as a hint */
  valueMm?: number;
  /** why it is a plausible answer for this field */
  because?: string;
}

export interface RejectedCandidate {
  evidenceId: string;
  reason: string;
}

export interface RepairBrief {
  /** stable id so the same failure is not repaired twice concurrently */
  id: string;
  memberMark?: string;
  field?: string;
  gate: string;
  /** what failed, in the words the gate used */
  problem: string;
  candidates: RepairCandidate[];
  rejected: RejectedCandidate[];
  attempt: number;
  maxAttempts: number;
  /** true when this brief has nothing to work with and should escalate */
  exhausted: boolean;
  /** why it is being escalated instead of repaired */
  escalationReason?: string;
}

export interface RepairHistoryEntry {
  briefId: string;
  attempt: number;
  /** the evidence the repair chose, if it chose one */
  chose?: string;
  /** whether re-verification accepted it */
  accepted: boolean;
  note?: string;
}

export interface RepairState {
  attempts: Map<string, number>;
  rejected: Map<string, RejectedCandidate[]>;
  history: RepairHistoryEntry[];
}

export function createRepairState(): RepairState {
  return { attempts: new Map(), rejected: new Map(), history: [] };
}

/** a failure's stable identity — a repair is per field, not per occurrence */
export function failureKey(f: VerificationFailure): string {
  return `${f.gate}:${f.memberMark ?? '-'}:${f.field ?? '-'}`;
}

export interface CandidateSource {
  /** evidence that could plausibly settle this field */
  nodes: readonly EvidenceNode[];
  /**
   * The engine's reading of each, so the brief can say what each would
   * produce. Deliberately NOT named `valueOf` — that collides with
   * `Object.prototype.valueOf`, and an object literal omitting it then
   * type-checks against the inherited method instead of being seen as absent.
   */
  readValue?: (node: EvidenceNode) => number | undefined;
  /** a band the field's value must fall inside, when the field has one */
  band?: [number, number];
}

/**
 * Build the brief for one failure.
 *
 * Candidates are filtered to what could actually be right: a value outside the
 * field's plausible band is not offered, because offering it invites the same
 * mistake with a fresh coat of paint. What was filtered out is reported as
 * rejected, with the reason, so the repair can see the shape of the problem.
 */
export function buildRepairBrief(
  failure: VerificationFailure,
  source: CandidateSource,
  state: RepairState,
): RepairBrief {
  const id = failureKey(failure);
  const attempt = (state.attempts.get(id) ?? 0) + 1;
  const priorRejected = state.rejected.get(id) ?? [];

  const candidates: RepairCandidate[] = [];
  const rejected: RejectedCandidate[] = [...priorRejected];
  const alreadyRejected = new Set(priorRejected.map((r) => r.evidenceId));

  for (const node of source.nodes) {
    if (alreadyRejected.has(node.id)) continue;
    const value = source.readValue?.(node);
    if (source.band && value !== undefined) {
      const [lo, hi] = source.band;
      if (value < lo || value > hi) {
        rejected.push({
          evidenceId: node.id,
          reason: `reads ${value}, outside the ${lo}–${hi} mm a ${failure.field ?? 'value'} of this kind can take`,
        });
        continue;
      }
    }
    candidates.push({
      evidenceId: node.id,
      text: node.rawText,
      valueMm: value,
      because: node.panelId ? `in ${node.panelId}, the panel that draws this member` : undefined,
    });
  }

  const exhausted = candidates.length === 0 || attempt > MAX_REPAIR_ATTEMPTS;
  return {
    id,
    memberMark: failure.memberMark,
    field: failure.field,
    gate: failure.gate,
    problem: failure.message,
    candidates,
    rejected,
    attempt,
    maxAttempts: MAX_REPAIR_ATTEMPTS,
    exhausted,
    escalationReason: exhausted
      ? candidates.length === 0
        ? 'the drawing carries no evidence that could settle this field — it has to be asked'
        : `repaired ${MAX_REPAIR_ATTEMPTS} times without passing; a person must decide`
      : undefined,
  };
}

/** Record what a repair attempt chose and whether it survived re-verification. */
export function recordRepair(
  state: RepairState,
  brief: RepairBrief,
  outcome: { chose?: string; accepted: boolean; note?: string },
): RepairState {
  state.attempts.set(brief.id, brief.attempt);
  state.history.push({
    briefId: brief.id,
    attempt: brief.attempt,
    chose: outcome.chose,
    accepted: outcome.accepted,
    note: outcome.note,
  });
  if (!outcome.accepted && outcome.chose) {
    // the choice that just failed becomes a named rejection, so the next
    // attempt is a different attempt rather than the same one again
    const list = state.rejected.get(brief.id) ?? [];
    if (!list.some((r) => r.evidenceId === outcome.chose)) {
      list.push({
        evidenceId: outcome.chose,
        reason: outcome.note ?? 'chosen on a previous attempt and rejected by verification',
      });
    }
    state.rejected.set(brief.id, list);
  }
  return state;
}

/** How the brief reads to whoever is answering it. */
export function renderRepairBrief(brief: RepairBrief): string {
  const lines = [
    `REPAIR — ${brief.memberMark ?? 'this job'}${brief.field ? `.${brief.field}` : ''}`,
    `attempt ${brief.attempt} of ${brief.maxAttempts}`,
    '',
    `WHAT FAILED (${brief.gate}): ${brief.problem}`,
    '',
  ];
  if (brief.candidates.length) {
    lines.push('CANDIDATES — choose one, and return a pointer, not a number:');
    for (const c of brief.candidates) {
      lines.push(
        `  ${c.evidenceId}${c.text ? `  ${JSON.stringify(c.text)}` : ''}` +
          `${c.valueMm !== undefined ? `  (would give ${c.valueMm} mm)` : ''}` +
          `${c.because ? `  — ${c.because}` : ''}`,
      );
    }
  } else {
    lines.push('CANDIDATES: none. The drawing carries nothing that could settle this.');
  }
  if (brief.rejected.length) {
    lines.push('', 'ALREADY REJECTED — do not choose these again:');
    for (const r of brief.rejected) lines.push(`  ${r.evidenceId} — ${r.reason}`);
  }
  lines.push(
    '',
    'If none of the candidates is right, say so and why. That turns a field the drawing ' +
      'cannot settle into a question a person can answer, which is a better outcome than a ' +
      'confident wrong pointer.',
  );
  return lines.join('\n');
}

/**
 * Which failures to repair, in what order.
 *
 * Ordered by how much they unblock, never by how much weight they might add.
 * A repair queue sorted by expected tonnage is a queue that chases a total.
 */
export function prioritiseFailures(failures: readonly VerificationFailure[]): VerificationFailure[] {
  const GATE_RANK: Record<string, number> = {
    schema: 0,
    provenance: 1,
    placement: 2,
    completeness: 3,
    coverage: 4,
    bands: 5,
    geometry: 6,
    arithmetic: 7,
    referee: 8,
  };
  return [...failures].sort((a, b) => {
    const byGate = (GATE_RANK[a.gate] ?? 99) - (GATE_RANK[b.gate] ?? 99);
    if (byGate) return byGate;
    return `${a.memberMark}${a.field}`.localeCompare(`${b.memberMark}${b.field}`);
  });
}
