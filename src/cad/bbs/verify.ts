// ============================================================
// The verification protocol — the gates that decide "done".
//
// COMPLETION IS NOT THE MODEL'S CALL. A model reporting that it has finished is
// reporting its own confidence, and confidence is the one quantity that was
// wrong in every failure this project has recorded. Done means: every gate
// below is silent.
//
// EACH GATE IS DETERMINISTIC AND INDEPENDENT. They are ordered cheapest-first
// so a schema violation is not diagnosed by arithmetic, but none depends on
// another passing — a run can fail five gates and be told about all five.
//
// A FAILURE NAMES A FIELD, NEVER A TARGET. The referee in particular must say
// "these members have no resolved height" and never "the total should be
// nearer X". A model steered toward a stated number closes the gap by
// mis-pointing, which is invention wearing a plausibility score.
// ============================================================
import type { BbsResult, BbsInterpretation, BbsMember, BbsRow } from './types';
import type { EvidenceGraph } from './evidence';
import type { MemberPlacement, UnverifiedExtent } from './placement';
import type { ScheduleDisposition } from './disposition';
import { checkDispositionCoverage, isScheduled, type DispositionEntry } from './disposition';
import { UNIT_WEIGHT_KG_PER_M } from '../../domain/india/bbs';

// v1: hoisted from the legacy orchestrator (not ported) — this is its home now.
export interface VerificationFailure {
  /** which gate rejected it — schema, provenance, geometry, coverage, … */
  gate: string;
  /** the exact field at fault, so a repair can be aimed at it */
  field?: string;
  memberMark?: string;
  message: string;
  /** evidence a repair should be shown */
  evidenceIds?: string[];
}

export interface VerifyInput {
  interpretation: BbsInterpretation;
  result?: BbsResult;
  graph?: EvidenceGraph;
  /** placements as resolved, by member mark */
  placements?: ReadonlyMap<
    string,
    {
      ok: boolean;
      count?: number;
      continuous?: boolean;
      reason?: string;
      /** the drawn layout was taken as the whole job with no run to check it */
      unverifiedExtent?: UnverifiedExtent;
    }
  >;
  dispositions?: readonly DispositionEntry[];
  declared?: readonly { name: string }[];
  /** every reinforcement callout the extractor parsed, verbatim */
  parsedCallouts?: readonly string[];
  /** callouts deliberately not assigned, with the reason */
  excludedCallouts?: readonly { callout: string; reason: string }[];
  /** the run, when one was given */
  runMm?: number;
}

export type Gate =
  | 'schema'
  | 'provenance'
  | 'geometry'
  | 'coverage'
  | 'completeness'
  | 'bands'
  | 'arithmetic'
  | 'placement'
  | 'extent'
  | 'anchorage'
  | 'referee';

const fail = (
  gate: Gate,
  message: string,
  over: Partial<VerificationFailure> = {},
): VerificationFailure => ({ gate, message, ...over });

// ------------------------------------------------------------
// A. schema
// ------------------------------------------------------------

/** fields the engine owns; a model that returns one has invented a number */
const ENGINE_OWNED = [
  'cuttingLength',
  'cuttingLengthMm',
  'totalLength',
  'totalLengthM',
  'totalBars',
  'barCount',
  'weight',
  'weightKg',
  'unitWeight',
  'developmentLength',
  'ldMm',
  'lapLength',
  'lapMm',
];

export function gateSchema(input: VerifyInput): VerificationFailure[] {
  const out: VerificationFailure[] = [];
  const { members, bars } = input.interpretation;

  for (const m of members) {
    const raw = m as unknown as Record<string, unknown>;
    for (const field of ENGINE_OWNED) {
      if (raw[field] !== undefined && raw[field] !== null) {
        out.push(
          fail('schema', `${m.mark}.${field} is computed by the engine and must not be supplied`, {
            memberMark: m.mark,
            field,
          }),
        );
      }
    }
    // A count of 1 is only legal as an assertion. Reaching here as a bare
    // number with no placement means something defaulted, which is the single
    // largest error this project has measured.
    const placement = (raw.placement ?? undefined) as MemberPlacement | undefined;
    if (!placement) {
      out.push(
        fail('schema', `${m.mark} has no placement — a count cannot follow from nothing`, {
          memberMark: m.mark,
          field: 'placement',
        }),
      );
    }
  }

  for (const b of bars) {
    if (!b.memberMark) {
      out.push(fail('schema', `a ${b.diaMm} bar from "${b.fromCallout}" names no member`));
    }
    if (!(Number(b.diaMm) > 0)) {
      out.push(
        fail('schema', `a bar from "${b.fromCallout}" has no usable diameter`, {
          memberMark: b.memberMark,
          field: 'diaMm',
        }),
      );
    }
  }
  return out;
}

