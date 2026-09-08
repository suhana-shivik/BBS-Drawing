// Bar Bending Schedule — the contract between extraction, interpretation and
// the engine.
//
// The division this file encodes, and the reason it exists:
//
//   ExtractedTable / ExtractedCallout   what the DRAWING says   (deterministic)
//   BbsInterpretation                   what it MEANS           (model)
//   BbsRow                              what it WEIGHS          (engine)
//
// The model never produces a length, a count or a weight. It says which
// callout belongs to which member and what kind of bar it is. Every number is
// computed by `domain/india/bbs.ts` from the extracted inputs, so a mislabel is
// a visible naming error and never a wrong figure in a cutting list.
import type { ShapeCode, BendMode, HookType } from '../../domain/india/bbs';

// ------------------------------------------------------------
// 1. what the drawing says — extracted, never inferred
// ------------------------------------------------------------

/** a table reconstructed from text positions; DXF tables have no structure */
export interface ExtractedTable {
  /** the title text that identified it, e.g. "PEDESTAL SCHEDULE :" */
  title: string;
  /** header row as read, may be empty if the table has none */
  header: string[];
  rows: string[][];
  /** model-space bounds, so the UI can zoom to it */
  min: { x: number; y: number };
  max: { x: number; y: number };
  /** handles of the text entities involved, for click-to-verify */
  handles: string[];
}

/** one rebar annotation exactly as written on the drawing */
export interface ExtractedCallout {
  /** verbatim text, e.g. "8 (2L)@100 C/C" or "10-20+14-16" */
  raw: string;
  /** parsed pieces — absent when the pattern did not match */
  diaMm?: number;
  spacingMm?: number;
  count?: number;
  legs?: number;
  /** a second diameter, for "10-20+14-16" style compound mains */
  secondDiaMm?: number;
  secondCount?: number;
  /** zone qualifier, e.g. "ZONE A" */
  zone?: string;
  position: { x: number; y: number };
  handle: string;
  layer: string;
}

/**
 * A general note that is really a RULE — "ALL DISTRIBUTION BARS ARE 8 @ 250
 * C/C", "LAPS, SPLICES & BOND LENGTH SHOULD BE 50 D". Left as prose these
 * never reach the schedule; parsed, the model can apply them to every member
 * they govern instead of asking for what the sheet already answered.
 */
export interface GlobalBarRule {
  kind: 'distribution' | 'chairs' | 'spacer' | 'lap';
  diaMm?: number;
  spacingMm?: number;
  /** for laps/bond stated as a bar-diameter multiple ("50 D") */
  multiple?: number;
  /** the note verbatim, so the rule is always checkable */
  raw: string;
}

/** one line of a per-member cover table ("b. COLUMN | 40") */
export interface MemberCover {
  member: string;
  /** as listed left to right — typically top/bottom/side, or a single value */
  coversMm: number[];
  raw: string;
}

/** project-level facts read off the sheet's notes */
export interface ExtractedNotes {
  concreteGrade?: string;
  steelGrade?: string;
  coverMm?: number;
  /**
   * Cover stated as a TABLE (member × face), the common form on consultant
   * sheets. When this is present `coverMm` is deliberately left unset — there
   * is no single sheet-wide cover, and pretending there is one puts a footing
   * cover on a slab bar.
   */
  coverByMember?: MemberCover[];
  globalRules?: GlobalBarRule[];
  /** free text the model may reason over */
  notes: string[];
}

/**
 * A member DECLARED on the sheet by name and size rather than by a schedule
 * row — "TB-(350X400)", "RCC WALL 200THK.", "H-POLE (150X150X2400)",
 * "PRECAST PANEL (2000x300x50thk)". Typical-detail sheets (boundary walls,
 * fences, trenches) carry most of their members this way and no schedule
 * table at all; a mark grammar tuned to "P1"/"F3" sees none of them.
 */
export interface DeclaredMember {
  /** normalised name: "TB", "RCC WALL", "H-POLE", "PRECAST PANEL" */
  name: string;
  /** the size text exactly as written, e.g. "350X400", "200THK", "150X150X2400" */
  sizeText: string;
  /** parsed mm, in the order written */
  dimsMm: number[];
  /** how many times the declaration (or its bare name) appears on the sheet */
  occurrences: number;
  raw: string;
  handles: string[];
}

