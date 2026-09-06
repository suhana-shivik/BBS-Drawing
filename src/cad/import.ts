// Import a CAD drawing into the open project: parse off the main thread,
// persist the document and the original bytes, and attach it as the
// underlay. The original file is never discarded.
import { parseDXFInWorker } from './worker/client';
import { addCadSheet, cadSheets, setActiveCadSheet, setCadDocument } from './session';
import * as repo from './store';
import type { CadDocument } from './types';
import { newId } from '../core/types';
import {
  findByContentHash,
  getDrawingRegister,
  loadDrawingRegister,
  noteReupload,
  registerDrawing,
} from '../register/register';
import { contentHash } from '../register/contentHash';
import type { DrawingRegisterEntry } from '../register/types';
import { downloadDrawingSource } from '../data/drawings';
import { isSupabaseConfigured } from '../lib/supabase';

export interface ImportProgress {
  phase: string;
  pct: number;
}

export interface ImportResult {
  doc: CadDocument;
  registration?: DrawingRegisterEntry;
  /** true when the parsed document could not be persisted (quota etc.) */
  transient: boolean;
  warning?: string;
  /**
   * The fingerprint of the file that was imported. Handed back because the
   * caller has its own fallback registration path for when persistence fails,
   * and an entry filed without its hash is an entry the next re-upload cannot
   * recognise.
   */
  contentHash: string;
  /**
   * Set when this file was already on the register, byte for byte: nothing was
   * parsed, filed or versioned, and `doc` is the copy already held. The caller
   * says so rather than reporting an import that did not happen.
   */
  duplicateOf?: DrawingRegisterEntry;
}

/**
 * Parse `text` and attach it to `projectId`.
 * Parsing runs in a worker so multi-megabyte files never block the UI.
 */
export async function importCadDrawing(
  projectId: string,
  fileName: string,
  text: string,
  opts: {
    onProgress?: (p: ImportProgress) => void;
    signal?: AbortSignal;
    sourceBytes?: ArrayBuffer;
    convertedFromDwg?: boolean;
  } = {},
): Promise<ImportResult> {
  // Before anything is parsed: is this the same file we already hold?
  //
  // A re-upload used to be a full second import — parsed again, filed again,
  // and then chained as a revision of itself, so a project with one drawing
  // dropped in twice showed two rows and marked the first superseded. It is
  // one drawing. Hashing the source is cheap next to a parse, so the question
  // is asked first and the whole import is skipped when the answer is yes.
  const hash = contentHash(text);
  const held = await heldCopy(projectId, hash);
  if (held) {
    setActiveCadSheet(held.sheetId);
    const registration = (await noteReupload(held.entry.id)) ?? held.entry;
    return {
      doc: held.doc,
      registration,
      transient: false,
      contentHash: hash,
      duplicateOf: registration,
    };
  }

  const doc = await parseDXFInWorker(text, fileName, {
    onProgress: (phase, pct) => opts.onProgress?.({ phase, pct }),
    signal: opts.signal,
  });

  if (doc.entities.length === 0) {
    throw new Error('No drawable entities were found in this DXF file.');
  }

  // Attach first so the drawing appears even if persistence later fails —
  // the user should never stare at an empty canvas because of a quota error.
  // Added as a NEW sheet: a project is a set of drawings, and importing the
  // structural plan must not evict the architectural one.
  addCadSheet(doc);

  let transient = false;
  let warning: string | undefined;
  let registration: DrawingRegisterEntry | undefined;
  try {
    const assetId = newId('asset');
    // persist every open sheet, so reopening the project restores the set
    await repo.putCadDocuments(projectId, cadSheets().map((s) => s.doc));
    await repo.putCadSource(projectId, {
      id: assetId,
      documentId: doc.id,
      name: fileName,
      bytes: opts.sourceBytes ?? new TextEncoder().encode(text).buffer,
      importedAt: Date.now(),
      convertedFromDwg: opts.convertedFromDwg,
      // Keep the converted text too, not just the DWG it came from: this is
      // the exact string every quantity on this drawing was read out of, and
      // re-converting later would not reproduce it byte for byte.
      ...(opts.convertedFromDwg ? { convertedDxf: text } : {}),
    });
    registration = await registerDrawing(projectId, doc, fileName, assetId, hash);
  } catch (err) {
    transient = true;
    warning =
      err instanceof Error
        ? `Drawing loaded but not saved: ${err.message}`
        : 'Drawing loaded but could not be saved to this browser.';
  }

  return { doc, registration, transient, warning, contentHash: hash };
}

/**
 * The open sheet for a file already on the register, matched by content hash.
 *
 * Both halves have to hold. A register entry alone is not enough — its parsed
 * document must still be in the session for there to be anything to show, and
 * if it is not (a register restored without its documents) the import goes
 * ahead normally rather than handing back a drawing nobody can open.
 */
