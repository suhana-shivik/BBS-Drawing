// ============================================================
// CALCULATED IS NOT VALIDATED.
//
// "34/34 calculated" says every row reached a weight. It does not say the
// weight is right. A row cut to an ASSUMED cover, a count that rests on a
// dimension nobody read, a length the second opinion disagrees with — each of
// these computes cleanly and is not yet an engineering answer.
//
// So there are two statuses, and this file owns the second:
//
//   CALCULATION   DRAFT · CALCULATING · CALCULATED · STALE · REBUILDING · ERROR
//                 — did the arithmetic run, and is it current?
//   ENGINEERING   UNVALIDATED · PARTIALLY_VALIDATED · VALIDATED · REJECTED
//                 — can the number be relied on, and why or why not?
//
// FINAL is the conjunction: every row VALIDATED, nothing stale, the drawing
// hash matching, the summary reconciling, no open dependency. Anything less
// is reported as exactly what it is.
//
// Everything here is derived from the rows the pipeline produced — the
// trace, the sources, the second opinion. Nothing is entered by hand and
// nothing is a judgement call: each check names what it looked at.
// ============================================================

import type { BbsRow } from '../src/cad/bbs/types';

export type CalculationStatus = 'DRAFT' | 'CALCULATING' | 'CALCULATED' | 'STALE' | 'REBUILDING' | 'ERROR';
export type EngineeringValidation = 'UNVALIDATED' | 'PARTIALLY_VALIDATED' | 'VALIDATED' | 'REJECTED';

export interface ValidationCheck {
  /** what was checked, in the schedule's words ("cover resolved") */
  name: string;
  ok: boolean;
  /**
   * blocking  — the row is not an answer without it (no length, no count)
   * assumed   — the row computed on an assumption a person must confirm
   * rejecting — the row computed and the check says the number is wrong
   */
  severity: 'blocking' | 'assumed' | 'rejecting';
  note?: string;
}

export interface RowValidation {
  barMark: string;
  status: EngineeringValidation;
  checks: ValidationCheck[];
  /** the assumptions this row rests on, each named */
  assumed: string[];
  /** what the row is waiting on */
  unresolved: string[];
}

export interface ScheduleValidation {
  status: EngineeringValidation;
  /** the whole schedule can be relied on as it stands */
  final: boolean;
  /** why it is not final, when it is not — one line per reason */
  blockers: string[];
  counts: {
    rows: number;
    /** rows that reached a weight */
    calculated: number;
    /** rows that did not */
    open: number;
    validated: number;
    partiallyValidated: number;
    rejected: number;
    unvalidated: number;
    /** distinct assumptions across the schedule */
    assumedInputs: number;
    /** rows on which a validation check did not pass */
    warnings: number;
    /** rows where two readings or derivations disagree and nobody has settled it */
    mismatches: number;
    /** distinct required facts still missing */
    missingFacts: number;
  };
  rows: RowValidation[];
  /** the distinct assumptions, so the schedule can list them once */
  assumptions: string[];
  /** the headline a filed artifact carries — INCOMPLETE until every gate passes */
  label: 'FINAL' | 'INCOMPLETE';
  /**
   * EVERY GATE, BY NAME. Calculated is not final: a schedule may compute
   * every row and still fail on a mismatch nobody settled, a drawing that
   * moved on, or an input with no provenance. The list is the contract, so a
   * reader sees which condition held it back rather than a bare "incomplete".
   */
  gates: FinalGate[];
}

export interface FinalGate {
  name: string;
  ok: boolean;
  detail?: string;
}

const ASSUMED_SOURCE = /^(ASSUMED|PROJECT_DEFAULT|DEFAULT)\b/i;

