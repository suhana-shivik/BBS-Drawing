// Bar Bending Schedule — the arithmetic.
//
// THE RULE, restated because it governs every function here: the model may
// say WHAT a bar is; it never says HOW LONG. Cutting length is entered by the
// detailer, or produced by a shape formula, or derived from IS 456/2502 — and
// the derivation is a suggestion shown with its working, never an assertion.
//
// Sources are named per constant. Nothing here is invented, and nothing is
// silently defaulted: an unknown diameter or grade returns null and the caller
// decides what to do about it.

// ------------------------------------------------------------
// IS 1786 Table 1 — nominal mass
// ------------------------------------------------------------

/**
 * kg/m by nominal diameter. Deliberately NOT pi/4*d^2*rho: the steel invoice
 * and the site check sheet are both written against nominal mass. The two
 * differ in the third decimal — immaterial on one bar, a visible
 * reconciliation gap over 40 tonnes.
 */
export const UNIT_WEIGHT_KG_PER_M: Record<number, number> = {
  6: 0.222,
  8: 0.395,
  10: 0.617,
  12: 0.888,
  16: 1.58,
  20: 2.47,
  25: 3.85,
  28: 4.83,
  32: 6.31,
  36: 7.99,
  40: 9.86,
};

export interface UnitWeight {
  kgPerM: number;
  source: 'IS_1786' | 'DENSITY_FALLBACK';
}

/** Nominal mass, or the density fallback — which is always reported, never silent. */
export function unitWeight(diaMm: number): UnitWeight | null {
  // NUMERIC columns arrive as "8.00"; a table keyed by 8 would miss it
  const d = Number(diaMm);
  if (!Number.isFinite(d) || d <= 0) return null;
  const nominal = UNIT_WEIGHT_KG_PER_M[d];
  if (nominal !== undefined) return { kgPerM: nominal, source: 'IS_1786' };
  // pi/4 * d^2 * 7850 kg/m^3, d in mm -> kg/m
  return {
    kgPerM: (Math.PI / 4) * (d / 1000) ** 2 * 7850,
    source: 'DENSITY_FALLBACK',
  };
}

// ------------------------------------------------------------
// IS 456 — development length and laps
// ------------------------------------------------------------

/** IS 456 Table 21 — design bond stress for PLAIN bars in tension, N/mm² */
const TAU_BD_PLAIN: Record<string, number> = {
  M15: 1.0,
  M20: 1.2,
  M25: 1.4,
  M30: 1.5,
  M35: 1.7,
  M40: 1.9,
};

/** characteristic yield strength by steel grade, N/mm² */
const FY: Record<string, number> = {
  Fe250: 250,
  Fe415: 415,
  Fe500: 500,
  Fe550: 550,
  Fe600: 600,
};

export interface DevelopmentLength {
  ldMm: number;
  /** the substituted arithmetic, so a UI can show why rather than assert */
  working: string;
}

/**
 * Ld = phi * sigma_s / (4 * tau_bd),  sigma_s = 0.87 * fy   (IS 456 cl. 26.2.1)
 *
 * tau_bd is increased 60% for deformed bars (cl. 26.2.1.1) and a further 25%
 * in compression. Grades above M40 take the M40 value — the table stops there
 * and cl. 26.2.1.1 does not extrapolate it.
 */
export function developmentLength(
  diaMm: number,
  concreteGrade: string,
  steelGrade: string,
  opts: { deformed?: boolean; compression?: boolean } = {},
): DevelopmentLength | null {
  const d = Number(diaMm);
  const fy = FY[steelGrade];
  if (!Number.isFinite(d) || d <= 0 || fy === undefined) return null;

  const gradeNum = Number(/M\s*(\d+)/i.exec(concreteGrade)?.[1] ?? NaN);
  if (!Number.isFinite(gradeNum)) return null;
  const key = gradeNum >= 40 ? 'M40' : `M${gradeNum}`;
  const base = TAU_BD_PLAIN[key];
  if (base === undefined) return null;

  const deformed = opts.deformed !== false; // deformed unless told otherwise
  let tau = base;
  const steps: string[] = [`τbd = ${base} (IS 456 Table 21, ${key})`];
  if (deformed) {
    tau *= 1.6;
    steps.push('× 1.6 deformed (cl. 26.2.1.1)');
  }
  if (opts.compression) {
    tau *= 1.25;
    steps.push('× 1.25 compression');
  }

  const sigmaS = 0.87 * fy;
  const ld = (d * sigmaS) / (4 * tau);
  return {
    ldMm: ld,
    working:
      `${steps.join(' ')} = ${tau.toFixed(3)};  ` +
      `σs = 0.87 × ${fy} = ${sigmaS.toFixed(1)};  ` +
      `Ld = ${d} × ${sigmaS.toFixed(1)} / (4 × ${tau.toFixed(3)}) = ${ld.toFixed(0)} mm ` +
      `(${(ld / d).toFixed(1)}φ)`,
  };
}