export interface DrawingExtract {
  drawingName: string;
  /**
   * The document's `sourceFile`, which is the key harness memory is filed
   * under. `drawingName` is `doc.name` and is NOT the same string — filing
   * against the wrong one wrote facts that were then unreadable, so the key
   * travels with the extract rather than being re-derived.
   */
  sourceFile: string;
  tables: ExtractedTable[];
  callouts: ExtractedCallout[];
  notes: ExtractedNotes;
  /** element marks found anywhere on the sheet, e.g. P1..P8, F1..F9 */
  marks: string[];
  /** members declared by name+size where no schedule table exists — see above */
  declared: DeclaredMember[];
  /** millimetres per drawing unit, after the unit sanity check */
  unitScale: number;
  /** content hash of the source DXF/PDF — used by the manifest for staleness detection */
  hash?: string;
}

// ------------------------------------------------------------
// 2. what it means — the model's only output
// ------------------------------------------------------------

/**
 * One structural member the schedule is written for.
 * Dimensions come from the extracted table; the model only says which column
 * meant what.
 */
export interface BbsMember {
  /** P1, F3, PB2 */
  mark: string;
  /** pedestal, footing, plinth beam, column, slab… */
  type: string;
  /** mm — from the drawing's own schedule table */
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  /** how many of this member exist */
  count: number;
  /**
   * How the count FOLLOWS from the run, when the sheet cannot state it.
   *
   * A typical-detail sheet draws one bay. It has no schedule table, so
   * `countRef` has nothing to point at and every member fell to 1 — which
   * under-prices a 100 m boundary wall by roughly fifty times. But the count is
   * not unknowable: the drawing DIMENSIONS the pitch (columns at 2050 c/c,
   * footings at 4187), and the run comes from the user. The model points at
   * that pitch; the engine divides, once the run is known.
   *
   * `endsInclusive` is the fence-post: members standing AT the node (columns,
   * footings) get the closing one, things spanning BETWEEN nodes (panels,
   * bays) do not.
   */
  countRule?: { pitchMm: number; endsInclusive: boolean };
  /**
   * The clear cover that governs THIS member, in mm — resolved by `cover.ts`
   * against the sheet's own cover table, not the sheet-wide settings figure.
   *
   * A drawing states cover as a table because cover is not one number: column
   * 40, tie beam 30, foundation 50. The engine used to collapse that to
   * `settings.coverMm` and apply it everywhere, so every tie-beam link arm came
   * out 20 mm short on each face — always in the under-ordering direction.
   *
   * Unset means the cover table does not describe this member. The engine then
   * falls back to `settings.coverMm` and RECORDS that it did (`BbsRow.
   * coverSource === 'settings-default'`), because a defaulted cover and one
   * read off the sheet must never look the same on the schedule.
   */
  coverMm?: number;
  /** which precedence step in `cover.ts` produced `coverMm` */
  coverSource?: string;
  /**
   * Where each resolved axis came from — "FOOTING SCHEDULE row F8, column
   * W SIZE = 3200 (schedule table, read deterministically)", "supplied by the
   * user as \"3500\"", or the model's pointer. A number alone cannot be
   * checked; the evidence it was read from can, so it rides the member into
   * every row's trace.
   */
  dimSources?: Partial<Record<'L' | 'W' | 'H', string>>;
  /** which extracted table row this came from */
  source: { table: string; row: number };
  /** true when a dimension the schedule needs was not on this sheet */
  incomplete: boolean;
  missing: string[];
}

/**
 * One rebar callout tied to a member. STILL NO LENGTH — this is the input a
 * cutting length is computed from, exactly as `bbs_reinforcement` holds it.
 */
