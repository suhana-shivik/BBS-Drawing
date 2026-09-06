// integration seam: StudioData is the ONLY door between the studio shell and
// the real engines. The shell never imports from src/cad/** or src/register/**;
// the integrator implements this interface over the real CAD session, register
// and BBS engine and injects it through <StudioDataContext.Provider>.
// The in-memory implementation in demoData.ts keeps `npm run dev` working
// before any of that lands.

import { createContext, useContext } from 'react';
import type { ScheduleRow } from './schedule';
import type { Ledger } from '../facts/ledger';
import type { FactSource } from '../facts/types';
import type { RevisionImpact } from '../facts/revision';
import type { SearchHit } from '../search/types';
// TYPES ONLY. §7.2 hands the chat a reference into the engine's own result
// store and the interface renders what it resolves to, so the shell has to be
// able to NAME that result — it still never calls the engine, which is what
// the rule above is for.
import type { BbsChatResult } from '../cad/bbs/chatResult';
import type { BbsProvenance } from '../io/bbsWorkbook';
import type {
  AnsweredQuestion,
  AnswerOutcome,
  CandidateFact,
  InterviewSession,
  PendingQuestion,
} from '../interview';

export type NodeState = 'ok' | 'warn' | 'idle' | 'busy';

export interface RegisterFileNode {
  kind: 'file';
  id: string;
  name: string;
  /** Revision chip for drawings (R0, R2 …). */
  rev?: string;
  /** Tag chip for outputs (v7, xlsx …). */
  tag?: string;
  current?: boolean;
  /** A revision a newer one replaced. It still opens; it is not the one to use. */
  superseded?: boolean;
  /**
   * Where this file sits in its drawing's version chain, and how long that
   * chain is. Both set only when there IS a chain — one drawing held in one
   * version says nothing, because "v1 of 1" is noise on every row in the
   * register.
   */
  version?: number;
  versionCount?: number;
  /** When this same file was last uploaded again (no new version was made). */
  reuploadedAt?: number;
  state: NodeState;
  /** Set when the file has been parsed into an openable sheet. */
  sheetId?: string;
  /** Set when the file is an output that opens in a dock tab. */
  dockTab?: 'ask' | 'bbs' | 'qty';
  /**
   * Set when the file IS a filed artifact — the versioned BBS or take-off in
   * Outputs. Opening it pins that version into the panel, so v1 stays readable
   * after v2 exists.
   */
  artifactId?: string;
  discipline?: string;
  /**
   * The drawing number this file belongs to, when the node is not itself an
   * openable sheet — a filed BBS carries the number of the drawing it was
   * built from, so the row states it even though the filename does not.
   */
  number?: string;
  /** File extension for un-parsed register entries (pdf, xlsx, csv …). */
  ext?: string;
  /**
   * Set when this row IS a register entry — the drawing itself, not a
   * section or a filed output. Rename and delete act on this id, never on
   * `id` alone: a section's `id` is a sheet id and an output's is an
   * artifact id, and writing either back to the register would rename or
   * delete the wrong thing (or, for an output, nothing at all).
   */
  entryId?: string;
  /**
   * THE FILING KEY — the stable identity a folder membership is stored under.
   *
   * `id` is the register ENTRY's id, and that id is local: it is minted by
   * `newId('drw')` on the machine that imported the drawing, while the same
   * drawing's row in Postgres carries a uuid the database assigned. Storing a
   * membership under `id` therefore filed the drawing into a folder on ONE
   * browser — clear IndexedDB, or open the project anywhere else, and the
   * member no longer resolved to anything and the folder came back empty.
   *
   * `documentId` is the parsed document's own id. It is what `drawings`,
   * `data_facts` and every filed schedule key off, it survives a re-import of
   * the same bytes, and it is the same string on every machine. Memberships
   * are written under it; `id` still resolves for anything filed before this
   * existed.
   */
  documentId?: string;
  /**
   * Set when this row IS a PDF register entry — a PDF page lives in its own
   * store (`realData.ts`'s `pdfStoreKey`), never the DXF register, so it
   * needs its own id to rename/delete against: writing it through `entryId`
   * would ask `updateDrawingEntry`/`removeDrawingEntry` to find a DXF entry
   * that was never there, and silently do nothing.
   */
  pdfId?: string;
  /** Short stat line shown in Files view (e.g. "84 entities" on a section). */
  meta?: string;
  /**
   * When this arrived, ms since epoch — a drawing's import, an output's
   * filing, a section package's build. Absent when the register genuinely
   * holds no time for it; the column then says "—" rather than guessing one.
   */
  at?: number;
}