async function heldCopy(
  projectId: string,
  hash: string,
): Promise<{ entry: DrawingRegisterEntry; doc: CadDocument; sheetId: string } | null> {
  if (getDrawingRegister()?.projectId !== projectId) {
    try {
      await loadDrawingRegister(projectId);
    } catch {
      return null;
    }
  }
  if (getDrawingRegister()?.projectId !== projectId) return null;
  const entry = findByContentHash(hash);
  if (!entry) return null;
  const sheet = cadSheets().find((s) => s.doc.id === entry.documentId);
  return sheet ? { entry, doc: sheet.doc, sheetId: sheet.id } : null;
}

/**
 * Reattach a previously imported drawing when a project is reopened.
 *
 * IndexedDB IS A CACHE. It is read first because a parsed document already on
 * this machine costs nothing, but a miss is not an answer: the register comes
 * from `public.drawings` now, so a machine that has never opened this project
 * has a full register and an empty cache — and until `hydrateMissing` existed
 * that combination listed drawings that nothing could open.
 *
 * The parsed document is NOT stored in the database. It is derived from the
 * source bytes, the source bytes are in the bucket, and uploading a parse
 * alongside the file it was parsed from would be a second copy of the same
 * drawing that can disagree with the first.
 */
export async function restoreCadDrawing(projectId: string): Promise<CadDocument | null> {
  try {
    const docs = await repo.getCadDocuments(projectId);
    setCadDocument(null);
    for (const d of docs) addCadSheet(d);
    // Projects created before the register existed are enrolled lazily on
    // first open. No drawing is re-parsed and no source is renamed.
    await loadDrawingRegister(projectId);
    const sources = await repo.getCadSources(projectId);
    for (const doc of docs) {
      if (getDrawingRegister()?.entries.some((e) => e.documentId === doc.id)) continue;
      const source = sources.find((s) => s.documentId === doc.id || s.name === doc.sourceFile);
      await registerDrawing(projectId, doc, doc.sourceFile || doc.name, source?.id ?? `legacy:${doc.id}`);
    }
    const restored = await hydrateMissing(projectId, docs);
    return docs[0] ?? restored ?? null;
  } catch {
    setCadDocument(null);
    return null;
  }
}

/**
 * Every register entry with no parsed document on this machine, fetched from
 * the bucket and parsed.
 *
 * Sequential, deliberately: parsing a multi-megabyte DXF is the expensive part
 * and running six at once would fight over the same worker and the same
 * memory. One failure is skipped rather than abandoning the rest — a project
 * where five of six drawings open is a working project.
 */
async function hydrateMissing(
  projectId: string,
  cached: readonly CadDocument[],
): Promise<CadDocument | null> {
  if (!isSupabaseConfigured()) return null;
  const held = new Set(cached.map((d) => d.id));
  const missing = (getDrawingRegister()?.entries ?? []).filter((e) => !held.has(e.documentId));
  if (!missing.length) return null;

  let first: CadDocument | null = null;
  for (const entry of missing) {
    try {
      const source = await downloadDrawingSource(projectId, entry.documentId);
      if (!source) continue;
      const doc = await parseDXFInWorker(source.text, source.name);
      // The parse assigns a fresh document id; the register, the facts and
      // every filed schedule key off the ORIGINAL one, so the restored
      // document has to keep it or it is a different drawing.
      const restored = { ...doc, id: entry.documentId };
      addCadSheet(restored);
      first = first ?? restored;
      await repo.putCadDocuments(projectId, cadSheets().map((s) => s.doc)).catch(() => {
        /* the cache is best effort; the drawing is open either way */
      });
    } catch (err) {
      console.warn(`[import] ${entry.originalFileName} could not be restored from storage:`, err);
    }
  }
  return first;
}

/** Human summary for the import report. */
export function summarise(doc: CadDocument): string[] {
  const byType = new Map<string, number>();
  for (const e of doc.entities) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  const lines: string[] = [];
  lines.push(`${doc.entities.length} entities on ${doc.layers.size} layers`);
  lines.push(`${doc.blocks.size} block definitions`);
  const inserts = byType.get('insert') ?? 0;
  if (inserts) lines.push(`${inserts} block instances`);
  const text = byType.get('text') ?? 0;
  if (text) lines.push(`${text} text items`);
  const hatch = byType.get('hatch') ?? 0;
  if (hatch) lines.push(`${hatch} hatches`);
  if (doc.regions.length > 1) lines.push(`${doc.regions.length} drawing regions (all kept)`);
  for (const d of doc.diagnostics) {
    if (d.code === 'unsupported-entity') lines.push(`${d.message} (${d.count})`);
  }
  return lines;
}
