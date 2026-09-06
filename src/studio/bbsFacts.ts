// The joint between the project fact ledger and the BBS engine.
//
// HOW_TO_BUILD_IT §6.3 describes one loop and the product had it built in two
// halves that never touched:
//
//     ledger ──▶ projectFacts ──▶ runOrchestrator ──▶ escalations ──▶ ledger
//                (this module)                        (this module)
//
// Without the left arm every run began with "PROJECT RUN: none was supplied",
// so a wall whose length the client had already given was measured as nothing
// and every weight came out 0.000. Without the right arm the questions the run
// raised died in the run log, so they could not be answered and the next run
// began exactly as blind.
//
// Everything here is PURE. No model call, no storage, no React — realData.ts
// supplies the ledger and takes the facts back.

import type { BbsChatRow } from '../cad/bbs/chatResult';
import type { EngineFact, EngineFactSource } from '../cad/bbs/refs';
import type { BbsSettings } from '../cad/bbs/types';
import type { Ledger } from '../facts/ledger';
import { resolveFact } from '../facts/ledger';
import type { BlockedRow } from '../facts/blocked';
import { isUsable, type Fact, type FactSource } from '../facts/types';
import { checkManifestFreshness, type BBSBuildManifest } from '../core/bbs/schemas';

// ------------------------------------------------------------
// fact ids ⇄ engine fact keys
// ------------------------------------------------------------
//
// The ledger keys facts as "<subject>.<name>" (§6.2). The engine's userFacts
// are flat keys the orchestrator names in a `{kind:'user-fact', factId}` ref —
// `run`, `c1_height`, `f1_depth` — the shape tests/live/gamco4.livetest.ts
// proved. This is the translation, and it is the only place it happens.

export type Axis = 'L' | 'W' | 'H';

/** Which member axis a fact name answers. A footing's DEPTH is its H. */
const AXIS_OF_NAME: Record<string, Axis> = {
  height: 'H',
  depth: 'H',
  h: 'H',
  length: 'L',
  plan_l: 'L',
  l: 'L',
  width: 'W',
  plan_w: 'W',
  section_w: 'W',
  thickness: 'W',
  w: 'W',
};

export const NAME_OF_AXIS: Record<Axis, string> = { L: 'length', W: 'width', H: 'height' };

/** "wall.total_run" → "wall"; a dotless id is its own subject. */
function subjectOf(id: string): string {
  const dot = id.indexOf('.');
  return dot === -1 ? id : id.slice(0, dot);
}

function nameOf(id: string): string {
  const dot = id.indexOf('.');
  return dot === -1 ? '' : id.slice(dot + 1);
}

/**
 * The engine key for a ledger fact id. `wall.total_run` is the run the whole
 * schedule multiplies by, and the engine has always called it `run`; every
 * other fact keeps its own shape, lower-cased and flattened.
 */
export function engineKeyForFactId(id: string): string {
  if (id === 'wall.total_run') return 'run';
  return id.toLowerCase().replace(/\./g, '_');
}

/** The ledger id for an engine key — only `run` is special-cased. */
export function factIdForEngineKey(key: string): string {
  return key === 'run' ? 'wall.total_run' : key;
}

/** The axis a fact id answers, when it answers one. */
export function axisOfFactId(id: string): Axis | null {
  return AXIS_OF_NAME[nameOf(id).toLowerCase()] ?? null;
}

/** The ledger id for one member axis: C1 + H → "C1.height". */
export function factIdForAxis(mark: string, axis: Axis): string {
  return `${mark}.${NAME_OF_AXIS[axis]}`;
}

// ------------------------------------------------------------
// ledger → projectFacts
// ------------------------------------------------------------

export interface UsedProjectFact {
  /** the flat key the engine sees, e.g. "c1_height" */
  engineKey: string;
  /** the ledger id it came from, e.g. "C1.height" */
  factId: string;
  /** the member mark the id names, when the id names one */
  mark: string;
  /** the member axis it answers, when it answers one */
  axis: Axis | null;
  mm: number;
}

export interface ProjectFactsFromLedger {
  facts: Record<string, EngineFact>;
  used: UsedProjectFact[];
  /** ids that carry a value but not one a dimension can be read from */
  skipped: string[];
}

/** A fact's millimetre value, or null when it is not a length at all. */
function millimetresOf(fact: Fact): number | null {
  const raw =
    typeof fact.value === 'number'
      ? fact.value
      : typeof fact.value === 'string' && /^-?\d+(\.\d+)?$/.test(fact.value.trim())
        ? Number(fact.value.trim())
        : null;
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
  const unit = (fact.unit ?? 'mm').trim().toLowerCase();
  if (unit === 'm' || unit === 'metre' || unit === 'metres' || unit === 'meter') return raw * 1000;
  if (unit === 'cm') return raw * 10;
  if (unit === 'mm' || unit === '') return raw;
  return null; // kg, degrees, counts — real facts, but not dimensions
}

/**
 * Every fact the run is allowed to compute with (§6.4: MEASURED, DECLARED,
 * DERIVED or SUPPLIED, and NOT contradicted), expressed as the engine's
 * userFacts. A MISSING or contradicted fact never reaches the engine — that is
 * the whole point of the rule; it blocks instead.
 */
