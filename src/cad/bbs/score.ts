// ============================================================
// Scoring a read at the MODEL BOUNDARY.
//
// WHY THIS EXISTS
//
// `BBS_DIAGNOSIS.md` §1 records three configurations measured by total
// tonnage: 0.499 t, then 1.363 t, then 0.965 t. The third run had strictly
// more capability than the second and scored lower. At that variance the
// total cannot attribute anything — a correct fix and a regression are the
// same number.
//
// Worse, the two open failures compound multiplicatively on the same members:
// a column bar is ~17x short because its height is missing AND ~49x
// under-counted because its count stayed at 1. Fix either alone and the total
// moves less than the noise floor. You would ship a correct change and be
// unable to see it.
//
// So progress is measured HERE — on the object the model actually produced,
// field by field, against a truth built by hand from the sheet. Every result
// is a boolean. Booleans survive repeats; a tonnage does not.
//
// THERE IS DELIBERATELY NO TONNAGE IN THIS FILE. Not in the report, not in
// the summary, not in the formatter. A score that mentions a target total is
// a score someone will optimise toward, and closing a gap to a stated number
// is what mis-pointing looks like from the inside.
// ============================================================
import type { BbsInterpretation } from './types';

// ------------------------------------------------------------
// the truth file
// ------------------------------------------------------------

/** a pointer the truth accepts for a dim — matched structurally, not by identity */
export type TruthRef =
  | { handle: string; part?: number }
  | { op: 'diff'; a: TruthRef; b: TruthRef }
  | { fact: string };

export interface TruthDim {
  /** the value the sheet actually states, in mm */
  mm: number;
  /**
   * Pointers that legitimately produce it. More than one text on a sheet can
   * carry "350", and any of them is a correct answer — the model is not being
   * asked to guess which instance a human would have picked.
   */
  refs?: TruthRef[];
  /** tolerance in mm; exact by default */
  tolMm?: number;
  /** the truth author was not certain — scored, but reported apart */
  review?: boolean;
}

export type TruthCount =
  | { kind: 'once' }
  | { kind: 'marks' }
  | { kind: 'rule'; along?: 'run' | 'x' | 'y'; pitchMm?: number }
  | { kind: 'unknown' };

export interface TruthMember {
  mark: string;
  /** substring match, case-insensitive — "column" accepts "rcc column" */
  type?: string;
  dims?: Partial<Record<'L' | 'W' | 'H', TruthDim>>;
  count?: TruthCount;
  review?: boolean;
}

export interface TruthBar {
  /** the callout verbatim, as extracted */
  fromCallout: string;
  memberMark: string;
  barType?: string;
  diaMm?: number;
  review?: boolean;
}

export interface Truth {
  sheet: string;
  note?: string;
  /**
   * Question ids or matchers the read is allowed to ask. Anything else is a
   * question about something the sheet states, which is the failure this
   * whole change order exists to close.
   */
  allowedQuestions?: string[];
  members: TruthMember[];
  bars?: TruthBar[];
}

// ------------------------------------------------------------
// what a run produced
// ------------------------------------------------------------

export interface RunObserved {
  interpretation: BbsInterpretation;
  /**
   * The model's raw answer, parsed. Needed because `parseInterpretation`
   * RESOLVES refs into values and does not keep them — so "did it point at an
   * allowed text" can only be asked of the original.
   */
  raw?: unknown;
  /** question ids actually put to the user */
  questionsAsked?: string[];
  /** questions Gate 1 refused — a non-zero count is itself a finding */
  questionsVetoed?: string[];
}

// ------------------------------------------------------------
// results
// ------------------------------------------------------------

export interface FieldResult {
  /** stable identity, so repeats line up: "C1.dims.W" */
  field: string;
  ok: boolean;
  want?: string;
  got?: string;
  /** the truth author flagged this value as needing confirmation */
  review?: boolean;
}

export interface ScoreReport {
  sheet: string;
  fields: FieldResult[];
  passed: number;
  total: number;
  /** of `total`, how many are review-flagged */
  reviewed: number;
}

const norm = (s: string): string => s.replace(/[^a-z0-9]/gi, '').toLowerCase();