/**
 * Lap = max(Ld, 30φ) tension / max(Ld, 24φ) compression  (IS 456 cl. 26.2.5.1)
 *
 * The floor is a detailing minimum applied AFTER Ld — which is why a small bar
 * in strong concrete does not end up with an absurdly short lap.
 */
export function lapLength(
  diaMm: number,
  ldMm: number,
  compression = false,
): { lapMm: number; governedBy: 'Ld' | 'minimum' } {
  const floor = (compression ? 24 : 30) * Number(diaMm);
  return ldMm >= floor
    ? { lapMm: ldMm, governedBy: 'Ld' }
    : { lapMm: floor, governedBy: 'minimum' };
}

// ------------------------------------------------------------
// IS 2502 — hooks and bends
// ------------------------------------------------------------

export type HookType = 'none' | 'hook90' | 'hook135' | 'hook180';

/** allowance per hook, with the 75 mm floor from IS 2502 Table 1 */
export function hookAllowance(diaMm: number, hook: HookType): number {
  const d = Number(diaMm);
  if (!Number.isFinite(d) || d <= 0 || hook === 'none') return 0;
  const mult = hook === 'hook90' ? 8 : hook === 'hook135' ? 10 : 9;
  return Math.max(mult * d, 75);
}

export type BendMode = 'CONVENTIONAL' | 'ARC_EXACT';

/**
 * What a corner costs.
 *
 * A drawing dimensions a bent bar to the INTERSECTION of its arms, but the bar
 * turns on an arc shorter than that corner. Cut to the dimensioned sum and
 * every bar comes out long; the difference is this deduction.
 *
 * The two modes are never mixed in one schedule — that subtracts each corner
 * twice.
 */
export function bendDeduction(
  diaMm: number,
  angleDeg: number,
  mode: BendMode,
  opts: { stirrup?: boolean } = {},
): { deductionMm: number; allowanceMm: number; note: string } {
  const d = Number(diaMm);
  const a = Math.abs(angleDeg);

  if (mode === 'CONVENTIONAL') {
    const table: Record<number, number> = { 45: 1, 90: 2, 135: 3 };
    const mult = table[a];
    if (mult !== undefined) {
      return {
        deductionMm: mult * d,
        allowanceMm: 0,
        note: `${a}° = ${mult}φ (conventional)`,
      };
    }
    // an off-table angle falls through to the exact derivation rather than
    // snapping to 45/90/135 — and says so
  }

  // minimum internal bend radius, IS 2502 Table 2
  const rInternal = (opts.stirrup ? 2 : 4) * d;
  const R = rInternal + d / 2; // to the bar centre-line
  const theta = (a * Math.PI) / 180;
  const deduction = R * (2 * Math.tan(theta / 2) - theta);
  return {
    deductionMm: deduction,
    allowanceMm: R * theta,
    note:
      `arc-exact: R = ${opts.stirrup ? '2' : '4'}φ + φ/2 = ${R.toFixed(1)} mm, ` +
      `θ = ${a}°; deduction = R(2·tan(θ/2) − θ) = ${deduction.toFixed(1)} mm`,
  };
}

// ------------------------------------------------------------
// shape formulas
// ------------------------------------------------------------

export type ShapeCode =
  | '00' | '11' | '21' | '31' | '34' | '41' | '51' | '52' | '60' | 'POL' | '77' | 'CUS';

export interface ShapeDef {
  code: ShapeCode;
  label: string;
  dims: string[];
  formulaText: string;
  compute(d: Record<string, number>): number | null;
}

const num = (v: number | undefined): number => (Number.isFinite(v) ? (v as number) : NaN);

