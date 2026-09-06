// The Ask conversation, kept.
//
// WHY THIS EXISTS
//
// The chat lived in React state and nowhere else. `Assistant.tsx` renders the
// Ask panel as `tab === 'chat' && <DrawingAI/>`, so every visit to Quantities
// or BBS unmounted it and took the whole conversation with it — and collapsing
// the workbench routes you through Overview, so the loss happened on the most
// ordinary navigation there is. A BBS interview conducted over ten minutes of
// questions and answers vanished on one click, with no way back.
//
// A transcript is not a cache: nothing here is recomputed if it is missing, so
// losing it loses the record itself. It therefore persists like every other
// per-drawing store in this app — `bimcad.bbs.interview`, `bimcad.memory`,
// `bimcad.ai.log` — keyed the same way, trimmed the same way.
//
// WHAT IS DELIBERATELY NOT STORED
//
// Photos. A conversation carrying three phone pictures as data URLs is
// megabytes, and localStorage is measured in single-digit megabytes for the
// whole origin; one drawing would evict everything else. The transcript keeps
// what was SAID about a photo, which is what a later reader needs. It also
// holds no quantities — the same rule `memory.ts` runs on — so a stale
// transcript can never put a wrong figure anywhere.
import type { CadDocument } from '../types';
import type { ChatTurn } from './chat';

const LS_KEY = 'bimcad.ai.transcript';
/** turns kept per drawing — a long interview, not an archive */
const MAX_TURNS = 120;
const MAX_DRAWINGS = 20;

/** what one answer cost and where it looked, kept beside the turn it belongs to */
export interface TurnMeta {
  imageSent: boolean;
  imageNote?: string;
  planLine?: string;
  droppedCount?: number;
  planError?: string;
}

export interface ChatEntry {
  turn: ChatTurn;
  meta?: TurnMeta;
}

type Store = Record<string, ChatEntry[]>;

function keyOf(doc: CadDocument): string {
  return doc.sourceFile || doc.name;
}

function read(): Store {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Store;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    }
  } catch {
    /* corrupt — start clean rather than throw away the session */
  }
  return {};
}

/** Everything said about this drawing, oldest first. */
export function loadTranscript(doc: CadDocument | null): ChatEntry[] {
  if (!doc) return [];
  const hit = read()[keyOf(doc)];
  return Array.isArray(hit) ? hit : [];
}

/**
 * Replace this drawing's transcript.
 *
 * Called on every turn rather than appending, because the caller owns the
 * list: a turn can be edited in place (the meta line arrives with the answer)
 * and reconciling that through an append API would be more machinery than the
 * whole feature is worth.
 */
export function saveTranscript(doc: CadDocument | null, entries: ChatEntry[]): void {
  if (!doc) return;
  try {
    const store = read();
    const k = keyOf(doc);
    if (entries.length === 0) delete store[k];
    else store[k] = entries.slice(-MAX_TURNS);
    // keep the most recent drawings; an old sheet's chat is not worth the
    // quota that would stop today's from saving
    const names = Object.keys(store);
    if (names.length > MAX_DRAWINGS) {
      for (const n of names.slice(0, names.length - MAX_DRAWINGS)) delete store[n];
    }
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    // Quota, most likely. The conversation on screen is unaffected — it is
    // only the ability to come back to it that is lost, and failing the turn
    // itself would be a far worse trade.
  }
}

/** Forget one drawing's conversation — the Clear button. */
export function clearTranscript(doc: CadDocument | null): void {
  saveTranscript(doc, []);
}