export interface RegisterFolderNode {
  kind: 'folder';
  id: string;
  name: string;
  icon?: string;
  children: RegisterNode[];
  /** Stat line for the folder itself — a Sections/ folder carries its
   *  coverage here: "12 items · 97.5% covered" (§3.2). */
  meta?: string;
  /**
   * Made by a person, not derived from the register. Only these can be
   * renamed, deleted or filed into — a discipline folder is a consequence of
   * what its drawings ARE and cannot be edited.
   */
  userMade?: boolean;
  /** When this folder's contents were produced — a split package's build. */
  at?: number;
  /**
   * Set when this folder IS a multi-page PDF's Pages/ folder — the whole
   * imported file, not a subordinate of one (unlike a drawing's Sections/
   * folder, there is no separate row above it to delete or rename instead).
   * Carries the shared `importedAt` every page in it was filed under, which
   * `deletePdf`/`renamePdf` take as well as a single page id — deleting or
   * renaming the folder acts on every page in the same import in one call.
   */
  pdfBatchAt?: number;
}

export type RegisterNode = RegisterFileNode | RegisterFolderNode;

/** Top-level register grouping: Drawings (by discipline) · Outputs · Attention. */
export interface RegisterGroup {
  id: string;
  name: string;
  folders: RegisterFolderNode[];
}

export interface SheetModelMap {
  /** Sheet-unit → millimetre mapping for the coordinate readout. */
  widthUnits: number;
  heightUnits: number;
  mmPerUnit: number;
  x0Mm: number;
  y0Mm: number;
}

export interface StudioSheet {
  id: string;
  /** Tab label, e.g. "GAMCO-STR-001 R2 boundary wall". */
  tab: string;
  title: string;
  number: string;
  rev: string;
  discipline: string;
  entities: number;
  grounded: boolean;
  issues: number;
  hasModel: boolean;
  superseded?: boolean;
  panels: string[];
  model: SheetModelMap;
  // integration seam: the real CAD renderer replaces this with a callback that
  // paints the display list. The shell only injects whatever SVG it is given —
  // layer groups must carry data-layer="CONC|RBAR|GRND|DIMS|TEXT|SHEET" so the
  // Layers control switches real geometry off.
  svg: string;
  /** Original file name on disk, when the sheet came from a real import. */
  fileName?: string;
  /** Free deterministic extraction line: "3 tables · 36 callouts read · 41 marks". */
  extractLine?: string;
  /** Plain statement of what this sheet IS when it is not CAD geometry
   *  (e.g. a PDF page: raster underlay + text index, no entities). */
  sourceNote?: string;
  /** The parsed CadDocument behind this sheet, when it is a real CAD sheet. */
  documentId?: string;
  /**
   * How many read-section highlights this sheet SVG actually carries.
   *
   * A section whose bounds do not map to a drawable box is dropped when the
   * sheet is built, and a dropped highlight looks exactly like one that was
   * never asked for. The panel reads this so it can say which happened.
   */
  marksDrawn?: number;
  /** R3 — set when this sheet IS a section file; drives the section detail panel (§3.3). */
  section?: SectionDetailData;
}

// --- R3: sections as files --------------------------------------------------

export type SplitStatus = 'queued' | 'splitting' | 'split' | 'failed' | 'stale';

/** One residual (uncovered) layer of the drawing after the split (§3.4). */
export interface ResidualLayerData {
  layer: string;
  count: number;
  /** the splitter's own accounting names this layer — explained, not lost */
  explained: boolean;
  sampleText: string[];
}

