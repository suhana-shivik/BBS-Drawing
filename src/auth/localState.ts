// ============================================================
// What has to be forgotten when someone signs out.
//
// Projects, drawings, facts and schedules live in Postgres behind Row Level
// Security, so the next person to sign in on this browser cannot READ any of
// them. But the app also keeps local caches, and several of them are keyed by
// a drawing's FILE NAME rather than by user or project — the model's notes on
// a sheet, the Ask transcript, typed overrides, cached readings. Left in
// place, those are one user's working notes sitting in the next user's
// browser. They are all caches and all rebuildable, so sign-out drops them.
//
// TWO THINGS SURVIVE ON PURPOSE:
//   · the UI chrome (theme, panel widths) — a property of the device, not of
//     the account, and forgetting it makes signing out feel like a fault;
//   · the OpenRouter key, which the person operating this machine entered as
//     their own credential.
//
// Supabase's own auth token is not touched here — signOut() owns that.
// ============================================================

/** Exact keys that hold one account's working state. */
const EXACT_KEYS = [
  'studio.boot.v1', // last project opened
  'studio.recentProjects.v1',
  'bimcad.register.folders',
  'bimcad.bbs.overrides',
  'bimcad.bbs.interview',
  'bimcad.bbs.readings',
  'bimcad.understanding',
  'bimcad.memory',
  'bimcad.ai.transcript',
  'bimcad.ai.log',
  'bimcad.boq.profiles',
  'bimcad.cad.dictionary',
];

/** Prefixes whose every key belongs to one account's work. */
const PREFIXES = ['studio.expand.', 'facts-ledger:', 'bimcad.cad.labels:'];

/** Kept: device chrome and the operator's own API key. */
const KEEP = new Set(['studio.ui.v1', 'bimcad.openrouter.key']);

export function clearAccountLocalState(storage?: Storage): void {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return;
  const doomed: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key || KEEP.has(key)) continue;
    if (EXACT_KEYS.includes(key) || PREFIXES.some((p) => key.startsWith(p))) doomed.push(key);
  }
  for (const key of doomed) {
    try {
      store.removeItem(key);
    } catch {
      // A storage that refuses to delete (private mode, quota) is not a reason
      // to abandon the sign-out — the session is already gone.
    }
  }
}
