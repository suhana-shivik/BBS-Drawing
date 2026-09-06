// ============================================================
// Projects, in Postgres.
//
// This is the SOURCE OF TRUTH for what projects exist. The browser keeps
// caches — IndexedDB holds parsed drawings, localStorage holds the last folder
// someone was looking at — but a project's existence, name and ownership are
// rows here, protected by RLS. That is what makes "User B cannot see User A's
// projects" a property of the system rather than of the user interface.
//
// The row shape is the studio's own `StudioProject` with database column
// names; `toStudioProject` is the only translation, so the app above this
// line is unchanged.
// ============================================================
import { supabase } from '../lib/supabase';
import { describeDbError, requireUserId, unwrap } from './session';

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  client: string | null;
  project_number: string | null;
  description: string | null;
  status: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

/** The shape the studio already speaks. Times are epoch ms, as the UI expects. */
export interface StudioProjectRecord {
  id: string;
  name: string;
  client?: string;
  projectNumber?: string;
  archived?: boolean;
  createdAt: number;
  modifiedAt: number;
}

export function toStudioProject(row: ProjectRow): StudioProjectRecord {
  return {
    id: row.id,
    name: row.name,
    ...(row.client ? { client: row.client } : {}),
    ...(row.project_number ? { projectNumber: row.project_number } : {}),
    ...(row.archived ? { archived: true } : {}),
    createdAt: Date.parse(row.created_at),
    modifiedAt: Date.parse(row.updated_at),
  };
}

const COLUMNS = 'id,user_id,name,client,project_number,description,status,archived,created_at,updated_at';

/** Every project this account owns, newest activity first. */
export async function listProjects(): Promise<StudioProjectRecord[]> {
  const { data, error } = await supabase()
    .from('projects')
    .select(COLUMNS)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(describeDbError(error, 'Loading your projects'));
  return (data ?? []).map((row) => toStudioProject(row as ProjectRow));
}

export interface NewProject {
  name: string;
  client?: string;
  projectNumber?: string;
  description?: string;
}

export async function createProject(input: NewProject): Promise<StudioProjectRecord> {
  const userId = await requireUserId();
  const row = unwrap<ProjectRow>(
    await supabase()
      .from('projects')
      .insert({
        user_id: userId,
        name: input.name.trim(),
        client: input.client?.trim() || null,
        project_number: input.projectNumber?.trim() || null,
        description: input.description?.trim() || null,
      })
      .select(COLUMNS)
      .single(),
    'Creating the project',
  );
  return toStudioProject(row);
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<NewProject, 'name' | 'client' | 'projectNumber' | 'description'>> & { archived?: boolean },
): Promise<StudioProjectRecord> {
  const row = unwrap<ProjectRow>(
    await supabase()
      .from('projects')
      .update({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.client !== undefined ? { client: patch.client.trim() || null } : {}),
        ...(patch.projectNumber !== undefined ? { project_number: patch.projectNumber.trim() || null } : {}),
        ...(patch.description !== undefined ? { description: patch.description.trim() || null } : {}),
        ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      })
      .eq('id', id)
      .select(COLUMNS)
      .single(),
    'Updating the project',
  );
  return toStudioProject(row);
}

/**
 * Deletes the project and, by foreign key, everything filed under it —
 * drawings, sections, readings, facts, schedules, artifacts, interview logs.
 * The cascade is declared in the schema rather than performed here, so it
 * cannot be half-done by a browser that closes mid-delete.
 */
export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase().from('projects').delete().eq('id', id);
  if (error) throw new Error(describeDbError(error, 'Deleting the project'));
}

/** Touch `updated_at` so the project sorts to the top after activity. */
export async function noteProjectActivity(id: string): Promise<void> {
  // A failure here is cosmetic — it only affects ordering on the home screen —
  // so it never interrupts the work that triggered it.
  await supabase()
    .from('projects')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', id);
}