/**
 * The engine's provenance for a ledger state. A reading is a reading whether
 * the model read it or the table parser did; a person's word is USER_INPUT;
 * arithmetic is DERIVED. Nothing here is ASSUMED — an assumption is made by
 * the engine at compute time and marked there, never filed as a fact.
 */
export function engineSourceOf(state: Fact['state']): EngineFactSource | undefined {
  switch (state) {
    case 'MEASURED':
    case 'DECLARED':
      return 'DRAWING_READ';
    case 'DERIVED':
      return 'DERIVED';
    case 'SUPPLIED':
      return 'USER_INPUT';
    default:
      return undefined;
  }
}

export function projectFactsFromLedger(ledger: Ledger): ProjectFactsFromLedger {
  const facts: Record<string, EngineFact> = {};
  const used: UsedProjectFact[] = [];
  const skipped: string[] = [];
  for (const entry of ledger.entries) {
    const fact = entry.fact;
    if (fact.supersededBy !== undefined) continue;
    if (!isUsable(fact)) continue;
    const mm = millimetresOf(fact);
    if (mm === null) {
      skipped.push(fact.id);
      continue;
    }
    const engineKey = engineKeyForFactId(fact.id);
    if (facts[engineKey] !== undefined) continue;
    const saidAs = fact.saidAs ?? describeProvenance(fact);
    const source = engineSourceOf(fact.state);
    const sourceText = fact.source?.rawText;
    facts[engineKey] = {
      mm,
      ...(saidAs ? { saidAs } : {}),
      ...(source ? { source } : {}),
      ...(sourceText ? { sourceText } : {}),
      factId: fact.id,
    };
    used.push({
      engineKey,
      factId: fact.id,
      mark: subjectOf(fact.id),
      axis: axisOfFactId(fact.id),
      mm,
    });
  }
  return { facts, used, skipped };
}

/**
 * The settings a PERSON stated, as the engine's own settings patch.
 *
 * `projectFactsFromLedger` above carries lengths — everything that answers a
 * dimension. A grade, a cover, a wastage percentage or a lap multiple is not a
 * dimension, so it was dropped into `skipped` and the schedule was computed at
 * DEFAULT_SETTINGS while the chat told the person their answer was applied.
 * This is the second arm of the same joint: what they said about HOW to
 * compute, handed to `settingsFromExtract` as the caller's word, which
 * outranks both the defaults and the sheet.
 *
 * Only ids under `settings.` are read, and only values that survive their own
 * type check. A fact the ledger holds but this cannot type is left alone: it
 * stays in the Specification, and nothing pretends it reached the arithmetic.
 */
export function settingsFromLedger(ledger: Ledger): {
  settings: Partial<BbsSettings>;
  used: string[];
} {
  const settings: Partial<BbsSettings> = {};
  const used: string[] = [];
  const take = (id: string, apply: (fact: Fact) => boolean) => {
    for (const entry of ledger.entries) {
      const fact = entry.fact;
      if (fact.supersededBy !== undefined || !isUsable(fact)) continue;
      if (fact.id.toLowerCase() !== id) continue;
      if (apply(fact)) used.push(fact.id);
      return;
    }
  };
  const numberOf = (fact: Fact): number | null => {
    const raw =
      typeof fact.value === 'number'
        ? fact.value
        : typeof fact.value === 'string' && /^-?\d+(\.\d+)?$/.test(fact.value.trim())
          ? Number(fact.value.trim())
          : null;
    return raw !== null && Number.isFinite(raw) ? raw : null;
  };
  const textOf = (fact: Fact): string | null => {
    const raw = typeof fact.value === 'string' ? fact.value.trim() : null;
    return raw ? raw : null;
  };

  // Cover is stated in millimetres, and `millimetresOf` already knows how to
  // read "0.04 m" as 40 — so it is the one that goes through the same reader.
  take('settings.cover', (fact) => {
    const mm = millimetresOf(fact);
    if (mm === null) return false;
    settings.coverMm = mm;
    return true;
  });
  take('settings.concrete_grade', (fact) => {
    const grade = textOf(fact);
    if (!grade || !/^M\s*\d{2,3}$/i.test(grade)) return false;
    settings.concreteGrade = grade.toUpperCase().replace(/\s+/g, '');
    return true;
  });
  take('settings.steel_grade', (fact) => {
    const grade = textOf(fact);
    if (!grade || !/^Fe\s*\d{3}D?$/i.test(grade)) return false;
    settings.steelGrade = grade.replace(/\s+/g, '').replace(/^fe/i, 'Fe').toUpperCase().replace(/^FE/, 'Fe');
    return true;
  });
  take('settings.wastage_pct', (fact) => {
    const pct = numberOf(fact);
    if (pct === null || pct < 0 || pct > 25) return false;
    settings.wastagePct = pct;
    return true;
  });
  // "LAPS SHOULD BE 50 D" as a project convention — the multiple, not a length.
  take('settings.lap_multiple', (fact) => {
    const multiple = numberOf(fact);
    if (multiple === null || multiple <= 0 || multiple > 100) return false;
    settings.ldMultiple = multiple;
    return true;
  });

  return { settings, used };
}