// ------------------------------------------------------------
// B. provenance
// ------------------------------------------------------------

export function gateProvenance(input: VerifyInput): VerificationFailure[] {
  const out: VerificationFailure[] = [];
  const graph = input.graph;
  if (!graph) return out;

  for (const m of input.interpretation.members) {
    const raw = m as unknown as Record<string, unknown>;
    const dims = raw.dims as Record<string, unknown> | undefined;
    if (!dims) continue;
    for (const [axis, ref] of Object.entries(dims)) {
      if (!ref || typeof ref !== 'object') continue;
      const ids = collectEvidenceIds(ref as Record<string, unknown>);
      for (const id of ids) {
        if (!graph.byId.has(id)) {
          out.push(
            fail('provenance', `${m.mark}.${axis} points at ${id}, which is not evidence on this sheet`, {
              memberMark: m.mark,
              field: axis,
              evidenceIds: [id],
            }),
          );
        }
      }
    }
  }
  return out;
}

function collectEvidenceIds(ref: Record<string, unknown>, acc: string[] = []): string[] {
  if (typeof ref.evidenceId === 'string') acc.push(ref.evidenceId);
  for (const key of ['a', 'b']) {
    const side = ref[key];
    if (side && typeof side === 'object') collectEvidenceIds(side as Record<string, unknown>, acc);
  }
  const segs = ref.segmentEvidenceIds;
  if (Array.isArray(segs)) for (const s of segs) if (typeof s === 'string') acc.push(s);
  return acc;
}

// ------------------------------------------------------------
// D. coverage
// ------------------------------------------------------------

export function gateCoverage(input: VerifyInput): VerificationFailure[] {
  const out: VerificationFailure[] = [];
  const { members, bars } = input.interpretation;

  // every declared element has a verdict
  if (input.declared && input.dispositions) {
    const cov = checkDispositionCoverage(
      input.declared as never,
      input.dispositions,
      members.map((m) => m.mark),
    );
    for (const g of cov.unclassified) {
      out.push(
        fail('coverage', `"${g.name}" is declared on the sheet but has no schedule disposition — ${g.reason}`, {
          memberMark: g.name,
          field: 'disposition',
        }),
      );
    }
    for (const g of cov.scheduledButAbsent) {
      out.push(fail('coverage', `"${g.name}": ${g.reason}`, { memberMark: g.name }));
    }
  }

  // every parsed callout is assigned or explicitly excluded
  if (input.parsedCallouts) {
    const assigned = new Set(bars.map((b) => b.fromCallout.trim()).filter(Boolean));
    const excluded = new Set((input.excludedCallouts ?? []).map((e) => e.callout.trim()));
    for (const c of input.parsedCallouts) {
      const t = c.trim();
      if (!t || assigned.has(t) || excluded.has(t)) continue;
      out.push(
        fail(
          'coverage',
          `the callout ${JSON.stringify(t)} was read off the drawing but is neither assigned to a ` +
            'member nor explicitly excluded — its steel is simply missing',
          { field: 'callout' },
        ),
      );
    }
  }

  // every scheduled member carries at least one bar
  const withBars = new Set(bars.map((b) => b.memberMark));
  const dispByName = new Map((input.dispositions ?? []).map((d) => [d.name, d.disposition]));
  for (const m of members) {
    const d = dispByName.get(m.mark);
    if (d && !isScheduled(d)) continue;
    if (!withBars.has(m.mark)) {
      out.push(
        fail('coverage', `${m.mark} is scheduled as reinforced concrete but has no bars assigned`, {
          memberMark: m.mark,
        }),
      );
    }
  }
  return out;
}

// ------------------------------------------------------------
// E. completeness — derived from what the bars need
// ------------------------------------------------------------

