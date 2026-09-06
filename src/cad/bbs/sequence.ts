// ============================================================
// Periodic sequence detection — what actually repeats, and over what period.
//
// WHY THE AVERAGE GAP IS WRONG
//
// A template was closed by adding the AVERAGE gap between occurrences. On a
// uniform layout that is right by coincidence. On an alternating one it is
// wrong by exactly the factor the alternation introduces:
//
//     C1  SC  C2  SC  C1  SC  C1        gaps all ~2079
//     └───────┘                          but the structural period is ~4158
//
// The footing layout of the same wall, carrying only its main members, closed
// with a 4158 gap. Two layouts describing the same run therefore produced
// template lengths of 29,106 and 27,027 mm, their tilings drifted apart, and
// the footing count came out one short of the column count it must equal.
//
// The period is not a property of the gaps. It is a property of the LABELLED
// SEQUENCE: the distance from an occurrence to the next occurrence that begins
// the same pattern. That is what this file computes.
//
// AND IT REFUSES. A layout with no unambiguous cycle — genuinely irregular, or
// too short to show one twice — returns unresolved with the reason. Inventing a
// period for an irregular layout is how a wall gets counted against a rhythm it
// does not have.
// ============================================================

export interface Occurrence {
  id: string;
  /** the normalised member identity — never a raw drawing string */
  label: string;
  /** position along the layout axis, mm */
  at: number;
}

export interface Cycle {
  /** how many occurrences make one full cycle */
  size: number;
  /** the distance from one cycle's start to the next, mm */
  periodMm: number;
  /** the labels of one cycle, in order */
  labels: string[];
  /** where the first cycle starts, mm — the phase */
  originMm: number;
  /** offsets of each occurrence within the cycle, mm from its origin */
  offsetsMm: number[];
  /** how many whole cycles the drawn layout shows */
  drawnCycles: number;
}

export interface SequenceResult {
  ok: boolean;
  cycle?: Cycle;
  reason?: string;
  /** what was considered and rejected, for the record */
  notes: string[];
}

/** two positions closer than this are the same node */
const NODE_TOL_MM = 25;
/** how far a gap may differ from its counterpart and still be "the same" */
const GAP_TOL_FRACTION = 0.05;
/** ...with this floor, so tiny gaps are not held to an impossible tolerance */
const GAP_TOL_FLOOR_MM = 30;

const close = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(GAP_TOL_FLOOR_MM, Math.abs(b) * GAP_TOL_FRACTION);

/** collapse coincident occurrences and sort along the axis */
export function normaliseOccurrences(list: readonly Occurrence[]): Occurrence[] {
  const sorted = [...list].sort((a, b) => a.at - b.at);
  const out: Occurrence[] = [];
  for (const o of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(o.at - last.at) <= NODE_TOL_MM && last.label === o.label) continue;
    out.push(o);
  }
  return out;
}

/**
 * The smallest labelled cycle the sequence genuinely repeats.
 *
 * Candidate sizes are tried smallest first, because the smallest true cycle is
 * the structural one: a sequence that repeats every 2 also "repeats" every 4,
 * and taking 4 would double the period and halve every count.
 *
 * A candidate must satisfy BOTH tests — the labels must line up, and so must
 * the distances. Labels alone would accept a layout whose spacing changes at an
 * expansion joint; distances alone would accept two different members that
 * happen to sit at the same pitch.
 */
