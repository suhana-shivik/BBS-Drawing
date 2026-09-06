// ============================================================
// Drawings — the register entry, the uploaded file, and the link between them.
//
// A drawing has two halves and they live in different places for good reason:
// the METADATA (number, revision, discipline, hashes, split status) is a row,
// because it is queried, joined and shown in lists; the FILE is an object in
// a private storage bucket, because a 10 MB DXF in a table row makes every
// query that touches that table slow.
//
// The storage path starts with the owner's id — `<user>/<project>/<drawing>/…`
// — which is what the bucket policy compares against `auth.uid()`. A path is
// therefore not a capability: knowing someone else's is worth nothing.
//
// REVISIONS ARE ROWS, NOT OVERWRITES. Uploading Rev B leaves Rev A in place
// with `revision_state = 'superseded'` and `superseded_by` pointing forward,
// so a schedule filed last month still names the exact sheet behind it.
// ============================================================
import type { DrawingRegisterEntry } from '../register/types';
import { supabase } from '../lib/supabase';
import { describeDbError, requireUserId, unwrap } from './session';

export const DRAWINGS_BUCKET = 'drawings';

export interface DrawingRow {
  id: string;
  project_id: string;
  user_id: string;
  document_id: string | null;
  asset_id: string | null;
  original_file_name: string;
  display_name: string | null;
  drawing_number: string | null;
  identity_key: string | null;
  title: string | null;
  revision: string | null;
  revision_rank: number | null;
  issue_date: string | null;
  discipline: string | null;
  health: string | null;
  revision_state: string;
  file_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
  content_hash: string | null;
  drawing_hash: string | null;
  status: string;
  split_status: string | null;
  package_hash: string | null;
  version_no: number;
  version_count: number;
  superseded_by: string | null;
  warnings: string[];
  evidence: Record<string, unknown>;
  imported_at: string;
  reuploaded_at: string | null;
  /** the split package without its sections — see 0003_split_manifest.sql */
  split_manifest: unknown;
}

export type DrawingStatus = 'UPLOADED' | 'READING' | 'READ' | 'NEEDS_REVIEW' | 'FAILED' | 'SUPERSEDED';

/**
 * documentId (the browser's own id for a parsed drawing) → the database row id.
 *
 * The app is built on `documentId` throughout — the register, the sheets, the
 * artifacts all key off it — so rather than rewrite that, this remembers the
 * correspondence for the session and everything else keeps speaking its own
 * language. Populated by `syncDrawing` and by `listDrawings`.
 */
const remoteIdByDocument = new Map<string, string>();

export function remoteDrawingIdFor(documentId: string | undefined | null): string | null {
  return documentId ? (remoteIdByDocument.get(documentId) ?? null) : null;
}

export function rememberDrawingId(documentId: string, rowId: string): void {
  remoteIdByDocument.set(documentId, rowId);
}

/** Tests and sign-out: forget the session's id correspondences. */
export function resetDrawingIdMap(): void {
  remoteIdByDocument.clear();
}

function toRow(entry: DrawingRegisterEntry, projectId: string, userId: string): Record<string, unknown> {
  return {
    project_id: projectId,
    user_id: userId,
    document_id: entry.documentId,
    asset_id: entry.assetId ?? null,
    original_file_name: entry.originalFileName,
    display_name: entry.displayName ?? null,
    drawing_number: entry.drawingNumber || null,
    identity_key: entry.identityKey || null,
    title: entry.title || null,
    revision: entry.revision || null,
    revision_rank: entry.revisionRank ?? null,
    issue_date: entry.issueDate || null,
    discipline: entry.discipline ?? null,
    health: entry.health ?? null,
    revision_state: entry.revisionState ?? 'current',
    content_hash: entry.contentHash ?? null,
    split_status: entry.splitStatus ?? null,
    package_hash: entry.packageHash ?? null,
    version_no: entry.versionNo ?? 1,
    version_count: entry.versionCount ?? 1,
    warnings: entry.warnings ?? [],
    evidence: entry.evidence ?? {},
    imported_at: new Date(entry.importedAt || Date.now()).toISOString(),
    reuploaded_at: entry.reuploadedAt ? new Date(entry.reuploadedAt).toISOString() : null,
  };
}

