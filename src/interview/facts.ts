// ============================================================
// Answers become facts — and only ever as facts.
//
// An answered question has exactly two destinations, and this module is the
// only thing that knows how to reach either:
//
//   the LEDGER   a SUPPLIED fact carrying `saidAs` — the user's own words —
//                and provenance, recorded through recordFact so the ledger's
//                trust ordering applies to a person's answer like anything
//                else (a SUPPLIED value never silently displaces a MEASURED
//                one; the losing claim stays on the record).
//   the ENGINE   the `projectFacts` shape runOrchestrator consumes:
//                Record<string, {mm, saidAs}>, keyed by the flat engine key.
//
// THREE RULES, ALL OF THEM §7.4
//
//   1. TYPED, ALWAYS. Validation is askFrom.ts's `applyAnswer` plus
//      interview.ts's `validateAnswer` — free prose never reaches arithmetic,
//      and an answer that fails comes back as an error to re-ask rather than a
//      coerced number. Nothing here parses a sentence into a measurement.
//   2. A DECLINE IS AN ANSWER. "Skip" / "I don't know" records a MISSING fact
//      — a NAMED GAP carrying the question that would close it. Never a
//      default, never a guess. A named gap is something a checker can price;
//      a silent assumption is not.
//   3. ONE TRANSLATION TABLE. Ledger ids ⇄ engine keys is bbsFacts.ts's job
//      and it says so ("this is the only place it happens"). This module
//      imports it rather than growing a second one that can drift.
// ============================================================
import type { AskableQuestion, AnswerPatch } from '../cad/bbs/askFrom';
import { applyAnswer, dependencyKeyOf, dependencyOf } from '../cad/bbs/askFrom';
import { validateAnswer, type InterviewQuestion } from '../cad/bbs/interview';
import type { MemberOverride } from '../cad/bbs/overrides';
import { recordFact, type Ledger } from '../facts/ledger';
import type { Fact, FactSource, FactValue } from '../facts/types';
import { axisOfFactId, engineKeyForFactId, factIdForAxis, type Axis } from '../studio/bbsFacts';
import type { AnsweredQuestion } from './session';

// ------------------------------------------------------------
// what a decline looks like
// ------------------------------------------------------------

