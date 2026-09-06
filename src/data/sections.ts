// ============================================================
// What the reader cut a sheet into, in Postgres.
//
// `drawing_sections` was in the schema from the start and nothing ever wrote
// to it: the split package lived in IndexedDB and only there. That left the
// table empty and, worse, left `data_facts.section_id` permanently null —
// there was no row for a fact to point at, so the one column that says WHICH
// PART OF THE SHEET a reading came from could never be filled.
//
// THE ROW IS THE INDEX; THE BODY GOES TO THE BUCKET.
//
// A section carries its own DXF text and a PNG data URL, and a busy sheet
// splits into a dozen of them — megabytes per drawing. None of that belongs
// in a table row that every listing query would then drag across the wire, so
// the row holds what a query needs (key, label, kind, bounds, entity count,
// callouts, hash) and the two bodies go to the same private `drawings` bucket
// the sheet itself is in, under `…/<drawing>/sections/<key>.{dxf,png}`, with
// `storage_path_dxf`/`storage_path_png` recording where.
//
// A body that fails to upload leaves its column null rather than a path to
// nothing, and the index row is still filed: an incomplete index is worth
// more than none, and the next split fills it in.
//
// REPLACE, NEVER APPEND. `savePackage` replaces a document's package because
// a document has ONE current decomposition, and this mirrors that exactly: a
// re-split deletes the drawing's rows and files the new set. Sections keyed
// REGION-01… are stable within a package and meaningless across two, so
// upserting on the key would silently merge two different readings of the
// same sheet.
// ============================================================
import { supabase } from '../lib/supabase';
import { describeDbError, requireUserId } from './session';
import {
  downloadDrawingFile,
  remoteDrawingIdFor,
  resolveDrawingId,
  sectionStoragePathFor,
  setSplitManifest,
  uploadSectionBody,
} from './drawings';

export interface SectionRow {
  id: string;
  section_key: string;
  label: string | null;
  kind: string | null;
  bounds: unknown;
  entity_count: number | null;
  note: string | null;
  callouts: unknown;
  drawing_hash: string | null;
  /** null when the body was not stored — read it back with `signedDrawingUrl` */
  storage_path_dxf: string | null;
  storage_path_png: string | null;
}

/** What this module needs off a `DrawingSection`, without importing the CAD types. */
export interface SectionInput {
  sectionId: string;
  label: string;
  kind: string;
  bounds: unknown;
  entityCount: number;
  calloutHints?: string[];
  sourceDrawingHash?: string;
  note?: string;
  /** the section's own DXF text — real entities, original coordinates */
  dxf?: string;
  /** `data:image/png;base64,…`, or '' when the run had no rasteriser */
  png?: string;
}

/**
 * A `data:` URL as bytes.
 *
 * `fetch(dataUrl)` would be shorter and is what most code reaches for, but it
 * is a network API pointed at a string: it is blocked by the page's own
 * connect-src in some builds and it is not available in every test
 * environment. Decoding it directly cannot fail for either reason.
 */
function dataUrlToBlob(dataUrl: string): Blob | null {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return null;
  const header = dataUrl.slice(5, comma);
  const body = dataUrl.slice(comma + 1);
  const type = header.replace(/;base64$/, '') || 'application/octet-stream';
  if (!header.endsWith(';base64')) {
    return new Blob([decodeURIComponent(body)], { type });
  }
  try {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  } catch {
    return null;
  }
}

const COLUMNS =
  'id,section_key,label,kind,bounds,entity_count,note,callouts,drawing_hash,' +
  'storage_path_dxf,storage_path_png';

/**
 * `<documentId>::<sectionId>` → the `drawing_sections` row id.
 *
 * The same trick `remoteIdByDocument` plays for drawings, and for the same
 * reason: the app is built on the package's own `REGION-01` keys throughout,
 * so rather than rewrite that, this remembers the correspondence for the
 * session and `factToRow` can turn a fact's `source.sectionId` into the uuid
 * its `section_id` column wants.
 */
const remoteIdBySection = new Map<string, string>();

const sectionCacheKey = (documentId: string, sectionId: string): string => `${documentId}::${sectionId}`;

