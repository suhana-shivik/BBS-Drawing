import { useEffect, useSyncExternalStore } from 'react';
import type { CadDocument } from '../cad/types';
import { newId } from './id';
import * as repo from '../cad/store';
import * as remote from '../data/drawings';
import { isSupabaseConfigured } from '../lib/supabase';
import { extractTitleBlock, revisionRank } from './titleBlock';
import type { DrawingRegisterData, DrawingRegisterEntry } from './types';

// ============================================================
// THE REGISTER IS A MIRROR OF `public.drawings`, NOT A BROWSER DOCUMENT.
//
// It began as the second: entries were written to IndexedDB and nowhere else,
// which meant a drawing imported on the office machine did not exist on the
// site laptop, and clearing site data lost the project's whole register. The
// row is the record now, and the two helpers below are the only places that
// know it — every mutation files, updates or removes the row beside the local
// copy, and `loadDrawingRegister` reconciles the two when a project opens.
//
// A FILING failure does not throw. An import must still put the drawing in
// front of the person when the network is down; the local copy carries it and
// the next load files it late. A DELETE is the exception — see
// `removeDrawingEntry`.
// ============================================================

/** File or update the row behind an entry. Never throws; reports and moves on. */
async function syncEntry(entry: DrawingRegisterEntry): Promise<void> {
  if (!isSupabaseConfigured()) return;
  try {
    await remote.syncDrawing(entry.projectId, entry);
  } catch (err) {
    console.warn('[register] the drawing is not filed in the database yet:', err);
  }
}

/**
 * Merge what the database holds with what this browser holds.
 *
 * The row wins on the fields it carries, because it is the record and because
 * a second machine has no local copy to prefer. The LOCAL id wins when both
 * know the document: entry ids are what open tabs, folder membership and the
 * delete/rename targets are keyed by, and swapping them mid-session strands
 * every one of those. A document only this browser knows is KEPT and pushed
 * up — it is an import that never reached the database, not a deletion.
 */
function mergeEntries(
  local: DrawingRegisterEntry[],
  rows: remote.DrawingRow[],
): { entries: DrawingRegisterEntry[]; unfiled: DrawingRegisterEntry[] } {
  const byDocument = new Map(local.map((e) => [e.documentId, e]));
  const entries: DrawingRegisterEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const mapped = remote.toRegisterEntry(row);
    const mine = byDocument.get(mapped.documentId);
    seen.add(mapped.documentId);
    entries.push(
      mine
        ? {
            ...mapped,
            id: mine.id,
            // The asset id names a blob in THIS browser's store; the row's
            // copy of it is meaningless anywhere else, so the local one holds.
            assetId: mine.assetId,
            splitStatus: mapped.splitStatus ?? mine.splitStatus,
            packageHash: mapped.packageHash ?? mine.packageHash,
          }
        : mapped,
    );
  }
  const unfiled = local.filter((e) => !seen.has(e.documentId));
  return { entries: [...entries, ...unfiled], unfiled };
}

let state: DrawingRegisterData | null = null;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const fn of [...listeners]) fn();
}

/**
 * Exported so the change log orders a chain exactly as the register does. A
 * second comparator would eventually disagree, and then the log would name the
 * wrong sheet as the replacement.
 */
export function compareRevision(a: DrawingRegisterEntry, b: DrawingRegisterEntry): number {
  if (a.revisionRank !== null && b.revisionRank !== null) return a.revisionRank - b.revisionRank;
  const dateA = Date.parse(a.issueDate);
  const dateB = Date.parse(b.issueDate);
  if (Number.isFinite(dateA) && Number.isFinite(dateB) && dateA !== dateB) return dateA - dateB;
  return a.importedAt - b.importedAt;
}

/**
 * Sort a chain into version order and stamp every member with where it sits.
 *
 * The version number is not a second opinion about the chain — it is the same
 * `compareRevision` order the revision state is decided from, counted. That is
 * the whole point of doing it here: "v3 of 3" and "current" are one fact said
 * two ways, and a Files row that showed v2 as current would be a register
 * contradicting itself.
 */
