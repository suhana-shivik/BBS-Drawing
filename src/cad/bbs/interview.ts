// ============================================================
// The interview — the model asking the user, on the record
//
// WHY
//
// The engine refuses to invent numbers, and `gaps.ts` could only ask from a
// fixed taxonomy — so a boundary wall's run length, the one figure the whole
// schedule multiplies out of, was never asked for by anyone. The model read
// "PRECAST PANEL LAYOUT" and had no way to say "what is the total run?".
//
// This module is the channel. The model emits QUESTIONS through the
// `ask_user` tool (agent.ts); the UI renders them; answers come back typed
// and land in the same override store a person already edits. The model never
// receives authority — an answer is data it must respect, not an instruction
// it interprets.
//
// THE CONTRACT (BBS_PLAN.md §2)
//
//   · stable ids — an answered question is never asked twice, across rounds
//     AND across re-reads of the drawing
//   · typed answers only — number-with-unit, confirm, choice, per-stretch
//     table. Free prose cannot reach arithmetic.
//   · every question says why, what it unblocks, and what the sheet DID say
//   · a suggestion carries its basis and is never auto-applied
//   · answers persist per drawing and are replayed into the next read
// ============================================================
import type { BbsSettings } from './types';
import type { MemberOverride } from './overrides';

const LS_KEY = 'bimcad.bbs.interview';
/** most questions one round may carry — more is a form, not an interview */
export const MAX_QUESTIONS_PER_ROUND = 10;
/** most ask_user rounds in one read — beyond this the model is stalling */
export const MAX_ASK_ROUNDS = 3;

// ------------------------------------------------------------
// questions
// ------------------------------------------------------------

export type QuestionKind = 'number' | 'confirm' | 'choice' | 'per_stretch';

/** where a typed answer lands, mechanically */
export type AnswerTarget =
  | { scope: 'member'; mark: string; field: keyof MemberOverride }
  | { scope: 'settings'; field: keyof BbsSettings }
  /**
   * A job-level take-off fact with no engine consumer yet — total run,
   * bays, zone table. Recorded and replayed to the model; the linear engine
   * (plan §7 step 5) reads them from here. The UI says so out loud.
   */
  | { scope: 'takeoff'; field: string };

export interface InterviewQuestion {
  /** stable across rounds and re-reads, e.g. "run-total" or "P2-height" */
  id: string;
  text: string;
  /** why the schedule cannot proceed without it — shown, always */
  why: string;
  kind: QuestionKind;
  /** for kind "number" */
  unit?: string;
  /** for kind "choice" */
  options?: string[];
  /** for kind "per_stretch": the column names of the mini-table */
  columns?: string[];
  /** what the sheet DID say nearby — text the user can check against */
  evidence?: string;
  /** entity handles behind the evidence, for click-to-locate */
  handles?: string[];
  suggestion?: { value: number | string; basis: string };
  writes: AnswerTarget;
}

export type StretchRow = Record<string, string | number>;
export type AnswerValue = number | string | boolean | StretchRow[];

export interface InterviewAnswer {
  questionId: string;
  value: AnswerValue;
}

/**
 * One round's reply, whatever mixture the user chose: typed cards, a free-
 * text sentence, a photo of the site plan — or all three. The fixed form was
 * rejected in the field ("i dont think the fixed format will work"), and a
 * QS answering from a site really does say "run is 96.5, wall goes 1.2 above
 * the beam" with a photo attached.
 */
export interface InterviewReply {
  answers: InterviewAnswer[];
  /** whatever the user said that the parser could not type — the model reads it */
  note?: string;
  /** attached photos, as data URLs — evidence for the model to PROPOSE from */
  images?: string[];
}

/** one asked-and-answered exchange, kept verbatim for replay and audit */
export interface InterviewExchange {
  question: InterviewQuestion;
  answer?: InterviewAnswer;
  /** the user explicitly declined rather than missed it */
  skipped?: boolean;
  at: number;
}

export interface InterviewRecord {
  drawingKey: string;
  exchanges: InterviewExchange[];
  updatedAt: number;
}

// ------------------------------------------------------------
// validating what the model emits
// ------------------------------------------------------------

const KINDS = new Set<QuestionKind>(['number', 'confirm', 'choice', 'per_stretch']);
const clip = (s: unknown, n: number): string => String(s ?? '').slice(0, n).trim();

