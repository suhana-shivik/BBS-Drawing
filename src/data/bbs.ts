// ============================================================
// Schedules, in Postgres.
//
// A run is stored with WHAT IT WAS COMPUTED FROM, not just what it came to:
// the drawing and its hash, the fact versions, the per-row dependency map, the
// settings actually spent, the snapshot lines and the reconciliation. That is
// what makes a stored schedule auditable a month later, and what lets a
// changed fact name exactly the rows it invalidates without recomputing
// anything.
//
// A row is stored with its whole trace — the stage it reached, the fact it is
// waiting on, the source text and entity handles it was read from, the
// substituted arithmetic. `bbs_rows` is therefore not a copy of the
// spreadsheet; it is the derivation.
//
// GENERIC. `member_id` and `bar_mark` are text, `fact_ids` is text[]. Nothing
// here knows what kind of member it is looking at.
// ============================================================
import type { BbsChatResult, BbsChatRow } from '../cad/bbs/chatResult';
import type { BBSBuildManifest } from '../core/bbs/schemas';
import { supabase } from '../lib/supabase';
import { describeDbError, requireUserId, unwrap } from './session';

export type RunStatus =
  | 'DRAFT'
  | 'STALE'
  | 'REBUILDING'
  | 'CALCULATED'
  | 'VALIDATING'
  | 'FINAL'
  | 'BLOCKED'
  | 'FAILED';

/** The row's own word for what happened to it, in the schedule's vocabulary. */
export function rowStatusOf(row: BbsChatRow): 'CALCULATED' | 'INFERRED' | 'BLOCKED' {
  if (row.status === 'unavailable') return 'BLOCKED';
  if (row.status === 'inferred') return 'INFERRED';
  return 'CALCULATED';
}

/**
 * The status of a whole run, from its rows.
 *
 * BLOCKED only when NOTHING could be computed — a schedule with some open
 * rows is CALCULATED and says how many are open, because calling it blocked
 * would throw away the part that is usable.
 */
export function runStatusOf(result: BbsChatResult): RunStatus {
  const rows = result.rows ?? [];
  if (!rows.length) return 'BLOCKED';
  const open = rows.filter((r) => r.status === 'unavailable').length;
  if (open === rows.length) return 'BLOCKED';
  if (open > 0) return 'CALCULATED';
  return result.verification?.ok ? 'FINAL' : 'CALCULATED';
}

export interface RunContext {
  projectId: string;
  drawingId?: string | null;
  drawingHash?: string | null;
  userId: string;
}

export interface BbsRowRecord {
  run_id: string;
  project_id: string;
  drawing_id: string | null;
  user_id: string;
  row_index: number;
  member_id: string | null;
  bar_mark: string;
  bar_type: string | null;
  description: string | null;
  shape_code: string | null;
  dia_mm: number | null;
  spacing_mm: number | null;
  cover_mm: number | null;
  cover_status: string | null;
  bars_per_member: number | null;
  member_count: number | null;
  total_bars: number | null;
  cutting_length_mm: number | null;
  total_length_m: number | null;
  unit_weight_kg_per_m: number | null;
  weight_kg: number | null;
  weight_with_wastage_kg: number | null;
  length_source: string | null;
  quantity_method: string | null;
  unit_weight_method: string | null;
  formula: string | null;
  working: string[];
  source_text: string | null;
  source_entity_handles: string[];
  fact_ids: string[];
  stage: string | null;
  failed_stage: string | null;
  missing_fact: string | null;
  reason: string | null;
  action: string | null;
  status: string;
  drawing_hash: string | null;
}