export function reconcileRevisionStates(entries: DrawingRegisterEntry[]): DrawingRegisterEntry[] {
  const chains = new Map<string, DrawingRegisterEntry[]>();
  for (const entry of entries) {
    const list = chains.get(entry.identityKey) ?? [];
    list.push(entry);
    chains.set(entry.identityKey, list);
  }
  const uncertain = (e: DrawingRegisterEntry): boolean =>
    !e.drawingNumber || !e.revision || e.health !== 'ready';
  const out: DrawingRegisterEntry[] = [];
  for (const chain of chains.values()) {
    // The chain is built from the CONFIRMED sheets only. A drawing whose
    // number or revision was never read has no place in a sequence — it is not
    // known to be part of one — and letting it in cut both ways: it took the
    // head of the chain by arrival order and marked a good R1 superseded by a
    // sheet nobody had identified. In review means in review; it supersedes
    // nothing and it is superseded by nothing.
    const ordered = chain.filter((e) => !uncertain(e)).sort(compareRevision);
    const latest = ordered.length ? ordered[ordered.length - 1] : undefined;
    const rank = new Map(ordered.map((e, i) => [e.id, i + 1]));
    for (const entry of chain) {
      // An unplaced sheet reports no version rather than a guessed one: 1 of 1
      // is how this register says "nothing to compare this against".
      const versionNo = rank.get(entry.id) ?? 1;
      const versionCount = rank.has(entry.id) ? ordered.length : 1;
      const superseded = rank.has(entry.id) && entry.id !== latest?.id;
      out.push({
        ...entry,
        revisionState: uncertain(entry) ? 'review' : entry.id === latest?.id ? 'current' : 'superseded',
        versionNo,
        versionCount,
        // The replacement is the NEXT version, not the newest one: a reader
        // following R0 → R1 → R2 needs each step, and naming the head at
        // every hop would lose the middle of the chain.
        ...(superseded && ordered[versionNo]
          ? { supersededById: ordered[versionNo].id }
          : { supersededById: undefined }),
      });
    }
  }
  return out.sort((a, b) => b.importedAt - a.importedAt);
}


export async function loadDrawingRegister(projectId: string): Promise<DrawingRegisterData> {
  let saved: DrawingRegisterData | null = null;
  try {
    saved = await repo.getDrawingRegister(projectId);
  } catch {
    // Same graceful fallback as project persistence: the register remains
    // usable in private/test contexts where IndexedDB is unavailable.
  }
  // The local mirror, or — when IndexedDB is unavailable or empty and this is
  // the project already open — what is in memory. Falling straight to `[]`
  // there emptied the register on a re-open in exactly the contexts with no
  // durable local store: private windows, a browser that refuses IndexedDB,
  // and tests.
  let entries =
    saved?.projectId === projectId
      ? saved.entries
      : state?.projectId === projectId
        ? state.entries
        : [];

  if (isSupabaseConfigured()) {
    try {
      const merged = mergeEntries(entries, await remote.listDrawings(projectId));
      entries = merged.entries;
      // An import that never reached the database gets its second chance here
      // rather than staying local forever. Not awaited: the register is
      // already correct for this session either way.
      for (const late of merged.unfiled) void syncEntry(late);
    } catch (err) {
      // Show the mirror rather than an empty register — the same choice
      // `loadProjectArtifacts` makes for filed outputs.
      console.warn('[register] could not read the drawing register from the database:', err);
    }
  }

  state = { projectId, entries: reconcileRevisionStates(entries), updatedAt: Date.now() };
  try {
    await repo.putDrawingRegister(state);
  } catch {
    /* the local mirror is best effort */
  }
  emit();
  return state;
}

/**
 * The entry this exact file is already filed as, if any.
 *
 * Identity is the title block's job and it is the right answer for a revision;
 * it is the wrong one here. Two uploads of the same bytes share an identityKey
 * AND a revision, so the chain would order them by arrival and mark the first
 * superseded — a drawing replaced by itself. The hash is what separates "R1
 * arrived" from "somebody dropped R1 in twice".
 */
export function findByContentHash(hash: string): DrawingRegisterEntry | null {
  if (!hash || !state) return null;
  return state.entries.find((e) => e.contentHash === hash) ?? null;
}