/**
 * Sanitise the model's ask_user payload into questions the UI can render.
 *
 * Anything malformed is dropped and reported rather than repaired: a question
 * with no id cannot keep its answer across a re-read, and a question with no
 * target cannot land its answer anywhere — both are worse asked than skipped.
 */
export function parseQuestions(raw: unknown): { questions: InterviewQuestion[]; rejected: string[] } {
  const rejected: string[] = [];
  const questions: InterviewQuestion[] = [];
  const list = Array.isArray((raw as { questions?: unknown })?.questions)
    ? ((raw as { questions: unknown[] }).questions)
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];

  for (const item of list.slice(0, MAX_QUESTIONS_PER_ROUND)) {
    if (!item || typeof item !== 'object') continue;
    const q = item as Record<string, unknown>;
    const id = clip(q.id, 64);
    const text = clip(q.text ?? q.question, 300);
    const kind = clip(q.kind, 20) as QuestionKind;
    const writes = q.writes as Record<string, unknown> | undefined;

    if (!id || !text) {
      rejected.push(`question with no id/text: ${clip(q.text ?? q.id, 60) || '(empty)'}`);
      continue;
    }
    if (!KINDS.has(kind)) {
      rejected.push(`"${id}": unknown kind "${clip(q.kind, 20)}"`);
      continue;
    }
    if (!writes || typeof writes !== 'object' || !clip(writes.scope, 20)) {
      rejected.push(`"${id}": no writes target — the answer would land nowhere`);
      continue;
    }

    const scope = clip(writes.scope, 20);
    let target: AnswerTarget | null = null;
    if (scope === 'member' && clip(writes.mark, 24) && clip(writes.field, 24)) {
      target = {
        scope: 'member',
        mark: clip(writes.mark, 24),
        field: clip(writes.field, 24) as keyof MemberOverride,
      };
    } else if (scope === 'settings' && clip(writes.field, 24)) {
      target = { scope: 'settings', field: clip(writes.field, 24) as keyof BbsSettings };
    } else if (scope === 'takeoff' && clip(writes.field, 40)) {
      target = { scope: 'takeoff', field: clip(writes.field, 40) };
    }
    if (!target) {
      rejected.push(`"${id}": writes target malformed (${JSON.stringify(writes).slice(0, 60)})`);
      continue;
    }

    const suggestion = q.suggestion as Record<string, unknown> | undefined;
    questions.push({
      id,
      text,
      why: clip(q.why, 400),
      kind,
      unit: clip(q.unit, 12) || undefined,
      options:
        kind === 'choice' && Array.isArray(q.options)
          ? q.options.slice(0, 6).map((o) => clip(o, 80)).filter(Boolean)
          : undefined,
      columns:
        kind === 'per_stretch' && Array.isArray(q.columns)
          ? q.columns.slice(0, 6).map((c) => clip(c, 40)).filter(Boolean)
          : undefined,
      evidence: clip(q.evidence, 300) || undefined,
      handles: Array.isArray(q.handles)
        ? q.handles.slice(0, 40).map((h) => clip(h, 16)).filter(Boolean)
        : undefined,
      suggestion:
        suggestion && (typeof suggestion.value === 'number' || typeof suggestion.value === 'string')
          ? { value: suggestion.value as number | string, basis: clip(suggestion.basis, 200) }
          : undefined,
      writes: target,
    });
  }
  return { questions, rejected };
}

/**
 * Refuse questions the sheet already answers — BEFORE the user sees them.
 *
 * The skill instructs "read first, ask second"; this enforces it. A model
 * that asks for a cover printed in the notes, or the size of a member the
 * sheet declares, looks incompetent — and one visibly dumb question poisons
 * trust in every good one. Refused questions never reach the screen; the
 * refusal goes back to the model naming exactly where the answer is, which
 * corrects it inside the same conversation.
 *
 * Deterministic checks only. A wrong refusal would be worse than a dumb
 * question, so anything requiring judgement passes through.
 */
