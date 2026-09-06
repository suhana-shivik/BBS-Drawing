// ============================================================
// The chat artifact — an immutable rendering of an engine result.
//
// THE MODEL NEVER WRITES THE TABLE.
//
// A schedule reproduced in Markdown by a language model is a schedule that has
// been retyped, and a retyped number is a number that can differ from the one
// the engine computed. It looks identical to a correct answer and there is no
// way to tell from the message which it is.
//
// So the assistant's message carries a REFERENCE — `artifact: {type, resultId}`
// — and the UI renders the stored object. What the yard cuts to and what the
// user reads are then the same bytes, by construction rather than by care.
//
// EVERY ROW SHOWS ITS WORKING. A figure a QS cannot check is a figure they must
// either trust blindly or recompute by hand, and both are how errors survive
// to site. `working` is the derivation in words; `evidenceIds` is what it was
// read from, so a click can find it on the drawing.
// ============================================================
import type { BbsResult, BbsRow as EngineRow, BbsSettings } from './types';
import type { UnverifiedExtent } from './placement';
import type { VerificationFailure } from './verify';
import type { Gate } from './verify';

export type RowStatus = 'verified' | 'inferred' | 'unavailable';

export interface BbsChatRow {
  id: string;
  barMark: string;
  memberMark: string;
  description: string;
  diameterMm: number;
  spacingMm?: number;
  memberCount?: number;
  barsPerMember?: number;
  totalBars?: number;
  cuttingLengthMm?: number;
  totalLengthM?: number;
  /**
   * Null on a row that could not be cut.
   *
   * It used to be coerced — `Number(r.unitWeightKgPerM ?? 0)` — so a blocked
   * row printed "0.000 kg/m" beside an empty weight, in a schedule whose own
   * conventions block says a blocked cell is EMPTY, never zero. A unit weight
   * is a property of a diameter and is never actually zero, so 0.000 is not a
   * small inaccuracy: it is the one value the column cannot legitimately hold,
   * announcing itself as a figure.
   */
  unitWeightKgPerM: number | null;
  totalWeightKg?: number;
  /**
   * The clear cover this row's arms were actually cut to, and where that
   * number came from. `'settings-default'` means the sheet's cover table did
   * not describe this member and the flat project figure was used — visible on
   * the row, because a defaulted cover that reads like a stated one is how a
   * schedule comes out short with nothing looking wrong.
   */
  coverMm?: number;
  coverSource?: string;
  coverAssumption?: 'ASSUMED' | 'TO_BE_VERIFIED' | 'BLOCKED';
  /** DRAWING_READ / USER_INPUT / ASSUMED — the cover's status, in the schedule's words */
  coverStatus?: 'DRAWING_READ' | 'USER_INPUT' | 'ASSUMED';
  /** the member axis the anchorage gate disputes, when it disputes one */
  disputedAxis?: 'L' | 'W' | 'H';
  /** the stage trace — which stages the row reached, and what stopped it */
  trace?: import('../../../calculations/schedule').RowStageTrace;
  /** the derivation, line by line — what a checker reads instead of retyping */
  working: string[];
  evidenceIds: string[];
  status: RowStatus;
  /** why it is not `verified`, when it is not */
  note?: string;
  /** §31 — the columns a final BBS prints, carried so every consumer reads the same row */
  shapeCode?: string;
  segments?: { label: string; mm: number }[];
  lengthSource?: string;
  lapMm?: number;
  weightWithWastageKg?: number;
  memberType?: string;
  /** the bar's role in the member — TOP, BOTTOM, MAIN, STIRRUP… */
  location?: string;
  sourceHandles?: string[];
  factIds?: string[];
  confidence?: number;
  engineering?: import('../../../calculations/validation').EngineeringValidation;
  secondOpinion?: import('./types').SecondOpinion;
}

export interface BbsMemberResult {
  mark: string;
  type: string;
  count?: number;
  continuous?: boolean;
  dims: { L?: number; W?: number; H?: number };
  coverMm?: number;
  coverSource?: string;
  /** how the count was arrived at */
  placementWorking?: string;
  rowIds: string[];
  weightKg: number;
}

export interface DiameterSummary {
  diaMm: number;
  barCount: number;
  totalLengthM: number;
  unitWeightKgPerM: number;
  totalWeightKg: number;
  totalWeightWithWastageKg: number;
  /** the share of totalWeightKg that is lap — inside the total, never added again */
  lapWeightKg: number;
  totalWeightMt: number;
  nonStandardDiameter: boolean;
}

