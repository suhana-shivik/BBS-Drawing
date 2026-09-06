// ============================================================
// About Drawing — the structured memory of what a sheet says — in Postgres.
//
// Keyed by DRAWING HASH, not just by drawing. A reading is only valid for the
// bytes it was read from: re-import the sheet with one dimension changed and
// the old reading is a description of a different drawing. Storing the hash
// beside the reading is what lets the next run ask "is there a reading for
// THIS version?" and get an honest no.
//
// It is also filed as a versioned artifact (kind: 'about'), which is the
// document a person downloads. This is the queryable form: the next run reads
// it back to start from memory instead of paying to read the sheet again.
// ============================================================
import { supabase } from '../lib/supabase';
import { describeDbError, requireUserId } from './session';

export interface ReadingRecord {
  drawingId: string;
  projectId: string;
  drawingHash: string;
  understanding?: string;
  note: string;
  conclusions: unknown[];
  sectionNotes: unknown[];
  unresolved: unknown[];
  escalations: unknown[];
}

interface ReadingRow {
  id: string;
  drawing_hash: string | null;
  understanding: string | null;
  note: string | null;
  conclusions: unknown[] | null;
  section_notes: unknown[] | null;
  unresolved: unknown[] | null;
  escalations: unknown[] | null;
  created_at: string;
}

export async function insertReading(record: ReadingRecord): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase().from('drawing_readings').insert({
    drawing_id: record.drawingId,
    project_id: record.projectId,
    user_id: userId,
    drawing_hash: record.drawingHash,
    understanding: record.understanding ?? null,
    note: record.note,
    conclusions: record.conclusions ?? [],
    section_notes: record.sectionNotes ?? [],
    unresolved: record.unresolved ?? [],
    escalations: record.escalations ?? [],
  });
  if (error) throw new Error(describeDbError(error, 'Saving what this drawing says'));
}

/**
 * The newest reading for a drawing AT A GIVEN HASH. A reading of different
 * bytes is not offered at all — it would be a confident description of a sheet
 * nobody is looking at.
 */
export async function latestReading(drawingId: string, drawingHash: string): Promise<ReadingRow | null> {
  const { data, error } = await supabase()
    .from('drawing_readings')
    .select('id,drawing_hash,understanding,note,conclusions,section_notes,unresolved,escalations,created_at')
    .eq('drawing_id', drawingId)
    .eq('drawing_hash', drawingHash)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(describeDbError(error, 'Loading what this drawing says'));
  return (data as unknown as ReadingRow) ?? null;
}