/**
 * One unread part of a drawing: where it is, what is on it, and — the point —
 * whether it is joined to anything that WAS read.
 *
 * `touches` empty means the read never came near it: a whole element of the
 * drawing nobody looked at, not a section that got cut short. The evidence
 * fields are deliberately evidence and not a verdict; whether a gap matters is
 * the reader's call, and a layer-name heuristic would be wrong on the next
 * drawing (see the note atop `cad/understanding/gaps.ts`).
 */
export interface GapClusterData {
  id: string;
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number };
  entityCount: number;
  layers: { layer: string; count: number }[];
  /** section ids whose box reaches this cluster; empty = joined to nothing */
  touches: string[];
  nearest: { sectionId: string; distanceMm: number } | null;
  /** verbatim text the bar-callout grammar could read a bar out of */
  callouts: string[];
  sampleText: string[];
  /**
   * Is this unread part needed for the bar bending schedule?
   *
   * Only two answers, and the second is the honest one most of the time:
   *
   *  'required' — the bar-callout grammar READ A BAR out of text inside this
   *    cluster. That is a fact about the content ("T16@150 C/C" parses), not a
   *    guess from a layer's name, so it can be asserted.
   *  'unknown'  — everything else. Shown as "Unknown / Needs Review", never as
   *    "not required": `coverage.ts` is explicit that deciding which orphaned
   *    layer matters is a judgement this project does not encode as a naming
   *    heuristic, and silently answering "no" would be exactly that with the
   *    uncertainty hidden.
   */
  bbs: 'required' | 'unknown';
  /** Why — quoted evidence for 'required', the reason for 'unknown'. */
  bbsBasis: string;
  /**
   * SECOND PASS — what this unread piece turned out to be, once it was read.
   *
   * `undefined` means the second pass has not run for this drawing: a
   * different statement from a piece that WAS read and turned out to be
   * independent, and the panel says so differently.
   */
  second?: {
    /**
     * THE AUTHORITATIVE RELATIONSHIP — computed from entity geometry, never
     * from the reading. A model calling a residual "independent" while its
     * entities overlap a region is wrong about a fact it was not asked to
     * judge, and the panel must not repeat it.
     */
    link: 'CONNECTED' | 'NEAR_CONNECTED' | 'INDEPENDENT';
    /** every region the geometry actually reaches */
    connectedRegions: string[];
    linkedTo: string | null;
    status: 'read' | 'unread' | 'failed';
    /** the model's kind, when it read one */
    kind: string | null;
    summary: string | null;
    relation: string | null;
    /** why the piece is `unread` or `failed` */
    note: string | null;
    /**
     * WHAT WAS DONE about it — the part that decides the colour.
     *
     * A successful read is not by itself a resolution: `attach` folds the
     * piece into an existing region, `create-region` promotes it to one of its
     * own, `explained` means it was read and needs no region — a sliver of a
     * grid line — and only `unresolved` stays orange. Reading and resolving
     * are two different claims and the sidebar says both.
     */
    action: 'attach' | 'create-region' | 'explained' | 'unresolved';
    /** the region it ended up in, for `attach` and `create-region` */
    resolvedTo: string | null;
    /** unique entities in this residual */
    uniqueEntities: number;
    /** one line on why it went where it went */
    why: string | null;
  };
}