export interface BbsBar {
  /** bar mark if the drawing carried one; the engine assigns otherwise */
  barMark?: string;
  memberMark: string;
  barType:
    | 'MAIN' | 'DISTRIBUTION' | 'TOP' | 'BOTTOM' | 'CROSS'
    | 'STIRRUP' | 'RING' | 'TIE' | 'EXTRA' | 'CRANK' | 'CURTAILMENT';
  diaMm: number;
  shapeCode: ShapeCode;
  /** which member axis the bars run along, for AUTO_SPACING */
  distributionAxis?: 'L' | 'W' | 'H';
  spacingMm?: number;
  /** stated count, when the drawing gives a number instead of a spacing */
  manualCount?: number;
  legs?: number;
  hookStart?: HookType;
  hookEnd?: HookType;
  zone?: string;
  /** the callout this came from, verbatim — always traceable */
  fromCallout: string;
  handles: string[];
  /** the model's confidence in the association, 0..1 */
  confidence?: number;
  note?: string;
  /**
   * Set by `conventions.ts`, never by the model: this run sits on the upper
   * mat layer, so its end legs are one bar diameter shorter. It lives on the
   * bar rather than in settings because it varies bar by bar within a member.
   */
  upperLayer?: boolean;
  /**
   * The straight half of an alternate bent-up pair. Set by conventions.ts,
   * never by the model; it is what earns the row its "-Alt." name.
   */
  alternate?: boolean;
  /**
   * How far this bar stops short of the concrete face at EACH end, in mm.
   *
   * Normally that is the cover, and this is left unset. The alternate straight
   * bar of a bent-up pair is different: the foundation drawing dimensions it
   * as "X/Y TYP." and the footing schedule carries X and Y per footing — 100
   * on this job. That is a stated end distance, not a cover, and reading it as
   * cover made every straight bar 100 mm long.
   */
  endDeductionMm?: number;
  /**
   * THE DRAWING'S OWN GEOMETRY for this bar, when it draws one. A polyline
   * traced on the detail, or a developed length the sheet states. It wins
   * over every library shape: a formula is what a schedule uses when the
   * drawing does not show the bar, and this is the drawing showing it.
   */
  drawnGeometry?: DrawnGeometry;
  /** a stated rule for bars per member — CUSTOM_FORMULA over L, W, H, T, S, COVER, DIA */
  countFormula?: string;
  /** a stated rule for the cutting length — CUSTOM_FORMULA over the same variables */
  lengthFormula?: string;
  /**
   * THE BAR'S OWN LEG DIMENSIONS, when the drawing states them or a person
   * completes them in the editable schedule. A, B, C, D are normally DERIVED
   * from the member's axes less cover; a schedule that dimensions the bar
   * itself states them, and then they govern. The shape formula still
   * computes the cutting length from them — this is an input, not a way to
   * type a length in.
   */
  legDimsMm?: Partial<Record<'A' | 'B' | 'C' | 'D', number>>;
}

export interface DrawnGeometry {
  /** the developed centre-line length as drawn or stated, mm */
  developedLengthMm?: number;
  /** the polyline the bar is drawn as, in mm — summed when no developed length is stated */
  vertices?: { x: number; y: number }[];
  closed?: boolean;
  /** where it was read ("SECTION A-A, polyline 2F3A") */
  source: string;
  handles?: string[];
}

/** One term of an independent cutting-length derivation, so a reader can see every part. */
export interface SecondOpinionTerm {
  term: string;
  mm: number;
  note?: string;
}

/**
 * An INDEPENDENT cutting length beside the primary: straight arms + arcs +
 * hooks + development + lap, with bend allowance and deduction shown as their
 * own terms, in exact-arc geometry. Compared against the primary; a
 * difference past tolerance is a validation failure, never a silent choice.
 */
export interface SecondOpinion {
  lengthMm: number;
  terms: SecondOpinionTerm[];
  working: string;
  primaryMm: number;
  diffMm: number;
  toleranceMm: number;
  withinTolerance: boolean;
}

export interface BbsInterpretation {
  members: BbsMember[];
  bars: BbsBar[];
  /** what the model made of the sheet as a whole */
  summary?: string;
  /** anything it could not resolve — surfaced, never dropped */
  unresolved: string[];
}

// ------------------------------------------------------------
// 3. what it weighs — computed, never asserted
// ------------------------------------------------------------

