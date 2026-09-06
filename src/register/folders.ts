// ============================================================
// Folders a person makes, alongside the ones the system infers.
//
// The built-in folders are DERIVED — a drawing is in "Structural" because its
// discipline says so, and in "Superseded" because a newer revision exists.
// They cannot be wrong for long, and they cannot be personal.
//
// Real filing is personal. "WH-4 package", "Issued to Sharma", "Priced" —
// groupings that mean something on this project and nothing on the next, that
// no rule could infer, and that a person needs to be able to make in the
// moment. So user folders sit beside the derived ones and hold whatever is put
// in them.
//
// They are a SECOND membership, not a move. A drawing in "WH-4 package" is
// still in Structural and still supersedable — filing it by hand must not
// remove it from the views that keep it honest.
// ============================================================

import { useEffect, useSyncExternalStore } from 'react';
import { newId } from './id';
import * as remote from '../data/folders';
import { isSupabaseConfigured } from '../lib/supabase';

export interface UserFolder {
  id: string;
  name: string;
  /** drawing ids placed here by hand */
  members: string[];
  createdAt: number;
}

const LS_KEY = 'bimcad.register.folders';

// ============================================================
// LOCAL FIRST, ROW IMMEDIATELY AFTER.
//
// The tree renders from a synchronous snapshot — `useSyncExternalStore` needs
// one, and a person clicking New → Folder must get a folder, not a spinner —
// so `localStorage` stays the thing every read goes through. What changed is
// that it is now a CACHE of `public.project_folders` rather than the only
// copy: filing that lived in one browser profile was lost with site data and
// invisible on a second machine, while the drawings it organised sat safely in
// `public.drawings`.
//
// Writes therefore go local-then-remote, never remote-then-local. `push` is
// not awaited and cannot throw into a caller; a folder made with the network
// down is filed by `hydrateFolders` on the next open, which pushes back
// anything the database has not seen.
// ============================================================

function push(projectId: string, folder: UserFolder): void {
  if (!isSupabaseConfigured()) return;
  void remote.upsertFolderRow(projectId, folder).catch((err: unknown) => {
    console.warn('[folders] the folder is not saved to the database yet:', err);
  });
}

function drop(projectId: string, folderId: string): void {
  if (!isSupabaseConfigured()) return;
  void remote.deleteFolderRow(projectId, folderId).catch((err: unknown) => {
    console.warn('[folders] the folder is still in the database:', err);
  });
}

/** Projects already reconciled this session — one round trip each, not one per render. */
const hydrated = new Set<string>();

/**
 * Bring this browser's folders and the project's rows into agreement.
 *
 * The row wins on name and membership: it is the record, and the other
 * machine's edit is the newer one as often as not. A folder only this browser
 * knows is KEPT and pushed up rather than deleted — it is an offline create,
 * not a delete performed somewhere else. That asymmetry is deliberate and it
 * has a cost: a folder deleted on machine A comes back if machine B still has
 * it cached and opens the project. Losing a label that way is recoverable in
 * one click; silently deleting an afternoon of filing is not.
 */
export async function hydrateFolders(projectId: string): Promise<void> {
  if (!isSupabaseConfigured() || hydrated.has(projectId)) return;
  hydrated.add(projectId);
  let rows: remote.FolderRow[];
  try {
    rows = await remote.listFolderRows(projectId);
  } catch (err) {
    hydrated.delete(projectId);
    console.warn('[folders] could not read your folders from the database:', err);
    return;
  }
  const all = readAll();
  const local = all[projectId] ?? [];
  const merged: UserFolder[] = rows.map((row) => ({
    id: row.local_id,
    name: row.name,
    members: row.members,
    createdAt: Date.parse(row.created_at) || Date.now(),
  }));
  const known = new Set(merged.map((f) => f.id));
  const unfiled = local.filter((f) => !known.has(f.id));
  all[projectId] = [...merged, ...unfiled].sort((a, b) => a.createdAt - b.createdAt);
  write(all);
  for (const folder of unfiled) push(projectId, folder);
}

/**
 * Tests and sign-out: reconcile again on the next open.
 *
 * The in-memory snapshots go too. `clearAccountLocalState` empties the
 * `localStorage` key, but `listFolders` hands out a memoised array and would
 * otherwise keep serving the previous account's folder names from it until
 * something else happened to write.
 */
export function resetFolderHydration(): void {
  hydrated.clear();
  snapshots.clear();
  version += 1;
  notify();
}

type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * A stable array per project, replaced only when something is written.
 *
 * `listFolders` sorts a fresh array on every call, and a `useSyncExternalStore`
 * snapshot that is a new object every time re-renders forever. So the list is
 * built once per write and handed out by reference until the next one.
 */
const snapshots = new Map<string, UserFolder[]>();
let version = 0;

export function subscribeFolders(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* one broken listener must not stop the rest */
    }
  }
}

function readAll(): Record<string, UserFolder[]> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, UserFolder[]>;
  } catch {
    /* corrupt — folders are a convenience, not a record of truth */
  }
  return {};
}

