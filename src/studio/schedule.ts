// Schedule model for the studio shell — a local, engine-free shape of a BBS
// row, modelled on the fields STUDIO_DESIGN §6.1 names on BbsRow.
//
// integration seam: the integrator adapts the engine's real BbsRow to
// ScheduleRow here. Nothing in this file computes a bar length — the shell
// renders what the engine derived, it never re-derives.

import type { BlockedRow } from '../facts/blocked';

export type LengthSource = 'ENTERED' | 'DRAWN_GEOMETRY' | 'CUSTOM_FORMULA' | 'SHAPE_FORMULA' | 'IS_DERIVED' | 'UNAVAILABLE';
export type RowStatus = 'verified' | 'inferred' | 'unavailable';

export interface ScheduleSegment {
  /** Leg label: a, b, c … A NEGATIVE mm value is a bend deduction. */
  label: string;
  mm: number;
  /** Optional note, e.g. "bend deduction, 2 × 90° · IS 2502 Table 1". */
  note?: string;
}

export interface ScheduleRow {
  id: string;
  mark: string;
  member: string;
  barType: string;
  diaMm: number;
  shapeCode: string;
  segments: ScheduleSegment[];
  cuttingLengthMm: number | null;
  /** The substituted arithmetic behind the length — shown, never hidden. */
  lengthWorking: string;
  lengthSource: LengthSource;
  /** the cover the length was cut to, and its status — beside every length */
  coverMm?: number | null;
  coverSource?: string;
  coverStatus?: 'DRAWING_READ' | 'USER_INPUT' | 'ASSUMED';
  /** the stage trace the engine persisted on the row */
  trace?: import('../../calculations/schedule').RowStageTrace;
  barsPerMember: number | null;
  memberCount: number | null;
  /**
   * NULL, never 0, when the count could not be derived.
   *
   * A zero total sums to nothing, reconciles against every arithmetic gate and
   * reads on the page as an answer — "this bar occurs no times" — when what
   * happened is that nobody could work out how many there are. The engine
   * stopped emitting 0 for an underived count; this is the last leg of that,
   * so a blocked row prints its question rather than a number.
   */
  totalBars: number | null;
  spacingMm: number | null;
  /** Set when the count came from mark occurrences rather than spacing; names the band. */
  occurrenceBand: string | null;
  countWorking?: string;
  totalLengthM: number | null;
  unitWeightKgPerM: number | null;
  weightKg: number | null;
  weightWorking?: string;
  warnings: string[];
  fromCallout: string | null;
  handles: string[];
  status: RowStatus;
  /** What is missing and which input would complete it, for UNAVAILABLE rows. */
  missing?: string;
  /**
   * §6.4 — an UNAVAILABLE row is a FORMULA WITH A HOLE, never a blank: the
   * arithmetic with ⟨fact.id⟩ written into it, the fact ids that are MISSING
   * and the question for each. Rendered through renderBlockedRow so the
   * schedule and the Specification say the same thing about the same hole.
   */
  blocked?: BlockedRow;
  /** Member-type profile extras (§6.2 rule 5). */
  zone?: string;
  face?: string;
  direction?: string;
  crank?: string;
  /** engineering validation — a row can be computed and still not validated */
  engineering?: import('../../calculations/validation').EngineeringValidation;
}

// --- derived-per-drawing column set (§6.2) ---------------------------------

export interface ScheduleColumn {
  id: string;
  label: string;
  numeric: boolean;
}

const LEG_LABELS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

export function legCountOf(row: ScheduleRow): number {
  // Bend deductions (negative entries) are derivation lines, not leg columns.
  return row.segments.filter((s) => s.mm >= 0).length;
}

/**
 * Rules 1–6 of §6.2:
 * 1. a column appears only if at least one row has an evidenced value for it;
 * 2. leg columns expand to the longest segments[] and no further;
 * 3. Shape appears when more than one distinct shapeCode is present;
 * 4. Spacing where counts derive from spacing; Occurrences where they came
 *    from mark occurrences;
 * 5. member-type profiles add Zone / Face / Direction / Crank;
 * 6. order follows Indian commercial convention.
 */