const num = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** One schedule row, with its derivation, as a database row. Pure. */
export function toRowRecord(
  row: BbsChatRow,
  index: number,
  runId: string,
  ctx: RunContext,
): BbsRowRecord {
  const trace = row.trace;
  const stages = trace?.stages ?? [];
  return {
    run_id: runId,
    project_id: ctx.projectId,
    drawing_id: ctx.drawingId ?? null,
    user_id: ctx.userId,
    row_index: index,
    member_id: row.memberMark || null,
    bar_mark: row.barMark,
    bar_type: null,
    description: row.description || null,
    shape_code: null,
    dia_mm: num(row.diameterMm),
    spacing_mm: num(row.spacingMm),
    cover_mm: num(row.coverMm ?? trace?.coverMm),
    cover_status: row.coverStatus ?? trace?.coverStatus ?? null,
    bars_per_member: num(row.barsPerMember),
    member_count: num(row.memberCount),
    total_bars: num(row.totalBars),
    cutting_length_mm: num(row.cuttingLengthMm),
    total_length_m: num(row.totalLengthM),
    unit_weight_kg_per_m: num(row.unitWeightKgPerM),
    weight_kg: num(row.totalWeightKg),
    weight_with_wastage_kg: null,
    length_source: trace?.method?.cuttingLength ?? null,
    quantity_method: trace?.method?.quantity ?? null,
    unit_weight_method: trace?.method?.unitWeight ?? null,
    formula: trace?.formula ?? null,
    working: [...(row.working ?? [])],
    source_text: trace?.sourceText ?? null,
    source_entity_handles: [...(trace?.sourceHandles ?? [])],
    fact_ids: [...(trace?.factsUsed ?? [])],
    stage: stages.length ? stages[stages.length - 1] : null,
    failed_stage: trace?.failedStage ?? null,
    missing_fact: trace?.missingFact ?? null,
    reason: trace?.reason ?? row.note ?? null,
    action: trace?.action ?? null,
    status: rowStatusOf(row),
    drawing_hash: ctx.drawingHash ?? null,
  };
}

export interface SaveRunInput {
  projectId: string;
  drawingId?: string | null;
  drawingHash?: string | null;
  result: BbsChatResult;
  manifest?: BBSBuildManifest | null;
  snapshot?: readonly string[];
  status?: RunStatus;
}

/**
 * File a finished run and its rows, and make it the current schedule for this
 * drawing.
 *
 * The previous current run is demoted rather than deleted — an old schedule is
 * evidence of what was ordered from, and losing it to a rebuild would make the
 * history unauditable. Only ONE run per drawing is `is_current`, so "show me
 * the schedule" can never be ambiguous.
 */
export async function saveRun(input: SaveRunInput): Promise<string> {
  const userId = await requireUserId();
  const ctx: RunContext = {
    projectId: input.projectId,
    drawingId: input.drawingId ?? null,
    drawingHash: input.drawingHash ?? null,
    userId,
  };
  const result = input.result;
  const rows = result.rows ?? [];
  const blocked = rows.filter((r) => r.status === 'unavailable').length;

  if (ctx.drawingId) {
    // Demote first: two current runs for one drawing is a state the reader
    // cannot resolve, and it must not exist even for the width of an insert.
    const { error } = await supabase()
      .from('bbs_calculation_runs')
      .update({ is_current: false })
      .eq('drawing_id', ctx.drawingId)
      .eq('is_current', true);
    if (error) throw new Error(describeDbError(error, 'Filing the schedule'));
  }

  const run = unwrap<{ id: string }>(
    await supabase()
      .from('bbs_calculation_runs')
      .insert({
        project_id: ctx.projectId,
        drawing_id: ctx.drawingId,
        user_id: userId,
        drawing_hash: ctx.drawingHash,
        engine_version: 'calculations/schedule.ts',
        status: input.status ?? runStatusOf(result),
        is_current: true,
        fact_versions: input.manifest?.factVersions ?? {},
        row_deps: input.manifest?.rowDeps ?? [],
        settings: result.settings ?? {},
        snapshot: [...(input.snapshot ?? [])],
        totals: {
          netWeightKg: result.netWeightKg ?? null,
          procurementWeightKg: result.procurementWeightKg ?? null,
        },
        steel_summary: result.diameterSummary ?? [],
        reconciled: result.reconciliation?.ok ?? null,
        reconciliation: result.reconciliation ?? null,
        total_rows: rows.length,
        calculated_rows: rows.length - blocked,
        blocked_rows: blocked,
        result,
      })
      .select('id')
      .single(),
    'Filing the schedule',
  );

  if (rows.length) {
    const records = rows.map((row, i) => toRowRecord(row, i, run.id, ctx));
    const { error } = await supabase().from('bbs_rows').insert(records);
    if (error) throw new Error(describeDbError(error, 'Filing the schedule rows'));
  }
  return run.id;
}