export interface SheetSectionsInfo {
  /** null: never queued (imported before split-on-import existed) */
  status: SplitStatus | null;
  /** human line beside the status dot: "split — 12 sections", "splitting…" */
  statusLine: string;
  /** honest spend, the way the BBS tab reports: "3 model calls · $0.0042 · 84s" */
  costLine: string | null;
  error: string | null;
  /** live tail while splitting */
  progressTail: string[];
  count: number | null;
  /** "97.5% of 1,335 entities" */
  coverageLine: string | null;
  residual: ResidualLayerData[];
  /** an unexplained residual = warning state on the drawing (§3.4) */
  unexplainedGap: boolean;
  /**
   * The parts of the drawing that are in NO section, as places rather than as
   * a percentage — clustered, with what each one is joined to.
   *
   * Computed from the stored package and the parsed drawing by pure geometry
   * (`findGapClusters`), so it needs no model, no key and no second read: once
   * a drawing has been split its gaps can be drawn and judged offline.
   */
  gaps: GapClusterData[];
  /**
   * Every section the read filed. `bounds` is the millimetre box it was cut
   * from — the Viewport outlines them on the sheet so the read is VISIBLE:
   * a coverage percentage says 97.5% but not WHICH 2.5% went unread.
   */
  sections: {
    sheetId: string;
    sectionId: string;
    label: string;
    kind: string;
    entityCount: number;
    bounds: { xMin: number; yMin: number; xMax: number; yMax: number };
    /**
     * How many entities inside this section's box the renderer will DRAW, and
     * how many it will skip.
     *
     * `buildDisplayList` drops entities on frozen or invisible layers;
     * `entityBoundsMm`, which the splitter boxes sections with, does not. So a
     * section can sit over a part of the sheet that draws nothing at all, and
     * its highlight then floats over black. These two counts are the only way
     * to tell that apart from a mapping bug, which is otherwise the same
     * picture — a box over nothing.
     */
    renderable: number;
    hidden: number;
    /**
     * GAP ids the second pass folded into this section.
     *
     * Empty for a section the first pass got whole. When it is not empty the
     * section's highlight covers more than the splitter originally cut, and
     * the sidebar says which pieces were added rather than leaving the reader
     * to wonder why a box grew.
     */
    attached?: string[];
    /** `initial`, `residual-second-pass`, or both */
    source?: string;
    /**
     * What the validation made of this section, when it has run.
     *
     * `undefined` means unchecked — a different statement from PASS, and the
     * row says so differently.
     */
    verdict?: {
      status: 'PASS' | 'WARNING' | 'FAIL';
      confidence: number;
      /** the first few reasons, for the row's tooltip */
      reasons: string[];
    };
  }[];
}

/** Everything §3.3 lists — read straight off DrawingSection, no new extraction. */
export interface SectionDetailData {
  sectionId: string;
  /** the orchestrator's own words, verbatim */
  label: string;
  /** a hint, never an assignment */
  kind: string;
  memberHints: { mark: string; basis: string }[];
  calloutHints: string[];
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number };
  widthMm: number;
  heightMm: number;
  entityCount: number;
  evidenceIds: string[];
  confidence: number;
  limitations: { code: string; message: string; count: number }[];
  orchestratorStep: number;
  /** open-sheet id of the parent drawing, when it is loaded */
  parentSheetId: string | null;
  parentName: string;
}

/** R3 — explicit split actions. Runs spend model calls; nothing here auto-fires. */
export interface StudioSplitSeam {
  /** null when a run can start; otherwise why not (missing key…). */
  blocked: string | null;
  /** split (or re-split) one drawing, by documentId */
  run: (documentId: string) => void;
  /** the explicit "Split all" — every drawing without a current package */
  runAll: () => void;
  /** how many drawings runAll would spend model calls on */
  pendingAll: number;
  /**
   * SECOND PASS — read the unread leftovers of an already-split drawing.
   *
   * A separate act from `run`, and a much cheaper one: it re-reads only the
   * pieces the first pass left behind and never re-cuts a section, so it can
   * be repeated when a key arrives late or a reading failed.
   */
  readResiduals: (documentId: string) => void;
  /**
   * STEP 8 — check every section against the drawing it was cut from.
   *
   * Cheaper than either read: the deterministic pass settles anything that
   * matches, and only the residue it could not decide is ever sent anywhere.
   * On a clean drawing that is no model calls at all, so this is safe to run
   * whenever the reader wants reassurance.
   */
  validate: (documentId: string, deep?: boolean) => void;
}

// --- live engine seams (implemented by realData.ts; absent in the demo) -----