export function remoteSectionIdFor(
  documentId: string | undefined | null,
  sectionId: string | undefined | null,
): string | null {
  if (!documentId || !sectionId) return null;
  return remoteIdBySection.get(sectionCacheKey(documentId, sectionId)) ?? null;
}

/** Tests and sign-out: forget the session's id correspondences. */
export function resetSectionIdMap(): void {
  remoteIdBySection.clear();
}

/**
 * File a document's sections, replacing whatever was filed for it before.
 *
 * Returns the row id per section key, and remembers the same map for the
 * session — a fact recorded moments later cites `REGION-03`, and this is what
 * lets that become a foreign key rather than a null.
 */
export async function syncDrawingSections(
  projectId: string,
  documentId: string,
  sections: readonly SectionInput[],
  manifest?: unknown,
): Promise<Map<string, string>> {
  // Resolved rather than looked up in the session map: a split can be saved
  // before the register has finished loading, and a silently empty index is
  // exactly the failure this table already had.
  const drawingId = await resolveDrawingId(projectId, documentId);
  const filed = new Map<string, string>();
  // No row for the drawing means nothing to hang a section off — the fix is
  // to file the drawing, not to invent a parent here.
  if (!drawingId) {
    console.warn(`[sections] ${documentId} has no drawing row yet, so its sections were not filed.`);
    return filed;
  }
  const userId = await requireUserId();

  const { error: clearError } = await supabase()
    .from('drawing_sections')
    .delete()
    .eq('drawing_id', drawingId);
  if (clearError) throw new Error(describeDbError(clearError, 'Clearing the previous sections'));
  for (const key of [...remoteIdBySection.keys()]) {
    if (key.startsWith(`${documentId}::`)) remoteIdBySection.delete(key);
  }
  if (!sections.length) return filed;

  // The bodies first, so the rows can be filed with their paths in one
  // statement instead of a patch per section. In parallel: a dozen small
  // objects one at a time is a dozen round trips for no reason.
  const bodies = await Promise.all(
    sections.map(async (section) => {
      const dxf = section.dxf
        ? await putBody(
            sectionStoragePathFor(userId, projectId, drawingId, section.sectionId, 'dxf'),
            new Blob([section.dxf], { type: 'application/dxf' }),
            'application/dxf',
          )
        : null;
      const pngBlob = section.png ? dataUrlToBlob(section.png) : null;
      const png = pngBlob
        ? await putBody(
            sectionStoragePathFor(userId, projectId, drawingId, section.sectionId, 'png'),
            pngBlob,
            'image/png',
          )
        : null;
      return { dxf, png };
    }),
  );

  const rows = sections.map((section, i) => ({
    drawing_id: drawingId,
    project_id: projectId,
    user_id: userId,
    section_key: section.sectionId,
    label: section.label,
    kind: section.kind,
    bounds: section.bounds ?? null,
    entity_count: section.entityCount,
    note: section.note ?? null,
    callouts: section.calloutHints ?? [],
    drawing_hash: section.sourceDrawingHash ?? null,
    storage_path_dxf: bodies[i].dxf,
    storage_path_png: bodies[i].png,
  }));

  const { data, error } = await supabase()
    .from('drawing_sections')
    .insert(rows)
    .select('id,section_key');
  if (error) throw new Error(describeDbError(error, 'Filing the drawing sections'));

  for (const row of (data ?? []) as unknown as { id: string; section_key: string }[]) {
    filed.set(row.section_key, row.id);
    remoteIdBySection.set(sectionCacheKey(documentId, row.section_key), row.id);
  }

  // THE MANIFEST LAST, AND ITS FAILURE IS NOT THE SPLIT'S FAILURE.
  //
  // The rows above are the split: they are what `data_facts.section_id`
  // references and what a second machine rebuilds the package from. The
  // manifest is the summary and coverage beside them, and it needs a column
  // that migration 0003 adds. Writing it FIRST meant a database still on 0002
  // threw before a single section row was filed — the whole split silently
  // stayed in one browser because of the optional half.
  if (manifest !== undefined) {
    try {
      await setSplitManifest(drawingId, manifest);
    } catch (err) {
      console.warn(
        '[sections] the sections are filed but the split summary is not — ' +
          'apply supabase/migrations/0003_split_manifest.sql:',
        err,
      );
    }
  }
  return filed;
}