const COLUMNS = '*';

/**
 * File (or update) a register entry as a drawing row, and remember its id.
 *
 * Matched on `(project_id, document_id)` — the browser's own identity for the
 * parsed drawing — so re-running an import updates the row rather than filing
 * a duplicate.
 */
export async function syncDrawing(
  projectId: string,
  entry: DrawingRegisterEntry,
  extra: { drawingHash?: string | null; status?: DrawingStatus; storagePath?: string | null; fileType?: string | null; fileSizeBytes?: number | null } = {},
): Promise<string> {
  const userId = await requireUserId();
  const patch = {
    ...toRow(entry, projectId, userId),
    ...(extra.drawingHash !== undefined ? { drawing_hash: extra.drawingHash } : {}),
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ...(extra.storagePath !== undefined ? { storage_path: extra.storagePath } : {}),
    ...(extra.fileType !== undefined ? { file_type: extra.fileType } : {}),
    ...(extra.fileSizeBytes !== undefined ? { file_size_bytes: extra.fileSizeBytes } : {}),
  };

  const existing = remoteIdByDocument.get(entry.documentId) ?? (await findDrawingId(projectId, entry.documentId));
  if (existing) {
    const { error } = await supabase().from('drawings').update(patch).eq('id', existing);
    if (error) throw new Error(describeDbError(error, 'Updating the drawing'));
    remoteIdByDocument.set(entry.documentId, existing);
    return existing;
  }

  const row = unwrap<{ id: string }>(
    await supabase().from('drawings').insert(patch).select('id').single(),
    'Filing the drawing',
  );
  remoteIdByDocument.set(entry.documentId, row.id);
  return row.id;
}

/**
 * The row id for a document, from the session map or from the database.
 *
 * `remoteDrawingIdFor` is map-only and deliberately synchronous — `factToRow`
 * is pure and cannot await. This is the version for callers that CAN wait and
 * must not fail just because the map has not been filled yet: a split saved
 * before `listDrawings` has returned would otherwise file no section index at
 * all, silently.
 */
export async function resolveDrawingId(projectId: string, documentId: string): Promise<string | null> {
  const known = remoteIdByDocument.get(documentId);
  if (known) return known;
  const found = await findDrawingId(projectId, documentId);
  if (found) remoteIdByDocument.set(documentId, found);
  return found;
}

async function findDrawingId(projectId: string, documentId: string): Promise<string | null> {
  const { data, error } = await supabase()
    .from('drawings')
    .select('id')
    .eq('project_id', projectId)
    .eq('document_id', documentId)
    .maybeSingle();
  if (error) throw new Error(describeDbError(error, 'Looking up the drawing'));
  return (data as { id: string } | null)?.id ?? null;
}

export async function listDrawings(projectId: string): Promise<DrawingRow[]> {
  const { data, error } = await supabase()
    .from('drawings')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .order('imported_at', { ascending: false });
  if (error) throw new Error(describeDbError(error, 'Loading the drawing register'));
  const rows = (data ?? []) as unknown as DrawingRow[];
  for (const row of rows) {
    if (row.document_id) remoteIdByDocument.set(row.document_id, row.id);
  }
  return rows;
}

export async function setDrawingStatus(drawingId: string, status: DrawingStatus): Promise<void> {
  const { error } = await supabase().from('drawings').update({ status }).eq('id', drawingId);
  if (error) throw new Error(describeDbError(error, 'Updating the drawing status'));
}

/**
 * Mark an older revision superseded by a newer one. Both rows survive; only
 * the pointer and the state change.
 */
export async function supersedeDrawing(oldId: string, newId: string): Promise<void> {
  const { error } = await supabase()
    .from('drawings')
    .update({ revision_state: 'superseded', status: 'SUPERSEDED', superseded_by: newId })
    .eq('id', oldId);
  if (error) throw new Error(describeDbError(error, 'Superseding the drawing'));
}

// ------------------------------------------------------------
// the file itself
// ------------------------------------------------------------

/** `<user>/<project>/<drawing>/<file>` — the first segment is what the policy checks. */
export function storagePathFor(userId: string, projectId: string, drawingId: string, fileName: string): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, '_') || 'drawing';
  return `${userId}/${projectId}/${drawingId}/${safe}`;
}