/** which member axes a bar's own behaviour requires */
export function requiredAxes(barType: string, distributionAxis?: string): ('L' | 'W' | 'H')[] {
  const t = barType.toUpperCase();
  if (t === 'STIRRUP' || t === 'TIE' || t === 'RING') {
    // a link needs the cross-section it wraps, plus the axis it marches along
    //
    // THE THIRD LOOKUP OF THIS SHAPE, AND THE THIRD TO NEED GUARDING. `??` only
    // catches null and undefined, so an empty-string axis reached `perp['']`,
    // came back undefined, and the spread threw "not iterable" — the same
    // failure as Run 009's `names[0]`, in a different file. An axis that is not
    // one of the three falls back to the default rather than exploding; the
    // boundary in contract.ts is what stops a wrong axis being asserted at all.
    const stated = distributionAxis as 'L' | 'W' | 'H' | undefined;
    const perp = { L: ['W', 'H'], W: ['L', 'H'], H: ['L', 'W'] } as const;
    const along = stated && perp[stated] ? stated : 'L';
    return [...perp[along], along] as ('L' | 'W' | 'H')[];
  }
  if (t === 'MAIN' || t === 'CRANK') return ['H'];
  if (t === 'DISTRIBUTION' || t === 'TOP' || t === 'BOTTOM' || t === 'CROSS') {
    return distributionAxis ? ['L', 'W'] : ['L'];
  }
  return ['L'];
}

export function gateCompleteness(input: VerifyInput): VerificationFailure[] {
  const out: VerificationFailure[] = [];
  const byMark = new Map(input.interpretation.members.map((m) => [m.mark, m]));
  const AXIS_FIELD = { L: 'lengthMm', W: 'widthMm', H: 'heightMm' } as const;

  for (const bar of input.interpretation.bars) {
    const m = byMark.get(bar.memberMark);
    if (!m) continue;
    for (const axis of requiredAxes(bar.barType, bar.distributionAxis)) {
      const v = m[AXIS_FIELD[axis]];
      if (typeof v !== 'number' || !(v > 0)) {
        out.push(
          fail(
            'completeness',
            `${m.mark} carries a ${bar.barType.toLowerCase()} from "${bar.fromCallout}", which ` +
              `needs ${axis} — and ${axis} is not resolved. The row cannot be computed.`,
            { memberMark: m.mark, field: axis },
          ),
        );
      }
    }
  }
  // dedupe: one member missing H with eight bars is one problem, not eight
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.memberMark}.${f.field}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ------------------------------------------------------------
// G. arithmetic — recomputed independently
// ------------------------------------------------------------

/**
 * One reader for every numeric field on a row.
 *
 * `BbsRow` types its computed fields `number | null`, and null is CORRECT for a
 * row the engine could not compute. The gate read them as `number | undefined`,
 * so `null !== undefined` passed the guard and `Math.abs(nominal - null)`
 * became `Math.abs(nominal)` — larger than any tolerance. Every unavailable row
 * was then reported as a unit-weight error: 98 false failures in one run,
 * enough to bury the real ones.
 */