/** structural ref equality — a truth ref matches a produced ref of the same shape */
export function refMatches(want: TruthRef, got: unknown): boolean {
  if (!got || typeof got !== 'object') return false;
  const g = got as Record<string, unknown>;
  if ('op' in want) {
    if (g.op !== want.op) return false;
    return refMatches(want.a, g.a) && refMatches(want.b, g.b);
  }
  if ('fact' in want) return typeof g.fact === 'string' && norm(g.fact) === norm(want.fact);
  if (typeof g.handle !== 'string') return false;
  if (norm(g.handle) !== norm(want.handle)) return false;
  if (want.part === undefined) return true;
  const part = g.part === undefined ? 1 : Number(g.part);
  return part === want.part;
}

/** the raw member object the model returned for a mark, if any */
function rawMember(raw: unknown, mark: string): Record<string, unknown> | undefined {
  const list = (raw as { members?: unknown })?.members;
  if (!Array.isArray(list)) return undefined;
  return list.find(
    (m) => m && typeof m === 'object' && norm(String((m as { mark?: unknown }).mark ?? '')) === norm(mark),
  ) as Record<string, unknown> | undefined;
}

const AXIS_FIELD = { L: 'lengthMm', W: 'widthMm', H: 'heightMm' } as const;

export function scoreRun(truth: Truth, run: RunObserved): ScoreReport {
  const fields: FieldResult[] = [];
  const push = (f: Omit<FieldResult, 'ok'> & { ok: boolean }): void => {
    fields.push(f);
  };

  const byMark = new Map(run.interpretation.members.map((m) => [norm(m.mark), m]));

  for (const tm of truth.members) {
    const got = byMark.get(norm(tm.mark));
    push({
      field: `${tm.mark}.present`,
      ok: !!got,
      want: 'present',
      got: got ? 'present' : 'MISSING',
      review: tm.review,
    });
    if (!got) continue;

    if (tm.type) {
      const ok = norm(got.type).includes(norm(tm.type));
      push({ field: `${tm.mark}.type`, ok, want: tm.type, got: got.type, review: tm.review });
    }

    for (const axis of ['L', 'W', 'H'] as const) {
      const td = tm.dims?.[axis];
      if (!td) continue;
      const value = got[AXIS_FIELD[axis]];
      const tol = td.tolMm ?? 0;
      const resolved = typeof value === 'number' && Number.isFinite(value);
      push({
        field: `${tm.mark}.${axis}.resolved`,
        ok: resolved,
        want: 'a number',
        got: resolved ? String(value) : 'MISSING',
        review: td.review,
      });
      if (resolved) {
        const ok = Math.abs((value as number) - td.mm) <= tol;
        push({
          field: `${tm.mark}.${axis}.value`,
          ok,
          want: `${td.mm}${tol ? ` ±${tol}` : ''}`,
          got: String(value),
          review: td.review,
        });
      }
      if (td.refs?.length) {
        const rm = rawMember(run.raw, tm.mark);
        const dims = (rm?.dims ?? rm?.dimensions) as Record<string, unknown> | undefined;
        const gotRef = dims?.[axis] ?? dims?.[axis.toLowerCase()];
        const ok = td.refs.some((r) => refMatches(r, gotRef));
        push({
          field: `${tm.mark}.${axis}.ref`,
          ok,
          want: `one of ${td.refs.length} allowed pointer(s)`,
          got: gotRef === undefined ? 'none' : JSON.stringify(gotRef).slice(0, 80),
          review: td.review,
        });
      }
    }

    if (tm.count) {
      const rm = rawMember(run.raw, tm.mark);
      const gotCount = rm?.count as Record<string, unknown> | undefined;
      const gotKind =
        gotCount && typeof gotCount === 'object' && typeof gotCount.kind === 'string'
          ? gotCount.kind
          : // pre-union runs: infer what the old shape amounts to, so a score
            // can be taken before Change 2 lands and compared after
            got.countRule
            ? 'rule'
            : got.count > 1
              ? 'marks'
              : 'once';
      push({
        field: `${tm.mark}.count.kind`,
        ok: gotKind === tm.count.kind,
        want: tm.count.kind,
        got: gotKind,
        review: tm.review,
      });
      if (tm.count.kind === 'rule' && tm.count.pitchMm !== undefined) {
        const pitch = got.countRule?.pitchMm;
        push({
          field: `${tm.mark}.count.pitch`,
          ok: typeof pitch === 'number' && Math.abs(pitch - tm.count.pitchMm) <= 1,
          want: String(tm.count.pitchMm),
          got: pitch === undefined ? 'none' : String(pitch),
          review: tm.review,
        });
      }
    }
  }

  for (const tb of truth.bars ?? []) {
    const got = run.interpretation.bars.find((b) => norm(b.fromCallout) === norm(tb.fromCallout));
    push({
      field: `bar[${tb.fromCallout}].present`,
      ok: !!got,
      want: 'present',
      got: got ? 'present' : 'MISSING',
      review: tb.review,
    });
    if (!got) continue;
    push({
      field: `bar[${tb.fromCallout}].member`,
      ok: norm(got.memberMark) === norm(tb.memberMark),
      want: tb.memberMark,
      got: got.memberMark,
      review: tb.review,
    });
    if (tb.diaMm !== undefined) {
      push({
        field: `bar[${tb.fromCallout}].dia`,
        ok: Number(got.diaMm) === tb.diaMm,
        want: String(tb.diaMm),
        got: String(got.diaMm),
        review: tb.review,
      });
    }
    if (tb.barType) {
      push({
        field: `bar[${tb.fromCallout}].type`,
        ok: norm(got.barType) === norm(tb.barType),
        want: tb.barType,
        got: got.barType,
        review: tb.review,
      });
    }
  }

  if (truth.allowedQuestions && run.questionsAsked) {
    const allowed = truth.allowedQuestions.map(norm);
    const extra = run.questionsAsked.filter(
      (q) => !allowed.some((a) => norm(q).includes(a) || a.includes(norm(q))),
    );
    push({
      field: 'questions.subset',
      ok: extra.length === 0,
      want: `⊆ {${truth.allowedQuestions.join(', ')}}`,
      got: extra.length ? `also asked: ${extra.join(', ')}` : 'ok',
    });
  }
  if (run.questionsVetoed) {
    push({
      field: 'questions.vetoed',
      ok: run.questionsVetoed.length === 0,
      want: '0',
      got: String(run.questionsVetoed.length),
    });
  }

  return {
    sheet: truth.sheet,
    fields,
    passed: fields.filter((f) => f.ok).length,
    total: fields.length,
    reviewed: fields.filter((f) => f.review).length,
  };
}

