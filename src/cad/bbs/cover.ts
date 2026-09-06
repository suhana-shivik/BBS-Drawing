// ============================================================
// Cover resolution — per member, not per sheet.
//
// A drawing states cover as a TABLE, because cover is not one number:
//
//     a. FOUNDATION BEAM & SLAB   50
//     b. COLUMN                   40
//     c. FLOOR BEAM               30
//     d. TIE BEAM                 30
//     e. FLOOR SLAB               20
//
// The engine collapsed that to a single figure and applied it everywhere. Every
// tie-beam stirrup was then computed against 50 mm of cover instead of 30 —
// 40 mm short on each arm, on every stirrup, in a direction that always
// under-orders. The table was extracted correctly all along and simply never
// consumed.
//
// PRECEDENCE, most specific first. Each step is narrower than the last, and the
// step that produced the answer is reported alongside it — a cover taken from
// an element-kind default and one read off the sheet's own row for this member
// are both usable, but a reviewer must be able to tell them apart.
//
// NOTHING IS INVENTED. When no step matches, this returns no value and says so.
// A missing cover is a gap like any other; guessing it silently changes every
// cutting length in the member.
// ============================================================

export type CoverSource =
  | 'user-override'
  | 'member-cover-table'
  | 'normalised-name-match'
  | 'element-kind'
  | 'sheet-default';

export interface CoverResolution {
  ok: boolean;
  mm?: number;
  source?: CoverSource;
  /** what matched, in the sheet's own words */
  matchedOn?: string;
  reason?: string;
  working?: string;
}

/** one row of the sheet's cover table */
export interface CoverRow {
  /** the member name as the sheet writes it */
  member: string;
  coversMm: number[];
  raw?: string;
}

export interface CoverInputs {
  /** per-member overrides typed by the user; the last word on the subject */
  overrides?: Readonly<Record<string, number>>;
  /** the cover table as extracted from the notes */
  table?: readonly CoverRow[];
  /**
   * Cover by element kind, from the project's conventions. Data, not code —
   * a vocabulary that can grow without this file changing.
   */
  byKind?: Readonly<Record<string, number>>;
  /** the single figure the sheet states with no member named, if any */
  sheetDefault?: number;
}

const norm = (s: string): string =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** words that carry no distinguishing meaning in a member name */
const NOISE = new Set(['THE', 'AND', 'OF', 'FOR', 'TO', 'RCC', 'R C C', 'TYP', 'TYPICAL']);

function tokens(s: string): string[] {
  return norm(s)
    .split(' ')
    .filter((w) => w && !NOISE.has(w));
}

/**
 * How well a cover-table row describes a member.
 *
 * Token overlap rather than substring matching: "TIE BEAM." must match "TB —
 * tie beam" without also matching "FLOOR BEAM", and a substring test on "BEAM"
 * would match both. The score is the fraction of the ROW's tokens the member
 * satisfies, so a row naming two things only wins when both are present.
 */
function score(memberWords: readonly string[], rowWords: readonly string[]): number {
  if (!rowWords.length) return 0;
  const have = new Set(memberWords);
  let hit = 0;
  for (const w of rowWords) if (have.has(w)) hit++;
  return hit / rowWords.length;
}

/**
 * The cover that governs one member.
 *
 * `memberNames` is every name the member is known by — its mark, its declared
 * name, its classified type — because the sheet's table is written against
 * prose ("TIE BEAM.") while the schedule is keyed by a mark ("TB").
 */
export function resolveCover(
  memberNames: readonly string[],
  kind: string | undefined,
  inputs: CoverInputs,
): CoverResolution {
  const names = memberNames.filter(Boolean);

  // 1. a person said so
  for (const n of names) {
    const hit = inputs.overrides?.[n] ?? inputs.overrides?.[norm(n)];
    if (typeof hit === 'number' && hit >= 0) {
      return {
        ok: true,
        mm: hit,
        source: 'user-override',
        matchedOn: n,
        working: `${hit} mm — you set this for ${n}`,
      };
    }
  }

  // 2. an exact row in the sheet's own cover table
  const rows = inputs.table ?? [];
  for (const n of names) {
    const exact = rows.find((r) => norm(r.member) === norm(n));
    if (exact && exact.coversMm.length) {
      const mm = Math.min(...exact.coversMm);
      return {
        ok: true,
        mm,
        source: 'member-cover-table',
        matchedOn: exact.member,
        working: `${mm} mm — the sheet's cover table, row "${exact.member}"`,
      };
    }
  }

  // 3. the same table, matched on normalised words
  let best: { row: CoverRow; s: number; on: string } | null = null;
  for (const n of names) {
    const words = tokens(n);
    if (!words.length) continue;
    for (const r of rows) {
      if (!r.coversMm.length) continue;
      const s = score(words, tokens(r.member));
      if (s > 0 && (!best || s > best.s)) best = { row: r, s, on: n };
    }
  }
  if (best && best.s >= 0.5) {
    const mm = Math.min(...best.row.coversMm);
    return {
      ok: true,
      mm,
      source: 'normalised-name-match',
      matchedOn: best.row.member,
      working:
        `${mm} mm — the sheet's cover table, row "${best.row.member}", matched to "${best.on}"`,
    };
  }

  // 4. the project's convention for this kind of element
  if (kind) {
    const byKind = inputs.byKind ?? {};
    const hit = byKind[kind] ?? byKind[norm(kind)] ?? byKind[kind.toLowerCase()];
    if (typeof hit === 'number') {
      return {
        ok: true,
        mm: hit,
        source: 'element-kind',
        matchedOn: kind,
        working: `${hit} mm — the project convention for a ${kind}`,
      };
    }
  }

  // 5. a single figure the sheet states for everything
  if (typeof inputs.sheetDefault === 'number') {
    return {
      ok: true,
      mm: inputs.sheetDefault,
      source: 'sheet-default',
      working: `${inputs.sheetDefault} mm — the one cover this sheet states`,
    };
  }

  return {
    ok: false,
    reason:
      `no cover governs ${names[0] ?? 'this member'}` +
      (rows.length
        ? `: the sheet's table names ${rows.map((r) => `"${r.member}"`).join(', ')}, none of which ` +
          'describes it'
        : ' and this sheet states none') +
      '. Nothing was assumed — a guessed cover changes every cutting length in the member.',
  };
}