const cell = (row: unknown, field: string): number | null => {
  const v = (row as Record<string, unknown>)[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/**
 * The same run, counted more than once.
 *
 * A bar cut to the length of the run IS the run: the engine measures a
 * longitudinal bar on a linear member as `run + a lap per stock length`. So a
 * row whose cutting length reaches the run, on a member counted 24 times, is
 * 24 copies of the same hundred metres. One live run priced a tie beam that
 * way and produced 78 tonnes on one member — 80 t all told, on a wall whose
 * whole schedule is a few tonnes — and every other gate passed, because each
 * row was internally consistent and the member count was a legal number.
 *
 * THIS IS ARITHMETIC, NOT JUDGEMENT. It reads two figures off the row the
 * engine already computed and observes that their product spans the job many
 * times over. It says nothing about what a tie beam is, how one should be
 * placed, or what any total ought to be — a member that genuinely repeats
 * carries bars measured across its own section, not across the run, and is
 * never mentioned here.
 */
export function gateRunCountedTwice(input: VerifyInput): VerificationFailure[] {
  const result = input.result;
  const runMm = input.runMm;
  if (!result || !runMm || !(runMm > 0)) return [];

  const out: VerificationFailure[] = [];
  const seen = new Set<string>();
  for (const row of result.rows as BbsRow[]) {
    const cut = cell(row, 'cuttingLengthMm');
    const members = cell(row, 'memberCount');
    if (cut === null || members === null || members <= 1) continue;
    // the bar spans the job — allow for the laps the engine folds into the cut
    if (cut < runMm * 0.95) continue;
    if (seen.has(row.memberMark)) continue;
    seen.add(row.memberMark);
    out.push(
      fail(
        'arithmetic',
        `${row.memberMark}: ${row.barMark} is cut ${Math.round(cut)} mm, which is the ${runMm} mm run itself, ` +
          `and it is then multiplied by ${members} ${row.memberMark}s — so the same run is scheduled ` +
          `${members} times over. A member whose bars are measured ALONG the run exists once along it; ` +
          `if ${row.memberMark} really does repeat, its bars are the ones that repeat, not the run.`,
        { memberMark: row.memberMark, field: 'memberCount' },
      ),
    );
  }
  return out;
}

export function gateArithmetic(input: VerifyInput): VerificationFailure[] {
  const out: VerificationFailure[] = [];
  const result = input.result;
  if (!result) return out;

  for (const row of result.rows as BbsRow[]) {
    const cut = cell(row, 'cuttingLengthMm');

    // A row with no cutting length is UNAVAILABLE by design — the engine said
    // so. There is no arithmetic on it to verify, and objecting here reports a
    // missing dimension as a maths error. Completeness owns that gap.
    if (cut === null) continue;

    const perMember = cell(row, 'barsPerMember');
    const members = cell(row, 'memberCount');
    const total = cell(row, 'totalBars');
    const lenM = cell(row, 'totalLengthM');
    const unit = cell(row, 'unitWeightKgPerM');
    const kg = cell(row, 'weightKg');
    const dia = Number(row.diaMm);

    // Recomputed from INPUTS, never read back from a field that might be stale.
    if (perMember !== null && members !== null) {
      const expect = perMember * members;
      if (total === null || expect !== total) {
        out.push(
          fail('arithmetic', `${row.barMark}: ${perMember} × ${members} = ${expect}, but totalBars is ${total ?? 'null'}`, {
            memberMark: row.memberMark,
            field: 'totalBars',
          }),
        );
      }
    }

    if (total !== null) {
      const expect = (cut * total) / 1000;
      if (lenM === null || Math.abs(expect - lenM) > Math.max(0.01, expect * 0.001)) {
        out.push(
          fail(
            'arithmetic',
            `${row.barMark}: ${cut} mm × ${total} = ${expect.toFixed(2)} m, but totalLengthM is ${lenM ?? 'null'}`,
            { memberMark: row.memberMark, field: 'totalLengthM' },
          ),
        );
      }
    }

    const nominal = (UNIT_WEIGHT_KG_PER_M as Record<number, number>)[dia];
    if (nominal !== undefined && unit !== null && Math.abs(nominal - unit) > 1e-6) {
      out.push(
        fail('arithmetic', `${row.barMark}: T${dia} unit weight is ${unit}, but IS 1786 nominal is ${nominal}`, {
          memberMark: row.memberMark,
          field: 'unitWeightKgPerM',
        }),
      );
    }

    // weight recomputed from the nominal mass, so a wrong unit weight cannot
    // hide behind an internally-consistent row
    const basis = nominal ?? unit;
    if (lenM !== null && basis !== null && basis !== undefined) {
      const expect = lenM * basis;
      if (kg === null || Math.abs(expect - kg) > Math.max(0.01, expect * 0.001)) {
        out.push(
          fail('arithmetic', `${row.barMark}: ${lenM.toFixed(2)} m × ${basis} = ${expect.toFixed(2)} kg, but weightKg is ${kg ?? 'null'}`, {
            memberMark: row.memberMark,
            field: 'weightKg',
          }),
        );
      }
    }
  }

  // the diameter summary must reconcile with the rows it summarises
  const byDia = new Map<number, number>();
  for (const row of result.rows as BbsRow[]) {
    const kg = cell(row, 'weightKg') ?? 0;
    byDia.set(Number(row.diaMm), (byDia.get(Number(row.diaMm)) ?? 0) + kg);
  }
  for (const line of result.summary) {
    const rows = byDia.get(line.diaMm) ?? 0;
    if (Math.abs(rows - line.totalWeightKg) > Math.max(0.05, rows * 0.001)) {
      out.push(
        fail(
          'arithmetic',
          `the T${line.diaMm} summary says ${line.totalWeightKg.toFixed(1)} kg but its rows total ` +
            `${rows.toFixed(1)} kg`,
          { field: `summary.T${line.diaMm}` },
        ),
      );
    }
  }
  return out;
}

// ------------------------------------------------------------
// H. placement
// ------------------------------------------------------------

export function gatePlacement(input: VerifyInput): VerificationFailure[] {
  const out: VerificationFailure[] = [];
  if (!input.placements) return out;
  for (const [mark, p] of input.placements) {
    if (!p.ok) {
      out.push(
        fail('placement', `${mark}: placement did not resolve — ${p.reason ?? 'no reason given'}`, {
          memberMark: mark,
          field: 'placement',
        }),
      );
      continue;
    }
    if (p.continuous) continue;
    if (p.count === undefined || !Number.isFinite(p.count)) {
      out.push(
        fail('placement', `${mark}: placement resolved but produced no count`, {
          memberMark: mark,
          field: 'placement',
        }),
      );
    }
  }
  return out;
}

// ------------------------------------------------------------
// H2. extent — a quantity is detail × extent, and this gate owns the second half
// ------------------------------------------------------------

/**
 * THE DRAWN LAYOUT WAS TAKEN AS THE WHOLE JOB, AND NOTHING SAID IT WAS.
 *
 * Every other gate here inspects DETAIL: the section, the spacing, the shape,
 * the arithmetic that turns them into a weight. All of it can be perfect and
 * the schedule still be a quarter of the job, because a quantity is
 * `detail × extent` and the extent lives on a different drawing.
 *
 * A structural sheet routinely carries every detail fact and not one extent
 * fact — this one's own General Notes say to read the architectural drawings —
 * so "no run was supplied" is the NORMAL state of the input, not an error. What
 * is an error is computing a whole-job schedule from it without saying so.
 *
 * The gate fires on exactly one shape: a run fact is absent, and a member's
 * count came from reading a repeating drawn BAND as the entire structure. It
 * does not fire on a member drawn once, and it does not fire when a run exists
 * — then `placement.ts` has a real comparison to make and makes it.
 *
 * It names the FIELD (`run`) and the question. It states the drawn extent
 * because that is a measured fact about this sheet, and it states no target,
 * no multiple and no total: a reader told how much is missing will find that
 * much, and the way they find it is by claiming something that is not there.
 */
export function gateExtent(input: VerifyInput): VerificationFailure[] {
  if (input.runMm !== undefined && input.runMm > 0) return [];
  if (!input.placements) return [];

  const out: VerificationFailure[] = [];
  for (const [mark, p] of input.placements) {
    const claim = p.unverifiedExtent;
    if (!p.ok || !claim) continue;
    out.push(
      fail(
        'extent',
        `${mark} was counted by reading the drawn layout as the whole job: ${claim.nodes} tags at ` +
          `about ${claim.pitchMm} mm centres, covering ${claim.drawnExtentMm} mm of structure. ` +
          'No run was supplied, so nothing on this sheet or off it establishes that those ' +
          `${claim.drawnExtentMm} mm ARE the job — a repeating band is a module of a longer ` +
          'structure at least as often as it is the whole of a short one, and the two are ' +
          'indistinguishable from the drawing alone. This schedule therefore covers only what is ' +
          `drawn. Answer "${claim.ask}" and every count that depends on it is recomputed.`,
        { memberMark: mark, field: claim.field },
      ),
    );
  }
  return out;
}

// ------------------------------------------------------------
// I. the aggregate referee
// ------------------------------------------------------------

/**
 * Plausible reinforcement intensity, by element class.
 *
 * Domain data, next to the unit weights it belongs with — not a tuning
 * constant. An unknown class is `unverifiable` and produces no objection,
 * which is the safe behaviour: a referee that objects to everything it does
 * not recognise trains people to ignore it.
 */
export const KG_PER_M_BANDS: Readonly<Record<string, [number, number]>> = {
  'boundary wall': [40, 120],
  wall: [40, 120],
  fence: [15, 60],
};

export interface RefereeInput extends VerifyInput {
  /** what kind of structure this schedule is for, if established */
  structureClass?: string;
}

export function gateReferee(input: RefereeInput): VerificationFailure[] {
  const result = input.result;
  const runMm = input.runMm;
  if (!result || !runMm || !(runMm > 0)) return [];
  const band = input.structureClass ? KG_PER_M_BANDS[input.structureClass.toLowerCase()] : undefined;
  if (!band) return [];

  const kg = result.summary.reduce((n, s) => n + s.totalWeightKg, 0);
  const perM = kg / (runMm / 1000);
  if (perM >= band[0] && perM <= band[1]) return [];

  // Name the DEFICIENT FIELDS. Never the distance to a target — a model told
  // it is 2 t short will find 2 t, and the way it finds them is by pointing at
  // something that is not there.
  const unresolved: string[] = [];
  for (const m of input.interpretation.members as BbsMember[]) {
    const missing: string[] = [];
    if (!(m.heightMm! > 0)) missing.push('H');
    if (!(m.lengthMm! > 0)) missing.push('L');
    if (!(m.widthMm! > 0)) missing.push('W');
    const p = input.placements?.get(m.mark);
    if (p && !p.ok) missing.push('placement');
    if (missing.length) unresolved.push(`${m.mark} (${missing.join(', ')})`);
  }

  return [
    fail(
      'referee',
      `this schedule works out at ${perM.toFixed(1)} kg per metre of ${input.structureClass}, ` +
        `outside the ${band[0]}–${band[1]} kg/m a real one carries. ` +
        (unresolved.length
          ? `Unresolved fields that would account for it: ${unresolved.join('; ')}. Resolve these ` +
            'by pointing at the drawing or by asking — the total is not credible while they stand.'
          : // RESOLVED IS NOT THE SAME AS RIGHT, and saying only the first sent
            // one run hunting for unclaimed callouts while three columns stood
            // 350 mm tall. A field resolved from the wrong dimension passes
            // every gate here and still prices a fraction of the steel.
            'Every field has a value, which is not the same as every value being right. Two things ' +
            'produce this: steel the drawing carries that no member claims, and a dimension resolved ' +
            'from the wrong evidence — check what each member axis was actually pointed at, ' +
            'particularly any that reads like a cross-section where a length or height belongs.'),
      { field: 'total' },
    ),
  ];
}

// ------------------------------------------------------------
// the protocol
// ------------------------------------------------------------

/**
 * The one verdict that survives a broken structure: the total is too HIGH.
 *
 * Deliberately separate from gateReferee, which reports both directions and is
 * rightly silenced when the inputs are incomplete. This asks only the question
 * incompleteness cannot answer away, and names the members carrying the weight
 * rather than a target — the reader has to find the over-claim themselves.
 */
export function aboveBand(input: RefereeInput): VerificationFailure[] {
  const result = input.result;
  const runMm = input.runMm;
  if (!result || !runMm || !(runMm > 0)) return [];
  const band = input.structureClass ? KG_PER_M_BANDS[input.structureClass.toLowerCase()] : undefined;
  if (!band) return [];
  const kg = result.summary.reduce((n, s) => n + s.totalWeightKg, 0);
  const perM = kg / (runMm / 1000);
  if (perM <= band[1]) return [];

  const byMember = new Map<string, number>();
  for (const row of result.rows as BbsRow[]) {
    const w = typeof row.weightKg === 'number' ? row.weightKg : 0;
    byMember.set(row.memberMark, (byMember.get(row.memberMark) ?? 0) + w);
  }
  const heaviest = [...byMember.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([mark, w]) => `${mark} ${Math.round(w)} kg`);

  return [
    fail(
      'referee',
      `this schedule works out at ${perM.toFixed(0)} kg per metre of ${input.structureClass}, above the ` +
        `${band[0]}–${band[1]} kg/m a real one carries. Fields are still unresolved elsewhere, and that is ` +
        'why this is reported anyway: an unresolved dimension can make a total too SMALL, never too large, ' +
        'so this excess is real whatever else is missing. Carrying the most weight: ' +
        `${heaviest.join(', ')}. Check those members' count and the axis their bars were measured along.`,
      { field: 'total' },
    ),
  ];
}

export type GateStatus = 'pass' | 'fail' | 'blocked' | 'not-applicable';

export interface GateResult {
  gate: Gate;
  status: GateStatus;
  failures: VerificationFailure[];
  /** for `blocked` and `not-applicable`: what stopped it being a verdict */
  because?: string;
}

export interface VerifyReport {
  ok: boolean;
  failures: VerificationFailure[];
  /** gates that ran and found nothing */
  passed: Gate[];
  /** every gate with its real status — pass is not the only good outcome */
  gates: GateResult[];
}

/**
 * Run every gate, and say honestly what each one's verdict is WORTH.
 *
 * Run 002 reported "Passed: provenance, placement, referee" on a schedule where
 * four of fifteen placements resolved, most dimensions were missing, coverage
 * was broken and 29 callouts were owned five times over. Those passes were
 * true statements about gates that had almost nothing to examine, and printing
 * them beside the failures made a broken run look half-successful.
 *
 * A gate whose input was destroyed upstream is BLOCKED, not passed. In
 * particular the referee — which asks only whether kg/m looks plausible — must
 * never return a verdict while members are missing bars or counts, because a
 * plausible aggregate over a fraction of the steel is a coincidence.
 */
// ------------------------------------------------------------
// H. anchorage — a length under its own Ld is a DISPUTED DIMENSION
// ------------------------------------------------------------

const AXIS_WORD = { L: 'length', W: 'width', H: 'height' } as const;

/**
 * A row the engine refused because its cutting length came out under the
 * bar's development length is not a verdict on the callout — it is a
 * question about the member dimension it was measured along. This gate turns
 * that refusal into a failure aimed at the AXIS (`field: 'W'`), which is what
 * `questionsFrom` puts to a person and what a repair re-reads; the message
 * IS the question, with the figure on record and the reason it cannot stand.
 */
export function gateAnchorage(input: VerifyInput): VerificationFailure[] {
  const out: VerificationFailure[] = [];
  const result = input.result;
  if (!result) return out;
  const byMark = new Map(input.interpretation.members.map((m) => [m.mark, m]));
  const seen = new Set<string>();
  for (const row of result.rows as BbsRow[]) {
    const axis = row.disputedAxis;
    if (!axis) continue;
    const key = `${row.memberMark}.${axis}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const member = byMark.get(row.memberMark);
    const held =
      axis === 'L' ? member?.lengthMm : axis === 'W' ? member?.widthMm : member?.heightMm;
    const came = /comes out\s+(-?[\d.]+)\s*mm/i.exec(row.missing ?? '')?.[1];
    const needs = /under the\s+(-?[\d.]+)\s*mm development length/i.exec(row.missing ?? '')?.[1];
    out.push(
      fail(
        'anchorage',
        `${row.memberMark} ${AXIS_WORD[axis]} is on record as ${typeof held === 'number' ? `${held} mm` : 'a value'}` +
          `${member?.dimSources?.[axis] ? ` (${member.dimSources[axis]})` : ''}, but a T${row.diaMm} bar measured along it ` +
          `comes out ${came ? `${came} mm` : 'too short'}, under the ${needs ? `${needs} mm` : ''} development length it needs ` +
          `to anchor (IS 456 cl 26.2.1) — so that figure cannot be this bar's length. What is the real ` +
          `${AXIS_WORD[axis]} of ${row.memberMark}, in mm? (If the figure is right, the bar runs along a ` +
          'different axis and it is the distribution axis, not the dimension, that needs correcting.)',
        { memberMark: row.memberMark, field: axis },
      ),
    );
  }
  return out;
}

