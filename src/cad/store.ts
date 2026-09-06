// ============================================================
// Browser persistence — IndexedDB repository.
//
// Why not localStorage: real drawings are 5–13 MB of DXF source and the
// parsed CadDocument is larger again; the ~5 MB localStorage budget cannot
// hold one drawing, let alone a project full of them.
//
// Why the documents are stored as live objects and never JSON:
// CadDocument carries four Maps (layers, linetypes, textStyles, blocks).
// IndexedDB serialises with the structured clone algorithm, which round-trips
// Map natively. JSON.stringify(doc) would turn every one of them into `{}`
// and silently lose the whole symbol/layer table.
//
// Five stores, all keyed by PROJECT id:
//   projects      ProjectData             (small: BIM elements + metadata)
//   cadDocuments  CadDocument             (parsed drawing, out-of-line key)
//   cadSources    CadSource[]             (every original upload; never lost)
//   drawingRegisters DrawingRegisterData  (identity + revision chain)
//   projectArtifacts ProjectArtifact[]     (versioned quantity/BBS CSV files)
// ============================================================
import type { CadDocument } from './types';
import type { ProjectData, ProjectMeta } from '../core/types';
import type { DrawingRegisterData } from '../register/types';

// ============================================================
// THIS DATABASE IS A CACHE, NOT THE RECORD.
//
// Every store below has a home in Postgres and is written there first:
// `projects` → public.projects, `drawingRegisters` → public.drawings,
// `projectArtifacts` → public.project_artifacts, `projectFacts` →
// public.data_facts, `interviewLogs` → public.interview_logs,
// `drawingUnderstanding` → public.drawing_sections plus
// `drawings.split_manifest`, `cadSources` → the private `drawings` bucket.
//
// `cadDocuments` is the one store with no counterpart, and deliberately: a
// parsed document is DERIVED from the source bytes, which are in the bucket.
// Uploading the parse beside the file it came from would be a second copy of
// the same drawing that can disagree with the first, so it is re-derived on a
// cache miss instead (`hydrateMissing` in cad/import.ts).
//
// What that buys: the app opens instantly and keeps working with no network.
// What it costs: this data is one account's, so `clearCache` has to run on
// sign-out — the stores are keyed by project id, not by user, and leaving them
// would show one person's drawings to the next person who signs in here.
// ============================================================
export const DB_NAME = 'bimcad';
export const DB_VERSION = 6;
export const STORE_PROJECTS = 'projects';
export const STORE_CAD_DOCUMENTS = 'cadDocuments';
export const STORE_CAD_SOURCES = 'cadSources';
export const STORE_DRAWING_REGISTERS = 'drawingRegisters';
export const STORE_PROJECT_ARTIFACTS = 'projectArtifacts';
export const STORE_UNDERSTANDING = 'drawingUnderstanding';
export const STORE_PROJECT_FACTS = 'projectFacts';
export const STORE_INTERVIEW_LOGS = 'interviewLogs';

const ALL_STORES = [
  STORE_PROJECTS,
  STORE_CAD_DOCUMENTS,
  STORE_CAD_SOURCES,
  STORE_DRAWING_REGISTERS,
  STORE_PROJECT_ARTIFACTS,
  STORE_UNDERSTANDING,
  STORE_PROJECT_FACTS,
  STORE_INTERVIEW_LOGS,
];

export interface CadSource {
  id: string;
  documentId: string;
  name: string;
  bytes: ArrayBuffer;
  importedAt: number;
  convertedFromDwg?: boolean;
  /**
   * The DXF the converter produced, when this upload was a DWG.
   *
   * Both versions are kept deliberately. The DWG is what the client sent and
   * is the contractual original; the DXF is what every figure in this app was
   * actually read from. Discarding it — which is what happened before — means
   * a quantity can never be re-checked against the exact text it came from,
   * and re-converting is not the same thing: a newer converter reads the same
   * DWG differently.
   */
  convertedDxf?: string;
}

export interface UsageEstimate {
  usage: number;
  quota: number;
}