/** Validate one row from what it carries. Pure. */
export function validateRow(row: BbsRow): RowValidation {
  const checks: ValidationCheck[] = [];
  const assumed: string[] = [];
  const unresolved: string[] = [];
  const trace = row.trace;

  const dimsOk = trace ? trace.failedStage !== 'GEOMETRY_RESOLVED' : row.cuttingLengthMm !== null;
  checks.push({
    name: 'required drawing facts resolved',
    ok: dimsOk,
    severity: 'blocking',
    note: dimsOk ? undefined : trace?.reason ?? row.missing,
  });
  if (!dimsOk && trace?.missingFact) unresolved.push(trace.missingFact);

  for (const [axis, src] of Object.entries(trace?.dimSources ?? {})) {
    if (typeof src === 'string' && ASSUMED_SOURCE.test(src)) assumed.push(`${row.memberMark}.${axis} — ${src}`);
  }

  const calloutOk = typeof row.fromCallout === 'string' && row.fromCallout.trim().length > 0 && row.diaMm > 0;
  checks.push({ name: 'reinforcement callout read', ok: calloutOk, severity: 'blocking' });

  const countOk = typeof row.memberCount === 'number' && row.memberCount > 0;
  checks.push({
    name: 'member count established',
    ok: countOk,
    severity: 'blocking',
    note: countOk ? undefined : `${row.memberMark}.count is not on record`,
  });
  if (!countOk) unresolved.push(`${row.memberMark}.count`);

  const coverStatus = row.coverStatus ?? trace?.coverStatus;
  const coverOk = coverStatus !== 'ASSUMED' && row.coverAssumption !== 'BLOCKED';
  checks.push({
    name: 'cover resolved',
    ok: coverOk,
    severity: row.coverAssumption === 'BLOCKED' ? 'blocking' : 'assumed',
    note: coverOk ? `${coverStatus ?? ''} ${row.coverMm ?? ''} mm`.trim() : `cover ${row.coverMm ?? '?'} mm is ${coverStatus ?? 'unresolved'}`,
  });
  if (!coverOk && coverStatus === 'ASSUMED') assumed.push(`cover ${row.coverMm} mm — ${row.coverSource ?? 'project default'}`);
  if (row.coverAssumption === 'BLOCKED') unresolved.push('settings.cover');

  const lengthOk = typeof row.cuttingLengthMm === 'number' && row.cuttingLengthMm > 0 && row.lengthSource !== 'UNAVAILABLE';
  checks.push({
    name: 'cutting length established',
    ok: lengthOk,
    severity: 'blocking',
    note: lengthOk ? row.lengthSource : row.missing,
  });

  const qtyOk = typeof row.barsPerMember === 'number' && row.barsPerMember > 0 && typeof row.totalBars === 'number' && row.totalBars > 0;
  checks.push({ name: 'quantity established', ok: qtyOk, severity: 'blocking' });

  const weightOk = typeof row.weightKg === 'number' && row.weightKg > 0;
  checks.push({ name: 'weight computed', ok: weightOk, severity: 'blocking' });

  if (row.secondOpinion) {
    const so = row.secondOpinion;
    checks.push({
      name: 'second opinion within tolerance',
      ok: so.withinTolerance,
      severity: 'rejecting',
      note: `${so.lengthMm.toFixed(0)} mm independent vs ${so.primaryMm.toFixed(0)} mm primary — diff ${so.diffMm.toFixed(0)} mm, tolerance ${so.toleranceMm.toFixed(0)} mm`,
    });
  }

  if (trace?.method.unitWeight === 'DENSITY_FALLBACK') {
    assumed.push(`unit weight of ${row.diaMm} mm bar from density (not IS 1786 nominal mass)`);
  }

  const blocking = checks.some((c) => !c.ok && c.severity === 'blocking');
  const rejecting = checks.some((c) => !c.ok && c.severity === 'rejecting');
  const assumedAny = assumed.length > 0 || checks.some((c) => !c.ok && c.severity === 'assumed');
  const status: EngineeringValidation = blocking
    ? 'UNVALIDATED'
    : rejecting
      ? 'REJECTED'
      : assumedAny
        ? 'PARTIALLY_VALIDATED'
        : 'VALIDATED';
  return { barMark: row.barMark, status, checks, assumed: [...new Set(assumed)], unresolved: [...new Set(unresolved)] };
}