export const SHAPES: Record<ShapeCode, ShapeDef> = {
  '00': {
    code: '00', label: 'Straight', dims: ['A'], formulaText: 'A',
    compute: (d) => num(d.A),
  },
  '11': {
    code: '11', label: 'L — one 90° bend', dims: ['A', 'B'], formulaText: 'A + B',
    compute: (d) => num(d.A) + num(d.B),
  },
  '21': {
    code: '21', label: 'U — two 90° bends', dims: ['A', 'B', 'C'], formulaText: 'A + B + C',
    compute: (d) => num(d.A) + num(d.B) + num(d.C),
  },
  '31': {
    code: '31', label: 'Triangle', dims: ['A', 'B', 'C'], formulaText: 'A + B + C',
    compute: (d) => num(d.A) + num(d.B) + num(d.C),
  },
  '34': {
    code: '34', label: 'Cranked / bent-up', dims: ['A', 'B', 'C', 'D'],
    formulaText: 'A + C × B × tan(D / 2)',
    compute: (d) => {
      const angle = Number.isFinite(d.D) ? d.D : 45;
      return num(d.A) + num(d.C) * num(d.B) * Math.tan((angle * Math.PI) / 360);
    },
  },
  '41': {
    code: '41', label: 'Rectangle', dims: ['A', 'B'], formulaText: '2 × (A + B)',
    compute: (d) => 2 * (num(d.A) + num(d.B)),
  },
  '51': {
    code: '51', label: 'Closed stirrup / link', dims: ['A', 'B'], formulaText: '2 × (A + B)',
    compute: (d) => 2 * (num(d.A) + num(d.B)),
  },
  '52': {
    code: '52', label: 'Open stirrup', dims: ['A', 'B'], formulaText: 'A + 2 × B',
    compute: (d) => num(d.A) + 2 * num(d.B),
  },
  '60': {
    code: '60', label: 'Circle / ring', dims: ['A'], formulaText: 'π × A',
    compute: (d) => Math.PI * num(d.A),
  },
  POL: {
    code: 'POL', label: 'Regular polygon', dims: ['A', 'B'], formulaText: 'B × A',
    compute: (d) => num(d.B) * num(d.A),
  },
  '77': {
    code: '77', label: 'Spiral / helix', dims: ['A', 'B', 'C'],
    formulaText: 'n × √((π·A)² + B²),  n = C/B + 1',
    compute: (d) => {
      const A = num(d.A), B = num(d.B), C = num(d.C);
      if (!(B > 0)) return NaN;
      const n = C / B + 1;
      return n * Math.sqrt((Math.PI * A) ** 2 + B ** 2);
    },
  },
  // CUSTOM — the drawing's own geometry. There is no formula: the developed
  // length is measured from what is drawn (a polyline's segments summed), and
  // reaches this table already resolved, as the single dimension `CUS`. A
  // custom shape with no drawn geometry behind it has no length, and says so
  // rather than borrowing the nearest library formula.
  CUS: {
    code: 'CUS', label: 'Custom — drawn geometry', dims: ['CUS'],
    formulaText: 'developed length of the drawn geometry',
    compute: (d) => num(d.CUS),
  },
};