// ------------------------------------------------------------
// connection
// ------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // out-of-line keys for the CAD stores: the key is the project id, and
      // the stored value stays exactly the CadDocument / source record.
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CAD_DOCUMENTS)) {
        db.createObjectStore(STORE_CAD_DOCUMENTS);
      }
      if (!db.objectStoreNames.contains(STORE_CAD_SOURCES)) {
        db.createObjectStore(STORE_CAD_SOURCES);
      }
      if (!db.objectStoreNames.contains(STORE_DRAWING_REGISTERS)) {
        db.createObjectStore(STORE_DRAWING_REGISTERS);
      }
      if (!db.objectStoreNames.contains(STORE_PROJECT_ARTIFACTS)) {
        db.createObjectStore(STORE_PROJECT_ARTIFACTS);
      }
      // v4: drawing-understanding packages — one array per project, keyed by
      // project id exactly like the artifacts store. Additive, so an existing
      // database upgrades without touching what is already in it.
      if (!db.objectStoreNames.contains(STORE_UNDERSTANDING)) {
        db.createObjectStore(STORE_UNDERSTANDING);
      }
      // v5: the project fact ledger — one serialized ledger per project, keyed
      // by project id exactly like the understanding store. Additive.
      if (!db.objectStoreNames.contains(STORE_PROJECT_FACTS)) {
        db.createObjectStore(STORE_PROJECT_FACTS);
      }
      // v6: interview logs — the record of what was ASKED, which the ledger
      // has never held. One append-only array per project, keyed by project id
      // like the two stores above. Additive, so an existing database upgrades
      // without touching anything already in it.
      if (!db.objectStoreNames.contains(STORE_INTERVIEW_LOGS)) {
        db.createObjectStore(STORE_INTERVIEW_LOGS);
      }
    };
    req.onblocked = () =>
      reject(new Error('The bimcad database is blocked by another open tab. Close it and retry.'));
    req.onerror = () => reject(req.error ?? new Error('Could not open the bimcad database.'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
  });
  // never cache a failed connection — a later call should be able to retry
  pending.catch(() => {
    dbPromise = null;
  });
  dbPromise = pending;
  return pending;
}

/** Drop the cached connection (tests / teardown). */
/**
 * Empty every store. Sign-out, and nothing else.
 *
 * The stores are keyed by PROJECT, not by user, so there is no way to drop
 * only the account that is leaving — and the whole point of the cache is that
 * it is rebuildable, so dropping all of it costs a reload and nothing more.
 * One store refusing does not stop the others: a partial clear is better than
 * a browser that keeps everything because one transaction failed.
 */
export async function clearCache(): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openDB();
  } catch {
    return; // no IndexedDB, nothing cached
  }
  await Promise.all(
    ALL_STORES.filter((name) => db.objectStoreNames.contains(name)).map(
      (name) =>
        new Promise<void>((resolve) => {
          try {
            const tx = db.transaction(name, 'readwrite');
            tx.objectStore(name).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
          } catch {
            resolve();
          }
        }),
    ),
  );
}

export function closeDB(): void {
  const p = dbPromise;
  dbPromise = null;
  if (p) p.then((db) => db.close()).catch(() => undefined);
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });
}

/** Resolves when the transaction commits; rejects (rolled back) on abort. */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () =>
      reject(tx.error ?? new Error('IndexedDB transaction aborted — nothing was written.'));
  });
}

async function read<T>(store: string, key: IDBValidKey): Promise<T | null> {
  const db = await openDB();
  const tx = db.transaction(store, 'readonly');
  const value = await wrap<T | undefined>(tx.objectStore(store).get(key));
  return value ?? null;
}

// ------------------------------------------------------------
// quota
// ------------------------------------------------------------

/** Fraction of the quota we are willing to fill; the rest is headroom. */
export const QUOTA_HEADROOM = 0.9;

/**
 * Bytes an import will cost on disk: the original file plus the parsed
 * document, which for DXF runs roughly 3–5× the source once every entity is
 * an object graph. Deliberately pessimistic — a false "won't fit" is a clear
 * error message, a false "will fit" is a QuotaExceededError mid-write.
 */
export const IMPORT_SIZE_FACTOR = 5;

export function estimateImportBytes(sourceByteLength: number): number {
  return Math.ceil(sourceByteLength * IMPORT_SIZE_FACTOR);
}

/** Rough on-disk cost of a parsed document, used when no source is at hand. */
export function estimateDocumentBytes(doc: CadDocument): number {
  let entities = doc.entities.length;
  for (const block of doc.blocks.values()) entities += block.entities.length;
  for (const layout of doc.layouts) entities += layout.entities.length;
  // ~400 B per structured-cloned entity, plus the symbol tables
  return entities * 400 + (doc.layers.size + doc.linetypes.size + doc.textStyles.size) * 200;
}

/** Pure predicate so the quota rule is testable without a browser. */
export function fitsInQuota(estimate: UsageEstimate | null, needed: number): boolean {
  if (!estimate || estimate.quota <= 0) return true; // unknown budget — let the write try
  return estimate.usage + needed <= estimate.quota * QUOTA_HEADROOM;
}

