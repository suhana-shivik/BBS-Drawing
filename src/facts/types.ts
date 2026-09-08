// Project fact ledger — types.
//
// The fact sheet is a ledger, not a transcription (HOW_TO_BUILD_IT §6.2).
// Every fact carries a provenance and a state; the state decides trust:
//
//   MEASURED  computed by code from geometry        — highest, reproducible
//   DECLARED  written on a drawing, read by model   — high, quotable, has a handle
//   DERIVED   inferred by combining facts           — medium, auditable (basis)
//   SUPPLIED  given by a human                      — medium, attributable
//   MISSING   required, searched for, not found     — BLOCKS the quantity
//
// Fact ids are stable and semantic: "<subject>.<name>", e.g. "wall.total_run".

export type FactState = 'MEASURED' | 'DECLARED' | 'DERIVED' | 'SUPPLIED' | 'MISSING';

/**
 * Why a superseded (or rejected) entry was replaced (§5.3). Stamped on the
 * OLD entry at supersede time; `factVersions` surfaces it per version.
 *
 *   newer-revision  same state read from a newer revision of the same drawing
 *   higher-trust    a strictly higher-trust state replaced it
 *   user-override   a person overrode the value (recorded as SUPPLIED, §4.5)
 *   withdrawn       a SUPPLIED answer was withdrawn by the person who gave it
 *   contradicted    the entry is a claim that lost — it was never current
 */
export type SupersedeReason =
  | 'newer-revision'
  | 'higher-trust'
  | 'user-override'
  | 'withdrawn'
  | 'contradicted';

export type FactValue = number | string | boolean | null;

/** Where a fact was read from: a drawing at a revision, optionally a section. */
export interface FactSource {
  drawingNumber: string;
  revision: string;
  /**
   * The ENGINEERING section this was read from — the whole detail, not the
   * cluster of ink it happened to sit in.
   */
  sectionId?: string;
  /**
   * Every visual region that section is drawn across. A detail drawn as four
   * separated clusters lists four; a highlight, a crop or a targeted re-read
   * still addresses the exact one it needs, while the fact belongs to the
   * detail as a whole.
   */
  regionIds?: string[];
  /** id of the stored document the drawing was read from (multi-drawing projects). */
  documentId?: string;
  /** DXF entity handles behind the reading — the audit trail. */
  handles?: string[];
  /** Verbatim text, exactly as drawn (e.g. "350X400"). */
  rawText?: string;
}

export interface Fact {
  /** Stable semantic id: "<subject>.<name>", e.g. "wall.total_run". */
  id: string;
  /** The reading. null when the fact is MISSING (never an invented number). */
  value: FactValue;
  /** Unit of the value where applicable, e.g. "mm". */
  unit?: string;
  state: FactState;
  /** Provenance: which drawing/revision/section this was read from. */
  source?: FactSource;
  /** Entity handles and/or verbatim text quotes backing the reading. */
  evidence?: string[];
  /** MEASURED: how code produced it, e.g. "buildPlacementBands() over F1/C1". */
  method?: string;
  /** DERIVED: the combination of facts and reasoning it was inferred from. */
  basis?: string;
  /** What quantities/rows this fact is needed for. */
  neededFor?: string[];
  /** MISSING: drawings/places that were searched before giving up. */
  lookedIn?: string[];
  /** MISSING: the exact question to put to a human. */
  ask?: string;
  /** ISO date the fact was read/recorded. */
  readOn: string;
  /** SUPPLIED: who gave the answer (name/email/channel). */
  suppliedBy?: string;
  /** SUPPLIED: the exact words the human used, so the value can be checked. */
  saidAs?: string;
  /**
   * Identity of the exact drawing bytes/structure this was read from.
   * When the drawing is re-imported and its hash changes, the fact goes stale
   * (see invalidateBySource) — it is marked, never deleted.
   */
  sourceDrawingHash?: string;
  /** Set when the source drawing changed since this was read. SUPPLIED facts never go stale. */
  stale?: boolean;
  /**
   * Set on the historical record of a write recordFact REJECTED: this entry's
   * claim lost to the current fact it names ("<id>@<seq>"). The claim stays on
   * the record; it was never current.
   */
  contradicts?: string;
  /**
   * Set on a current fact when later, lower-trust claims tried and failed to
   * replace it. Refs of the rejected entries, oldest first.
   */
  contradictedBy?: string[];
  /**
   * Set on a historical entry when a later entry for the same id replaced it.
   * Holds the superseding entry's ref ("<id>@<seq>"). History is never deleted.
   * (A rejected recordFact entry also carries this, pointing at the current
   * fact that held against it, so it never resolves as current.)
   */
  supersededBy?: string;
  /** Epoch ms the entry was appended to the ledger (stamped at append time). */
  recordedAt?: number;
  /** Epoch ms the entry was superseded, stamped alongside `supersededBy`. */
  supersededAt?: number;
  /** Why the entry was superseded/rejected — see SupersedeReason (§5.3). */
  supersededReason?: SupersedeReason;
  /**
   * Set on a CURRENT fact when a claim of EQUAL trust from a different
   * drawing disagrees with it and neither can win (open question 3). A
   * contradicted fact BLOCKS exactly like MISSING until a SUPPLIED answer
   * (or a higher-trust reading) settles which governs. The rival claims are
   * in `contradictedBy`.
   */
  contradicted?: boolean;
  /**
   * Why a downstream check disputed this value — set alongside `contradicted`
   * by `disputeFact`, in the checker's own words.
   *
   * The other route to `contradicted` is two drawings disagreeing, where the
   * question to put to a person can be synthesised from the two sources. This
   * route has no rival claim to name: the value is on the record ONCE and an
   * arithmetic gate downstream has shown it cannot be right. The reason is
   * the only thing that makes such a question answerable, so it is kept.
   */
  disputedBecause?: string;
  /**
   * DERIVED: ids of the facts this one was combined from (§4.3 fromKeys).
   * Lets withdrawFact/applyRevisionFacts mark dependents stale for recompute.
   */
  dependsOn?: string[];
}