export interface BbsSettings {
  concreteGrade: string;
  steelGrade: string;
  coverMm: number;
  /**
   * Where `coverMm` came from: the sheet, a person, or nobody at all.
   *
   * Cover is in every arm of every link and both ends of every straight bar,
   * so a schedule computed on a cover nobody supplied is a schedule of
   * plausible numbers resting on a figure that was never a reading. Absent
   * means "not established either way" and the engine behaves as it always
   * has; `'default'` is the case that must not silently produce lengths.
   */
  coverSource?: 'default' | 'sheet' | 'stated';
  bendMode: BendMode;
  wastagePct: number;
  /**
   * A project convention, when one is known — offices routinely apply a flat
   * multiple (49φ is common for Fe500/M25) rather than re-deriving per bar.
   * When set, it is used and the IS derivation is shown beside it as the
   * second opinion. When absent, IS 456 governs.
   */
  ldMultiple?: number;
  /**
   * The bottom leg of a starter bar, turned into the footing — NOT the
   * development length. A reference schedule for this project sets it as
   * `Ld − lap`, and no drawing states it.
   *
   * RECORDED BUT NOT YET USED. The vertical-bar cutting length still comes
   * from the member axis alone, so setting this changes no number today. It is
   * declared rather than smuggled through a cast so that the day the formula
   * lands, the answers a person already gave are waiting for it.
   */
  anchorageMm?: number;
  /**
   * How far a starter bar projects above, for the lap into the column it
   * supports. Same status as `anchorageMm`: stored, not yet consumed.
   */
  lapMm?: number;
}

export interface BbsRow {
  barMark: string;
  /** trade-readable name, e.g. "Long Bar T10 @ 150c/c (Btm)" — see describe.ts */
  description: string;
  memberMark: string;
  barType: BbsBar['barType'];
  diaMm: number;
  shapeCode: ShapeCode;
  /** mm — how it was arrived at is in `lengthSource` */
  cuttingLengthMm: number | null;
  /** how the cutting length was established — in the priority the engine applies them */
  lengthSource: 'ENTERED' | 'DRAWN_GEOMETRY' | 'CUSTOM_FORMULA' | 'SHAPE_FORMULA' | 'IS_DERIVED' | 'UNAVAILABLE';
  /** the lap INSIDE `cuttingLengthMm`, per bar — reported, never added a second time */
  lapMm?: number;
  /** the independent derivation and its comparison with the primary, when one could be made */
  secondOpinion?: SecondOpinion;
  /** engineering validation of this row — separate from whether it computed */
  engineering?: import('../../../calculations/validation').EngineeringValidation;
  /** the reading confidence of the callout this row was cut from, when one was recorded */
  confidence?: number;
  /**
   * Where the cover this row was cut to came from, in the schedule's own
   * vocabulary: read off the drawing, supplied by a person, or ASSUMED (the
   * project default — an assumption the row must say out loud).
   */
  coverStatus?: 'DRAWING_READ' | 'USER_INPUT' | 'ASSUMED';
  /**
   * Set by the anchorage gate: the member axis this bar was measured along is
   * DISPUTED — its value on record cannot be this bar's length. A question
   * about the dimension, never a verdict on the callout.
   */
  disputedAxis?: 'L' | 'W' | 'H';
  /**
   * The stage trace: which of INPUT_RESOLVED … VALIDATED the row reached, and
   * if it stopped, the FAILED_STAGE, MISSING_FACT, SOURCE, REASON and ACTION.
   */
  trace?: import('../../../calculations/schedule').RowStageTrace;
  /** the substituted arithmetic behind the length, shown never hidden */
  lengthWorking?: string;
  /**
   * The cutting length broken into its legs, as every commercial BBS prints
   * it in columns a, b, c… A checker verifies the SEGMENTS, not the total, so
   * a schedule that only carries the sum cannot actually be checked.
   * A negative entry is a bend deduction.
   */
  segments?: { label: string; mm: number }[];
  /**
   * Bars in ONE member — `null` when it could not be derived.
   *
   * NOT 0. A count nobody established is the same class of answer as a
   * placement nobody established, and `placement.ts` has never been allowed to
   * return 1 for that reason. A 0 was worse than the 1 it was guarding
   * against: it contributes no weight, it needs no explanation, it survives
   * every arithmetic gate (0 × anything reconciles), and it reads on screen as
   * a real answer that happens to be zero. `missing` says what it waits on.
   */
  barsPerMember: number | null;
  memberCount: number | null;
  /** `barsPerMember × memberCount`, or `null` when the count is unresolved */
  totalBars: number | null;
  /**
   * Bar spacing in mm — the C/C column of a commercial schedule, and the
   * input the count was derived from. Carried on the row because a checker
   * verifies the count by dividing the span by THIS; a schedule that shows
   * the count without the spacing cannot be checked.
   */
  spacingMm?: number;
  totalLengthM: number | null;
  unitWeightKgPerM: number | null;
  weightKg: number | null;
  weightWithWastageKg: number | null;
  /** raised, not silently corrected */
  warnings: string[];
  /**
   * Why this row is not complete, in the words the engine refused in — the
   * cutting length, the count, or both. Present exactly when something on the
   * row is null, so a reader never has to work out which figure is absent or
   * cross-reference `incomplete` by bar mark to find out what it waits on.
   */
  missing?: string;
  /**
   * The clear cover this row's arithmetic actually used, in mm, and where that
   * number came from. Both are on the ROW because the row is what a checker
   * reads: an arm of `350 − 2×c − φ` cannot be verified without knowing which
   * `c` went into it.
   *
   * `coverSource` is `'settings-default'` exactly when the member was not
   * described by the sheet's cover table and the flat project figure was used
   * instead — the fallback is recorded, never silent.
   */
  coverMm?: number;
  coverSource?: string;
  coverAssumption?: 'ASSUMED' | 'TO_BE_VERIFIED' | 'BLOCKED';
  handles: string[];
  fromCallout: string;
}