/**
 * Mark every current run whose rows read one of these facts as STALE.
 *
 * Generic by construction: it compares the manifest's own dependency list
 * against the changed ids. No member is named, and none needs to be.
 */
export async function markStaleByFacts(
  projectId: string,
  staleFactIds: readonly string[],
): Promise<number> {
  if (!staleFactIds.length) return 0;
  const { data, error } = await supabase()
    .from('bbs_calculation_runs')
    .select('id,row_deps,status')
    .eq('project_id', projectId)
    .eq('is_current', true);
  if (error) throw new Error(describeDbError(error, 'Checking which schedules are stale'));

  const changed = new Set(staleFactIds);
  const doomed: string[] = [];
  for (const run of (data ?? []) as { id: string; row_deps: { factIds?: string[] }[] | null; status: string }[]) {
    if (run.status === 'STALE') continue;
    const deps = run.row_deps ?? [];
    const touched = deps.some((d) => (d.factIds ?? []).some((id) => changed.has(id)));
    // A run with no recorded dependencies cannot prove it is unaffected, and
    // the safe reading of "cannot prove" is stale.
    if (touched || deps.length === 0) doomed.push(run.id);
  }
  if (!doomed.length) return 0;

  const { error: updateError } = await supabase()
    .from('bbs_calculation_runs')
    .update({ status: 'STALE', stale_fact_ids: [...changed] })
    .in('id', doomed);
  if (updateError) throw new Error(describeDbError(updateError, 'Marking schedules stale'));
  return doomed.length;
}

export interface StoredRun {
  id: string;
  status: RunStatus;
  drawingHash: string | null;
  totalRows: number;
  calculatedRows: number;
  blockedRows: number;
  reconciled: boolean | null;
  snapshot: string[];
  staleFactIds: string[];
  result: BbsChatResult | null;
  createdAt: number;
}

/** The current schedule for a drawing, or null when none has been filed. */
export async function currentRun(drawingId: string): Promise<StoredRun | null> {
  const { data, error } = await supabase()
    .from('bbs_calculation_runs')
    .select('id,status,drawing_hash,total_rows,calculated_rows,blocked_rows,reconciled,snapshot,stale_fact_ids,result,created_at')
    .eq('drawing_id', drawingId)
    .eq('is_current', true)
    .maybeSingle();
  if (error) throw new Error(describeDbError(error, 'Loading the schedule'));
  if (!data) return null;
  const row = data as unknown as {
    id: string;
    status: RunStatus;
    drawing_hash: string | null;
    total_rows: number;
    calculated_rows: number;
    blocked_rows: number;
    reconciled: boolean | null;
    snapshot: string[] | null;
    stale_fact_ids: string[] | null;
    result: BbsChatResult | null;
    created_at: string;
  };
  return {
    id: row.id,
    status: row.status,
    drawingHash: row.drawing_hash,
    totalRows: row.total_rows,
    calculatedRows: row.calculated_rows,
    blockedRows: row.blocked_rows,
    reconciled: row.reconciled,
    snapshot: row.snapshot ?? [],
    staleFactIds: row.stale_fact_ids ?? [],
    result: row.result,
    createdAt: Date.parse(row.created_at),
  };
}