/**
 * Record that a file already on the register was uploaded again. The row does
 * not move and no version is created; the only thing that changes is that the
 * register can now say when it last saw this file.
 */
export async function noteReupload(id: string, at = Date.now()): Promise<DrawingRegisterEntry | null> {
  if (!state) return null;
  let touched: DrawingRegisterEntry | null = null;
  const entries = state.entries.map((e) => {
    if (e.id !== id) return e;
    touched = { ...e, reuploadedAt: at };
    return touched;
  });
  if (!touched) return null;
  state = { ...state, entries, updatedAt: Date.now() };
  try {
    await repo.putDrawingRegister(state);
  } catch {
    // As everywhere else here: the note holds for this session regardless.
  }
  emit();
  return touched;
}

export async function registerDrawing(
  projectId: string,
  doc: CadDocument,
  originalFileName: string,
  assetId: string,
  contentHash?: string,
): Promise<DrawingRegisterEntry> {
  if (!state || state.projectId !== projectId) await loadDrawingRegister(projectId);
  const parsed = extractTitleBlock(doc, originalFileName);
  const existing =
    state!.entries.find((e) => e.documentId === doc.id) ??
    (contentHash ? state!.entries.find((e) => e.contentHash === contentHash) : undefined);
  const warnings = doc.diagnostics
    .filter((d) => d.severity === 'warning' || d.code === 'unsupported-entity')
    .map((d) => `${d.message}${d.count > 1 ? ` (${d.count})` : ''}`);
  const limited = warnings.some((w) => /unsupported|proxy|unknown|missing/i.test(w));
  const health = limited ? 'limited' : parsed.needsReview ? 'review' : 'ready';
  const entry: DrawingRegisterEntry = {
    id: existing?.id ?? newId('drw'),
    projectId,
    documentId: doc.id,
    assetId,
    originalFileName,
    displayName: parsed.displayName,
    drawingNumber: parsed.drawingNumber.value,
    identityKey: parsed.identityKey || doc.id,
    title: parsed.title.value,
    revision: parsed.revision.value,
    revisionRank: revisionRank(parsed.revision.value),
    issueDate: parsed.issueDate.value,
    discipline: parsed.discipline.value as DrawingRegisterEntry['discipline'],
    health,
    revisionState: 'review',
    // Stamped by the reconcile below; a lone drawing is v1 of 1.
    versionNo: existing?.versionNo ?? 1,
    versionCount: existing?.versionCount ?? 1,
    // The FIRST arrival, even when the same file comes back — that is the date
    // the practice received this drawing, and re-uploading it does not change
    // when it landed.
    importedAt: existing?.importedAt ?? Date.now(),
    ...(contentHash ? { contentHash } : existing?.contentHash ? { contentHash: existing.contentHash } : {}),
    ...(existing?.reuploadedAt ? { reuploadedAt: existing.reuploadedAt } : {}),
    warnings,
    evidence: {
      drawingNumber: parsed.drawingNumber,
      title: parsed.title,
      revision: parsed.revision,
      issueDate: parsed.issueDate,
      discipline: parsed.discipline,
    },
  };
  const entries = reconcileRevisionStates([...state!.entries.filter((e) => e.id !== entry.id), entry]);
  state = { projectId, entries, updatedAt: Date.now() };
  try {
    await repo.putDrawingRegister(state);
  } catch {
    // Keep the in-memory register alive; importCadDrawing reports source/doc
    // persistence failures separately.
  }
  const filed = entries.find((e) => e.id === entry.id)!;
  // Awaited, because the caller needs the row to exist before it can put the
  // uploaded file against it.
  await syncEntry(filed);
  // A revision supersedes its predecessor in `reconcileRevisionStates`; the
  // rows have to learn that too, or the database keeps two current sheets for
  // one drawing number.
  for (const other of entries) {
    if (other.id !== filed.id && other.identityKey === filed.identityKey) void syncEntry(other);
  }
  emit();
  return filed;
}