export async function estimateUsage(): Promise<UsageEstimate | null> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storage || typeof storage.estimate !== 'function') return null;
  try {
    const est = await storage.estimate();
    if (typeof est.usage !== 'number' || typeof est.quota !== 'number') return null;
    return { usage: est.usage, quota: est.quota };
  } catch {
    return null;
  }
}

const MB = 1024 * 1024;
const mb = (n: number) => `${(n / MB).toFixed(1)} MB`;

async function assertQuota(needed: number, what: string): Promise<void> {
  const est = await estimateUsage();
  if (fitsInQuota(est, needed)) return;
  throw new Error(
    `Not enough browser storage for ${what}: it needs about ${mb(needed)} but only ` +
      `${mb(Math.max(0, est!.quota * QUOTA_HEADROOM - est!.usage))} of the ${mb(est!.quota)} ` +
      `budget is free (${mb(est!.usage)} already used). Delete a project and try again.`,
  );
}

// ------------------------------------------------------------
// projects
// ------------------------------------------------------------

/** Pure — exported so the list projection is testable without a browser. */
export function projectMeta(data: ProjectData): ProjectMeta {
  return {
    id: data.id,
    name: data.name,
    createdAt: data.createdAt,
    modifiedAt: data.modifiedAt,
    levelCount: data.levels.length,
    elementCount: data.elements.length,
    ...(data.client !== undefined ? { client: data.client } : {}),
    ...(data.projectNumber !== undefined ? { projectNumber: data.projectNumber } : {}),
    ...(data.archived !== undefined ? { archived: data.archived } : {}),
  };
}

export async function putProject(data: ProjectData): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_PROJECTS, 'readwrite');
  const done = txDone(tx);
  tx.objectStore(STORE_PROJECTS).put(data);
  await done;
}

export async function getProject(id: string): Promise<ProjectData | null> {
  return read<ProjectData>(STORE_PROJECTS, id);
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await openDB();
  const tx = db.transaction(STORE_PROJECTS, 'readonly');
  const all = await wrap<ProjectData[]>(tx.objectStore(STORE_PROJECTS).getAll());
  return all.map(projectMeta).sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** Removes the project and cascades to its CAD document and source file. */
export async function deleteProject(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(ALL_STORES, 'readwrite');
  const done = txDone(tx);
  tx.objectStore(STORE_PROJECTS).delete(id);
  tx.objectStore(STORE_CAD_DOCUMENTS).delete(id);
  tx.objectStore(STORE_CAD_SOURCES).delete(id);
  // The interview log is per project and goes with it. (The understanding and
  // fact stores are NOT cleared here — a pre-existing gap, left alone rather
  // than widened by a change about something else.)
  tx.objectStore(STORE_INTERVIEW_LOGS).delete(id);
  await done;
}

// ------------------------------------------------------------
// CAD documents + sources
// ------------------------------------------------------------

export async function putCadDocument(projectId: string, doc: CadDocument): Promise<void> {
  await assertQuota(estimateDocumentBytes(doc), `the drawing "${doc.name}"`);
  const db = await openDB();
  const tx = db.transaction(STORE_CAD_DOCUMENTS, 'readwrite');
  const done = txDone(tx);
  // stored as a live object graph — the Maps survive structured clone
  tx.objectStore(STORE_CAD_DOCUMENTS).put(doc, projectId);
  await done;
}

export async function getCadDocument(projectId: string): Promise<CadDocument | null> {
  // the value may now be an array of sheets; hand back the first
  const docs = await getCadDocuments(projectId);
  return docs[0] ?? null;
}


/**
 * Store every drawing open in a project.
 *
 * A project is a SET of sheets — architectural, structural, MEP — and
 * reopening it must restore all of them, not just the last import. Kept as an
 * array under the same key so older single-document records migrate lazily.
 */
export async function putCadDocuments(
  projectId: string,
  docs: CadDocument[],
): Promise<void> {
  const total = docs.reduce((n, d) => n + estimateDocumentBytes(d), 0);
  await assertQuota(total, `${docs.length} drawing${docs.length === 1 ? '' : 's'}`);
  const db = await openDB();
  const tx = db.transaction(STORE_CAD_DOCUMENTS, 'readwrite');
  const done = txDone(tx);
  tx.objectStore(STORE_CAD_DOCUMENTS).put(docs, projectId);
  await done;
}

/**
 * Every drawing in a project. Tolerates the older single-document shape so
 * projects saved before multi-sheet support still open.
 */
export async function getCadDocuments(projectId: string): Promise<CadDocument[]> {
  const raw = await read<CadDocument | CadDocument[]>(STORE_CAD_DOCUMENTS, projectId);
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export async function putCadSource(
  projectId: string,
  source: CadSource,
): Promise<void> {
  await assertQuota(source.bytes.byteLength, `the source file "${source.name}"`);
  const db = await openDB();
  const tx = db.transaction(STORE_CAD_SOURCES, 'readwrite');
  const done = txDone(tx);
  const store = tx.objectStore(STORE_CAD_SOURCES);
  const previous = await wrap<CadSource | CadSource[] | undefined>(store.get(projectId));
  const sources = !previous ? [] : Array.isArray(previous) ? previous : [previous];
  store.put([...sources.filter((s) => s.id !== source.id), source], projectId);
  await done;
}

export async function getCadSource(projectId: string): Promise<CadSource | null> {
  const sources = await getCadSources(projectId);
  return sources.length ? sources[sources.length - 1] : null;
}

export async function getCadSources(projectId: string): Promise<CadSource[]> {
  const raw = await read<CadSource | CadSource[]>(STORE_CAD_SOURCES, projectId);
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

// ------------------------------------------------------------
// drawing register
// ------------------------------------------------------------

export async function putDrawingRegister(data: DrawingRegisterData): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_DRAWING_REGISTERS, 'readwrite');
  const done = txDone(tx);
  tx.objectStore(STORE_DRAWING_REGISTERS).put(data, data.projectId);
  await done;
}

export async function getDrawingRegister(projectId: string): Promise<DrawingRegisterData | null> {
  return read<DrawingRegisterData>(STORE_DRAWING_REGISTERS, projectId);
}

// ------------------------------------------------------------
// issued quantity / BBS CSV artifacts
// ------------------------------------------------------------

export async function putProjectArtifacts<T>(projectId: string, artifacts: T[]): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_PROJECT_ARTIFACTS, 'readwrite');
  const done = txDone(tx);
  tx.objectStore(STORE_PROJECT_ARTIFACTS).put(artifacts, projectId);
  await done;
}