/** State + trigger for one orchestrated BBS run over the active sheet. */
export interface StudioBbsSeam {
  /** null when a run can start; otherwise the sentence saying exactly why not
   *  (no sheet open, PDF sheet, missing VITE_OPENROUTER_API_KEY …). */
  blocked: string | null;
  running: boolean;
  /** live progress lines, oldest first — honest pass/cost reporting. */
  progress: string[];
  /** run summary once finished: turns, calls, cost, why it stopped. */
  stats: string | null;
  error: string | null;
  /** starts a run against the ACTIVE sheet. Never called on page load. */
  run: () => void;
  /** questions raised by this very run; all in one batch, never after filing */
  pendingQuestions?: PendingQuestion[];
  /** typed validation happens in InterviewSession; an invalid answer stays open */
  answerQuestion?: (questionId: string, raw: string) => AnswerOutcome;
  /** an explicit decline becomes a named gap, never a default */
  skipQuestion?: (questionId: string, said?: string) => AnswerOutcome;
  /**
   * §6.3 — fact ids that became answerable since the schedule was built. The
   * loop closes here: a run raises MISSING facts, a person answers them in the
   * Specification (or on the blocked row), and the tab notices. It NEVER
   * re-runs by itself: a rebuild spends model calls, so it is offered.
   */
  answersSince: string[];
  /** exact fact ids that are stale relative to the build manifest */
  staleFacts?: string[];
  /** BBS lifecycle state: STALE -> REBUILDING -> VALIDATED */
  lifecycleStatus?: 'STALE' | 'REBUILDING' | 'VALIDATED' | 'IDLE';
  /** build manifest of the currently held schedule */
  manifest?: import('../core/bbs/schemas').BBSBuildManifest | null;
  /** the project facts the last run was given — "briefed with 9 facts" */
  factsUsed: number;
  /** what the last run spent, so the price of a rebuild is stated before it is spent */
  lastCostLine: string | null;
  /** how many open questions the last run filed into the Specification */
  questionsFiled: number;
  /**
   * Download every interview log this project has recorded, as one Markdown
   * file — what the drawing already said, what was asked, what was answered,
   * and the engine's own reasoning, per question.
   *
   * Absent until something has been recorded: a button that downloads an
   * empty file is worse than no button.
   */
  downloadInterviewLog?: () => void;
  /** how many runs are on file, for the button's label */
  interviewLogCount?: number;
}

/** A file the user deliberately added to one chat turn. */
export interface StudioChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  /** Extracted readable content for text, CSV, DXF and modern Excel files. */
  text?: string;
  kind: 'image' | 'spreadsheet' | 'text' | 'file';
}

/** One-question chat about the active sheet (src/cad/ai/chat.ts). */
export interface StudioAskSeam {
  /** null when a question can be asked; otherwise why not. */
  blocked: string | null;
  running?: boolean;
  progress?: readonly string[];
  error?: string | null;
  stats?: string | null;
  ask: (
    question: string,
    attachments?: readonly StudioChatAttachment[],
    signal?: AbortSignal,
  ) => Promise<string>;
}

// --- §7: the chat IS the interview -----------------------------------------

export interface ChatRunOutcome {
  result: BbsChatResult;
  /**
   * Values a MODEL relayed as the user's, if the run reported any. They are
   * NOT applied on arrival: §7.1 checks every one back against the transcript
   * and discards what nobody said. Empty is the ordinary case.
   */
  relayed?: CandidateFact[];
}

export interface ChatRunRequest {
  /** the live interview for THIS run — the panel owns it and abandons it */
  session: InterviewSession;
  /** "give me the BBS for the tie beam" → the member the run is scoped to */
  memberMark?: string;
  /** answers already given in this thread, so a re-ask runs WITH them (§7.1) */
  priorAnswers?: readonly AnsweredQuestion[];
  /** Client-provided evidence travelling with this exact request. */
  attachments?: readonly StudioChatAttachment[];
}

/**
 * §7 — the Ask tab driving the same engine as the BBS tab's button, with a
 * person in the loop. One run, one session; the run resolves when the engine
 * finishes, and everything it asked on the way was asked in the thread.
 */
