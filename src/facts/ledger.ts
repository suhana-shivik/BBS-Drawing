// Project fact ledger — the append-only per-project store of facts.
//
// Pure functions over an immutable Ledger value. History is never deleted:
// re-adding a fact for an existing id appends a new entry and marks the old
// current entry as superseded (a new ledger value is returned; nothing in the
// old value is mutated). resolveFact always returns the current — the latest
// non-superseded — fact for an id.

import type { Fact, FactSource, FactState, FactValue, SupersedeReason } from './types';
import { trustOf } from './types';
import { revisionRank } from '../register/titleBlock';

/** One append to the ledger. `seq` is assigned at append time and never reused. */
export interface LedgerEntry {
  readonly seq: number;
  readonly fact: Fact;
}

export interface Ledger {
  readonly entries: readonly LedgerEntry[];
}

export function emptyLedger(): Ledger {
  return { entries: [] };
}

/** Ref for a specific entry, used in `supersededBy`: "<id>@<seq>". */
export function entryRef(entry: LedgerEntry): string {
  return `${entry.fact.id}@${entry.seq}`;
}

function nextSeq(ledger: Ledger): number {
  let max = -1;
  for (const e of ledger.entries) if (e.seq > max) max = e.seq;
  return max + 1;
}

/**
 * Append a fact, optionally stamping WHY the outgoing entry was replaced
 * (§5.3). If a current (non-superseded) fact with the same id exists, the
 * new entry supersedes it: the historical entry is retained with its
 * `supersededBy` pointing at the new entry, `supersededAt` and — when given —
 * `supersededReason`. Append-only — the input ledger is never mutated.
 */
export function appendFact(ledger: Ledger, fact: Fact, reason?: SupersedeReason): Ledger {
  const seq = nextSeq(ledger);
  const now = Date.now();
  const entry: LedgerEntry = {
    seq,
    fact: { ...fact, supersededBy: undefined, recordedAt: fact.recordedAt ?? now },
  };
  const ref = entryRef(entry);
  const entries = ledger.entries.map((e) =>
    e.fact.id === fact.id && e.fact.supersededBy === undefined
      ? {
          seq: e.seq,
          fact: {
            ...e.fact,
            supersededBy: ref,
            supersededAt: now,
            ...(reason !== undefined ? { supersededReason: reason } : {}),
          },
        }
      : e,
  );
  return { entries: [...entries, entry] };
}

/** `appendFact` without a supersede reason — unconditional append (legacy path). */
export function addFact(ledger: Ledger, fact: Fact): Ledger {
  return appendFact(ledger, fact);
}

/** The current (latest non-superseded) entry for an id, or undefined. */
function currentEntry(ledger: Ledger, id: string): LedgerEntry | undefined {
  for (let i = ledger.entries.length - 1; i >= 0; i--) {
    const e = ledger.entries[i];
    if (e.fact.id === id && e.fact.supersededBy === undefined) return e;
  }
  return undefined;
}

export interface RecordResult {
  ledger: Ledger;
  /** true: the fact is now current. false: the claim was recorded as contradicted. */
  accepted: boolean;
  /** when rejected, why the current fact held */
  reason?: string;
  /**
   * true: the write was an EQUAL-trust disagreement from a different drawing
   * (open question 3) — both readings are on the record and the fact id is
   * now marked `contradicted`, blocking like MISSING until resolved.
   */
  contradicted?: boolean;
}

/** Same drawing = same stored document, or failing that, same drawing number. */
function sameDrawing(a: Fact['source'], b: Fact['source']): boolean {
  if (!a || !b) return false;
  if (a.documentId && b.documentId) return a.documentId === b.documentId;
  return a.drawingNumber === b.drawingNumber;
}

/** Is `next` a strictly newer revision of the same drawing than `cur`? */
function newerRevisionOfSameDrawing(next: Fact, cur: Fact): boolean {
  if (!sameDrawing(next.source, cur.source)) return false;
  const nextRank = revisionRank(next.source!.revision);
  const curRank = revisionRank(cur.source!.revision);
  if (nextRank === null || curRank === null) return false;
  return nextRank > curRank;
}