export async function getProjectArtifacts<T>(projectId: string): Promise<T[] | null> {
  return read<T[]>(STORE_PROJECT_ARTIFACTS, projectId);
}

// ------------------------------------------------------------
// drawing-understanding packages
// ------------------------------------------------------------

export async function putUnderstandingPackages<T>(projectId: string, packages: T[]): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_UNDERSTANDING, 'readwrite');
  const done = txDone(tx);
  tx.objectStore(STORE_UNDERSTANDING).put(packages, projectId);
  await done;
}

export async function getUnderstandingPackages<T>(projectId: string): Promise<T[] | null> {
  return read<T[]>(STORE_UNDERSTANDING, projectId);
}

// ------------------------------------------------------------
// interview logs — what was ASKED, not just what was answered
// ------------------------------------------------------------

export async function putInterviewLogs<T>(projectId: string, logs: T[]): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_INTERVIEW_LOGS, 'readwrite');
  const done = txDone(tx);
  tx.objectStore(STORE_INTERVIEW_LOGS).put(logs, projectId);
  await done;
}

export async function getInterviewLogs<T>(projectId: string): Promise<T[] | null> {
  return read<T[]>(STORE_INTERVIEW_LOGS, projectId);
}

// ------------------------------------------------------------
// project fact ledger
// ------------------------------------------------------------

/**
 * The ledger is stored as its serialized JSON string (src/facts/store.ts owns
 * the format), not a live object: one persisted shape shared by localStorage
 * and IndexedDB, one deserializer, one format version check.
 */
export async function putProjectFacts(projectId: string, serializedLedger: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_PROJECT_FACTS, 'readwrite');
  const done = txDone(tx);
  tx.objectStore(STORE_PROJECT_FACTS).put(serializedLedger, projectId);
  await done;
}

export async function getProjectFacts(projectId: string): Promise<string | null> {
  return read<string>(STORE_PROJECT_FACTS, projectId);
}

/**
 * Write a whole CAD import — project, parsed document and original file — in a
 * SINGLE readwrite transaction spanning the three stores. If any put fails
 * (quota, corrupt value) the transaction aborts and none of the three land, so
 * there is no project pointing at a document that was never stored.
 */
export async function putCadImport(
  project: ProjectData,
  doc: CadDocument,
  source: CadSource,
): Promise<void> {
  await assertQuota(estimateImportBytes(source.bytes.byteLength), `the drawing "${source.name}"`);
  const db = await openDB();
  const tx = db.transaction(ALL_STORES, 'readwrite');
  const done = txDone(tx);
  // no awaits between these — an idle transaction auto-commits
  tx.objectStore(STORE_PROJECTS).put(project);
  tx.objectStore(STORE_CAD_DOCUMENTS).put(doc, project.id);
  tx.objectStore(STORE_CAD_SOURCES).put([source], project.id);
  await done;
}