/** A one-line "where this came from" for a fact with no words of its own. */
function describeProvenance(fact: Fact): string {
  if (fact.state === 'MEASURED' && fact.method) return `measured: ${fact.method}`;
  if (fact.state === 'DERIVED' && fact.basis) return `derived: ${fact.basis}`;
  if (fact.source) {
    return `${fact.state.toLowerCase()} on ${[fact.source.drawingNumber, fact.source.revision]
      .filter(Boolean)
      .join(' ')}`.trim();
  }
  return `${fact.state.toLowerCase()} · ${fact.id}`;
}

export const BASE_OBJECTIVE = 'Produce a complete bar bending schedule for this drawing.';

/**
 * The objective that made a live run actually POINT at the client's answers
 * instead of asking for them again (tests/live/gamco4.livetest.ts, run 4).
 *
 * The facts alone were not enough: the model saw them listed and still left
 * axes unresolved. What changed the behaviour was naming the axis-to-fact map
 * in the objective — "C1 H → c1_height" — and saying plainly that re-asking
 * wastes an answer already given. That teaching is reproduced here from the
 * facts actually on the ledger, so it can never name a fact that is not there.
 */
export function bbsObjective(used: readonly UsedProjectFact[], base = BASE_OBJECTIVE): string {
  if (!used.length) return base;
  const axisMap = used
    .filter((u) => u.axis !== null && u.engineKey !== 'run')
    .map((u) => `${u.mark} ${u.axis} → ${u.engineKey}`);
  const parts = [
    base,
    'The client has already answered open questions from earlier readings of this project; ' +
      'their answers are the project facts listed below, and each one is on the record with its provenance.',
    'IMPORTANT: for any member axis or dimension the sheet does not legibly dimension, point the ' +
      "dimension conclusion at the matching project fact with a {kind:'user-fact', factId:'…'} " +
      'reference — do NOT ask again and do NOT leave the axis unresolved.',
  ];
  if (axisMap.length) parts.push(`The axis-to-fact map: ${axisMap.join(', ')}.`);
  const others = used.filter((u) => u.axis === null || u.engineKey === 'run');
  if (others.length) {
    parts.push(
      `Also on the record: ${others.map((u) => `${u.engineKey} = ${u.mm} mm`).join(', ')}.`,
    );
  }
  parts.push(
    'Anything still not answered is a question for the client: record it with askUser so it reaches ' +
      'them, rather than assuming a number.',
  );
  return parts.join(' ');
}

// ------------------------------------------------------------
// which fact does a blocked row want? (§6.4)
// ------------------------------------------------------------
//
// The engine says WHY a row could not be cut, in its own words, on the row
// itself (`missing` → BbsChatRow.note). Those sentences are written in
// src/cad/bbs/build.ts and they name the axis: "member H dimension not on this
// sheet", "member cross-section (L × W) not on this sheet", "the TOTAL RUN has
// not been answered". Reading them back is a translation, not a guess — and
// where the sentence names no axis, the member's own undefined axes do.

const RUN_FACT_ID = 'wall.total_run';

function axesFromNote(note: string): Axis[] {
  const out = new Set<Axis>();
  if (/total[\s-]*run|\brun\b[^.]*answered/i.test(note)) return [];
  const single = /member\s+([LWH])\s+dimension/.exec(note);
  if (single) out.add(single[1] as Axis);
  const section = /cross-section\s*\(\s*([LWH])\s*[×x]\s*([LWH])\s*\)/i.exec(note);
  if (section) {
    out.add(section[1].toUpperCase() as Axis);
    out.add(section[2].toUpperCase() as Axis);
  }
  if (/member\s+HEIGHT/i.test(note)) out.add('H');
  return [...out];
}

function needsRun(note: string): boolean {
  return /total[\s-]*run/i.test(note);
}

/**
 * The axis a blocked row BLAMES — one that has a value, and whose value the
 * engine has just proved cannot be a bar length.
 *
 * `axesFromNote` reads the sentences about an axis that is ABSENT. This reads
 * the other kind, and they need separating because the register's response to
 * them is opposite: an absent axis is asked about, a present one is not (a
 * fact on the record is never re-asked, which is right). The Ld gate in
 * build.ts writes "measured along the member's H = 100 mm, which is under the
 * 752 mm development length …" — it has already done the work of naming which
 * value is wrong and why. Left unread, that sentence went to the Status column
 * of a spreadsheet and nowhere else, and the row could never be unblocked by
 * anybody.
 */
export interface BlamedAxis {
  axis: Axis;
  /** what that axis is on record as, per the engine's own sentence */
  heldMm: number | null;
  /** the cutting length it produced */
  cameOutMm: number | null;
  /** the anchorage the bar needs, which it fell short of */
  needsMm: number | null;
}