/**
 * Trust-ordered overwrite — the rule memory enforces (PRODUCT_AS_HARNESS §3.3).
 *
 * A fact may only replace the current one for its id when it carries a
 * STRICTLY higher trust state (MEASURED > DECLARED > DERIVED = SUPPLIED >
 * MISSING), or the same state read from a NEWER revision of the same drawing.
 * A DECLARED claim never silently replaces a MEASURED value.
 *
 * A rejected write is not dropped: it is appended flagged
 * `contradicts: "<id>@<seq>"` (and immediately superseded by the current
 * entry, so it never resolves), and the current fact gains `contradictedBy`.
 * The losing claim is on the record; the last writer does not win.
 *
 * `addFact` remains available for unconditional appends; harness writers go
 * through recordFact.
 */
export function recordFact(ledger: Ledger, fact: Fact): RecordResult {
  const cur = currentEntry(ledger, fact.id);
  if (!cur) return { ledger: appendFact(ledger, fact), accepted: true };

  // Resolution path (open question 3): a contradicted fact is settled by a
  // human answer. SUPPLIED would normally lose to DECLARED on trust; here a
  // person is choosing which of two equal claims governs, so it lands.
  if (cur.fact.contradicted === true && fact.state === 'SUPPLIED') {
    return { ledger: appendFact(ledger, fact, 'user-override'), accepted: true };
  }

  // A PERSON CORRECTING THEMSELVES IS NOT A SECOND OPINION.
  //
  // Two SUPPLIED claims are equal on trust, so the rule below would refuse the
  // later one ("can only replace SUPPLIED from a newer revision of the same
  // drawing") and keep the first. That rule is right about READINGS — two
  // measurements of one drawing that disagree cannot be settled by arrival
  // order. It is wrong about answers: there is one person, answering the same
  // question again, and the second answer is the one they mean. A mistyped
  // 100 that could never be withdrawn left every row it fed blocked forever,
  // with the correction silently discarded.
  //
  // The first answer is not lost — it supersedes into history like any other,
  // with 'user-override' saying what happened.
  if (fact.state === 'SUPPLIED' && cur.fact.state === 'SUPPLIED') {
    return { ledger: appendFact(ledger, fact, 'user-override'), accepted: true };
  }

  const curTrust = trustOf(cur.fact.state);
  const newTrust = trustOf(fact.state);
  if (newTrust > curTrust) {
    return { ledger: appendFact(ledger, fact, 'higher-trust'), accepted: true };
  }
  if (fact.state === cur.fact.state && newerRevisionOfSameDrawing(fact, cur.fact)) {
    return { ledger: appendFact(ledger, fact, 'newer-revision'), accepted: true };
  }

  // Contradiction between equals (open question 3): same state, different
  // drawings, neither newer, values disagreeing. The trust rule cannot settle
  // it. Both readings are recorded; the incumbent stays current but is marked
  // `contradicted`, which BLOCKS like MISSING (isUsable → false) and surfaces
  // through blockedFacts() with a synthesised ask.
  const equalTrustClash =
    fact.state === cur.fact.state &&
    !sameDrawing(fact.source, cur.fact.source) &&
    fact.value !== cur.fact.value;

  const reason = equalTrustClash
    ? `equal-trust ${fact.state} from a different drawing disagrees — both recorded, fact marked contradicted`
    : newTrust < curTrust
      ? `${fact.state} cannot replace ${cur.fact.state} — lower trust`
      : `${fact.state} can only replace ${cur.fact.state} from a newer revision of the same drawing`;

  const seq = nextSeq(ledger);
  const winnerRef = entryRef(cur);
  const rejected: LedgerEntry = {
    seq,
    fact: {
      ...fact,
      contradicts: winnerRef,
      supersededBy: winnerRef,
      recordedAt: fact.recordedAt ?? Date.now(),
      supersededReason: 'contradicted',
    },
  };
  const rejectedRef = entryRef(rejected);
  const entries = ledger.entries.map((e) =>
    e.seq === cur.seq
      ? {
          seq: e.seq,
          fact: {
            ...e.fact,
            contradictedBy: [...(e.fact.contradictedBy ?? []), rejectedRef],
            ...(equalTrustClash ? { contradicted: true } : {}),
          },
        }
      : e,
  );
  return {
    ledger: { entries: [...entries, rejected] },
    accepted: false,
    reason,
    ...(equalTrustClash ? { contradicted: true } : {}),
  };
}