export interface BbsAssumption {
  what: string;
  why: string;
  /** what it would take to make this exact instead */
  toResolve?: string;
}

export interface BbsWarning {
  message: string;
  memberMark?: string;
}

/**
 * A member whose count came from reading the drawn layout as the whole job,
 * with no run fact to check that reading against.
 *
 * It rides the result as its own field — not only as prose in `warnings` — so
 * that "this schedule covers 24,948 mm of drawn structure" is a value a caller
 * can render, test and refuse to print a total beside, rather than a sentence
 * that has to be parsed back out of a list.
 */
export interface ExtentClaim extends UnverifiedExtent {
  memberMark: string;
}

export interface BbsGapItem {
  memberMark?: string;
  field?: string;
  message: string;
  /** true when a person could answer it */
  askable: boolean;
}

export interface VerificationSummary {
  passed: Gate[];
  failures: VerificationFailure[];
  /** true only when every gate is silent */
  ok: boolean;
}

export interface BbsChatResult {
  id: string;
  status: 'complete' | 'partial' | 'blocked';
  project: {
    drawingName: string;
    runMm?: number;
  };
  members: BbsMemberResult[];
  rows: BbsChatRow[];
  diameterSummary: DiameterSummary[];
  netWeightKg?: number;
  procurementWeightKg?: number;
  assumptions: BbsAssumption[];
  warnings: BbsWarning[];
  gaps: BbsGapItem[];
  /**
   * Members counted off a drawn band with no run fact anywhere. Empty is the
   * good case. Non-empty means EVERY figure below is scoped to what is drawn,
   * and the status can never be `complete`.
   */
  extentClaims: ExtentClaim[];
  /** the drawn extent this schedule covers, mm — set only when it is not the job */
  coversDrawnExtentMm?: number;
  verification: VerificationSummary;
  /** when it was built — supplied by the caller, never read from a clock here */
  builtAt?: number;
  manifest?: import('../../core/bbs/schemas').BBSBuildManifest;
  /**
   * The settings the arithmetic actually spent — grade, cover, wastage, lap
   * multiple — and where each came from (default / sheet / stated). The
   * export header prints THESE, never a defaults table.
   */
  settings?: BbsSettings;
  settingSources?: Partial<Record<keyof BbsSettings, 'default' | 'sheet' | 'stated'>>;
  /** Σ rows against the diameter summary, as the engine reconciled them */
  reconciliation?: import('../../../calculations/schedule').Reconciliation;
  /**
   * The DataFacts the rows read (every id in a row's `trace.factsUsed`), as
   * they stood on the project record when this schedule became current —
   * value, unit, source type, version, source text and entity handles. The
   * caller that holds the ledger attaches them; the trace sheet prints them.
   */
  inputFacts?: import('../../facts/dataFact').DataFactRecord[];
  /** engineering validation — calculated is not validated; FINAL is this saying so */
  validation?: import('../../../calculations/validation').ScheduleValidation;
  rowDrift?: import('../../../calculations/schedule').RowDrift[];
}

