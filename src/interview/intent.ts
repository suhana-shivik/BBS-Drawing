// ============================================================
// What the user asked for, in words — STUDIO_DESIGN §7.3.
//
// The chat is the second way to drive the same engine, so an Ask-tab message
// has to be read as an INSTRUCTION before it is read as conversation: ask for
// a schedule and the engine runs; answer an open question and the run resumes;
// ask for a different format and the SAME artifact re-renders.
//
// DETERMINISTIC ON PURPOSE
//
// This is pattern matching, not a model call, and that is a design decision
// rather than a shortcut. A classifier that costs a request cannot run on
// every keystroke, cannot be tested without a network, and — the real reason —
// can decide that "drop the shape column" meant "rebuild the schedule". The
// fallback is documented and boring: with a question open, anything that is
// not plainly a new request is treated as an answer to it; with nothing open,
// anything unrecognised is ordinary chat.
//
// THE TWO RULES §7.3 PUTS ON A FORMAT REQUEST
//
//   1. ASKING FOR A DIFFERENT FORMAT NEVER RE-DERIVES A NUMBER. It re-renders
//      the same artifact. A format request and a recalculation are different
//      acts, so `applyFormatChange` touches columns, grouping, a filter and a
//      display unit — and is not given the rows at all where it does not need
//      them. Nothing in this module can produce a figure.
//   2. AN EVIDENCED COLUMN IS NEVER HIDDEN ON REQUEST. The §6.2 refusal holds
//      in chat: the request is declined in the message, NAMING the rows it
//      would blank — "C1 and C2 carry link spacing — dropping that column
//      would leave their counts uncheckable. I can group it away instead."
// ============================================================
import type { BbsChatRow } from '../cad/bbs/chatResult';
import type { AskableQuestion } from '../cad/bbs/askFrom';
import { orderQuestions } from './session';

// ------------------------------------------------------------
// the format, as the chat can talk about it
// ------------------------------------------------------------

export type GroupBy = 'member' | 'dia' | 'shape';
export type DisplayUnit = 'mm' | 'm';

/**
 * The format state §9 keeps (`format: { columns, derived, group }`), plus the
 * two view settings §7.3 lets the chat change. One format per drawing, not one
 * per surface: a format settled in the chat IS the BBS tab's format.
 */
export interface FormatView {
  columns: string[];
  /** the drawing's own derived set — what "put it back" restores */
  derived: string[];
  group: GroupBy;
  /** "only the 16Ø bars" — a filter on the view, never on the rows */
  filterDiaMm?: number;
  unit: DisplayUnit;
}

export type FormatChange =
  | { op: 'add-column'; column: string }
  | { op: 'hide-column'; column: string }
  | { op: 'group-by'; by: GroupBy }
  | { op: 'filter-diameter'; diaMm: number }
  | { op: 'clear-filter' }
  | { op: 'unit'; unit: DisplayUnit }
  | { op: 'restore-derived' }
  | { op: 'use-house-format' }
  | { op: 'save-house-format' };

export type Intent =
  | { kind: 'build-schedule'; said: string; memberMark?: string }
  | { kind: 'answer-question'; said: string; questionId: string }
  | { kind: 'format-change'; said: string; change: FormatChange }
  | { kind: 'other'; said: string };

// ------------------------------------------------------------
// column vocabulary
// ------------------------------------------------------------

/**
 * What a person calls a column, and what the schedule calls it. The ids are
 * schedule.ts's ids — one vocabulary, so a column named in the chat is the
 * column the BBS tab shows.
 *
 * Order matters: "unit weight" must be tried before "weight", and "total
 * length" before "length", or the longer phrase never wins.
 */
const COLUMN_WORDS: readonly (readonly [RegExp, string])[] = [
  [/\bunit\s*(?:wt|weight)\b/i, 'unitWeight'],
  [/\btotal\s*length\b/i, 'totalLength'],
  [/\btotal\s*(?:no\.?|number|bars?)\b/i, 'totalBars'],
  [/\b(?:bars?\s*per\s*member|no\.?\s*per\s*member)\b/i, 'barsPerMember'],
  [/\bcutting\s*length\b/i, 'cuttingLength'],
  [/\b(?:spacing|c\/c|pitch)\b/i, 'spacing'],
  [/\boccurrences?\b/i, 'occurrences'],
  [/\bshapes?\b/i, 'shape'],
  [/\bbar\s*type\b/i, 'barType'],
  [/\b(?:dia|diameter|ø|Ø)\b/i, 'dia'],
  [/\bmembers?\s*count\b/i, 'memberCount'],
  [/\bmarks?\b/i, 'mark'],
  [/\bzone\b/i, 'zone'],
  [/\bfaces?\b/i, 'face'],
  [/\bdirection\b/i, 'direction'],
  [/\bcranks?\b/i, 'crank'],
  [/\bweights?\b/i, 'weight'],
  [/\bmembers?\b/i, 'member'],
];

