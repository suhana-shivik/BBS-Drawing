// Search — querying and ranking (UI_REQUIREMENTS_UPDATE §6.3).
//
// The ranking is the spec's sentence, implemented literally as score tiers:
//
//   exact mark match          1000
//   drawing number             800
//   section label               600
//   fact key                    400
//   free text over rawText      200   (and the other free-text fields)
//
// Within a tier, match quality separates hits (exact +90, prefix +50,
// substring +0), a superseded source costs a flat 5 — enough to put the
// current revision above the superseded one at equal match quality, never
// enough to cross a quality step or a tier, because finding the old value is
// often the point — and recency breaks the remaining ties, newest first.
// Hand-rolled on purpose: no tokeniser, no fuzziness, no library. A query
// either occurs in a field or it does not.
//
// Matching is case-insensitive, and every comparison is retried with all
// whitespace stripped, so "8@150" finds the callout drawn "8 (2L) @ 150 C/C"
// and "2-16TOR" finds "2-16 TOR + 2-12 TOR".

import type {
  IndexedDrawing,
  IndexedFact,
  IndexedMark,
  IndexedSection,
  ProjectIndex,
} from './index';
import type { MatchedField, SearchHit, SearchHitKind } from './types';
import { factName } from '../facts/types';

// ------------------------------------------------------------
// tiers and quality
// ------------------------------------------------------------

const TIER_MARK_EXACT = 1000;
const TIER_DRAWING_NUMBER = 800;
const TIER_SECTION_LABEL = 600;
const TIER_FACT_KEY = 400;
const TIER_FREE_TEXT = 200;

const QUALITY_EXACT = 90;
const QUALITY_PREFIX = 50;
const QUALITY_SUBSTRING = 0;

/** §6.3 — current above superseded at equal quality; smaller than any step. */
const SUPERSEDED_PENALTY = 5;

function norm(s: string): string {
  return s.toUpperCase().replace(/\s+/g, ' ').trim();
}

function tight(s: string): string {
  return s.toUpperCase().replace(/\s+/g, '');
}

/**
 * Callout text with parenthesised qualifiers dropped: "8 (2L)@150 C/C" →
 * "8@150C/C". A leg count in parentheses qualifies the callout; a query
 * that omits it ("8@150") still names the same steel.
 */
function bare(s: string): string {
  return s
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, '');
}

interface NormQuery {
  norm: string;
  tight: string;
  bare: string;
}

function formQuality(hay: string, needle: string): number | null {
  if (!hay || !needle) return null;
  if (hay === needle) return QUALITY_EXACT;
  if (hay.startsWith(needle)) return QUALITY_PREFIX;
  if (hay.includes(needle)) return QUALITY_SUBSTRING;
  return null;
}

/**
 * How well does `field` match the query? null = no match. The best quality
 * across three forms of both sides: whitespace-normalised, whitespace-
 * stripped (so "8 @ 150 C/C" is findable as "8@150c/c") and qualifier-
 * stripped (so "8@150" finds the callout drawn "8 (2L)@150 C/C").
 */
function quality(field: string, q: NormQuery): number | null {
  if (!field) return null;
  const qualities = [
    formQuality(norm(field), q.norm),
    formQuality(tight(field), q.tight),
    formQuality(bare(field), q.bare),
  ].filter((x): x is number => x !== null);
  return qualities.length === 0 ? null : Math.max(...qualities);
}

interface FieldCandidate {
  tier: number;
  field: MatchedField;
  text: string;
}

/** Best (tier + quality) across candidates, or null when nothing matches. */
function best(
  candidates: readonly FieldCandidate[],
  q: NormQuery,
): { score: number; matchedOn: MatchedField; snippet: string } | null {
  let out: { score: number; matchedOn: MatchedField; snippet: string } | null = null;
  for (const c of candidates) {
    const ql = quality(c.text, q);
    if (ql === null) continue;
    const score = c.tier + ql;
    if (!out || score > out.score) out = { score, matchedOn: c.field, snippet: c.text };
  }
  return out;
}

// ------------------------------------------------------------
// per-kind scoring
// ------------------------------------------------------------

function scoreDrawing(d: IndexedDrawing, q: NormQuery): SearchHit | null {
  const m = best(
    [
      { tier: TIER_DRAWING_NUMBER, field: 'drawingNumber', text: d.drawingNumber },
      { tier: TIER_DRAWING_NUMBER, field: 'fileName', text: d.fileName },
      { tier: TIER_FREE_TEXT, field: 'title', text: d.title },
      { tier: TIER_FREE_TEXT, field: 'discipline', text: d.discipline },
      { tier: TIER_FREE_TEXT, field: 'revision', text: d.revision },
    ],
    q,
  );
  if (!m) return null;
  return {
    kind: 'drawing',
    documentId: d.documentId,
    fileName: d.fileName,
    drawingNumber: d.drawingNumber,
    revision: d.revision,
    superseded: d.superseded,
    score: m.score - (d.superseded ? SUPERSEDED_PENALTY : 0),
    matchedOn: m.matchedOn,
    snippet: m.snippet,
  };
}