export function vetQuestions(
  questions: InterviewQuestion[],
  extract: Pick<import('./types').DrawingExtract, 'declared' | 'notes'>,
): { ask: InterviewQuestion[]; refused: { question: InterviewQuestion; reason: string }[] } {
  const ask: InterviewQuestion[] = [];
  const refused: { question: InterviewQuestion; reason: string }[] = [];
  const notes = extract.notes;

  for (const q of questions) {
    const t = q.writes;

    if (t.scope === 'settings' && t.field === 'coverMm') {
      if (notes.coverByMember?.length) {
        refused.push({
          question: q,
          reason:
            'the sheet TABULATES cover per member: ' +
            notes.coverByMember.map((c) => `${c.member} ${c.coversMm.join('/')}`).join('; ') +
            ' — apply the table; at most CONFIRM it.',
        });
        continue;
      }
      if (notes.coverMm !== undefined) {
        refused.push({
          question: q,
          reason: `the sheet states clear cover ${notes.coverMm} mm — apply it.`,
        });
        continue;
      }
    }

    if (t.scope === 'settings' && t.field === 'ldMultiple') {
      const lap = notes.globalRules?.find((r) => r.kind === 'lap' && r.multiple !== undefined);
      if (lap) {
        refused.push({
          question: q,
          reason: `the notes state it: "${lap.raw}" — ${lap.multiple}·d. Apply it.`,
        });
        continue;
      }
    }

    if (t.scope === 'member') {
      const declaredHit = extract.declared.find((d) => d.name === t.mark.toUpperCase());
      const plan = t.field === 'lengthMm' || t.field === 'widthMm';
      if (declaredHit && plan && declaredHit.dimsMm.length >= 2) {
        refused.push({
          question: q,
          reason:
            `the sheet declares ${t.mark} as ${declaredHit.sizeText} (seen ${declaredHit.occurrences}×) — ` +
            'read the cross-section from the declaration.',
        });
        continue;
      }
      if (declaredHit && t.field === 'heightMm' && declaredHit.dimsMm.length >= 3) {
        refused.push({
          question: q,
          reason:
            `the sheet declares ${t.mark} as ${declaredHit.sizeText} — the third dimension is on the sheet.`,
        });
        continue;
      }
    }

    ask.push(q);
  }
  return { ask, refused };
}

/**
 * The completeness gate: facts the model's OWN ANSWER admits are missing and
 * blocking, which nobody ever put to the user.
 *
 * The invariant this enforces, in the user's words: "when the model doesn't
 * know something it should ask — that should be the final stop." A read that
 * ends with members missing their height, interview rounds to spare, and no
 * question ever asked is not a finished read; it is a model giving up one
 * step before the one tool that could answer. A fact the user DECLINED counts
 * as asked — declining is an answer, and nagging past it breaks trust the
 * other way.
 */
export function unaskedBlockingFacts(
  content: string,
  record: InterviewRecord,
): { mark: string; axis: string; field: keyof MemberOverride }[] {
  const AXIS_FIELD: Record<string, keyof MemberOverride> = {
    L: 'lengthMm',
    W: 'widthMm',
    H: 'heightMm',
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, ''));
  } catch {
    return []; // an unparseable answer fails later for better reasons
  }
  const root = parsed as { members?: unknown; bars?: unknown };
  const members = Array.isArray(root.members) ? root.members : [];
  const bars = (Array.isArray(root.bars) ? root.bars : []).filter(
    (b): b is Record<string, unknown> => !!b && typeof b === 'object',
  );

  // What each member's bars actually NEED, derived from the bars themselves —
  // never from the model's own `missing` list. The first version trusted that
  // list, the model simply left a dim null WITHOUT declaring it missing, and
  // the gate waved through a read with three unavailable verticals. Trusting
  // the model's self-assessment was the same mistake in a new place.
  const LINK_TYPES = new Set(['TIE', 'STIRRUP', 'RING']);
  const needs = new Map<string, Set<string>>();
  for (const b of bars) {
    const mark = String(b.memberMark ?? '').toUpperCase();
    if (!mark) continue;
    const need = needs.get(mark) ?? new Set<string>();
    const axis = String(b.distributionAxis ?? '').toUpperCase();
    const type = String(b.barType ?? '').toUpperCase();
    const shape = String(b.shapeCode ?? '00');
    if (LINK_TYPES.has(type)) {
      need.add('L');
      need.add('W');
      need.add('H'); // links are counted up the member height
    } else if (axis === 'L' || axis === 'W') {
      need.add('L');
      need.add('W');
      if (shape !== '00') need.add('H'); // bent legs stand in the depth
    } else {
      need.add('H'); // a vertical runs the height
    }
    needs.set(mark, need);
  }

  const asked = new Set(
    record.exchanges
      .filter((ex) => ex.question.writes.scope === 'member' && (ex.answer || ex.skipped))
      .map((ex) => {
        const w = ex.question.writes as { scope: 'member'; mark: string; field: string };
        return `${w.mark.toUpperCase()}|${w.field}`;
      }),
  );

  const out: { mark: string; axis: string; field: keyof MemberOverride }[] = [];
  for (const raw of members) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const mark = String(rec.mark ?? '').toUpperCase();
    const need = mark ? needs.get(mark) : undefined;
    if (!need) continue; // a member with no bars blocks nothing

    // an axis is missing when its ref is null/absent — the model declaring it
    // in `missing` is corroboration, never the test
    const dims = (rec.dims ?? rec.dimensions ?? {}) as Record<string, unknown>;
    const declared = new Set(
      (Array.isArray(rec.missing) ? rec.missing : []).map((m) => String(m).toUpperCase()),
    );
    for (const axis of ['L', 'W', 'H']) {
      if (!need.has(axis)) continue;
      const ref = dims[axis] ?? dims[axis.toLowerCase()];
      const absent = ref === null || ref === undefined || declared.has(axis);
      if (!absent) continue;
      const field = AXIS_FIELD[axis];
      if (asked.has(`${mark}|${field}`)) continue;
      out.push({ mark, axis, field });
    }
  }
  return out;
}