/**
 * Trust order (§6.2): MEASURED > DECLARED > DERIVED = SUPPLIED; MISSING is not
 * usable at all — it blocks.
 */
export const FACT_TRUST: Record<FactState, number> = {
  MEASURED: 3,
  DECLARED: 2,
  DERIVED: 1,
  SUPPLIED: 1,
  MISSING: 0,
};

export function trustOf(state: FactState): number {
  return FACT_TRUST[state];
}

/**
 * A fact is usable in a computation only when it is not MISSING (§6.4) and
 * not contradicted — an unresolved equal-trust disagreement blocks exactly
 * like a hole (open question 3).
 */
export function isUsable(fact: Fact): boolean {
  return fact.state !== 'MISSING' && fact.contradicted !== true;
}

/**
 * Does this fact belong to the drawing on screen?
 *
 * The ledger is PROJECT-wide — one drawing's schedule can be blocked by a fact
 * read off another, which is the point of keeping one ledger. But a
 * specification that lists every drawing's facts at once cannot be read as any
 * one drawing's specification, and that is what a person opening a drawing is
 * asking for.
 *
 * Three cases, in order:
 *
 *  1. A fact with a source belongs to the drawing it was READ from.
 *  2. A fact with no source but a `lookedIn` trail belongs to the drawing the
 *     run SEARCHED. Gaps carried no source until they were taught to, so this
 *     is what keeps a ledger written before then on the right drawing rather
 *     than on all of them.
 *  3. Anything still unattributable shows on every drawing. Hiding a fact
 *     nothing can place would make it unreachable from any surface at all —
 *     an open question in a ledger nobody can find is worse than one listed
 *     twice (§3, nothing closes without leaving a way back).
 */
/**
 * Can this fact be tied to a drawing at all?
 *
 * `factOnDrawing` shows an unplaceable fact on EVERY drawing, deliberately —
 * hiding one would make it unreachable from any surface. But shown without
 * comment it reads as a fact OF the drawing you are looking at, which is how
 * an answer given on the columns sheet came to appear in the foundations
 * specification as if the foundations sheet had said it.
 *
 * So the surfaces ask this and say so. Facts written before answers recorded
 * which drawing they were asked on are the ones that fail it, and they cannot
 * be placed retroactively — nothing ever stored where they came from.
 */
export function factPlaceable(fact: Fact): boolean {
  return Boolean(fact.source || fact.lookedIn?.length);
}

export function factOnDrawing(fact: Fact, drawingNumber: string): boolean {
  if (!drawingNumber) return true;
  if (fact.source) return fact.source.drawingNumber === drawingNumber;
  if (fact.lookedIn?.length) {
    return fact.lookedIn.some((where) => where.startsWith(drawingNumber));
  }
  return true;
}

/** "wall.total_run" → "wall". */
export function factSubject(id: string): string {
  const dot = id.indexOf('.');
  return dot === -1 ? id : id.slice(0, dot);
}

/** "wall.total_run" → "total_run". */
export function factName(id: string): string {
  const dot = id.indexOf('.');
  return dot === -1 ? '' : id.slice(dot + 1);
}
