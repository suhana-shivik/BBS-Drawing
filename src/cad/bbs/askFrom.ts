// ============================================================
// From a verification failure to a question worth asking.
//
// WHEN A PERSON IS THE RIGHT ANSWER
//
// Only after the drawing has been exhausted. A question about something the
// sheet states is worse than useless: it costs the user's attention and teaches
// them that the harness has not read what they gave it. The orchestrator
// therefore repairs first, and only what repair could not settle arrives here.
//
// WHAT A QUESTION MUST CARRY
//
// The exact missing fact; why the engine needs it; which rows it blocks; what
// the sheet DID say nearby; the answer type; and the field the answer lands in.
// A question missing the last of those cannot be applied when it is answered,
// which is how an interview ends with the schedule unchanged.
// ============================================================
import type { VerificationFailure } from './verify';
import type { RepairBrief } from './repair';

export type AnswerType =
  | 'number-mm'
  | 'number-m'
  /** a plain count of things — no unit, and a whole number or nothing */
  | 'number-count'
  | 'choice'
  | 'confirm'
  | 'table'
  | 'text';

// ============================================================
// THE DEPENDENCY KEY — what makes two questions the same question.
//
// A question's `id` says WHERE IT CAME FROM: "extent:F1:run", "extent:F2:run".
// Nine members each failing the extent gate mint nine ids. But all nine ask
// one thing — the total run of the structure — and all nine answers land in
// ONE fact, `wall.total_run`. Deduplicating by id therefore does nothing, and
// the person is asked the identical question nine times.
//
// So identity is the DEPENDENCY: the fact the answer is written to. One fact,
// one question, however many rows are waiting on it. This is the same string
// the ledger stores the answer under and the same string a BBS row lists in
// its `factsUsed`, which is what makes "these four rows depend on one fact"
// true by construction rather than by coincidence.
//
// Defined HERE, with no imports, because askFrom.ts is the module that mints
// questions and everything above it (the orchestrator, the interview session,
// the Ask panel) has to agree. `interview/facts.ts` delegates its
// `factIdForQuestion` to this, so there is exactly one definition and the two
// cannot drift.
// ============================================================

/** Which member axis a field answers. A footing's DEPTH is its H. */
const AXIS_OF_FIELD: Readonly<Record<string, 'L' | 'W' | 'H'>> = {
  h: 'H',
  height: 'H',
  heightmm: 'H',
  depth: 'H',
  l: 'L',
  length: 'L',
  lengthmm: 'L',
  w: 'W',
  width: 'W',
  widthmm: 'W',
  thickness: 'W',
};

const AXIS_NAME: Readonly<Record<'L' | 'W' | 'H', string>> = {
  L: 'length',
  W: 'width',
  H: 'height',
};