export const COLUMN_LABELS: Readonly<Record<string, string>> = {
  mark: 'Mark',
  member: 'Member',
  barType: 'Bar type',
  dia: 'Ø',
  shape: 'Shape',
  zone: 'Zone',
  face: 'Face',
  direction: 'Direction',
  crank: 'Crank',
  cuttingLength: 'Cutting length',
  barsPerMember: 'No. per member',
  memberCount: 'Members',
  totalBars: 'Total no.',
  spacing: 'Spacing (c/c)',
  occurrences: 'Occurrences',
  totalLength: 'Total length',
  unitWeight: 'Unit wt',
  weight: 'Weight',
};

/** The column a phrase names, or null when it names none. */
export function columnFor(text: string): string | null {
  for (const [re, id] of COLUMN_WORDS) if (re.test(text)) return id;
  return null;
}

// ------------------------------------------------------------
// classification
// ------------------------------------------------------------

const BUILD_RE =
  /\b(?:give|get|make|build|produce|generate|prepare|run|create|show|do|calculate|compute)\b[^.?!]*\b(?:bbs|bar\s*bending\s*schedule|schedule|cutting\s*list|steel\s*schedule)\b/i;
const BARE_BUILD_RE = /^\s*(?:the\s+)?(?:bbs|bar\s*bending\s*schedule)\s*[.?!]?\s*$/i;
const SCOPE_RE = /\bfor\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 \-]{0,28}?)(?:\s*(?:only|please))?\s*[.?!]?$/i;
const MARK_RE = /^[A-Z]{1,4}[0-9]{0,3}$/;

/** "give me the BBS for the tie beam" → "TIE BEAM"; a mark stays a mark. */
function scopeOf(said: string): string | undefined {
  const m = SCOPE_RE.exec(said.trim());
  if (!m) return undefined;
  const scope = m[1].trim();
  if (!scope) return undefined;
  const upper = scope.toUpperCase();
  if (MARK_RE.test(upper)) return upper;
  // a phrase like "tie beam" is a member DESCRIPTION; it is passed on as the
  // user said it, upper-cased, and matched against member marks by the caller
  return upper;
}

const DIA_FILTER_RE =
  /\b(?:only|just)\b[^.?!]*?(\d{1,2})\s*(?:mm|ø|Ø|dia|diameter)?\b[^.?!]*\bbars?\b|\b(?:only|just)\s*(?:the\s*)?(\d{1,2})\s*(?:mm|ø|Ø)\b/i;

/**
 * Read a format request. Returns the change, or null when the message is not
 * one — the caller then goes on to the other intents.
 */
export function formatChangeIn(said: string): FormatChange | null {
  const text = said.trim();

  if (/\b(?:put it back|restore|revert|back to)\b[^.?!]*\b(?:drawing|derived|default|original|way)\b/i.test(text)) {
    return { op: 'restore-derived' };
  }
  if (/\bsave\b[^.?!]*\bhouse\s*format\b/i.test(text)) return { op: 'save-house-format' };
  if (/\b(?:use|apply)\b[^.?!]*\bhouse\s*format\b/i.test(text)) return { op: 'use-house-format' };

  if (/\bgroup(?:ed)?\s+(?:it\s+)?by\b/i.test(text)) {
    if (/\b(?:dia|diameter|ø|Ø)\b/i.test(text)) return { op: 'group-by', by: 'dia' };
    if (/\bshapes?\b/i.test(text)) return { op: 'group-by', by: 'shape' };
    if (/\bmembers?\b/i.test(text)) return { op: 'group-by', by: 'member' };
  }

  if (/\b(?:lengths?|dimensions?|everything)\b[^.?!]*\bin\s+(?:metres|meters|m)\b/i.test(text)) {
    return { op: 'unit', unit: 'm' };
  }
  if (/\b(?:lengths?|dimensions?|everything)\b[^.?!]*\bin\s+(?:millimetres|millimeters|mm)\b/i.test(text)) {
    return { op: 'unit', unit: 'mm' };
  }

  if (/\b(?:all|every)\s+(?:the\s+)?(?:bars|diameters|dia)\b/i.test(text) || /\bclear\s+the\s+filter\b/i.test(text)) {
    return { op: 'clear-filter' };
  }
  const dia = DIA_FILTER_RE.exec(text);
  if (dia) {
    const value = Number(dia[1] ?? dia[2]);
    if (Number.isFinite(value) && value > 0) return { op: 'filter-diameter', diaMm: value };
  }

  if (/\b(?:add|include|show|bring back|put in)\b[^.?!]*\bcolumns?\b/i.test(text)) {
    const column = columnFor(text);
    if (column) return { op: 'add-column', column };
  }
  if (/\b(?:drop|remove|hide|lose|delete|take out|without)\b[^.?!]*\bcolumns?\b/i.test(text)) {
    const column = columnFor(text);
    if (column) return { op: 'hide-column', column };
  }
  return null;
}

