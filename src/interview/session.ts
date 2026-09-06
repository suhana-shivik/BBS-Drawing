// ============================================================
// The interview session — one BBS chat run, as a state machine.
//
//   idle → running → awaiting-answer → running → published
//                                    ↘ failed
//                                    ↘ abandoned
//
// WHY A SESSION AT ALL
//
// Today the orchestrator's loop RECORDS questions and keeps going
// (`escalations.push(q)` in orchestrate.ts). Nothing waits, so nothing can be
// answered mid-run, and the interview §7.1 describes — the chat IS the
// interview — cannot happen: the run ends, the questions land in a report, and
// the user answers them into the next run instead of this one.
//
// This is the thing that waits. `askUser(question)` returns a promise the
// engine can await; `answer(questionId, raw)` is what the Ask tab calls to
// resolve it. Between those two calls the run is genuinely suspended, which is
// the whole point.
//
// THE THREE RULES THAT KEEP IT FROM HANGING
//
//   1. ABANDONING RESOLVES. Unmount the tab, close the drawing, cancel the
//      run — every pending question resolves `null` and the engine finishes on
//      its own gap-reporting path. A promise nobody will ever resolve is how a
//      chat run becomes a spinner that outlives the session that made it.
//   2. IT IS BOUNDED. A run may ask MAX_QUESTIONS_PER_RUN questions and no
//      more; past that, `askUser` resolves null immediately and says why.
//      Thirty questions is a form, not an interview (interview.ts).
//   3. IT BATCHES. Questions raised in one pass are registered together and
//      shown together, ordered by how many rows each unblocks (§7.4
//      "Ordering"). They are never drip-fed one at a time across turns.
//
// An answered question is never asked twice — the stable ids askFrom.ts mints
// are what makes that possible, and re-asking one resolves instantly with the
// answer already given.
// ============================================================
import type { AnswerPatch, AskableQuestion } from '../cad/bbs/askFrom';
import { dependencyOf } from '../cad/bbs/askFrom';
import { MAX_QUESTIONS_PER_ROUND } from '../cad/bbs/interview';
import { isDecline, typeAnswer } from './facts';
import type { TranscriptLine } from './trace';

export type SessionState =
  | 'idle'
  | 'running'
  | 'awaiting-answer'
  | 'published'
  | 'failed'
  | 'abandoned';

/** the interview is bounded by the same number a round has always been bounded by */
export const MAX_QUESTIONS_PER_RUN = MAX_QUESTIONS_PER_ROUND;

export interface PendingQuestion {
  question: AskableQuestion;
  askedAt: number;
}

export interface AnsweredQuestion {
  question: AskableQuestion;
  /** exactly what the user typed or clicked — never normalised */
  raw: string;
  /** the typed patch, absent when the question was declined */
  patch?: AnswerPatch;
  /** "skip" / "I don't know" — a first-class answer (§7.4), never a guess */
  skipped: boolean;
  at: number;
}

export type AnswerOutcome =
  | { ok: true; answered: AnsweredQuestion }
  /** validation failed: the question stays open and is re-asked with this reason */
  | { ok: false; error: string };

export interface SessionSnapshot {
  state: SessionState;
  /** questions waiting on the user, in the order they should be shown */
  pending: PendingQuestion[];
  answered: AnsweredQuestion[];
  transcript: TranscriptLine[];
  /** set once the run publishes an artifact */
  artifactId?: string;
  /** why the run failed or was abandoned */
  stoppedBecause?: string;
  questionsAsked: number;
  questionsRemaining: number;
}

export interface SessionOptions {
  /** how many questions one run may put to the user in total */
  maxQuestions?: number;
  now?: () => number;
}

/**
 * The batch order §7.4 asks for: the answer that unblocks the most rows comes
 * first. `blocks` is the members and rows waiting on the question, so its
 * length IS the value of answering. Ties keep the order they arrived in — a
 * stable sort, so a re-render never reshuffles the questions under a cursor.
 */
export function orderQuestions(questions: readonly AskableQuestion[]): AskableQuestion[] {
  return questions
    .map((question, index) => ({ question, index }))
    .sort((a, b) => {
      const byBlocks = b.question.blocks.length - a.question.blocks.length;
      return byBlocks !== 0 ? byBlocks : a.index - b.index;
    })
    .map((x) => x.question);
}

interface PendingEntry {
  question: AskableQuestion;
  askedAt: number;
  resolve: (answer: string | null) => void;
}

/** a second await of the same open question rides the first one's answer */
function chain(open: PendingEntry, resolve: (answer: string | null) => void): void {
  const first = open.resolve;
  open.resolve = (answer) => {
    first(answer);
    resolve(answer);
  };
}