/**
 * Hash invalidation (PRODUCT_AS_HARNESS §3.4). A drawing was re-imported and
 * its hash changed: every CURRENT fact sourced from it (by documentId or
 * drawing number) whose `sourceDrawingHash` no longer matches is marked
 * `stale` — marked, never deleted; the value and its provenance remain
 * legible. A fact whose hash matches again is un-marked. SUPPLIED facts
 * survive un-stale: a human's answer about the project does not expire when
 * a drawing is revised. Facts carrying no hash are left untouched — there is
 * nothing to verify them against.
 */
export function invalidateBySource(
  ledger: Ledger,
  documentIdOrDrawingNumber: string,
  newHash: string,
): Ledger {
  const entries = ledger.entries.map((e) => {
    const f = e.fact;
    if (f.supersededBy !== undefined) return e;
    const src = f.source;
    const matches =
      !!src &&
      (src.documentId === documentIdOrDrawingNumber ||
        src.drawingNumber === documentIdOrDrawingNumber);
    if (!matches) return e;
    if (f.state === 'SUPPLIED') {
      return f.stale ? { seq: e.seq, fact: { ...f, stale: undefined } } : e;
    }
    if (f.sourceDrawingHash === undefined) return e;
    if (f.sourceDrawingHash !== newHash) {
      return f.stale ? e : { seq: e.seq, fact: { ...f, stale: true } };
    }
    return f.stale ? { seq: e.seq, fact: { ...f, stale: undefined } } : e;
  });
  return { entries };
}

/** The current (latest non-superseded) fact for an id, or undefined. */
export function resolveFact(ledger: Ledger, id: string): Fact | undefined {
  for (let i = ledger.entries.length - 1; i >= 0; i--) {
    const e = ledger.entries[i];
    if (e.fact.id === id && e.fact.supersededBy === undefined) return e.fact;
  }
  return undefined;
}

/** Full history for an id, oldest first (superseded entries included). */
export function factHistory(ledger: Ledger, id: string): Fact[] {
  return ledger.entries.filter((e) => e.fact.id === id).map((e) => e.fact);
}

/** A human answer to a MISSING fact. */
export interface SuppliedAnswer {
  value: Exclude<Fact['value'], null>;
  unit?: string;
  /** Who supplied it (name/email/channel). Required — SUPPLIED is attributable. */
  suppliedBy: string;
  /** ISO date; defaults to today. */
  on?: string;
  /** Optional quote of the answer as given ("client email 12/3", "100 m on call"). */
  evidence?: string[];
  /**
   * The drawing that was open when the answer was given — CONTEXT, never
   * authority. See `answerPlacement`.
   */
  askedOn?: string;
}

/**
 * WHERE AN ANSWERED FACT BELONGS.
 *
 * `factOnDrawing` shows a fact nothing can place on EVERY drawing, by design —
 * a question nobody can find is worse than one listed twice. The interview
 * path learned to place its answers (`askedAboutTrail` in interview/facts.ts);
 * this path never did. So answering `c1.height` on the columns sheet, or
 * overriding it, dropped the placement the MISSING entry already carried, and
 * the answer then appeared on the pedestal sheet, the foundations sheet, and
 * every other one — "not tied to a drawing" against a value that was tied to a
 * drawing until the moment it was answered.
 *
 * Priority is the honest order: what the fact already knew, then where the
 * value it replaces was read, then the drawing that happened to be open.
 *
 * It goes in `lookedIn`, NEVER in `source`. `source` would claim the drawing
 * SAYS this; a person said it. That distinction is the whole of §7.1.
 */