export function blamedAxisFromNote(note: string): BlamedAxis | null {
  const m = /measured along the member['’]s\s+([LWH])(?:\s*=\s*(-?[\d.]+)\s*mm)?/i.exec(note);
  if (!m) return null;
  const num = (re: RegExp): number | null => {
    const hit = re.exec(note);
    const n = hit ? Number(hit[1]) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return {
    axis: m[1].toUpperCase() as Axis,
    heldMm: m[2] !== undefined && Number.isFinite(Number(m[2])) ? Number(m[2]) : null,
    cameOutMm: num(/comes out\s+(-?[\d.]+)\s*mm long/i),
    needsMm: num(/under the\s+(-?[\d.]+)\s*mm development length/i),
  };
}

/**
 * The question to put about a disputed axis: what it is on record as, why the
 * engine will not use it, and the number to give instead. It states the held
 * value because a person asked "what is the height of P1?" for the second time
 * will answer 100 again — they already told us 100. What they have not been
 * told is that 100 is what broke it.
 */
export function askForBlamedAxis(mark: string, blamed: BlamedAxis): string {
  const name = NAME_OF_AXIS[blamed.axis];
  const held = blamed.heldMm !== null ? `${blamed.heldMm} mm` : 'the value on record';
  const short =
    blamed.needsMm !== null
      ? `a bar measured along it comes out ${blamed.cameOutMm !== null ? `${blamed.cameOutMm} mm` : 'too short'}, ` +
        `under the ${blamed.needsMm} mm it needs to anchor (IS 456 cl 26.2.1)`
      : 'a bar measured along it comes out too short to anchor';
  return (
    `${mark} ${name} is on record as ${held}, but ${short} — so that figure cannot be this bar's ` +
    `length. What is the real ${name} of ${mark}, in mm? ` +
    '(If the figure is right, then the bars run along a different axis and it is the bar, not the ' +
    'dimension, that needs correcting.)'
  );
}

/** A note that is about a missing MEASUREMENT, as against a bad shape code. */
const DIMENSION_SHAPED =
  /\baxes\b|\baxis\b|dimension|cross-section|not on this sheet|not resolved|not answered/i;

/** The ask that goes with a hole — the exact question to put to a person. */
export function askForFactId(id: string, mark: string, axis: Axis | null): string {
  if (id === RUN_FACT_ID) {
    return 'What is the total run of the wall, end to end? Every per-running-metre quantity multiplies by it.';
  }
  if (axis) {
    return `What is the ${NAME_OF_AXIS[axis]} of ${mark}? This sheet carries no dimension for it.`;
  }
  return `What is ${id}?`;
}

export interface RowHole {
  factId: string;
  mark: string;
  axis: Axis | null;
  ask: string;
}

/**
 * The facts one blocked row is waiting on. Empty for a row that computed —
 * a row with a length is never blocked, whatever else is imperfect about it.
 */
export function holesForRow(
  row: Pick<BbsChatRow, 'status' | 'note' | 'memberMark'>,
  memberDims?: { L?: number; W?: number; H?: number },
): RowHole[] {
  if (row.status !== 'unavailable') return [];
  const note = row.note ?? '';
  const holes: RowHole[] = [];
  const add = (factId: string, mark: string, axis: Axis | null) => {
    if (holes.some((h) => h.factId === factId)) return;
    holes.push({ factId, mark, axis, ask: askForFactId(factId, mark, axis) });
  };
  if (needsRun(note)) add(RUN_FACT_ID, 'wall', null);
  for (const axis of axesFromNote(note)) {
    add(factIdForAxis(row.memberMark, axis), row.memberMark, axis);
  }
  if (!holes.length && memberDims && DIMENSION_SHAPED.test(note)) {
    // "fewer than two axes are on this sheet" and its kin name no axis: the
    // member's own undefined axes are the holes, and they are not a guess.
    // A row blocked on something else — an unreadable shape code, a cover that
    // leaves no room — names no fact, because no fact would unblock it.
    for (const axis of ['H', 'L', 'W'] as Axis[]) {
      const v = memberDims[axis];
      if (typeof v !== 'number' || !(v > 0)) add(factIdForAxis(row.memberMark, axis), row.memberMark, axis);
    }
  }
  return holes;
}

/**
 * §6.4's shape for one row: the formula with its hole named. The lines the
 * engine itself wrote are kept verbatim — nothing here re-derives a number —
 * and the hole is written into the arithmetic as ⟨fact.id⟩ so what is unknown
 * reads as part of the sum rather than as a dash.
 */
export function blockedRowFor(
  row: Pick<BbsChatRow, 'status' | 'note' | 'memberMark' | 'barMark' | 'working' | 'unitWeightKgPerM' | 'totalBars' | 'barsPerMember' | 'memberCount' | 'spacingMm'>,
  memberDims?: { L?: number; W?: number; H?: number },
): BlockedRow | null {
  const holes = holesForRow(row, memberDims);
  if (!holes.length) return null;
  const gap = holes.map((h) => `⟨${h.factId}⟩`).join(' , ');
  const lines: string[] = [];
  for (const line of row.working ?? []) {
    if (/^weight:/i.test(line)) continue;
    lines.push(line);
  }
  lines.push(`cutting length  =  f(${gap})`);
  const count =
    row.totalBars && row.totalBars > 0
      ? `${row.totalBars}`
      : row.spacingMm
        ? `⌈ ${gap} / ${row.spacingMm} ⌉ + 1`
        : '⟨number⟩';
  if (!row.totalBars) {
    lines.push(
      `no. per member  =  ${count}${row.spacingMm ? ` at ${row.spacingMm} mm c/c` : ''}`,
    );
  }
  const unit = row.unitWeightKgPerM ? row.unitWeightKgPerM.toFixed(3) : '⟨unit wt⟩';
  lines.push(`weight  =  cutting length × ${unit} kg/m × ${count}`);
  return {
    formula: lines.join('\n'),
    missingFactIds: holes.map((h) => h.factId),
    ask: holes.map((h) => h.ask),
  };
}

/**
 * The minimum of an engine result this module reads. Structural on purpose:
 * BbsChatResult grows fields (the engine is worked on in parallel) and none of
 * them change which fact a blocked row is waiting on.
 */
export interface ScheduleShape {
  members: readonly {
    mark: string;
    dims: { L?: number; W?: number; H?: number };
  }[];
  rows: readonly Pick<
    BbsChatRow,
    | 'id'
    | 'barMark'
    | 'memberMark'
    | 'status'
    | 'note'
    | 'working'
    | 'unitWeightKgPerM'
    | 'totalBars'
    | 'barsPerMember'
    | 'memberCount'
    | 'spacingMm'
  >[];
}

/** Blocked rows for a whole result, keyed by the engine's row id (barMark). */
export function blockedRowsOf(result: ScheduleShape): Map<string, BlockedRow> {
  const dims = new Map(result.members.map((m) => [m.mark, m.dims] as const));
  const out = new Map<string, BlockedRow>();
  for (const row of result.rows) {
    const blocked = blockedRowFor(row, dims.get(row.memberMark));
    if (blocked) out.set(row.id, blocked);
  }
  return out;
}

/**
 * The axes a finished run DISPUTES: on record with a value, and named by a
 * blocked row as the reason it could not be cut.
 *
 * Kept apart from `missingFactsFromRun` because the two file opposite things.
 * A missing axis becomes a MISSING fact and is skipped if anything is already
 * on the record — "a fact already on the record is never re-asked", which is
 * what stops an interview repeating itself. A disputed axis is precisely the
 * case where the thing on the record is the problem, so it is reopened
 * instead: `disputeFact` marks it contradicted and it blocks like MISSING
 * until a person says what the number really is.
 */
export interface AxisDispute {
  factId: string;
  mark: string;
  axis: Axis;
  /** the engine's own sentence, verbatim — why this value cannot stand */
  reason: string;
  ask: string;
  /** the rows waiting on it */
  blocks: string[];
}

export function axisDisputesFromRun(result: ScheduleShape): AxisDispute[] {
  const dims = new Map(result.members.map((m) => [m.mark, m.dims] as const));
  const out = new Map<string, AxisDispute>();
  for (const row of result.rows) {
    if (row.status !== 'unavailable') continue;
    const note = row.note ?? '';
    const blamed = blamedAxisFromNote(note);
    if (!blamed) continue;
    // An axis with no value is a HOLE, not a dispute — there is nothing on the
    // record to reopen, and missingFactsFromRun already asks for it.
    const held = dims.get(row.memberMark)?.[blamed.axis];
    if (typeof held !== 'number' || !(held > 0)) continue;
    const factId = factIdForAxis(row.memberMark, blamed.axis);
    const label = `${row.memberMark} row ${row.barMark}`;
    const existing = out.get(factId);
    if (existing) {
      if (!existing.blocks.includes(label)) existing.blocks.push(label);
      continue;
    }
    out.set(factId, {
      factId,
      mark: row.memberMark,
      axis: blamed.axis,
      reason: note,
      ask: askForBlamedAxis(row.memberMark, blamed),
      blocks: [label],
    });
  }
  return [...out.values()];
}

/**
 * The settings NOBODY supplied — neither the sheet nor the person — that the
 * schedule nonetheless computed on.
 *
 * These are not dimensions and they never came back as blocked rows, which is
 * exactly how they escaped notice: a schedule built at M25 / Fe500 / 50 mm
 * cover looks identical to one built on three readings, and prints those
 * figures in its header as though the drawing had said them. They are not
 * cosmetic. The two grades derive the development length — the gate that
 * decides whether a bar is long enough to be a bar — and cover sits in every
 * stirrup arm.
 *
 * So they are asked about, like any other gap. The schedule still computes:
 * refusing to produce one would trade a schedule honest about an assumption
 * for no schedule at all, and every row that used a defaulted cover already
 * carries the warning that marks it INFERRED.
 */
export interface AssumedSetting {
  factId: string;
  /** what the run computed with */
  usedValue: string;
  ask: string;
}

const SETTING_QUESTIONS: Record<string, (used: string) => { factId: string; ask: string }> = {
  coverMm: (used) => ({
    factId: 'settings.cover',
    ask:
      `What is the clear cover, in mm? The schedule computed at ${used} mm — the project default, ` +
      'not something this drawing states. Cover is in every stirrup arm, so each link is only as ' +
      'right as that figure.',
  }),
  concreteGrade: (used) => ({
    factId: 'settings.concrete_grade',
    ask:
      `What is the concrete grade? The schedule computed at ${used} — the project default, not ` +
      'something this drawing states. It sets the bond stress the development length comes out of ' +
      '(IS 456 Table 21), so it decides every lap and anchorage on the sheet.',
  }),
  steelGrade: (used) => ({
    factId: 'settings.steel_grade',
    ask:
      `What is the steel grade? The schedule computed at ${used} — the project default, not ` +
      'something this drawing states. It sets the development length with the concrete grade, and ' +
      'the unit weights are read from it.',
  }),
};

export function assumedSettings(
  sources: Readonly<Record<string, string | undefined>>,
  settings: object,
): AssumedSetting[] {
  const values = settings as Readonly<Record<string, unknown>>;
  const out: AssumedSetting[] = [];
  for (const [key, question] of Object.entries(SETTING_QUESTIONS)) {
    if (sources[key] !== 'default') continue;
    const value = values[key];
    if (value === undefined || value === null) continue;
    const usedValue = String(value);
    out.push({ ...question(usedValue), usedValue });
  }
  return out;
}

/**
 * The answers that are not dimensions — figures a person typed for one BAR,
 * which replace what the engine would derive rather than feeding it.
 *
 * `projectFactsFromLedger` cannot carry these. It is keyed by engine key and
 * every value it produces is a millimetre reading the model points AT; a
 * cutting length is the opposite, an instruction not to derive one. `buildBbs`
 * has always taken them and marked the row ENTERED — the wire from the ledger
 * to that argument is what did not exist, so answering "the drawing says ENTER
 * DESIGN LENGTH — what is it?" changed nothing at all.
 *
 * Only the cutting length for now, because that is the field a sheet actually
 * declares as an input. The shape is the overrides store's own, so the rest
 * can join it without a second translation table.
 */
export function overridesFromLedger(ledger: Ledger): {
  bars: Record<string, { cuttingLengthMm: number }>;
  used: string[];
} {
  const bars: Record<string, { cuttingLengthMm: number }> = {};
  const used: string[] = [];
  for (const entry of ledger.entries) {
    const fact = entry.fact;
    if (fact.supersededBy !== undefined || !isUsable(fact)) continue;
    const m = /^(.+)\.cutting_length$/i.exec(fact.id);
    if (!m) continue;
    const mm = millimetresOf(fact);
    if (mm === null || !(mm > 0)) continue;
    const mark = m[1].toUpperCase();
    if (bars[mark] !== undefined) continue;
    bars[mark] = { cuttingLengthMm: mm };
    used.push(fact.id);
  }
  return { bars, used };
}

// ------------------------------------------------------------
// run → MISSING facts (§6.3 "record F as MISSING with what was searched")
// ------------------------------------------------------------

export interface RunEscalation {
  question: string;
  whyNeeded: string;
}

export interface MissingFactsInput {
  result: ScheduleShape;
  /** the questions the orchestrator escalated to a person */
  escalations: readonly RunEscalation[];
  /** axes/things the run recorded as unresolved rather than asked about */
  unresolved: readonly string[];
  /** where the run looked — drawing, revision, sections, what it read */
  lookedIn: readonly string[];
  /** ISO date the run happened */
  readOn: string;
  /**
   * The drawing the run read. Stamped onto every gap it files, so an open
   * question lands on the specification of the drawing that raised it rather
   * than on every drawing in the project.
   */
  source?: FactSource;
}

/** Words that identify which axis a free-text question is about. */
const AXIS_WORDS: { re: RegExp; axis: Axis }[] = [
  { re: /\bheights?\b|\btall\b/i, axis: 'H' },
  { re: /\bdepths?\b|\bdeep\b/i, axis: 'H' },
  { re: /\bwidths?\b|\bwide\b|\bthick(ness)?\b/i, axis: 'W' },
  { re: /\blengths?\b|\blong\b/i, axis: 'L' },
];

function slug(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return (words.slice(0, 4).join('_') || 'question').slice(0, 48);
}

const STOPWORDS = new Set([
  'the', 'what', 'which', 'does', 'how', 'many', 'and', 'for', 'this', 'that',
  'are', 'was', 'were', 'has', 'have', 'its', 'from', 'with', 'not', 'any',
  'you', 'please', 'confirm', 'there', 'they', 'them',
]);

/**
 * The ledger id a free-text question is about. A question naming a member and
 * an axis IS that member's axis fact; a question about the run is the run; and
 * a question about anything else is kept as an open question under its own id
 * rather than forced into a shape it does not have.
 */
export function factIdForQuestion(question: string, marks: readonly string[]): {
  id: string;
  mark: string;
  axis: Axis | null;
} {
  const text = question;
  if (/total[\s-]*run|overall (length|extent)|how long is the (wall|boundary)/i.test(text)) {
    return { id: RUN_FACT_ID, mark: 'wall', axis: null };
  }
  // The orchestrator's own idiom for an axis it could not resolve: "C1 H",
  // "SC H", "F1 L" — a mark and a bare axis letter, side by side.
  const shorthand = /\b([A-Z][A-Z0-9]{0,4})\s+([HLW])\b(?![a-z])/.exec(text);
  if (shorthand) {
    const mark = shorthand[1];
    const axis = shorthand[2] as Axis;
    return { id: factIdForAxis(mark, axis), mark, axis };
  }
  const known =
    [...marks]
      .sort((a, b) => b.length - a.length)
      .find((m) => new RegExp(`(^|[^A-Za-z0-9])${escapeRe(m)}([^A-Za-z0-9]|$)`, 'i').test(text)) ?? null;
  const axis = AXIS_WORDS.find((w) => w.re.test(text))?.axis ?? null;
  // A mark the schedule does not carry is still a mark: a question about C2 on
  // a run that never established C2 is exactly the question worth keeping, and
  // it must land on the id the NEXT run will look for.
  const mark = known ?? (axis ? markShapedIn(text) : null);
  if (mark && axis) return { id: factIdForAxis(mark, axis), mark, axis };
  return { id: `open.${slug(text)}`, mark: mark ?? 'open', axis };
}

/** Bar callouts (T16, Y12) and code references (IS 456) are never member marks. */
const NOT_A_MARK = /^(T|Y|R|D|M|IS|SP)\d+$/i;

function markShapedIn(text: string): string | null {
  const re = /\b([A-Z]{1,3}[0-9]{1,2})\b/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(text)) !== null) {
    if (!NOT_A_MARK.test(hit[1])) return hit[1];
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Everything a finished run learned it does NOT know, as MISSING facts ready
 * for recordFact: the holes its own blocked rows are waiting on, the questions
 * it escalated, and the axes it recorded as unresolved. Each carries the ask,
 * where the run searched, and the member marks and row ids it blocks — which
 * is what makes the Specification's open question answerable rather than a
 * line in a log nobody reads.
 *
 * Facts already on the ledger under the same id are left alone: a run never
 * overwrites an answer, and never asks twice for the same thing.
 */
export function missingFactsFromRun(input: MissingFactsInput, ledger: Ledger): Fact[] {
  const marks = input.result.members.map((m) => m.mark);
  const dims = new Map(input.result.members.map((m) => [m.mark, m.dims] as const));

  interface Draft {
    id: string;
    mark: string;
    axis: Axis | null;
    ask: string;
    blocks: string[];
  }
  const drafts = new Map<string, Draft>();
  const draft = (id: string, mark: string, axis: Axis | null, ask: string): Draft => {
    const existing = drafts.get(id);
    if (existing) return existing;
    const made: Draft = { id, mark, axis, ask, blocks: [] };
    drafts.set(id, made);
    return made;
  };

  // 1. the holes the schedule's own blocked rows are standing on
  for (const row of input.result.rows) {
    for (const hole of holesForRow(row, dims.get(row.memberMark))) {
      const d = draft(hole.factId, hole.mark, hole.axis, hole.ask);
      const label = `${row.memberMark} row ${row.barMark}`;
      if (!d.blocks.includes(label)) d.blocks.push(label);
    }
  }

  // 2. the questions the run put to a person, verbatim
  for (const e of input.escalations) {
    const { id, mark, axis } = factIdForQuestion(e.question, marks);
    const d = draft(id, mark, axis, e.question.trim());
    if (e.whyNeeded && !d.blocks.includes(e.whyNeeded)) d.blocks.push(e.whyNeeded.trim());
  }

  // 3. what it recorded as unresolved rather than asking about
  for (const line of input.unresolved) {
    const { id, mark, axis } = factIdForQuestion(line, marks);
    const d = draft(id, mark, axis, askForFactId(id, mark, axis));
    const why = `recorded unresolved by the run: ${line.trim()}`;
    if (!d.blocks.includes(why)) d.blocks.push(why);
  }

  const out: Fact[] = [];
  for (const d of drafts.values()) {
    // A fact already on the record is never re-asked — answered or not.
    if (resolveFact(ledger, d.id) !== undefined) continue;
    out.push({
      id: d.id,
      value: null,
      ...(d.axis ? { unit: 'mm' } : {}),
      state: 'MISSING',
      neededFor: d.blocks.length ? d.blocks : ['the bar bending schedule'],
      lookedIn: [...input.lookedIn],
      ask: d.ask,
      readOn: input.readOn,
      ...(input.source ? { source: input.source } : {}),
    });
  }
  return out;
}

// ------------------------------------------------------------
// answers since the schedule was built (§6.3, the resolution loop closes)
// ------------------------------------------------------------

/** Every fact id the engine could compute with right now. */
export function usableFactIds(ledger: Ledger): string[] {
  const out: string[] = [];
  for (const e of ledger.entries) {
    if (e.fact.supersededBy === undefined && isUsable(e.fact)) out.push(e.fact.id);
  }
  return out;
}

/**
 * Which facts have become usable since a baseline was taken — the answers that
 * have arrived since the schedule was built. It is deliberately NOT a trigger:
 * a rebuild spends model calls, so the tab offers it and the person decides.
 */
export function answersSince(ledger: Ledger, baseline: readonly string[]): string[] {
  const had = new Set(baseline);
  return usableFactIds(ledger).filter((id) => !had.has(id));
}

/**
 * Current ledger sequence numbers for all usable facts: factId -> seq
 */
export function currentFactVersions(ledger: Ledger): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const entry of ledger.entries) {
    if (entry.fact.supersededBy === undefined && isUsable(entry.fact)) {
      versions[entry.fact.id] = entry.seq;
    }
  }
  return versions;
}

