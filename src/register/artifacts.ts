import { useEffect, useSyncExternalStore } from 'react';
import { newId } from './id';
import * as repo from '../cad/store';
import * as remote from '../data/artifacts';
import { isSupabaseConfigured } from '../lib/supabase';

/**
 * A derived output filed against a drawing.
 *
 * `sections` is the drawing-understanding package: unlike the other two it is
 * an INDEX, not the thing itself. The section DXFs and PNGs run to megabytes
 * and live in their own store; copying them in here would load every one of
 * them every time the register lists a folder.
 */
export type ProjectArtifactKind = 'quantity' | 'bbs' | 'sections' | 'about';

export interface ProjectArtifact {
  id: string;
  projectId: string;
  documentId: string;
  kind: ProjectArtifactKind;
  fileName: string;
  drawingName: string;
  drawingNumber: string;
  revision: string;
  version: number;
  mimeType: 'text/csv' | 'application/json';
  content: string;
  createdAt: number;
}

const cache = new Map<string, ProjectArtifact[]>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/**
 * Fields that change on every run WITHOUT the document changing: the result's
 * own id (`orchestrated-<startedAt>`) and its timestamps.
 *
 * They are why a byte comparison does not work here. Two rebuilds of an
 * unchanged schedule differ only in these, so comparing raw content calls them
 * different documents and files another version — which is how one drawing
 * came to have 326 outputs that were all "distinct".
 */
// Volatile WHEREVER they appear. `manifest.buildId` is a fresh UUID on every
// build, nested two levels down, and it alone made 163 identical schedules
// look like 163 versions.
const VOLATILE_ANYWHERE = new Set(['buildId', 'builtAt', 'updatedAt', 'exportedAt']);
// Volatile only at the TOP. A row's `id` is its bar mark and means something;
// only the result's own id is noise.
const VOLATILE_AT_ROOT = new Set(['id']);

function stripVolatile(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((item) => stripVolatile(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (VOLATILE_ANYWHERE.has(key)) continue;
    if (depth === 0 && VOLATILE_AT_ROOT.has(key)) continue;
    out[key] = stripVolatile(inner, depth + 1);
  }
  return out;
}

/**
 * What makes two filed outputs the SAME document. JSON is compared with the
 * volatile fields removed; anything else is compared as it stands.
 */
export function artifactFingerprint(content: string, mimeType: string): string {
  if (mimeType !== 'application/json') return content;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object') return content;
    return JSON.stringify(stripVolatile(parsed));
  } catch {
    // Not JSON after all — compare it as text rather than declaring it equal
    // to something it may not be.
    return content;
  }
}

export function nextArtifactVersion(
  artifacts: readonly ProjectArtifact[],
  documentId: string,
  kind: ProjectArtifactKind,
): number {
  return artifacts
    .filter((item) => item.documentId === documentId && item.kind === kind)
    .reduce((highest, item) => Math.max(highest, item.version), 0) + 1;
}

export async function loadProjectArtifacts(projectId: string): Promise<ProjectArtifact[]> {
  // The database is the record of what this project has produced; the browser
  // store is a mirror of it. A filed schedule that exists only in one browser
  // is not filed at all.
  if (isSupabaseConfigured()) {
    try {
      const rows = await remote.listArtifacts(projectId);
      cache.set(projectId, rows);
      emit();
      // Keep the local mirror current so the register still lists outputs if
      // the network drops mid-session.
      void repo.putProjectArtifacts(projectId, rows).catch(() => {});
      return rows;
    } catch {
      // fall through to the mirror rather than showing an empty Outputs folder
    }
  }
  // `getProjectArtifacts` is generic; without the argument T infers as unknown
  const saved = await repo.getProjectArtifacts<ProjectArtifact>(projectId).catch(() => null);
  const artifacts = saved ?? [];
  cache.set(projectId, artifacts);
  emit();
  return artifacts;
}