export function answerPlacement(prior: Fact | undefined, askedOn?: string): string[] | undefined {
  if (prior?.lookedIn?.length) return prior.lookedIn;
  const src = prior?.source;
  if (src?.drawingNumber) {
    const rev = src.revision ? ` ${src.revision}` : '';
    return [`${src.drawingNumber}${rev} — where the value this answer replaces was read`];
  }
  if (askedOn) return [`${askedOn} — the drawing open when this was answered`];
  return undefined;
}

/**
 * Convert a MISSING fact into a SUPPLIED one from a human answer, recording
 * who and when. Context worth keeping from the MISSING entry (neededFor, ask)
 * is carried over; the MISSING entry itself stays in history, superseded.
 * Supplying an id with no prior entry is allowed (a human volunteering a fact).
 */
export function supplyFact(ledger: Ledger, id: string, answer: SuppliedAnswer): Ledger {
  const prior = resolveFact(ledger, id);
  const lookedIn = answerPlacement(prior, answer.askedOn);
  const fact: Fact = {
    id,
    value: answer.value,
    unit: answer.unit ?? prior?.unit,
    state: 'SUPPLIED',
    evidence: answer.evidence,
    neededFor: prior?.neededFor,
    ask: prior?.ask,
    ...(lookedIn ? { lookedIn } : {}),
    suppliedBy: answer.suppliedBy,
    readOn: answer.on ?? new Date().toISOString().slice(0, 10),
  };
  const reason: SupersedeReason | undefined =
    prior === undefined ? undefined : prior.state === 'MISSING' ? 'higher-trust' : 'user-override';
  return appendFact(ledger, fact, reason);
}

/**
 * A downstream check disputes a value it has proved cannot be right.
 *
 * WHY THIS EXISTS
 *
 * A fact could only be reopened two ways: it was MISSING, or two drawings
 * disagreed about it. Neither covers the case that actually stops a schedule —
 * ONE value, on the record, that an arithmetic gate further down has since
 * shown to be impossible. A pedestal answered as 100 mm high produced a 100 mm
 * vertical bar; the engine refused it (a bar shorter than its own development
 * length is not a bar) and the row blocked. But the fact was present and
 * usable, so nothing asked about it, and nothing could: the run had no way to
 * say "this answer is the problem". The row stayed BLOCKED for good.
 *
 * A dispute marks the incumbent `contradicted`, which blocks exactly like
 * MISSING (isUsable → false) and surfaces through `blockedFacts` carrying the
 * checker's own sentence as the question. It is settled the way any
 * contradicted fact is settled — by a SUPPLIED answer, which `recordFact`
 * already accepts over a contradicted incumbent.
 *
 * The value is NOT deleted and NOT replaced by a guess. It stands on the
 * record, marked, until a person says what the number really is.
 */
export function disputeFact(
  ledger: Ledger,
  id: string,
  dispute: { reason: string; ask: string },
): Ledger {
  const cur = currentEntry(ledger, id);
  if (!cur) return ledger;
  // Disputing the same value for the same reason twice is one dispute. Re-runs
  // of a schedule raise the same objection every time, and each one must not
  // re-write the ledger and re-notify.
  if (cur.fact.contradicted === true && cur.fact.disputedBecause === dispute.reason) return ledger;
  return {
    entries: ledger.entries.map((e) =>
      e.seq === cur.seq
        ? {
            seq: e.seq,
            fact: { ...e.fact, contradicted: true, disputedBecause: dispute.reason, ask: dispute.ask },
          }
        : e,
    ),
  };
}

/**
 * A person overrides a fact (§4.5): the new value is recorded as SUPPLIED and
 * the overridden value is kept in history with reason 'user-override'. The
 * ledger never loses what the drawing said — the old entry stays, superseded,
 * its source intact. Trust is deliberately bypassed: an override is a human
 * decision, not a competing reading.
 */