/**
 * One body, uploaded — or null and a warning.
 *
 * A failed body must not take the index row with it. The row is what
 * `data_facts.section_id` references and what every listing reads; losing the
 * whole split because one PNG timed out would be trading the useful part for
 * the optional one.
 */
async function putBody(path: string, body: Blob, contentType: string): Promise<string | null> {
  try {
    return await uploadSectionBody(path, body, contentType);
  } catch (err) {
    console.warn(`[sections] ${path} was not stored:`, err);
    return null;
  }
}

/**
 * A drawing's whole split, back out of the database.
 *
 * The manifest, the section rows and each section's stored DXF and PNG — the
 * three pieces `savePackage` sent, reassembled. This is what a machine that
 * has never split this sheet reads instead of finding nothing and offering to
 * spend a model call re-splitting a drawing that was already read.
 *
 * A body that will not download is left empty rather than failing the whole
 * package: a section with its bounds, label and kind is still worth having.
 */
export async function loadRemoteSplit(
  projectId: string,
  documentId: string,
): Promise<{ manifest: unknown; sections: (SectionRow & { dxf: string; png: string })[] } | null> {
  const drawingId = await resolveDrawingId(projectId, documentId);
  if (!drawingId) return null;

  // The manifest is read but never REQUIRED. A database still on migration
  // 0002 has no column for it, and a split whose summary failed to file is
  // still a split — the sections are the part everything else is built on, so
  // the rows decide whether there is a package here, not the metadata.
  let manifest: unknown = null;
  const { data, error } = await supabase()
    .from('drawings')
    .select('split_manifest')
    .eq('id', drawingId)
    .maybeSingle();
  if (error) {
    console.warn('[sections] no split summary on file (migration 0003?):', describeDbError(error, 'Loading the split package'));
  } else {
    manifest = (data as { split_manifest: unknown } | null)?.split_manifest ?? null;
  }

  const rows = await listDrawingSections(documentId);
  if (!rows.length) return null;
  const sections = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      dxf: row.storage_path_dxf ? await bodyText(row.storage_path_dxf) : '',
      png: row.storage_path_png ? await bodyDataUrl(row.storage_path_png) : '',
    })),
  );
  return { manifest, sections };
}

async function bodyText(path: string): Promise<string> {
  try {
    return await (await downloadDrawingFile(path)).text();
  } catch (err) {
    console.warn(`[sections] ${path} could not be read back:`, err);
    return '';
  }
}

async function bodyDataUrl(path: string): Promise<string> {
  try {
    const blob = await downloadDrawingFile(path);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
  } catch (err) {
    console.warn(`[sections] ${path} could not be read back:`, err);
    return '';
  }
}

/** The sections filed for one drawing, and their ids remembered for this session. */
export async function listDrawingSections(documentId: string): Promise<SectionRow[]> {
  const drawingId = remoteDrawingIdFor(documentId);
  if (!drawingId) return [];
  const { data, error } = await supabase()
    .from('drawing_sections')
    .select(COLUMNS)
    .eq('drawing_id', drawingId);
  if (error) throw new Error(describeDbError(error, 'Loading the drawing sections'));
  const rows = (data ?? []) as unknown as SectionRow[];
  for (const row of rows) {
    remoteIdBySection.set(sectionCacheKey(documentId, row.section_key), row.id);
  }
  return rows;
}

/**
 * Drop a document's sections. Deleting the drawing itself already cascades
 * here; this is for deleting only the split — a re-split that produced
 * nothing, or a package cleared on its own.
 */
export async function deleteDrawingSections(documentId: string): Promise<void> {
  const drawingId = remoteDrawingIdFor(documentId);
  if (!drawingId) return;
  const { error } = await supabase().from('drawing_sections').delete().eq('drawing_id', drawingId);
  if (error) throw new Error(describeDbError(error, 'Removing the drawing sections'));
  for (const key of [...remoteIdBySection.keys()]) {
    if (key.startsWith(`${documentId}::`)) remoteIdBySection.delete(key);
  }
}