export interface BbsResult {
  settings: BbsSettings;
  members: BbsMember[];
  rows: BbsRow[];
  summary: import('../../domain/india/bbs').SummaryLine[];
  /** rows the engine could not complete, with the reason */
  incomplete: { barMark: string; reason: string }[];
  interpretation: BbsInterpretation;
  /**
   * Whole-schedule plausibility findings — kg per running metre against the
   * band a structure of this kind actually carries. Every INPUT had a gate
   * and a 100 m wall still totalled 0.731 MT with every row locally
   * defensible; this is the gate on the OUTPUT.
   */
  sanity?: string[];
  /** Build manifest — records fact dependencies for dependency-aware staleness. */
  manifest?: import('../../core/bbs/schemas').BBSBuildManifest;
  /** Σ rows against the diameter summary — computed before the result is returned. */
  reconciliation?: import('../../../calculations/schedule').Reconciliation;
  /** the engineering validation of the whole schedule — see calculations/validation.ts */
  validation?: import('../../../calculations/validation').ScheduleValidation;
  /** per-row differences between the stored rows and a fresh pass of the pipeline */
  rowDrift?: import('../../../calculations/schedule').RowDrift[];
  /**
   * EXACTLY WHAT THE PIPELINE WAS GIVEN, so a filed schedule can be rebuilt
   * without the drawing. The editable schedule completes a blocked row by
   * editing these inputs and running `scheduleRow` again — the same function
   * that produced the row in the first place. Without this the editor would
   * have to reconstruct bars from the printed columns, which is how a second
   * calculation engine starts.
   */
  engineInputs?: EngineInputs;
}

/** The inputs a build was run with — bars by bar mark, members by member mark. */
export interface EngineInputs {
  bars: Record<string, BbsBar>;
  members: Record<string, BbsMember>;
  settings: BbsSettings;
  runMm: number | null;
  coverTable: { member: string }[];
  /** the member count a project fact supplied, when the interpretation carried none */
  takeoffCounts: Record<string, number>;
  /** the cutting length a person typed for a bar, by bar mark */
  enteredCuttingLengthMm?: Record<string, number>;
  /** the sheet declares the cutting length a design input, by bar mark */
  declaredInputs?: Record<string, { where: string; saidAs: string }>;
}
