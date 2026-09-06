// Fact ledger persistence — JSON serialization and per-project localStorage.
//
// The ledger is a plain value, so persistence is a straight JSON round-trip;
// provenance (source, evidence, method, basis, supersededBy chains) must
// survive intact. localStorage access is guarded so the module also loads in
// non-browser test environments.

import type { Ledger, LedgerEntry } from './ledger';
import { getProjectFacts, putProjectFacts } from '../cad/store';
import { isSupabaseConfigured } from '../lib/supabase';
import { loadLedgerRemote, saveLedgerRemote } from '../data/facts';

const FORMAT_VERSION = 1;
const KEY_PREFIX = 'facts-ledger:';

interface SerializedLedger {
  version: number;
  entries: LedgerEntry[];
}

export function serializeLedger(ledger: Ledger): string {
  const payload: SerializedLedger = {
    version: FORMAT_VERSION,
    entries: ledger.entries as LedgerEntry[],
  };
  return JSON.stringify(payload);
}

export function deserializeLedger(json: string): Ledger {
  const payload = JSON.parse(json) as SerializedLedger;
  if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.entries)) {
    throw new Error('facts/store: not a serialized ledger');
  }
  if (payload.version !== FORMAT_VERSION) {
    throw new Error(`facts/store: unsupported ledger format version ${payload.version}`);
  }
  return { entries: payload.entries };
}

export function ledgerStorageKey(projectKey: string): string {
  return `${KEY_PREFIX}${projectKey}`;
}

function storageOrNull(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null; // e.g. storage disabled, or non-browser env
  }
}

/** Persist the ledger for a project. No-op (returns false) without localStorage. */
export function saveLedger(projectKey: string, ledger: Ledger): boolean {
  const storage = storageOrNull();
  if (!storage) return false;
  storage.setItem(ledgerStorageKey(projectKey), serializeLedger(ledger));
  return true;
}

/** Load a project's ledger, or null when absent/unreadable/no storage. */
export function loadLedger(projectKey: string): Ledger | null {
  const storage = storageOrNull();
  if (!storage) return null;
  const json = storage.getItem(ledgerStorageKey(projectKey));
  if (json === null) return null;
  try {
    return deserializeLedger(json);
  } catch {
    return null;
  }
}

/** Remove a project's persisted ledger. */
export function deleteLedger(projectKey: string): void {
  storageOrNull()?.removeItem(ledgerStorageKey(projectKey));
}

// ------------------------------------------------------------
// IndexedDB promotion (PRODUCT_AS_HARNESS §3.1)
// ------------------------------------------------------------
// The durable home is the STORE_PROJECT_FACTS object store in the bimcad
// database, same additive pattern as drawingUnderstanding. The localStorage
// path above stays as the fallback for tests and non-IndexedDB environments —
// same serialized format either way, so a ledger written by one path is
// readable by the other.

// ------------------------------------------------------------
// Postgres, when there is an account behind the app
// ------------------------------------------------------------
//
// The specification IS the fact ledger, so with Supabase configured the
// ledger's durable home is `data_facts` — one row per ENTRY, keeping the
// append-only history and its supersede chains (src/data/facts.ts). IndexedDB
// stays underneath as a local mirror: it is what the app reads if the network
// is down mid-session, and it costs one cheap write.
//
// The remote write is awaited and its failure is REPORTED, not swallowed. A
// user's answer that reached only this browser is the exact failure this whole
// migration exists to end — it would recalculate here and be gone tomorrow.

/**
 * Persist the ledger for a project. With Supabase configured the database is
 * the durable home and IndexedDB is a mirror; without it, the original
 * IndexedDB-then-localStorage behaviour stands.
 *
 * Resolves false only when nothing durable accepted the write.
 */
export async function saveLedgerIdb(
  projectId: string,
  ledger: Ledger,
  opts: { documentId?: string | null } = {},
): Promise<boolean> {
  let local = false;
  try {
    await putProjectFacts(projectId, serializeLedger(ledger));
    local = true;
  } catch {
    local = saveLedger(projectId, ledger);
  }

  if (!isSupabaseConfigured()) return local;
  await saveLedgerRemote(projectId, ledger, { documentId: opts.documentId ?? null });
  return true;
}

/**
 * Load a project's ledger. The database wins when it has anything: it is the
 * shared record, and a local mirror can only ever be this browser's copy of
 * an older moment.
 */
export async function loadLedgerIdb(projectId: string): Promise<Ledger | null> {
  if (isSupabaseConfigured()) {
    const remote = await loadLedgerRemote(projectId);
    if (remote.entries.length > 0) return remote;
    // No rows yet: fall through, so a ledger that only exists locally (written
    // before this project was signed in to) is still offered rather than lost.
  }
  try {
    const json = await getProjectFacts(projectId);
    if (json !== null) return deserializeLedger(json);
  } catch {
    // fall through to localStorage
  }
  return loadLedger(projectId);
}