export class InterviewSession {
  private _state: SessionState = 'idle';
  private readonly pendingById = new Map<string, PendingEntry>();
  private readonly answeredById = new Map<string, AnsweredQuestion>();
  // THE QUEUE IS UNIQUE BY DEPENDENCY, NOT BY QUESTION ID.
  //
  // Four rows blocked on one fact mint four questions with four ids and one
  // dependency. Keyed by id they became four identical cards and a "Submit all
  // 4 answers" button; keyed by dependency they are one card, and the other
  // three awaits ride its answer (see `chain`). The by-id maps stay so the UI
  // can keep answering by `question.id`, which is what it holds.
  private readonly pendingByDependency = new Map<string, string>();
  private readonly answeredByDependency = new Map<string, AnsweredQuestion>();
  private readonly lines: TranscriptLine[] = [];
  private readonly listeners = new Set<(s: SessionSnapshot) => void>();
  private readonly maxQuestions: number;
  private readonly now: () => number;
  private asked = 0;
  private _artifactId?: string;
  private _stoppedBecause?: string;

  constructor(opts: SessionOptions = {}) {
    this.maxQuestions = Math.max(1, opts.maxQuestions ?? MAX_QUESTIONS_PER_RUN);
    this.now = opts.now ?? (() => Date.now());
  }

  get state(): SessionState {
    return this._state;
  }

  /** true once the session can no longer take work — nothing may reopen it */
  get finished(): boolean {
    return (
      this._state === 'published' || this._state === 'failed' || this._state === 'abandoned'
    );
  }