/**
 * Returns the fact IDs that have changed, been superseded/withdrawn, or newly arrived
 * since the given manifest was built. If non-empty, the schedule is STALE.
 */
export function staleFacts(
  ledger: Ledger,
  manifest: BBSBuildManifest,
  currentDrawingHash?: string,
): string[] {
  const curVersions = currentFactVersions(ledger);
  const hash = currentDrawingHash ?? manifest.drawingHash;
  const result = checkManifestFreshness(manifest, curVersions, hash);
  // A changed drawing stales EVERY row whatever the facts did — it is named
  // as its own entry so the banner and the recalculation can say so.
  return result.drawingChanged ? [DRAWING_CHANGED, ...result.staleFactIds] : result.staleFactIds;
}

/** the pseudo fact id `staleFacts` reports when the drawing bytes themselves changed */
export const DRAWING_CHANGED = 'drawing.hash';

/**
 * The manifest, stamped with the ledger's own sequence numbers.
 *
 * The engine names which fact ids each row read; only the ledger knows which
 * VERSION of each was current when the schedule became current. Every fact
 * usable at this moment goes into the baseline — the ones the rows read AND
 * the rest — so any later answer, override or withdrawal changes a sequence
 * the manifest holds and the schedule is STALE, never silently current. The
 * per-row `rowDeps` are kept as the engine wrote them, so the stale ROWS can
 * be named rather than only the stale facts.
 */