export interface ClassifyContext {
  /** questions the run is currently waiting on, if any */
  pendingQuestions?: readonly AskableQuestion[];
  /** a specific question the UI's input is bound to — a click beats a guess */
  answeringQuestionId?: string;
}

/**
 * One Ask-tab message → one intent.
 *
 * THE FALLBACK, stated once so it is never a surprise: an explicit request
 * (build, or a format change) is read as that request even while a question is
 * open — a user who types "group by diameter" mid-interview means it. Anything
 * else, with a question open, is that question's answer. Anything else with
 * nothing open is ordinary chat, and ordinary chat changes no number.
 */
export function classify(message: string, ctx: ClassifyContext = {}): Intent {
  const said = message.trim();
  const pending = orderQuestions(ctx.pendingQuestions ?? []);

  if (!said) return { kind: 'other', said };

  if (ctx.answeringQuestionId) {
    return { kind: 'answer-question', said, questionId: ctx.answeringQuestionId };
  }

  const format = formatChangeIn(said);
  if (format) return { kind: 'format-change', said, change: format };

  if (BARE_BUILD_RE.test(said) || BUILD_RE.test(said)) {
    const memberMark = scopeOf(said);
    return memberMark ? { kind: 'build-schedule', said, memberMark } : { kind: 'build-schedule', said };
  }

  if (pending.length) {
    // the batch is ordered by rows unblocked, so an untargeted reply answers
    // the question at the top of it — the one the UI is showing first
    return { kind: 'answer-question', said, questionId: pending[0].id };
  }

  return { kind: 'other', said };
}

// ------------------------------------------------------------
// §6.2 / §7.3 — an evidenced column is never hidden
// ------------------------------------------------------------

/** Whether a chat row carries a value for a column, and evidence for it. */
type ColumnProbe = (row: BbsChatRow) => boolean;

const has = (v: unknown): boolean => v !== null && v !== undefined && v !== '';

const COLUMN_EVIDENCE: Readonly<Record<string, ColumnProbe>> = {
  mark: (r) => has(r.barMark),
  member: (r) => has(r.memberMark),
  dia: (r) => has(r.diameterMm),
  spacing: (r) => has(r.spacingMm),
  cuttingLength: (r) => has(r.cuttingLengthMm),
  barsPerMember: (r) => has(r.barsPerMember),
  memberCount: (r) => has(r.memberCount),
  totalBars: (r) => has(r.totalBars),
  totalLength: (r) => has(r.totalLengthM),
  unitWeight: (r) => has(r.unitWeightKgPerM),
  weight: (r) => has(r.totalWeightKg),
};

/** Every column this row can evidence — the set §6.2 rule 1 derives from. */
export function evidencedColumns(row: BbsChatRow): Set<string> {
  const out = new Set<string>();
  for (const [id, probe] of Object.entries(COLUMN_EVIDENCE)) if (probe(row)) out.add(id);
  return out;
}

export type FormatVerdict =
  | { ok: true }
  | {
      ok: false;
      /** the message the assistant sends back, naming the rows */
      declined: string;
      /** the rows that would be blanked — bar marks */
      wouldBlank: string[];
      /** the members those rows belong to, in the order first seen */
      members: string[];
    };

const listOf = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * The refusal, in chat. A hide request is declined when any row can evidence
 * the column — and the decline NAMES those rows, because "no" without the
 * reason is indistinguishable from the tool being awkward.
 *
 * Every other format change is allowed: grouping, filtering, units and adding
 * a column can hide no evidence.
 */
