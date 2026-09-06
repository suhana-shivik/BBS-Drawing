// ============================================================
// User overrides — the human has the last word, on every value.
//
// WHY
//
// The engine derives what the drawing states, and refuses what it does not.
// That is right, but on its own it leaves the user stuck: a footing depth that
// lives on another sheet, a cover the title block never spelled out, an
// upturn the detail draws shorter than full depth. The person reading the
// drawing knows these. They should be able to type them in.
//
// So every value the schedule rests on is overridable — member dimensions, bar
// diameter, spacing, count, shape, and the cutting length itself. An override
// is not a suggestion the engine may ignore: it replaces the derived value and
// the row says so.
//
// TWO RULES THIS FILE KEEPS
//
//   1. An override is always VISIBLE as an override. A number the user typed
//      and a number the engine derived must never be indistinguishable, or the
//      audit trail that makes this tool trustworthy is gone.
//   2. Overrides PERSIST per drawing and survive a re-run of the model. Having
//      to retype a footing depth after every interpretation would make the
//      feature useless in practice.
//
// This is the same principle as `correctLabel` for names and `kind:
// 'correction'` in memory, applied to numbers: a human correction outranks
// everything and is never silently discarded.
// ============================================================
import type { BbsBar, BbsInterpretation, BbsMember, BbsSettings } from './types';
import type { ShapeCode } from '../../domain/india/bbs';

const LS_KEY = 'bimcad.bbs.overrides';

/** what a user may correct about one structural member */
export interface MemberOverride {
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  count?: number;
}

/** what a user may correct about one bar row */
export interface BarOverride {
  diaMm?: number;
  spacingMm?: number;
  /** a stated count replaces the spacing derivation entirely */
  manualCount?: number;
  shapeCode?: ShapeCode;
  legs?: number;
  distributionAxis?: 'L' | 'W' | 'H';
  /** the last word: a cutting length typed straight in */
  cuttingLengthMm?: number;
}

export interface BbsOverrides {
  /** keyed by member mark, e.g. "F1" */
  members: Record<string, MemberOverride>;
  /** keyed by bar mark, e.g. "F1-M1" */
  bars: Record<string, BarOverride>;
  /** settings the user pinned for this drawing */
  settings?: Partial<BbsSettings>;
}

export function emptyOverrides(): BbsOverrides {
  return { members: {}, bars: {} };
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeOverrides(fn: Listener): () => void {
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

// ------------------------------------------------------------
// persistence, per drawing
// ------------------------------------------------------------

function readAll(): Record<string, BbsOverrides> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, BbsOverrides>;
  } catch {
    /* corrupt — start clean rather than throw away the session */
  }
  return {};
}

export function loadOverrides(drawing: string): BbsOverrides {
  const hit = readAll()[drawing];
  return hit ? { members: hit.members ?? {}, bars: hit.bars ?? {}, settings: hit.settings } : emptyOverrides();
}

export function saveOverrides(drawing: string, ov: BbsOverrides): void {
  try {
    const all = readAll();
    all[drawing] = ov;
    const keys = Object.keys(all);
    if (keys.length > 40) for (const k of keys.slice(0, keys.length - 40)) delete all[k];
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    /* quota — the in-memory copy still drives this session */
  }
  notify();
}

/** Drop every correction for one drawing — the "reset to the drawing" button. */
export function clearOverrides(drawing: string): void {
  try {
    const all = readAll();
    delete all[drawing];
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    /* best-effort */
  }
  notify();
}

/** Is anything overridden at all? Drives the "N corrections" badge. */
export function countOverrides(ov: BbsOverrides): number {
  let n = 0;
  for (const m of Object.values(ov.members)) n += Object.values(m).filter((v) => v !== undefined).length;
  for (const b of Object.values(ov.bars)) n += Object.values(b).filter((v) => v !== undefined).length;
  return n;
}

// ------------------------------------------------------------
// application
// ------------------------------------------------------------

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Fold the user's corrections into the model's interpretation.
 *
 * Runs BEFORE `buildBbs`, so every downstream derivation — cutting length,
 * count, weight, the steel summary — is computed from the corrected values
 * rather than patched afterwards. A member depth typed in here flows into the
 * upturn leg, the bar count and the tonnage exactly as a depth read off the
 * drawing would.
 *
 * `overriddenMembers` / `overriddenBars` come back so the table can mark which
 * cells are the user's, keeping rule 1.
 */
export function applyOverrides(
  interpretation: BbsInterpretation,
  ov: BbsOverrides,
  markOf: (bar: BbsBar, index: number) => string,
): {
  interpretation: BbsInterpretation;
  overriddenMembers: Map<string, Set<keyof MemberOverride>>;
  overriddenBars: Map<string, Set<keyof BarOverride>>;
} {
  const overriddenMembers = new Map<string, Set<keyof MemberOverride>>();
  const overriddenBars = new Map<string, Set<keyof BarOverride>>();

  const members: BbsMember[] = interpretation.members.map((m) => {
    const o = ov.members[m.mark];
    if (!o) return m;
    const touched = new Set<keyof MemberOverride>();
    const next: BbsMember = { ...m };
    const L = num(o.lengthMm);
    const W = num(o.widthMm);
    const H = num(o.heightMm);
    const C = num(o.count);
    if (L !== undefined) { next.lengthMm = L; touched.add('lengthMm'); }
    if (W !== undefined) { next.widthMm = W; touched.add('widthMm'); }
    if (H !== undefined) { next.heightMm = H; touched.add('heightMm'); }
    if (C !== undefined) { next.count = C; touched.add('count'); }
    if (touched.size) {
      overriddenMembers.set(m.mark, touched);
      // a dimension supplied by hand is no longer missing
      next.missing = next.missing.filter((k) => {
        const key = k.toUpperCase();
        if (key.includes('L') && L !== undefined) return false;
        if (key.includes('W') && W !== undefined) return false;
        if (key.includes('H') && H !== undefined) return false;
        return true;
      });
      next.incomplete = next.missing.length > 0;
    }
    return next;
  });

  const bars: BbsBar[] = interpretation.bars.map((b, i) => {
    const mark = markOf(b, i);
    const o = ov.bars[mark];
    if (!o) return b;
    const touched = new Set<keyof BarOverride>();
    const next: BbsBar = { ...b };
    const d = num(o.diaMm);
    const s = num(o.spacingMm);
    const c = num(o.manualCount);
    const legs = num(o.legs);
    if (d !== undefined) { next.diaMm = d; touched.add('diaMm'); }
    if (s !== undefined) { next.spacingMm = s; touched.add('spacingMm'); }
    if (c !== undefined) { next.manualCount = c; touched.add('manualCount'); }
    if (legs !== undefined) { next.legs = legs; touched.add('legs'); }
    if (o.shapeCode) { next.shapeCode = o.shapeCode; touched.add('shapeCode'); }
    if (o.distributionAxis) { next.distributionAxis = o.distributionAxis; touched.add('distributionAxis'); }
    // a typed cutting length is honoured in `buildBbs`, not here — recorded so
    // the row can show it as ENTERED rather than derived
    if (num(o.cuttingLengthMm) !== undefined) touched.add('cuttingLengthMm');
    if (touched.size) overriddenBars.set(mark, touched);
    return next;
  });

  return { interpretation: { ...interpretation, members, bars }, overriddenMembers, overriddenBars };
}
