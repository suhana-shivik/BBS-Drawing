// ============================================================
// Sections — the unit the Re-Verification Protocol judges
//
// BBS_PLAN.md Part II. Three wrong totals in one day (0.731 MT, 0 kg,
// 0.668 MT) shared one structural absence: nobody owned the question "is this
// section's steel roughly what this drawing implies?" Every row was locally
// defensible; the aggregate was absurd; the absurdity had no owner.
//
// This module owns it. Each member group becomes a SECTION carrying its
// element kind, its quantum (dimensions, count, run), the engine's subtotal —
// and the REFEREE's independent expectation: steel as kg per m³ of concrete,
// by element kind. That is the cross-check every estimator in the country
// already trusts, it is deterministic, and it is computed from the quantum
// alone
// 


















//— so its errors cannot correlate with the engine's row arithmetic.
//
// The AI's ideal (Stage 1 of the protocol) joins later as the third voice.
// Nothing here writes a bill number: sections judge, the engine bills.
// ============================================================
import { isLinearMember, runMmFromTakeoff } from './build';
import type { BbsMember, BbsResult } from './types';

export type ElementKind =
  | 'footing'
  | 'column' // includes pedestals and stub columns
  | 'beam'
  | 'wall'
  | 'pole'
  | 'panel'
  | 'other';

/** the broad structural family a member belongs to, from its type and mark */
export function elementKind(member: BbsMember): ElementKind {
  const t = member.type.toLowerCase();
  const mark = member.mark.trim().toUpperCase();
  if (/footing|foundation|raft/.test(t) || /^F\d{1,3}$/.test(mark)) return 'footing';
  if (/pole/.test(t) || /^H-?POLE/.test(mark)) return 'pole';
  if (/panel|precast/.test(t) || /PANEL/.test(mark)) return 'panel';
  if (/wall|parapet/.test(t)) return 'wall';
  if (/beam|tb\b|plinth/.test(t) || /^(TB|PB|GB|LB|RB)\d{0,3}$/.test(mark)) return 'beam';
  if (/column|pedestal|pier|stub|post/.test(t) || /^(C|P|SC)\d{0,3}$/.test(mark)) return 'column';
  return 'other';
}

// ------------------------------------------------------------
// dimension bands by kind — no 150 mm footings, no 1 mm columns
// ------------------------------------------------------------

interface Band {
  min: number;
  max: number;
}

/**
 * What a dimension of this kind can plausibly be, in mm.
 *
 * The global ≥30 mm gate caught a 2 mm "column" and then a 150 mm "footing
 * width" walked straight past it — 150 mm is a fine slab thickness and an
 * impossible footing side. Plausibility is a property of the ELEMENT KIND,
 * not of numbers in general. Bands are deliberately generous: a wrong refusal
 * silences a real dimension, which is worse than letting an odd one through
 * to the referee's judgement.
 */
const DIM_BANDS: Record<ElementKind, { plan: Band; depth: Band }> = {
  footing: { plan: { min: 300, max: 8000 }, depth: { min: 150, max: 2500 } },
  column: { plan: { min: 150, max: 2000 }, depth: { min: 300, max: 8000 } }, // depth = height
  beam: { plan: { min: 100, max: 1000 }, depth: { min: 150, max: 2000 } },
  wall: { plan: { min: 75, max: 600 }, depth: { min: 300, max: 8000 } }, // plan = thickness
  pole: { plan: { min: 75, max: 500 }, depth: { min: 500, max: 6000 } },
  panel: { plan: { min: 40, max: 3000 }, depth: { min: 40, max: 3000 } },
  other: { plan: { min: 30, max: 30000 }, depth: { min: 30, max: 30000 } },
};

export interface DimViolation {
  mark: string;
  axis: 'L' | 'W' | 'H';
  value: number;
  band: Band;
  kind: ElementKind;
}

const inBand = (v: number | undefined, b: Band): boolean =>
  v === undefined || (v >= b.min && v <= b.max);

/** every dimension on a member that its kind says cannot be right */
export function dimViolations(member: BbsMember): DimViolation[] {
  const kind = elementKind(member);
  const bands = DIM_BANDS[kind];
  const out: DimViolation[] = [];
  const check = (axis: 'L' | 'W' | 'H', v: number | undefined, b: Band): void => {
    if (v !== undefined && v > 0 && !inBand(v, b)) {
      out.push({ mark: member.mark, axis, value: v, band: b, kind });
    }
  };
  // for a linear member the "length" is a run, not a section dimension
  if (!isLinearMember(member)) check('L', member.lengthMm, bands.plan);
  check('W', member.widthMm, bands.plan);
  check('H', member.heightMm, bands.depth);
  return out;
}

/**
 * Strip out-of-band dimensions before the engine computes on them.
 *
 * Runs at the same choke point as declaration grounding, so a 150 mm footing
 * width from a poisoned cache or a mis-aimed reference becomes an honest
 * MISSING axis — its rows refuse, its question renders — instead of flowing
 * into 23 metres of billed 8 mm bar.
 */
export function enforceDimBands(interpretation: {
  members: BbsMember[];
}): { members: BbsMember[]; violations: DimViolation[] } {
  const violations: DimViolation[] = [];
  const members = interpretation.members.map((m) => {
    const bad = dimViolations(m);
    if (!bad.length) return m;
    violations.push(...bad);
    const next = { ...m };
    for (const v of bad) {
      if (v.axis === 'L') next.lengthMm = undefined;
      if (v.axis === 'W') next.widthMm = undefined;
      if (v.axis === 'H') next.heightMm = undefined;
      if (!next.missing.includes(v.axis)) next.missing = [...next.missing, v.axis];
    }
    next.incomplete = next.missing.length > 0;
    return next;
  });
  return { members, violations };
}