/**
 * The coverage critic — the other half of the self-questioning loop.
 *
 * `unaskedBlockingFacts` catches unknowns on members the model DID return;
 * this catches what it never returned at all. The GAMCO wall was declared
 * sixteen times, carried 34 parsed callouts of which 16 were assigned to
 * nothing, and the answer contained no wall — and the read completed. The
 * critic is deterministic on purpose: a second model reviewing the first
 * costs a call and can agree with its mistakes; a diff between "what the
 * sheet declares" and "what the answer covers" can do neither.
 */
export function coverageGaps(
  content: string,
  extract: Pick<import('./types').DrawingExtract, 'declared' | 'callouts'>,
): { missingMembers: string[]; unassignedCallouts: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, ''));
  } catch {
    return { missingMembers: [], unassignedCallouts: [] };
  }
  const root = parsed as { members?: unknown; bars?: unknown };
  const members = Array.isArray(root.members) ? root.members : [];
  const bars = Array.isArray(root.bars) ? root.bars : [];

  const tight = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const covered = new Set(
    members
      .map((m) => (m && typeof m === 'object' ? tight(String((m as Record<string, unknown>).mark ?? '')) : ''))
      .filter(Boolean),
  );
  // a member declared repeatedly with a real size and no entry in the answer
  const missingMembers = (extract.declared ?? [])
    .filter((d) => d.occurrences >= 2 && d.dimsMm.length >= 1)
    .filter((d) => !covered.has(tight(d.name)))
    .map((d) => `${d.name} (${d.sizeText}, seen ${d.occurrences}×)`);

  const assigned = new Set(
    bars
      .map((b) =>
        b && typeof b === 'object' ? tight(String((b as Record<string, unknown>).fromCallout ?? '')) : '',
      )
      .filter(Boolean),
  );
  const seen = new Set<string>();
  const unassignedCallouts: string[] = [];
  for (const c of extract.callouts) {
    if (c.diaMm === undefined) continue; // unparsed strings are not bars
    const key = tight(c.raw);
    if (assigned.has(key) || seen.has(key)) continue;
    seen.add(key);
    unassignedCallouts.push(c.raw);
  }
  return { missingMembers, unassignedCallouts };
}

/**
 * Type a free-text reply against the open questions — conservatively.
 *
 * "run is 100m, C2 height 1.2m" should not force anyone to a form. But a
 * parser that guesses wrong writes a wrong number as if the USER typed it,
 * which outranks everything downstream. So the rules are strict: a question
 * is filled only when its keywords and exactly one number share a clause,
 * exactly one question claims that clause, and the value passes the same
 * validation the cards apply. Everything else stays in `unmatched` and goes
 * to the model verbatim, which may re-ask with a suggestion to confirm.
 */