const DECLINES = [
  /^\s*skip\s*$/i,
  /^\s*pass\s*$/i,
  /^\s*n\/?a\s*$/i,
  /^\s*none\s*$/i,
  /^\s*unknown\s*$/i,
  /\bi\s*(?:do\s*not|don'?t|dont)\s*know\b/i,
  /\b(?:no|not)\s+(?:idea|sure)\b/i,
  /\bdunno\b/i,
  /\bcan'?t\s+say\b/i,
];

/**
 * Is this reply a decline rather than an answer?
 *
 * Recognised HERE rather than left to the number parser, because "don't know"
 * read as a measurement is the exact failure §7.4 forbids: a guess wearing a
 * person's name.
 */
export function isDecline(raw: string): boolean {
  const said = raw.trim();
  if (!said) return false;
  return DECLINES.some((re) => re.test(said));
}

// ------------------------------------------------------------
// where an answer lands
// ------------------------------------------------------------

/** Which member axis a question's field answers. A footing's DEPTH is its H. */
const AXIS_OF_FIELD: Readonly<Record<string, Axis>> = {
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

const OVERRIDE_FIELD: Record<Axis, keyof MemberOverride> = {
  L: 'lengthMm',
  W: 'widthMm',
  H: 'heightMm',
};

function snake(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

/** The member axis this question answers, when it answers one. */
export function axisOfQuestion(q: AskableQuestion): Axis | null {
  return AXIS_OF_FIELD[q.writesTo.field.toLowerCase()] ?? null;
}

/**
 * The ledger id an answer lands under.
 *
 * `run` is the one special case, and it is bbsFacts.ts's special case too:
 * the whole schedule multiplies out of it and the engine has always called it
 * `run`, so it is "wall.total_run" in the ledger and nothing else.
 */
export function factIdForQuestion(q: AskableQuestion): string {
  // Delegated, deliberately. The fact an answer lands in IS the key two
  // questions are the same under (askFrom.ts's `dependencyKeyOf`), and two
  // implementations of that rule would drift — at which point the interview
  // would dedupe on one string and record the answer under another, which is
  // exactly how a question comes back after it has been answered.
  return dependencyOf(q);
}

/** The flat key the engine sees for this question — "c1_height", "run". */
export function engineKeyForQuestion(q: AskableQuestion): string {
  return engineKeyForFactId(factIdForQuestion(q));
}

// ------------------------------------------------------------
// lifting a reply-level escalation into a question that can be answered
// ------------------------------------------------------------

/**
 * The orchestrator's own `askUser` reply carries only {question, whyNeeded} —
 * no `writesTo`, and "a question missing it cannot be applied when it is
 * answered, which is how an interview ends with the schedule unchanged"
 * (askFrom.ts).
 *
 * So this reads a target out of the question's own words, and returns NULL
 * when it cannot. A question with nowhere to land stays a recorded gap rather
 * than becoming a card that wastes an answer.
 */
export function inferWritesTo(
  text: string,
  marks: readonly string[] = [],
): AskableQuestion['writesTo'] | null {
  const said = text.toLowerCase();
  if (/\b(?:total\s+)?run\b/.test(said) || /\boverall\s+length\s+of\s+the\s+(?:wall|job|site)\b/.test(said)) {
    return { field: 'run' };
  }

  const mark = marks.find((m) => new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
  const axis: Axis | null = /\bheight|\bdeep\b|\bdepth\b/.test(said)
    ? 'H'
    : /\bwidth\b|\bthick(?:ness)?\b/.test(said)
      ? 'W'
      : /\blength\b/.test(said)
        ? 'L'
        : null;
  if (mark && axis) return { memberMark: mark.toUpperCase(), field: axis };
  // "How many F2 are there?" is the orchestrator's own commonest escalation and
  // it matched no axis, so this returned null and the question was DROPPED
  // before it ever reached the user. A count is now a field like any other.
  // `\bnos?\b` also matched the word "no" — so "What are the plan size (L × W)
  // of footing F8? … no project fact covers them" was typed as a COUNT, the
  // user's 3200 × 3500 went nowhere, and the run asked again. "nos" and "no."
  // are the Indian count abbreviations; the plain word "no" is not one.
  if (mark && /\bhow many\b|\bnos\b|\bno\.\s|\bcount\b|\bquantity of\b|\bnumber of\b/.test(said)) {
    return { memberMark: mark.toUpperCase(), field: 'count' };
  }
  if (/\bcover\b/.test(said)) return { field: 'cover' };
  return null;
}

const TYPE_OF_FIELD: Readonly<Record<string, AskableQuestion['answerType']>> = {
  H: 'number-mm',
  L: 'number-mm',
  W: 'number-mm',
  cover: 'number-mm',
  run: 'number-m',
  count: 'number-count',
};

/**
 * One escalation → one askable question, or null when it cannot be one.
 *
 * This is the lift the engine seam needs: everything askFrom.ts's own
 * questions carry, built from a reply that carried two fields.
 */
export function escalationQuestion(
  escalation: { question: string; whyNeeded: string },
  opts: {
    id: string;
    marks?: readonly string[];
    writesTo?: AskableQuestion['writesTo'];
    blocks?: readonly string[];
    evidence?: readonly string[];
  },
): AskableQuestion | null {
  const writesTo = opts.writesTo ?? inferWritesTo(escalation.question, opts.marks ?? []);
  if (!writesTo) return null;
  return {
    id: opts.id,
    dependencyKey: dependencyKeyOf(writesTo),
    question: escalation.question,
    why: escalation.whyNeeded,
    blocks: [...(opts.blocks ?? (writesTo.memberMark ? [writesTo.memberMark] : []))],
    evidence: [...(opts.evidence ?? [])],
    answerType: TYPE_OF_FIELD[writesTo.field] ?? 'text',
    writesTo,
  };
}

// ------------------------------------------------------------
// typed validation
// ------------------------------------------------------------

const KIND_OF_ANSWER_TYPE: Record<AskableQuestion['answerType'], InterviewQuestion['kind']> = {
  'number-mm': 'number',
  'number-m': 'number',
  'number-count': 'number',
  choice: 'choice',
  confirm: 'confirm',
  table: 'per_stretch',
  // a free-text answer is checked for shape, never for magnitude — it carries
  // no arithmetic, which is the whole reason it is allowed to be prose
  text: 'choice',
};

/**
 * The same AskableQuestion, in the vocabulary interview.ts already validates.
 *
 * Deliberately a translation and not a second validator: the "no member axis
 * is 1 mm" gate, the zero refusal and the choice-must-be-an-option rule were
 * all written against real failures, and duplicating them here would mean two
 * places to fix the next one.
 */
export function toInterviewQuestion(q: AskableQuestion): InterviewQuestion {
  const mark = q.writesTo.memberMark?.trim().toUpperCase();
  const axis = axisOfQuestion(q);
  const numeric = q.answerType === 'number-mm' || q.answerType === 'number-m';
  return {
    id: q.id,
    text: q.question,
    why: q.why,
    kind: KIND_OF_ANSWER_TYPE[q.answerType],
    // applyAnswer normalises every measurement to millimetres before this
    // point, so the question a value is checked against is a mm question
    unit: numeric ? 'mm' : undefined,
    options: q.options,
    evidence: q.evidence.join(' · ') || undefined,
    writes:
      mark && axis
        ? { scope: 'member', mark, field: OVERRIDE_FIELD[axis] }
        : { scope: 'takeoff', field: factIdForQuestion(q) },
  };
}

/**
 * Cheap, immediate sanity on a typed answer — what stands between a mis-click
 * and a schedule. Returns the message to re-ask with, or null when it passes.
 */
export function checkAnswerPatch(q: AskableQuestion, patch: AnswerPatch): string | null {
  const value = patch.mm ?? patch.count ?? patch.choice ?? patch.text;
  if (value === undefined) return 'that answer carries nothing to record';
  return validateAnswer(toInterviewQuestion(q), value);
}

/**
 * Answer → typed patch, or the reason it cannot be one.
 *
 * The single door: session.answer and any caller that has only raw words both
 * come through here, so prose is refused in exactly one place.
 */
export function typeAnswer(
  q: AskableQuestion,
  raw: string,
): { patch: AnswerPatch } | { error: string } {
  const patch = applyAnswer(q, raw);
  if ('error' in patch) return { error: patch.error };
  const problem = checkAnswerPatch(q, patch);
  if (problem) return { error: problem };
  return { patch };
}

// ------------------------------------------------------------
// answers → ledger facts
// ------------------------------------------------------------

export interface Supplier {
  /** name/email/channel — SUPPLIED is attributable */
  suppliedBy: string;
  /** ISO date; defaults to the day the answer was given */
  on?: string;
  /**
   * The drawing the question was raised from — CONTEXT, never authority. A
   * user's answer is not a reading of that sheet and must not be recorded as
   * one (§7.1: the two kinds of evidence stay apart).
   */
  askedAbout?: FactSource;
}

function readOnOf(at: number, who: Supplier): string {
  return who.on ?? new Date(at).toISOString().slice(0, 10);
}

/**
 * A SUPPLIED fact from one answered question.
 *
 * `saidAs` is the user's exact words, so every applied value stays checkable
 * against its own transcript — that is what lets a row print "ΔLVL = 900 mm ·
 * from you" and mean it.
 */
/**
 * WHICH DRAWING THIS WAS ASKED ON, as a placeable trail.
 *
 * `Supplier.askedAbout` has always carried it and nothing has ever recorded
 * it, so an answered fact reached the ledger with no `source` and no
 * `lookedIn` — and `factOnDrawing` shows an unplaceable fact on EVERY drawing
 * by design, so that the ledger never hides something nobody can find. The
 * result: open a second drawing and its Specification listed the first
 * drawing's answers as if they were its own.
 *
 * It goes in `lookedIn`, NOT in `source`. That distinction is the point of
 * §7.1 and of the comment on `askedAbout` itself — "CONTEXT, never authority.
 * A user's answer is not a reading of that sheet and must not be recorded as
 * one." `source` would claim the drawing SAYS this; `lookedIn` says only that
 * this is where the question came up, which is exactly what happened and
 * exactly what case 2 of `factOnDrawing` is for.
 *
 * The drawing number leads, because that is what `factOnDrawing` matches on.
 */
function askedAboutTrail(who: Supplier): string[] {
  const at = who.askedAbout;
  if (!at?.drawingNumber) return [];
  const rev = at.revision ? ` ${at.revision}` : '';
  return [`${at.drawingNumber}${rev} — the drawing open when this was asked`];
}

export function factFromAnswer(answered: AnsweredQuestion, who: Supplier): Fact {
  const q = answered.question;
  const id = factIdForQuestion(q);
  if (answered.skipped) return namedGap(answered, who);

  const patch = answered.patch;
  const numeric = patch?.mm !== undefined;
  const value: FactValue = numeric
    ? (patch?.mm as number)
    : (patch?.choice ?? patch?.text ?? answered.raw);

  return {
    id,
    value,
    ...(numeric ? { unit: 'mm' } : {}),
    state: 'SUPPLIED',
    suppliedBy: who.suppliedBy,
    saidAs: patch?.saidAs ?? answered.raw,
    evidence: [`asked: "${q.question}" (${q.id})`],
    neededFor: q.blocks.filter(Boolean).length ? q.blocks.filter(Boolean) : [q.why],
    ...(askedAboutTrail(who).length ? { lookedIn: askedAboutTrail(who) } : {}),
    readOn: readOnOf(answered.at, who),
  };
}

/**
 * A NAMED GAP — the fact a decline produces.
 *
 * MISSING carries no value (never an invented one), the question that would
 * close it, and everything the sheet did say nearby. The rows it blocks stay
 * unavailable and SAY WHY, which is the difference between a schedule a
 * checker can query and one they have to trust.
 */
export function namedGap(answered: AnsweredQuestion, who: Supplier): Fact {
  const q = answered.question;
  return {
    id: factIdForQuestion(q),
    value: null,
    state: 'MISSING',
    ask: q.question,
    neededFor: q.blocks.filter(Boolean).length ? q.blocks.filter(Boolean) : [q.why],
    // The drawing FIRST, so this gap is placeable: `factOnDrawing` matches on
    // the leading drawing number, and an evidence line does not start with one.
    lookedIn: [
      ...askedAboutTrail(who),
      ...(q.evidence.length ? q.evidence : ['the drawing was searched before asking']),
    ],
    saidAs: answered.raw,
    suppliedBy: who.suppliedBy,
    evidence: [`declined: "${answered.raw}" to "${q.question}" (${q.id})`],
    readOn: readOnOf(answered.at, who),
  };
}

export interface RecordAnswersResult {
  ledger: Ledger;
  /** facts that are now current */
  applied: Fact[];
  /** claims the ledger kept but did not make current, and why */
  rejected: { fact: Fact; reason: string }[];
  /** the declines, recorded as MISSING — the schedule's named gaps */
  gaps: Fact[];
}

/**
 * Record a run's answers into the ledger, through `recordFact` so the trust
 * ordering, the contradiction record and the history all apply. Nothing is
 * mutated: a new ledger value comes back.
 */
export function recordAnswers(
  ledger: Ledger,
  answers: readonly AnsweredQuestion[],
  who: Supplier,
): RecordAnswersResult {
  let next = ledger;
  const applied: Fact[] = [];
  const rejected: { fact: Fact; reason: string }[] = [];
  const gaps: Fact[] = [];

  for (const answered of answers) {
    const fact = factFromAnswer(answered, who);
    const result = recordFact(next, fact);
    next = result.ledger;
    if (result.accepted) {
      applied.push(fact);
      if (fact.state === 'MISSING') gaps.push(fact);
    } else {
      rejected.push({ fact, reason: result.reason ?? 'the current fact held' });
    }
  }
  return { ledger: next, applied, rejected, gaps };
}

// ------------------------------------------------------------
// answers → the engine's projectFacts
// ------------------------------------------------------------

/**
 * The `projectFacts` runOrchestrator consumes. Only measurements reach it: a
 * choice, a confirmation or a decline is a real answer and none of them is a
 * millimetre, so none of them is smuggled into arithmetic.
 */
export function projectFactsFromAnswers(
  answers: readonly AnsweredQuestion[],
): Record<string, { mm: number; saidAs?: string }> {
  const out: Record<string, { mm: number; saidAs?: string }> = {};
  for (const answered of answers) {
    if (answered.skipped) continue;
    const mm = answered.patch?.mm;
    if (typeof mm !== 'number' || !Number.isFinite(mm)) continue;
    out[engineKeyForQuestion(answered.question)] = {
      mm,
      saidAs: answered.patch?.saidAs ?? answered.raw,
    };
  }
  return out;
}

/**
 * Does the ARITHMETIC read this fact, or does the ledger merely hold it?
 *
 * Three channels reach a computed number, and only three: a length that
 * answers an axis or the run (`projectFactsFromLedger`), a cover
 * (`resolveCover` / `settings.coverMm`), and the settings patch
 * (`settingsFromLedger` — grades, wastage, lap multiple). Anything else is a
 * real fact that is recorded, quoted and auditable, and changes no figure.
 *
 * This exists because `appliedLine` used to promise "applied, and quoted
 * wherever it is used" for every answer, including ones nothing consumed. A
 * wrong number a person was told was applied is worse than an open gap: the
 * gap argues for itself, the false confirmation ends the conversation.
 */
export function isComputedWith(factId: string): boolean {
  const id = factId.toLowerCase();
  if (id === 'wall.total_run') return true;
  if (axisOfFactId(id) !== null) return true;
  if (/(^|\.)cover$/.test(id)) return true;
  return (
    id === 'settings.concrete_grade' ||
    id === 'settings.steel_grade' ||
    id === 'settings.wastage_pct' ||
    id === 'settings.lap_multiple'
  );
}

/**
 * What the assistant says after an answer lands (§7.4 "Answering
 * recomputes"). Words only — the figures belong to the artifact, and this
 * function is given none to print.
 */
export function appliedLine(fact: Fact): string {
  const unit = fact.unit ? ` ${fact.unit}` : '';
  const value = fact.state === 'MISSING' ? 'left as a named gap' : `${String(fact.value)}${unit}`;
  if (fact.state === 'MISSING') {
    return `${fact.id} — ${value}: ${fact.ask ?? 'unanswered'}. The rows waiting on it stay unavailable and say so.`;
  }
  const said = `${fact.id} = ${value} · from you ("${fact.saidAs ?? ''}")`;
  return isComputedWith(fact.id)
    ? `${said} — applied, and quoted wherever it is used.`
    : `${said} — recorded in the specification. This calculation does not read it, so no figure below changes because of it.`;
}
