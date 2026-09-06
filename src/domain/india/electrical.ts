// Rule-based decoding of Indian electrical drawing nomenclature.
//
// Indian SLDs name things systematically: `ACDB-R1` is an AC Distribution
// Board, Red phase, circuit 1. That is decodable with certainty and zero cost,
// so it must happen BEFORE any model is asked. The AI pass then only handles
// the genuine residue (opaque block names like `A$C64AE5EFA`).
//
// This module assigns MEANING ONLY. It never returns a quantity.

export type Phase = 'R' | 'Y' | 'B' | 'N' | 'E';

export const PHASE_NAME: Record<Phase, string> = {
  R: 'Red phase',
  Y: 'Yellow phase',
  B: 'Blue phase',
  N: 'Neutral',
  E: 'Earth',
};

/** Indian three-phase colour code */
export const PHASE_COLOR: Record<Phase, string> = {
  R: '#e04a3f',
  Y: '#e0c23f',
  B: '#3f6fe0',
  N: '#9aa0aa',
  E: '#4fbf67',
};

interface BoardType {
  code: string;
  name: string;
  role: string;
}

const BOARDS: BoardType[] = [
  { code: 'LPDB', name: 'Lighting & Power Distribution Board', role: 'lighting' },
  { code: 'ACDB', name: 'AC Distribution Board', role: 'hvac' },
  { code: 'APFC', name: 'Automatic Power Factor Control panel', role: 'power' },
  { code: 'MCC', name: 'Motor Control Centre', role: 'power' },
  { code: 'MDB', name: 'Main Distribution Board', role: 'power' },
  { code: 'PCC', name: 'Power Control Centre', role: 'power' },
  { code: 'SDB', name: 'Sub Distribution Board', role: 'power' },
  { code: 'EDB', name: 'Emergency Distribution Board', role: 'power' },
  { code: 'LDB', name: 'Lighting Distribution Board', role: 'lighting' },
  { code: 'UDB', name: 'UPS Distribution Board', role: 'ups' },
  { code: 'UPS', name: 'UPS', role: 'ups' },
  { code: 'DB', name: 'Distribution Board', role: 'power' },
];

const DEVICES: { re: RegExp; name: string }[] = [
  { re: /\bMCCB\b/i, name: 'Moulded case circuit breaker' },
  { re: /\bRCCB\b/i, name: 'Residual current circuit breaker' },
  { re: /\bRCBO\b/i, name: 'Residual current breaker with overload' },
  { re: /\bELCB\b/i, name: 'Earth leakage circuit breaker' },
  { re: /\bMCB\b/i, name: 'Miniature circuit breaker' },
  { re: /\bACB\b/i, name: 'Air circuit breaker' },
  { re: /\bMFM\b/i, name: 'Multi-function meter' },
  { re: /\bSPD\b/i, name: 'Surge protection device' },
  { re: /\bCT\b/i, name: 'Current transformer' },
  { re: /\bPT\b/i, name: 'Potential transformer' },
  { re: /\bISOLATOR\b/i, name: 'Isolator' },
  { re: /\bCHANGE\s*OVER\b/i, name: 'Changeover switch' },
  { re: /POWER\s*SOCKET|POWER\s*PLUG/i, name: 'Power socket outlet' },
  { re: /\bSOCKET\b/i, name: 'Socket outlet' },
  { re: /\bSWITCH\b/i, name: 'Switch' },
  { re: /PUSH\s*BUTTON/i, name: 'Push button' },
  { re: /\bAMMETER\b|\bAMM\b/i, name: 'Ammeter' },
  { re: /\bVOLTMETER\b|\bVM\b/i, name: 'Voltmeter' },
];

/** pole configuration, e.g. TPN / FP / DP */
const POLES: { re: RegExp; name: string }[] = [
  { re: /\bTPN\b/i, name: 'triple pole + neutral' },
  { re: /\bFP\b|\b4P\b/i, name: 'four pole' },
  { re: /\bTP\b/i, name: 'triple pole' },
  { re: /\bDP\b/i, name: 'double pole' },
  { re: /\bSP\b/i, name: 'single pole' },
];

export interface ElectricalMeaning {
  /** human label, e.g. "AC Distribution Board — Red phase, circuit 1" */
  label: string;
  discipline: 'electrical';
  /** what rule matched, shown as evidence */
  evidence: string;
  boardType?: string;
  phase?: Phase;
  circuit?: number;
  device?: string;
  poles?: string;
  /** amps, when the name states a rating */
  rating?: number;
  confidence: number;
}

/**
 * Decode a block, layer or annotation name.
 * Returns null when no rule applies — that is the signal to ask a model.
 */