export interface StudioChatSeam {
  /** null when a run can start; otherwise the sentence saying why not. */
  blocked: string | null;
  /** true while a chat-driven run holds the engine */
  running: boolean;
  start: (request: ChatRunRequest) => Promise<ChatRunOutcome>;
  /**
   * §7.2 — the engine result → the rows `BbsSheet` renders. The chat resolves
   * an artifact REFERENCE and adapts what it resolved to; it never renders a
   * table the message carried, because a message never carries one.
   */
  adaptRows: (result: BbsChatResult) => ScheduleRow[];
  /**
   * Answers → SUPPLIED facts in the project ledger, through `recordAnswers`
   * and the ledger's own write path. Returns the line to quote per fact
   * (`appliedLine`), so every applied value is stated in the thread.
   */
  recordAnswers: (answers: readonly AnsweredQuestion[]) => Promise<string[]>;
  /**
   * File the run's interview log — what was ASKED, beside what was answered.
   *
   * Called whether the run published or failed: a failed run is the one worth
   * reading later, and its questions are exactly what a reader needs.
   */
  logInterview: (
    session: InterviewSession,
    outcome: { artifactId?: string; stoppedBecause?: string },
  ) => Promise<void>;
  /** the export header's provenance — drawing, revision, settings, conventions */
  provenance: () => BbsProvenance;
}

export interface StudioActions {
  /** File → Import drawing… — picker accepting .dxf/.dwg/.pdf. */
  importDrawing: () => void;
  /**
   * A filed output, taken away from the folder that lists it — the workbook
   * under exactly the filename the node carries (§6.2). Returns that filename,
   * or null when the artifact cannot be read back into a schedule.
   */
  downloadArtifact: (artifactId: string, format: 'xlsx' | 'csv') => string | null;
  /**
   * Delete a drawing — its register entry, its Sections/ folder and every
   * output filed under it (BBS, quantities, the "about this drawing" note).
   * Those all PROJECT from the drawing's own record (`buildGroups`), so this
   * is the one call that makes them disappear together rather than three
   * separate deletes that could fall out of step. The originally uploaded
   * file is kept — the register's record of it is what's removed.
   */
  deleteDrawing: (entryId: string) => void;
  /** Rename a drawing — the name the Files list, tabs and window title show. */
  renameDrawing: (entryId: string, name: string) => void;
  /** Delete one filed output on its own — an old BBS or quantity version. */
  deleteArtifact: (artifactId: string) => void;
  /** Delete a single-page PDF — its own register, separate from the DXF one. */
  deletePdf: (pdfId: string) => void;
  /** Rename a single-page PDF — the name the Files list and its tab show. */
  renamePdf: (pdfId: string, name: string) => void;
  /**
   * Delete every page of a multi-page PDF import at once — the Pages/ folder
   * IS the imported file (§ pdfBatchAt on RegisterFolderNode), so this is its
   * delete, the same way `deleteDrawing` is a drawing's.
   */
  deletePdfBatch: (importedAt: number) => void;
  /** Rename every page's shared file name at once — what the Pages/ folder itself is called. */
  renamePdfBatch: (importedAt: number, name: string) => void;
  /**
   * A folder a PERSON makes — "WH-4 package", "Issued to Sharma". It sits
   * beside the derived folders and holds whatever is filed into it.
   *
   * Filing is a SECOND membership, never a move (src/register/folders.ts): a
   * drawing put in "WH-4 package" is still in Structural and still
   * supersedable, because filing by hand must not remove it from the views
   * that keep it honest. Deleting the folder deletes the label, never the
   * drawings.
   */
  /** Returns the new folder's id, or null when the name was refused. */
  createFolder: (name: string) => string | null;
  renameFolder: (folderId: string, name: string) => void;
  deleteFolder: (folderId: string) => void;
  fileInFolder: (folderId: string, nodeId: string, member: boolean) => void;
  /**
   * MOVE, as distinct from FILE INTO.
   *
   * `fileInFolder` adds or removes ONE membership and leaves the others
   * alone — filing a drawing into "Priced" does not take it out of "WH-4
   * package". A move is the other statement: this drawing lives HERE now, so
   * it leaves every other folder a person made. `null` moves it out of all of
   * them, back to being filed by discipline alone.
   *
   * Neither one touches the drawing's discipline. That is a classification
   * read off the sheet, not a consequence of where somebody filed it.
   */
  moveToFolder: (nodeId: string, folderId: string | null) => void;
}