export function deriveColumns(rows: ScheduleRow[]): ScheduleColumn[] {
  const has = (pick: (r: ScheduleRow) => unknown) =>
    rows.some((r) => {
      const v = pick(r);
      return v !== null && v !== undefined && v !== '';
    });

  const cols: ScheduleColumn[] = [];
  const push = (id: string, label: string, numeric = true) => cols.push({ id, label, numeric });

  push('mark', 'Mark', false);
  push('member', 'Member', false);
  if (has((r) => r.barType)) push('barType', 'Bar type', false);
  push('dia', 'Ø');

  const shapes = new Set(rows.map((r) => r.shapeCode).filter(Boolean));
  if (shapes.size > 1) push('shape', 'Shape', false);

  const maxLegs = rows.reduce((m, r) => Math.max(m, legCountOf(r)), 0);
  for (let i = 0; i < Math.min(maxLegs, LEG_LABELS.length); i++) {
    push(`leg:${LEG_LABELS[i]}`, LEG_LABELS[i]);
  }

  if (has((r) => r.zone)) push('zone', 'Zone', false);
  if (has((r) => r.face)) push('face', 'Face', false);
  if (has((r) => r.direction)) push('direction', 'Direction', false);
  if (has((r) => r.crank)) push('crank', 'Crank', false);

  push('cuttingLength', 'Cutting length');
  // every cutting length carries the cover it was cut to and where it came from
  if (has((r) => r.coverMm)) push('cover', 'Cover');
  if (has((r) => r.coverStatus ?? r.coverSource)) push('coverSource', 'Cover source', false);
  push('barsPerMember', 'No. per member');
  push('memberCount', 'Members');
  push('totalBars', 'Total no.');
  if (has((r) => r.spacingMm)) push('spacing', 'Spacing (c/c)');
  if (has((r) => r.occurrenceBand)) push('occurrences', 'Occurrences', false);
  push('totalLength', 'Total length');
  push('unitWeight', 'Unit wt');
  push('weight', 'Weight');
  return cols;
}

/** When only one shape is present it is stated in the header, not a column. */
export function singleShapeOf(rows: ScheduleRow[]): string | null {
  const shapes = new Set(rows.map((r) => r.shapeCode).filter(Boolean));
  return shapes.size === 1 ? [...shapes][0] : null;
}

export function cellValue(row: ScheduleRow, colId: string): string {
  const num = (v: number | null, dp = 0): string =>
    v === null ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (colId.startsWith('leg:')) {
    const label = colId.slice(4);
    const legs = row.segments.filter((s) => s.mm >= 0);
    const at = LEG_LABELS.indexOf(label);
    return at >= 0 && at < legs.length ? num(legs[at].mm) : '';
  }
  switch (colId) {
    case 'mark': return row.mark;
    case 'member': return row.member;
    case 'barType': return row.barType;
    case 'dia': return String(row.diaMm);
    case 'shape': return row.shapeCode;
    case 'zone': return row.zone ?? '';
    case 'face': return row.face ?? '';
    case 'direction': return row.direction ?? '';
    case 'crank': return row.crank ?? '';
    case 'cuttingLength': return num(row.cuttingLengthMm);
    case 'cover': return num(row.coverMm ?? null);
    case 'coverSource': {
      const status = row.coverStatus ?? '';
      const src = row.coverSource ?? '';
      const where =
        src === 'settings-default' ? 'project default' : src === 'user-override' ? 'your answer' : src === 'member-cover-table' ? 'cover table' : src;
      return `${status}${where ? ` (${where})` : ''}`.trim();
    }
    case 'barsPerMember': return num(row.barsPerMember);
    case 'memberCount': return num(row.memberCount);
    case 'totalBars': return num(row.totalBars);
    case 'spacing': return row.spacingMm === null ? '—' : num(row.spacingMm);
    case 'occurrences': return row.occurrenceBand ?? '';
    case 'totalLength': return row.totalLengthM === null ? '—' : num(row.totalLengthM, 1);
    case 'unitWeight': return row.unitWeightKgPerM === null ? '—' : num(row.unitWeightKgPerM, 3);
    case 'weight': return row.weightKg === null ? '—' : num(row.weightKg, 1);
    default: return '';
  }
}

// --- grouping + totals ------------------------------------------------------

