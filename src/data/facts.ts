// ============================================================
// The fact ledger, in Postgres.
//
// The ledger is APPEND-ONLY and that property is the whole point: a corrected
// dimension does not overwrite the reading it replaces, it supersedes it, and
// the superseded entry keeps its provenance and its reason. A schedule can
// then say which VERSION of which fact it was computed from, and a person can
// see that "F8.length was read as 1400, then answered as 3500" rather than
// just "F8.length is 3500".
//
// So the mapping is entry-for-row, not fact-for-row: `entry_seq` is the
// ledger's own sequence number and `version` is `entry_seq + 1`, which makes
// the unique key (project, fact_key, version) exactly the ledger's identity.
// `rowToEntry(factToRow(entry))` is the identity function, and there is a test
// that says so — a history that does not round-trip is a history nobody can
// rely on.
//
// NOTHING HERE KNOWS A MEMBER NAME. `fact_key` is whatever the ledger wrote:
// "F8.length" on a footing sheet, "PB03.span" on a beam sheet,
// "settings.cover" for the project. The columns are member/parameter, split
// from the key.
// ============================================================
import type { Ledger, LedgerEntry } from '../facts/ledger';
import { entryRef } from '../facts/ledger';
import { factName, factSubject, type Fact, type FactSource, type FactState, type FactValue } from '../facts/types';
import { semanticTypeOf, sourceTypeOf } from '../facts/dataFact';
import { supabase } from '../lib/supabase';
import { describeDbError, requireUserId } from './session';
import { remoteDrawingIdFor } from './drawings';
import { remoteSectionIdFor } from './sections';

export interface FactRow {
  project_id: string;
  drawing_id: string | null;
  section_id: string | null;
  user_id: string;
  fact_key: string;
  member_id: string | null;
  parameter: string;
  value: FactValue;
  unit: string | null;
  semantic_type: string | null;
  source_type: string;
  source_text: string | null;
  source_entity_handles: string[];
  source: FactSource | null;
  drawing_hash: string | null;
  confidence: number | null;
  status: string;
  ask: string | null;
  needed_for: string[];
  looked_in: string[];
  said_as: string | null;
  supplied_by: string | null;
  entry_seq: number;
  evidence: string[];
  method: string | null;
  basis: string | null;
  depends_on: string[];
  read_on: string | null;
  state: string | null;
  contradicts: string | null;
  contradicted_by: string[];
  contradicted: boolean;
  disputed_because: string | null;
  stale: boolean;
  superseded_ref: string | null;
  superseded_reason: string | null;
  superseded_at: string | null;
  recorded_at: string | null;
  version: number;
}

const COLUMNS =
  'project_id,drawing_id,section_id,user_id,fact_key,member_id,parameter,value,unit,semantic_type,source_type,' +
  'source_text,source_entity_handles,source,drawing_hash,confidence,status,ask,needed_for,looked_in,' +
  'said_as,supplied_by,entry_seq,evidence,method,basis,depends_on,read_on,state,contradicts,' +
  'contradicted_by,contradicted,disputed_because,stale,superseded_ref,superseded_reason,superseded_at,' +
  'recorded_at,version';

/** The DataFact status vocabulary, from what the ledger says about the entry. */
function statusOf(fact: Fact): string {
  if (fact.supersededBy !== undefined) return 'SUPERSEDED';
  if (fact.contradicted === true) return 'UNREADABLE';
  if (fact.state === 'MISSING') return 'MISSING';
  if (fact.stale === true) return 'STALE';
  return 'VALID';
}

function confidenceOf(fact: Fact): number {
  if (fact.contradicted === true || fact.state === 'MISSING') return 0;
  if (fact.state === 'SUPPLIED' || fact.state === 'DECLARED') return 1;
  if (fact.state === 'MEASURED') return (fact.evidence?.length ?? fact.source?.handles?.length ?? 0) > 0 ? 0.9 : 0.75;
  return 0.8;
}

const iso = (ms: number | undefined): string | null =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

const ms = (text: string | null): number | undefined => {
  if (!text) return undefined;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : undefined;
};