// --- R4/R4a: the project fact ledger, rendered as the Specification ---------

/** Which segment of a provenance chain was clicked (§4.4). */
export type SourceLevel = 'drawing' | 'section' | 'handles';

export interface StudioFactsSeam {
  /** false until the per-project ledger has been read from storage */
  loaded: boolean;
  /** the live ledger value — empty until loaded */
  ledger: Ledger;
  /**
   * Answer a MISSING (or contradicted) fact: records SUPPLIED with `saidAs`
   * kept verbatim, persists the ledger. Numeric-looking strings become numbers.
   */
  answer: (id: string, value: string, saidAs?: string) => Promise<void>;
  /** Override any fact — recorded SUPPLIED; the old value stays in history (§4.5). */
  override: (id: string, value: string) => Promise<void>;
  /** Withdraw a SUPPLIED answer — back to MISSING; DERIVED dependents marked stale. */
  withdraw: (id: string) => Promise<void>;
  /** R4a — resolve one segment of a provenance chain to its location. */
  open: (source: FactSource, level: SourceLevel) => void;
  /** Export the specification as CSV with provenance columns (§4.6). */
  exportCsv: () => void;
  /** latest hash-matched semantic reading for the active drawing */
  aboutDrawing?: {
    drawingName: string;
    updatedAt: number;
    note: string;
    conclusionCount: number;
    sectionNotes: {
      sectionId: string;
      label: string;
      kind: string;
      /** the flat rendering — what goes to the model, and is CAPPED for tokens */
      note: string;
      /**
       * The structured reading, UNCAPPED.
       *
       * The panel renders this rather than `note`: a person opening About
       * Drawing wants the whole sheet, and "… and 57 more" is the one thing a
       * record must never say to the person checking it. The cap belongs on
       * the prompt, where tokens are paid for — not on the page.
       */
      detail?: {
        text: string[];
        dimensions: {
          handle: string;
          measurementMm: number | null;
          textOverride?: string;
        }[];
        callouts: {
          raw: string;
          diaMm?: number;
          spacingMm?: number;
          count?: number;
          legs?: number;
          secondDiaMm?: number;
          zone?: string;
        }[];
        byType: { type: string; count: number }[];
        byLayer: { layer: string; count: number }[];
        entityCount: number;
      };
    }[];
  } | null;
}

// --- R5: revision impact -----------------------------------------------------

export interface RevisionImpactRecord {
  id: string;
  createdAt: number;
  impact: RevisionImpact;
}

export interface StudioRevisionSeam {
  /** newest filed impact report, or null when no revision has landed */
  latest: RevisionImpactRecord | null;
  /** true right after an import completed a revision — the report shows once (§5.4) */
  showReport: boolean;
  dismissReport: () => void;
}

// --- R6: one search, four kinds of hit ---------------------------------------

export interface StudioSearchSeam {
  query: (q: string) => SearchHit[];
  /** §6.4 — a result is a location: selecting it navigates and highlights. */
  goTo: (hit: SearchHit) => void;
}

export interface StudioData {
  projectName: string;
  groups: RegisterGroup[];
  sheets: Record<string, StudioSheet>;
  // integration seam: the real BbsRow[] from the engine is adapted to
  // ScheduleRow[] here (see schedule.ts for the field mapping).
  scheduleRows: ScheduleRow[];
  scheduleVersion: string;
  /**
   * §6.2 — the engine result the visible rows were adapted from. The export
   * writes from THIS, with the columns the table is showing, so the file and
   * the screen are the same document. Undefined until a schedule exists.
   */
  scheduleResult?: BbsChatResult;
  /** Which drawing, which revision, under which cover — the export's header. */
  scheduleProvenance?: BbsProvenance;
  /** The artifact version behind `scheduleResult`, for the filename. */
  scheduleVersionNo?: number;
  /** Live actions — undefined in the demo, where the shell falls back to toasts. */
  actions?: StudioActions;
  bbs?: StudioBbsSeam;
  ask?: StudioAskSeam;
  /** §7 — the live interview in the Ask tab; undefined in the demo. */
  chat?: StudioChatSeam;
  /** R3 — split-on-import job control; undefined in the demo. */
  split?: StudioSplitSeam;
  /**
   * R3 — split/sections state per documentId, kept OFF StudioSheet so live
   * progress lines never change the sheet object identity (the Viewport
   * re-injects the multi-MB SVG whenever the sheet object changes).
   */
  sectionsByDoc?: Record<string, SheetSectionsInfo>;
  /** R4 — the project fact ledger + its actions; undefined in the demo. */
  facts?: StudioFactsSeam;
  /** R5 — revision impact reports; undefined in the demo. */
  revision?: StudioRevisionSeam;
  /** R6 — the project search index; undefined in the demo. */
  search?: StudioSearchSeam;
}

