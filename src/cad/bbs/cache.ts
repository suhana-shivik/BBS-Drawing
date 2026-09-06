// The model's reading of a drawing, kept.
//
// Interpreting a reinforcement drawing is the one genuinely expensive step in
// the schedule: it costs a request, several seconds, and money. Everything
// after it — cutting lengths, counts, weights, the steel summary — is
// arithmetic the engine redoes in a millisecond.
//
// So THE READING is what gets cached, not the schedule built from it. Two
// consequences, both wanted:
//
//   * Reopening a drawing restores its schedule instantly and for free.
//   * A cached reading combined with changed settings or overrides produces
//     the NEW numbers, not stale ones. Caching the computed rows instead would
//     have meant a cover change silently showing the old tonnage.
//
// This is the same reasoning as `memory.ts` holding statements and never
// quantities: what a callout MEANS is durable, what it WEIGHS is derived.
import type { BbsInterpretation } from './types';

const LS_KEY = 'bimcad.bbs.readings';
const MAX_DRAWINGS = 20;

interface Entry {
  at: number;
  model?: string;
  interpretation: BbsInterpretation;
}

function readAll(): Record<string, Entry> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, Entry>;
  } catch {
    /* corrupt — a lost cache costs one request, not correctness */
  }
  return {};
}

export function loadInterpretation(
  drawing: string,
): { interpretation: BbsInterpretation; at: number; model?: string } | null {
  if (!drawing) return null;
  const hit = readAll()[drawing];
  if (!hit?.interpretation) return null;
  const i = hit.interpretation;
  // a cache written by an older shape must not crash the panel
  if (!Array.isArray(i.members) || !Array.isArray(i.bars)) return null;
  return { interpretation: { ...i, unresolved: i.unresolved ?? [] }, at: hit.at, model: hit.model };
}

export function saveInterpretation(
  drawing: string,
  interpretation: BbsInterpretation,
  model?: string,
): void {
  if (!drawing) return;
  try {
    const all = readAll();
    all[drawing] = { at: Date.now(), model, interpretation };
    // readings are large; keep fewer of them than of overrides
    const keys = Object.keys(all);
    if (keys.length > MAX_DRAWINGS) {
      for (const k of keys.slice(0, keys.length - MAX_DRAWINGS)) delete all[k];
    }
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    // Quota is a real possibility here — a big schedule is a big object. The
    // session keeps working from memory; only the free restore is lost.
  }
}

export function forgetInterpretation(drawing: string): void {
  try {
    const all = readAll();
    delete all[drawing];
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    /* best-effort */
  }
}
