// ============================================================
// Filed outputs, in Postgres.
//
// An artifact is a document the project produced: a BBS result, the About
// Drawing memory, the sections index. They are versioned per (drawing, kind)
// and never overwritten, because "v3 of the foundation schedule" is a thing
// somebody may have priced from.
//
// One row per artifact, rather than the whole array rewritten on every save —
// which is what the browser store did, and which quietly loses an artifact
// when two tabs file one at the same time.
// ============================================================
import { supabase } from '../lib/supabase';
import { describeDbError, requireUserId, unwrap } from './session';
import { remoteDrawingIdFor } from './drawings';

export type ArtifactKind = 'quantity' | 'bbs' | 'sections' | 'about';

export interface ArtifactRecord {
  id: string;
  projectId: string;
  documentId: string;
  kind: ArtifactKind;
  fileName: string;
  drawingName: string;
  drawingNumber: string;
  revision: string;
  version: number;
  mimeType: 'text/csv' | 'application/json';
  content: string;
  createdAt: number;
  /** last write. Equal to createdAt until the artifact is edited in place. */
  updatedAt: number;
}

interface ArtifactRow {
  id: string;
  project_id: string;
  document_id: string | null;
  kind: ArtifactKind;
  file_name: string | null;
  drawing_name: string | null;
  drawing_number: string | null;
  revision: string | null;
  version: number;
  mime_type: string;
  content: string | null;
  created_at: string;
  updated_at: string | null;
}

const COLUMNS =
  'id,project_id,document_id,kind,file_name,drawing_name,drawing_number,revision,version,mime_type,content,created_at,updated_at';

function toRecord(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    documentId: row.document_id ?? '',
    kind: row.kind,
    fileName: row.file_name ?? '',
    drawingName: row.drawing_name ?? '',
    drawingNumber: row.drawing_number ?? '',
    revision: row.revision ?? '',
    version: row.version,
    mimeType: (row.mime_type === 'text/csv' ? 'text/csv' : 'application/json') as ArtifactRecord['mimeType'],
    content: row.content ?? '',
    createdAt: Date.parse(row.created_at),
    updatedAt: row.updated_at ? Date.parse(row.updated_at) : Date.parse(row.created_at),
  };
}

/** Newest first, matching the order the register lists Outputs in. */
export async function listArtifacts(projectId: string): Promise<ArtifactRecord[]> {
  const { data, error } = await supabase()
    .from('project_artifacts')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(describeDbError(error, 'Loading the project outputs'));
  return ((data ?? []) as unknown as ArtifactRow[]).map(toRecord);
}

/**
 * File the output and hand back THE ROW'S id.
 *
 * The id matters to the caller. `project_artifacts.id` is a `uuid` the
 * database generates; the browser's own id for the same output is
 * `artifact_<n>`. A session that filed a schedule and then deleted it was
 * sending that browser id to `delete().eq('id', …)`, which Postgres rejects as
 * malformed uuid — so the row survived and the "deleted" workbook came back on
 * the next load. Returning the real id is what lets the caller store the one
 * value that can address the row again.
 */
export async function insertArtifact(artifact: ArtifactRecord): Promise<string> {
  const userId = await requireUserId();
  const inserted = unwrap<{ id: string }>(
    await supabase()
      .from('project_artifacts')
      .insert({
        project_id: artifact.projectId,
        // Linked to the drawing row when this session knows which one it is,
        // so a deleted drawing takes its outputs with it rather than leaving a
        // BBS workbook with nothing left to have produced it.
        drawing_id: remoteDrawingIdFor(artifact.documentId),
        user_id: userId,
        document_id: artifact.documentId,
        kind: artifact.kind,
        file_name: artifact.fileName,
        drawing_name: artifact.drawingName,
        drawing_number: artifact.drawingNumber,
        revision: artifact.revision,
        version: artifact.version,
        mime_type: artifact.mimeType,
        content: artifact.content,
      })
      .select('id')
      .single(),
    'Filing the output',
  );
  return inserted.id;
}

/**
 * Write new content over an artifact that already exists — a CORRECTION, not
 * a new version. The row keeps its id, its version and its file name; only
 * the content and `updated_at` move. What changed is recorded in the
 * artifact's own history and in the calculation runs beside it.
 */
export async function updateArtifact(artifactId: string, content: string): Promise<void> {
  const { error } = await supabase()
    .from('project_artifacts')
    .update({ content, updated_at: new Date().toISOString() })
    .eq('id', artifactId);
  if (error) throw new Error(describeDbError(error, 'updating the filed schedule'));
}

export async function deleteArtifact(id: string): Promise<void> {
  const { error } = await supabase().from('project_artifacts').delete().eq('id', id);
  if (error) throw new Error(describeDbError(error, 'Removing the output'));
}

export async function deleteArtifactsForDocument(projectId: string, documentId: string): Promise<void> {
  const { error } = await supabase()
    .from('project_artifacts')
    .delete()
    .eq('project_id', projectId)
    .eq('document_id', documentId);
  if (error) throw new Error(describeDbError(error, 'Removing the outputs for that drawing'));
}
