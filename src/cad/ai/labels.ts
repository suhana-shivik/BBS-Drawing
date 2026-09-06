// ============================================================
// Where meaning is kept, and how a human overrules it.
//
// Two things are persisted:
//
//   drawing labels   what this drawing's keys mean, so a reopened project is
//                    already labelled and the AI pass is not re-run for free.
//   dictionary       raw block/layer name → meaning, GLOBAL across drawings.
//                    Firms reuse block libraries; the second drawing from the
//                    same office should import mostly pre-labelled, and every
//                    correction a user makes should still be true next week.
//
// Precedence is fixed and never inverted: a human label (`userSet`) outranks a
// model label, always. A model pass can fill a blank; it cannot overwrite a
// correction. That is what makes a wrong label a one-click fix rather than a
// recurring argument with the software.
//
// Storage: `store.ts` owns the IndexedDB schema (projects / cadDocuments /
// cadSources at DB_VERSION 1) and none of its three stores is a fit for a
// small keyed blob — putting label records into `projects` would corrupt
// `listProjects()`, and into `cadDocuments` would break `estimateDocumentBytes`.
// Bumping DB_VERSION from here would race `store.openDB()` and throw
// VersionError in the app. So: use the IndexedDB store if one ever appears
// under the name below, otherwise localStorage, which comfortably holds label
// text (the multi-megabyte things — sources and parsed documents — stay in
// IndexedDB where they belong).
// ============================================================
import type { CadDocument, CadLabel } from '../types';
import type { AnalysisResult } from './contract';
import { toCadLabels } from './contract';
import { getCadSession, setCadLabel, setCadLabels } from '../session';
import { openDB } from '../store';
import { isGeneratedBlock } from './digest';

/** the object store used when the schema ever gains one; probed, never created */
export const STORE_LABELS = 'cadLabels';
const LS_PREFIX = 'bimcad.cad.';
const DICTIONARY_KEY = 'dictionary';

/** entries beyond this are dropped oldest-first so storage cannot grow forever */
export const MAX_DICTIONARY = 4000;

/**
 * A model suggestion is only worth carrying to the NEXT drawing if it was
 * reasonably confident. Corrections are always carried, whatever this says.
 */
const REMEMBER_CONFIDENCE = 0.6;

// ------------------------------------------------------------
// records
// ------------------------------------------------------------

export interface DictionaryEntry {
  /** the raw name as it appeared, for display */
  key: string;
  label: CadLabel;
  /** epoch ms of the last write, used for trimming */
  at: number;
}

/** keyed by `dictionaryKey(rawName)` */
export type LabelDictionary = Record<string, DictionaryEntry>;

interface DrawingLabelRecord {
  drawingId: string;
  at: number;
  labels: Record<string, CadLabel>;
}

/**
 * Block and layer names differ in case between offices and between exports of
 * the same file, so the dictionary is keyed case-insensitively. The original
 * spelling is kept on the entry.
 */
export function dictionaryKey(raw: string): string {
  return raw.trim().toUpperCase();
}

// ------------------------------------------------------------
// key-value storage (IndexedDB when available, else localStorage)
// ------------------------------------------------------------

async function labelDb(): Promise<IDBDatabase | null> {
  try {
    const db = await openDB();
    return db.objectStoreNames.contains(STORE_LABELS) ? db : null;
  } catch {
    return null;
  }
}

function lsGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function lsPut(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

async function kvGet<T>(key: string): Promise<T | null> {
  const db = await labelDb();
  if (!db) return lsGet<T>(key);
  return new Promise<T | null>((resolve) => {
    try {
      const req = db.transaction(STORE_LABELS, 'readonly').objectStore(STORE_LABELS).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => resolve(lsGet<T>(key));
    } catch {
      resolve(lsGet<T>(key));
    }
  });
}

async function kvPut(key: string, value: unknown): Promise<boolean> {
  const db = await labelDb();
  if (!db) return lsPut(key, value);
  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE_LABELS, 'readwrite');
      tx.objectStore(STORE_LABELS).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(lsPut(key, value));
      tx.onabort = () => resolve(lsPut(key, value));
    } catch {
      resolve(lsPut(key, value));
    }
  });
}

// ------------------------------------------------------------
// dictionary
// ------------------------------------------------------------

let cache: LabelDictionary | null = null;