export interface FactContext {
  projectId: string;
  userId: string;
  /**
   * The document that was open when this ledger was written — a FALLBACK,
   * and the one that matters for answers.
   *
   * A ledger is project-wide and its entries do not share a drawing: a
   * reading off the footing sheet, an answer typed about the beam sheet and
   * `settings.cover` sit side by side in it. So the drawing is resolved per
   * fact from its own provenance first.
   *
   * A SUPPLIED fact has no `source` and must not be given one — §7.1 keeps a
   * person's answer and a reading of the sheet apart, and `source` would
   * claim the drawing SAYS this. But `drawing_id` is not that claim; it is
   * "which drawing does this fact belong to", and for an answer the drawing
   * it was asked on is the honest answer. `source_type` beside it already
   * records that it was USER_INPUT rather than read.
   */
  documentId?: string | null;
}

/**
 * Which drawing row this fact belongs to, and which section of it.
 *
 * Both were null in every row this app has ever written, for two different
 * reasons. `drawing_id` was taken from a ledger-wide context nobody ever
 * passed, so it defaulted to null forever; `section_id` was not written at
 * all, and could not have been — `drawing_sections` had no rows to reference
 * until the split started filing them.
 *
 * A fact's `source` already carries both (`documentId`, `sectionId`), because
 * that is what the reader recorded when it read it. This turns those into the
 * ids the columns want, and answers null honestly when the fact genuinely has
 * no drawing — a project setting is not a reading off a sheet.
 */
function provenanceOf(fact: Fact, ctx: FactContext): { drawingId: string | null; sectionId: string | null } {
  const documentId = fact.source?.documentId ?? ctx.documentId ?? null;
  return {
    drawingId: remoteDrawingIdFor(documentId),
    // The SECTION only ever comes from the fact's own source. Falling back to
    // the open document would be meaningless — a document is not a section —
    // and guessing one would put a reading in a part of the sheet it was
    // never read from.
    sectionId: remoteSectionIdFor(documentId, fact.source?.sectionId),
  };
}

export function factToRow(entry: LedgerEntry, ctx: FactContext): FactRow {
  const fact = entry.fact;
  const parameter = factName(fact.id) || fact.id;
  const provenance = provenanceOf(fact, ctx);
  return {
    project_id: ctx.projectId,
    drawing_id: provenance.drawingId,
    section_id: provenance.sectionId,
    user_id: ctx.userId,
    fact_key: fact.id,
    member_id: factSubject(fact.id),
    parameter,
    value: fact.value,
    unit: fact.unit ?? null,
    semantic_type: semanticTypeOf(parameter, fact.unit),
    source_type: sourceTypeOf(fact),
    source_text: fact.source?.rawText ?? fact.saidAs ?? null,
    source_entity_handles: [...(fact.source?.handles ?? fact.evidence ?? [])],
    source: fact.source ?? null,
    drawing_hash: fact.sourceDrawingHash ?? null,
    confidence: confidenceOf(fact),
    status: statusOf(fact),
    ask: fact.ask ?? null,
    needed_for: [...(fact.neededFor ?? [])],
    looked_in: [...(fact.lookedIn ?? [])],
    said_as: fact.saidAs ?? null,
    supplied_by: fact.suppliedBy ?? null,
    entry_seq: entry.seq,
    evidence: [...(fact.evidence ?? [])],
    method: fact.method ?? null,
    basis: fact.basis ?? null,
    depends_on: [...(fact.dependsOn ?? [])],
    read_on: fact.readOn ?? null,
    state: fact.state,
    contradicts: fact.contradicts ?? null,
    contradicted_by: [...(fact.contradictedBy ?? [])],
    contradicted: fact.contradicted === true,
    disputed_because: fact.disputedBecause ?? null,
    stale: fact.stale === true,
    superseded_ref: fact.supersededBy ?? null,
    superseded_reason: fact.supersededReason ?? null,
    superseded_at: iso(fact.supersededAt),
    recorded_at: iso(fact.recordedAt),
    version: entry.seq + 1,
  };
}