export function detectCycle(occurrences: readonly Occurrence[]): SequenceResult {
  const notes: string[] = [];
  const list = normaliseOccurrences(occurrences);
  if (list.length < 2) {
    return { ok: false, reason: `a sequence of ${list.length} cannot show a repeat`, notes };
  }

  const labels = list.map((o) => o.label);
  const at = list.map((o) => o.at);
  const n = list.length;

  for (let size = 1; size <= Math.floor(n / 2); size++) {
    // the cycle must be shown at least TWICE, or it is an assertion not an
    // observation — a single drawn group repeats nothing
    const repeats = Math.floor(n / size);
    if (repeats < 2) continue;

    let labelsMatch = true;
    for (let i = size; i < n && labelsMatch; i++) {
      if (labels[i] !== labels[i - size]) labelsMatch = false;
    }
    if (!labelsMatch) continue;

    // The period is measured between CORRESPONDING occurrences — occurrence i
    // and occurrence i+size — never from an average. Every such pair must
    // agree, which is what rejects a layout whose pitch changes partway.
    const periods: number[] = [];
    for (let i = 0; i + size < n; i++) periods.push(at[i + size] - at[i]);
    if (!periods.length) continue;
    const period = periods[0];
    if (!(period > 0)) continue;
    if (!periods.every((p) => close(p, period))) {
      notes.push(
        `cycle of ${size} matches by label but its period varies (${periods
          .map((p) => Math.round(p))
          .join(', ')}) — rejected`,
      );
      continue;
    }

    const originMm = at[0];
    const offsetsMm = list.slice(0, size).map((o) => o.at - originMm);
    return {
      ok: true,
      notes,
      cycle: {
        size,
        periodMm: period,
        labels: labels.slice(0, size),
        originMm,
        offsetsMm,
        drawnCycles: repeats,
      },
    };
  }

  return {
    ok: false,
    notes,
    reason:
      `no cycle repeats twice in this layout of ${n} occurrence(s) ` +
      `(${labels.join(', ')}). It is either irregular or too short to show its own rhythm; ` +
      'a period was not invented for it.',
  };
}

export interface TileOptions {
  /** how far the job runs, mm */
  runMm: number;
  /** does an occurrence sit at the closing end of the run? */
  boundaryRule?: 'both-ends' | 'start-only';
}

export interface TileResult {
  /** how many of each label exist over the whole run */
  counts: Record<string, number>;
  /** every occurrence position generated, for provenance */
  positions: { label: string; at: number }[];
  working: string;
}

/**
 * Repeat a cycle over the run, keeping its phase.
 *
 * Phase is what makes a partial final cycle correct: a member sitting early in
 * the cycle appears in a short tail and one sitting late does not. Counting a
 * tail by proportion — "the tail is 70% of a cycle so it holds 70% of each
 * member" — produces fractional columns and loses the alternation entirely.
 */
export function tileCycle(cycle: Cycle, opts: TileOptions): TileResult {
  const counts: Record<string, number> = {};
  const positions: { label: string; at: number }[] = [];
  const { runMm } = opts;
  const boundary = opts.boundaryRule ?? 'both-ends';

  const limit = runMm + (boundary === 'both-ends' ? NODE_TOL_MM : -NODE_TOL_MM);
  let cycleIndex = 0;
  for (;;) {
    const base = cycleIndex * cycle.periodMm;
    if (base > limit) break;
    let placedAny = false;
    for (let i = 0; i < cycle.size; i++) {
      const at = base + cycle.offsetsMm[i];
      if (at > limit) continue;
      placedAny = true;
      const label = cycle.labels[i];
      counts[label] = (counts[label] ?? 0) + 1;
      positions.push({ label, at });
    }
    if (!placedAny && base > 0) break;
    cycleIndex++;
    if (cycleIndex > 100000) break; // a period of near-zero cannot run away
  }

  const whole = Math.floor(runMm / cycle.periodMm);
  const tail = runMm - whole * cycle.periodMm;
  return {
    counts,
    positions,
    working:
      `cycle of ${cycle.size} (${cycle.labels.join('·')}) every ${Math.round(cycle.periodMm)} mm; ` +
      `${runMm} mm run = ${whole} whole cycle(s)` +
      (tail > NODE_TOL_MM ? ` + a ${Math.round(tail)} mm tail, counted by position` : '') +
      `, ${boundary}`,
  };
}