export async function updateDrawingEntry(
  id: string,
  patch: Partial<
    Pick<
      DrawingRegisterEntry,
      'originalFileName' | 'displayName' | 'drawingNumber' | 'title' | 'revision' | 'issueDate' | 'discipline'
    >
  >,
): Promise<void> {
  if (!state) return;
  const entries = state.entries.map((entry) => {
    if (entry.id !== id) return entry;
    const drawingNumber = patch.drawingNumber ?? entry.drawingNumber;
    const title = patch.title ?? entry.title;
    const revision = patch.revision ?? entry.revision;
    const identityKey = (drawingNumber || title).toUpperCase().replace(/[^A-Z0-9]+/g, '') || entry.identityKey;
    return {
      ...entry,
      ...patch,
      identityKey,
      revisionRank: revisionRank(revision),
      health: drawingNumber && revision ? 'ready' as const : 'review' as const,
      displayName: patch.displayName ?? `${drawingNumber || title} · ${revision || 'REV ?'}`,
      evidence: {
        ...entry.evidence,
        ...(patch.drawingNumber !== undefined ? { drawingNumber: { value: drawingNumber, source: 'user' as const, confidence: 1 } } : {}),
        ...(patch.title !== undefined ? { title: { value: title, source: 'user' as const, confidence: 1 } } : {}),
        ...(patch.revision !== undefined ? { revision: { value: revision, source: 'user' as const, confidence: 1 } } : {}),
        ...(patch.issueDate !== undefined ? { issueDate: { value: patch.issueDate, source: 'user' as const, confidence: 1 } } : {}),
        ...(patch.discipline !== undefined ? { discipline: { value: patch.discipline, source: 'user' as const, confidence: 1 } } : {}),
      },
    };
  });
  state = { ...state, entries: reconcileRevisionStates(entries), updatedAt: Date.now() };
  try {
    await repo.putDrawingRegister(state);
  } catch {
    // A correction remains valid for this session when storage is unavailable.
  }
  // A typed drawing number changes the identity key, which can re-order a
  // whole revision chain — so the chain is filed, not only the edited row.
  const edited = state.entries.find((e) => e.id === id);
  for (const entry of state.entries) {
    if (!edited || entry.id === id || entry.identityKey === edited.identityKey) void syncEntry(entry);
  }
  emit();
}

/**
 * Remove a drawing from the register.
 *
 * Two things make this more than a filter:
 *
 * The revision chain has to be re-reconciled. Deleting an R1 leaves its R0
 * marked "superseded" by a sheet that no longer exists â€” the register would
 * then show a package with no current drawing at all. Running the entries back
 * through `reconcileRevisionStates` promotes the survivor.
 *
 * The uploaded file is deliberately NOT deleted. The register promises the
 * original is preserved, and a mis-click here must not destroy the only copy
 * of a client's drawing. This removes the register's record of it.
 */
export async function removeDrawingEntry(id: string): Promise<DrawingRegisterEntry | null> {
  if (!state) return null;
  const gone = state.entries.find((e) => e.id === id) ?? null;
  if (!gone) return null;

  // THE ROW GOES FIRST, AND A REFUSAL IS AN ERROR.
  //
  // Unlike a filing failure, a delete that only happened locally is a lie the
  // next reload exposes: `loadDrawingRegister` reads the rows back and the
  // drawing returns. So this throws and the caller reports it, rather than
  // showing "Deleted" over a drawing that is still on file.
  if (isSupabaseConfigured()) await remote.deleteDrawingRow(gone.projectId, gone.documentId);

  const entries = state.entries.filter((e) => e.id !== id);
  state = { ...state, entries: reconcileRevisionStates(entries), updatedAt: Date.now() };
  try {
    await repo.putDrawingRegister(state);
  } catch {
    // Same graceful degradation as everywhere else here: the removal holds for
    // this session even when storage is unavailable.
  }
  // Deleting an R1 promotes its R0 back to current — the rows have to be told.
  for (const entry of state.entries) {
    if (entry.identityKey === gone.identityKey) void syncEntry(entry);
  }
  emit();
  return gone;
}

export function getDrawingRegister(): DrawingRegisterData | null {
  return state;
}

export function useDrawingRegister(projectId: string): DrawingRegisterData | null {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
  );
  useEffect(() => {
    if (state?.projectId !== projectId) void loadDrawingRegister(projectId);
  }, [projectId]);
  return state?.projectId === projectId ? state : null;
}