export function decodeElectrical(raw: string): ElectricalMeaning | null {
  const s = raw.trim();
  if (!s) return null;
  const upper = s.toUpperCase();

  // ---- board with optional phase + circuit, e.g. ACDB-R1, UDB-B2, SDB-11
  for (const b of BOARDS) {
    const re = new RegExp(`\\b${b.code}\\b\\s*[-_ ]?\\s*([RYBNE])?\\s*(\\d+)?`, 'i');
    const m = re.exec(upper);
    if (!m) continue;
    const phase = m[1] as Phase | undefined;
    const circuit = m[2] ? Number(m[2]) : undefined;
    const bits = [b.name];
    if (phase) bits.push(PHASE_NAME[phase]);
    if (circuit !== undefined) bits.push(`circuit ${circuit}`);
    return {
      label: bits.join(' — '),
      discipline: 'electrical',
      evidence: `"${b.code}" board code${phase ? ` + "${phase}" phase` : ''}`,
      boardType: b.code,
      phase,
      circuit,
      confidence: phase || circuit !== undefined ? 0.95 : 0.85,
    };
  }

  // ---- protective devices and outlets
  for (const d of DEVICES) {
    if (!d.re.test(upper)) continue;
    const poles = POLES.find((p) => p.re.test(upper));
    const amps = /(\d+(?:\.\d+)?)\s*A\b/i.exec(upper);
    const rating = amps ? Number(amps[1]) : undefined;
    const bits: string[] = [];
    if (rating !== undefined) bits.push(`${rating} A`);
    if (poles) bits.push(poles.name);
    bits.push(d.name);
    return {
      label: bits.join(' ').replace(/^\w/, (c) => c.toUpperCase()),
      discipline: 'electrical',
      evidence: `matched "${d.name}"${rating ? ` with ${rating} A rating` : ''}`,
      device: d.name,
      poles: poles?.name,
      rating,
      confidence: 0.9,
    };
  }

  return null;
}

// ------------------------------------------------------------
// cable specification
// ------------------------------------------------------------

export interface CableSpec {
  cores: number;
  /** mm² */
  size: number;
  material: 'aluminium' | 'copper';
  armoured: boolean;
  insulation?: string;
  label: string;
}

/**
 * Parse a cable callout, e.g.
 *   "3.5X185 SQ.MM AL ARMOURED CABLE"
 *   "3C X 2.5 SQ.MM CU FRLS FLEXIBLE CABLE"
 */
export function parseCable(raw: string): CableSpec | null {
  const s = raw.toUpperCase();
  const m = /(\d+(?:\.\d+)?)\s*C?\s*[X×]\s*(\d+(?:\.\d+)?)\s*SQ\.?\s*MM/i.exec(s);
  if (!m) return null;
  const cores = Number(m[1]);
  const size = Number(m[2]);
  const material = /\bCU\b|COPPER/.test(s) ? 'copper' : 'aluminium';
  const armoured = /ARMOU?RED/.test(s);
  const ins = /FRLS|XLPE|PVC/.exec(s)?.[0];
  return {
    cores,
    size,
    material,
    armoured,
    insulation: ins,
    label:
      `${cores} core × ${size} mm² ${material}` +
      (armoured ? ' armoured' : '') +
      (ins ? ` ${ins}` : ''),
  };
}

// ------------------------------------------------------------
// phase balance — a real audit nobody does by eye
// ------------------------------------------------------------

export interface PhaseBalance {
  counts: Record<Phase, number>;
  /** the largest gap between the three live phases, as a fraction of the max */
  imbalance: number;
  balanced: boolean;
  note: string;
}

/**
 * Count circuits per phase across a set of names.
 *
 * A three-phase installation should distribute load roughly evenly across
 * R, Y and B. A visible skew is a design finding worth surfacing — but note
 * this counts CIRCUITS, not load, so it is an indicator rather than a verdict.
 */
export function phaseBalance(names: Iterable<string>): PhaseBalance {
  const counts: Record<Phase, number> = { R: 0, Y: 0, B: 0, N: 0, E: 0 };
  for (const n of names) {
    const d = decodeElectrical(n);
    if (d?.phase) counts[d.phase] += 1;
  }
  const live = [counts.R, counts.Y, counts.B];
  const max = Math.max(...live);
  const min = Math.min(...live);
  const imbalance = max > 0 ? (max - min) / max : 0;
  const balanced = max === 0 || imbalance <= 0.25;
  return {
    counts,
    imbalance,
    balanced,
    note:
      max === 0
        ? 'No phase-tagged circuits found.'
        : balanced
          ? `Circuits are reasonably balanced across phases (R ${counts.R} / Y ${counts.Y} / B ${counts.B}).`
          : `Phase loading looks uneven: R ${counts.R} / Y ${counts.Y} / B ${counts.B}. ` +
            'Counts circuits, not connected load — worth a look rather than a conclusion.',
  };
}