export function verifyAll(input: RefereeInput): VerifyReport {
  const run: [Gate, (i: RefereeInput) => VerificationFailure[]][] = [
    ['schema', gateSchema],
    ['provenance', gateProvenance],
    ['placement', gatePlacement],
    ['extent', gateExtent],
    ['coverage', gateCoverage],
    ['completeness', gateCompleteness],
    ['anchorage', gateAnchorage],
    ['arithmetic', gateArithmetic],
    // the run counted many times over — reported as arithmetic, because that is what it is
    ['arithmetic', gateRunCountedTwice],
  ];

  const gates: GateResult[] = [];
  const failures: VerificationFailure[] = [];
  const found = new Map<Gate, VerificationFailure[]>();

  // ACCUMULATED, not overwritten: two checks share the 'arithmetic' name
  // because they are both arithmetic, and the second must not erase the first.
  for (const [name, fn] of run) {
    const f = fn(input);
    found.set(name, [...(found.get(name) ?? []), ...f]);
    failures.push(...f);
  }

  // What each gate's verdict depends on. A gate is only allowed to say "pass"
  // when the thing it inspects actually reached it.
  const schemaBroken = (found.get('schema') ?? []).length > 0;
  const coverageBroken = (found.get('coverage') ?? []).length > 0;
  const completenessBroken = (found.get('completeness') ?? []).length > 0;
  const anyRows = (input.result?.rows.length ?? 0) > 0;

  const verdict = (gate: Gate): GateResult => {
    const f = found.get(gate) ?? [];
    if (f.length) return { gate, status: 'fail', failures: f };
    switch (gate) {
      case 'placement':
        return schemaBroken
          ? {
              gate,
              status: 'blocked',
              failures: [],
              because: 'schema failures meant some members had no placement to evaluate',
            }
          : { gate, status: 'pass', failures: [] };
      case 'extent':
        // "Pass" here means one of two different things, and saying which
        // matters: a run WAS supplied and every count was measured against it,
        // or no count claimed an extent in the first place. A gate with nothing
        // to look at must not report the same word as a gate that looked.
        if (input.runMm !== undefined && input.runMm > 0) {
          return { gate, status: 'pass', failures: [] };
        }
        return input.placements && input.placements.size
          ? { gate, status: 'pass', failures: [] }
          : {
              gate,
              status: 'not-applicable',
              failures: [],
              because: 'no placement resolved, so nothing claimed how much of the job is drawn',
            };
      case 'arithmetic':
        return anyRows
          ? { gate, status: 'pass', failures: [] }
          : { gate, status: 'not-applicable', failures: [], because: 'the schedule has no rows to check' };
      default:
        return { gate, status: 'pass', failures: [] };
    }
  };

  // one verdict per GATE, not per check: two checks share the 'arithmetic'
  // name, and a report that lists it twice reads as though it ran twice
  for (const name of [...new Set(run.map(([n]) => n))]) gates.push(verdict(name));

  // the referee runs LAST and only when the structure beneath it is sound
  const structurallyBroken = schemaBroken || coverageBroken || completenessBroken;
  // MISSING DATA CAN ONLY MAKE A TOTAL TOO LOW.
  //
  // Blocking the referee whenever anything is unresolved is right for the
  // under-count it was written for: a plausible kg/m over part of the steel is
  // a coincidence. It is exactly wrong in the other direction. One run put a
  // tie beam in 47 times with a cross-section as its length, totalled 180
  // tonnes on a 100 m wall — 1854 kg/m — and was reported as "partial, one
  // failure: a wall height is unresolved", because the referee was blocked by
  // that very gap. An unresolved dimension cannot INFLATE a total, so an
  // excursion above the band is real whatever else is missing, and it is said.
  const excursion = structurallyBroken ? aboveBand(input) : [];
  if (excursion.length) {
    failures.push(...excursion);
    gates.push({ gate: 'referee', status: 'fail', failures: excursion });
  } else if (structurallyBroken) {
    gates.push({
      gate: 'referee',
      status: 'blocked',
      failures: [],
      because:
        'members are missing bars, counts or dimensions — a plausible kg/m over part of the ' +
        'steel says nothing about the whole, so no verdict is offered. (An excursion ABOVE the ' +
        'band would still have been reported: missing data cannot inflate a total.)',
    });
  } else if (!anyRows) {
    gates.push({
      gate: 'referee',
      status: 'not-applicable',
      failures: [],
      because: 'the schedule has no rows',
    });
  } else {
    const f = gateReferee(input);
    failures.push(...f);
    gates.push(f.length ? { gate: 'referee', status: 'fail', failures: f } : { gate: 'referee', status: 'pass', failures: [] });
  }

  return {
    ok: failures.length === 0 && gates.every((g) => g.status !== 'blocked'),
    failures,
    passed: gates.filter((g) => g.status === 'pass').map((g) => g.gate),
    gates,
  };
}