// ------------------------------------------------------------
// repeats
// ------------------------------------------------------------

export interface StableField {
  field: string;
  passes: number;
  runs: number;
  review?: boolean;
  /** the first disagreeing observation, for the report */
  example?: { want?: string; got?: string };
}

/**
 * Per-field stability across repeats.
 *
 * `3/3` is a fact; `2/3` is a coin flip wearing a result. The diagnosis's
 * cautionary table is exactly what happens when single samples are treated as
 * measurements.
 */
export function mergeRepeats(reports: readonly ScoreReport[]): StableField[] {
  const order: string[] = [];
  const acc = new Map<string, StableField>();
  for (const r of reports) {
    for (const f of r.fields) {
      let hit = acc.get(f.field);
      if (!hit) {
        hit = { field: f.field, passes: 0, runs: 0, review: f.review };
        acc.set(f.field, hit);
        order.push(f.field);
      }
      hit.runs++;
      if (f.ok) hit.passes++;
      else if (!hit.example) hit.example = { want: f.want, got: f.got };
    }
  }
  return order.map((k) => acc.get(k)!);
}

/** The one-page table. Failures first — that is what the reader came for. */
export function formatScore(sheet: string, merged: readonly StableField[]): string {
  const fail = merged.filter((f) => f.passes < f.runs);
  const pass = merged.filter((f) => f.passes === f.runs);
  const lines: string[] = [`SCORE — ${sheet}`, ''];
  const row = (f: StableField): string =>
    `  ${`${f.passes}/${f.runs}`.padEnd(5)} ${f.field.padEnd(34)}` +
    (f.passes < f.runs && f.example ? ` want ${f.example.want ?? '?'} · got ${f.example.got ?? '?'}` : '') +
    (f.review ? '   [review]' : '');
  if (fail.length) {
    lines.push(`NOT PASSING (${fail.length})`);
    for (const f of fail) lines.push(row(f));
    lines.push('');
  }
  lines.push(`PASSING (${pass.length})`);
  for (const f of pass) lines.push(row(f));
  lines.push('');
  const all = merged.length;
  const solid = merged.filter((f) => f.passes === f.runs).length;
  const flaky = merged.filter((f) => f.passes > 0 && f.passes < f.runs).length;
  lines.push(`${solid}/${all} fields stable across repeats · ${flaky} unstable`);
  const rev = merged.filter((f) => f.review).length;
  if (rev) lines.push(`${rev} field(s) marked [review] — truth value not yet confirmed by a human`);
  return lines.join('\n');
}
