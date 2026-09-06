// ============================================================
// The interview log, in Postgres.
//
// What was ASKED, beside what was answered — the record of how a schedule came
// to rest on the numbers it rests on. It is the thing a checker reads when a
// figure looks wrong: was this measured, or was somebody asked, and what were
// they told at the time?
//
// One row per run, and no cap. The browser store keeps 60 because localStorage
// and IndexedDB are a shared, finite budget; a database is not, and silently
// dropping the 61st run's record would lose exactly the history this table
// exists for.
// ============================================================
import { supabase } from '../lib/supabase';
import { describeDbError, requireUserId } from './session';
import { remoteDrawingIdFor } from './drawings';

export interface InterviewLogRecord {
  drawingName: string;
  artifactId?: string;
  stoppedBecause?: string;
  /** the AuditLog itself — questions, answers, findings */
  log: unknown;
  documentId?: string;
  createdAt?: number;
}

interface LogRow {
  id: string;
  drawing_name: string | null;
  artifact_id: string | null;
  stopped_because: string | null;
  log: unknown;
  created_at: string;
}

export async function insertInterviewLog(projectId: string, record: InterviewLogRecord): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase().from('interview_logs').insert({
    project_id: projectId,
    drawing_id: remoteDrawingIdFor(record.documentId),
    user_id: userId,
    drawing_name: record.drawingName,
    artifact_id: record.artifactId ?? null,
    stopped_because: record.stoppedBecause ?? null,
    log: record.log ?? {},
  });
  if (error) throw new Error(describeDbError(error, 'Filing the interview log'));
}

export async function listInterviewLogs(projectId: string): Promise<InterviewLogRecord[]> {
  const { data, error } = await supabase()
    .from('interview_logs')
    .select('id,drawing_name,artifact_id,stopped_because,log,created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(describeDbError(error, 'Loading the interview logs'));
  return ((data ?? []) as unknown as LogRow[]).map((row) => ({
    drawingName: row.drawing_name ?? '',
    ...(row.artifact_id ? { artifactId: row.artifact_id } : {}),
    ...(row.stopped_because ? { stoppedBecause: row.stopped_because } : {}),
    log: row.log,
    createdAt: Date.parse(row.created_at),
  }));
}