export const StudioDataContext = createContext<StudioData | null>(null);

export function useStudioData(): StudioData {
  const data = useContext(StudioDataContext);
  if (!data) throw new Error('useStudioData must be used inside <StudioDataContext.Provider>');
  return data;
}

// --- register helpers (pure tree walks over the injected data) -------------

export function allFolders(data: StudioData): RegisterFolderNode[] {
  const out: RegisterFolderNode[] = [];
  const walk = (nodes: RegisterNode[]) => {
    nodes.forEach((n) => {
      if (n.kind === 'folder') {
        out.push(n);
        walk(n.children);
      }
    });
  };
  data.groups.forEach((g) => {
    out.push(...g.folders);
    g.folders.forEach((f) => walk(f.children));
  });
  return out;
}

export function findFolder(data: StudioData, id: string): RegisterFolderNode | null {
  return allFolders(data).find((f) => f.id === id) ?? null;
}

/** The folder-id chain from a group root down to (and including) `folderId`. */
export function folderPath(data: StudioData, folderId: string): string[] {
  for (const g of data.groups) {
    const walk = (folders: RegisterFolderNode[], trail: string[]): string[] | null => {
      for (const f of folders) {
        const here = [...trail, f.id];
        if (f.id === folderId) return here;
        const sub = f.children.filter((c): c is RegisterFolderNode => c.kind === 'folder');
        const found = walk(sub, here);
        if (found) return found;
      }
      return null;
    };
    const found = walk(g.folders, []);
    if (found) return found;
  }
  return [];
}

/** The folder path holding a file node, for locate/reveal. */
export function pathToFile(data: StudioData, fileId: string): { path: string[]; file: RegisterFileNode } | null {
  for (const folder of allFolders(data)) {
    const file = folder.children.find((c) => c.kind === 'file' && c.id === fileId) as
      | RegisterFileNode
      | undefined;
    if (file) return { path: folderPath(data, folder.id), file };
  }
  return null;
}

export function fileForSheet(data: StudioData, sheetId: string): RegisterFileNode | null {
  for (const folder of allFolders(data)) {
    const file = folder.children.find((c) => c.kind === 'file' && c.sheetId === sheetId);
    if (file) return file as RegisterFileNode;
  }
  return null;
}

/**
 * The drawing number the open sheet speaks for — what "this drawing" means to
 * every panel scoped to the sheet on screen.
 *
 * A SECTION resolves to its parent: a section is a cut of one drawing, not a
 * drawing of its own, and its facts were read off the parent. Returns `null`
 * with no sheet open, which every caller reads as "the whole project".
 */
export function activeDrawingNumber(data: StudioData, activeSheetId: string | null): string | null {
  const sheet = activeSheetId ? data.sheets[activeSheetId] : null;
  if (!sheet) return null;
  const parent = sheet.section?.parentSheetId ? data.sheets[sheet.section.parentSheetId] : null;
  return (parent?.number || sheet.number) ?? null;
}

export function countDrawings(data: StudioData): number {
  const seen = new Set<string>();
  allFolders(data).forEach((f) =>
    f.children.forEach((c) => {
      if (c.kind === 'file' && c.rev) seen.add(`${c.name} ${c.rev}`);
    }),
  );
  return seen.size;
}