export function parseFreeformAnswers(
  text: string,
  questions: InterviewQuestion[],
): { answers: InterviewAnswer[]; unmatched: string } {
  const answers: InterviewAnswer[] = [];
  const taken = new Set<string>();
  const clauses = text
    .split(/[,;\n]+|\band\b/i)
    .map((c) => c.trim())
    .filter(Boolean);
  const leftovers: string[] = [];

  const esc = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const keywordsOf = (q: InterviewQuestion): string[] => {
    const words: string[] = [];
    if (q.writes.scope === 'member') words.push(q.writes.mark);
    const field = String(q.writes.field ?? '');
    if (/height/i.test(field) || /height/i.test(q.text)) words.push('height', 'high', 'ht');
    if (/run/i.test(field) || /\brun\b/i.test(q.text)) words.push('run', 'wall length', 'total length');
    if (/lap/i.test(field)) words.push('lap');
    if (/anchor/i.test(field)) words.push('anchor', 'bottom l');
    if (/cover/i.test(field)) words.push('cover');
    if (/depth/i.test(q.text)) words.push('depth');
    return words.filter(Boolean);
  };

  const NUM_RE = /(-?\d+(?:\.\d+)?)\s*(mm|mtrs|mtr|metres|metre|meters|meter|m|nos)?\b/gi;

  for (const clause of clauses) {
    // the digit inside a mark token is identity, not a value: "C2 height
    // 1.2m" carries ONE number, not two
    const stripped = clause.replace(/\b[A-Z]{1,3}\d{1,3}[A-Z]?\b/g, ' ');
    const nums = [...stripped.matchAll(NUM_RE)];
    if (nums.length !== 1) {
      leftovers.push(clause);
      continue;
    }
    const rawVal = Number(nums[0][1]);
    const unit = (nums[0][2] ?? '').toLowerCase();

    // Exactly one open question may claim the clause. A MARK is a specific
    // address and outranks generic words: "C2 height 1.2" says the word
    // "height" — which every height question carries — but names only C2.
    const candidates = questions.filter((qq) => !taken.has(qq.id) && qq.kind === 'number');
    const markMatched = candidates.filter(
      (qq) =>
        qq.writes.scope === 'member' &&
        new RegExp(`\\b${esc(qq.writes.mark)}\\b`, 'i').test(clause),
    );
    const keywordMatched = candidates.filter((qq) =>
      keywordsOf(qq).some((w) => new RegExp(`\\b${esc(w)}`, 'i').test(clause)),
    );
    const pool = markMatched.length ? markMatched : keywordMatched;
    if (pool.length !== 1) {
      leftovers.push(clause);
      continue;
    }
    const q = pool[0];

    // convert to the question's unit: "1.2m" against a mm question is 1200,
    // and a bare small number against mm is read as metres too — nobody
    // answers a wall height as 1.2 millimetres
    let value = rawVal;
    const metres = /^m(trs|tr|etres|etre|eters|eter)?$/.test(unit);
    if (q.unit === 'mm' && (metres || (!unit && rawVal < 30))) value = rawVal * 1000;
    if (q.unit === 'm' && unit === 'mm') value = rawVal / 1000;

    if (validateAnswer(q, value) !== null) {
      leftovers.push(clause);
      continue;
    }
    taken.add(q.id);
    answers.push({ questionId: q.id, value });
  }

  return { answers, unmatched: leftovers.join('; ') };
}

/**
 * Cheap client-side sanity, before an answer is accepted at all.
 *
 * The model challenges IMPLAUSIBLE answers next round (that is judgement);
 * this rejects IMPOSSIBLE ones immediately (that is arithmetic). A −2 mm
 * cutting length once reached a schedule because nothing stood here.
 */
export function validateAnswer(q: InterviewQuestion, value: AnswerValue): string | null {
  if (q.kind === 'number') {
    const v = Number(value);
    if (!Number.isFinite(v)) return 'Enter a number.';
    if (v < 0) return 'A dimension cannot be negative.';
    if (v === 0) return 'Zero would erase every quantity this feeds — enter the real value.';
    // One click on a number spinner writes "1", the question vanishes as
    // answered, and a 1 mm depth poisons every row it feeds. No member axis
    // is under 30 mm; refuse at the door, matching the engine's own gate.
    if (
      q.writes.scope === 'member' &&
      /Mm$/.test(String(q.writes.field)) &&
      (v < 30 || v > 30000)
    ) {
      return `${v} mm is not a member dimension — check the value.`;
    }
  }
  if (q.kind === 'choice' && q.options?.length && !q.options.includes(String(value))) {
    return 'Pick one of the listed options.';
  }
  if (q.kind === 'per_stretch') {
    if (!Array.isArray(value) || value.length === 0) return 'Add at least one row.';
    for (const row of value) {
      for (const col of Object.keys(row)) {
        const n = Number(row[col]);
        if (typeof row[col] !== 'string' && (!Number.isFinite(n) || n < 0)) {
          return `"${col}" must be a non-negative number.`;
        }
      }
    }
  }
  return null;
}

// ------------------------------------------------------------
// applying answers — mechanically, into the stores that exist
// ------------------------------------------------------------