// ------------------------------------------------------------
// the referee — steel as kg per m³ of concrete, by kind
// ------------------------------------------------------------

/**
 * Typical reinforcement content of Indian RCC elements, kg of steel per m³
 * of concrete. The ranges every estimator sanity-checks against; generous at
 * both ends because detailing varies by office and seismic zone.
 */
const STEEL_KG_PER_M3: Partial<Record<ElementKind, Band>> = {
  footing: { min: 50, max: 100 },
  column: { min: 100, max: 200 },
  beam: { min: 90, max: 180 },
  wall: { min: 50, max: 110 },
  pole: { min: 100, max: 220 },
};

/**
 * Concrete volume of one section's members, m³ — null when the quantum is
 * incomplete, which is itself the finding: a section whose volume cannot be
 * computed is a section whose steel cannot be verified.
 */
export function concreteVolumeM3(
  member: BbsMember,
  kind: ElementKind,
  runMm: number | null,
): number | null {
  const mm3ToM3 = 1e-9;
  if (kind === 'wall' || kind === 'beam' || (isLinearMember(member) && kind !== 'panel')) {
    // thickness/width × height/depth × run
    const thk = member.widthMm;
    const depth = member.heightMm;
    if (!thk || !depth || !runMm) return null;
    return thk * depth * runMm * mm3ToM3;
  }
  const { lengthMm: l, widthMm: w, heightMm: h } = member;
  if (!l || !w || !h) return null;
  return l * w * h * (member.count > 0 ? member.count : 1) * mm3ToM3;
}

export type SectionVerdict =
  | 'verified' // engine inside the referee band
  | 'short' // engine below — steel is missing, not cheap
  | 'over' // engine above — check double counting
  | 'unverifiable' // quantum incomplete: no volume, no judgement
  | 'not-scheduled'; // the section exists on the sheet and has no rows

export interface Section {
  mark: string;
  kind: ElementKind;
  /** engine subtotal for this member, kg incl. wastage */
  engineKg: number;
  /** m³, when the quantum allows it */
  concreteM3: number | null;
  /** the referee's expectation, kg */
  expectedKg: Band | null;
  verdict: SectionVerdict;
  /** why — refused rows, band violations, missing quantum */
  causes: string[];
}

/**
 * Judge every member group against the referee.
 *
 * Pure arithmetic over the engine's own result: no model, no I/O. The AI
 * ideal (protocol Stage 1) is layered on top of these verdicts by the caller.
 */
export function buildSections(
  result: BbsResult,
  takeoff?: Record<string, unknown>,
): Section[] {
  const runMm = runMmFromTakeoff(takeoff);
  const byMark = new Map<string, number>();
  for (const row of result.rows) {
    byMark.set(row.memberMark, (byMark.get(row.memberMark) ?? 0) + (row.weightWithWastageKg ?? 0));
  }

  return result.members.map((member) => {
    const kind = elementKind(member);
    const engineKg = byMark.get(member.mark) ?? 0;
    const causes: string[] = [];

    for (const v of dimViolations(member)) {
      causes.push(
        `${v.axis} = ${v.value} mm is outside a ${v.kind}'s ${v.band.min}–${v.band.max} mm band`,
      );
    }
    for (const inc of result.incomplete) {
      if (inc.barMark.startsWith(`${member.mark}-`)) {
        causes.push(`${inc.barMark}: ${inc.reason}`);
      }
    }

    const rows = result.rows.filter((r) => r.memberMark === member.mark);
    if (rows.length === 0) {
      return {
        mark: member.mark,
        kind,
        engineKg: 0,
        concreteM3: null,
        expectedKg: null,
        verdict: 'not-scheduled',
        causes: [`${member.mark} is on the sheet and has no rows in the schedule`],
      };
    }

    const concreteM3 = concreteVolumeM3(member, kind, runMm);
    const band = STEEL_KG_PER_M3[kind];
    if (concreteM3 === null || !band) {
      if (concreteM3 === null) {
        causes.push('quantum incomplete — a dimension or the run is unanswered, so the section cannot be verified');
      }
      return {
        mark: member.mark,
        kind,
        engineKg,
        concreteM3,
        expectedKg: null,
        verdict: 'unverifiable',
        causes,
      };
    }

    const expectedKg = { min: concreteM3 * band.min, max: concreteM3 * band.max };
    const verdict: SectionVerdict =
      engineKg < expectedKg.min ? 'short' : engineKg > expectedKg.max ? 'over' : 'verified';
    if (verdict === 'short') {
      causes.push(
        `engine ${engineKg.toFixed(0)} kg is below the referee's ${expectedKg.min.toFixed(0)}–${expectedKg.max.toFixed(0)} kg ` +
          `(${concreteM3.toFixed(1)} m³ of ${kind} at ${band.min}–${band.max} kg/m³) — steel is missing, not cheap`,
      );
    }
    if (verdict === 'over') {
      causes.push(
        `engine ${engineKg.toFixed(0)} kg is above the referee's ${expectedKg.max.toFixed(0)} kg — check for double counting`,
      );
    }
    return { mark: member.mark, kind, engineKg, concreteM3, expectedKg, verdict, causes };
  });
}

/** the one-line verdict the total must carry */
export function sectionsSummary(sections: Section[]): string | null {
  const bad = sections.filter((s) => s.verdict !== 'verified');
  if (!bad.length) return null;
  const parts = bad.map((s) => `${s.mark} ${s.verdict.replace('-', ' ')}`);
  return `${bad.length} of ${sections.length} sections unverified: ${parts.join(', ')}`;
}
