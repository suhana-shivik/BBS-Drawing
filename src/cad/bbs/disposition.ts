// ============================================================
// Schedule disposition — what a declared element IS.
//
// A drawing declares many things by name and size. A bar bending schedule
// concerns exactly one of those categories, and the sheet never says which is
// which:
//
//     TB-(350X400)              reinforced concrete   → schedule it
//     200 THK. RCC WALL         reinforced concrete   → schedule it
//     PRECAST PANEL (2000x300x50thk)  a bought product → do NOT schedule it
//     H-POLE (150X150X2400)     a bought product      → do NOT schedule it
//
// Treating every declaration as reinforced concrete puts imaginary steel in a
// panel that arrives on a lorry. Treating none of them as concrete loses real
// members. Both failures are silent, which is why disposition is an explicit,
// required, evidence-backed classification rather than a guess from the name.
//
// AND IT IS NOT A FILTER. An excluded element stays on the record with the
// evidence that excluded it, because "we saw the H-poles and they are a supply
// item" and "we never noticed the H-poles" must not look the same to a
// reviewer. Coverage checks that every declaration got a verdict — not that
// the schedule is short.
// ============================================================
import type { DeclaredMember } from './types';

export type ScheduleDisposition =
  /** cast on site with bars in it — the only kind a BBS schedules */
  | { kind: 'reinforced-concrete'; evidenceIds: string[] }
  /** arrives finished; its steel is the supplier's, not this schedule's */
  | { kind: 'precast-product'; evidenceIds: string[] }
  /** rolled sections, not bars */
  | { kind: 'structural-steel'; evidenceIds: string[] }
  /** drawn for context — a level, a ground line, an adjacent structure */
  | { kind: 'reference-only'; evidenceIds: string[] }
  /** not classified. A gap, and then a question — never an assumption. */
  | { kind: 'unknown'; reason: string };

/** the dispositions whose members carry bars this schedule must compute */
export const SCHEDULED_KINDS: ReadonlySet<ScheduleDisposition['kind']> = new Set([
  'reinforced-concrete',
]);

export function isScheduled(d: ScheduleDisposition | undefined): boolean {
  return !!d && SCHEDULED_KINDS.has(d.kind);
}

export interface DispositionEntry {
  /** the declared name, verbatim as the sheet wrote it */
  name: string;
  disposition: ScheduleDisposition;
}

export interface CoverageGap {
  name: string;
  reason: string;
}

export interface DispositionCoverage {
  ok: boolean;
  /** declarations with no verdict at all */
  unclassified: CoverageGap[];
  /** classified as scheduled, but nothing was interpreted for them */
  scheduledButAbsent: CoverageGap[];
  /** deliberately excluded, with the evidence — shown, never hidden */
  excluded: DispositionEntry[];
}

/**
 * Every declared element must have a verdict, and every element whose verdict
 * is "reinforced concrete" must have arrived in the interpretation.
 *
 * The second half is the one that catches real loss: a member classified as
 * concrete and then quietly not scheduled is steel that vanished between two
 * correct-looking stages.
 */
export function checkDispositionCoverage(
  // Only the NAME is read here. Asking for a whole DeclaredMember would force
  // every caller to carry a size, a dimension list and handles it does not
  // have — which is what the `as never` at the verify.ts call site was hiding.
  declared: readonly { name: string }[],
  dispositions: readonly DispositionEntry[],
  interpretedMarks: readonly string[],
): DispositionCoverage {
  const norm = (s: string): string => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const byName = new Map(dispositions.map((d) => [norm(d.name), d]));
  const marks = new Set(interpretedMarks.map(norm));

  const unclassified: CoverageGap[] = [];
  const scheduledButAbsent: CoverageGap[] = [];
  const excluded: DispositionEntry[] = [];
  const seen = new Set<string>();

  for (const d of declared) {
    const key = norm(d.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = byName.get(key);
    if (!hit || hit.disposition.kind === 'unknown') {
      unclassified.push({
        name: d.name,
        reason:
          hit?.disposition.kind === 'unknown'
            ? (hit.disposition as { reason: string }).reason
            : 'the sheet declares it, and nothing has said what kind of element it is',
      });
      continue;
    }
    if (isScheduled(hit.disposition)) {
      if (!marks.has(key)) {
        scheduledButAbsent.push({
          name: d.name,
          reason:
            'classified as reinforced concrete but absent from the interpretation — its bars ' +
            'would be missing from the schedule entirely',
        });
      }
    } else {
      excluded.push(hit);
    }
  }

  return {
    ok: unclassified.length === 0 && scheduledButAbsent.length === 0,
    unclassified,
    scheduledButAbsent,
    excluded,
  };
}
