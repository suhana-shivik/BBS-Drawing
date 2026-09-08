// The live StudioData implementation — the only place the studio shell's data
// seam meets the real engines. It composes:
//
//   src/cad/session.ts + store.ts      the open CAD sheets and their persistence
//   src/register/register.ts           drawing identity, revisions, health
//   src/register/artifacts.ts          issued outputs (BBS results, versioned)
//   src/cad/import.ts + dwg.ts + pdf/  the three import pipelines
//   src/cad/bbs/orchestrate.ts         the orchestrated BBS engine
//   src/cad/ai/                        the OpenRouter transport + chat
//
// The shell itself imports none of those modules — it reads the StudioData
// this hook builds (see src/studio/data.ts). demoData.ts remains reachable
// behind `?demo` for a data-free look at the shell.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { groupRegions } from '../cad/bbs/logicalSections';
import type { BbsRow } from '../cad/bbs/types';
import { reconcileRows } from '../../calculations/schedule';
import { importCadDrawing, restoreCadDrawing } from '../cad/import';
import {
  activeCadSheet,
  cadSheets,
  clearCadSession,
  closeCadSheet,
  useCadSession,
  type CadSheet,
} from '../cad/session';
import { DwgError, readCadDrawing } from '../cad/dwg';
import { importPdf } from '../cad/pdf/import';
import { identityFromPdfTexts } from '../cad/pdf/identity';
import type { PdfSheet } from '../cad/pdf/types';
import { buildDisplayList } from '../cad/displayList';
import { extractDrawing } from '../cad/bbs/extract';
import { buildEvidenceGraph, type EvidenceGraph } from '../cad/bbs/evidence';
import { runOrchestrator, type OrchestrateOptions } from '../cad/bbs/orchestrate';
import { DEFAULT_SETTINGS, resolveSettings } from '../cad/bbs/build';
import { factSheetLines } from '../cad/bbs/factSheet';
import {
  askForDesignInput,
  designInputsFrom,
  factIdForDesignInput,
} from '../cad/bbs/designInputs';
import type { BbsChatResult, BbsChatRow } from '../cad/bbs/chatResult';
import {
  appliedLine,
  askUserOf,
  InterviewSession,
  projectFactsFromAnswers,
  recordAnswers,
  appendInterviewLog,
  buildAuditLog,
  auditMarkdown,
  interviewLogsMarkdown,
  loadInterviewLogs,
  type StoredInterviewLog,
  type AnsweredQuestion,
  type AskUser,
} from '../interview';
import { bbsFileName, type BbsProvenance } from '../io/bbsWorkbook';
import { rasterise } from '../cad/ai/crops';
import { getAiConfig, isAiConfigured } from '../cad/ai/config';
import { contentOf, messageFromErrorBody, parseModelJson } from '../cad/ai/openrouter';
import { askDrawing } from '../cad/ai/chat';
import type { CadDocument } from '../cad/types';
import type { DrawingExtract } from '../cad/bbs/types';
import { registerDrawing, removeDrawingEntry, updateDrawingEntry, useDrawingRegister } from '../register/register';
import { inferDiscipline } from '../register/titleBlock';
import {
  createFolder as createFolderRecord,
  deleteFolder as deleteFolderRecord,
  moveMembership,
  renameFolder as renameFolderRecord,
  setMembership as setFolderMembership,
  useProjectFolders,
  type UserFolder,
} from '../register/folders';
import {
  answerPlacement,
  disputeFact,
  emptyLedger,
  overrideFact,
  recordFact,
  resolveFact,
  withdrawFact,
  type Ledger,
} from '../facts/ledger';
import { numbersOnly } from '../cad/bbs/askFrom';
import { applyRevisionFacts } from '../facts/revision';
import { loadLedgerIdb, saveLedgerIdb } from '../facts/store';
import { isUsable, type Fact, type FactSource, type FactValue } from '../facts/types';
import { buildProjectIndex, type ProjectIndex } from '../search/index';
import { search } from '../search/query';
import type { SearchHit } from '../search/types';
import {
  removeProjectArtifact,
  removeProjectArtifactsForDocument,
  saveProjectArtifact,
  useProjectArtifacts,
  type ProjectArtifact, updateProjectArtifact } from '../register/artifacts';
import * as repo from '../cad/store';
import { newId } from '../register/id';
import type { DrawingRegisterEntry } from '../register/types';
import type {
  ChatRunOutcome,
  ChatRunRequest,
  RegisterFileNode,
  RegisterFolderNode,
  RegisterNode,
  RegisterGroup,
  RevisionImpactRecord,
  SectionDetailData,
  GapClusterData,
  SheetSectionsInfo,
  SourceLevel,
  SplitStatus,
  StudioData,
  StudioChatAttachment,
  StudioSheet,
} from './data';
import { deriveColumns, type ScheduleRow } from './schedule';
import {
  downloadBytes,
  downloadScheduleCsv,
  downloadScheduleXlsx,
  exportColumns,
  workbookGroup,
} from './exportSchedule';
import { runLogPath, writeLogFile } from './logSink';
import { parseCallout, parsedAnything } from '../cad/bbs/callout';
import { boundsIntersect, entityBoundsMm } from '../cad/understanding/bounds';
import { findGapClusters } from '../cad/understanding/gaps';
import { auditLabels, labelAuditReport } from '../cad/understanding/validate';
import {
  finalizationReport,
  finalizeSecondPass,
  type Finalization,
} from '../cad/understanding/finalize';
import { groupedSheetSvg, modelMapFor, pdfSheetSvg, type SheetHighlight } from './sheetSvg';
import { closeEditorModel, openEditorModel } from './editorHost';
import { maybeModel, subscribe as subscribeModel } from '../core/modelStore';
import type { ProjectData } from '../core/types';
import type { StudioStore } from './store';
import {
  deletePackage,
  drawingHash,
  loadPackages,
  restorePackage,
  stalenessOf,
  type DrawingSection,
  type DrawingUnderstandingPackage,
} from '../cad/understanding';
import {
  packageRelationships,
  packageSectionEvidence,
} from '../cad/understanding/consume';
import { drawingReadiness } from '../cad/understanding/readiness';
import {
  aboutDrawingBriefing,
  buildAboutDrawingMemory,
  parseAboutDrawingMemory,
} from '../cad/bbs/about';
import {
  coverageLineFor,
  hasUnexplainedGap,
  parseSectionSheetId,
  residualFor,
  sectionSubsetDoc,
  sectionsFolderFor,
  sectionSheetId,
} from './sections';
import {
  queueSplit,
  runSecondPass,
  runValidation,
  runSplit,
  splitCostLine,
  splitJobFor,
  useSplitJobs,
} from './splitJobs';
import type { StudioProject } from './projects';
import {
  answersSince,
  bbsObjective,
  blockedRowsOf,
  assumedSettings,
  axisDisputesFromRun,
  overridesFromLedger,
  missingFactsFromRun,
  projectFactsFromLedger,
  settingsFromLedger,
  usableFactIds,
  staleFacts,
  stampManifest,
  staleRowsOf,
} from './bbsFacts';
import { memberFactsFromTables } from '../cad/bbs/tableFacts';
import { dataFactsOf } from '../facts/dataFact';
import { isSupabaseConfigured } from '../lib/supabase';
import { saveRun, markStaleByFacts, currentRun } from '../data/bbs';
import { remoteDrawingIdFor, setDrawingStatus, syncDrawing, uploadDrawingFile } from '../data/drawings';
import { insertReading } from '../data/readings';
import {
  applyEdits,
  buildEditGrid,
  disputesOf,
  recalculate,
  reconstructEngineInputs,
  type BbsEditEvent,
  type DisputeAcknowledgement,
  type CellEdit,
  type EditableGrid,
  type EditRejection,
} from '../../calculations/bbsEdit';
import { buildChatResult } from '../cad/bbs/chatResult';
import type { BbsResult } from '../cad/bbs/types';

/** How the shell reports to the user; App passes the toast function in. */
export type Notify = (message: string, kind?: 'ok' | 'warn') => void;

// ------------------------------------------------------------
// per-document caches (module level: a parsed doc never changes)
// ------------------------------------------------------------

interface RenderedDoc {
  /** how many highlight rects the sheet SVG actually carries */
  marksDrawn: number;
  svg: string;
  model: StudioSheet['model'];
  extractLine: string;
}

const renderCache = new Map<string, RenderedDoc>();
const extractCache = new Map<string, DrawingExtract | null>();
const graphCache = new Map<string, EvidenceGraph | null>();

function extractFor(doc: CadDocument): DrawingExtract | null {
  if (!extractCache.has(doc.id)) {
    try {
      extractCache.set(doc.id, extractDrawing(doc));
    } catch {
      extractCache.set(doc.id, null);
    }
  }
  return extractCache.get(doc.id) ?? null;
}

function graphFor(doc: CadDocument): EvidenceGraph | null {
  if (!graphCache.has(doc.id)) {
    const extract = extractFor(doc);
    try {
      graphCache.set(doc.id, extract ? buildEvidenceGraph(doc, extract) : null);
    } catch {
      graphCache.set(doc.id, null);
    }
  }
  return graphCache.get(doc.id) ?? null;
}

/** The free deterministic line the Details tab shows — no model call spent. */
function extractLineFor(doc: CadDocument): string {
  const ex = extractFor(doc);
  if (!ex) return '';
  const callouts = ex.callouts.length;
  const marks = ex.marks.length;
  const tables = ex.tables.length;
  return `${tables} table${tables === 1 ? '' : 's'} · ${callouts} callout${callouts === 1 ? '' : 's'} read · ${marks} mark${marks === 1 ? '' : 's'}`;
}

function renderDoc(doc: CadDocument, highlights: readonly SheetHighlight[] = []): RenderedDoc {
  // The highlights are PART OF THE SHEET now, so they belong in its cache key:
  // a drawing read after it was first rendered has to re-emit its SVG, once.
  const key = `${doc.id}|${highlights.map((h) => h.id).join(',')}`;
  const hit = renderCache.get(key);
  if (hit) return hit;
  const list = buildDisplayList(doc, { regionId: null, hiddenLayers: new Set<string>(), paper: false });
  const sheet = groupedSheetSvg(list, {
    width: 2200,
    highlights,
    mmPerUnit: doc.unitScale || 1,
  });
  // `doc.unitScale`, NOT the extract's copy of it. They are the same number
  // (extract.ts:1365 assigns it straight across) right up until `extractFor`
  // swallows a throw and returns null — and then this silently became 1 while
  // every section box stayed in millimetres computed from `doc.unitScale`
  // (understanding/bounds.ts:427). On a drawing in metres that is a 1000×
  // disagreement between the sheet and the boxes drawn over it. The document's
  // own property is always there and cannot fall back.
  const unitScale = doc.unitScale || 1;
  const built: RenderedDoc = {
    marksDrawn: sheet.marksDrawn,
    svg: sheet.svg,
    model: modelMapFor(list, sheet, unitScale),
    extractLine: extractLineFor(doc),
  };
  renderCache.set(key, built);
  return built;
}

// ------------------------------------------------------------
// PDF register entries — raster underlay + text index, never entities
// ------------------------------------------------------------

export interface PdfRegisterEntry {
  id: string;
  fileName: string;
  pageIndex: number;
  pageCount: number;
  number: string;
  title: string;
  revision: string;
  importedAt: number;
  /**
   * Which discipline folder it belongs in — the same keys a DXF entry uses.
   * A PDF used to have none, and every page was filed under General no matter
   * what it was or where the person imported it. Absent on pages imported
   * before this existed; those still read as General.
   */
  discipline?: string;
  sheet: PdfSheet;
}

/**
 * PDF pages persist through the same generic artifacts store, under their own
 * PER-PROJECT key so they can never collide with the project's issued outputs
 * — or with another project's PDF pages (§1.4).
 */
const pdfStoreKey = (projectId: string) => `${projectId}#pdf-sheets`;

async function loadPdfEntries(projectId: string): Promise<PdfRegisterEntry[]> {
  try {
    return (await repo.getProjectArtifacts<PdfRegisterEntry>(pdfStoreKey(projectId))) ?? [];
  } catch {
    return [];
  }
}

async function persistPdfEntries(projectId: string, entries: PdfRegisterEntry[]): Promise<void> {
  try {
    await repo.putProjectArtifacts(pdfStoreKey(projectId), entries);
  } catch {
    /* storage unavailable — the session still works, re-import restores */
  }
}

// ------------------------------------------------------------
// R5 — revision impact reports, filed per project (§5.4)
// ------------------------------------------------------------

const impactsKey = (projectId: string) => `${projectId}#revision-impacts`;

async function loadImpacts(projectId: string): Promise<RevisionImpactRecord[]> {
  try {
    return (await repo.getProjectArtifacts<RevisionImpactRecord>(impactsKey(projectId))) ?? [];
  } catch {
    return [];
  }
}

async function persistImpacts(projectId: string, records: RevisionImpactRecord[]): Promise<void> {
  try {
    await repo.putProjectArtifacts(impactsKey(projectId), records);
  } catch {
    /* storage unavailable — the report lives for this session */
  }
}

// ------------------------------------------------------------
// What the last schedule was BUILT KNOWING (§6.3)
// ------------------------------------------------------------
//
// The rebuild offer has to survive a reload, because answering an open question
// is not something that happens in the same sitting as the run that raised it.
// So the set of facts the last schedule was computed from is filed against the
// project, exactly as the PDF pages and impact reports are.

export interface BbsRunMemo {
  /** fact ids that were usable when the schedule was built */
  factIds: string[];
  at: number;
  /** the honest price of that run, restated before a rebuild is spent */
  costLine: string | null;
  questionsFiled: number;
}

const runMemoKey = (projectId: string) => `${projectId}#bbs-run-memo`;