export function vetFormatChange(
  change: FormatChange,
  rows: readonly BbsChatRow[],
): FormatVerdict {
  if (change.op !== 'hide-column') return { ok: true };

  const blanked = rows.filter((r) => evidencedColumns(r).has(change.column));
  if (!blanked.length) return { ok: true };

  const members: string[] = [];
  for (const r of blanked) if (!members.includes(r.memberMark)) members.push(r.memberMark);
  const label = COLUMN_LABELS[change.column] ?? change.column;

  return {
    ok: false,
    wouldBlank: blanked.map((r) => r.barMark),
    members,
    declined:
      `${listOf(members)} carry ${label.toLowerCase()} — dropping that column would leave ` +
      `${blanked.length === 1 ? 'that row' : 'those rows'} uncheckable ` +
      `(${listOf(blanked.map((r) => r.barMark))}). I can group it away instead.`,
  };
}

export interface FormatOutcome {
  view: FormatView;
  /** set when the change was refused — the view is returned unchanged */
  declined?: string;
  /** the rows a refused hide would have blanked */
  wouldBlank?: string[];
}

/**
 * Apply a format change to the VIEW. Nothing else.
 *
 * It is given the rows solely to run the §6.2 refusal; it never reads a figure
 * out of one and never writes one back. This is what "a format request
 * re-renders the same artifact" means mechanically: the artifact is not an
 * argument to this function, so it cannot be changed by it.
 */
export function applyFormatChange(
  view: FormatView,
  change: FormatChange,
  rows: readonly BbsChatRow[] = [],
  houseFormat?: readonly string[],
): FormatOutcome {
  const verdict = vetFormatChange(change, rows);
  if (!verdict.ok) {
    return { view, declined: verdict.declined, wouldBlank: verdict.wouldBlank };
  }

  switch (change.op) {
    case 'add-column':
      return {
        view: view.columns.includes(change.column)
          ? view
          : { ...view, columns: [...view.columns, change.column] },
      };
    case 'hide-column':
      return { view: { ...view, columns: view.columns.filter((c) => c !== change.column) } };
    case 'group-by':
      return { view: { ...view, group: change.by } };
    case 'filter-diameter':
      return { view: { ...view, filterDiaMm: change.diaMm } };
    case 'clear-filter': {
      const { filterDiaMm: _dropped, ...rest } = view;
      return { view: { ...rest } };
    }
    case 'unit':
      return { view: { ...view, unit: change.unit } };
    case 'restore-derived':
      return { view: { ...view, columns: [...view.derived] } };
    case 'use-house-format': {
      if (!houseFormat?.length) {
        return { view, declined: 'no house format is saved for this project yet.' };
      }
      // §6.2: a saved format NEVER hides an evidenced column. Anything this
      // drawing can evidence that the house format has no room for is added
      // back, flagged, rather than silently dropped to fit the template.
      const evidenced = new Set<string>();
      for (const r of rows) for (const c of evidencedColumns(r)) evidenced.add(c);
      const columns = [...houseFormat];
      for (const c of view.derived) {
        if (!columns.includes(c) && evidenced.has(c)) columns.push(c);
      }
      return { view: { ...view, columns } };
    }
    case 'save-house-format':
      return { view };
    default:
      return { view };
  }
}

/**
 * The one-line answer to a format request. Words only: this module is given no
 * figure and produces none, so a format reply can never restate a quantity.
 */
export function formatReply(change: FormatChange, outcome: FormatOutcome): string {
  if (outcome.declined) return outcome.declined;
  switch (change.op) {
    case 'add-column':
      return `Added the ${COLUMN_LABELS[change.column] ?? change.column} column. Same schedule, re-rendered — no figure changed.`;
    case 'hide-column':
      return `Hidden the ${COLUMN_LABELS[change.column] ?? change.column} column. No row loses evidence by it.`;
    case 'group-by':
      return `Grouped by ${change.by === 'dia' ? 'diameter' : change.by}. The rows are the same rows.`;
    case 'filter-diameter':
      return `Showing the ${change.diaMm}Ø bars only — a filter on the view, not on the schedule.`;
    case 'clear-filter':
      return 'Filter cleared — every bar is shown again.';
    case 'unit':
      return `Lengths shown in ${change.unit === 'm' ? 'metres' : 'millimetres'}. A display unit, not a recalculation.`;
    case 'restore-derived':
      return "Restored the drawing's own format.";
    case 'use-house-format':
      return 'Applied the project house format — any column this drawing can evidence is kept, flagged as added.';
    case 'save-house-format':
      return 'Saved as the project house format.';
    default:
      return 'The format is unchanged.';
  }
}