/** drop the memo (tests, or after the user clears storage) */
export function resetDictionaryCache(): void {
  cache = null;
}

/** oldest entries first out the door, so a long-lived install stays bounded */
export function trimDictionary(dict: LabelDictionary, max = MAX_DICTIONARY): LabelDictionary {
  const entries = Object.entries(dict);
  if (entries.length <= max) return dict;
  entries.sort((a, b) => {
    // human corrections survive a trim that evicts model guesses
    const au = a[1].label.userSet ? 1 : 0;
    const bu = b[1].label.userSet ? 1 : 0;
    if (au !== bu) return bu - au;
    return b[1].at - a[1].at;
  });
  return Object.fromEntries(entries.slice(0, max));
}

export async function loadDictionary(): Promise<LabelDictionary> {
  if (cache) return cache;
  const stored = await kvGet<LabelDictionary>(DICTIONARY_KEY);
  cache = stored && typeof stored === 'object' ? stored : {};
  return cache;
}

async function saveDictionary(dict: LabelDictionary): Promise<void> {
  cache = dict;
  if (!(await kvPut(DICTIONARY_KEY, dict))) {
    // storage refused (quota) — trim hard and try once more, then give up
    // quietly: losing the dictionary must never lose the user's drawing
    const trimmed = trimDictionary(dict, Math.floor(MAX_DICTIONARY / 4));
    cache = trimmed;
    await kvPut(DICTIONARY_KEY, trimmed);
  }
}

/**
 * Write meanings into the global dictionary.
 *
 * A stored human correction is never demoted by a later model suggestion —
 * that is the whole value of the dictionary.
 */
export async function rememberLabels(entries: Iterable<[string, CadLabel]>): Promise<void> {
  const dict = { ...(await loadDictionary()) };
  const now = Date.now();
  let changed = false;

  for (const [key, label] of entries) {
    if (!key || !label?.label) continue;
    const k = dictionaryKey(key);
    if (!k) continue;
    const existing = dict[k];
    if (existing?.label.userSet && !label.userSet) continue;
    if (!label.userSet && (label.confidence ?? 0.75) < REMEMBER_CONFIDENCE) continue;
    dict[k] = { key: key.trim(), label: { ...label }, at: now };
    changed = true;
  }

  if (changed) await saveDictionary(trimDictionary(dict));
}

/** what the dictionary knows about a raw name */
export async function lookupLabel(key: string): Promise<CadLabel | null> {
  const dict = await loadDictionary();
  return dict[dictionaryKey(key)]?.label ?? null;
}

// ------------------------------------------------------------
// per-drawing labels
// ------------------------------------------------------------

const drawingKey = (drawingId: string): string => `labels:${drawingId}`;

/** the drawing the session currently has open, if any */
export function activeDrawingId(): string | null {
  return getCadSession().doc?.id ?? null;
}

export async function loadDrawingLabels(drawingId: string): Promise<Map<string, CadLabel>> {
  const rec = await kvGet<DrawingLabelRecord>(drawingKey(drawingId));
  const out = new Map<string, CadLabel>();
  if (!rec || typeof rec.labels !== 'object') return out;
  for (const [key, label] of Object.entries(rec.labels)) {
    if (label && typeof label.label === 'string') out.set(key, label);
  }
  return out;
}

export async function saveDrawingLabels(
  drawingId: string,
  labels: ReadonlyMap<string, CadLabel>,
): Promise<void> {
  const rec: DrawingLabelRecord = {
    drawingId,
    at: Date.now(),
    labels: Object.fromEntries(labels),
  };
  await kvPut(drawingKey(drawingId), rec);
}

// ------------------------------------------------------------
// merging — pure, so precedence is testable without a browser
// ------------------------------------------------------------

/**
 * Fold `incoming` into `current`.
 *
 * A `userSet` label in `current` is immovable unless the incoming label is
 * itself `userSet` (a fresh correction). Everything else is a straight
 * overwrite, so re-running the AI pass refreshes its own guesses.
 */
export function mergeLabels(
  current: ReadonlyMap<string, CadLabel>,
  incoming: ReadonlyMap<string, CadLabel>,
): Map<string, CadLabel> {
  const out = new Map(current);
  for (const [key, label] of incoming) {
    const existing = out.get(key);
    if (existing?.userSet && !label.userSet) continue;
    out.set(key, label);
  }
  return out;
}