export function overrideFact(ledger: Ledger, id: string, answer: SuppliedAnswer): Ledger {
  const prior = resolveFact(ledger, id);
  const lookedIn = answerPlacement(prior, answer.askedOn);
  const fact: Fact = {
    id,
    value: answer.value,
    unit: answer.unit ?? prior?.unit,
    state: 'SUPPLIED',
    evidence: answer.evidence,
    neededFor: prior?.neededFor,
    ...(lookedIn ? { lookedIn } : {}),
    suppliedBy: answer.suppliedBy,
    readOn: answer.on ?? new Date().toISOString().slice(0, 10),
  };
  return appendFact(ledger, fact, 'user-override');
}

/** Does a DERIVED fact depend on `id` — structured `dependsOn` first, basis text as fallback. */
function derivesFrom(fact: Fact, id: string): boolean {
  if (fact.dependsOn?.includes(id)) return true;
  return typeof fact.basis === 'string' && fact.basis.includes(id);
}

export interface WithdrawResult {
  ledger: Ledger;
  /** false when the current fact for the id is not SUPPLIED (nothing to withdraw). */
  withdrawn: boolean;
  /** Current DERIVED facts that depended on the withdrawn answer, now marked stale. */
  staleDependents: string[];
}

/**
 * Withdraw a SUPPLIED answer (§4.5). The fact returns to MISSING — restoring
 * the ask/lookedIn context from its earlier MISSING entry when there was one —
 * so it blocks and surfaces again; the withdrawn answer stays in history with
 * reason 'withdrawn', never deleted. Every current DERIVED fact that depended
 * on it is marked stale so dependents recompute rather than standing on a
 * retracted answer.
 */
export function withdrawFact(ledger: Ledger, id: string): WithdrawResult {
  const cur = currentEntry(ledger, id);
  if (!cur || cur.fact.state !== 'SUPPLIED') {
    return { ledger, withdrawn: false, staleDependents: [] };
  }
  let priorMissing: Fact | undefined;
  for (const e of ledger.entries) {
    if (e.fact.id === id && e.fact.state === 'MISSING') priorMissing = e.fact;
  }
  const missing: Fact = {
    id,
    value: null,
    state: 'MISSING',
    neededFor: cur.fact.neededFor ?? priorMissing?.neededFor,
    lookedIn: priorMissing?.lookedIn,
    ask:
      cur.fact.ask ??
      priorMissing?.ask ??
      `The supplied value for ${id} ("${cur.fact.saidAs ?? String(cur.fact.value)}") was withdrawn — what is the correct value?`,
    readOn: new Date().toISOString().slice(0, 10),
  };
  const withMissing = appendFact(ledger, missing, 'withdrawn');

  const staleDependents: string[] = [];
  const entries = withMissing.entries.map((e) => {
    const f = e.fact;
    if (f.supersededBy === undefined && f.state === 'DERIVED' && derivesFrom(f, id)) {
      staleDependents.push(f.id);
      return { seq: e.seq, fact: { ...f, stale: true } };
    }
    return e;
  });
  return { ledger: { entries }, withdrawn: true, staleDependents };
}

/** All current facts still in state MISSING — the open-question list. */
export function missingFacts(ledger: Ledger): Fact[] {
  const out: Fact[] = [];
  for (const e of ledger.entries) {
    if (e.fact.supersededBy === undefined && e.fact.state === 'MISSING') out.push(e.fact);
  }
  return out;
}

// ------------------------------------------------------------
// Inline history (§5.3) — the queryable view over the entries
// ------------------------------------------------------------

/**
 * One version a fact has held (§5.3). `reason` is why THIS version was
 * replaced; the current version carries neither `supersededAt` nor `reason`.
 */
export interface FactVersion {
  value: FactValue;
  state: FactState;
  /** the OLD drawing + revision + handles — stays resolvable */
  source?: FactSource;
  recordedAt: number;
  supersededAt?: number;
  reason?: SupersedeReason;
}

const VERSION_CAP = 20;

function toVersion(fact: Fact): FactVersion {
  return {
    value: fact.value,
    state: fact.state,
    ...(fact.source !== undefined ? { source: fact.source } : {}),
    recordedAt: fact.recordedAt ?? (fact.readOn ? Date.parse(fact.readOn) || 0 : 0),
    ...(fact.supersededAt !== undefined ? { supersededAt: fact.supersededAt } : {}),
    ...(fact.supersededReason !== undefined ? { reason: fact.supersededReason } : {}),
  };
}