export interface AppliedAnswers {
  members: Record<string, MemberOverride>;
  settings: Partial<BbsSettings>;
  /** take-off facts with no consumer yet — recorded, surfaced, not arithmetic */
  takeoff: Record<string, AnswerValue>;
}

export function applyAnswers(exchanges: InterviewExchange[]): AppliedAnswers {
  const out: AppliedAnswers = { members: {}, settings: {}, takeoff: {} };
  for (const ex of exchanges) {
    if (!ex.answer || ex.skipped) continue;
    const t = ex.question.writes;
    const v = ex.answer.value;
    if (t.scope === 'member') {
      if (typeof v !== 'number') continue; // member fields are all numeric
      out.members[t.mark] = { ...out.members[t.mark], [t.field]: v };
    } else if (t.scope === 'settings') {
      if (typeof v === 'number') {
        (out.settings as Record<string, number>)[t.field] = v;
      }
    } else {
      out.takeoff[t.field] = v;
    }
  }
  return out;
}

// ------------------------------------------------------------
// persistence — per drawing, replayed into the next read
// ------------------------------------------------------------

type Store = Record<string, InterviewRecord>;

function readStore(): Store {
  try {
    return (JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Store) ?? {};
  } catch {
    return {};
  }
}

export function loadInterview(drawingKey: string): InterviewRecord {
  return (
    readStore()[drawingKey] ?? { drawingKey, exchanges: [], updatedAt: 0 }
  );
}

export function saveInterview(record: InterviewRecord): void {
  try {
    const store = readStore();
    store[record.drawingKey] = { ...record, updatedAt: Date.now() };
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    // storage full or unavailable: the interview still works this session
  }
}

export function forgetInterview(drawingKey: string): void {
  try {
    const store = readStore();
    delete store[drawingKey];
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    /* nothing to forget */
  }
}

/**
 * The record a NEW read starts from: answers persist, declines do not.
 *
 * "Declined counts as asked" is correct WITHIN a read — it stops the model
 * nagging past a refusal. Persisted across reads it becomes a trap: one
 * skipped round in session three silenced eleven questions in every session
 * after it, the completeness gate counted them all as asked, and the user
 * faced a 0 kg schedule wondering why nothing ever asked them anything.
 * A skip means "not now", never "never". Pressing Read again is the user
 * saying NOW.
 */
export function freshReadRecord(record: InterviewRecord): InterviewRecord {
  return { ...record, exchanges: record.exchanges.filter((ex) => ex.answer) };
}

/** merge a round's questions+answers into the record, newest answer winning */
export function recordExchanges(
  record: InterviewRecord,
  questions: InterviewQuestion[],
  answers: InterviewAnswer[] | null,
): InterviewRecord {
  const byId = new Map(record.exchanges.map((e) => [e.question.id, e]));
  for (const q of questions) {
    const a = answers?.find((x) => x.questionId === q.id);
    byId.set(q.id, {
      question: q,
      answer: a,
      skipped: answers !== null && !a,
      at: Date.now(),
    });
  }
  return { ...record, exchanges: [...byId.values()], updatedAt: Date.now() };
}

// ------------------------------------------------------------
// briefing the model on what is already answered
// ------------------------------------------------------------

const showValue = (v: AnswerValue): string => {
  if (Array.isArray(v)) return v.map((r) => JSON.stringify(r)).join('; ');
  return String(v);
};

/**
 * The block that goes into every read's prompt. This is what makes the
 * interview RESUME rather than restart: the model sees what was asked, what
 * was answered, and what the user declined — and is told not to ask again.
 */
export function answersBrief(record: InterviewRecord): string {
  if (!record.exchanges.length) return '';
  const lines = [
    'ANSWERS THE USER HAS ALREADY GIVEN (do NOT ask these again; treat the values as facts',
    'to reconcile with the drawing — challenge an answer ONLY if it contradicts something',
    'the sheet states, and say what it contradicts):',
  ];
  for (const ex of record.exchanges) {
    if (ex.answer) {
      lines.push(`  [${ex.question.id}] ${ex.question.text} → ${showValue(ex.answer.value)}${ex.question.unit ? ` ${ex.question.unit}` : ''}`);
    } else if (ex.skipped) {
      lines.push(`  [${ex.question.id}] ${ex.question.text} → the user DECLINED to answer; proceed without it and mark what it blocks as unavailable`);
    }
  }
  return lines.join('\n');
}