/** every key in a drawing that can carry a meaning */
export function labelKeysOf(doc: CadDocument): string[] {
  const keys = new Set<string>();
  for (const b of doc.blocks.values()) {
    if (!isGeneratedBlock(b.name)) keys.add(b.name);
  }
  for (const l of doc.layers.keys()) keys.add(l);
  return [...keys];
}

// ------------------------------------------------------------
// the loop: dictionary → AI → correction → dictionary
// ------------------------------------------------------------

export interface DictionaryApplication {
  /** keys the dictionary could name */
  labelled: string[];
  /** keys nothing knows about yet — what the AI pass should be asked about */
  unknown: string[];
}

/**
 * Pre-fill labels from the dictionary at import time.
 *
 * Run this BEFORE any AI call. On the second drawing from an office most keys
 * are already known, so the request that follows is smaller, cheaper and only
 * about things genuinely never seen.
 */
export async function applyDictionary(doc: CadDocument): Promise<DictionaryApplication> {
  const dict = await loadDictionary();
  const current = getCadSession().labels;
  const next = new Map(current);
  const labelled: string[] = [];
  const unknown: string[] = [];

  for (const key of labelKeysOf(doc)) {
    const hit = dict[dictionaryKey(key)];
    if (!hit) {
      if (!next.get(key)) unknown.push(key);
      continue;
    }
    const existing = next.get(key);
    if (!(existing?.userSet && !hit.label.userSet)) next.set(key, { ...hit.label });
    labelled.push(key);
  }

  if (labelled.length) {
    setCadLabels(next);
    await saveDrawingLabels(doc.id, next);
  }
  return { labelled, unknown };
}

/** restore a reopened drawing's saved labels, then top up from the dictionary */
export async function restoreLabels(doc: CadDocument): Promise<Map<string, CadLabel>> {
  const saved = await loadDrawingLabels(doc.id);
  if (saved.size) setCadLabels(mergeLabels(getCadSession().labels, saved));
  await applyDictionary(doc);
  return new Map(getCadSession().labels);
}

/**
 * Apply an `AnalysisResult` to the session and persist it.
 *
 * The result has already been through `parseAnalysis`, so it holds no
 * quantities and no keys this drawing does not contain.
 */
export async function applyAnalysis(
  result: AnalysisResult,
  opts: { drawingId?: string | null; remember?: boolean } = {},
): Promise<Map<string, CadLabel>> {
  const incoming = toCadLabels(result);
  const merged = mergeLabels(getCadSession().labels, incoming);
  setCadLabels(merged);

  const id = opts.drawingId ?? activeDrawingId();
  if (id) await saveDrawingLabels(id, merged);
  if (opts.remember !== false) await rememberLabels(incoming);
  return merged;
}

/**
 * A human overrules the model.
 *
 * Writes through to the dictionary so the same block in next month's drawing
 * arrives already correct — the correction is the durable artefact here, not
 * the model's guess.
 */
export async function correctLabel(key: string, label: string | CadLabel): Promise<CadLabel> {
  const base: CadLabel =
    typeof label === 'string'
      ? { label: label.trim(), userSet: true }
      : { ...label, userSet: true };
  const next: CadLabel = { ...base, label: base.label.trim().slice(0, 80), confidence: undefined };
  if (!next.label) throw new Error('A label needs some text.');

  setCadLabel(key, next);
  const id = activeDrawingId();
  if (id) await saveDrawingLabels(id, getCadSession().labels);
  await rememberLabels([[key, next]]);
  return next;
}

/** forget a label everywhere: this drawing and the dictionary */
export async function clearLabel(key: string): Promise<void> {
  setCadLabel(key, null);
  const id = activeDrawingId();
  if (id) await saveDrawingLabels(id, getCadSession().labels);
  const dict = { ...(await loadDictionary()) };
  if (dict[dictionaryKey(key)]) {
    delete dict[dictionaryKey(key)];
    await saveDictionary(dict);
  }
}

/** keys a human has already settled — the AI pass has no business re-asking */
export function userSetKeys(): Set<string> {
  const out = new Set<string>();
  for (const [key, label] of getCadSession().labels) {
    if (label.userSet) out.add(key);
  }
  return out;
}