export interface BuildChatResultInput {
  id: string;
  drawingName: string;
  runMm?: number;
  result: BbsResult;
  verification: VerificationSummary;
  manifest?: import('../../core/bbs/schemas').BBSBuildManifest;
  /** placement working per member mark, for the count column */
  placementWorking?: ReadonlyMap<string, string>;
  /** cover per member mark, with where it came from */
  cover?: ReadonlyMap<string, { mm: number; source: string }>;
  assumptions?: readonly BbsAssumption[];
  gaps?: readonly BbsGapItem[];
  /** placements that read a drawn band as the whole job — see ExtentClaim */
  extentClaims?: readonly ExtentClaim[];
  builtAt?: number;
  settings?: BbsSettings;
  settingSources?: Partial<Record<keyof BbsSettings, 'default' | 'sheet' | 'stated'>>;
  reconciliation?: import('../../../calculations/schedule').Reconciliation;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Split an engine row's working into lines a person can follow.
 *
 * The engine writes one dense string ("A = W 350 − 2×50 − 8 = 242;  B = …").
 * Semicolons are its own separator, so this is presentation, not
 * re-derivation — no number is touched.
 */
function workingLines(row: EngineRow, placement?: string): string[] {
  const raw = (row as unknown as Record<string, unknown>).lengthWorking;
  const lines: string[] = [];
  if (typeof raw === 'string' && raw.trim()) {
    for (const part of raw.split(';')) {
      const t = part.trim();
      if (t) lines.push(t);
    }
  }
  const r = row as unknown as Record<string, unknown>;
  // `typeof === 'number'`, not `!== undefined`. The engine writes NULL for a
  // figure it could not compute — a blocked row carries `cuttingLengthMm: null`
  // — and `null !== undefined` is true, so an undefined-check lets a null
  // through and the next `.toFixed` throws. That crash killed a live run after
  // 45 successful requests and $0.19 of real traffic.
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  const barsPer = num(r.barsPerMember);
  const members = num(r.memberCount);
  const totalBars = num(r.totalBars);
  const cut = num(r.cuttingLengthMm);
  const lenM = num(r.totalLengthM);
  const unit = num(r.unitWeightKgPerM);
  const kg = num(r.weightKg);

  if (placement) lines.push(`members: ${placement}`);
  if (barsPer !== null && members !== null) {
    lines.push(`bars: ${barsPer} per member × ${members} = ${totalBars ?? '—'}`);
  }
  if (cut !== null && totalBars !== null) {
    lines.push(`length: ${cut} mm × ${totalBars} = ${(lenM ?? 0).toFixed(2)} m`);
  }
  if (lenM !== null && unit !== null) {
    lines.push(
      `weight: ${lenM.toFixed(2)} m × ${unit} kg/m = ${(kg ?? 0).toFixed(2)} kg  (IS 1786 nominal)`,
    );
  }
  return lines;
}

function statusOf(row: EngineRow): { status: RowStatus; note?: string } {
  const r = row as unknown as Record<string, unknown>;
  if (num(r.cuttingLengthMm) === undefined) {
    return { status: 'unavailable', note: String(r.missing ?? 'a required dimension is not resolved') };
  }
  // A ROW WITH A LENGTH AND NO COUNT IS AS BLOCKED AS ONE WITH NO LENGTH.
  //
  // It used to reach here `verified`, carrying barsPerMember 0 and a weight of
  // zero, because only the cutting length was tested. A cutting length is half
  // a row: length × count is the quantity, and a row missing either half has
  // no quantity. Reporting it as an answer that happens to weigh nothing is
  // the same silent failure as a count of 1 — the number is not there, and it
  // must say so rather than resolve to something harmless-looking.
  if (num(r.barsPerMember) === undefined || num(r.totalBars) === undefined) {
    return {
      status: 'unavailable',
      note: String(r.missing ?? 'the number of bars could not be derived'),
    };
  }
  const warnings = Array.isArray(r.warnings) ? (r.warnings as string[]) : [];
  if (r.lengthSource === 'PROJECT_CONVENTION' || warnings.length) {
    // The cover line leads when there is one: it is the assumption a reader
    // most needs to see, and the Status column prints exactly this note.
    const coverLine = warnings.find((w) => /^Cover\b/.test(w));
    return { status: 'inferred', note: coverLine ?? warnings[0] ?? 'derived from a project convention' };
  }
  return { status: 'verified' };
}

/**
 * Build the artifact. Pure: everything comes from the engine result, and no
 * figure is recomputed on the way through.
 */
export function buildChatResult(input: BuildChatResultInput): BbsChatResult {
  const { result } = input;
  const rows: BbsChatRow[] = [];
  const byMember = new Map<string, BbsChatRow[]>();

  for (const row of result.rows as EngineRow[]) {
    const r = row as unknown as Record<string, unknown>;
    const placement = input.placementWorking?.get(row.memberMark);
    const { status, note } = statusOf(row);
    const chatRow: BbsChatRow = {
      id: row.barMark,
      barMark: row.barMark,
      memberMark: row.memberMark,
      description: String(r.description ?? `${row.barType} T${row.diaMm}`),
      diameterMm: Number(row.diaMm),
      spacingMm: num(r.spacingMm),
      memberCount: num(r.memberCount),
      barsPerMember: num(r.barsPerMember),
      totalBars: num(r.totalBars),
      cuttingLengthMm: num(r.cuttingLengthMm),
      totalLengthM: num(r.totalLengthM),
      unitWeightKgPerM: num(r.unitWeightKgPerM) ?? null,
      totalWeightKg: num(r.weightKg),
      coverMm: num(r.coverMm),
      coverSource: typeof r.coverSource === 'string' ? r.coverSource : undefined,
      coverAssumption: row.coverAssumption ?? (r.coverAssumption as any),
      working: workingLines(row, placement),
      evidenceIds: Array.isArray(r.evidenceIds) ? (r.evidenceIds as string[]) : [],
      status,
      note,
      ...(row.coverStatus ? { coverStatus: row.coverStatus } : {}),
      ...(row.disputedAxis ? { disputedAxis: row.disputedAxis } : {}),
      ...(row.trace ? { trace: row.trace } : {}),
      shapeCode: row.shapeCode,
      ...(row.segments ? { segments: row.segments } : {}),
      lengthSource: row.lengthSource,
      ...(typeof row.lapMm === 'number' ? { lapMm: row.lapMm } : {}),
      ...(typeof row.weightWithWastageKg === 'number' ? { weightWithWastageKg: row.weightWithWastageKg } : {}),
      memberType: (result.members ?? []).find((m) => m.mark === row.memberMark)?.type,
      location: row.barType,
      sourceHandles: [...(row.handles ?? [])],
      factIds: [...(row.trace?.factsUsed ?? [])],
      ...(typeof row.confidence === 'number' ? { confidence: row.confidence } : {}),
      ...(row.engineering ? { engineering: row.engineering } : {}),
      ...(row.secondOpinion ? { secondOpinion: row.secondOpinion } : {}),
    };
    rows.push(chatRow);
    const list = byMember.get(row.memberMark) ?? [];
    list.push(chatRow);
    byMember.set(row.memberMark, list);
  }

  const members: BbsMemberResult[] = (result.members ?? []).map((m) => {
    const mine = byMember.get(m.mark) ?? [];
    const cover = input.cover?.get(m.mark);
    return {
      mark: m.mark,
      type: m.type,
      count: num((m as unknown as Record<string, unknown>).count),
      dims: {
        L: num(m.lengthMm),
        W: num(m.widthMm),
        H: num(m.heightMm),
      },
      // The engine stamps the cover it actually SPENT on every member it
      // built, fallback included; `input.cover` is the resolver's view of the
      // same thing. The engine's wins when both are present, so the panel can
      // never show a cover the arithmetic did not use.
      coverMm: m.coverMm ?? cover?.mm,
      coverSource: m.coverSource ?? cover?.source,
      placementWorking: input.placementWorking?.get(m.mark),
      rowIds: mine.map((r) => r.id),
      weightKg: mine.reduce((n, r) => n + (r.totalWeightKg ?? 0), 0),
    };
  });

  const diameterSummary: DiameterSummary[] = result.summary.map((s) => ({
    diaMm: s.diaMm,
    barCount: s.barCount,
    totalLengthM: s.totalLengthM,
    unitWeightKgPerM: s.unitWeightKgPerM,
    totalWeightKg: s.totalWeightKg,
    totalWeightWithWastageKg: s.totalWeightWithWastageKg,
    lapWeightKg: s.lapWeightKg,
    totalWeightMt: s.totalWeightMt,
    nonStandardDiameter: s.nonStandardDiameter,
  }));

  const netWeightKg = diameterSummary.reduce((n, s) => n + s.totalWeightKg, 0);
  const procurementWeightKg = diameterSummary.reduce((n, s) => n + s.totalWeightWithWastageKg, 0);

  const warnings: BbsWarning[] = (result.incomplete ?? []).map((i) => ({
    message: `${i.barMark}: ${i.reason}`,
    memberMark: rows.find((r) => r.barMark === i.barMark)?.memberMark,
  }));
  // The engine's own aggregate plausibility voice. It was written on every
  // build and read by nobody — the one check that ignores gate blocking, dead
  // in the artifact. It surfaces here as a warning, never as a verdict.
  for (const s of result.sanity ?? []) warnings.push({ message: s });

  const gaps = [...(input.gaps ?? [])];
  const assumptions = [...(input.assumptions ?? [])];

  // ---- the extent caveat, put where it cannot be missed ----
  //
  // A quantity is detail × extent. Everything else in this object is detail:
  // sections, spacings, shapes, weights, all of it checkable and all of it
  // silent on how much of the structure exists. When the counts came from
  // reading a drawn band as the whole job with no run fact, that reading is
  // the largest single number in the schedule and nobody supplied it.
  //
  // It goes in FIRST — ahead of every per-row warning — and again as an
  // assumption with what would settle it, because the two are read by
  // different people in different places and neither reads the other's list.
  const extentClaims = [...(input.extentClaims ?? [])];
  const extentWarnings: BbsWarning[] = [];
  let coversDrawnExtentMm: number | undefined;
  if (extentClaims.length) {
    coversDrawnExtentMm = Math.max(...extentClaims.map((c) => c.drawnExtentMm));
    const marks = extentClaims.map((c) => c.memberMark).join(', ');
    extentWarnings.push({
      message:
        `THIS SCHEDULE COVERS ONLY WHAT IS DRAWN — ${coversDrawnExtentMm} mm of structure. ` +
        `No total run was supplied, so ${marks} ${extentClaims.length === 1 ? 'was' : 'were'} ` +
        'counted by taking the drawn layout to BE the whole job. A repeating band on a ' +
        'typical-detail sheet is a module of a longer structure at least as often as it is the ' +
        'whole of a short one, and the drawing cannot tell the two apart. Every count, length ' +
        `and weight below is scoped to those ${coversDrawnExtentMm} mm. ` +
        `${extentClaims[0].ask}`,
    });
    assumptions.push({
      what:
        `The drawn layout is the entire structure — ${coversDrawnExtentMm} mm, ` +
        `${extentClaims[0].nodes} tags at about ${extentClaims[0].pitchMm} mm centres.`,
      why:
        'No run fact was supplied and none is on this sheet, so the tags on the layout were ' +
        'the only extent available. This was assumed, not read.',
      toResolve: extentClaims[0].ask,
    });
  }
  const blocked = rows.filter((r) => r.status === 'unavailable');

  // Status is derived, never asserted. "Complete" means every gate passed AND
  // no row is unavailable — a schedule with a blocked row is partial however
  // confident anything feels about it.
  //
  // An unverified extent can never be complete either, even when every gate
  // the caller ran happened to be silent about it. A schedule for an unknown
  // fraction of a structure is not a finished schedule for the structure.
  const status: BbsChatResult['status'] =
    !input.verification.ok && blocked.length === rows.length && rows.length > 0
      ? 'blocked'
      : input.verification.ok && blocked.length === 0 && !extentClaims.length
        ? 'complete'
        : 'partial';

  return {
    id: input.id,
    status,
    project: { drawingName: input.drawingName, runMm: input.runMm },
    members,
    rows,
    diameterSummary,
    netWeightKg,
    procurementWeightKg,
    assumptions,
    warnings: [...extentWarnings, ...warnings],
    gaps,
    extentClaims,
    coversDrawnExtentMm,
    verification: input.verification,
    builtAt: input.builtAt,
    manifest: input.manifest ?? result.manifest,
    settings: input.settings ?? result.settings,
    ...(input.settingSources ? { settingSources: input.settingSources } : {}),
    ...(input.reconciliation ?? result.reconciliation
      ? { reconciliation: input.reconciliation ?? result.reconciliation }
      : {}),
    ...(result.validation ? { validation: result.validation } : {}),
    ...(result.rowDrift ? { rowDrift: result.rowDrift } : {}),
  };
}

// ------------------------------------------------------------
// the store the chat message points into
// ------------------------------------------------------------

const store = new Map<string, BbsChatResult>();

export function putChatResult(result: BbsChatResult): void {
  store.set(result.id, result);
  // a session does not need more than a handful; the newest are what a
  // conversation refers to
  if (store.size > 24) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
}

export function getChatResult(id: string): BbsChatResult | undefined {
  return store.get(id);
}

/** the message body that accompanies an artifact — deliberately says no numbers */
export function artifactMessage(result: BbsChatResult): {
  content: string;
  artifact: { type: 'bbs-result'; resultId: string };
} {
  // The extent caveat outranks the row-level one. A reader who is told "ready,
  // with gaps against the rows they block" goes and looks at the rows; the
  // thing that is missing here is not in any row.
  const content = result.extentClaims?.length
    ? 'The bar bending schedule covers only the stretch that is drawn — no total run was ' +
      'supplied, so nothing establishes that the drawn layout is the whole job. The warning at ' +
      'the top of the schedule names the extent it does cover, and the question that settles it.'
    : result.status === 'complete'
      ? 'The bar bending schedule is complete.'
      : result.status === 'partial'
        ? 'The bar bending schedule is ready, with gaps listed against the rows they block.'
        : 'The schedule could not be computed — every row is blocked on something unresolved.';
  return { content, artifact: { type: 'bbs-result', resultId: result.id } };
}