  subscribe(listener: (s: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): SessionSnapshot {
    return {
      state: this._state,
      pending: orderQuestions([...this.pendingById.values()].map((p) => p.question)).map(
        (question) => ({
          question,
          askedAt: this.pendingById.get(question.id)?.askedAt ?? 0,
        }),
      ),
      answered: [...this.answeredById.values()],
      transcript: [...this.lines],
      artifactId: this._artifactId,
      stoppedBecause: this._stoppedBecause,
      questionsAsked: this.asked,
      questionsRemaining: Math.max(0, this.maxQuestions - this.asked),
    };
  }

  /** the conversation so far — what trace.ts checks every relayed fact against */
  get transcript(): readonly TranscriptLine[] {
    return this.lines;
  }

  /** record something said, by either side, verbatim */
  say(role: TranscriptLine['role'], text: string): void {
    const said = text.trim();
    if (!said) return;
    this.lines.push({ role, text: said, at: this.now() });
    this.emit();
  }

  // ----------------------------------------------------------
  // the run
  // ----------------------------------------------------------

  /** idle → running. Starting a run that is already running changes nothing. */
  start(): void {
    if (this._state === 'idle') {
      this._state = 'running';
      this.emit();
    }
  }

  /** running → published, carrying the id of the artifact the thread now shows */
  publish(artifactId: string): void {
    if (this.finished) return;
    this.resolveAll(null, 'the run finished while the question was open');
    this._artifactId = artifactId;
    this._state = 'published';
    this.emit();
  }

  /** running → failed. Pending questions resolve, so nothing is left hanging. */
  fail(reason: string): void {
    if (this.finished) return;
    this.resolveAll(null, reason);
    this._stoppedBecause = reason;
    this._state = 'failed';
    this.emit();
  }

  /**
   * The unmount path, and the one that matters.
   *
   * Every pending question resolves `null` — the engine reads that as "the user
   * cannot answer", records the gap and finishes. Without this a closed tab
   * leaves an awaited promise nobody will ever settle and the run never ends.
   */
  abandon(reason = 'the interview was abandoned'): void {
    if (this.finished) return;
    this.resolveAll(null, reason);
    this._stoppedBecause = reason;
    this._state = 'abandoned';
    this.emit();
  }

  // ----------------------------------------------------------
  // the seam the engine awaits
  // ----------------------------------------------------------

  /**
   * Put one question to the user and wait.
   *
   * Resolves with the user's exact words, or `null` when it cannot be answered
   * — declined, capped, or the session ended. Never rejects: a question that
   * throws inside the engine's loop loses the whole run over a missing depth.
   */
  askUser(question: AskableQuestion): Promise<string | null> {
    if (this.finished) return Promise.resolve(null);
    if (this._state === 'idle') this.start();

    const dependency = dependencyOf(question);

    // Answered already — however it was worded, and whichever row asked this
    // time. The recorded answer is handed straight back, so a rebuild that
    // rediscovers the same hole never puts it to a person twice.
    const already = this.answeredByDependency.get(dependency);
    if (already) return Promise.resolve(already.skipped ? null : already.raw);

    // Open already — the second asker rides the first card's answer rather
    // than adding another one.
    const openId = this.pendingByDependency.get(dependency);
    const open = openId ? this.pendingById.get(openId) : undefined;
    if (open) return new Promise((resolve) => chain(open, resolve));

    if (this.asked >= this.maxQuestions) {
      this.say(
        'assistant',
        `(not asked — this run has already put ${this.maxQuestions} questions to you: ${question.question})`,
      );
      return Promise.resolve(null);
    }

    this.asked += 1;
    this.say('assistant', question.question);
    return new Promise<string | null>((resolve) => {
      this.pendingById.set(question.id, { question, askedAt: this.now(), resolve });
      this.pendingByDependency.set(dependency, question.id);
      this._state = 'awaiting-answer';
      this.emit();
    });
  }

  /**
   * Put a whole pass's questions at once — the shape §7.4 requires.
   *
   * Every question is registered before anything is awaited, so the UI renders
   * the batch in one go rather than one per turn, ordered by rows unblocked.
   * The returned answers keep the caller's original order.
   */
  askBatch(questions: readonly AskableQuestion[]): Promise<(string | null)[]> {
    const ordered = orderQuestions(questions);
    // Keyed by dependency, so a batch carrying the same hole four times asks
    // once and gives all four callers the same answer.
    const promises = new Map<string, Promise<string | null>>();
    for (const q of ordered) {
      const key = dependencyOf(q);
      if (!promises.has(key)) promises.set(key, this.askUser(q));
    }
    return Promise.all(
      questions.map((q) => promises.get(dependencyOf(q)) ?? Promise.resolve(null)),
    );
  }

  // ----------------------------------------------------------
  // the seam the UI calls
  // ----------------------------------------------------------

  /**
   * Answer an open question. Validation is askFrom.ts's `applyAnswer`, so free
   * prose can never reach arithmetic: a reply carrying no usable number comes
   * back as an error and the question STAYS OPEN to be asked again. Nothing is
   * ever coerced into a number on the user's behalf.
   */
  answer(questionId: string, raw: string): AnswerOutcome {
    const entry = this.pendingById.get(questionId);
    if (!entry) return { ok: false, error: `no open question "${questionId}"` };

    if (isDecline(raw)) return this.skip(questionId, raw);

    const typed = typeAnswer(entry.question, raw);
    if ('error' in typed) return { ok: false, error: typed.error };

    const answered: AnsweredQuestion = {
      question: entry.question,
      raw: raw.trim(),
      patch: typed.patch,
      skipped: false,
      at: this.now(),
    };
    this.settle(entry, answered, raw.trim());
    return { ok: true, answered };
  }

  /**
   * Declining is a first-class answer (§7.4). The row stays unavailable and the
   * gap is NAMED — facts.ts turns this into a MISSING fact. Never a default
   * quietly substituted: a named gap is something a checker can price or query,
   * a silent assumption is not.
   */
  skip(questionId: string, said = 'skip'): AnswerOutcome {
    const entry = this.pendingById.get(questionId);
    if (!entry) return { ok: false, error: `no open question "${questionId}"` };
    const answered: AnsweredQuestion = {
      question: entry.question,
      raw: said.trim() || 'skip',
      skipped: true,
      at: this.now(),
    };
    this.settle(entry, answered, null);
    return { ok: true, answered };
  }

  /** every question this run has settled — what facts.ts records */
  answers(): AnsweredQuestion[] {
    return [...this.answeredById.values()];
  }

  pending(): PendingQuestion[] {
    return this.snapshot().pending;
  }

  // ----------------------------------------------------------

  private settle(entry: PendingEntry, answered: AnsweredQuestion, resolveWith: string | null): void {
    const dependency = dependencyOf(entry.question);
    this.pendingById.delete(entry.question.id);
    this.pendingByDependency.delete(dependency);
    this.answeredById.set(entry.question.id, answered);
    this.answeredByDependency.set(dependency, answered);
    this.lines.push({ role: 'user', text: answered.raw, at: answered.at });
    if (!this.finished) {
      this._state = this.pendingById.size ? 'awaiting-answer' : 'running';
    }
    entry.resolve(resolveWith);
    this.emit();
  }

  private resolveAll(answer: string | null, reason: string): void {
    for (const [id, entry] of [...this.pendingById]) {
      this.pendingById.delete(id);
      this.pendingByDependency.delete(dependencyOf(entry.question));
      this.lines.push({ role: 'assistant', text: `(unanswered — ${reason})`, at: this.now() });
      entry.resolve(answer);
    }
  }

  private emit(): void {
    if (!this.listeners.size) return;
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }
}

/** the engine seam, spelled out once so both sides can name the same type */
export type AskUser = (question: AskableQuestion) => Promise<string | null>;

/** bind a session to that seam — this is what an OrchestrateOptions.askUser is */
export function askUserOf(session: InterviewSession): AskUser {
  return (question) => session.askUser(question);
}