export interface ScheduleGroupBlock {
  key: string;
  label: string;
  rows: ScheduleRow[];
  weightKg: number;
  incomplete: number;
}

export function groupRows(
  rows: ScheduleRow[],
  by: 'member' | 'dia' | 'shape',
): ScheduleGroupBlock[] {
  const keyOf = (r: ScheduleRow) =>
    by === 'dia' ? `${r.diaMm} mm` : by === 'shape' ? (r.shapeCode || '—') : r.member;
  const blocks = new Map<string, ScheduleGroupBlock>();
  // Grouping preserves the schedule's own row order inside each block.
  rows.forEach((r) => {
    const key = keyOf(r);
    let block = blocks.get(key);
    if (!block) {
      block = { key, label: key, rows: [], weightKg: 0, incomplete: 0 };
      blocks.set(key, block);
    }
    block.rows.push(r);
    if (r.weightKg !== null) block.weightKg += r.weightKg;
    else block.incomplete += 1;
  });
  return [...blocks.values()];
}

export interface SteelSummaryLine {
  diaMm: number;
  totalLengthM: number;
  weightKg: number;
}

/** The steel summary by diameter — the shape a fabricator orders from. */
export function steelSummary(rows: ScheduleRow[]): SteelSummaryLine[] {
  const byDia = new Map<number, SteelSummaryLine>();
  rows.forEach((r) => {
    let line = byDia.get(r.diaMm);
    if (!line) {
      line = { diaMm: r.diaMm, totalLengthM: 0, weightKg: 0 };
      byDia.set(r.diaMm, line);
    }
    line.totalLengthM += r.totalLengthM ?? 0;
    line.weightKg += r.weightKg ?? 0;
  });
  return [...byDia.values()].sort((a, b) => a.diaMm - b.diaMm);
}

export function scheduleTotalKg(rows: ScheduleRow[]): number {
  return rows.reduce((sum, r) => sum + (r.weightKg ?? 0), 0);
}

// --- blocked totals (§6.4) --------------------------------------------------
//
// "0.0 (+4 open)" is a lie told by a true number. Nothing weighed nothing; four
// rows could not be weighed at all, and a subtotal that leads with 0.0 reads as
// a member carrying no steel. Where EVERY row of a block is open, the block has
// no total — it has a question, and it says so.

const kg = (v: number): string =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** True when nothing in the block could be weighed — not when it weighs zero. */
export function isFullyBlocked(block: Pick<ScheduleGroupBlock, 'rows' | 'incomplete'>): boolean {
  return block.rows.length > 0 && block.incomplete === block.rows.length;
}

/** The distinct fact ids the open rows are waiting on, in first-seen order. */
export function blockedFactIds(rows: readonly ScheduleRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    for (const id of r.blocked?.missingFactIds ?? []) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** What a group's subtotal cell says — a figure, or the reason there is none. */
export function subtotalText(block: ScheduleGroupBlock): string {
  if (isFullyBlocked(block)) {
    const ids = blockedFactIds(block.rows);
    return (
      `blocked — ${block.incomplete} row${block.incomplete === 1 ? '' : 's'} open` +
      (ids.length ? `, waiting on ${ids.join(', ')}` : '')
    );
  }
  return kg(block.weightKg) + (block.incomplete ? ` (+${block.incomplete} open)` : '');
}

/**
 * What the schedule total says. A schedule with nothing weighable is BLOCKED —
 * printing "0.0 kg" of steel for a wall that plainly carries steel is the one
 * number this table must never show.
 */
export function scheduleTotalText(rows: readonly ScheduleRow[]): string {
  const open = rows.filter((r) => r.weightKg === null).length;
  if (rows.length > 0 && open === rows.length) {
    const ids = blockedFactIds(rows);
    return ids.length
      ? `blocked — no weight can be computed until ${ids.length} fact${ids.length === 1 ? '' : 's'} ` +
          `${ids.length === 1 ? 'is' : 'are'} answered: ${ids.join(', ')}`
      : `blocked — every row is open; no weight can be computed`;
  }
  const total = rows.reduce((sum, r) => sum + (r.weightKg ?? 0), 0);
  return `${kg(total)} kg${open ? ` · ${open} row${open === 1 ? '' : 's'} still open` : ''}`;
}