/**
 * `<user>/<project>/<drawing>/sections/<key>.<ext>` — where a section body goes.
 *
 * Deeper than a drawing's own path and deliberately so: the policy compares
 * `(storage.foldername(name))[1]` to `auth.uid()`, which is the FIRST segment
 * however many follow it, so nesting costs nothing and keeps a drawing's
 * sections together under it. The key is sanitised the same way a file name
 * is — a section key is generated (`REGION-01`), but a path that trusts
 * generated input is a path that can be talked out of its own prefix.
 */
export function sectionStoragePathFor(
  userId: string,
  projectId: string,
  drawingId: string,
  sectionKey: string,
  ext: 'dxf' | 'png',
): string {
  const safe = sectionKey.replace(/[^A-Za-z0-9._-]+/g, '_') || 'section';
  return `${userId}/${projectId}/${drawingId}/sections/${safe}.${ext}`;
}

/**
 * Put a section's body in the bucket and hand back its path.
 *
 * Separate from `uploadDrawingFile` because it updates no row: the caller
 * files the paths with the section rows it is about to insert, in one
 * statement, rather than inserting rows and then patching each one.
 */
export async function uploadSectionBody(
  path: string,
  body: Blob,
  contentType: string,
): Promise<string> {
  const { error } = await supabase()
    .storage.from(DRAWINGS_BUCKET)
    .upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`Uploading the section failed: ${error.message}`);
  return path;
}

/**
 * Put the uploaded bytes in the private bucket and record the path on the row.
 * Upsert, so re-importing the same drawing replaces its object rather than
 * accumulating copies.
 */
export async function uploadDrawingFile(
  projectId: string,
  drawingId: string,
  fileName: string,
  bytes: ArrayBuffer | Uint8Array | Blob,
  contentType = 'application/octet-stream',
): Promise<string> {
  const userId = await requireUserId();
  const path = storagePathFor(userId, projectId, drawingId, fileName);
  const body = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type: contentType });
  const { error } = await supabase()
    .storage.from(DRAWINGS_BUCKET)
    .upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`Uploading the drawing file failed: ${error.message}`);

  const { error: rowError } = await supabase()
    .from('drawings')
    .update({ storage_path: path, file_size_bytes: body.size, file_type: contentType })
    .eq('id', drawingId);
  if (rowError) throw new Error(describeDbError(rowError, 'Recording the drawing file'));
  return path;
}

/**
 * A short-lived URL for a stored drawing.
 *
 * Signed rather than public, and deliberately short: a link that never expires
 * is a permanent way around the bucket policy for anyone it is forwarded to.
 */
export async function signedDrawingUrl(path: string, expiresInSeconds = 300): Promise<string> {
  const { data, error } = await supabase()
    .storage.from(DRAWINGS_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error || !data) throw new Error(`Could not open the drawing file: ${error?.message ?? 'no URL returned'}`);
  return data.signedUrl;
}

/**
 * The split package's manifest, filed against the drawing.
 *
 * Separate from `syncDrawing` because it is written by the SPLIT, not by the
 * import: pushing it through the register's sync would mean every rename and
 * every revision re-sent a document nobody had changed.
 */
export async function setSplitManifest(drawingId: string, manifest: unknown): Promise<void> {
  const { error } = await supabase()
    .from('drawings')
    .update({ split_manifest: manifest ?? null })
    .eq('id', drawingId);
  if (error) throw new Error(describeDbError(error, 'Filing the split package'));
}

/**
 * The original file for a document, out of the bucket, as text.
 *
 * This is what makes the browser's copy a CACHE rather than the only copy: a
 * machine that has never seen this project has an empty IndexedDB, and until
 * this existed the register could list a drawing that nothing could open. The
 * bytes in the bucket are the record; the parse is derived from them, which
 * is why the parsed document is not uploaded as well.
 *
 * Null — not an error — when the drawing has no stored file. That is an
 * ordinary state for a drawing imported before uploads existed, and the caller
 * carries on with the rest of the register rather than failing the open.
 */