function snakeField(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

/**
 * The fact id an answer to this question lands in — and therefore the key two
 * questions are the same under.
 *
 * `run` is the special case that caused the bug: the total run belongs to the
 * STRUCTURE, not to whichever member's gate happened to notice it was missing,
 * so the member mark is deliberately dropped.
 */
export function dependencyKeyOf(writesTo: { memberMark?: string; field: string }): string {
  const field = writesTo.field;
  const mark = writesTo.memberMark?.trim().toUpperCase();
  if (field === 'run') return 'wall.total_run';
  const axis = AXIS_OF_FIELD[field.toLowerCase()];
  if (mark && axis) return `${mark}.${AXIS_NAME[axis]}`;
  if (mark) return `${mark}.${snakeField(field)}`;
  return `settings.${snakeField(field)}`;
}

/** The dependency of a minted question, computed if it was not stamped. */
export function dependencyOf(question: Pick<AskableQuestion, 'writesTo' | 'dependencyKey'>): string {
  return question.dependencyKey ?? dependencyKeyOf(question.writesTo);
}

/**
 * Drop every question that asks for something already asked. Order is
 * preserved and the FIRST question for a dependency wins, so the one with the
 * best evidence — `questionsFrom` sorts by how much each unblocks — is the one
 * that survives.
 */
export function dedupeByDependency(
  questions: readonly AskableQuestion[],
  alreadyAsked: ReadonlySet<string> = new Set(),
): AskableQuestion[] {
  const seen = new Set(alreadyAsked);
  const out: AskableQuestion[] = [];
  for (const q of questions) {
    const key = dependencyOf(q);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

export interface AskableQuestion {
  id: string;
  /**
   * The fact this question answers — see `dependencyKeyOf`. Two questions with
   * this key equal are the same question however differently they were minted,
   * and only one of them is ever put to a person.
   */
  dependencyKey?: string;
  /** the fact itself, asked plainly */
  question: string;
  /** why the engine cannot proceed without it */
  why: string;
  /** the members and rows that are waiting on it */
  blocks: string[];
  /** what the sheet says near this, verbatim — so the user can check us */
  evidence: string[];
  answerType: AnswerType;
  /** where the answer is written — without this an answer changes nothing */
  writesTo: { memberMark?: string; field: string };
  /** options, when the answer is a choice */
  options?: string[];
  /** a suggestion ONLY when the sheet gives a basis for one, with the basis */
  suggestion?: { value: string; basis: string };
}

const TYPE_FOR_FIELD: Record<string, AnswerType> = {
  H: 'number-mm',
  L: 'number-mm',
  W: 'number-mm',
  run: 'number-m',
  count: 'number-count',
  placement: 'choice',
  disposition: 'choice',
  cover: 'number-mm',
};

const PLACEMENT_OPTIONS = [
  'it runs the whole length (continuous)',
  'it repeats at a regular pitch',
  'the drawn layout is the whole job',
  'the drawn layout repeats along the run',
  'its count follows another member',
  'there is only one',
];

const DISPOSITION_OPTIONS = [
  'cast-in-place reinforced concrete',
  'a precast product, bought finished',
  'structural steel',
  'drawn for reference only',
];

/**
 * Turn one exhausted repair into a question.
 *
 * `brief` carries what was already tried, which is what keeps the question
 * honest: "the sheet offers 1800 and 1500 and neither passed" is a far better
 * question than "what is F1's length?", because it shows the user we looked.
 */
export function questionFrom(
  failure: VerificationFailure,
  brief?: RepairBrief,
  blocks: readonly string[] = [],
): AskableQuestion {
  const field = failure.field ?? 'value';
  const mark = failure.memberMark;
  const answerType = TYPE_FOR_FIELD[field] ?? 'text';

  const evidence: string[] = [];
  if (brief) {
    for (const c of brief.candidates) {
      evidence.push(
        `${c.text ? `${JSON.stringify(c.text)}` : c.evidenceId}` +
          `${c.valueMm !== undefined ? ` — would give ${c.valueMm} mm` : ''}`,
      );
    }
    for (const r of brief.rejected) evidence.push(`${r.evidenceId} — rejected: ${r.reason}`);
  }

  const question =
    // The anchorage gate writes its failure AS the question: the figure on
    // record, why it cannot be this bar's length, and what to give instead.
    failure.gate === 'anchorage'
      ? failure.message
      : field === 'placement'
      ? `How does ${mark ?? 'this member'} repeat along the job?`
      : field === 'disposition'
        ? `What kind of element is ${mark ?? 'this'}? It is declared on the sheet, but nothing says whether its steel belongs in this schedule.`
        : field === 'run'
          ? 'What is the total run of this structure, in metres?'
          : `What is ${mark ? `${mark}'s ` : 'the '}${field}?`;

  const why =
    field === 'run'
      ? 'Every quantity on a linear job multiplies out of the run, and it is on no sheet — it lives on the site plan.'
      : brief?.escalationReason
        ? `The drawing was searched first: ${brief.escalationReason}.`
        : failure.message;

  return {
    id: `${failure.gate}:${mark ?? '-'}:${field}`,
    dependencyKey: dependencyKeyOf({ memberMark: mark, field }),
    question,
    why,
    blocks: [...blocks],
    evidence,
    answerType,
    writesTo: { memberMark: mark, field },
    options:
      field === 'placement' ? PLACEMENT_OPTIONS : field === 'disposition' ? DISPOSITION_OPTIONS : undefined,
  };
}

/**
 * "What is the clear cover?" — asked once per run when nobody stated it.
 *
 * Cover is in every arm of every link and both ends of every straight bar.
 * A schedule computed at the project default is only as right as that figure,
 * and a row held open for want of cover is waiting on exactly this. The
 * question names the figure the run would otherwise rest on, so the answer is
 * a correction of something visible rather than a number typed into a void.
 * It lands as `settings.cover` — the same id the specification files it under.
 */
export function coverQuestion(usedMm: number): AskableQuestion {
  return {
    id: 'settings:-:cover',
    dependencyKey: dependencyKeyOf({ field: 'cover' }),
    question:
      `What is the clear cover, in mm? This drawing states no cover and none has been supplied; ` +
      `the project default is ${usedMm} mm, and every cutting length rests on it.`,
    why:
      'Cover is in every stirrup arm and at both ends of every straight bar, so each cutting ' +
      'length is only as right as this figure. It was not read off the drawing.',
    blocks: ['every row cut to the default cover'],
    evidence: [`project default: ${usedMm} mm — an assumption, not a reading`],
    answerType: 'number-mm',
    writesTo: { field: 'cover' },
  };
}

/**
 * "How many are there?" — the question a stalled placement is really asking.
 *
 * A member whose placement never resolved blocks EVERY row it carries, and it
 * was the largest single source of open rows on a finished schedule. The
 * taxonomy question (`field: 'placement'`, six options about continuity and
 * tiling) is the right question to put to a model that can see the layout; it
 * is the wrong one to put to a person, who knows the answer as a number and
 * should not have to classify their own job to give it.
 *
 * So the placement failure becomes a count, and a count is a placement the
 * engine can resolve — `{ kind: 'stated' }` in placement.ts.
 *
 * `evidence` carries what the sheet DID show, so the answer is a correction of
 * something visible rather than a number typed into a void: "7 tags are drawn"
 * invites "yes, 7" or "no, that is one bay of nine".
 */
export function countQuestion(
  mark: string,
  opts: { why?: string; evidence?: readonly string[] } = {},
): AskableQuestion {
  return {
    id: `count:${mark}:count`,
    dependencyKey: dependencyKeyOf({ memberMark: mark, field: 'count' }),
    question: `How many ${mark} are there in the whole job?`,
    why:
      opts.why ??
      `Nothing on the sheet establishes how ${mark} repeats, and no count was assumed — ` +
        'every row this member carries is waiting on it.',
    blocks: [mark],
    evidence: [...(opts.evidence ?? [])],
    answerType: 'number-count',
    writesTo: { memberMark: mark, field: 'count' },
  };
}

/**
 * Which failures are worth a person's time, ordered by what they unblock.
 *
 * Batched deliberately: one question per round wastes the user's time and
 * thirty is a form, not an interview.
 */
export function questionsFrom(
  failures: readonly VerificationFailure[],
  briefs: ReadonlyMap<string, RepairBrief>,
  /** `alreadyAsked` holds DEPENDENCY KEYS (see dependencyKeyOf), not question ids. */
  opts: { max?: number; alreadyAsked?: ReadonlySet<string> } = {},
): AskableQuestion[] {
  const max = opts.max ?? 8;
  // DEPENDENCY keys, not question ids — see `dependencyKeyOf`. Nine members
  // failing the same gate mint nine ids for one fact, and keying this on the
  // id is what put the same question on screen nine times.
  const asked = opts.alreadyAsked ?? new Set<string>();
  const out: AskableQuestion[] = [];
  const seen = new Set<string>();

  // how many other failures each member is responsible for — a member blocking
  // six rows is asked about before one blocking a single row
  const weight = new Map<string, number>();
  for (const f of failures) {
    const k = f.memberMark ?? '-';
    weight.set(k, (weight.get(k) ?? 0) + 1);
  }

  const ordered = [...failures].sort(
    (a, b) => (weight.get(b.memberMark ?? '-') ?? 0) - (weight.get(a.memberMark ?? '-') ?? 0),
  );

  for (const f of ordered) {
    if (out.length >= max) break;
    const brief = briefs.get(`${f.gate}:${f.memberMark ?? '-'}:${f.field ?? '-'}`);
    // only ask what the drawing genuinely could not settle
    if (brief && !brief.exhausted) continue;
    const q = questionFrom(f, brief, [f.memberMark ?? '']);
    const key = dependencyOf(q);
    if (seen.has(key) || asked.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/**
 * Apply one answer to the job.
 *
 * Returns the patch rather than mutating, so the caller decides what to do with
 * it and the whole thing stays testable. `writesTo` is what makes this possible
 * at all — an answer with nowhere to go is an answer that changes nothing.
 */
export interface AnswerPatch {
  memberMark?: string;
  field: string;
  /** millimetres, normalised from whatever unit was asked for */
  mm?: number;
  /** a plain count — things, not millimetres */
  count?: number;
  choice?: string;
  text?: string;
  /** the transcript line this came from, so provenance survives */
  saidAs: string;
}

/**
 * Words that turn a figure into an ESTIMATE.
 *
 * "about 900" used to be accepted as 900: the first number in the string won,
 * and the hedge — the only part of the sentence saying the person was not sure
 * — was dropped on the floor. A schedule cannot tell an estimate from a
 * measurement once the number is in a cell, so it has to be refused at the
 * door. "min 900" and "up to 900" are the same problem wearing a different
 * word: they are constraints on a dimension, not the dimension.
 */
const HEDGED =
  /~|\b(?:about|approx|approximately|around|roughly|circa|say|maybe|perhaps|probably|nearly|almost|guess(?:ing)?|assume|assuming|at\s+least|at\s+most|no\s+more\s+than|no\s+less\s+than|up\s+to|min|minimum|max|maximum|more\s+than|less\s+than|or\s+so|plus\s+or\s+minus)\b/i;

/**
 * One figure, in digits, and nothing that changes what it means.
 *
 * Deliberately stricter than "find me a number in there". A range ("900 to
 * 1200") answered the question with two different values and the old parser
 * silently took the smaller; a hedge answered it with none. Both produced a
 * hard number in a cell that nobody could tell from a measured one, which is
 * the failure this whole module exists to prevent. A unit is not a problem and
 * is not rejected — "900 mm" is one figure, said properly.
 */
export function numbersOnly(said: string): string | null {
  const cleaned = said.replace(/,/g, '');
  const found = cleaned.match(/-?\d+(?:\.\d+)?/g) ?? [];
  if (found.length === 0) return `"${said}" carries no number — type the figure in digits, e.g. 900`;
  if (found.length > 1) {
    return (
      `"${said}" carries ${found.length} numbers (${found.join(', ')}) — this needs one figure. ` +
      'If the value varies, answer with the one that applies here and say the rest in the notes.'
    );
  }
  if (HEDGED.test(cleaned)) {
    return (
      `"${said}" is an estimate, not a measurement — a schedule cannot tell the two apart once ` +
      `it is in a cell. Type the figure alone (${found[0]}) if that is the value, or skip this ` +
      'question to leave it recorded as unknown.'
    );
  }
  return null;
}

export function applyAnswer(q: AskableQuestion, raw: string): AnswerPatch | { error: string } {
  const said = raw.trim();
  if (!said) return { error: 'no answer was given' };

  if (q.answerType === 'number-count') {
    const bad = numbersOnly(said);
    if (bad) return { error: bad };
    const m = /-?\d+(?:\.\d+)?/.exec(said.replace(/,/g, ''))!;
    const n = Number(m[0]);
    // "3.5 columns" is not a count of anything. Rounding it would be inventing
    // a quantity, which is the one thing this module exists not to do.
    if (!Number.isInteger(n) || n < 1) {
      return { error: `"${said}" is not a count — it must be a whole number of one or more` };
    }
    return { memberMark: q.writesTo.memberMark, field: q.writesTo.field, count: n, saidAs: said };
  }

  if (q.answerType === 'number-mm' || q.answerType === 'number-m') {
    const bad = numbersOnly(said);
    if (bad) return { error: bad };
    const m = /-?\d+(?:\.\d+)?/.exec(said.replace(/,/g, ''))!;
    const n = Number(m[0]);
    if (!Number.isFinite(n) || n <= 0) return { error: `"${said}" is not a usable measurement` };
    // The unit is decided by what was ASKED, not by what was typed — a user
    // answering "100" to a question posed in metres means 100 m, and reading
    // it as millimetres would scale the whole job by a thousand.
    const explicitMm = /\bmm\b/i.test(said);
    const explicitM = /\b(m|metres?|meters?)\b/i.test(said) && !explicitMm;
    const mm = explicitMm ? n : explicitM ? n * 1000 : q.answerType === 'number-m' ? n * 1000 : n;
    return { memberMark: q.writesTo.memberMark, field: q.writesTo.field, mm, saidAs: said };
  }

  if (q.answerType === 'choice' || q.answerType === 'confirm') {
    return { memberMark: q.writesTo.memberMark, field: q.writesTo.field, choice: said, saidAs: said };
  }

  return { memberMark: q.writesTo.memberMark, field: q.writesTo.field, text: said, saidAs: said };
}