/** The developed length of a drawn polyline — the sum of its segments, in the drawing's units. */
export function polylineLength(points: readonly { x: number; y: number }[], closed = false): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  if (closed) {
    const a = points[points.length - 1], b = points[0];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

export function shapeLength(code: ShapeCode, dims: Record<string, number>): number | null {
  const s = SHAPES[code];
  if (!s) return null;
  const v = s.compute(dims);
  return Number.isFinite(v) && (v as number) > 0 ? (v as number) : null;
}

/**
 * Centre-line arm of a stirrup inside a member.
 *
 * `member − 2·cover − φ`, not `member − 2·cover`. The bar's own diameter comes
 * off too because the dimension runs to the bar centre — the single most
 * common stirrup error.
 */
export function stirrupArm(memberMm: number, coverMm: number, diaMm: number): number {
  return memberMm - 2 * coverMm - Number(diaMm);
}

// ------------------------------------------------------------
// counting
// ------------------------------------------------------------

export interface BarCount {
  count: number;
  actualPitchMm: number | null;
  warning?: string;
}

/**
 * n = ceil(span / spacing) + 1
 *
 * The +1 is the fence-post and it is the most common under-count in a
 * hand-written BBS: eight 150 mm gaps carry nine bars. Bars stop at the cover
 * line, hence span = axis − 2·cover.
 */
export function countBySpacing(
  axisMm: number,
  spacingMm: number,
  coverMm: number,
): BarCount | null {
  const span = axisMm - 2 * coverMm;
  if (!(span > 0) || !(spacingMm > 0)) return null;
  const gaps = Math.ceil(span / spacingMm);
  const count = gaps + 1;
  const actual = gaps > 0 ? span / gaps : null;
  const drift = actual === null ? 0 : Math.abs(actual - spacingMm);
  return {
    count,
    actualPitchMm: actual,
    warning:
      drift > 1
        ? `Actual pitch ${actual!.toFixed(1)} mm differs from the requested ${spacingMm} mm — ` +
          'the last gap closing short is normal, but confirm the pitch.'
        : undefined,
  };
}

// ------------------------------------------------------------
// weights
// ------------------------------------------------------------

export interface BarWeight {
  totalLengthM: number;
  weightKg: number;
  weightWithWastageKg: number;
  unitWeightKgPerM: number;
  unitWeightSource: UnitWeight['source'];
}

/** Wastage is an ordering margin. It never reaches the structure, so it is never in the net weight. */
export function barWeight(
  cuttingLengthMm: number,
  totalBars: number,
  diaMm: number,
  wastagePct = 0,
): BarWeight | null {
  const uw = unitWeight(diaMm);
  if (!uw || !(cuttingLengthMm > 0) || !(totalBars > 0)) return null;
  const totalLengthM = (cuttingLengthMm * totalBars) / 1000;
  const weightKg = totalLengthM * uw.kgPerM;
  return {
    totalLengthM,
    weightKg,
    weightWithWastageKg: weightKg * (1 + wastagePct / 100),
    unitWeightKgPerM: uw.kgPerM,
    unitWeightSource: uw.source,
  };
}

export interface SummaryLine {
  diaMm: number;
  barCount: number;
  totalLengthM: number;
  unitWeightKgPerM: number;
  totalWeightKg: number;
  totalWeightWithWastageKg: number;
  /**
   * The share of `totalWeightKg` that is lap. It is INSIDE the total — a lap
   * is part of a bar's cutting length, and is never added a second time here.
   * Reported so a reader can see how much of the steel is splice.
   */
  lapWeightKg: number;
  totalWeightMt: number;
  nonStandardDiameter: boolean;
}

/** Grouped by diameter and nothing else — the yard cuts by diameter. */
export function steelSummary(
  rows: { diaMm: number; cuttingLengthMm: number; totalBars: number; lapMm?: number }[],
  wastagePct = 0,
): SummaryLine[] {
  const acc = new Map<number, { bars: number; lenM: number; lapM: number }>();
  for (const r of rows) {
    const d = Number(r.diaMm);
    if (!(d > 0) || !(r.cuttingLengthMm > 0) || !(r.totalBars > 0)) continue;
    const cur = acc.get(d) ?? { bars: 0, lenM: 0, lapM: 0 };
    cur.bars += r.totalBars;
    cur.lenM += (r.cuttingLengthMm * r.totalBars) / 1000;
    if (typeof r.lapMm === 'number' && r.lapMm > 0) cur.lapM += (r.lapMm * r.totalBars) / 1000;
    acc.set(d, cur);
  }

  const out: SummaryLine[] = [];
  for (const [diaMm, v] of [...acc].sort((a, b) => a[0] - b[0])) {
    const uw = unitWeight(diaMm);
    if (!uw) continue;
    const kg = v.lenM * uw.kgPerM;
    // MT derived from the rounded kg so the two can never round differently
    const kgRounded = Number(kg.toFixed(6));
    out.push({
      diaMm,
      barCount: v.bars,
      totalLengthM: v.lenM,
      unitWeightKgPerM: uw.kgPerM,
      totalWeightKg: kgRounded,
      totalWeightWithWastageKg: kgRounded * (1 + wastagePct / 100),
      lapWeightKg: Number((v.lapM * uw.kgPerM).toFixed(6)),
      totalWeightMt: kgRounded / 1000,
      nonStandardDiameter: uw.source === 'DENSITY_FALLBACK',
    });
  }
  return out;
}