/**
 * Every value a fact has ever held, NEWEST FIRST, derived from the ledger's
 * append-only entries (rejected claims included — their reason is
 * 'contradicted'). Capped at 20 as the first + the last 19: the original
 * reading is the one people go back to, so it always survives the cap.
 */
export function factVersions(ledger: Ledger, id: string): FactVersion[] {
  const chronological = ledger.entries.filter((e) => e.fact.id === id).map((e) => e.fact);
  const capped =
    chronological.length > VERSION_CAP
      ? [chronological[0], ...chronological.slice(chronological.length - (VERSION_CAP - 1))]
      : chronological;
  return capped.map(toVersion).reverse();
}

// ------------------------------------------------------------
// Blocked facts (open question 3) — missing + contradicted
// ------------------------------------------------------------

export interface BlockedFact {
  id: string;
  kind: 'missing' | 'contradicted';
  /** the current fact: the MISSING entry, or the contradicted incumbent */
  fact: Fact;
  /** contradicted only: the standing equal-trust rival claims, oldest first */
  rivals?: Fact[];
  /** the question to put to a human — the fact's own ask, or one synthesised from the disagreeing sources */
  ask?: string;
}

function claimLabel(fact: Fact): string {
  if (fact.source) return `${fact.source.drawingNumber} ${fact.source.revision}`.trim();
  if (fact.suppliedBy) return fact.suppliedBy;
  return 'unknown source';
}

/** "ARCH-101 R0 says 100000, SITE-01 R0 says 98000 — which governs?" */
function synthesiseAsk(incumbent: Fact, rivals: Fact[]): string {
  const claims = [incumbent, ...rivals].map((f) => `${claimLabel(f)} says ${String(f.value)}`);
  return `${claims.join(', ')} — which governs?`;
}

/** The equal-trust rival entries recorded against a contradicted incumbent, oldest first. */
function rivalsOf(ledger: Ledger, incumbent: LedgerEntry): Fact[] {
  const refs = new Set(incumbent.fact.contradictedBy ?? []);
  const out: Fact[] = [];
  for (const e of ledger.entries) {
    if (refs.has(entryRef(e)) && trustOf(e.fact.state) === trustOf(incumbent.fact.state)) {
      out.push(e.fact);
    }
  }
  return out;
}

/**
 * `missingFacts`'s sibling: everything that BLOCKS a computation — current
 * MISSING facts and current contradicted facts (open question 3) — each with
 * the question to ask. A contradicted fact's ask is synthesised from the
 * disagreeing sources; resolution arrives as a SUPPLIED answer via recordFact.
 */
export function blockedFacts(ledger: Ledger): BlockedFact[] {
  const out: BlockedFact[] = [];
  for (const e of ledger.entries) {
    const f = e.fact;
    if (f.supersededBy !== undefined) continue;
    if (f.state === 'MISSING') {
      out.push({ id: f.id, kind: 'missing', fact: f, ...(f.ask !== undefined ? { ask: f.ask } : {}) });
    } else if (f.contradicted === true) {
      const rivals = rivalsOf(ledger, e);
      // A disputed fact has no rival to name — the ask that came with the
      // dispute is the only one that says anything, and synthesising
      // "unknown source says 100 — which governs?" over the top of it would
      // replace a real question with a meaningless one.
      const ask = f.disputedBecause !== undefined && f.ask ? f.ask : synthesiseAsk(f, rivals);
      out.push({ id: f.id, kind: 'contradicted', fact: f, rivals, ask });
    }
  }
  return out;
}

/** All current facts read from a given drawing number. */
export function factsBySource(ledger: Ledger, drawingNumber: string): Fact[] {
  const out: Fact[] = [];
  for (const e of ledger.entries) {
    if (e.fact.supersededBy === undefined && e.fact.source?.drawingNumber === drawingNumber) {
      out.push(e.fact);
    }
  }
  return out;
}
