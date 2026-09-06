// Harness memory.
//
// The engine accumulates what it has established about a drawing — measured
// findings, names the user corrected, conclusions reached in conversation —
// and feeds that forward as context for the next question. Two reasons this
// matters beyond convenience:
//
//   1. Answers stop contradicting each other. Without memory the model
//      re-derives its understanding every turn and can say two different
//      things about the same symbol in one session.
//   2. Corrections compound. A name the user fixed once is a fact from then
//      on, across questions and across drawings from the same office.
//
// Memory holds STATEMENTS, never quantities. Numbers are always recomputed
// from geometry at the moment they are needed, so a remembered fact can never
// go stale against an edited drawing.
import type { CadDocument } from '../types';

const LS_KEY = 'bimcad.memory';
const MAX_PER_DRAWING = 60;
const MAX_DRAWINGS = 40;

export type MemoryKind =
  | 'correction'   // the user renamed something — highest authority
  | 'finding'      // the engine measured something notable
  | 'conclusion'   // established during conversation
  | 'note';        // the user wrote it down

export interface MemoryItem {
  kind: MemoryKind;
  text: string;
  /** entity handles or block/layer keys this refers to */
  refs?: string[];
  at: number;
}

interface MemoryStore {
  /** keyed by drawing source file name */
  drawings: Record<string, MemoryItem[]>;
  /** applies to every drawing — office conventions, standing instructions */
  global: MemoryItem[];
}

function read(): MemoryStore {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as MemoryStore;
  } catch {
    /* corrupt or unavailable — start clean rather than throw */
  }
  return { drawings: {}, global: [] };
}

// ------------------------------------------------------------
// change notification
//
// Memory is written from deep inside the AI modules and read by the Memory
// tab. Without a signal the panel would show a stale list until something
// else re-rendered it, which is exactly the invisibility this file is meant
// to end.
// ------------------------------------------------------------
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeMemory(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a broken listener must not stop the others */
    }
  }
}

function write(store: MemoryStore): void {
  try {
    // keep the most recent drawings only; memory is an aid, not an archive
    const names = Object.keys(store.drawings);
    if (names.length > MAX_DRAWINGS) {
      const trimmed: Record<string, MemoryItem[]> = {};
      for (const n of names.slice(-MAX_DRAWINGS)) trimmed[n] = store.drawings[n];
      store.drawings = trimmed;
    }
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    /* quota — memory is best-effort */
  }
  notify();
}

function keyOf(doc: CadDocument): string {
  return doc.sourceFile || doc.name;
}

/** Everything remembered about this drawing, newest last. */
export function recall(doc: CadDocument): MemoryItem[] {
  const store = read();
  return [...store.global, ...(store.drawings[keyOf(doc)] ?? [])];
}

/**
 * The same facts, but with their scope kept apart.
 *
 * `recall` deliberately flattens the two because a prompt does not care where
 * a fact came from. A person does: "every drawing from this office" and "this
 * sheet" carry very different weight when you are deciding whether to trust a
 * figure, so the panel shows them separately.
 */
export function recallScoped(doc: CadDocument): {
  global: MemoryItem[];
  drawing: MemoryItem[];
} {
  const store = read();
  return { global: [...store.global], drawing: [...(store.drawings[keyOf(doc)] ?? [])] };
}

/**
 * Move a fact from this drawing up to every drawing.
 *
 * This is the "if required, use" half of memory: a convention noticed on one
 * sheet — this office writes covers in the title block, marks run P1..Pn — is
 * worth carrying forward, but only when a human says so. Nothing is promoted
 * automatically, because a wrong global fact contaminates every future
 * drawing instead of one.
 */
export function promoteToGlobal(doc: CadDocument, text: string): void {
  const store = read();
  const k = keyOf(doc);
  const item = (store.drawings[k] ?? []).find((m) => m.text === text);
  if (!item) return;
  store.drawings[k] = (store.drawings[k] ?? []).filter((m) => m.text !== text);
  store.global = [
    ...store.global.filter((m) => m.text.trim() !== text.trim()),
    { ...item, at: Date.now() },
  ].slice(-MAX_PER_DRAWING);
  write(store);
}

/** Drop a global fact. Same reasoning as `promoteToGlobal`, in reverse. */
export function forgetGlobal(text: string): void {
  const store = read();
  store.global = store.global.filter((m) => m.text !== text);
  write(store);
}

export function remember(doc: CadDocument, item: Omit<MemoryItem, 'at'>): void {
  const store = read();
  const k = keyOf(doc);
  const list = store.drawings[k] ?? [];
  // a repeated statement replaces the old one rather than stacking
  const dedup = list.filter((m) => m.text.trim() !== item.text.trim());
  dedup.push({ ...item, at: Date.now() });
  // corrections are never evicted before findings and conclusions
  const ranked = dedup
    .slice(-MAX_PER_DRAWING * 2)
    .sort((a, b) => rank(a) - rank(b) || a.at - b.at)
    .slice(-MAX_PER_DRAWING);
  store.drawings[k] = ranked;
  write(store);
}

export function rememberGlobal(item: Omit<MemoryItem, 'at'>): void {
  const store = read();
  store.global = [
    ...store.global.filter((m) => m.text.trim() !== item.text.trim()),
    { ...item, at: Date.now() },
  ].slice(-MAX_PER_DRAWING);
  write(store);
}

function rank(m: MemoryItem): number {
  switch (m.kind) {
    case 'correction': return 3;
    case 'note': return 2;
    case 'conclusion': return 1;
    default: return 0;
  }
}

export function forget(doc: CadDocument, text: string): void {
  const store = read();
  const k = keyOf(doc);
  store.drawings[k] = (store.drawings[k] ?? []).filter((m) => m.text !== text);
  write(store);
}

export function clearMemory(doc?: CadDocument): void {
  const store = read();
  if (doc) delete store.drawings[keyOf(doc)];
  else write({ drawings: {}, global: [] });
  if (doc) write(store);
}

/** Memory rendered for the prompt. Empty string when there is nothing to say. */
export function memoryContext(doc: CadDocument): string {
  const items = recall(doc);
  if (items.length === 0) return '';
  const lines = ['ESTABLISHED PREVIOUSLY (treat as known; corrections are authoritative):'];
  for (const m of items) {
    const tag =
      m.kind === 'correction' ? 'CORRECTED BY USER'
      : m.kind === 'note' ? 'USER NOTE'
      : m.kind === 'finding' ? 'MEASURED'
      : 'ESTABLISHED';
    lines.push(`  [${tag}] ${m.text}`);
  }
  return lines.join('\n');
}

/**
 * Record a Q&A exchange as a conclusion. Kept short deliberately — memory is
 * a running summary, not a transcript, and long entries crowd out the
 * measured facts in the prompt.
 */
export function rememberExchange(doc: CadDocument, question: string, answer: string): void {
  const trimmed = answer.replace(/\s+/g, ' ').trim();
  if (trimmed.length < 12) return;
  remember(doc, {
    kind: 'conclusion',
    text: `Q: ${question.replace(/\s+/g, ' ').trim().slice(0, 120)} → ${trimmed.slice(0, 260)}`,
  });
}