export async function saveProjectArtifact(
  input: Omit<ProjectArtifact, 'id' | 'version' | 'createdAt' | 'fileName'> & { fileName?: string },
): Promise<ProjectArtifact> {
  const current = cache.has(input.projectId)
    ? cache.get(input.projectId)!
    : await loadProjectArtifacts(input.projectId);

  // A VERSION IS A CHANGE, NOT A RUN.
  //
  // Rebuilding a schedule that comes out identical is not a new document — it
  // is the same document, computed again. Filing it anyway turns an Outputs
  // folder into a list of forty-nine indistinguishable workbooks and makes the
  // real history (v1 read the sheet, v2 had the cover, v3 had the run)
  // impossible to find. So an identical payload returns the version already on
  // file and writes nothing.
  const latest = current
    .filter((a) => a.documentId === input.documentId && a.kind === input.kind)
    .sort((a, b) => b.version - a.version)[0];
  if (
    latest &&
    latest.mimeType === input.mimeType &&
    artifactFingerprint(latest.content, latest.mimeType) ===
      artifactFingerprint(input.content, input.mimeType)
  ) {
    return latest;
  }

  const artifactVersion = nextArtifactVersion(current, input.documentId, input.kind);
  const safeName = (input.drawingNumber || input.drawingName || 'drawing')
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '');
  const suffix =
    input.kind === 'quantity' ? 'QTY' :
      input.kind === 'bbs' ? 'BBS' :
        input.kind === 'about' ? 'ABOUT-DRAWING' : 'SECTIONS';
  const ext = input.mimeType === 'application/json' ? 'json' : 'csv';
  const artifact: ProjectArtifact = {
    ...input,
    fileName: input.fileName || `${safeName}-${suffix}-v${artifactVersion}.${ext}`,
    id: newId('artifact'),
    version: artifactVersion,
    createdAt: Date.now(),
  };
  // THE ROW'S ID WINS.
  //
  // `newId('artifact')` is only a placeholder for the offline case. When the
  // database files the row it generates a uuid, and that uuid is the only
  // value `deleteArtifact` can address the row by — so the record kept in the
  // cache and in the mirror carries it, not the local one. Filing under the
  // local id is what made Delete look like it worked and then hand the output
  // straight back on the next load.
  const filed = isSupabaseConfigured()
    ? { ...artifact, id: await remote.insertArtifact(artifact) }
    : artifact;
  const next = [filed, ...current];
  await repo.putProjectArtifacts(input.projectId, next).catch(() => {
    /* the mirror is best-effort once the database has it */
  });
  cache.set(input.projectId, next);
  emit();
  return filed;
}

/**
 * Drop every artifact filed against one document — a BBS run, a quantity
 * take-off, the sections index, the "about this drawing" note. Called when
 * the drawing itself is deleted: these are outputs FILED UNDER it, not
 * independent records, so removing the drawing without them would leave a
 * BBS workbook in Outputs with no drawing left to have produced it.
 */
export async function removeProjectArtifactsForDocument(
  projectId: string,
  documentId: string,
): Promise<void> {
  const current = cache.has(projectId) ? cache.get(projectId)! : await loadProjectArtifacts(projectId);
  const next = current.filter((item) => item.documentId !== documentId);
  if (next.length === current.length) return;
  // The rows FIRST, and the mirror only if they went. Clearing the mirror
  // alone is what `loadProjectArtifacts` undoes on the next open — it reads
  // the database and overwrites the mirror with whatever is still filed there.
  if (isSupabaseConfigured()) await remote.deleteArtifactsForDocument(projectId, documentId);
  await repo.putProjectArtifacts(projectId, next).catch(() => {
    /* the mirror is best-effort once the database has agreed */
  });
  cache.set(projectId, next);
  emit();
}

/**
 * Delete one filed output directly — an old BBS or quantity version, deleted
 * on its own rather than by deleting the drawing that produced it. Unlike
 * `removeProjectArtifactsForDocument` this drops exactly one version; the
 * others filed against the same document (and same drawing) are untouched.
 */
export async function removeProjectArtifact(projectId: string, artifactId: string): Promise<void> {
  const current = cache.has(projectId) ? cache.get(projectId)! : await loadProjectArtifacts(projectId);
  const next = current.filter((item) => item.id !== artifactId);
  if (next.length === current.length) return;
  if (isSupabaseConfigured()) await remote.deleteArtifact(artifactId);
  await repo.putProjectArtifacts(projectId, next).catch(() => {
    /* the mirror is best-effort once the database has agreed */
  });
  cache.set(projectId, next);
  emit();
}

export function useProjectArtifacts(projectId: string): ProjectArtifact[] {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  useEffect(() => {
    if (!cache.has(projectId)) void loadProjectArtifacts(projectId);
  }, [projectId]);
  return cache.get(projectId) ?? [];
}