function scoreSection(s: IndexedSection, q: NormQuery): SearchHit | null {
  const candidates: FieldCandidate[] = [
    { tier: TIER_SECTION_LABEL, field: 'label', text: s.label },
    { tier: TIER_SECTION_LABEL, field: 'sectionId', text: s.sectionId },
    { tier: TIER_FREE_TEXT, field: 'kind', text: s.kind },
    ...s.memberHints.map(
      (h): FieldCandidate => ({ tier: TIER_FREE_TEXT, field: 'memberHint', text: h }),
    ),
    ...s.calloutHints.map(
      (h): FieldCandidate => ({ tier: TIER_FREE_TEXT, field: 'calloutHint', text: h }),
    ),
  ];
  const m = best(candidates, q);
  if (!m) return null;
  return {
    kind: 'section',
    sectionId: s.sectionId,
    label: s.label,
    parentDocumentId: s.parentDocumentId,
    bounds: s.bounds,
    ...(s.superseded ? { superseded: true } : {}),
    score: m.score - (s.superseded ? SUPERSEDED_PENALTY : 0),
    matchedOn: m.matchedOn,
    snippet: m.snippet,
  };
}

function scoreFact(f: IndexedFact, q: NormQuery): SearchHit | null {
  const m = best(
    [
      { tier: TIER_FACT_KEY, field: 'factKey', text: f.factId },
      // "total_run" is an exact hit on wall.total_run's name half
      { tier: TIER_FACT_KEY, field: 'factKey', text: factName(f.factId) },
      { tier: TIER_FREE_TEXT, field: 'value', text: f.valueText },
      { tier: TIER_FREE_TEXT, field: 'saidAs', text: f.saidAs },
      { tier: TIER_FREE_TEXT, field: 'rawText', text: f.rawText },
    ],
    q,
  );
  if (!m) return null;
  return {
    kind: 'fact',
    factId: f.factId,
    state: f.state,
    score: m.score,
    matchedOn: m.matchedOn,
    // the key is always the more useful snippet than a bare number
    snippet: m.matchedOn === 'factKey' ? f.factId : m.snippet,
  };
}

function scoreMark(m: IndexedMark, q: NormQuery): SearchHit | null {
  const ql = quality(m.text, q);
  if (ql === null) return null;
  const field: MatchedField = m.markKind === 'callout' ? 'callout' : 'mark';
  // §6.3 tier 1: an EXACT mark match outranks everything. Partial matches on
  // mark/callout text are free-text hits over the raw drawing text.
  const score =
    ql === QUALITY_EXACT ? TIER_MARK_EXACT + QUALITY_EXACT : TIER_FREE_TEXT + ql;
  return {
    kind: 'mark',
    text: m.text,
    documentId: m.documentId,
    handles: [...m.handles],
    ...(m.superseded ? { superseded: true } : {}),
    score: score - (m.superseded ? SUPERSEDED_PENALTY : 0),
    matchedOn: field,
    snippet: m.text,
  };
}

// ------------------------------------------------------------
// search
// ------------------------------------------------------------

export interface SearchOptions {
  /** restrict to these kinds (default: all four) */
  kinds?: readonly SearchHitKind[];
  /** maximum hits returned (default 50) */
  limit?: number;
}

/**
 * Query the index. Returns hits sorted by the §6.3 ranking: score tier and
 * match quality first (superseded sources already demoted within their
 * quality step), recency breaking ties, newest first. An empty or
 * whitespace-only query returns nothing.
 */
export function search(
  index: ProjectIndex,
  query: string,
  opts?: SearchOptions,
): SearchHit[] {
  const q: NormQuery = { norm: norm(query), tight: tight(query), bare: bare(query) };
  if (q.norm === '') return [];

  const kinds = new Set<SearchHitKind>(opts?.kinds ?? ['drawing', 'section', 'fact', 'mark']);
  const limit = opts?.limit ?? 50;

  const scored: { hit: SearchHit; recency: number }[] = [];
  const keep = (hit: SearchHit | null, recency: number): void => {
    if (hit) scored.push({ hit, recency });
  };

  if (kinds.has('drawing')) for (const d of index.drawings) keep(scoreDrawing(d, q), d.recency);
  if (kinds.has('section')) for (const s of index.sections) keep(scoreSection(s, q), s.recency);
  if (kinds.has('fact')) for (const f of index.facts) keep(scoreFact(f, q), f.recency);
  if (kinds.has('mark')) for (const m of index.marks) keep(scoreMark(m, q), m.recency);

  scored.sort((a, b) => {
    if (b.hit.score !== a.hit.score) return b.hit.score - a.hit.score;
    return b.recency - a.recency;
  });

  return scored.slice(0, limit).map((s) => s.hit);
}