export function stampManifest(
  manifest: BBSBuildManifest,
  ledger: Ledger,
  drawingHash?: string,
): BBSBuildManifest {
  const versions = currentFactVersions(ledger);

  // ONE KEY SPACE, OR THE SCHEDULE IS STALE FOREVER.
  //
  // The engine records its dependencies as ENGINE KEYS — `f1_width`, `run` —
  // because that is how `userFacts` reaches it. The ledger keys the same facts
  // as `F1.width` and `wall.total_run`. A manifest holding both is compared
  // against a ledger that only speaks the second, so every engine key looks
  // like a fact that has vanished, every check says STALE, and the automatic
  // rebuild that answers a STALE schedule runs again, and again. That is what
  // filed forty-nine versions of one schedule in a minute.
  //
  // So the manifest is normalised to LEDGER IDS here, using the ledger's own
  // ids to build the reverse map — `engineKeyForFactId` is lossy (it
  // lower-cases), so it cannot be inverted by rule, only by looking at what
  // the ledger actually holds.
  const ledgerIdByEngineKey = new Map<string, string>();
  for (const id of Object.keys(versions)) ledgerIdByEngineKey.set(engineKeyForFactId(id), id);

  // The freshness contract is exactly the facts the LEDGER can answer for.
  // A dependency it does not hold — a value typed into this run and not yet
  // filed, or a derived engine key like `runM` — is left out rather than given
  // a version nothing can ever satisfy. The row still names it in its own
  // trace, so nothing is hidden; it simply cannot make the schedule stale.
  const factVersions: Record<string, number> = {};
  for (const [id, seq] of Object.entries(versions)) factVersions[id] = seq;

  /** an id in whatever space it was recorded, as the ledger's id when there is one */
  const asLedgerId = (recorded: string): string | null =>
    factVersions[recorded] !== undefined ? recorded : (ledgerIdByEngineKey.get(recorded) ?? null);

  return {
    ...manifest,
    drawingHash: drawingHash ?? manifest.drawingHash,
    factIds: Object.keys(factVersions),
    factVersions,
    // Row dependencies travel in the same space, so `staleRowsOf` can name the
    // rows a changed fact invalidates instead of matching nothing.
    rowDeps: manifest.rowDeps.map((dep) => ({
      ...dep,
      factIds: [...new Set(dep.factIds.map(asLedgerId).filter((id): id is string => id !== null))],
    })),
    status: 'VALIDATED',
    staleFactIds: [],
  };
}

/** The row ids whose dependencies include any of the changed facts. */
export function staleRowsOf(manifest: BBSBuildManifest, staleFactIds: readonly string[]): string[] {
  const changed = new Set(staleFactIds);
  if (changed.has(DRAWING_CHANGED)) return manifest.rowDeps.map((r) => r.rowId);
  return manifest.rowDeps.filter((r) => r.factIds.some((id) => changed.has(id))).map((r) => r.rowId);
}

/**
 * Returns the row IDs whose computation depended on any of the changed fact IDs.
 */
export function dependentRows(
  manifest: BBSBuildManifest,
  changedFactIds: readonly string[],
): string[] {
  if (changedFactIds.length === 0) return [];
  const changedSet = new Set(changedFactIds);
  const staleRows: string[] = [];
  for (const rowDep of manifest.rowDeps) {
    if (rowDep.factIds.some((id) => changedSet.has(id))) {
      staleRows.push(rowDep.rowId);
    }
  }
  return staleRows;
}