export interface ValidateScheduleOptions {
  /** the drawing this was built from still hashes the same */
  drawingHashMatches?: boolean;
  /** any dependency fact has changed since the build */
  stale?: boolean;
  /** the summary reconciles with the rows */
  reconciliationOk?: boolean;
  /** the referee's gates passed */
  verificationOk?: boolean;
  /** rows-vs-recompute drift was found */
  driftRows?: readonly string[];
  /** questions still open against this schedule */
  openDependencies?: readonly string[];
  /**
   * A DISPUTE the schedule itself carries: a sanity check that says steel is
   * missing, an independent verifier that rejects a count, a reading two
   * sources disagree on. Every row can compute and the arithmetic still be
   * built on something a person has to settle — so a dispute blocks FINAL
   * until somebody says they have checked it.
   */
  disputes?: readonly string[];
}

/** Validate the schedule from its rows and the state around it. Pure. */
export function validateSchedule(rows: readonly BbsRow[], opts: ValidateScheduleOptions = {}): ScheduleValidation {
  const perRow = rows.map(validateRow);
  const count = (s: EngineeringValidation): number => perRow.filter((r) => r.status === s).length;
  const calculated = rows.filter((r) => typeof r.weightKg === 'number').length;
  const assumptions = [...new Set(perRow.flatMap((r) => r.assumed))];
  const blockers: string[] = [];

  const validated = count('VALIDATED');
  const rejected = count('REJECTED');
  const partially = count('PARTIALLY_VALIDATED');
  const unvalidated = count('UNVALIDATED');

  if (rows.length === 0) blockers.push('no rows');
  if (unvalidated) blockers.push(`${unvalidated} row(s) unresolved: ${perRow.filter((r) => r.status === 'UNVALIDATED').map((r) => r.barMark).join(', ')}`);
  if (rejected) blockers.push(`${rejected} row(s) rejected by the second opinion: ${perRow.filter((r) => r.status === 'REJECTED').map((r) => r.barMark).join(', ')}`);
  if (partially) blockers.push(`${partially} row(s) rest on an assumption: ${assumptions.join('; ')}`);
  if (opts.stale) blockers.push('a dependency fact changed since this was built');
  if (opts.drawingHashMatches === false) blockers.push('the drawing changed since this was built');
  if (opts.reconciliationOk === false) blockers.push('the steel summary does not reconcile with the rows');
  if (opts.verificationOk === false) blockers.push('a verification gate failed');
  if (opts.driftRows?.length) blockers.push(`DRIFT — stored and recalculated values differ on: ${opts.driftRows.join(', ')}`);
  if (opts.openDependencies?.length) blockers.push(`open dependencies: ${opts.openDependencies.join(', ')}`);
  for (const dispute of opts.disputes ?? []) blockers.push(`UNRESOLVED — ${dispute}`);

  const mismatched = perRow.filter((r) => r.checks.some((c) => !c.ok && c.severity === 'rejecting'));
  const missingFacts = [...new Set(perRow.flatMap((r) => r.unresolved))];
  // A computed number a reader cannot trace is not an engineering answer.
  const withoutProvenance = rows.filter(
    (r) => typeof r.weightKg === 'number' && !(r.trace && r.trace.factsUsed.length > 0 && r.trace.sourceText),
  );
  if (withoutProvenance.length) {
    blockers.push(
      `${withoutProvenance.length} computed row(s) carry no provenance: ${withoutProvenance.map((r) => r.barMark).join(', ')}`,
    );
  }

  const noneOr = (list: readonly string[]): string => (list.length ? list.join(', ') : 'none');
  const openLengths = rows.filter((r) => !(typeof r.cuttingLengthMm === 'number' && r.cuttingLengthMm > 0));
  const openGeometry = rows.filter((r) => r.trace?.failedStage === 'GEOMETRY_RESOLVED');
  const gates: FinalGate[] = [
    { name: 'required rows complete', ok: rows.length > 0 && calculated === rows.length, detail: `${calculated}/${rows.length} calculated` },
    { name: 'blocked rows = 0', ok: unvalidated === 0, detail: `${unvalidated} blocked` },
    { name: 'required missing facts = 0', ok: missingFacts.length === 0, detail: noneOr(missingFacts) },
    { name: 'critical mismatches = 0', ok: mismatched.length === 0, detail: noneOr(mismatched.map((r) => r.barMark)) },
    { name: 'unresolved geometry = 0', ok: openGeometry.length === 0, detail: noneOr(openGeometry.map((r) => r.barMark)) },
    { name: 'unresolved cutting lengths = 0', ok: openLengths.length === 0, detail: noneOr(openLengths.map((r) => r.barMark)) },
    { name: 'quantity validated', ok: rows.every((r) => typeof r.totalBars === 'number' && r.totalBars > 0) },
    {
      name: 'cutting length validated',
      ok: perRow.every(
        (r) =>
          r.checks.find((c) => c.name === 'cutting length established')?.ok === true &&
          r.checks.find((c) => c.name === 'second opinion within tolerance')?.ok !== false,
      ),
    },
    { name: 'weight calculated', ok: rows.every((r) => typeof r.weightKg === 'number' && r.weightKg > 0) },
    { name: 'steel summary reconciled', ok: opts.reconciliationOk !== false, detail: opts.reconciliationOk === false ? 'the summary differs from the sum of the rows' : undefined },
    {
      name: 'drawing revision/hash current',
      ok: opts.drawingHashMatches !== false && !opts.stale,
      detail:
        opts.drawingHashMatches === false
          ? 'the drawing changed since this was computed'
          : opts.stale
            ? 'a dependency changed since this was computed'
            : undefined,
    },
    { name: 'provenance present for every input', ok: withoutProvenance.length === 0, detail: noneOr(withoutProvenance.map((r) => r.barMark)) },
    { name: 'no assumed input', ok: assumptions.length === 0, detail: assumptions.length ? assumptions.join('; ') : 'none' },
    { name: 'no open dependency', ok: !opts.openDependencies?.length, detail: noneOr(opts.openDependencies ?? []) },
    { name: 'no drift from stored rows', ok: !opts.driftRows?.length, detail: noneOr(opts.driftRows ?? []) },
    {
      name: 'no unresolved dispute',
      ok: !opts.disputes?.length,
      detail: opts.disputes?.length ? `${opts.disputes.length} unresolved: ${opts.disputes[0].slice(0, 90)}…` : 'none',
    },
  ];

  const status: EngineeringValidation =
    rows.length === 0
      ? 'UNVALIDATED'
      : rejected
        ? 'REJECTED'
        : validated === rows.length && !opts.stale && opts.drawingHashMatches !== false
          ? 'VALIDATED'
          : calculated > 0
            ? 'PARTIALLY_VALIDATED'
            : 'UNVALIDATED';

  // FINAL is the conjunction of every gate. A schedule that computed all its
  // rows but failed one of them is INCOMPLETE, and says which.
  const final = blockers.length === 0 && gates.every((g) => g.ok);
  return {
    status,
    final,
    label: final ? 'FINAL' : 'INCOMPLETE',
    gates,
    blockers,
    counts: {
      rows: rows.length,
      calculated,
      open: rows.length - calculated,
      validated,
      partiallyValidated: partially,
      rejected,
      unvalidated,
      assumedInputs: assumptions.length,
      // a validation warning is a check that did not pass — informational notes are not counted
      warnings: perRow.filter((r) => r.checks.some((c) => !c.ok)).length,
      mismatches: mismatched.length,
      missingFacts: missingFacts.length,
    },
    rows: perRow,
    assumptions,
  };
}

/** The calculation status of a built result, from the run's own state. */
export function calculationStatusOf(input: {
  built: boolean;
  error?: boolean;
  stale?: boolean;
  rebuilding?: boolean;
  calculating?: boolean;
}): CalculationStatus {
  if (input.error) return 'ERROR';
  if (input.rebuilding) return 'REBUILDING';
  if (input.calculating) return 'CALCULATING';
  if (!input.built) return 'DRAFT';
  if (input.stale) return 'STALE';
  return 'CALCULATED';
}
