// ============================================================
// Folders a person made, in Postgres.
//
// The thin half of `src/register/folders.ts`: that module owns the model and
// the synchronous snapshot the Files tree renders from, this one owns the
// row. Every write there is mirrored through here, and `listFolderRows` is
// what a second machine hydrates from.
//
// Matched on `local_id`, not on the row id. The register makes a folder
// immediately — a person clicking New → Folder must not wait for a round trip
// to name it — so the browser's `uf_…` id exists first and the row is filed
// under it. That is what makes the write an upsert rather than a guess about
// whether this folder is already there.
// ============================================================
import { supabase } from '../lib/supabase';
import { describeDbError, requireUserId } from './session';

export interface FolderRow {
  id: string;
  local_id: string;
  name: string;
  members: string[];
  created_at: string;
}

const COLUMNS = 'id,local_id,name,members,created_at';

/** Oldest first — the order `listFolders` sorts its snapshot into. */
export async function listFolderRows(projectId: string): Promise<FolderRow[]> {
  const { data, error } = await supabase()
    .from('project_folders')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(describeDbError(error, 'Loading your folders'));
  return ((data ?? []) as unknown as FolderRow[]).map((row) => ({
    ...row,
    members: Array.isArray(row.members) ? row.members : [],
  }));
}

/**
 * File a folder, or bring the row up to date with it.
 *
 * One call covers create, rename and every membership change, because all
 * three are the same statement about the same row and splitting them into
 * three would mean three chances for the row to drift from what the tree
 * shows.
 */
export async function upsertFolderRow(
  projectId: string,
  folder: { id: string; name: string; members: string[]; createdAt: number },
): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase()
    .from('project_folders')
    .upsert(
      {
        project_id: projectId,
        user_id: userId,
        local_id: folder.id,
        name: folder.name,
        members: folder.members,
        created_at: new Date(folder.createdAt).toISOString(),
      },
      { onConflict: 'project_id,local_id' },
    );
  if (error) throw new Error(describeDbError(error, 'Saving the folder'));
}

/**
 * Remove a folder. The drawings it named are not touched — membership is a
 * column on this row and nothing else in the schema points back at it, which
 * is exactly the property that lets a label be deleted without consequence.
 */
export async function deleteFolderRow(projectId: string, localId: string): Promise<void> {
  const { error } = await supabase()
    .from('project_folders')
    .delete()
    .eq('project_id', projectId)
    .eq('local_id', localId);
  if (error) throw new Error(describeDbError(error, 'Removing the folder'));
}