export function rowToEntry(row: FactRow): LedgerEntry {
  // Only fields the ledger actually had are put back. Spreading an
  // `undefined` in would turn "this fact never had a method" into "this fact
  // has a method of undefined", and the round-trip test would fail on it —
  // which is exactly the point of writing it this way.
  const fact: Fact = {
    id: row.fact_key,
    value: row.value,
    state: (row.state ?? 'MISSING') as FactState,
    readOn: row.read_on ?? '',
    ...(row.unit !== null ? { unit: row.unit } : {}),
    ...(row.source ? { source: row.source } : {}),
    ...(row.evidence.length ? { evidence: row.evidence } : {}),
    ...(row.method !== null ? { method: row.method } : {}),
    ...(row.basis !== null ? { basis: row.basis } : {}),
    ...(row.needed_for.length ? { neededFor: row.needed_for } : {}),
    ...(row.looked_in.length ? { lookedIn: row.looked_in } : {}),
    ...(row.ask !== null ? { ask: row.ask } : {}),
    ...(row.supplied_by !== null ? { suppliedBy: row.supplied_by } : {}),
    ...(row.said_as !== null ? { saidAs: row.said_as } : {}),
    ...(row.drawing_hash !== null ? { sourceDrawingHash: row.drawing_hash } : {}),
    ...(row.stale ? { stale: true } : {}),
    ...(row.contradicts !== null ? { contradicts: row.contradicts } : {}),
    ...(row.contradicted_by.length ? { contradictedBy: row.contradicted_by } : {}),
    ...(row.superseded_ref !== null ? { supersededBy: row.superseded_ref } : {}),
    ...(row.superseded_reason !== null
      ? { supersededReason: row.superseded_reason as NonNullable<Fact['supersededReason']> }
      : {}),
    ...(row.contradicted ? { contradicted: true } : {}),
    ...(row.disputed_because !== null ? { disputedBecause: row.disputed_because } : {}),
    ...(row.depends_on.length ? { dependsOn: row.depends_on } : {}),
  };
  const recordedAt = ms(row.recorded_at);
  if (recordedAt !== undefined) fact.recordedAt = recordedAt;
  const supersededAt = ms(row.superseded_at);
  if (supersededAt !== undefined) fact.supersededAt = supersededAt;
  return { seq: row.entry_seq, fact };
}

/** The ledger as the database holds it, in the ledger's own order. */
export async function loadLedgerRemote(projectId: string): Promise<Ledger> {
  const { data, error } = await supabase()
    .from('data_facts')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .order('entry_seq', { ascending: true });
  if (error) throw new Error(describeDbError(error, 'Loading the project specification'));
  // Cast through unknown: the column list is assembled at runtime, so the
  // client cannot infer a row type from it and falls back to its error shape.
  return { entries: ((data ?? []) as unknown as FactRow[]).map(rowToEntry) };
}

/**
 * Write the ledger back.
 *
 * Every entry is upserted rather than only the new ones: an existing entry
 * CHANGES when a later claim supersedes or contradicts it, so an append-only
 * write would leave the old row saying it is still current. Ledgers are tens
 * to hundreds of entries, so one upsert of the whole thing is both correct
 * and cheap — and it is idempotent, which matters when a save is retried.
 */
export async function saveLedgerRemote(
  projectId: string,
  ledger: Ledger,
  opts: { documentId?: string | null } = {},
): Promise<void> {
  if (!ledger.entries.length) return;
  const userId = await requireUserId();
  const rows = ledger.entries.map((entry) =>
    factToRow(entry, { projectId, userId, documentId: opts.documentId ?? null }),
  );
  const { error } = await supabase()
    .from('data_facts')
    .upsert(rows, { onConflict: 'project_id,fact_key,version' });
  if (error) throw new Error(describeDbError(error, 'Saving the project specification'));
}

/**
 * The CURRENT facts as DataFacts — what a schedule is allowed to compute with.
 * Superseded entries stay in the table for audit; they are not offered here.
 */
export async function currentFactRows(projectId: string): Promise<FactRow[]> {
  const { data, error } = await supabase()
    .from('data_facts')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .is('superseded_ref', null)
    .order('fact_key', { ascending: true });
  if (error) throw new Error(describeDbError(error, 'Loading the project facts'));
  return (data ?? []) as unknown as FactRow[];
}

export { entryRef };