async function loadRunMemo(projectId: string): Promise<BbsRunMemo | null> {
  try {
    const rows = await repo.getProjectArtifacts<BbsRunMemo>(runMemoKey(projectId));
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

async function persistRunMemo(projectId: string, memo: BbsRunMemo): Promise<void> {
  try {
    await repo.putProjectArtifacts(runMemoKey(projectId), [memo]);
  } catch {
    /* storage unavailable — the offer lives for this session */
  }
}

// ------------------------------------------------------------
// R4 — fact value parsing + specification CSV (§4.6)
// ------------------------------------------------------------

/** "1200" → 1200, "true" → true, anything else stays the human's words. */
export function parseFactValue(s: string): Exclude<FactValue, null> {
  const t = s.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
  return t;
}

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The specification as CSV — current facts with their provenance intact (§4.6). */
export function specificationCsv(ledger: Ledger): string {
  const header = [
    'fact', 'value', 'unit', 'state', 'drawing', 'revision', 'section',
    'handles', 'rawText', 'saidAs', 'suppliedBy', 'method', 'basis', 'readOn',
  ];
  const lines = [header.join(',')];
  for (const e of ledger.entries) {
    const f = e.fact;
    if (f.supersededBy !== undefined) continue;
    lines.push(
      [
        f.id,
        f.value,
        f.unit,
        f.state + (f.contradicted ? ' (contradicted)' : f.stale ? ' (stale)' : ''),
        f.source?.drawingNumber,
        f.source?.revision,
        f.source?.sectionId,
        (f.source?.handles ?? []).join(' '),
        f.source?.rawText,
        f.saidAs,
        f.suppliedBy,
        f.method,
        f.basis,
        f.readOn,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n');
}

const pdfSvgCache = new Map<string, { svg: string; model: StudioSheet['model'] }>();

function pdfDisplayName(entry: PdfRegisterEntry): string {
  const core = entry.fileName;
  return entry.pageCount > 1 ? `${core} — page ${entry.pageIndex + 1}` : core;
}

/**
 * The folder a multi-page PDF's pages sit under — same shape as a drawing's
 * Sections/ folder (§3.2), for the same reason: a 30-page PDF dumped as 30
 * flat rows into its discipline folder buried everything else in it, and
 * every page shares the one import it came from anyway. `importedAt` is set
 * once per import call (§ importPicked), so it groups exactly the pages of
 * ONE import — never two different uploads that happen to share a filename.
 */
function pdfPagesFolderId(importedAt: number): string {
  return `f-pdf-pages-${importedAt}`;
}

// ------------------------------------------------------------
// BbsChatResult rows → ScheduleRow (the seam adaptation, §6.1)
// ------------------------------------------------------------

/**
 * Adapt the engine's immutable chat rows to the shell's schedule shape. No
 * figure is recomputed — fields the chat artifact does not carry (legs, shape
 * code) stay empty and the derived column set simply omits them (§6.2 rule 1).
 * Evidence ids become DXF handles through the deterministic evidence graph so
 * clicking a row can light its geometry.
 */
export function adaptChatRows(result: BbsChatResult, graph: EvidenceGraph | null): ScheduleRow[] {
  const memberType = new Map(result.members.map((m) => [m.mark, m.type] as const));
  // §6.4 — an unavailable row carries its formula-with-a-hole across the seam
  // so the table can render a question where a dash used to be.
  const blocked = blockedRowsOf(result);
  return result.rows.map((row: BbsChatRow, i: number) => {
    const counts: string[] = [];
    const weights: string[] = [];
    const lengths: string[] = [];
    for (const line of row.working) {
      if (/^(members|bars):/i.test(line)) counts.push(line);
      else if (/^weight:/i.test(line)) weights.push(line);
      else lengths.push(line);
    }
    const handles = new Set<string>();
    if (graph) {
      for (const id of row.evidenceIds) {
        const node = graph.byId.get(id);
        if (node) for (const h of node.sourceHandles) handles.add(h);
      }
    }
    const type = memberType.get(row.memberMark);
    return {
      id: `${result.id}:${row.barMark}:${i}`,
      mark: row.barMark,
      member: type ? `${row.memberMark} ${type}` : row.memberMark,
      barType: '',
      diaMm: row.diameterMm,
      shapeCode: row.shapeCode ?? '',
      segments: row.segments ?? [],
      cuttingLengthMm: row.cuttingLengthMm ?? null,
      lengthWorking: lengths.join(' · '),
      lengthSource: row.status === 'unavailable' ? 'UNAVAILABLE' : ((row.lengthSource as ScheduleRow['lengthSource'] | undefined) ?? 'SHAPE_FORMULA'),
      barsPerMember: row.barsPerMember ?? null,
      memberCount: row.memberCount ?? null,
      // never `?? 0`: an underived count is a hole, and 0 is a number that
      // weighs nothing and passes every check
      totalBars: row.totalBars ?? null,
      spacingMm: row.spacingMm ?? null,
      occurrenceBand: null,
      countWorking: counts.join(' · ') || undefined,
      totalLengthM: row.totalLengthM ?? null,
      unitWeightKgPerM: row.unitWeightKgPerM ?? null,
      weightKg: row.totalWeightKg ?? null,
      weightWorking: weights.join(' · ') || undefined,
      warnings: row.note && row.status !== 'verified' ? [row.note] : [],
      fromCallout: row.description || null,
      handles: [...handles],
      status: row.status,
      ...(row.engineering ? { engineering: row.engineering } : {}),
      missing: row.status === 'unavailable' ? row.note : undefined,
      coverMm: row.coverMm ?? row.trace?.coverMm ?? null,
      coverSource: row.coverSource ?? row.trace?.coverSource,
      coverStatus: row.coverStatus ?? row.trace?.coverStatus,
      ...(row.trace ? { trace: row.trace } : {}),
      ...(blocked.has(row.id) ? { blocked: blocked.get(row.id) } : {}),
    } satisfies ScheduleRow;
  });
}

// ------------------------------------------------------------
// the OpenRouter seam for the orchestrator, browser side
// ------------------------------------------------------------

interface Spend {
  calls: number;
  costUsd: number;
}

interface AskRunState {
  running: boolean;
  progress: string[];
  error: string | null;
  stats: string | null;
}

/**
 * Mirrors the ask() the live harness built (SOURCE tests/live/orchestrated
 * .livetest.ts): per-request timeout with a hard wall clock, one retry, images
 * dropped for models that refuse them, cost read off the usage block.
 */
function makeAsk(spend: Spend, push: (line: string) => void) {
  const cfg = getAiConfig();
  const model = cfg.textModel || cfg.visionModel;
  let lastAt = 0;
  return async (args: {
    system: string;
    prompt: string;
    images: { dataUrl: string; caption: string }[];
    label: string;
  }): Promise<Record<string, unknown> | null> => {
    const wait = lastAt + 120 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const t0 = Date.now();
    const timeoutMs = args.label === 'orchestrator' || args.label === 'judge' ? 240_000 : 90_000;
    let raw = '';
    let error: string | undefined;
    let usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined;
    let sendImages = args.images ?? [];

    for (let attempt = 1; attempt <= 2; attempt++) {
      error = undefined;
      try {
        const res = (await Promise.race([
          fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              Authorization: `Bearer ${cfg.apiKey}`,
              'Content-Type': 'application/json',
              'X-Title': cfg.appName,
            },
            body: JSON.stringify({
              model: args.label === 'judge' ? cfg.judgeModel : model,
              temperature: 0.1,
              max_tokens: 16000,
              reasoning: { effort: 'low' },
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: args.system },
                {
                  role: 'user',
                  content: sendImages.length
                    ? [
                        { type: 'text', text: args.prompt },
                        ...sendImages.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } })),
                      ]
                    : args.prompt,
                },
              ],
            }),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`no response within ${Math.round(timeoutMs / 1000)}s (hard deadline)`)),
              timeoutMs + 15_000,
            ),
          ),
        ])) as Response;
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          error = messageFromErrorBody(res.status, body);
          if (attempt === 1 && sendImages.length && /image input|image_url|does not support image/i.test(body + error)) {
            sendImages = [];
            continue;
          }
          break;
        }
        const payload = (await res.json()) as Record<string, unknown>;
        raw = contentOf(payload);
        usage = payload.usage as typeof usage;
        if (attempt === 1 && !parseModelJson(raw)) {
          error = 'the reply came back empty or unreadable';
          continue;
        }
        error = undefined;
        break;
      } catch (e) {
        error = `request failed — ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    lastAt = Date.now();
    spend.calls += 1;
    spend.costUsd += usage?.cost ?? 0;
    const tokens =
      usage?.prompt_tokens !== undefined ? ` · ${usage.prompt_tokens}→${usage.completion_tokens ?? 0} tok` : '';
    const cost = usage?.cost ? ` · $${usage.cost.toFixed(5)}` : '';
    push(
      `${args.label}: ${Date.now() - t0} ms${sendImages.length ? ` · ${sendImages.length} image(s)` : ''}${tokens}${cost}${error ? ` · FAILED: ${error}` : ''}`,
    );
    return error ? null : parseModelJson(raw);
  };
}

// ------------------------------------------------------------
// register tree derivation
// ------------------------------------------------------------

type RegisterNodeList = (RegisterFileNode | RegisterFolderNode)[];

const DISCIPLINE_LABEL: Record<string, string> = {
  architectural: 'Architectural',
  structural: 'Structural',
  mep: 'MEP',
  civil: 'Civil',
  general: 'General',
};

/** The folder id a discipline is listed under — the inverse is `disciplineOfFolderId`. */
const disciplineFolderId = (discipline: string): string =>
  `f-disc-${(DISCIPLINE_LABEL[discipline] ?? 'General').toLowerCase()}`;

/**
 * The discipline a browsed folder stands for: `f-disc-structural` →
 * 'structural'. Null for anything else — the root, Outputs, a Sections
 * folder — because those are not a discipline and an import into one has no
 * folder to inherit.
 */
function disciplineOfFolderId(folderId: string | undefined): string | null {
  const label = folderId?.startsWith('f-disc-') ? folderId.slice('f-disc-'.length) : null;
  if (!label) return null;
  return Object.keys(DISCIPLINE_LABEL).find((key) => key === label) ?? null;
}

/** R3 — everything the register projection needs to know about one drawing's split. */
export interface DocSplitView {
  status: SplitStatus | null;
  pkg: DrawingUnderstandingPackage | null;
  /** a residual layer the splitter never accounted for (§3.4) */
  unexplainedGap: boolean;
}

/**
 * §3.1 — the split status IS the register's state dot: a queued/running job
 * shows busy, a failure or an unexplained coverage gap shows warn; otherwise
 * the entry's own health speaks.
 */
function nodeStateFor(entry: DrawingRegisterEntry, split: DocSplitView | undefined): RegisterFileNode['state'] {
  if (split) {
    if (split.status === 'queued' || split.status === 'splitting') return 'busy';
    if (split.status === 'failed' || split.status === 'stale' || split.unexplainedGap) return 'warn';
  }
  return entry.health === 'ready' ? 'ok' : entry.health === 'limited' ? 'warn' : 'idle';
}

/**
 * A file is called what it was imported as.
 *
 * The node used to be named from the title block — a foundation drawing
 * uploaded under its own name appeared in the register, the Files list, the
 * tab strip and the window title as "PCD-IND-B300-S-803-R0 · S", a number and
 * a revision nobody typed. The number is still reported, in the Drawing No.
 * column that says so; it is not the file's name.
 */
function fileNodeFor(
  entry: DrawingRegisterEntry,
  sheetId: string | undefined,
  split?: DocSplitView,
): RegisterFileNode {
  return {
    kind: 'file',
    id: entry.id,
    // Rename/delete act on this — the register entry's own id, so the two
    // never drift onto a section's sheet id or an output's artifact id.
    entryId: entry.id,
    // FILING acts on this. See `RegisterFileNode.documentId`: the entry id is
    // minted per browser, the document id is the same string everywhere, and
    // a folder membership has to survive a different machine.
    documentId: entry.documentId,
    name: entry.originalFileName || entry.displayName,
    rev: entry.revision || undefined,
    current: entry.revisionState === 'current',
    // Said on the row, because the folder that used to say it is gone.
    ...(entry.revisionState === 'superseded' ? { superseded: true } : {}),
    at: entry.importedAt,
    state: nodeStateFor(entry, split),
    sheetId,
    discipline: DISCIPLINE_LABEL[entry.discipline] ?? 'General',
    // Only a drawing actually held in more than one version says which one
    // this is; on everything else the chip would be "v1 of 1" on every row.
    ...(entry.versionCount > 1
      ? { version: entry.versionNo, versionCount: entry.versionCount }
      : {}),
    ...(entry.reuploadedAt ? { reuploadedAt: entry.reuploadedAt } : {}),
    ...(sheetId ? {} : { ext: 'dxf' }),
  };
}


/**
 * The tree, testable without a React tree around it.
 *
 * Exported because the filing rules this function encodes — one drawing
 * identity across two views, a section folder that follows its drawing, a
 * discipline that never moves — are exactly the kind of thing that breaks
 * silently and cannot be seen in a screenshot.
 */
export const buildGroupsForTest = (
  ...args: Parameters<typeof buildGroups>
): ReturnType<typeof buildGroups> => buildGroups(...args);

/** The split view for an entry, for `fileNodeFor`'s state dot. */
function split0(
  splitByDoc: Map<string, DocSplitView>,
  entry: DrawingRegisterEntry,
): DocSplitView | undefined {
  return splitByDoc.get(entry.documentId);
}

function buildGroups(
  entries: DrawingRegisterEntry[],
  sheetByDoc: Map<string, string>,
  pdfEntries: PdfRegisterEntry[],
  artifacts: ProjectArtifact[],
  splitByDoc: Map<string, DocSplitView>,
  userFolders: readonly UserFolder[],
): RegisterGroup[] {
  // Drawings, by discipline — ALL of them, superseded revisions included.
  // They used to be skipped here and listed only under Attention, so removing
  // that group would have made an old revision unreachable in the whole app.
  // A superseded row stays where its drawing lives and says what it is in its
  // Status column; nothing is hidden, and nothing is listed twice.
  //
  // A drawing with a split package brings its Sections/ folder in right
  // beneath it (§3.2) — sections are real files in the same tree.
  //
  // A DRAWING IS LISTED WHERE IT IS FILED, AND IN ONE PLACE ONLY.
  //
  // Filing a drawing into a folder someone made is a decision about where it
  // lives. The discipline folder is not a second home for it — it is what the
  // register does with a drawing NOBODY has filed, which is to group it by
  // what the sheet says it is.
  //
  // Listing it under both was defensible and it was still wrong in use: two
  // identical rows, and no way to tell from the tree which one was the filing
  // and which the classification. The discipline has not gone anywhere — it is
  // the DISCIPLINE column in Files, the chip and the "Discipline" row in
  // Details, and it is still what decides the folder the moment the drawing is
  // taken out of every folder someone made.
  //
  // The section folder follows its drawing, for the same reason and by the
  // same rule.
  const filed = new Set<string>();
  for (const folder of userFolders) for (const member of folder.members) filed.add(member);
  const isFiled = (...keys: (string | undefined)[]): boolean =>
    keys.some((k) => k !== undefined && filed.has(k));

  // EVERY drawing node, whether or not the discipline view lists it. A user
  // folder resolves its members through this, so building it from the
  // discipline lists alone would empty the folder of exactly the drawings that
  // are filed in it.
  const nodeById = new Map<string, RegisterNode>();
  const remember = (node: RegisterNode) => {
    nodeById.set(node.id, node);
    if (node.kind === 'file' && node.documentId) nodeById.set(node.documentId, node);
  };

  /** documentId → the drawing's section folder, so a filing view can pick it up. */
  const sectionsByDoc = new Map<string, RegisterFolderNode>();

  const byDiscipline = new Map<string, RegisterNodeList>();
  for (const entry of entries) {
    const label = DISCIPLINE_LABEL[entry.discipline] ?? 'General';
    const list = byDiscipline.get(label) ?? [];
    const node = fileNodeFor(entry, sheetByDoc.get(entry.documentId), split0(splitByDoc, entry));
    remember(node);
    const split = splitByDoc.get(entry.documentId);
    let sections: RegisterFolderNode | undefined;
    if (split?.pkg) {
      sections = sectionsFolderFor(split.pkg, entry.originalFileName || entry.displayName);
      sectionsByDoc.set(entry.documentId, sections);
      remember(sections);
    }
    if (!isFiled(entry.documentId, entry.id)) {
      list.push(node);
      if (sections) list.push(sections);
      byDiscipline.set(label, list);
    } else if (!byDiscipline.has(label)) {
      // The label still has to exist when something else is in it; an empty
      // discipline folder is dropped below rather than shown holding nothing.
      byDiscipline.set(label, list);
    }
  }
  // A PDF page files by discipline exactly as a drawing does. It used to be
  // pinned to General here regardless of what it was or where it was imported,
  // so a foundation PDF landed in General while its own DXF sat in Structural.
  //
  // A single-page PDF is one row, same as always. A MULTI-page one groups its
  // pages into a Pages/ folder (§ pdfPagesFolderId) instead of dumping every
  // page as a flat sibling — a 30-page PDF used to bury everything else in its
  // discipline folder under 30 rows for what a person imported as one file.
  const pdfBatches = new Map<string, PdfRegisterEntry[]>();
  for (const pdf of pdfEntries) {
    const key = pdf.pageCount > 1 ? pdfPagesFolderId(pdf.importedAt) : `single:${pdf.id}`;
    const batch = pdfBatches.get(key) ?? [];
    batch.push(pdf);
    pdfBatches.set(key, batch);
  }
  for (const batch of pdfBatches.values()) {
    const first = batch[0];
    const label = DISCIPLINE_LABEL[first.discipline ?? 'general'] ?? 'General';
    const list = byDiscipline.get(label) ?? [];
    // Same rule as a drawing: a PDF filed into a folder someone made is listed
    // there, not also under its discipline.
    const pdfFiled = isFiled(
      batch.length > 1 ? pdfPagesFolderId(first.importedAt) : first.id,
    );
    if (batch.length > 1) {
      const pages = [...batch].sort((a, b) => a.pageIndex - b.pageIndex);
      const pagesFolder: RegisterFolderNode = {
        kind: 'folder',
        id: pdfPagesFolderId(first.importedAt),
        name: `Pages — ${first.fileName}`,
        meta: `${pages.length} page${pages.length === 1 ? '' : 's'}`,
        at: first.importedAt,
        // Delete/rename act on this — the folder IS the imported file.
        pdfBatchAt: first.importedAt,
        children: pages.map((pdf) => ({
          kind: 'file',
          id: pdf.id,
          // Rename/delete act on this — see the field's own doc comment.
          pdfId: pdf.id,
          name: `Page ${pdf.pageIndex + 1}`,
          rev: pdf.revision || undefined,
          state: 'ok' as const,
          sheetId: pdf.id,
          discipline: label,
          ext: 'pdf',
          at: pdf.importedAt,
        })),
      };
      remember(pagesFolder);
      if (!pdfFiled) list.push(pagesFolder);
    } else {
      const page: RegisterFileNode = {
        kind: 'file',
        id: first.id,
        pdfId: first.id,
        name: pdfDisplayName(first),
        rev: first.revision || undefined,
        state: 'ok',
        sheetId: first.id,
        discipline: label,
        ext: 'pdf',
        at: first.importedAt,
      };
      remember(page);
      if (!pdfFiled) list.push(page);
    }
    byDiscipline.set(label, list);
  }
  const disciplineFolders: RegisterFolderNode[] = [...byDiscipline.entries()]
    // Every drawing of this discipline is filed somewhere a person put it, so
    // there is nothing for this folder to group. It comes back the moment one
    // of them is moved out of every folder.
    .filter(([, children]) => children.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, children]) => ({
      kind: 'folder',
      id: `f-disc-${label.toLowerCase()}`,
      name: label,
      children,
    }));

  // Folders a PERSON made. They hold the same node objects the discipline
  // folders hold — a second membership, not a move (src/register/folders.ts),
  // so a drawing filed into "WH-4 package" is still in Structural where the
  // register's own rules can keep it honest. A member that no longer exists
  // (deleted drawing) simply does not resolve; the folder does not carry a
  // ghost row for it.
  //
  // TWO KEYS PER DRAWING, ONE DRAWING.
  //
  // A membership written today names the DOCUMENT id, which is the same on
  // every machine. One written before that named the ENTRY id, which was
  // minted locally. Both resolve to the same single node here — there is one
  // drawing identity and this is not a place that could produce a second.
  const madeFolders: RegisterFolderNode[] = userFolders.map((f) => {
    const children: RegisterNode[] = [];
    const seen = new Set<string>();
    for (const member of f.members) {
      const node = nodeById.get(member);
      // A member that no longer exists (deleted drawing) simply does not
      // resolve; the folder carries no ghost row for it. `seen` is what stops
      // a folder holding the same drawing twice when a membership was written
      // under both keys.
      if (!node || seen.has(node.id)) continue;
      seen.add(node.id);
      children.push(node);
      const sections = node.kind === 'file' && node.documentId
        ? sectionsByDoc.get(node.documentId)
        : undefined;
      if (sections && !seen.has(sections.id)) {
        seen.add(sections.id);
        children.push(sections);
      }
    }
    return {
      kind: 'folder' as const,
      id: f.id,
      name: f.name,
      userMade: true,
      at: f.createdAt,
      children,
    };
  });

  // Outputs — issued artifacts, versioned.
  //
  // A filed BBS is STORED as the engine result (JSON), because that is the
  // thing a schedule can be re-rendered and re-checked from — a spreadsheet
  // is a rendering of it, not the record. But the deliverable a person is
  // looking for in this folder is the workbook, so the node is NAMED for the
  // workbook, with exactly the filename `bbsFileName` will hand them when they
  // press Download. Two names for one output is how a folder stops matching
  // what comes out of it.
  const outputFolder = (id: string, name: string, kind: string): RegisterFolderNode => ({
    kind: 'folder',
    id,
    name,
    children: artifacts
      .filter((a) => a.kind === kind)
      .map((a) => ({
        kind: 'file' as const,
        id: a.id,
        name:
          kind === 'bbs'
            ? bbsFileName(
                {
                  drawingFile: a.drawingName,
                  drawingNumber: a.drawingNumber,
                  revision: a.revision,
                },
                { version: a.version },
              )
            : a.fileName,
        tag: `v${a.version}`,
        state: 'ok' as const,
        at: a.createdAt,
        // The number the name no longer carries. It is not lost — it is where
        // a number belongs, in the row's own Drawing no. column.
        ...(a.drawingNumber ? { number: a.drawingNumber } : {}),
        // Opening a filed schedule shows THAT version, not the newest one.
        dockTab: kind === 'bbs' ? 'bbs' : 'qty',
        artifactId: a.id,
        ext: kind === 'bbs' ? 'xlsx' : a.mimeType === 'application/json' ? 'json' : 'csv',
      })),
  });
  const bbsFolder = outputFolder('f-out-bbs', 'BBS', 'bbs');
  const qtyFolder = outputFolder('f-out-qty', 'Quantities', 'quantity');
  const outputFolders = [bbsFolder, qtyFolder].filter((f) => f.children.length > 0);

  // There is no "Attention" group. Needs-review and superseded were folders
  // that re-listed drawings the tree already held, and every one of those rows
  // states its own condition — the state dot beside it, the Status column in
  // the Files view. A second copy under a second heading is not a second fact.
  const groups: RegisterGroup[] = [{ id: 'g-drawings', name: 'Drawings', folders: disciplineFolders }];
  if (outputFolders.length) groups.push({ id: 'g-outputs', name: 'Outputs', folders: outputFolders });
  if (madeFolders.length) groups.push({ id: 'g-folders', name: 'Folders', folders: madeFolders });
  return groups;
}

// ------------------------------------------------------------
// sheet building
// ------------------------------------------------------------

/**
 * StudioSheet objects are cached by identity key: the Viewport re-injects the
 * (multi-MB) SVG whenever the sheet OBJECT changes, so a rebuild during a BBS
 * run must hand back the same object unless something about the sheet changed.
 */
const studioSheetCache = new Map<string, { key: string; sheet: StudioSheet }>();

function cadStudioSheet(
  s: CadSheet,
  entry: DrawingRegisterEntry | undefined,
  hasSchedule: boolean,
  highlights: readonly SheetHighlight[],
): StudioSheet {
  const key = [
    s.doc.id,
    // The sheet's SVG now CONTAINS the read-section highlights, so the sheet
    // must be rebuilt when they arrive. Without this the cache would hand back
    // the pre-read SVG for the life of the session and no highlight would
    // ever appear.
    highlights.map((h) => h.id).join('+'),
    entry?.originalFileName ?? '',
    entry?.revision ?? '',
    entry?.health ?? '',
    entry?.revisionState ?? '',
    entry?.warnings.length ?? 0,
    hasSchedule ? 1 : 0,
  ].join('|');
  const hit = studioSheetCache.get(s.id);
  if (hit && hit.key === key) return hit.sheet;
  const sheet = buildCadStudioSheet(s, entry, hasSchedule, highlights);
  studioSheetCache.set(s.id, { key, sheet });
  return sheet;
}

function buildCadStudioSheet(
  s: CadSheet,
  entry: DrawingRegisterEntry | undefined,
  hasSchedule: boolean,
  highlights: readonly SheetHighlight[],
): StudioSheet {
  const rendered = renderDoc(s.doc, highlights);
  const number = entry?.drawingNumber || '';
  const rev = entry?.revision || '';
  const title = entry?.title || s.doc.name;
  return {
    id: s.id,
    tab: entry?.originalFileName || s.doc.sourceFile || s.doc.name,
    title,
    number: number || s.doc.name,
    rev,
    discipline: entry ? (DISCIPLINE_LABEL[entry.discipline] ?? 'General') : 'General',
    entities: s.doc.entities.length,
    grounded: hasSchedule,
    issues: entry?.warnings.length ?? 0,
    hasModel: false,
    superseded: entry?.revisionState === 'superseded',
    panels: [],
    model: rendered.model,
    svg: rendered.svg,
    fileName: entry?.originalFileName || s.doc.sourceFile || s.doc.name,
    extractLine: rendered.extractLine,
    marksDrawn: rendered.marksDrawn,
    documentId: s.doc.id,
  };
}

// ------------------------------------------------------------
// section sheets — a section opens as a sheet in its own right (§3.2)
// ------------------------------------------------------------
//
// Render decision: the parent document's ENTITY SUBSET through the existing
// sheet render path (buildDisplayList → groupedSheetSvg) — the cheapest route
// the ported code offers, and it keeps original handles so the shared
// selection/highlight path works on a section exactly as on its parent.

const sectionSheetCache = new Map<string, { key: string; sheet: StudioSheet }>();

function sectionStudioSheet(
  id: string,
  pkg: DrawingUnderstandingPackage,
  section: DrawingSection,
  parent: CadSheet,
  entry: DrawingRegisterEntry | undefined,
): StudioSheet {
  // a re-split replaces the package; REGION ids repeat, so key on its birth
  const cacheKey = `${pkg.createdAt ?? 0}|${entry?.revision ?? ''}`;
  const hit = sectionSheetCache.get(id);
  if (hit && hit.key === cacheKey) return hit.sheet;
  const sub = sectionSubsetDoc(parent.doc, section);
  const list = buildDisplayList(sub, { regionId: null, hiddenLayers: new Set<string>(), paper: false });
  // The document's own scale, for the same reason `renderDoc` uses it: an
  // extract that threw would silently make this 1 while the section's own
  // millimetre bounds stayed on `doc.unitScale`.
  const unitScale = parent.doc.unitScale || 1;
  // A section sheet carries ITS OWN outline. Opening REGION-01 as a sheet
  // otherwise showed a drawing with no mark on it anywhere, which reads as
  // "the highlighting is broken" — the highlights were on the parent, one tab
  // away. Same colour, same meaning: this is the part that was read.
  const rendered = groupedSheetSvg(list, {
    width: 1600,
    highlights: [
      { id: section.sectionId, label: section.label, bounds: section.bounds, kind: 'read' },
    ],
    mmPerUnit: unitScale,
  });
  const b = section.bounds;
  const limitations = section.limitations ?? [];
  const detail: SectionDetailData = {
    sectionId: section.sectionId,
    label: section.label,
    kind: section.kind,
    memberHints: (section.memberHints ?? []).map((m) => ({ mark: m.mark, basis: m.basis })),
    calloutHints: section.calloutHints ?? [],
    bounds: { ...b },
    widthMm: b.xMax - b.xMin,
    heightMm: b.yMax - b.yMin,
    entityCount: section.entityCount ?? sub.entities.length,
    evidenceIds: section.evidenceIds ?? [],
    confidence: section.confidence ?? 0,
    limitations: limitations.map((l) => ({ code: l.code, message: l.message, count: l.count })),
    orchestratorStep: section.orchestratorStep ?? 0,
    parentSheetId: parent.id,
    parentName: entry?.originalFileName || parent.doc.name,
  };
  const sheet: StudioSheet = {
    id,
    tab: `${section.sectionId} ${section.label}`.slice(0, 48),
    title: section.label,
    number: section.sectionId,
    rev: entry?.revision ?? '',
    discipline: entry ? (DISCIPLINE_LABEL[entry.discipline] ?? 'General') : 'General',
    entities: sub.entities.length,
    grounded: false,
    issues: limitations.length,
    hasModel: false,
    panels: [],
    model: modelMapFor(list, rendered, unitScale),
    svg: rendered.svg,
    fileName: `sections/${section.sectionId}/section.dxf`,
    extractLine: `${sub.entities.length.toLocaleString('en-IN')} entities · cut from ${pkg.sourceDrawing}`,
    documentId: parent.doc.id,
    section: detail,
  };
  sectionSheetCache.set(id, { key: cacheKey, sheet });
  return sheet;
}

// ------------------------------------------------------------
// the unread parts of a drawing — geometry, never a model
// ------------------------------------------------------------
//
// `findGapClusters` walks every entity in the document against every section
// box, so it is cached per package: the result changes only when the drawing
// is read again, and re-walking 3,000 entities on every render of the Details
// panel would be for nothing.
//
// NO KEY IS INVOLVED. This is the answer to "the drawing is already split —
// why should looking at what it missed cost a model call?". It does not.

/**
 * Does an unread part matter to the schedule?
 *
 * `required` is asserted ONLY from a bar callout the grammar actually read —
 * "T16@150 C/C" parsing into a 16 mm bar at 150 mm centres is a fact about
 * what is written on the drawing. Everything else is `unknown`, which the
 * panel shows as "Unknown / Needs Review".
 *
 * There is deliberately no `not-required`. The only way to reach it would be a
 * layer-name rule, and `coverage.ts` says plainly why this project refuses
 * those — they are "wrong on the next drawing's layer names". An unread part
 * quietly marked irrelevant is a missed quantity nobody was told about.
 */
export function bbsVerdict(callouts: string[]): Pick<GapClusterData, 'bbs' | 'bbsBasis'> {
  if (callouts.length) {
    return {
      bbs: 'required',
      bbsBasis: `reads as reinforcement: ${callouts.map((c) => `"${c}"`).join(', ')}`,
    };
  }
  return {
    bbs: 'unknown',
    bbsBasis: 'no bar callout could be read here — open it and decide',
  };
}

/**
 * Per section: how many entities in its box the renderer draws, and how many
 * it skips for being on a frozen or invisible layer.
 *
 * Pure geometry over the parsed drawing — no model, no key — and cached with
 * the gaps, because it walks the same entity list.
 */
function sectionInkFor(
  doc: CadDocument | undefined,
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number },
): { renderable: number; hidden: number } {
  if (!doc) return { renderable: 0, hidden: 0 };
  let renderable = 0;
  let hidden = 0;
  for (const e of doc.entities) {
    const b = entityBoundsMm(e, doc);
    if (!b || !boundsIntersect(bounds, b)) continue;
    const layer = doc.layers.get(e.style.layer);
    // The same test `buildDisplayList` makes (displayList.ts) — one rule.
    if (layer && (!layer.visible || layer.frozen)) hidden += 1;
    else renderable += 1;
  }
  return { renderable, hidden };
}

const inkCache = new Map<string, { key: string; ink: Map<string, { renderable: number; hidden: number }> }>();

function sectionInkMap(
  docId: string,
  pkg: DrawingUnderstandingPackage,
): Map<string, { renderable: number; hidden: number }> {
  // The residual count is part of the key: without it the second pass lands
  // and the panel keeps showing the cached pre-reading gaps.
  const key = `${pkg.createdAt ?? 0}|${pkg.sections.length}|${pkg.residuals?.length ?? -1}`;
  const hit = inkCache.get(docId);
  if (hit && hit.key === key) return hit.ink;
  const doc = cadSheets().find((s) => s.doc.id === docId)?.doc;
  const ink = new Map<string, { renderable: number; hidden: number }>();
  for (const s of pkg.sections) ink.set(s.sectionId, sectionInkFor(doc, s.bounds));
  inkCache.set(docId, { key, ink });
  return ink;
}

const gapCache = new Map<string, { key: string; gaps: GapClusterData[] }>();
const finalCache = new Map<string, { key: string; value: Finalization }>();

/**
 * THE FINAL STATE OF ONE DRAWING — what is blue, what is orange, and nothing
 * that is both.
 *
 * Before this existed, the sheet was built from `pkg.sections` plus EVERY gap
 * cluster, so a residual the second pass had read as belonging to REGION-10
 * still carried its orange outline while REGION-10 kept its old bounds. Two
 * contradictory statements about the same entities, drawn at once.
 *
 * Deterministic and local: the readings are already stored on the package, and
 * resolving them into regions is arithmetic. No model call, no key.
 */
function finalizationFor(docId: string, pkg: DrawingUnderstandingPackage): Finalization {
  const key = `${pkg.createdAt ?? 0}|${pkg.sections.length}|${pkg.residuals?.length ?? -1}`;
  const hit = finalCache.get(docId);
  if (hit && hit.key === key) return hit.value;
  const doc = cadSheets().find((s) => s.doc.id === docId)?.doc ?? null;
  // The residuals are keyed by GAP id and so are the clusters — recomputing the
  // clusters here would risk two numberings; the stored readings carry their
  // own bounds and handles, which is all finalisation needs.
  const value = finalizeSecondPass(doc, pkg.sections, pkg.residuals ?? []);
  finalCache.set(docId, { key, value });
  // THE ACCEPTANCE REPORT, once per finalisation (the cache makes it once per
  // package). The two invariants are checked here rather than assumed: the
  // books must balance, and nothing may be blue and orange at once.
  if (import.meta.env?.MODE !== 'test' && pkg.residuals?.length) {
    // eslint-disable-next-line no-console
    console.log([`${pkg.sourceDrawing || docId}`, ...finalizationReport(value)].join('\n'));
    // THE TWO ACCEPTANCE CONDITIONS, checked rather than assumed. An entity
    // owned twice and an accounting that does not balance are both silent
    // failures — every coverage figure downstream still renders, just wrong.
    if (value.conflicts.length) {
      // eslint-disable-next-line no-console
      console.error(
        `DUPLICATE ENTITY OWNERSHIPS: ${value.conflicts.length} → ${value.conflicts.slice(0, 20).join(', ')}`,
      );
    }
    // WHERE DID EACH INSTANCE OF A REPEATED LABEL GO?
    //
    // Four "C1"s on a sheet with two of them highlighted is three different
    // failures wearing the same face. The ownership map already tells them
    // apart, so this costs nothing and is printed beside the accounting.
    const doc2 = cadSheets().find((x) => x.doc.id === docId)?.doc;
    if (doc2) {
      const groups = auditLabels(doc2, value, { onlyUnaccounted: true });
      if (groups.length) {
        // eslint-disable-next-line no-console
        console.warn(labelAuditReport(groups).join('\n'));
      }
    }
    if (!value.accounting.pass) {
      // eslint-disable-next-line no-console
      console.error('ACCOUNTING CHECK: FAIL', value.accounting);
    }
  }
  return value;
}

function gapClustersFor(docId: string, pkg: DrawingUnderstandingPackage): GapClusterData[] {
  // The residual count is part of the key: without it the second pass lands
  // and the panel keeps showing the cached pre-reading gaps.
  const key = `${pkg.createdAt ?? 0}|${pkg.sections.length}|${pkg.residuals?.length ?? -1}`;
  const hit = gapCache.get(docId);
  if (hit && hit.key === key) return hit.gaps;
  const doc = cadSheets().find((s) => s.doc.id === docId)?.doc;
  // With no parsed drawing in the session there is nothing to measure against
  // — and an empty list is the honest answer, not a guess from the summary.
  const clusters = doc
    ? findGapClusters(
        doc,
        pkg.sections.map((s) => ({ sectionId: s.sectionId, bounds: s.bounds })),
        pkg.sheetExtents,
      )
    : [];
  // Reading the text is done HERE, not in `understanding/`: that module is the
  // splitter's, and the splitter does not import the BBS engine — the module
  // graph enforces it (tests/domain/drawing-splitter.test.ts, "never reaches
  // into the BBS engine"). The studio layer may see both, so this is where a
  // string becomes "a bar callout" rather than "some text".
  // What the second pass read, if it has run. Keyed by GAP id — the ids come
  // from the same clusterer, so they line up by construction.
  const readBack = new Map((pkg.residuals ?? []).map((r) => [r.gapId, r]));
  // And what was DONE about it. A piece attached to a region is history, not a
  // review item: the sidebar still shows where it went, but it must not be
  // counted as unread and must not be drawn orange.
  const outcomes = new Map(finalizationFor(docId, pkg).outcomes.map((o) => [o.gapId, o]));
  const gaps: GapClusterData[] = clusters.map((c) => {
    const callouts: string[] = [];
    const rest: string[] = [];
    for (const t of c.sampleText) {
      (parsedAnything(parseCallout(t)) ? callouts : rest).push(t);
    }
    return {
      id: c.id,
      bounds: c.bounds,
      entityCount: c.entityCount,
      layers: c.layers,
      touches: c.touches,
      nearest: c.nearest,
      callouts: callouts.slice(0, 6),
      sampleText: rest.slice(0, 6),
      // A verdict only where the CONTENT gives one. A cluster the bar grammar
      // read a bar out of is reinforcement this schedule has not counted; for
      // anything else the honest answer is that we do not know, and saying so
      // is the point — a quiet "no" would hide the uncertainty.
      ...bbsVerdict(callouts),
      ...(readBack.has(c.id)
        ? {
            second: (() => {
              const r = readBack.get(c.id)!;
              const o = outcomes.get(c.id);
              return {
                // FROM THE OUTCOME, not from the residual's stored `link`.
                // That one was decided when the reading came back and can
                // disagree with the geometry; this one IS the geometry.
                link: o?.relationship ?? 'INDEPENDENT',
                connectedRegions: o?.connectedRegions ?? [],
                uniqueEntities: o?.uniqueEntities ?? c.entityCount,
                linkedTo: o?.regionId ?? null,
                status: r.status,
                kind: r.reading?.kind ?? null,
                summary: r.reading?.summary ?? null,
                relation: r.reading?.relation ?? null,
                note: r.note ?? null,
                action: o?.action ?? 'unresolved',
                // For an attachment this is the region it went INTO, which is
                // not always the one the reading named — finalisation refuses
                // an attachment to a region that is not in the package.
                resolvedTo: o?.regionId ?? null,
                why: o?.why ?? null,
              };
            })(),
          }
        : {}),
    };
  });
  gapCache.set(docId, { key, gaps });
  return gaps;
}

const pdfStudioSheetCache = new Map<string, StudioSheet>();

function pdfStudioSheet(entry: PdfRegisterEntry): StudioSheet {
  // PDF entries are immutable after import — cache the whole sheet object so
  // the Viewport never re-injects an unchanged raster underlay.
  const existing = pdfStudioSheetCache.get(entry.id);
  if (existing) return existing;
  let cached = pdfSvgCache.get(entry.id);
  if (!cached) {
    cached = pdfSheetSvg(entry.sheet);
    pdfSvgCache.set(entry.id, cached);
  }
  const runs = entry.sheet.texts.length;
  const sheet: StudioSheet = {
    id: entry.id,
    tab: pdfDisplayName(entry),
    title: entry.title || entry.fileName,
    number: entry.number || entry.fileName,
    rev: entry.revision,
    discipline: 'General',
    entities: 0,
    grounded: false,
    issues: 0,
    hasModel: false,
    panels: [],
    model: cached.model,
    svg: cached.svg,
    fileName: entry.fileName,
    extractLine: `${runs} text run${runs === 1 ? '' : 's'} indexed · 0 CAD entities`,
    sourceNote:
      'This sheet is a PDF page: a raster underlay plus a text index. It carries no CAD entities — ' +
      (entry.sheet.rasterDataUrl ? 'measure and schedule from the DXF.' : `and no raster either (${entry.sheet.rasterNote ?? 'rasterisation unavailable'}).`),
  };
  pdfStudioSheetCache.set(entry.id, sheet);
  return sheet;
}

// ------------------------------------------------------------
// the hook
// ------------------------------------------------------------

interface BbsRunState {
  running: boolean;
  progress: string[];
  stats: string | null;
  error: string | null;
  result: BbsChatResult | null;
  rows: ScheduleRow[] | null;
  version: string | null;
  /**
   * The fact ids that were usable when this schedule was built. Anything
   * usable that is NOT in here is an answer that arrived since — the signal
   * the tab offers a rebuild on (§6.3). Null before any run this session.
   */
  factBaseline: string[] | null;
  /** how many project facts the run was briefed with */
  factsUsed: number;
  /** how many open questions the run filed into the Specification */
  questionsFiled: number;
  /** the honest price of the last run, restated before a rebuild is spent */
  costLine: string | null;
  /** BBS lifecycle: STALE when dependant facts changed since last build */
  lifecycleStatus: 'STALE' | 'REBUILDING' | 'VALIDATED' | 'IDLE';
  /** build manifest of the held schedule, for staleness checking */
  manifest: import('../core/bbs/schemas').BBSBuildManifest | null;
}

/**
 * Which project the CAD session currently holds. Module-level for the same
 * reason the old boolean was: StrictMode mounts effects twice and two
 * concurrent restores interleave into duplicated sheets. Switching projects
 * clears the session and restores the new one — the audit rule: NOTHING
 * sheet-shaped survives a project switch (§1.2, §1.4).
 */
let restoredProjectId: string | null = null;

/** What one orchestrated run is asked for. Empty is the BBS tab's button. */
interface BbsRunRequest {
  /** SEAM 1 — the live interview, when there is a person in the loop (§7). */
  askUser?: AskUser;
  /** the chat's scope: "give me the BBS for the tie beam" */
  memberMark?: string;
  /** answers already given in this thread — they brief the run (§7.1) */
  priorAnswers?: readonly AnsweredQuestion[];
  /** Files deliberately attached to this chat request. */
  attachments?: readonly StudioChatAttachment[];
  /**
   * RECALCULATE, DO NOT RE-READ. A dependent fact changed (an answer, an
   * override, a withdrawal) and the schedule on screen is STALE. The saved
   * About Drawing conclusions are replayed, every row is rebuilt through
   * calculations/schedule.ts from the latest facts, the summary is rebuilt
   * and reconciled — and no model turn is spent. Open holes are still put to
   * the person when an interview is attached.
   */
  recalculateOnly?: boolean;
}

/**
 * A scoped ask reaches the run as the CLIENT'S OWN WORDS, which is what
 * `objective` is for — not as a filter applied to a finished schedule. The
 * whole drawing is still read; the objective says what the answer is for.
 */
const objectiveFor = (mark: string): string =>
  `Produce a complete bar bending schedule for this drawing. The client asked specifically about ${mark} — ` +
  'schedule it in full, and say plainly if it is not on this sheet.';

/**
 * The practice behind the figures, printed in the export header. These are
 * statements of what the engine did, not settings a caller can change here.
 */
const EXPORT_CONVENTIONS: readonly string[] = [
  'Bend deductions per IS 2502 Table 1; development length and laps per IS 456.',
  'Unit mass per IS 1786 nominal mass (d² ÷ 162 kg/m).',
  'Open rows carry no quantity — a blocked cell is EMPTY, never zero, and is in no total below.',
  'Values a person supplied are marked as supplied and quoted with the words they were given in.',
];

const BBS_IDLE: BbsRunState = {
  running: false,
  progress: [],
  stats: null,
  error: null,
  result: null,
  rows: null,
  version: null,
  factBaseline: null,
  factsUsed: 0,
  questionsFiled: 0,
  costLine: null,
  lifecycleStatus: 'IDLE',
  manifest: null,
};

export function useRealStudioData(store: StudioStore, notify: Notify, project: StudioProject): StudioData {
  // §1.2 — no default project. Every read below is scoped to THIS id.
  const projectId = project.id;
  if (!projectId) throw new Error('useRealStudioData needs a project — there is no default project.');

  const session = useCadSession();
  const register = useDrawingRegister(projectId);
  const artifacts = useProjectArtifacts(projectId);
  const userFolders = useProjectFolders(projectId);
  const shell = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const splitVersion = useSplitJobs();

  const [pdfEntries, setPdfEntries] = useState<PdfRegisterEntry[]>([]);
  const [packages, setPackages] = useState<DrawingUnderstandingPackage[]>([]);
  const [docHashes, setDocHashes] = useState<ReadonlyMap<string, string>>(new Map());
  const [bbs, setBbs] = useState<BbsRunState>(BBS_IDLE);
  const [askRun, setAskRun] = useState<AskRunState>({ running: false, progress: [], error: null, stats: null });
  const bbsRunning = useRef(false);
  const bbsInterview = useRef<InterviewSession | null>(null);
  /** bumped when a run's interview log is filed, so the panel can offer it */
  const [interviewLogVersion, setInterviewLogVersion] = useState(0);
  const [interviewLogs, setInterviewLogs] = useState<StoredInterviewLog[]>([]);
  const bbsInterviewUnsubscribe = useRef<(() => void) | null>(null);
  /**
   * Bumped whenever the BBS interview changes, and READ — not discarded.
   *
   * The value used to be thrown away (`const [, setBbsInterviewVersion]`),
   * which made this a pure re-render trigger. That is fine for anything read
   * during render, but the seam that carries the open questions is a `useMemo`,
   * and a memo cannot depend on a counter nobody named. It held whichever
   * batch of questions was open when some unrelated dependency last changed:
   * the session moved on, those ids were settled, and answering one came back
   * "no open question".
   */
  const [bbsInterviewVersion, setBbsInterviewVersion] = useState(0);

  // R4 — the per-project fact ledger, and R5 — its revision impact reports.
  const [ledger, setLedger] = useState<Ledger>(emptyLedger());
  const [ledgerLoaded, setLedgerLoaded] = useState(false);
  const ledgerRef = useRef<Ledger>(ledger);
  ledgerRef.current = ledger;
  const [impacts, setImpacts] = useState<RevisionImpactRecord[]>([]);
  const [showImpact, setShowImpact] = useState(false);

  // Per-project restore of everything persisted against it. The module-level
  // guard keeps StrictMode's double mount from interleaving two restores;
  // switching projects clears the CAD session first so no sheet, PDF page or
  // package from the previous project survives into this one.
  useEffect(() => {
    let alive = true;
    if (restoredProjectId !== projectId) {
      restoredProjectId = projectId;
      clearCadSession();
      // AND SHOW IT. Restoring the drawings put them back in the session and
      // then left the canvas empty: the register listed four drawings, the
      // viewport showed bare grid, and the only way to see anything was to
      // know to click one. A restored project opens on its drawing.
      //
      // Only when nothing is open — reopening a project mid-session must not
      // yank the sheet the person is on back to the first one.
      void restoreCadDrawing(projectId).then((doc) => {
        if (!alive || !doc) return;
        if (store.getState().sheets.active) return;
        const sheet = cadSheets().find((s) => s.doc.id === doc.id) ?? activeCadSheet();
        if (sheet) store.openSheet(sheet.id);
      });
    }
    setPdfEntries([]);
    setPackages([]);
    setDocHashes(new Map());
    setBbs(BBS_IDLE);
    setLedger(emptyLedger());
    setLedgerLoaded(false);
    setImpacts([]);
    setShowImpact(false);
    bbsInterview.current?.abandon('the project changed');
    bbsInterview.current = null;
    bbsInterviewUnsubscribe.current?.();
    bbsInterviewUnsubscribe.current = null;
    void loadPdfEntries(projectId).then((entries) => {
      if (alive && entries.length) setPdfEntries(entries);
    });
    void loadPackages(projectId).then((pkgs) => {
      if (alive) setPackages(pkgs);
    });
    void loadLedgerIdb(projectId).then((saved) => {
      if (alive) {
        setLedger(saved ?? emptyLedger());
        setLedgerLoaded(true);
      }
    });
    void loadImpacts(projectId).then((records) => {
      if (alive && records.length) setImpacts(records);
    });
    // §6.3 — what the last schedule was built knowing, so an answer given days
    // after the run still shows up as an answer the schedule has not used.
    void loadRunMemo(projectId).then((memo) => {
      if (alive && memo) {
        setBbs((prev) =>
          prev.factBaseline === null
            ? {
                ...prev,
                factBaseline: memo.factIds,
                costLine: memo.costLine,
                questionsFiled: memo.questionsFiled,
              }
            : prev,
        );
      }
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  // ---- the BIM model behind the project -----------------------------------
  //
  // The 22 drafting tools write BIM elements into THIS model and nowhere else
  // (EDITOR_TOOLS_NOTE §12 — the imported drawing stays an underlay). Without
  // it open the tools have nothing to draw into and say so; so it opens with
  // the project and closes with it, and never survives a project switch.
  useEffect(() => {
    let alive = true;
    void (async () => {
      let data: ProjectData | null = null;
      try {
        data = await repo.getProject(projectId);
      } catch {
        data = null; // storage unavailable — the model lives for the session
      }
      if (!alive) return;
      openEditorModel(
        data ?? {
          id: projectId,
          name: project.name,
          createdAt: project.createdAt,
          modifiedAt: project.modifiedAt,
          levels: [],
          elements: [],
          settings: { unit: 'mm', gridSpacing: 100, snapGrid: true, snapObjects: true },
        },
      );
    })();
    return () => {
      alive = false;
      closeEditorModel();
    };
    // `project` fields only seed a model that does not exist yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Debounced write-back: drawn geometry that vanishes on reload would be a
  // lie the strip tells. Failures are silent — the session still holds.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeModel(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const m = maybeModel();
        if (!m || m.id !== projectId) return;
        void repo.putProject(m.toJSON()).catch(() => undefined);
      }, 700);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [projectId]);

  const docHashesRef = useRef(docHashes);
  docHashesRef.current = docHashes;

  // Structural fingerprints for staleness (§3.1): a package whose hash no
  // longer matches its drawing is STALE and must say so, never silently used.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const additions = new Map<string, string>();
      for (const s of session.sheets) {
        if (docHashesRef.current.has(s.doc.id)) continue;
        try {
          additions.set(s.doc.id, await drawingHash(s.doc, null));
        } catch {
          additions.set(s.doc.id, '');
        }
      }
      if (alive && additions.size) {
        setDocHashes((prev) => {
          const next = new Map(prev);
          for (const [k, v] of additions) next.set(k, v);
          return next;
        });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.version, session.sheets, projectId]);

  const entries = register?.entries ?? [];
  const registerRef = useRef(register);
  registerRef.current = register;
  const sheetByDoc = useMemo(
    () => new Map(session.sheets.map((s) => [s.doc.id, s.id] as const)),
    [session.sheets, session.version],
  );
  const sheetByDocRef = useRef(sheetByDoc);
  sheetByDocRef.current = sheetByDoc;
  const packagesRef = useRef(packages);
  packagesRef.current = packages;
  const artifactsRef = useRef(artifacts);
  artifactsRef.current = artifacts;

  /**
   * The document the person is looking at, with a section sheet resolved back
   * to the drawing it was cut from — the same rule `openDrawingNumber` uses,
   * because a section is a view of a drawing and never a drawing of its own.
   */
  //
  // SPLITS THIS BROWSER HAS NOT SEEN.
  //
  // `loadPackages` reads IndexedDB and only IndexedDB, which is right — it is
  // the cache, and reading it is free. But a cache MISS was being treated as
  // an answer: a project opened on another machine, or after site data was
  // cleared, showed a register full of drawings and not one section folder,
  // because the packages sat in `drawing_sections` and nothing ever went and
  // got them.
  //
  // So every drawing on the register with no package in hand is asked about
  // once, and `restorePackage` rebuilds it from the rows and their stored
  // bodies. Once per document per session: `askedFor` remembers the ones that
  // came back empty too, because "this drawing has never been split" is a real
  // answer and re-asking it on every register change would be a request per
  // render.
  const askedFor = useRef(new Set<string>());
  useEffect(() => {
    askedFor.current.clear();
  }, [projectId]);

  useEffect(() => {
    if (!isSupabaseConfigured() || !entries.length) return;
    const missing = entries.filter(
      (e) =>
        !askedFor.current.has(e.documentId) &&
        !packagesRef.current.some((p) => p.documentId === e.documentId),
    );
    if (!missing.length) return;
    let alive = true;
    void (async () => {
      // Sequential: each one downloads its section bodies, and six drawings
      // firing at once would open a dozen parallel storage reads on a project
      // that is still rendering.
      for (const entry of missing) {
        askedFor.current.add(entry.documentId);
        const pkg = await restorePackage(projectId, entry.documentId).catch(() => null);
        if (!alive || !pkg) continue;
        setPackages((prev) =>
          prev.some((p) => p.documentId === pkg.documentId) ? prev : [pkg, ...prev],
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, entries]);

  const openDocumentId = useCallback((): string | null => {
    const activeId = store.getState().sheets.active;
    if (!activeId) return null;
    const section = parseSectionSheetId(activeId);
    if (section) return section.documentId;
    return cadSheets().find((s) => s.id === activeId)?.doc.id ?? null;
  }, [store]);

  // ---- R4: the ledger's one write path ------------------------------------

  const commitLedger = useCallback(
    async (next: Ledger): Promise<void> => {
      ledgerRef.current = next;
      setLedger(next);
      try {
        // The open document goes with the write. A fact READ off a sheet
        // carries its own `source.documentId` and does not need this; an
        // ANSWER carries none by design (§7.1 — an answer is not a reading),
        // and without this every user-supplied fact filed a null drawing.
        await saveLedgerIdb(projectId, next, { documentId: openDocumentId() });
      } catch {
        /* storage unavailable — the ledger holds for this session */
      }
    },
    [projectId, openDocumentId],
  );

  /**
   * The drawing number of the sheet that is open, resolved exactly as
   * `activeDrawingNumber` resolves it for the views — a section reads as the
   * drawing it was cut from, never as a drawing of its own.
   */
  const openDrawingNumber = useCallback((): string | undefined => {
    const activeId = store.getState().sheets.active;
    if (!activeId) return undefined;
    const section = parseSectionSheetId(activeId);
    const doc = section
      ? cadSheets().find((s) => s.doc.id === section.documentId)?.doc
      : cadSheets().find((s) => s.id === activeId)?.doc;
    if (!doc) return undefined;
    const entry = registerRef.current?.entries.find((e) => e.documentId === doc.id);
    return entry?.drawingNumber || doc.name || undefined;
  }, [store]);

  const answerFact = useCallback(
    async (id: string, value: string, saidAs?: string): Promise<void> => {
      const cur = resolveFact(ledgerRef.current, id);
      // A MEASUREMENT ANSWERED IN WORDS IS NOT AN ANSWER.
      //
      // `parseFactValue` keeps anything that is not a bare number as a STRING,
      // and a string-valued mm fact is skipped by projectFactsFromLedger
      // without a word — so "about 900" filed a fact that reads as answered on
      // the specification while the rows it feeds stay blocked, with nothing
      // anywhere saying why. The interview's own guard is applied here so both
      // doors into the ledger hold the same line.
      const expectsNumber = cur?.unit === 'mm' || typeof cur?.value === 'number';
      const bad = expectsNumber ? numbersOnly(value) : null;
      if (bad) {
        notify(bad, 'warn');
        return;
      }
      // AN ANSWER KEEPS THE FACT'S PLACEMENT.
      //
      // Without this the answer landed with no `source` and no `lookedIn`, and
      // `factOnDrawing` shows an unplaceable fact on EVERY drawing — so
      // answering c1.height on the columns sheet put it in the pedestal
      // sheet's specification too, chipped "not tied to a drawing" over a fact
      // that had been tied to one until the moment it was answered. The
      // interview path has recorded this since §7.1; this door had not.
      const lookedIn = answerPlacement(cur, openDrawingNumber());
      const fact: Fact = {
        id,
        value: parseFactValue(value),
        ...(cur?.unit !== undefined ? { unit: cur.unit } : {}),
        state: 'SUPPLIED',
        ...(cur?.neededFor !== undefined ? { neededFor: cur.neededFor } : {}),
        ...(lookedIn ? { lookedIn } : {}),
        suppliedBy: 'you',
        saidAs: saidAs ?? value,
        readOn: new Date().toISOString().slice(0, 10),
      };
      const res = recordFact(ledgerRef.current, fact);
      await commitLedger(res.ledger);
      if (!res.accepted) {
        notify(res.reason ?? 'The answer was recorded but did not replace the current value.', 'warn');
      } else {
        notify(`${id} answered — recorded as supplied.`, 'ok');
      }
    },
    [commitLedger, notify, openDrawingNumber],
  );

  const overrideFactAction = useCallback(
    async (id: string, value: string): Promise<void> => {
      const askedOn = openDrawingNumber();
      const next = overrideFact(ledgerRef.current, id, {
        value: parseFactValue(value),
        suppliedBy: 'you',
        ...(askedOn ? { askedOn } : {}),
      });
      await commitLedger(next);
      notify(`${id} overridden — what the drawing said stays in history.`, 'ok');
    },
    [commitLedger, notify, openDrawingNumber],
  );

  const withdrawFactAction = useCallback(
    async (id: string): Promise<void> => {
      const res = withdrawFact(ledgerRef.current, id);
      if (!res.withdrawn) {
        notify('Only supplied answers can be withdrawn — disagreeing with a reading is an override.', 'warn');
        return;
      }
      await commitLedger(res.ledger);
      notify(
        res.staleDependents.length
          ? `${id} withdrawn — ${res.staleDependents.length} derived fact${res.staleDependents.length === 1 ? '' : 's'} marked stale: ${res.staleDependents.join(', ')}.`
          : `${id} withdrawn — it blocks again until answered.`,
        'ok',
      );
    },
    [commitLedger, notify],
  );

  const exportSpecCsv = useCallback((): void => {
    const csv = specificationCsv(ledgerRef.current);
    try {
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/[^a-z0-9_-]+/gi, '_')}-specification.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
      notify('Specification exported — provenance columns intact.', 'ok');
    } catch {
      notify('Export failed — the browser refused the download.', 'warn');
    }
  }, [project.name, notify]);

  // ---- R4a: a provenance chain segment resolves to a location -------------

  const openFactSource = useCallback(
    (source: FactSource, level: SourceLevel): void => {
      const regEntries = registerRef.current?.entries ?? [];
      const entry =
        (source.documentId
          ? regEntries.find((e) => e.documentId === source.documentId)
          : undefined) ??
        regEntries.find(
          (e) =>
            e.drawingNumber === source.drawingNumber &&
            (!source.revision || e.revision === source.revision),
        ) ??
        regEntries.find((e) => e.drawingNumber === source.drawingNumber);
      const docId = source.documentId ?? entry?.documentId;
      const sheetId = docId ? sheetByDocRef.current.get(docId) : undefined;
      if (!sheetId) {
        notify(
          `${source.drawingNumber || 'That drawing'}${source.revision ? ` ${source.revision}` : ''} is filed but not loaded in this session.`,
          'warn',
        );
        return;
      }
      if (level === 'drawing') {
        store.openSheet(sheetId);
        return;
      }
      const pkg = docId ? packagesRef.current.find((p) => p.documentId === docId) : undefined;
      const section =
        source.sectionId && pkg
          ? pkg.sections.find((s) => s.sectionId === source.sectionId)
          : undefined;
      if (level === 'section') {
        if (section) store.focusOn(sheetId, section.bounds);
        else {
          store.openSheet(sheetId);
          notify(`${source.sectionId ?? 'That section'} is not in this drawing's current split.`, 'warn');
        }
        return;
      }
      // handles — open, zoom to the section when known, light the entities amber
      store.openSheet(sheetId);
      if (section) store.focusOn(sheetId, section.bounds);
      store.setSelection({ handles: source.handles ?? [], source: 'schedule' });
    },
    [store, notify],
  );

  // ---- R6: the project index + palette navigation -------------------------

  const projectIndex = useMemo<ProjectIndex>(() => {
    // Trimmed packages (fixtures, old exports) may lack hint arrays the
    // indexer maps over — fill the defaults before handing them across.
    const safePackages = packages.map((p) => ({
      ...p,
      sections: p.sections.map((s) => ({
        ...s,
        memberHints: s.memberHints ?? [],
        calloutHints: s.calloutHints ?? [],
      })),
    }));
    const marks = session.sheets.map((s) => {
      const ex = extractFor(s.doc);
      return {
        documentId: s.doc.id,
        marks: ex?.marks ?? [],
        callouts: ex?.callouts ?? [],
      };
    });
    return buildProjectIndex({
      registerEntries: entries,
      sections: safePackages,
      ledger,
      marks,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, packages, ledger, session.sheets, session.version]);

  const searchProject = useCallback(
    (q: string): SearchHit[] => search(projectIndex, q, { limit: 40 }),
    [projectIndex],
  );

  const goToHit = useCallback(
    (hit: SearchHit): void => {
      switch (hit.kind) {
        case 'drawing': {
          const sheetId = sheetByDocRef.current.get(hit.documentId);
          if (sheetId) store.openSheet(sheetId);
          else notify(`${hit.drawingNumber} is filed but not loaded in this session.`, 'warn');
          return;
        }
        case 'section': {
          const parentSheet = sheetByDocRef.current.get(hit.parentDocumentId);
          const pkg = packagesRef.current.find((p) => p.documentId === hit.parentDocumentId);
          const known = pkg?.sections.some((s) => s.sectionId === hit.sectionId) ?? false;
          if (parentSheet && known) {
            store.openSheet(sectionSheetId(hit.parentDocumentId, hit.sectionId));
          } else if (parentSheet) {
            store.focusOn(parentSheet, hit.bounds);
          } else {
            notify(`${hit.sectionId}'s drawing is not loaded in this session.`, 'warn');
          }
          return;
        }
        case 'fact': {
          store.revealFact(hit.factId);
          return;
        }
        case 'mark': {
          const sheetId = sheetByDocRef.current.get(hit.documentId);
          if (!sheetId) {
            notify(`The drawing carrying "${hit.text}" is not loaded in this session.`, 'warn');
            return;
          }
          store.openSheet(sheetId);
          store.setSelection({
            handles: hit.handles,
            memberId: hit.matchedOn === 'mark' ? hit.text : null,
            source: 'canvas',
          });
          return;
        }
      }
    },
    [store, notify],
  );

  // ---- import: one picker, three pipelines --------------------------------

  const importPicked = useCallback(
    async (file: File) => {
      const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
      const isPdf =
        (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) ||
        /\.pdf$/i.test(file.name);
      // AN IMPORT LANDS WHERE THE PERSON IS STANDING.
      //
      // The discipline folders are the register's own shape, so "import into
      // Structural" is a statement about the file's discipline — recorded as
      // theirs, with the authority a typed correction has. Only while the
      // browser has the stage: a path left behind by an earlier visit is not
      // a place anyone is pointing at.
      //
      // Standing inside a folder a PERSON made ("demo", "WH-4 package") is a
      // different statement: that folder is not a discipline and importing
      // into it must not silently recolour the drawing General/Structural
      // out from under them, so this side files the import as a SECOND
      // membership (same as an explicit "File into") rather than touching
      // `intoDiscipline` at all.
      const shellNow = store.getState();
      const currentFolderId =
        shellNow.ui.stageMode === 'files'
          ? shellNow.browse.path[shellNow.browse.path.length - 1]
          : undefined;
      const intoDiscipline = disciplineOfFolderId(currentFolderId);
      const intoUserFolder = currentFolderId
        ? userFolders.find((f) => f.id === currentFolderId)
        : undefined;
      try {
        if (isPdf) {
          notify(`Reading ${file.name}…`);
          const bytes = await file.arrayBuffer();
          const res = await importPdf(bytes, { fileName: file.name });
          const now = Date.now();
          const added: PdfRegisterEntry[] = res.sheets.map((sheet) => {
            const identity = identityFromPdfTexts(sheet.texts, file.name);
            // The folder they imported into wins. Failing that, the page is
            // read the same way a DXF's title block is — its own number and
            // title, then its text — rather than defaulting to General.
            const discipline =
              intoDiscipline ??
              inferDiscipline(
                `${identity.drawingNumber ?? ''} ${file.name}`,
                `${identity.title ?? ''} ${sheet.texts.map((t) => t.text).join(' ')}`,
              );
            return {
              id: newId('pdf'),
              fileName: file.name,
              pageIndex: sheet.pageIndex,
              pageCount: res.sheets.length,
              number: identity.drawingNumber ?? '',
              title: identity.title ?? '',
              revision: identity.revision ?? '',
              importedAt: now,
              discipline,
              sheet,
            };
          });
          setPdfEntries((prev) => {
            const next = [...prev, ...added];
            void persistPdfEntries(projectId, next);
            return next;
          });
          if (intoUserFolder) {
            // A multi-page PDF files as its ONE Pages/ folder — the same node
            // `buildGroups` puts at top level for it — never one membership
            // per page, which `nodeById` (the id a user folder resolves
            // through) does not index individually once pages are grouped.
            if (added.length > 1) {
              setFolderMembership(projectId, intoUserFolder.id, pdfPagesFolderId(now), true);
            } else if (added.length === 1) {
              setFolderMembership(projectId, intoUserFolder.id, added[0].id, true);
            }
          }
          if (added.length) store.openSheet(added[0].id);
          notify(
            `Filed ${added.length} PDF page${added.length === 1 ? '' : 's'} into the register — raster underlay + text index, no CAD entities.`,
            'ok',
          );
          return;
        }

        // DXF / DWG — routed by magic bytes inside readCadDrawing.
        const picked = await readCadDrawing(file, { onStatus: (m) => notify(m) });
        // R5 §5.1 — snapshot the register BEFORE the import files anything, so
        // a revision (same number, different revision) is detectable after.
        const preEntries = registerRef.current?.entries ?? [];
        const result = await importCadDrawing(projectId, picked.name, picked.text, {
          sourceBytes: picked.sourceBytes,
          convertedFromDwg: picked.convertedFromDwg,
        });
        let registration = result.registration;
        if (!registration) {
          // Persistence failed (quota, no IndexedDB) so importCadDrawing never
          // reached the register. The drawing is still open — file its identity
          // in the in-memory register too, so the tree tells the truth about
          // what is loaded; registerDrawing tolerates unavailable storage.
          try {
            registration = await registerDrawing(
              projectId,
              result.doc,
              picked.name,
              `transient:${result.doc.id}`,
              // The hash travels even down the degraded path: an entry filed
              // without it is one the next upload of the same file cannot
              // recognise, and the duplicate would be filed all over again.
              result.contentHash,
            );
          } catch {
            /* identity extraction failed — the warning below already reports */
          }
        }
        // Imported INTO a discipline folder: that is the person saying where
        // this belongs, so it is filed as theirs — `updateDrawingEntry` records
        // it with the same authority as a typed correction, evidence and all,
        // and the classifier's guess stays in the history behind it.
        if (registration && intoDiscipline && registration.discipline !== intoDiscipline) {
          await updateDrawingEntry(registration.id, {
            discipline: intoDiscipline as DrawingRegisterEntry['discipline'],
          });
        }
        // IMPORTED INTO A FOLDER SOMEONE MADE: it is filed there.
        //
        // Filed under the DOCUMENT id, not the register entry's: the entry id
        // is minted on this machine and a membership stored under it resolves
        // nowhere else, so the folder came back empty on a second browser.
        //
        // And filed WITHOUT touching the discipline. Standing in "demofolder"
        // says where this drawing belongs in someone's filing; it says nothing
        // about whether the sheet is structural, and the classifier's reading
        // of the title block is not a person's to overwrite by accident.
        if (registration && intoUserFolder) {
          setFolderMembership(projectId, intoUserFolder.id, registration.documentId, true);
        }

        // THE FILE, NOT ONLY ITS METADATA.
        //
        // `registerDrawing` files the row. Without this the row named a
        // `storage_path` of null and the drawing existed nowhere but the
        // browser it was imported in: open the project on another machine and
        // the register listed a sheet that could not be opened. The bytes go
        // to the private bucket under `<user>/<project>/<drawing>/`, which is
        // the path the bucket policy checks against `auth.uid()`.
        //
        // Not fatal. A drawing that is parsed, registered and on screen is
        // more use than an import aborted because the upload timed out — the
        // row is already there and a re-import fills the file in.
        if (registration && isSupabaseConfigured()) {
          const rowId = remoteDrawingIdFor(registration.documentId);
          if (rowId) {
            try {
              await uploadDrawingFile(
                projectId,
                rowId,
                picked.name,
                picked.sourceBytes,
                picked.convertedFromDwg ? 'image/vnd.dwg' : 'application/dxf',
              );
              await setDrawingStatus(rowId, 'UPLOADED');
            } catch (err) {
              notify(
                `${picked.name} is registered but its file is not stored yet — ${err instanceof Error ? err.message : String(err)}`,
                'warn',
              );
            }
          }
        }

        // R3 §3.1 — import QUEUES the split job. It does not run it: the job
        // runs when this drawing is opened (which the import is about to do)
        // or when Split / Split all is pressed. Re-import of identical bytes
        // finds the saved package and never spends a model call.
        queueSplit(projectId, result.doc.id);

        // R5 §5.2 — the import was a REVISION when its identity matches an
        // entry that was current and its revision differs. The register has
        // already superseded the old sheet; here the LEDGER catches up: every
        // fact sourced from this drawing is re-run through applyRevisionFacts
        // (nothing re-read yet, so readings the new sheet has not answered
        // become MISSING with an ask; supplied answers survive; derived facts
        // go stale) and the §5.4 impact report is filed.
        if (registration) {
          const reg = registration;
          const prev = preEntries.find(
            (e) =>
              e.identityKey === reg.identityKey &&
              e.documentId !== reg.documentId &&
              e.revisionState === 'current',
          );
          if (prev && prev.revision && reg.revision && prev.revision !== reg.revision) {
            const { ledger: nextLedger, impact } = applyRevisionFacts(ledgerRef.current, {
              drawingNumber: reg.drawingNumber || prev.drawingNumber,
              oldRevision: prev.revision,
              newRevision: reg.revision,
              newFacts: [],
            });
            await commitLedger(nextLedger);
            const record: RevisionImpactRecord = {
              id: newId('revimpact'),
              createdAt: Date.now(),
              impact,
            };
            setImpacts((prevList) => {
              const next = [record, ...prevList];
              void persistImpacts(projectId, next);
              return next;
            });
            setShowImpact(true);
            notify(
              `${impact.drawing} ${impact.from} → ${impact.to} — revision impact report filed in the Specification.`,
              'ok',
            );
          }
        }

        const opened = activeCadSheet();
        if (opened) store.openSheet(opened.id);
        const name = registration?.originalFileName ?? picked.name;
        if (result.warning) notify(result.warning, 'warn');
        // Nothing was filed and nothing was versioned — say that, rather than
        // reporting an import. Claiming "filed in the register" for a file the
        // register already held is how a person ends up hunting for a second
        // row that was never going to appear.
        if (result.duplicateOf) {
          notify(
            `${name} is already on file — opened the copy the register holds. Re-uploading the same file does not create a version.`,
            'ok',
          );
          return;
        }
        notify(
          `${name} filed in the register — ${result.doc.entities.length.toLocaleString('en-IN')} entities${picked.convertedFromDwg ? ' (converted from DWG)' : ''}.`,
          'ok',
        );
      } catch (err) {
        // DwgError messages are already fit to show verbatim (service down,
        // CORS, truncated file); everything else is reported as-is too.
        const message =
          err instanceof DwgError || err instanceof Error ? err.message : String(err);
        notify(message, 'warn');
      }
    },
    [notify, store, projectId, commitLedger, userFolders],
  );

  const importDrawing = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.dxf,.dwg,.pdf';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void importPicked(file);
    };
    input.click();
  }, [importPicked]);

  // ---- BBS: the orchestrated engine, on explicit user action only ---------

  const activeCad = session.sheets.find((s) => s.id === shell.sheets.active) ?? null;
  const activePdf = pdfEntries.find((p) => p.id === shell.sheets.active) ?? null;

  let bbsBlocked: string | null = null;
  if (bbs.running) bbsBlocked = null;
  else if (activePdf) {
    bbsBlocked =
      'The active sheet is a PDF page — a raster and a text index, not geometry. The BBS engine reads DXF entities; import the DXF of this drawing and run it there.';
  } else if (!activeCad) {
    bbsBlocked = 'Open a DXF drawing from the register first — the schedule is read off the open sheet.';
  } else if (!isAiConfigured()) {
    bbsBlocked =
      'No OpenRouter key found. Set VITE_OPENROUTER_API_KEY=sk-or-… in .env at the project root and restart the dev server. (A key pasted into localStorage under "bimcad.openrouter.key" also works.)';
  }

  // THE READING GATE.
  //
  // Splitting, the second-pass residual read and validation all existed as
  // OPTIONAL actions beside a Calculate BBS button that consulted none of
  // them. A schedule could therefore be built over a drawing whose sections
  // had never been cut, or one with a fifth of its geometry outside every
  // section box that nobody had looked at. Steel no section carries is steel
  // the schedule cannot see, and a total missing it looks exactly like a
  // correct one.
  //
  // Checked after the conditions above so the more basic refusals (no sheet,
  // no key) still speak first — being told to read the leftovers of a drawing
  // that is not open helps nobody.
  const bbsReadiness = activeCad
    ? drawingReadiness({
        pkg: packages.find((p) => p.documentId === activeCad.doc.id) ?? null,
        jobStatus: splitJobFor(activeCad.doc.id)?.status ?? null,
        currentHash: docHashes.get(activeCad.doc.id) ?? null,
      })
    : null;
  if (!bbsBlocked && !bbs.running && bbsReadiness && !bbsReadiness.ok) {
    // A refusal with no way out of it is a dead end. The remedy names the
    // control that clears this exact block, so the message a person is stopped
    // by and the button that unblocks them are never a search apart.
    const WHERE: Record<string, string> = {
      split: ' Split it from the Sections panel.',
      'second-pass': ' Read the leftovers from the Sections panel.',
      wait: '',
    };
    bbsBlocked =
      bbsReadiness.reason +
      (bbsReadiness.unread.length ? ` Not read: ${bbsReadiness.unread.join('; ')}.` : '') +
      (bbsReadiness.remedy ? WHERE[bbsReadiness.remedy] ?? '' : '');
  }

  /**
   * One orchestrated run over the active sheet.
   *
   * `askUser` is §7's live interview (see the seam note below): when the Ask
   * tab supplies it, the engine's questions are put to a person mid-run
   * instead of being filed for the next one. `memberMark` is the chat's scope
   * — "give me the BBS for the tie beam" — and reaches the run as the
   * client's own objective, never as a filter applied after the fact.
   */
  const startBbsRun = useCallback(
    (opts: BbsRunRequest = {}): Promise<BbsChatResult> => {
    const active = cadSheets().find((s) => s.id === store.getState().sheets.active);
    if (!active) return Promise.reject(new Error('No DXF sheet is open.'));
    if (bbsRunning.current) return Promise.reject(new Error('A run is already in progress.'));
    if (!isAiConfigured()) return Promise.reject(new Error('No OpenRouter key is configured.'));
    bbsRunning.current = true;
    // A new run supersedes whatever version was pinned open — otherwise the
    // schedule finishes and the panel keeps showing the old one.
    store.openArtifact(null);
    const doc = active.doc;
    const startedAt = Date.now();
    const spend: Spend = { calls: 0, costUsd: 0 };
    const push = (line: string) =>
      setBbs((prev) => ({ ...prev, progress: [...prev.progress, line].slice(-500) }));
    setBbs({ ...BBS_IDLE, running: true, lifecycleStatus: 'REBUILDING', progress: ['extracting the drawing (deterministic, no model call)…'] });

    return (async () => {
      try {
        const extract = extractFor(doc);
        if (!extract) throw new Error('The drawing could not be read deterministically — see the console.');
        const graph = graphFor(doc);
        push(
          `${extract.callouts.length} callouts · ${extract.marks.length} marks · ${graph?.dimensions.length ?? 0} readable dimensions · ${extract.tables.length} tables`,
        );

        // Split once, use many times. A BBS run consumes only a package whose
        // fingerprint still matches the active drawing; a stale split is
        // reported and ignored rather than becoming evidence for a new sheet.
        const currentHash = await drawingHash(doc, null);

        // THE DRAWING GETS A ROW BEFORE ANYTHING IS READ FROM IT.
        //
        // Facts and schedule rows both point at a drawing, and the hash is
        // what says WHICH VERSION of it they were read from. Filing it first
        // means every fact this run records can carry that pointer, rather
        // than being attached afterwards to whichever drawing happens to be
        // open. `status: READING` is honest for the interval this takes.
        if (isSupabaseConfigured()) {
          const registerEntry = entries.find((e) => e.documentId === doc.id);
          if (registerEntry) {
            try {
              await syncDrawing(projectId, registerEntry, { drawingHash: currentHash, status: 'READING' });
            } catch (err) {
              push(`drawing not filed in the database: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        const savedPackage = packagesRef.current.find((p) => p.documentId === doc.id) ?? null;
        const packageStatus = savedPackage ? stalenessOf(savedPackage, currentHash) : null;
        const currentPackage = packageStatus && !packageStatus.stale ? packageStatus.package : null;

        // The gate again, at the door the work actually goes through.
        //
        // `bbsBlocked` disables the button, which is where a person meets it —
        // but the seam is callable from the chat and from a command, and a
        // guard that only lives in a disabled button is not a guard. It is
        // re-derived here from the same function rather than trusted from the
        // render, so the two can never drift apart.
        const readiness = drawingReadiness({
          pkg: savedPackage,
          jobStatus: splitJobFor(doc.id)?.status ?? null,
          currentHash,
        });
        if (!readiness.ok) {
          throw new Error(
            readiness.reason +
              (readiness.unread.length ? ` Not read: ${readiness.unread.join('; ')}.` : ''),
          );
        }
        if (currentPackage) {
          push(
            `loaded the saved drawing split — ${currentPackage.sections.length} section${currentPackage.sections.length === 1 ? '' : 's'}, ` +
              `${currentPackage.coverage.coveredEntities}/${currentPackage.coverage.measurableEntities} measurable entities covered.`,
          );
        } else if (packageStatus?.stale) {
          push(`saved sections were not used: ${packageStatus.reason ?? 'the drawing changed since they were cut'}`);
        } else {
          push('no saved section package is available — continuing from the whole DXF without silently spending another split.');
        }

        const about = artifactsRef.current
          .filter((a) => a.documentId === doc.id && a.kind === 'about' && a.mimeType === 'application/json')
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((a) => parseAboutDrawingMemory(a.content))
          .find((m) => m !== null && m.sourceDrawingHash === currentHash) ?? null;
        if (about) {
          push(
            `loaded About Drawing memory — ${about.conclusions.length} evidence conclusion${about.conclusions.length === 1 ? '' : 's'} ` +
              `and ${about.sectionNotes.length} section note${about.sectionNotes.length === 1 ? '' : 's'} will be revalidated.`,
          );
        }

        // THE DRAWING READER'S OWN FACTS GO INTO MEMORY FIRST.
        //
        // A schedule table that names a member and states its size is the
        // sheet declaring that dimension — the latest validated DRAWING_READ
        // fact for it. Filed as DECLARED facts with the table, row and column
        // as their source, so the Specification carries F8.width = 3200 from
        // "FOOTING SCHEDULE row F8, column W SIZE" and the BBS input
        // resolution reads it from the same record it reads answers from.
        // The ledger's trust rule applies: DECLARED outranks a SUPPLIED guess
        // at the same id, and a MISSING question filed by an earlier run is
        // answered by the drawing itself.
        {
          const fromTables = memberFactsFromTables(extract);
          const entryT = entries.find((e) => e.documentId === doc.id);
          let next = ledgerRef.current;
          let filedFromTables = 0;
          for (const d of fromTables.dims) {
            const cur = resolveFact(next, d.factId);
            if (cur && isUsable(cur) && cur.state !== 'SUPPLIED' && cur.value === d.mm) continue;
            const res = recordFact(next, {
              id: d.factId,
              value: d.mm,
              unit: 'mm',
              state: 'DECLARED',
              source: {
                drawingNumber: entryT?.drawingNumber || doc.name,
                revision: entryT?.revision ?? '',
                documentId: doc.id,
                handles: d.handles.slice(0, 40),
                rawText: `${d.table} — ${d.column}: ${d.saidAs}`,
              },
              evidence: d.handles.slice(0, 40),
              method: d.source,
              saidAs: d.saidAs,
              sourceDrawingHash: currentHash,
              readOn: new Date().toISOString().slice(0, 10),
            });
            if (res.accepted) {
              next = res.ledger;
              filedFromTables += 1;
            }
          }
          if (next !== ledgerRef.current) {
            await commitLedger(next);
            push(
              `${filedFromTables} member dimension${filedFromTables === 1 ? '' : 's'} read from the sheet's schedule ` +
                `table${extract.tables.length === 1 ? '' : 's'} filed as DRAWING_READ facts: ${fromTables.dims
                  .map((d) => `${d.factId}=${d.mm}`)
                  .join(', ')}`,
            );
          }
          for (const note of fromTables.notes) push(`schedule table: ${note}`);
        }

        // §6.3 — THE RUN BEGINS FROM MEMORY. Every fact the project has that a
        // dimension can be read from goes in as a project fact, and the
        // objective names the axis-to-fact map (the shape that made the live
        // run point at the client's answers instead of asking again). Without
        // this the briefing says "PROJECT RUN: none was supplied" and a wall
        // whose length is already on file is scheduled as nothing.
        const ledgerNow = ledgerRef.current;
        const baseline = usableFactIds(ledgerNow);
        const { facts: ledgerFacts, used } = projectFactsFromLedger(ledgerNow);
        // §7.1 — answers already given in this thread ride into the run
        // alongside the ledger's, so a re-ask after answering is a run WITH
        // the answer rather than a run that asks for it again.
        const answerFacts = projectFactsFromAnswers(opts.priorAnswers ?? []);
        const projectFacts = { ...ledgerFacts, ...answerFacts };
        push(
          used.length
            ? `briefing the run with ${used.length} project fact${used.length === 1 ? '' : 's'} from the specification: ${used
                .map((u) => `${u.engineKey}=${u.mm}`)
                .join(', ')}`
            : 'no usable project facts on the specification yet — anything the sheet does not dimension will come back as an open question.',
        );
        const answerKeys = Object.keys(answerFacts);
        if (answerKeys.length) {
          push(
            `and ${answerKeys.length} answer${answerKeys.length === 1 ? '' : 's'} from this conversation: ${answerKeys
              .map((k) => `${k}=${answerFacts[k].mm}`)
              .join(', ')}`,
          );
        }
        // What the person said about HOW to compute — cover, grades, wastage,
        // the lap multiple. These are not dimensions, so they never rode in
        // with the facts above, and the run computed at DEFAULT_SETTINGS while
        // the chat reported them as applied.
        const { settings: userSettings, used: settingsUsed } = settingsFromLedger(ledgerNow);
        // Defaults < what the sheet states < what the person states — and
        // WHICH of the three it was, per setting, so the ones nobody supplied
        // can be asked about after the run instead of passing as readings.
        const resolvedSettings = resolveSettings(extract, userSettings);
        // Figures a person typed for one BAR — a cutting length the drawing
        // declared an input and never stated. They replace a derivation rather
        // than feeding one, so they travel as overrides, not project facts.
        const barOverrides = overridesFromLedger(ledgerNow);
        if (barOverrides.used.length) {
          push(
            `and ${barOverrides.used.length} cutting length${barOverrides.used.length === 1 ? '' : 's'} ` +
              `you gave: ${barOverrides.used.join(', ')} — used as entered, not derived.`,
          );
        }
        if (settingsUsed.length) {
          push(
            `computing with ${settingsUsed.length} setting${settingsUsed.length === 1 ? '' : 's'} you stated: ${Object.entries(
              userSettings,
            )
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')}`,
          );
        }
        push('handing over to the orchestrator — it plans its own work from here.');
        // integration seam: `askUser` is SEAM 1 of src/interview/index.ts and
        // does not exist on OrchestrateOptions yet — Agent EXTENT-GUARD is
        // adding it. It is passed through a locally widened type so this side
        // typechecks TODAY and starts putting questions to the person in the
        // chat the moment the engine honours the field. Nothing else changes
        // here when it lands.
        const orchestrateOptions: OrchestrateOptions & { askUser?: AskUser } = {
          doc,
          extract,
          objective: bbsObjective(used, opts.memberMark ? objectiveFor(opts.memberMark) : undefined),
          projectFacts,
          // Defaults < what the sheet states < what the person states. Passing
          // nothing here used to hand the engine DEFAULT_SETTINGS as the
          // caller's word, which put the defaults back on top of the drawing's
          // own notes (see settingsFromExtract in cad/bbs/build.ts).
          ...(Object.keys(userSettings).length ? { settings: userSettings } : {}),
          ...(Object.keys(barOverrides.bars).length
            ? { overrides: { members: {}, bars: barOverrides.bars } }
            : {}),
          ...(currentPackage
            ? {
                sections: packageSectionEvidence(currentPackage),
                sectionSummary: currentPackage.summary,
                sectionRelationships: packageRelationships(currentPackage),
              }
            : {}),
          ...(about
            ? {
                aboutDrawing: aboutDrawingBriefing(about),
                priorConclusions: about.conclusions,
              }
            : {}),
          ...(opts.attachments?.length
            ? {
                supplementalEvidence: opts.attachments
                  .filter((attachment) => attachment.text?.trim())
                  .map((attachment) => ({ name: attachment.name, text: attachment.text! })),
                supplementalImages: opts.attachments
                  .filter((attachment) => attachment.kind === 'image')
                  .map((attachment) => ({ dataUrl: attachment.dataUrl, caption: `User attachment — ${attachment.name}` })),
              }
            : {}),
          ...(opts.askUser ? { askUser: opts.askUser } : {}),
          // A recalculation replays the saved reading and spends no model
          // turn: zero orchestrator turns, zero AI calls, no judge. Every row
          // is still rebuilt from the latest facts and every hole still asked.
          independentJudge: !opts.recalculateOnly,
          ask: makeAsk(spend, push),
          rasterise,
          limits: opts.recalculateOnly
            ? {
                maxOrchestratorTurns: 0,
                maxTasks: 0,
                maxAiCalls: 0,
                maxMs: 2 * 60 * 1000,
                maxBuilds: 6,
                taskConcurrency: 1,
              }
            : {
                maxOrchestratorTurns: 10,
                maxTasks: 30,
                maxAiCalls: 60,
                maxMs: 20 * 60 * 1000,
                maxBuilds: 3,
                taskConcurrency: 3,
              },
          onEvent: (e) =>
            push(`${e.kind}${e.turn !== undefined ? ` turn ${e.turn}` : ''}${e.taskId ? ` ${e.taskId}` : ''}: ${e.detail}`),
        };
        const out = await runOrchestrator(orchestrateOptions);

        // PRINTED BEFORE THE SCHEDULE IS RETURNED — the drawing, its hash,
        // the fact version, and how many rows computed, are blocked, are
        // waiting on which facts, and whether the rows reconcile with the
        // steel summary. A schedule is not handed over without this.
        push('— schedule snapshot —');
        for (const l of out.snapshot) push(`  ${l}`);
        for (const l of out.unresolved.filter((u) => /^(dimension|axis) override:/.test(u))) push(`  ${l}`);

        // THE FACTS, BEFORE THE SCHEDULE.
        //
        // Printed in full, each with its origin, because a finished table
        // cannot be checked against inputs it has already spent — a dropped
        // bar count and a cover nobody stated both produce rows that look
        // exactly like read ones.
        if (out.factSheet) {
          push('the facts this schedule was built from —');
          for (const l of factSheetLines(out.factSheet)) push(`  ${l}`);
          if (out.factSheet.open.length) {
            push(
              `${out.factSheet.open.length} of them are NOT established: ` +
                `${out.factSheet.open.map((l) => l.label).join(', ')}. ` +
                'Every row resting on one of these is open, and the schedule is not final until they are answered.',
            );
          }
        }

        // THE INPUTS TRAVEL WITH THE RESULT. Every fact id a row read is
        // resolved against the record as it stands now — value, source type,
        // version, source text, entity handles — so the filed schedule and
        // its export can say what each figure rests on without the ledger.
        {
          const ids = new Set<string>();
          for (const r of out.result.rows) for (const id of r.trace?.factsUsed ?? []) ids.add(id);
          out.result.inputFacts = dataFactsOf(ledgerRef.current, { drawingId: doc.id, drawingHash: currentHash }, [...ids]);
        }

        // §22 — DRIFT. The stored schedule (the previous run for this drawing)
        // is re-read against the fresh pass, field by field. A difference is
        // shown as DRIFT and takes FINAL away; it is never absorbed. Only a run
        // of the SAME drawing is compared — a changed drawing is a new schedule.
        try {
          const stored = isSupabaseConfigured() ? await currentRun(doc.id) : null;
          if (stored?.result?.rows?.length && stored.drawingHash === currentHash) {
            const asRow = (r: BbsChatRow): BbsRow =>
              ({
                barMark: r.barMark,
                memberMark: r.memberMark,
                diaMm: r.diameterMm,
                spacingMm: r.spacingMm,
                barsPerMember: r.barsPerMember ?? null,
                cuttingLengthMm: r.cuttingLengthMm ?? null,
                totalBars: r.totalBars ?? null,
                totalLengthM: r.totalLengthM ?? null,
                weightKg: r.totalWeightKg ?? null,
                weightWithWastageKg: r.weightWithWastageKg ?? null,
              }) as unknown as BbsRow;
            const drift = reconcileRows(stored.result.rows.map(asRow), out.result.rows.map(asRow));
            out.result.rowDrift = drift;
            if (drift.length && out.result.validation) {
              const marks = [...new Set(drift.map((d) => d.barMark))];
              out.result.validation = {
                ...out.result.validation,
                final: false,
                blockers: [...out.result.validation.blockers, `DRIFT — stored and recalculated values differ on: ${marks.join(', ')}`],
              };
              push(`DRIFT: ${drift.length} field(s) differ from the stored schedule on ${marks.join(', ')} — shown, not absorbed.`);
            }
          }
        } catch (err) {
          push(`drift check skipped: ${(err as Error).message}`);
        }

        const rows = adaptChatRows(out.result, graph);
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        const netT = out.result.netWeightKg === undefined ? '—' : `${(out.result.netWeightKg / 1000).toFixed(3)} t`;
        const stats =
          `${out.result.status} · ${rows.length} rows · net ${netT} · ${out.turns} turns · ` +
          `${spend.calls} calls · $${spend.costUsd.toFixed(4)} · ${elapsed}s · stopped: ${out.stoppedBecause}`;
        const costLine = `last run: ${spend.calls} model call${spend.calls === 1 ? '' : 's'} · $${spend.costUsd.toFixed(4)} · ${elapsed}s`;

        // §6.3 — AND THE RUN ENDS IN MEMORY. What it could not resolve is
        // filed as MISSING facts with the ask, where it looked, and the member
        // marks and rows each one blocks. Before this they died in the run log:
        // a question nobody could answer, on a row nobody could unblock.
        const entry0 = entries.find((e) => e.documentId === doc.id);
        const lookedIn = [
          `${entry0?.drawingNumber || doc.name}${entry0?.revision ? ` ${entry0.revision}` : ''}`,
          `${extract.callouts.length} callouts, ${graph?.dimensions.length ?? 0} readable dimensions, ${extract.tables.length} tables on this sheet`,
          `${out.aiCalls} model call(s) over ${out.turns} orchestrator turn(s)`,
        ];
        const questions = missingFactsFromRun(
          {
            result: out.result,
            escalations: out.escalations,
            unresolved: out.unresolved,
            lookedIn,
            readOn: new Date().toISOString().slice(0, 10),
            // The gaps belong to the drawing that raised them. Without this
            // every drawing's specification listed every drawing's open
            // questions, because a MISSING fact carried no provenance at all.
            source: {
              drawingNumber: entry0?.drawingNumber || doc.name,
              revision: entry0?.revision ?? '',
              documentId: doc.id,
            },
          },
          ledgerRef.current,
        );
        let filed = 0;
        if (questions.length) {
          let next = ledgerRef.current;
          for (const fact of questions) {
            const res = recordFact(next, fact);
            next = res.ledger;
            if (res.accepted) filed += 1;
          }
          await commitLedger(next);
          push(
            `${filed} open question${filed === 1 ? '' : 's'} filed into the specification: ${questions
              .map((q) => q.id)
              .join(', ')}`,
          );
        }

        // AND THE ANSWERS THE RUN HAS JUST DISPROVED.
        //
        // The filing above cannot reach these: it skips any fact already on
        // the record, and a disputed axis is on the record — that is the whole
        // problem with it. A pedestal answered as 100 mm high blocked every
        // row it fed, said so in the Status column, and left nothing anyone
        // could answer. Reopening it puts the engine's own objection to the
        // person who gave the number, which is the only place it can be
        // settled.
        // A dimension the run READ off the sheet has no ledger fact behind it,
        // so there is nothing to reopen — but the row is just as stuck, and on
        // the foundations sheet that is every blocked row. The objection is
        // then filed as an open question in its own right: the value the run
        // used is quoted in it, so the reader can see what to correct.
        // The settings nobody supplied. Filed as questions like any other gap:
        // the header printed "M25 · Fe500 · cover 50" as though the drawing had
        // said so, and those three figures decide every development length and
        // every stirrup arm in the schedule.
        const assumed = assumedSettings(resolvedSettings.sources, resolvedSettings.settings);
        if (assumed.length) {
          let next = ledgerRef.current;
          let asked = 0;
          for (const a of assumed) {
            if (resolveFact(next, a.factId) !== undefined) continue;
            const res = recordFact(next, {
              id: a.factId,
              value: null,
              state: 'MISSING',
              neededFor: ['every development length, lap and stirrup arm in this schedule'],
              lookedIn: [...lookedIn, `this drawing's notes state no value; computed at ${a.usedValue}`],
              ask: a.ask,
              readOn: new Date().toISOString().slice(0, 10),
              source: {
                drawingNumber: entry0?.drawingNumber || doc.name,
                revision: entry0?.revision ?? '',
                documentId: doc.id,
              },
            });
            if (res.accepted) {
              next = res.ledger;
              asked += 1;
            }
          }
          if (asked) {
            await commitLedger(next);
            push(
              `${asked} project default${asked === 1 ? '' : 's'} this drawing never stated ` +
                `(${assumed.map((a) => `${a.factId}=${a.usedValue}`).join(', ')}) filed as open questions — ` +
                'the schedule computed on them.',
            );
          }
        }

        // WHAT THE SHEET SAID IT WOULD NOT TELL US.
        //
        // A template that writes "INPUT" under CUTTING LENGTH has already
        // answered the question of whether to derive one: it has said not to.
        // Reading that is the difference between asking for a number and
        // blocking a row with a development-length sentence about a bar cut
        // from the only dimension the member happened to have.
        const declared = designInputsFrom(extract);
        if (declared.length) {
          let next = ledgerRef.current;
          let opened = 0;
          for (const d of declared) {
            const factId = factIdForDesignInput(d);
            if (resolveFact(next, factId) !== undefined) continue;
            const res = recordFact(next, {
              id: factId,
              value: null,
              unit: 'mm',
              state: 'MISSING',
              neededFor: [d.mark ? `${d.mark} — the drawing leaves this to design` : d.fieldLabel],
              lookedIn: [...lookedIn, `${d.where}, which reads "${d.saidAs}"`],
              ask: askForDesignInput(d),
              readOn: new Date().toISOString().slice(0, 10),
              source: {
                drawingNumber: entry0?.drawingNumber || doc.name,
                revision: entry0?.revision ?? '',
                documentId: doc.id,
              },
            });
            if (res.accepted) {
              next = res.ledger;
              opened += 1;
            }
          }
          if (opened) {
            await commitLedger(next);
            push(
              `${opened} figure${opened === 1 ? '' : 's'} this drawing declares a design input ` +
                `(${declared.map((d) => factIdForDesignInput(d)).join(', ')}) filed as open questions — ` +
                'the sheet states them as INPUT, so nothing was derived for them.',
            );
          }
        }

        const disputes = axisDisputesFromRun(out.result);
        if (disputes.length) {
          let next = ledgerRef.current;
          let raised = 0;
          for (const d of disputes) {
            const before = next;
            if (resolveFact(next, d.factId) === undefined) {
              const res = recordFact(next, {
                id: d.factId,
                value: null,
                unit: 'mm',
                state: 'MISSING',
                neededFor: d.blocks,
                lookedIn: [...lookedIn, `the run resolved this axis, and the schedule rejected it: ${d.reason}`],
                ask: d.ask,
                readOn: new Date().toISOString().slice(0, 10),
                source: {
                  drawingNumber: entry0?.drawingNumber || doc.name,
                  revision: entry0?.revision ?? '',
                  documentId: doc.id,
                },
              });
              next = res.accepted ? res.ledger : next;
            } else {
              next = disputeFact(next, d.factId, { reason: d.reason, ask: d.ask });
            }
            if (next !== before) raised += 1;
          }
          if (raised) {
            await commitLedger(next);
            push(
              `${raised} dimension${raised === 1 ? '' : 's'} the schedule could not use ` +
                `(${disputes.map((d) => d.factId).join(', ')}) put back as open questions — ` +
                'a bar cut from each came out shorter than the length it needs to anchor.',
            );
          }
        }

        // The reading is a first-class, versioned artifact. It carries only
        // conclusions the engine accepted and will re-check them against the
        // drawing hash on the next run; calculated quantities stay in BBS.
        try {
          const entry = entries.find((e) => e.documentId === doc.id);
          const memory = buildAboutDrawingMemory({
            documentId: doc.id,
            drawingName: doc.name,
            sourceDrawingHash: currentHash,
            outcome: out,
            pkg: currentPackage,
          });
          await saveProjectArtifact({
            projectId,
            documentId: doc.id,
            kind: 'about',
            drawingName: doc.name,
            drawingNumber: entry?.drawingNumber ?? '',
            revision: entry?.revision ?? '',
            mimeType: 'application/json',
            content: JSON.stringify(memory),
          });
          // The same memory, normalised and keyed by DRAWING HASH, so the next
          // run can ask "is there a reading of these exact bytes?" instead of
          // parsing artifacts to find out. The artifact above stays the
          // document a person downloads.
          {
            const readingDrawingId = remoteDrawingIdFor(doc.id);
            if (isSupabaseConfigured() && readingDrawingId) {
              try {
                await insertReading({
                  drawingId: readingDrawingId,
                  projectId,
                  drawingHash: currentHash,
                  understanding: memory.understanding,
                  note: memory.note,
                  conclusions: memory.conclusions,
                  sectionNotes: memory.sectionNotes,
                  unresolved: memory.unresolved,
                  escalations: memory.escalations,
                });
              } catch (err) {
                push(`About Drawing not filed in the database: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
          push(
            `About Drawing updated — ${memory.conclusions.length} validated conclusion${memory.conclusions.length === 1 ? '' : 's'}, ` +
              `${memory.sectionNotes.length} section note${memory.sectionNotes.length === 1 ? '' : 's'}.`,
          );
        } catch (err) {
          push(`About Drawing was not persisted: ${err instanceof Error ? err.message : String(err)}`);
        }

        // file the result as a versioned output against the drawing
        let version: string | null = null;
        try {
          const entry = entries.find((e) => e.documentId === doc.id);
          const artifact = await saveProjectArtifact({
            projectId,
            documentId: doc.id,
            kind: 'bbs',
            drawingName: doc.name,
            drawingNumber: entry?.drawingNumber ?? '',
            revision: entry?.revision ?? '',
            mimeType: 'application/json',
            content: JSON.stringify(out.result),
          });
          version = `v${artifact.version}`;
        } catch (err) {
          push(`result not persisted: ${err instanceof Error ? err.message : String(err)}`);
        }

        // THE SCHEDULE, AND WHAT IT WAS COMPUTED FROM, INTO THE DATABASE.
        //
        // The artifact above is the exported document; this is the derivation:
        // one run row carrying the drawing hash, the fact versions and the
        // per-row dependency map, and one row per bar mark carrying its stage
        // trace, the facts it read and the entities it was read from. It is
        // what makes a stale fact able to name the rows it invalidates, and
        // what lets a schedule be audited without recomputing it.
        if (isSupabaseConfigured()) {
          try {
            const stamped = out.result.manifest
              ? stampManifest(out.result.manifest, ledgerRef.current, currentHash)
              : null;
            await saveRun({
              projectId,
              drawingId: remoteDrawingIdFor(doc.id),
              drawingHash: currentHash,
              result: out.result,
              manifest: stamped,
              snapshot: out.snapshot,
            });
            push(
              `schedule filed to the project database — ${out.result.rows.length} row(s) with their calculation trace.`,
            );
          } catch (err) {
            // Said out loud. A schedule that exists only in this browser is
            // the failure this database exists to end.
            push(`SCHEDULE NOT FILED to the database: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        setBbs((prev) => ({
          ...prev,
          running: false,
          stats,
          error: null,
          result: out.result,
          rows,
          version,
          factBaseline: baseline,
          factsUsed: used.length,
          questionsFiled: filed,
          costLine,
          lifecycleStatus: 'VALIDATED',
          // THE MANIFEST IS STAMPED WITH THE LEDGER'S OWN SEQUENCE NUMBERS.
          // The engine records which fact ids each row read; only the ledger
          // knows which VERSION of each was current. Stamped here, at the
          // moment the schedule becomes current, so that any later answer,
          // override or withdrawal on a fact a row depends on marks that row
          // — and the schedule — STALE, and the rebuild names the rows.
          manifest: (() => {
            const built = out.result.manifest;
            return built ? stampManifest(built, ledgerRef.current, currentHash) : null;
          })(),
        }));
        void persistRunMemo(projectId, {
          factIds: baseline,
          at: Date.now(),
          costLine,
          questionsFiled: filed,
        });
        notify(
          `Bar bending schedule built — ${rows.length} rows, ${netT}, $${spend.costUsd.toFixed(4)}` +
            (filed ? ` · ${filed} open question${filed === 1 ? '' : 's'} filed in the Specification.` : '.'),
          'ok',
        );
        return out.result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setBbs((prev) => ({ ...prev, running: false, error: message }));
        notify(`BBS run failed: ${message}`, 'warn');
        throw err instanceof Error ? err : new Error(message);
      } finally {
        bbsRunning.current = false;
      }
    })();
    },
    [entries, notify, store, projectId, commitLedger],
  );

  /**
   * File one run's interview log — what was ASKED, beside what was answered.
   *
   * The ledger already keeps the answers. It keeps nothing about the asking:
   * not what the sheet already said, not the engine's reason for asking, not
   * whether the answer agreed with the drawing. Those are the three things a
   * finished run has to be judged on, and none of them survives the run.
   *
   * `before` is the ledger as it stood when the run started; `ledgerRef` is
   * where it ended. The difference is what makes the findings computable.
   */
  const fileInterviewLog = useCallback(
    async (
      session: InterviewSession,
      before: Ledger,
      outcome: { artifactId?: string; stoppedBecause?: string } = {},
    ) => {
      const snap = session.snapshot();
      if (!snap.answered.length && !snap.pending.length) return;
      const active = cadSheets().find((s) => s.id === store.getState().sheets.active);
      const entry = active ? entries.find((e) => e.documentId === active.doc.id) : undefined;
      const drawingName = entry?.drawingNumber || active?.doc.name || 'this project';
      // The document id travels beside the name. The name is a label — the
      // drawing number when one was read, the file name when it was not — and
      // `interview_logs.drawing_id` cannot be resolved from it; this is what
      // stopped every filed log recording a null drawing.
      const log = {
        ...buildAuditLog(snap, before, ledgerRef.current),
        drawingName,
        ...(active ? { documentId: active.doc.id } : {}),
        ...outcome,
      };
      await appendInterviewLog(projectId, log);
      // AND A FILE ON DISK, when there is a dev server to write one.
      //
      // The browser copy is the source of truth; this is the durable second
      // copy a person can read outside the browser that made it. Not awaited
      // and never checked: a built bundle has no endpoint to post to, so a
      // failed write is the ordinary case, not a fault.
      void writeLogFile(
        runLogPath(project.name, drawingName, log.startedAt),
        auditMarkdown(log, drawingName),
      );
      setInterviewLogVersion((v) => v + 1);
    },
    [projectId, store, entries],
  );

  /** The BBS tab's own button: the same run, with nobody in the loop. */
  const runBbs = useCallback(() => {
    bbsInterview.current?.abandon('a new BBS run started');
    bbsInterviewUnsubscribe.current?.();
    const interview = new InterviewSession();
    bbsInterview.current = interview;
    bbsInterviewUnsubscribe.current = interview.subscribe(() => setBbsInterviewVersion((v) => v + 1));
    interview.start();
    setBbsInterviewVersion((v) => v + 1);

    // THE LEDGER AS IT STOOD BEFORE THE RUN.
    //
    // Captured here and nowhere else: it is the only thing that can answer
    // "did we ask for something we already had?", and it stops being available
    // the moment the first answer is recorded.
    const ledgerBefore = ledgerRef.current;

    void startBbsRun({ askUser: askUserOf(interview) })
      .then(async (result) => {
        // Answers are persisted before the run is published, so reopening the
        // drawing cannot make the same interview happen again.
        const answers = interview.answers();
        if (answers.length) {
          const active = cadSheets().find((s) => s.id === store.getState().sheets.active);
          const entry = active ? entries.find((e) => e.documentId === active.doc.id) : undefined;
          const recorded = recordAnswers(ledgerRef.current, answers, {
            suppliedBy: 'you',
            ...(active
              ? {
                  askedAbout: {
                    documentId: active.doc.id,
                    drawingNumber: entry?.drawingNumber || active.doc.name,
                    revision: entry?.revision ?? '',
                  },
                }
              : {}),
          });
          await commitLedger(recorded.ledger);
        }
        await fileInterviewLog(interview, ledgerBefore, { artifactId: result.id });
        interview.publish(result.id);
      })
      .catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err);
        // A FAILED RUN IS THE ONE WORTH READING. Logged before the failure is
        // reported, so the questions it asked and the answers it got survive
        // whatever went wrong after them.
        await fileInterviewLog(interview, ledgerBefore, { stoppedBecause: message });
        interview.fail(message);
      });
  }, [startBbsRun, store, entries, commitLedger, fileInterviewLog]);

  /**
   * THE OPEN QUESTIONS, RE-READ WHENEVER THE SESSION SAYS SO.
   *
   * This was a bare `bbsInterview.current?.snapshot()` and the seam that
   * carries it is a `useMemo` that does not list it. So the panel kept
   * rendering whichever batch of questions happened to be open when some
   * unrelated dependency last changed: the session moved on, those ids were
   * settled, and answering one came back "no open question" — the answer was
   * being posted to a question that no longer existed.
   *
   * Keyed on the version the session bumps on every change, so it is stable
   * between notifications and fresh after each one.
   */
  // The runs on file, re-read whenever one is added. Read-only: the log is a
  // record, and nothing in the app edits it.
  useEffect(() => {
    let alive = true;
    void loadInterviewLogs(projectId).then((logs) => {
      if (alive) setInterviewLogs(logs);
    });
    return () => {
      alive = false;
    };
  }, [projectId, interviewLogVersion]);

  const bbsInterviewSnapshot = useMemo(
    () => bbsInterview.current?.snapshot(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bbsInterviewVersion],
  );

  // ---- schedule rows -------------------------------------------------------
  //
  // Three sources, one grid, in this order:
  //   1. a PINNED artifact — someone opened v1 out of Outputs → BBS;
  //   2. the last run this session;
  //   3. the newest filed output.
  //
  // The pin comes first on purpose: it is the only one a person asked for by
  // name. Everything downstream — the table, the totals, the workbook the
  // Download button writes — reads these four values and nothing else, so an
  // old version exports as the document it was, not as today's.

  const pinnedArtifactId = shell.ui.artifactId;

  const { scheduleRows, scheduleVersion, scheduleResult, scheduleVersionNo } = useMemo((): {
    scheduleRows: ScheduleRow[];
    scheduleVersion: string;
    scheduleResult?: BbsChatResult;
    scheduleVersionNo?: number;
  } => {
    const filed = artifacts.filter((a) => a.kind === 'bbs' && a.mimeType === 'application/json');
    const pinned = pinnedArtifactId ? filed.find((a) => a.id === pinnedArtifactId) : undefined;

    if (!pinned && bbs.rows) {
      return {
        scheduleRows: bbs.rows,
        scheduleVersion: bbs.version ?? 'run',
        ...(bbs.result ? { scheduleResult: bbs.result } : {}),
        ...(bbs.version ? { scheduleVersionNo: Number(bbs.version.replace(/^v/, '')) || undefined } : {}),
      };
    }
    const source = pinned ?? [...filed].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!source) return { scheduleRows: [] as ScheduleRow[], scheduleVersion: '—' };
    try {
      const result = JSON.parse(source.content) as BbsChatResult;
      const doc = session.sheets.find((s) => s.doc.id === source.documentId)?.doc ?? null;
      return {
        scheduleRows: adaptChatRows(result, doc ? graphFor(doc) : null),
        scheduleVersion: `v${source.version}`,
        scheduleResult: result,
        scheduleVersionNo: source.version,
      };
    } catch {
      return { scheduleRows: [] as ScheduleRow[], scheduleVersion: '—' };
    }
  }, [bbs.rows, bbs.version, bbs.result, artifacts, session.version, pinnedArtifactId]);

  /**
   * §6.3 — the answers that have arrived since the schedule was built. This is
   * the ONLY thing that connects answering a fact to the schedule: it never
   * triggers anything, it offers. A rebuild spends model calls, so a person
   * spends them.
   */
  const bbsAnswersSince = useMemo(
    () => (bbs.factBaseline === null ? [] : answersSince(ledger, bbs.factBaseline)),
    [ledger, bbs.factBaseline],
  );

  // §STALE — manifest-based precise staleness. If the manifest records which
  // fact ids were used and the ledger now has newer answers for any of them,
  // the schedule is STALE and must say so before being shown as current.
  const bbsStaleFacts = useMemo(
    // The LIVE hash of the open drawing is compared too: a re-imported or
    // edited drawing changes its hash, and every row computed from the old
    // bytes is STALE — never shown as current, never silently reused.
    () =>
      bbs.manifest && !bbs.running
        ? staleFacts(ledger, bbs.manifest, activeCad ? (docHashes.get(activeCad.doc.id) ?? undefined) : undefined)
        : [],
    [bbs.manifest, bbs.running, ledger, activeCad, docHashes],
  );

  // Derive the effective lifecycle status: if stale facts exist after a
  // VALIDATED build, promote to STALE so the UI shows the banner immediately
  // rather than only after a user scrolls to the answersSince notice.
  const bbsLifecycleStatus = useMemo<'STALE' | 'REBUILDING' | 'VALIDATED' | 'IDLE'>(() => {
    if (bbs.running) return 'REBUILDING';
    if (bbs.lifecycleStatus === 'VALIDATED' && bbsStaleFacts.length > 0) return 'STALE';
    return bbs.lifecycleStatus;
  }, [bbs.running, bbs.lifecycleStatus, bbsStaleFacts]);

  /** the rows whose dependencies moved — named in the banner and the run log */
  const bbsStaleRows = useMemo(
    () => (bbs.manifest && bbsStaleFacts.length ? staleRowsOf(bbs.manifest, bbsStaleFacts) : []),
    [bbs.manifest, bbsStaleFacts],
  );

  // A DEPENDENT FACT CHANGED → THE SCHEDULE RECALCULATES. On its own.
  //
  // The old schedule must never stay on screen as current once a fact it
  // read has moved: the manifest names the stale rows, the saved About
  // Drawing reading is replayed, every row goes back through
  // calculations/schedule.ts on the latest facts, the summary is rebuilt and
  // reconciled. No model call is spent (`recalculateOnly`), so nothing is
  // rationed and nobody has to press a button they did not know to press.
  // The guard remembers which stale signature was already recalculated, so a
  // fact the rows do not read cannot spin the loop.
  //
  // THE GUARD MUST NOT INCLUDE THE BUILD ID. Every rebuild mints a new one, so
  // a signature containing it never repeats and the guard never fires — which
  // is precisely how a schedule that reported itself stale on every check
  // rebuilt itself forty-nine times in a minute. The signature is the WORK:
  // this drawing, these stale facts. If recalculating does not settle them,
  // rebuilding again will not either.
  const recalculatedFor = useRef<string>('');
  const recalcAttempts = useRef(0);
  useEffect(() => {
    if (bbs.running || !bbs.manifest) return;
    if (bbsLifecycleStatus !== 'STALE') {
      // Settled. The next genuine change starts from zero attempts.
      recalcAttempts.current = 0;
      return;
    }
    const signature = `${bbs.manifest.drawingHash}|${[...bbsStaleFacts].sort().join(',')}`;
    if (recalculatedFor.current === signature) return;

    // A second belt: even a signature that keeps changing cannot spin forever.
    // Three consecutive automatic rebuilds without reaching a settled schedule
    // is a defect to report, not a thing to keep doing.
    recalcAttempts.current += 1;
    if (recalcAttempts.current > 3) {
      recalculatedFor.current = signature;
      notify(
        `The schedule still reports ${bbsStaleFacts.length} changed fact(s) after 3 automatic rebuilds ` +
          `(${bbsStaleFacts.slice(0, 3).join(', ')}${bbsStaleFacts.length > 3 ? ', …' : ''}). ` +
          'Stopping — rebuild by hand once the cause is known.',
        'warn',
      );
      return;
    }
    recalculatedFor.current = signature;
    notify(
      `${bbsStaleFacts.length} fact${bbsStaleFacts.length === 1 ? '' : 's'} changed (${bbsStaleFacts.slice(0, 4).join(', ')}` +
        `${bbsStaleFacts.length > 4 ? ', …' : ''}) — ${bbsStaleRows.length ? `${bbsStaleRows.length} row(s) marked STALE; ` : ''}recalculating the schedule.`,
      'ok',
    );
    // The STORED schedule is marked stale too, immediately. Between the fact
    // changing and the rebuild landing there is a window in which the database
    // still holds the old run; anyone reading it in that window — another tab,
    // an export, a colleague — must see that it is superseded rather than take
    // it as current.
    if (isSupabaseConfigured()) {
      void markStaleByFacts(project.id, bbsStaleFacts).catch(() => {
        /* the rebuild below replaces the run regardless */
      });
    }
    void startBbsRun({ recalculateOnly: true, ...(bbsInterview.current ? { askUser: askUserOf(bbsInterview.current) } : {}) }).catch(
      (err) => notify(`Recalculation did not complete: ${err instanceof Error ? err.message : String(err)}`, 'warn'),
    );
  }, [bbsLifecycleStatus, bbs.running, bbs.manifest, bbsStaleFacts, bbsStaleRows, startBbsRun, notify]);

  const activeAboutDrawing = useMemo(() => {
    if (!activeCad) return null;
    const currentHash = docHashes.get(activeCad.doc.id);
    return artifacts
      .filter((a) => a.documentId === activeCad.doc.id && a.kind === 'about' && a.mimeType === 'application/json')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((a) => parseAboutDrawingMemory(a.content))
      .find((m) => m !== null && (!currentHash || m.sourceDrawingHash === currentHash)) ?? null;
  }, [activeCad, artifacts, docHashes]);

  const docsWithSchedule = useMemo(
    () => new Set(artifacts.filter((a) => a.kind === 'bbs').map((a) => a.documentId)),
    [artifacts],
  );

  // ---- ask ----------------------------------------------------------------

  let askBlocked: string | null = null;
  if (activePdf) askBlocked = 'The active sheet is a PDF page — questions run against parsed DXF geometry. Open a DXF sheet.';
  else if (!activeCad) askBlocked = 'Open a DXF drawing first — questions are answered from the open sheet.';
  else if (!isAiConfigured()) {
    askBlocked =
      'No OpenRouter key found. Set VITE_OPENROUTER_API_KEY in .env at the project root and restart the dev server.';
  }

  const ask = useCallback(
    async (
      question: string,
      attachments: readonly StudioChatAttachment[] = [],
      signal?: AbortSignal,
    ): Promise<string> => {
      const active = cadSheets().find((s) => s.id === store.getState().sheets.active);
      if (!active) throw new Error('No DXF sheet is open.');
      const startedAt = Date.now();
      const progress = [
        `Question prepared for ${active.doc.name}.`,
        attachments.length
          ? `${attachments.length} attachment${attachments.length === 1 ? '' : 's'} included: ${attachments.map((item) => item.name).join(', ')}.`
          : 'No user attachments included.',
      ];
      setAskRun({ running: true, progress, error: null, stats: null });
      try {
        const answer = await askDrawing(active.doc, question, {
          attachments,
          signal,
          onPhase: (phase) => {
            const line = phase.kind === 'planning'
              ? 'Planning what evidence to inspect…'
              : phase.kind === 'gathering'
                ? 'Gathering measured drawing evidence…'
                : 'Request sent to the model; waiting for a response…';
            setAskRun((current) => ({ ...current, progress: [...current.progress, line] }));
          },
        });
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        setAskRun((current) => ({ ...current, running: false, stats: `answered in ${elapsed}s`, progress: [...current.progress, 'Response received.'] }));
        return answer;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        setAskRun((current) => ({ ...current, running: false, error: message, stats: `stopped after ${elapsed}s`, progress: [...current.progress, `Stopped: ${message}`] }));
        throw err;
      }
    },
    [store],
  );

  // ---- §7: the chat IS the interview --------------------------------------

  /**
   * The rows for an artifact the CHAT resolved (§7.2). It is the same adapter
   * the BBS tab uses, so the schedule in the bubble and the schedule in the
   * tab are the same rows built the same way — the reference is resolved, and
   * nothing is re-derived on the way through.
   */
  const chatAdaptRows = useCallback(
    (result: BbsChatResult): ScheduleRow[] => {
      const active = cadSheets().find((s) => s.id === store.getState().sheets.active);
      return adaptChatRows(result, active ? graphFor(active.doc) : null);
    },
    [store],
  );

  /**
   * §7.1 — an answer becomes a SUPPLIED fact exactly ONCE, through the same
   * `recordFact` write path everything else uses, and a decline becomes a
   * NAMED GAP. Returns the line to quote per fact, because "never silently
   * applied" means the thread says what landed.
   */
  const chatRecordAnswers = useCallback(
    async (answers: readonly AnsweredQuestion[]): Promise<string[]> => {
      if (!answers.length) return [];
      const active = cadSheets().find((s) => s.id === store.getState().sheets.active);
      const entry = active ? entries.find((e) => e.documentId === active.doc.id) : undefined;
      const res = recordAnswers(ledgerRef.current, answers, {
        suppliedBy: 'you',
        // CONTEXT, never authority: the answer is not a reading of this sheet
        ...(active
          ? {
              askedAbout: {
                documentId: active.doc.id,
                drawingNumber: entry?.drawingNumber || active.doc.name,
                revision: entry?.revision ?? '',
              },
            }
          : {}),
      });
      await commitLedger(res.ledger);
      const lines = res.applied.map(appliedLine);
      for (const { fact, reason } of res.rejected) {
        lines.push(`${fact.id} was recorded but did not become current — ${reason}.`);
      }
      return lines;
    },
    [commitLedger, entries, store],
  );

  /** Which drawing, which revision, under what — the export's header block. */
  /**
   * The export header for ONE drawing. A filed artifact must be stamped with
   * the drawing it was computed from, never with whatever sheet happens to be
   * open — downloading v3 of the foundation schedule while a gate detail is on
   * screen would otherwise hand over a workbook titled after the gate.
   */
  const provenanceOf = useCallback(
    (documentId: string | undefined, fallbackName?: string): BbsProvenance => {
      const entry = documentId ? entries.find((e) => e.documentId === documentId) : undefined;
      return {
        projectName: project.name,
        drawingName: entry?.title || fallbackName,
        // What the export is NAMED after: the drawing's own file, the same
        // stem the BBS folder shows. The header still prints title + number.
        ...(fallbackName ? { drawingFile: fallbackName } : {}),
        drawingNumber: entry?.drawingNumber,
        revision: entry?.revision,
        issueDate: entry?.issueDate,
        preparedBy: 'BIMCAD Studio',
        settings: {
          concreteGrade: DEFAULT_SETTINGS.concreteGrade,
          steelGrade: DEFAULT_SETTINGS.steelGrade,
          coverMm: DEFAULT_SETTINGS.coverMm,
          bendMode: DEFAULT_SETTINGS.bendMode,
          wastagePct: DEFAULT_SETTINGS.wastagePct,
        },
        conventions: EXPORT_CONVENTIONS,
      };
    },
    [entries, project.name],
  );

  const chatProvenance = useCallback((): BbsProvenance => {
    const active = cadSheets().find((s) => s.id === store.getState().sheets.active);
    return provenanceOf(active?.doc.id, active?.doc.name);
  }, [provenanceOf, store]);

  /**
   * §6.2 — a filed schedule taken away from the folder that lists it, under
   * exactly the filename that folder shows. The rows are re-adapted from the
   * stored engine result, so an old version exports as the document it was.
   */

  // ------------------------------------------------------------
  // EXPAND / EDIT — stages 3 and 4
  // ------------------------------------------------------------

  /**
   * A filed schedule as an editable grid.
   *
   * The rows are RECOMPUTED from the inputs the artifact carries rather than
   * read out of it, so what a person edits is always the schedule the current
   * engine produces from those inputs. An artifact filed before engine inputs
   * were recorded cannot be rebuilt, and returns null rather than offering a
   * half-editable grid.
   */
  const bbsEditorGrid = useCallback(
    (artifactId: string): EditableGrid | null => {
      const artifact = artifacts.find((a) => a.id === artifactId);
      if (!artifact || artifact.kind !== 'bbs' || artifact.mimeType !== 'application/json') return null;
      try {
        const stored = JSON.parse(artifact.content) as BbsChatResult;
        // A schedule filed before builds recorded their inputs is rebuilt from
        // what it does record, and every row is checked against the filed
        // numbers. Rows that do not reproduce ride along as MISMATCH rather
        // than closing the whole schedule to editing.
        const rebuilt = stored.engineInputs
          ? { inputs: stored.engineInputs, unreproduced: [] as string[] }
          : reconstructEngineInputs(stored);
        if (!rebuilt) return null;
        const { inputs, unreproduced } = rebuilt;
        const { rows, summary, reconciliation } = recalculate(inputs);
        const hash = docHashes.get(artifact.documentId);
        return buildEditGrid(rows, inputs, {
          summary,
          reconciliation,
          unreproduced,
          // A sanity failure or a verifier's dispute survives a rebuild: the
          // arithmetic was never what it doubted.
          disputes: disputesOf(stored),
          verificationOk: stored.verification?.ok,
          drawingHashMatches: hash && stored.drawingHash ? hash === stored.drawingHash : undefined,
        });
      } catch {
        return null;
      }
    },
    [artifacts, docHashes],
  );

  /**
   * Stage 4 in one call, in order:
   *
   *   validate every edit → USER_INPUT DataFact beside the drawing's own value
   *   → invalidate the rows that read it → recompute through
   *   `calculations/schedule.ts` → steel summary → reconciliation →
   *   engineering validation → file the result as the next version.
   *
   * Nothing here computes a length, a count or a weight: `applyEdits` calls
   * the same `scheduleRow` the build does. An edit that fails validation
   * changes nothing at all, and the previous version stays on file whatever
   * happens — it is the audit trail.
   */
  const saveBbsEdits = useCallback(
    async (
      artifactId: string,
      edits: readonly CellEdit[],
      opts: { asNewVersion?: boolean; acknowledged?: readonly string[] } = {},
    ): Promise<{
      status: 'FINAL' | 'INCOMPLETE';
      version: number;
      artifactId: string;
      newVersion: boolean;
      rejected: readonly EditRejection[];
      recalculated: number;
      facts: number;
    } | null> => {
      const artifact = artifacts.find((a) => a.id === artifactId);
      if (!artifact || artifact.kind !== 'bbs' || artifact.mimeType !== 'application/json') return null;

      let stored: BbsChatResult;
      try {
        stored = JSON.parse(artifact.content) as BbsChatResult;
      } catch {
        return null;
      }
      const recovered = stored.engineInputs
        ? { inputs: stored.engineInputs, unreproduced: [] as string[] }
        : reconstructEngineInputs(stored);
      if (!recovered) return null;
      const { inputs, unreproduced } = recovered;

      // A row the reconstruction could not reproduce is not edited: saving it
      // would replace a filed number with one nobody can trace.
      const refused = edits
        .filter((e) => unreproduced.includes(e.barMark))
        .map((e) => ({
          barMark: e.barMark,
          field: e.field,
          value: e.value,
          reason:
            'this row was filed before its inputs were recorded and could not be reproduced — rebuild the BBS for this drawing to edit it',
        }));
      if (refused.length) {
        return {
          status: 'INCOMPLETE' as const,
          version: artifact.version,
          artifactId: artifact.id,
          newVersion: false,
          rejected: refused,
          recalculated: 0,
          facts: 0,
        };
      }

      const hash = docHashes.get(artifact.documentId);
      const drawingHashMatches = hash && stored.drawingHash ? hash === stored.drawingHash : undefined;
      const { rows } = recalculate(inputs);
      const standing = disputesOf(stored, opts.acknowledged ?? []);
      const out = applyEdits(rows, inputs, edits, {
        drawingHashMatches,
        disputes: standing,
        verificationOk: stored.verification?.ok,
      });

      // Nothing is written when an edit did not validate: a half-applied save
      // would leave the schedule in a state nobody chose.
      if (out.rejected.length) {
        return {
          status: out.status,
          version: artifact.version,
          artifactId: artifact.id,
          newVersion: false,
          rejected: out.rejected,
          recalculated: 0,
          facts: 0,
        };
      }

      // A dispute is settled by a person saying they have checked it, and that
      // is recorded with their name on it — not silently dropped.
      const acknowledged: DisputeAcknowledgement[] = [
        ...((stored as { acknowledged?: DisputeAcknowledgement[] }).acknowledged ?? []),
        ...(opts.acknowledged ?? []).map((dispute) => ({ dispute, by: 'you', at: Date.now() })),
      ];

      // 1. THE FACTS. A person's figure is SUPPLIED and attributable. Where it
      //    displaces something the drawing stated, it goes in as an explicit
      //    override — a plain SUPPLIED record is (rightly) refused against a
      //    DECLARED reading, and the reading stays on the record either way.
      let ledger = ledgerRef.current;
      for (const fact of out.facts) {
        if (fact.value === null) continue;
        const current = resolveFact(ledger, fact.factId);
        const evidence = [
          `entered in the editable schedule for ${artifact.drawingNumber || artifact.drawingName}`,
          ...(fact.confirmed ? ['confirmed by the editor as read from the drawing or stated by the designer'] : []),
          ...(fact.previous ? [`replaces ${fact.previous.source} ${fact.previous.value}`] : []),
        ];
        if (current && current.state !== 'MISSING' && current.state !== 'SUPPLIED') {
          ledger = overrideFact(ledger, fact.factId, {
            value: fact.value,
            suppliedBy: 'you',
            evidence,
            ...(artifact.drawingNumber ? { askedOn: artifact.drawingNumber } : {}),
          });
        } else {
          const res = recordFact(ledger, {
            id: fact.factId,
            value: fact.value,
            ...(fact.unit ? { unit: fact.unit } : {}),
            state: 'SUPPLIED',
            suppliedBy: 'you',
            saidAs: fact.saidAs,
            evidence,
            neededFor: fact.affects,
            readOn: new Date().toISOString().slice(0, 10),
          });
          ledger = res.ledger;
        }
      }
      await commitLedger(ledger);

      // 2. THE RESULT, through the one builder. A synthesised BbsResult keeps
      //    every consumer — the sheet, the workbook, the summary — reading the
      //    same rows the pipeline just produced.
      const rebuilt: BbsResult = {
        settings: out.inputs.settings,
        members: Object.values(out.inputs.members),
        rows: out.rows,
        summary: out.summary,
        reconciliation: out.reconciliation,
        validation: out.validation,
        engineInputs: out.inputs,
        incomplete: out.rows
          .filter((r) => r.missing)
          .map((r) => ({ barMark: r.barMark, reason: r.missing ?? '' })),
        interpretation: {
          members: Object.values(out.inputs.members),
          bars: Object.values(out.inputs.bars),
          unresolved: [],
        },
        ...(stored.manifest ? { manifest: stored.manifest } : {}),
      };
      const next = buildChatResult({
        id: `edited-${Date.now()}`,
        drawingName: artifact.drawingName,
        result: rebuilt,
        verification: stored.verification,
        settings: out.inputs.settings,
        reconciliation: out.reconciliation,
        ...(stored.manifest ? { manifest: stored.manifest } : {}),
        ...(stored.drawingHash ? { drawingHash: stored.drawingHash } : {}),
        ...(stored.assumptions ? { assumptions: stored.assumptions } : {}),
        ...(stored.gaps ? { gaps: stored.gaps } : {}),
        builtAt: Date.now(),
      });

      // 3. THE AUDIT ENTRY. Correcting in place must not cost the record of
      //    what was corrected, so every edit is kept on the artifact with the
      //    value it replaced and where that value came from.
      const previous = (stored as { history?: BbsEditEvent[] }).history ?? [];
      const event: BbsEditEvent = {
        at: Date.now(),
        by: 'you',
        ...(opts.acknowledged?.length ? { acknowledged: [...opts.acknowledged] } : {}),
        edits: out.facts.map((f) => ({
          factId: f.factId,
          to: f.value,
          ...(f.previous ? { from: f.previous.value, fromSource: f.previous.source } : {}),
          override: f.override,
          ...(f.confirmed ? { confirmed: true } : {}),
          affects: f.affects,
        })),
        rowsRecalculated: out.invalidated,
        statusBefore: stored.validation?.label ?? 'INCOMPLETE',
        statusAfter: out.status,
        reconciled: out.reconciliation.ok,
        netWeightKg: out.summary.reduce((n, s) => n + s.totalWeightKg, 0),
      };
      (next as { history?: BbsEditEvent[] }).history = [...previous, event];
      if (acknowledged.length) {
        (next as { acknowledged?: DisputeAcknowledgement[] }).acknowledged = acknowledged;
      }

      // 4. WRITTEN BACK TO THE SCHEDULE THAT WAS OPENED.
      //
      //    A recalculation is not a revision. Completing a blocked row in
      //    "pedestal-BBS-v1" leaves you with "pedestal-BBS-v1", corrected —
      //    the same id, the same version, the same file name. A new version
      //    is a deliberate act, and `asNewVersion` is that act.
      const content = JSON.stringify(next);
      const saved = opts.asNewVersion
        ? await saveProjectArtifact({
            projectId,
            documentId: artifact.documentId,
            kind: 'bbs',
            drawingName: artifact.drawingName,
            drawingNumber: artifact.drawingNumber,
            revision: artifact.revision,
            mimeType: 'application/json',
            content,
          })
        : await updateProjectArtifact(projectId, artifactId, content);
      if (!saved) return null;

      // 5. THE CALCULATION RUN, which is where the per-run history lives. The
      //    artifact is one document; the runs behind it are many.
      if (isSupabaseConfigured()) {
        try {
          await saveRun({
            projectId,
            drawingId: remoteDrawingIdFor(artifact.documentId),
            drawingHash: stored.drawingHash ?? null,
            result: next,
            ...(stored.manifest ? { manifest: stored.manifest } : {}),
            snapshot: [
              `EDIT ${new Date(event.at).toISOString()} — ${event.edits.length} input(s), ` +
                `${event.rowsRecalculated.length} row(s) recalculated, ${event.statusBefore} → ${event.statusAfter}`,
              ...event.edits.map(
                (e) => `  ${e.factId}: ${e.from ?? '(none)'} → ${e.to}${e.override ? ' (override)' : ''}`,
              ),
            ],
          });
        } catch {
          // The schedule is saved; its run record is a second write and must
          // not be able to undo the first.
        }
      }

      return {
        status: out.status,
        version: saved.version,
        artifactId: saved.id,
        newVersion: Boolean(opts.asNewVersion),
        rejected: [],
        recalculated: out.invalidated.length,
        facts: out.facts.length,
      };
    },
    [artifacts, commitLedger, docHashes, projectId],
  );

  const downloadArtifact = useCallback(
    (artifactId: string, format: 'xlsx' | 'csv'): string | null => {
      const artifact = artifacts.find((a) => a.id === artifactId);
      if (!artifact || artifact.kind !== 'bbs' || artifact.mimeType !== 'application/json') {
        return null;
      }
      try {
        const result = JSON.parse(artifact.content) as BbsChatResult;
        const doc = cadSheets().find((s) => s.doc.id === artifact.documentId)?.doc ?? null;
        const rows = adaptChatRows(result, doc ? graphFor(doc) : null);
        const provenance = provenanceOf(artifact.documentId, artifact.drawingName);
        const input = {
          result,
          columns: exportColumns(deriveColumns(rows)),
          groupBy: workbookGroup(store.getState().format.group),
          provenance: {
            ...provenance,
            // The artifact's own record wins: v1 of a drawing that has since
            // been revised still exports as the document it was.
            drawingFile: artifact.drawingName || provenance.drawingFile,
            drawingName: provenance.drawingName || artifact.drawingName,
            drawingNumber: artifact.drawingNumber || provenance.drawingNumber,
            revision: artifact.revision || provenance.revision,
            exportedAt: Date.now(),
          },
          version: artifact.version,
        };
        return format === 'csv' ? downloadScheduleCsv(input) : downloadScheduleXlsx(input);
      } catch {
        return null;
      }
    },
    [artifacts, provenanceOf, store],
  );

  /**
   * Delete a drawing — its register entry, its Sections/ folder and every
   * output filed under it (BBS, quantities, the sections index, the "about
   * this drawing" note). Those all PROJECT from the drawing's own record
   * (`buildGroups`, `sectionsFolderFor`, the Outputs folders) — they exist
   * only because the underlying record does, so this removes the records
   * rather than trying to hide three separate rows in step.
   *
   * The parsed CadDocument is dropped from the session AND its persisted
   * cache (`putCadDocuments`, the same call `importCadDrawing` makes) —
   * otherwise `restoreCadDrawing` would find the doc with no matching
   * register entry on the next reload and silently re-enrol it from the
   * source bytes. Those source bytes themselves are kept, same as
   * `removeDrawingEntry` already promises: this removes the register's
   * record of the file, never the client's only copy of it.
   */
  const deleteDrawing = useCallback(
    (entryId: string) => {
      const entry = entries.find((e) => e.id === entryId);
      if (!entry) return;
      const { documentId } = entry;
      const label = entry.originalFileName || entry.displayName;

      const cadSheet = cadSheets().find((s) => s.doc.id === documentId);
      const openTabs = shell.sheets.open.filter(
        (tid) => tid === cadSheet?.id || parseSectionSheetId(tid)?.documentId === documentId,
      );
      for (const tid of openTabs) store.closeSheet(tid);

      if (cadSheet) {
        closeCadSheet(cadSheet.id);
        void repo.putCadDocuments(projectId, cadSheets().map((s) => s.doc));
      }

      void deletePackage(projectId, documentId);
      setPackages((prev) => prev.filter((p) => p.documentId !== documentId));
      void removeProjectArtifactsForDocument(projectId, documentId).catch((err: unknown) => {
        notify(
          `The outputs filed under ${label} are still on file — ${err instanceof Error ? err.message : String(err)}`,
          'warn',
        );
      });
      void removeDrawingEntry(entryId).catch((err: unknown) => {
        notify(`${label} is still on file — ${err instanceof Error ? err.message : String(err)}`, 'warn');
      });
      notify(`Deleted ${label} — its sections and filed outputs went with it.`, 'ok');
    },
    [entries, shell.sheets.open, store, projectId, notify],
  );

  /** Rename — the name the Files list, every open tab and the window title show. */
  const renameDrawing = useCallback((entryId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void updateDrawingEntry(entryId, { originalFileName: trimmed });
  }, []);

  // ---- folders a person makes ---------------------------------------------
  //
  // src/register/folders.ts has held this whole model since it was written —
  // create, rename, delete, membership, persistence — and nothing ever called
  // it, so New → Folder could only apologise. These four are the wiring.

  const createUserFolder = useCallback(
    (name: string): string | null => {
      try {
        const folder = createFolderRecord(projectId, name);
        notify(`Folder "${folder.name}" created.`, 'ok');
        // The id comes straight back so a caller can file into the folder it
        // just made, in the same click, without waiting for a re-render.
        return folder.id;
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), 'warn');
        return null;
      }
    },
    [projectId, notify],
  );

  const renameUserFolder = useCallback(
    (folderId: string, name: string) => {
      renameFolderRecord(projectId, folderId, name);
    },
    [projectId],
  );

  const deleteUserFolder = useCallback(
    (folderId: string) => {
      // The folder is a label; the drawings it named stay exactly where they
      // are, in every derived view they belong to.
      deleteFolderRecord(projectId, folderId);
      notify('Folder removed — the drawings in it are untouched.', 'ok');
    },
    [projectId, notify],
  );

  const fileInFolder = useCallback(
    (folderId: string, nodeId: string, member: boolean) => {
      setFolderMembership(projectId, folderId, nodeId, member);
    },
    [projectId],
  );

  /**
   * MOVE — one filing location, not one more.
   *
   * `fileInFolder` adds a membership and leaves the rest alone, which is right
   * for "also file this under Priced". A move is the other statement: the
   * drawing lives HERE now, so it leaves every other folder a person made.
   * `null` moves it out of all of them and it is filed by discipline alone
   * again.
   *
   * The DISCIPLINE IS NOT TOUCHED, here or anywhere in this path. It is read
   * off the sheet's title block; moving a drawing between two folders someone
   * made says nothing about what kind of drawing it is, and a move that
   * silently reclassified it would be the register lying about the sheet.
   *
   * Both keys are removed because a membership filed before `documentId`
   * existed named the entry id — leaving that one behind would move the
   * drawing and leave a copy of it in the folder it came from.
   */
  const moveToFolder = useCallback(
    (nodeId: string, folderId: string | null) => {
      // The node may arrive under either key, so the entry is looked up by
      // both and every key it has ever been filed under is handed over. It
      // lands under the DOCUMENT id, which is the same on every machine.
      const entry = entries.find((e) => e.id === nodeId || e.documentId === nodeId);
      const keys = entry ? [entry.id, entry.documentId] : [nodeId];
      moveMembership(projectId, keys, folderId, entry?.documentId ?? nodeId);
    },
    [projectId, entries],
  );

  /**
   * Delete one filed output on its own — an old BBS or quantity version,
   * removed without touching the drawing that produced it or any other
   * version filed against it.
   */
  const deleteArtifact = useCallback(
    (artifactId: string) => {
      // No notify on SUCCESS — the row's DISPLAYED name (`bbsFileName` for a
      // BBS output) is computed in `outputFolder`, not carried on the artifact
      // itself, so the caller — which already has that name off the row —
      // reports it. A FAILURE is this function's to report: the delete goes to
      // the database, and a refused delete that said nothing would look
      // exactly like a successful one until the next reload put the output
      // back.
      void removeProjectArtifact(projectId, artifactId).catch((err: unknown) => {
        notify(
          `That output is still on file — ${err instanceof Error ? err.message : String(err)}`,
          'warn',
        );
      });
    },
    [projectId, notify],
  );

  /**
   * Delete an imported PDF page — its own register (`pdfStoreKey`), never the
   * DXF one, so `deleteDrawing` would find no matching entry and silently do
   * nothing. Its sheet id IS its own id (`pdfStudioSheet`), so any open tab
   * for it closes the same way a drawing's does.
   */
  const deletePdf = useCallback(
    (pdfId: string) => {
      if (shell.sheets.open.includes(pdfId)) store.closeSheet(pdfId);
      setPdfEntries((prev) => {
        const next = prev.filter((p) => p.id !== pdfId);
        if (next.length !== prev.length) void persistPdfEntries(projectId, next);
        return next;
      });
    },
    [shell.sheets.open, store, projectId],
  );

  /** Rename an imported PDF page — `pdfDisplayName` reads this back. */
  const renamePdf = useCallback(
    (pdfId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setPdfEntries((prev) => {
        const next = prev.map((p) => (p.id === pdfId ? { ...p, fileName: trimmed } : p));
        void persistPdfEntries(projectId, next);
        return next;
      });
    },
    [projectId],
  );

  /**
   * Delete every page of one multi-page PDF import — the Pages/ folder's own
   * delete (§ pdfBatchAt). All of them share `importedAt` (set once per
   * import call), so that value is what finds the batch.
   */
  const deletePdfBatch = useCallback(
    (importedAt: number) => {
      const pageIds = pdfEntries.filter((p) => p.importedAt === importedAt).map((p) => p.id);
      for (const id of pageIds) if (shell.sheets.open.includes(id)) store.closeSheet(id);
      setPdfEntries((prev) => {
        const next = prev.filter((p) => p.importedAt !== importedAt);
        if (next.length !== prev.length) void persistPdfEntries(projectId, next);
        return next;
      });
    },
    [pdfEntries, shell.sheets.open, store, projectId],
  );

  /** Rename every page's shared file name at once — `pdfDisplayName`, and the folder's own name, read this back. */
  const renamePdfBatch = useCallback(
    (importedAt: number, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setPdfEntries((prev) => {
        const next = prev.map((p) => (p.importedAt === importedAt ? { ...p, fileName: trimmed } : p));
        void persistPdfEntries(projectId, next);
        return next;
      });
    },
    [projectId],
  );

  /** the ledger a chat run started from — see `chatStart` */
  const chatLedgerBefore = useRef<Ledger | null>(null);

  const chatStart = useCallback(
    async (request: ChatRunRequest): Promise<ChatRunOutcome> => {
      // The ledger as it stands BEFORE the run — the only thing that can
      // answer "did we ask for something we already had?", and gone the
      // moment the first answer lands.
      chatLedgerBefore.current = ledgerRef.current;
      const result = await startBbsRun({
        askUser: askUserOf(request.session),
        memberMark: request.memberMark,
        priorAnswers: request.priorAnswers,
        attachments: request.attachments,
      });
      // integration seam: when the engine reports the userFacts a MODEL
      // relayed (SEAM 1), they arrive here and the panel traces every one
      // against the transcript before applying it. Until then a run relays
      // nothing and the only user values in play are the ones typed in the
      // thread — which are traced on the same path regardless.
      return { result, relayed: [] };
    },
    [startBbsRun],
  );

  // ---- R3: split-on-import jobs -------------------------------------------

  const splitByDoc = useMemo(() => {
    const map = new Map<string, DocSplitView>();
    for (const s of session.sheets) {
      const docId = s.doc.id;
      const job = splitJobFor(docId);
      const pkg = packages.find((p) => p.documentId === docId) ?? null;
      const hash = docHashes.get(docId);
      const stale = !!(pkg && hash && stalenessOf(pkg, hash).stale);
      let status: SplitStatus | null = null;
      if (job && job.status !== 'split') status = job.status;
      else if (pkg) status = stale ? 'stale' : 'split';
      else if (job) status = 'split';
      map.set(docId, { status, pkg, unexplainedGap: pkg ? hasUnexplainedGap(pkg) : false });
    }
    return map;
    // splitVersion invalidates on every job event
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sheets, session.version, packages, docHashes, splitVersion]);

  const refreshPackages = useCallback(() => {
    void loadPackages(projectId).then(setPackages);
  }, [projectId]);

  const splitBlocked = isAiConfigured()
    ? null
    : 'No OpenRouter key found. Reading a drawing spends model calls (~$0.007 per drawing) and cannot run without one — set VITE_OPENROUTER_API_KEY in .env and restart the dev server.';

  /**
   * WRITE THE READING DOWN, THE MOMENT THE SECTIONS EXIST.
   *
   * The About Drawing note used to be written only at the end of a BBS run, so
   * a drawing read seven sections deep still said "Nothing on file yet" in the
   * Specification — and every later run went back to the model for text,
   * dimensions and callouts that were already on the sheet and already cut
   * into sections.
   *
   * Nothing here calls a model. Every line of it is read out of the DXF.
   */
  const writeAboutDrawing = useCallback(
    async (doc: CadDocument, pkg: DrawingUnderstandingPackage) => {
      try {
        const entry = entries.find((e) => e.documentId === doc.id);
        const memory = buildAboutDrawingMemory({
          documentId: doc.id,
          drawingName: doc.name,
          sourceDrawingHash: pkg.sourceDrawingHash,
          // No outcome: this is the READING, not a take-off. A BBS run later
          // rewrites this note with its conclusions folded in.
          pkg,
          doc,
        });
        await saveProjectArtifact({
          projectId,
          documentId: doc.id,
          kind: 'about',
          drawingName: doc.name,
          drawingNumber: entry?.drawingNumber ?? '',
          revision: entry?.revision ?? '',
          mimeType: 'application/json',
          content: JSON.stringify(memory),
        });
        // No refresh needed: `saveProjectArtifact` emits to its own
        // subscribers, and `useProjectArtifacts` is one of them.
      } catch {
        // The note is a record OF the read, never part of it: a failed write
        // must not turn a successful split into a failure.
      }
    },
    [projectId, entries],
  );

  const runSplitFor = useCallback(
    (documentId: string) => {
      const sheet = cadSheets().find((s) => s.doc.id === documentId);
      if (!sheet) {
        notify('That drawing is not loaded in this project.', 'warn');
        return;
      }
      void runSplit(projectId, sheet.doc).then((pkg) => {
        if (pkg) {
          notify(
            `Split into ${pkg.sections.length} section${pkg.sections.length === 1 ? '' : 's'} — filed under the drawing (${splitCostLine(splitJobFor(documentId)!)}).`,
            'ok',
          );
          void writeAboutDrawing(sheet.doc, pkg);
          refreshPackages();
        } else {
          const job = splitJobFor(documentId);
          if (job?.status === 'failed' && job.error) notify(`Split failed: ${job.error}`, 'warn');
        }
      });
    },
    [projectId, notify, refreshPackages, writeAboutDrawing],
  );

  /**
   * SECOND PASS — read the unread leftovers of a drawing that is already split.
   *
   * Separate from the split, and re-runnable: it re-reads only the leftovers,
   * never re-cuts a section. A drawing with no package cannot have one, and
   * says so rather than quietly starting a split the user did not ask for.
   */
  const readResidualsFor = useCallback(
    (documentId: string) => {
      const sheet = cadSheets().find((s) => s.doc.id === documentId);
      const pkg = splitByDoc.get(documentId)?.pkg;
      if (!sheet || !pkg) {
        notify('That drawing has not been split yet — read it first.', 'warn');
        return;
      }
      void runSecondPass(projectId, sheet.doc, pkg).then((next) => {
        if (next) {
          const list = next.residuals ?? [];
          const read = list.filter((r) => r.status === 'read').length;
          notify(
            list.length
              ? `Second pass — read ${read} of ${list.length} unread part${list.length === 1 ? '' : 's'} (${splitCostLine(splitJobFor(documentId)!)}).`
              : 'Second pass — nothing was left unread.',
            'ok',
          );
          // The reading is only finished once the leftovers have been read, so
          // the note is rewritten here too — same deterministic pass, now over
          // whatever the second pass folded into a region.
          const sheet2 = cadSheets().find((s) => s.doc.id === documentId);
          if (sheet2) void writeAboutDrawing(sheet2.doc, next);
          refreshPackages();
        } else {
          const job = splitJobFor(documentId);
          if (job?.status === 'failed' && job.error) notify(`Second pass failed: ${job.error}`, 'warn');
        }
      });
    },
    [projectId, notify, refreshPackages, splitByDoc, writeAboutDrawing],
  );

  /**
   * STEP 8 — validate every section of a drawing that has been split.
   *
   * Runs the deterministic checks always; escalates only what they could not
   * settle, and only when a key is configured. A drawing with no package
   * cannot be validated and says so rather than quietly starting a split.
   */
  const validateFor = useCallback(
    (documentId: string, deep = false) => {
      const sheet = cadSheets().find((s) => s.doc.id === documentId);
      const pkg = splitByDoc.get(documentId)?.pkg;
      if (!sheet || !pkg) {
        notify('That drawing has not been split yet — read it first.', 'warn');
        return;
      }
      void runValidation(projectId, sheet.doc, pkg, deep).then((next) => {
        if (next) {
          const v = next.validations ?? [];
          const bad = v.filter((x) => x.status !== 'PASS').length;
          notify(
            bad
              ? `${bad} of ${v.length} section${v.length === 1 ? '' : 's'} need a look — see the Sections list.`
              : `All ${v.length} sections match the drawing they were cut from.`,
            bad ? 'warn' : 'ok',
          );
          refreshPackages();
        } else {
          const job = splitJobFor(documentId);
          if (job?.status === 'failed' && job.error) notify(`Validation failed: ${job.error}`, 'warn');
        }
      });
    },
    [projectId, notify, refreshPackages, splitByDoc],
  );

  const pendingSplitDocs = useMemo(
    () =>
      session.sheets
        .filter((s) => {
          const view = splitByDoc.get(s.doc.id);
          return !view?.pkg && splitJobFor(s.doc.id)?.status !== 'splitting';
        })
        .map((s) => s.doc.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.sheets, splitByDoc, splitVersion],
  );

  // "Split all" — the explicit bulk act (open question 1). Sequential, so the
  // cost line grows one drawing at a time and a failure stops nothing else.
  const runAllSplits = useCallback(() => {
    void (async () => {
      for (const docId of pendingSplitDocs) {
        const sheet = cadSheets().find((s) => s.doc.id === docId);
        if (!sheet) continue;
        const pkg = await runSplit(projectId, sheet.doc);
        if (pkg) refreshPackages();
      }
    })();
  }, [pendingSplitDocs, projectId, refreshPackages]);

  // Auto-split ONLY the drawing the user OPENS (open question 1's leaning).
  // Never on page load — boot opens no sheets (§2.3) — and never again after
  // a failure: a failed run waits for an explicit Split press. A drawing with
  // a saved package loads it and spends nothing; a stale one waits for an
  // explicit Re-split, because re-spending on every open of an old sheet is
  // exactly the silent cost this job exists to surface.
  useEffect(() => {
    if (!isAiConfigured()) return;
    const active = session.sheets.find((s) => s.id === shell.sheets.active);
    if (!active) return;
    const docId = active.doc.id;
    const job = splitJobFor(docId);
    if (job && job.status !== 'queued') return;
    if (packages.some((p) => p.documentId === docId)) return;
    runSplitFor(docId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell.sheets.active, session.version, packages, splitVersion, runSplitFor]);

  const sectionsByDoc = useMemo(() => {
    const out: Record<string, SheetSectionsInfo> = {};
    for (const [docId, view] of splitByDoc) {
      const job = splitJobFor(docId);
      const pkg = view.pkg;
      if (!job && !pkg) continue;
      // The user-facing word for a split is READING: the model reads the
      // drawing and files what it finds. "Split"/"re-split" is the mechanism's
      // name and meant nothing to anyone holding a drawing.
      let statusLine = 'not read yet';
      switch (view.status) {
        case 'queued':
          statusLine = 'queued — this drawing is read when it is opened';
          break;
        case 'splitting':
          statusLine = 'reading the drawing…';
          break;
        case 'failed':
          statusLine = 'could not be read';
          break;
        case 'stale':
          statusLine = 'the drawing changed since it was last read';
          break;
        case 'split':
          statusLine = `read — ${pkg?.sections.length ?? job?.sectionCount ?? 0} sections`;
          break;
      }
      out[docId] = {
        status: view.status,
        statusLine,
        costLine: job && (job.rounds > 0 || job.costUsd > 0 || job.startedAt) ? splitCostLine(job) : null,
        error: job?.error ?? null,
        progressTail: job?.status === 'splitting' ? job.progress.slice(-3) : [],
        count: pkg ? pkg.sections.length : null,
        coverageLine: pkg ? coverageLineFor(pkg.coverage) : null,
        residual: pkg ? residualFor(pkg) : [],
        unexplainedGap: view.unexplainedGap,
        gaps: pkg ? gapClustersFor(docId, pkg) : [],
        // THE DETAILS, not the clusters. Grouped from the regions the splitter
        // cut and the gaps it could not place, by what they describe — a
        // shared member mark, the same subject ("PLAN - PEDESTAL P1" and
        // "SECTION A-A - PEDESTAL P1" are two views of one pedestal), or a
        // gap touching a detail. Proximity alone never merges two details
        // that each say who they are.
        logicalSections: pkg
          ? (() => {
              const final = finalizationFor(docId, pkg);
              const gaps = gapClustersFor(docId, pkg);
              const asRegion = (b: { xMin: number; yMin: number; xMax: number; yMax: number }) => ({
                x1: b.xMin,
                y1: b.yMin,
                x2: b.xMax,
                y2: b.yMax,
              });
              const { sections } = groupRegions([
                ...final.regions.map((r) => ({
                  id: r.sectionId,
                  label: r.label,
                  kind: r.kind,
                  evidenceIds: r.entityIds,
                  bounds: asRegion(r.bounds),
                })),
                ...gaps.map((g) => ({
                  id: g.id,
                  kind: 'gap',
                  evidenceIds: [] as string[],
                  bounds: asRegion(g.bounds),
                  isGap: true,
                  joins: g.touches,
                })),
              ]);
              return sections.map((s) => ({
                id: s.id,
                ...(s.title ? { title: s.title } : {}),
                kind: s.kind,
                marks: s.marks,
                regionIds: s.regionIds,
                relation: s.relation,
                basis: s.basis,
              }));
            })()
          : [],
        sections: pkg
          ? (() => {
              const ink = sectionInkMap(docId, pkg);
              // The FINAL regions — bounds grown by anything the second pass
              // proved belongs to them, plus any piece that earned a region of
              // its own. The row and the box on the drawing must agree, and
              // they only do if both come from here.
              const final = finalizationFor(docId, pkg);
              // Keyed by the ORIGINAL section id — validation runs on the
              // snapshot the first pass filed, and a merged duplicate keeps
              // its own verdict under the id it was checked as.
              const verdicts = new Map((pkg.validations ?? []).map((v) => [v.sectionId, v]));
              return final.regions.map((s) => ({
                sheetId: sectionSheetId(docId, s.sectionId),
                sectionId: s.sectionId,
                label: s.label,
                kind: s.kind,
                entityCount: s.entityIds.length,
                bounds: { ...s.bounds },
                attached: s.attached,
                source: s.source,
                ...(verdicts.has(s.sectionId)
                  ? {
                      verdict: {
                        status: verdicts.get(s.sectionId)!.status,
                        confidence: verdicts.get(s.sectionId)!.confidence,
                        reasons: verdicts
                          .get(s.sectionId)!
                          .mismatches.slice(0, 4)
                          .map((m) => `${m.type}: ${m.reason}`),
                      },
                    }
                  : {}),
                ...(ink.get(s.sectionId) ?? { renderable: 0, hidden: 0 }),
              }));
            })()
          : [],
      };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitByDoc, splitVersion]);

  // ---- assemble -----------------------------------------------------------

  return useMemo<StudioData>(() => {
    const sheets: Record<string, StudioSheet> = {};
    const entryByDoc = new Map(entries.map((e) => [e.documentId, e] as const));
    for (const s of session.sheets) {
      // EVERY section the read filed, drawn on the sheet it was cut from. No
      // hover, no selection, no filtering — if the section exists, it is
      // highlighted. The bounds go through untouched; the sheet renderer maps
      // them with the same transform it maps the geometry with.
      const pkg = packages.find((p) => p.documentId === s.doc.id) ?? null;
      // THE FINAL STATE, not the raw first-pass sets. A region's box is its
      // bounds AFTER anything proven to belong to it has been merged in, and
      // the amber list is only what is genuinely still unresolved — so an
      // entity can never be drawn blue and orange at the same time.
      const final = pkg ? finalizationFor(s.doc.id, pkg) : null;
      const unresolvedIds = new Set(final?.unresolved.map((r) => r.gapId) ?? []);
      const highlights: SheetHighlight[] = pkg
        ? [
            ...final!.regions.map((sec) => ({
              id: sec.sectionId,
              // A NEW region's label already names the piece it was made from
              // ("title · GAP-06"), so appending its attachments printed
              // "title · GAP-06 + GAP-06" on the drawing. Only a region that
              // ABSORBED something says so.
              label:
                sec.source === 'residual-second-pass' || !sec.attached.length
                  ? sec.label
                  : `${sec.label} + ${sec.attached.join(', ')}`,
              bounds: sec.bounds,
              kind: 'read' as const,
            })),
            // GEOMETRY A REGION OWNS BUT CANNOT REACH, drawn where it is.
            //
            // An attached residual too far from its region to grow its box was
            // owned, counted, and drawn nowhere: two of the four column marks
            // on the layout plan were read and attached and still looked
            // exactly like geometry nobody had ever seen. It is blue, because
            // it was read; it is its own box, because stretching the region to
            // reach it is what washed a whole sheet blue.
            ...final!.regions.flatMap((sec) =>
              sec.detached.map((d) => ({
                id: `${sec.sectionId}+${d.gapId}`,
                label: `${sec.sectionId} · ${d.gapId}`,
                bounds: d.bounds,
                kind: 'read' as const,
              })),
            ),
            // Only what is STILL unread keeps an amber outline. A piece the
            // second pass resolved is gone from here entirely — it is inside a
            // region's box now, and drawing it twice is the contradiction.
            ...gapClustersFor(s.doc.id, pkg)
              .filter((g) => !pkg.residuals?.length || unresolvedIds.has(g.id))
              .map((g) => ({
                id: g.id,
                label: g.touches.length ? `unread · joins ${g.touches.join(', ')}` : 'unread · independent',
                bounds: g.bounds,
                kind: 'gap' as const,
              })),
          ]
        : [];
      // EVERY MARK THAT REACHES THE SHEET, and how big it is.
      //
      // The one number that matters is the last: a mark covering most of the
      // sheet is a read region that has been stretched, not a region anybody
      // cut, and it washes the whole drawing blue.
      if (import.meta.env?.MODE !== 'test' && highlights.length && final) {
        const sh = pkg!.sheetExtents;
        const area = sh ? (sh.xMax - sh.xMin) * (sh.yMax - sh.yMin) : 0;
        // eslint-disable-next-line no-console
        console.log(
          [
            `MARKS ON ${s.doc.name}`,
            ...highlights.map((h) => {
              const r = final.regions.find((x) => x.sectionId === h.id);
              const w = h.bounds.xMax - h.bounds.xMin;
              const ht = h.bounds.yMax - h.bounds.yMin;
              const share = area > 0 ? ((w * ht) / area) * 100 : 0;
              return (
                `  ${h.id.padEnd(12)} ${h.kind === 'gap' ? 'GAP  ' : 'READ '}` +
                `${h.kind === 'gap' ? '#fb923c dashed' : 'rgba(14,165,233,.3) / #38bdf8'}  ` +
                `src=${r?.source ?? 'gap-cluster'}  ` +
                `bounds=${Math.round(h.bounds.xMin)},${Math.round(h.bounds.yMin)} → ` +
                `${Math.round(h.bounds.xMax)},${Math.round(h.bounds.yMax)}  ` +
                `${Math.round(w)}×${Math.round(ht)}mm  ${share.toFixed(1)}% of sheet` +
                (share > 60 ? '   ← COVERS THE SHEET' : '')
              );
            }),
          ].join('\n'),
        );
      }
      sheets[s.id] = cadStudioSheet(
        s,
        entryByDoc.get(s.doc.id),
        docsWithSchedule.has(s.doc.id),
        highlights,
      );
    }
    for (const p of pdfEntries) sheets[p.id] = pdfStudioSheet(p);

    // open section sheets — built lazily from the package + the parent doc
    for (const id of shell.sheets.open) {
      if (sheets[id]) continue;
      const ref = parseSectionSheetId(id);
      if (!ref) continue;
      const pkg = packages.find((p) => p.documentId === ref.documentId);
      const section = pkg?.sections.find((x) => x.sectionId === ref.sectionId);
      const parent = session.sheets.find((sh) => sh.doc.id === ref.documentId);
      if (!pkg || !section || !parent) continue;
      sheets[id] = sectionStudioSheet(id, pkg, section, parent, entryByDoc.get(ref.documentId));
    }

    return {
      projectName: project.name,
      groups: buildGroups(entries, sheetByDoc, pdfEntries, artifacts, splitByDoc, userFolders),
      sheets,
      scheduleRows,
      scheduleVersion,
      ...(scheduleResult ? { scheduleResult } : {}),
      ...(scheduleVersionNo ? { scheduleVersionNo } : {}),
      scheduleProvenance: chatProvenance(),
      actions: {
        importDrawing,
        downloadArtifact,
        bbsEditorGrid,
        saveBbsEdits,
        deleteDrawing,
        renameDrawing,
        createFolder: createUserFolder,
        renameFolder: renameUserFolder,
        deleteFolder: deleteUserFolder,
        fileInFolder,
        moveToFolder,
        deleteArtifact,
        deletePdf,
        renamePdf,
        deletePdfBatch,
        renamePdfBatch,
      },
      bbs: {
        blocked: bbsBlocked,
        running: bbs.running,
        progress: bbs.progress,
        stats: bbs.stats,
        error: bbs.error,
        run: runBbs,
        pendingQuestions: bbsInterviewSnapshot?.pending ?? [],
        answerQuestion: (questionId, raw) =>
          bbsInterview.current?.answer(questionId, raw) ?? { ok: false, error: 'there is no active BBS interview' },
        skipQuestion: (questionId, said) =>
          bbsInterview.current?.skip(questionId, said) ?? { ok: false, error: 'there is no active BBS interview' },
        answersSince: bbsAnswersSince,
        staleFacts: bbsStaleFacts,
        lifecycleStatus: bbsLifecycleStatus,
        manifest: bbs.manifest,
        factsUsed: bbs.factsUsed,
        lastCostLine: bbs.costLine,
        questionsFiled: bbs.questionsFiled,
        ...(interviewLogs.length
          ? {
              interviewLogCount: interviewLogs.length,
              downloadInterviewLog: () => {
                downloadBytes(
                  interviewLogsMarkdown(interviewLogs, project.name),
                  `${project.name.replace(/[^a-z0-9_-]+/gi, '-')}-interview-log.md`,
                  'text/markdown;charset=utf-8',
                );
              },
            }
          : {}),
      },
      ask: { blocked: askBlocked, ask, ...askRun },
      chat: {
        // a chat run IS a BBS run — it is blocked by exactly the same things
        blocked: bbsBlocked,
        running: bbs.running,
        start: chatStart,
        adaptRows: chatAdaptRows,
        recordAnswers: chatRecordAnswers,
        logInterview: (session, outcome) =>
          fileInterviewLog(session, chatLedgerBefore.current ?? ledgerRef.current, outcome),
        provenance: chatProvenance,
      },
      split: {
        blocked: splitBlocked,
        run: runSplitFor,
        runAll: runAllSplits,
        pendingAll: pendingSplitDocs.length,
        readResiduals: readResidualsFor,
        validate: validateFor,
      },
      sectionsByDoc,
      facts: {
        loaded: ledgerLoaded,
        ledger,
        answer: answerFact,
        override: overrideFactAction,
        withdraw: withdrawFactAction,
        open: openFactSource,
        exportCsv: exportSpecCsv,
        aboutDrawing: activeAboutDrawing
          ? {
              drawingName: activeAboutDrawing.drawingName,
              updatedAt: activeAboutDrawing.updatedAt,
              note: activeAboutDrawing.note,
              conclusionCount: activeAboutDrawing.conclusions.length,
              sectionNotes: activeAboutDrawing.sectionNotes.map((s) => ({
                sectionId: s.sectionId,
                label: s.label,
                kind: s.kind,
                note: s.note,
                ...(s.detail ? { detail: s.detail } : {}),
              })),
            }
          : null,
      },
      revision: {
        latest: impacts[0] ?? null,
        showReport: showImpact,
        dismissReport: () => setShowImpact(false),
      },
      search: {
        query: searchProject,
        goTo: goToHit,
      },
    };
  }, [
    project.name,
    entries,
    session.version,
    session.sheets,
    pdfEntries,
    packages,
    artifacts,
    userFolders,
    createUserFolder,
    renameUserFolder,
    deleteUserFolder,
    fileInFolder,
    sheetByDoc,
    shell.sheets.open,
    splitByDoc,
    sectionsByDoc,
    splitBlocked,
    runSplitFor,
    runAllSplits,
    pendingSplitDocs,
    scheduleRows,
    scheduleVersion,
    scheduleResult,
    scheduleVersionNo,
    docsWithSchedule,
    importDrawing,
    deleteDrawing,
    renameDrawing,
    deleteArtifact,
    deletePdf,
    renamePdf,
    deletePdfBatch,
    renamePdfBatch,
    chatStart,
    chatAdaptRows,
    chatRecordAnswers,
    chatProvenance,
    bbsBlocked,
    bbs.running,
    bbs.progress,
    bbs.stats,
    bbs.error,
    bbs.factsUsed,
    bbs.costLine,
    bbs.questionsFiled,
    bbsAnswersSince,
    bbsInterviewSnapshot,
    runBbs,
    askBlocked,
    ask,
    ledger,
    ledgerLoaded,
    activeAboutDrawing,
    answerFact,
    overrideFactAction,
    withdrawFactAction,
    openFactSource,
    exportSpecCsv,
    impacts,
    showImpact,
    searchProject,
    goToHit,
  ]);
}