export async function downloadDrawingSource(
  projectId: string,
  documentId: string,
): Promise<{ name: string; text: string } | null> {
  const id = await resolveDrawingId(projectId, documentId);
  if (!id) return null;
  const { data, error } = await supabase()
    .from('drawings')
    .select('storage_path,original_file_name')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(describeDbError(error, 'Looking up the drawing file'));
  const row = data as { storage_path: string | null; original_file_name: string } | null;
  if (!row?.storage_path) return null;
  const blob = await downloadDrawingFile(row.storage_path);
  return { name: row.original_file_name, text: await blob.text() };
}

export async function downloadDrawingFile(path: string): Promise<Blob> {
  const { data, error } = await supabase().storage.from(DRAWINGS_BUCKET).download(path);
  if (error || !data) throw new Error(`Downloading the drawing file failed: ${error?.message ?? 'no data'}`);
  return data;
}

// ------------------------------------------------------------
// back the other way: a row, as the register reads it
// ------------------------------------------------------------

/**
 * A `drawings` row turned back into the register entry it was filed from.
 *
 * The register is the app's own shape and it is what every view is built on,
 * so hydrating a project on a second machine means coming back through here.
 * Fields the row does not carry (`assetId`, which names a blob in THIS
 * browser's store) are reconstructed as best they can be rather than left
 * undefined — the register's type requires them, and an entry missing one
 * would break the tree rather than degrade it.
 */
export function toRegisterEntry(row: DrawingRow): DrawingRegisterEntry {
  const evidence = (row.evidence ?? {}) as DrawingRegisterEntry['evidence'];
  return {
    id: row.id,
    projectId: row.project_id,
    documentId: row.document_id ?? row.id,
    assetId: row.asset_id ?? `remote:${row.id}`,
    originalFileName: row.original_file_name,
    displayName: row.display_name ?? row.original_file_name,
    drawingNumber: row.drawing_number ?? '',
    identityKey: row.identity_key || (row.document_id ?? row.id),
    title: row.title ?? '',
    revision: row.revision ?? '',
    revisionRank: row.revision_rank ?? null,
    issueDate: row.issue_date ?? '',
    discipline: (row.discipline ?? 'general') as DrawingRegisterEntry['discipline'],
    health: (row.health ?? 'review') as DrawingRegisterEntry['health'],
    revisionState: (row.revision_state ?? 'review') as DrawingRegisterEntry['revisionState'],
    importedAt: Date.parse(row.imported_at) || Date.now(),
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    evidence,
    versionNo: row.version_no ?? 1,
    versionCount: row.version_count ?? 1,
    ...(row.content_hash ? { contentHash: row.content_hash } : {}),
    ...(row.reuploaded_at ? { reuploadedAt: Date.parse(row.reuploaded_at) } : {}),
    ...(row.split_status ? { splitStatus: row.split_status as DrawingRegisterEntry['splitStatus'] } : {}),
    ...(row.package_hash ? { packageHash: row.package_hash } : {}),
  };
}

/**
 * Remove a drawing's row, and the uploaded file with it.
 *
 * `drawing_sections`, `drawing_readings`, `data_facts`, `bbs_rows` and
 * `project_artifacts` all reference `drawings.id` with `on delete cascade`, so
 * this one statement takes the drawing's whole trail. The stored object is NOT
 * cascaded by Postgres — a bucket is not a foreign key — so it is removed
 * here, deliberately and in the same call, rather than left behind as an
 * orphan nobody can reach and everybody keeps paying for.
 */
export async function deleteDrawingRow(projectId: string, documentId: string): Promise<void> {
  const id = remoteIdByDocument.get(documentId) ?? (await findDrawingId(projectId, documentId));
  if (!id) return;

  const { data } = await supabase().from('drawings').select('storage_path').eq('id', id).maybeSingle();
  const path = (data as { storage_path: string | null } | null)?.storage_path ?? null;

  const { error } = await supabase().from('drawings').delete().eq('id', id);
  if (error) throw new Error(describeDbError(error, 'Removing the drawing'));
  remoteIdByDocument.delete(documentId);

  if (path) {
    // Best effort, and on purpose: the row is gone, which is what the register
    // and every view read. Failing the whole delete because a storage object
    // outlived it would leave the person with a drawing they cannot remove.
    await supabase().storage.from(DRAWINGS_BUCKET).remove([path]).catch(() => {});
  }
}