function write(all: Record<string, UserFolder[]>): void {
  snapshots.clear();
  version += 1;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    /* quota — best effort */
  }
  notify();
}

export function listFolders(projectId: string): UserFolder[] {
  const cached = snapshots.get(projectId);
  if (cached) return cached;
  const list = [...(readAll()[projectId] ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  snapshots.set(projectId, list);
  return list;
}

/** The same list, live: re-renders when a folder is made, renamed or filled. */
export function useProjectFolders(projectId: string): UserFolder[] {
  useSyncExternalStore(subscribeFolders, () => version);
  // The one place a project's folders are read for the screen, so the one
  // place worth reconciling them from. `hydrateFolders` is a no-op after the
  // first call per project.
  useEffect(() => {
    void hydrateFolders(projectId);
  }, [projectId]);
  return listFolders(projectId);
}

export function createFolder(projectId: string, name: string): UserFolder {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error('A folder needs a name.');
  const all = readAll();
  const mine = all[projectId] ?? [];
  if (mine.some((f) => f.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`"${clean}" already exists.`);
  }
  const folder: UserFolder = {
    // `newId`, not a timestamp. Both halves of the old id — `Date.now()` and
    // `Math.floor(performance.now())` — are millisecond clocks, so two folders
    // made in the same millisecond were given the SAME id: filing a drawing
    // into one filed it into both, and a move could not tell them apart
    // because there was nothing to tell apart. `newId` carries a counter and a
    // random tail and cannot collide with itself.
    id: newId('uf'),
    name: clean,
    members: [],
    createdAt: Date.now(),
  };
  all[projectId] = [...mine, folder];
  write(all);
  push(projectId, folder);
  return folder;
}

export function renameFolder(projectId: string, id: string, name: string): void {
  const clean = name.trim().slice(0, 60);
  if (!clean) return;
  const all = readAll();
  all[projectId] = (all[projectId] ?? []).map((f) => (f.id === id ? { ...f, name: clean } : f));
  write(all);
  const renamed = all[projectId].find((f) => f.id === id);
  if (renamed) push(projectId, renamed);
}

/**
 * Delete a folder, never its drawings.
 *
 * The folder is a label. Removing a label cannot remove the thing labelled —
 * the drawings stay in the register and in every derived view they belonged to.
 */
export function deleteFolder(projectId: string, id: string): void {
  const all = readAll();
  all[projectId] = (all[projectId] ?? []).filter((f) => f.id !== id);
  write(all);
  drop(projectId, id);
}

export function setMembership(
  projectId: string,
  folderId: string,
  drawingId: string,
  member: boolean,
): void {
  const all = readAll();
  all[projectId] = (all[projectId] ?? []).map((f) => {
    if (f.id !== folderId) return f;
    const has = f.members.includes(drawingId);
    if (member === has) return f;
    return {
      ...f,
      members: member ? [...f.members, drawingId] : f.members.filter((m) => m !== drawingId),
    };
  });
  write(all);
  const changed = all[projectId].find((f) => f.id === folderId);
  if (changed) push(projectId, changed);
}

/**
 * MOVE: exactly one filing location, not one more.
 *
 * `setMembership` adds or removes ONE membership and leaves the rest alone —
 * right for "also file this under Priced". A move is the other statement: this
 * drawing lives HERE now, so it leaves every other folder a person made.
 * `null` moves it out of all of them and it is filed by its discipline alone.
 *
 * `keys` is every id this node has ever been filed under — the document id it
 * uses now and the register entry id it used before that. Both are removed,
 * because leaving one behind would move the drawing and leave a copy of it in
 * the folder it came from.
 *
 * NOTHING HERE TOUCHES THE DISCIPLINE, and nothing here can: a discipline is
 * read off the sheet's title block and lives on the register entry, which this
 * module has no reference to. That is the point of keeping filing in its own
 * module — a move cannot silently reclassify a drawing, because the code that
 * moves it cannot reach the field that would say so.
 *
 * One write, not one per folder: `write` notifies subscribers, and removing a
 * drawing from three folders in three writes would re-render the tree three
 * times with the drawing briefly nowhere.
 */
export function moveMembership(
  projectId: string,
  keys: readonly string[],
  folderId: string | null,
  filingKey = keys[0],
): void {
  const all = readAll();
  const mine = all[projectId] ?? [];
  const wanted = new Set(keys);
  let changed = false;
  const next = mine.map((f) => {
    const keep = f.members.filter((m) => !wanted.has(m));
    const target = f.id === folderId;
    const members = target ? [...keep, filingKey] : keep;
    if (members.length === f.members.length && (!target || f.members.includes(filingKey))) {
      return f;
    }
    changed = true;
    return { ...f, members };
  });
  if (!changed) return;
  all[projectId] = next;
  write(all);
  for (const f of next) {
    const before = mine.find((m) => m.id === f.id);
    if (before !== f) push(projectId, f);
  }
}

/** Which user folders a drawing has been filed into. */
export function foldersOf(projectId: string, drawingId: string): UserFolder[] {
  return listFolders(projectId).filter((f) => f.members.includes(drawingId));
}
