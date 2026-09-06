// DOES EACH SECTION ACTUALLY CONTAIN WHAT ITS AREA OF THE DRAWING CONTAINS?
//
// The splitter cuts a box and writes the entities inside it to a DXF. Nothing
// has ever checked that what came out matches what was there — and the failure
// is silent, because a section that lost a dimension or gained a stray from the
// detail next door still opens, still renders, still looks like a section.
//
// TWO PRINCIPLES, and they are what keep this cheap and honest:
//
//   1. CODE FIRST, MODEL ONLY WHERE CODE CANNOT SEE. Handles, counts, layers,
//      coordinates, dimension endpoints and ownership are all decidable
//      exactly, for nothing, every run. A model asked to confirm arithmetic
//      will confirm it — including when it is wrong. So the model is only ever
//      shown the residue: the specific mismatches the deterministic pass could
//      not settle. A section that matches exactly costs ZERO tokens.
//
//   2. READ → COMPARE → REPORT. Never READ → DECIDE → MODIFY. Nothing in this
//      file writes to a section, an ownership map or a bound. A validator that
//      can also repair is a validator whose reports you cannot trust, because
//      you can no longer tell a section that was right from one it fixed.
//
// A count match is NOT a pass. The same number of entities can be the wrong
// entities, so every check compares IDENTITY — which handles, which strings,
// which endpoints — and the counts are reported alongside as context, not as
// the verdict.

import type { CadDocument, CadEntity } from '../types';
import { boundsIntersect, entitiesInBounds, entityBoundsMm } from './bounds';
import type { Finalization, OwnerState } from './finalize';
import type { DrawingSection, SectionBounds } from './types';
import { openRouterTransport, type ChatMessage, type ChatTransport } from './orchestrator';
import { parseModelJson } from '../ai/openrouter';
import { getAiConfig } from '../ai/config';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type CheckStatus = 'PASS' | 'WARNING' | 'FAIL';

export interface EntityCounts {
  lines: number;
  text: number;
  dimensions: number;
  blocks: number;
  other: number;
  total: number;
}

export interface Mismatch {
  type: 'geometry' | 'text' | 'dimension' | 'tag' | 'ownership';
  /** the handle, the string, or the tag — whatever names the thing */
  id: string;
  original: string;
  generated: string;
  reason: string;
}

export interface SectionValidation {
  sectionId: string;
  status: CheckStatus;
  /** 0..1, from the size of what did not match — not a model's opinion */
  confidence: number;
  checks: {
    geometry: CheckStatus;
    text: CheckStatus;
    dimensions: CheckStatus;
    tags: CheckStatus;
    ownership: CheckStatus;
  };
  /** context, never the verdict: the same count can be the wrong entities */
  counts: { original: EntityCounts; generated: EntityCounts };
  /** handles in the source area that the section did not capture */
  missing: string[];
  /** handles the section captured that its area does not contain */
  extra: string[];
  mismatches: Mismatch[];
  /** null when the section was never sent — see `deep` in ValidateOptions */
  ai: {
    status: CheckStatus;
    /** things the model says the section should carry and does not */
    missing: string[];
    /** things it says are wrong, one line each */
    issues: { id: string; reason: string }[];
  } | null;
}

// ---------------------------------------------------------------------------
// thresholds
// ---------------------------------------------------------------------------

/**
 * Below this share of the area's entities a discrepancy is a WARNING; above it
 * a FAIL. A section is cut on a box and clipped, so one or two entities on the
 * boundary going either way is expected; five per cent of them is not.
 */
const WARN_SHARE = 0.05;
/** Any missing TEXT is a FAIL — text is meaning, not decoration. */
const TEXT_IS_CRITICAL = true;

const worst = (a: CheckStatus, b: CheckStatus): CheckStatus =>
  a === 'FAIL' || b === 'FAIL' ? 'FAIL' : a === 'WARNING' || b === 'WARNING' ? 'WARNING' : 'PASS';

function countsOf(entities: readonly CadEntity[], dimensions: number): EntityCounts {
  let lines = 0;
  let text = 0;
  let blocks = 0;
  let other = 0;
  for (const e of entities) {
    if (e.type === 'text') text += 1;
    else if (e.type === 'insert') blocks += 1;
    else if (e.type === 'line' || e.type === 'polyline') lines += 1;
    else other += 1;
  }
  return { lines, text, dimensions, blocks, other, total: entities.length };
}

const textOf = (e: CadEntity): string | null =>
  e.type === 'text' && e.text.trim() ? e.text.trim() : null;

/** A dimension's own box, in millimetres. */
function dimensionBox(
  d: { from?: { x: number; y: number }; to?: { x: number; y: number }; textPoint?: { x: number; y: number } },
  unitScale: number,
): SectionBounds | null {
  const pts = [d.from, d.to, d.textPoint].filter((p): p is { x: number; y: number } => !!p);
  if (!pts.length) return null;
  const xs = pts.map((p) => p.x * unitScale);
  const ys = pts.map((p) => p.y * unitScale);
  return { xMin: Math.min(...xs), yMin: Math.min(...ys), xMax: Math.max(...xs), yMax: Math.max(...ys) };
}

// ---------------------------------------------------------------------------
// the deterministic pass
// ---------------------------------------------------------------------------

/**
 * Compare ONE section against the area of the drawing it was cut from.
 *
 * Everything here is decided from the document and the section record — no
 * model, no network, no cost. `section.entityIds` is the authoritative record
 * of what was written into the section's DXF, and the entities its bounds
 * select from the original are what should have been. The two are compared by
 * IDENTITY, not by count.
 */
export function validateSection(doc: CadDocument, section: DrawingSection): SectionValidation {
  const unitScale = doc.unitScale || 1;
  const selection = entitiesInBounds(doc, section.bounds, 'intersect');
  const expected = new Map(selection.entities.map((e, i) => [e.style.handle || `#${i}`, e]));
  const captured = new Set(section.entityIds ?? []);
  const byHandle = new Map(doc.entities.map((e, i) => [e.style.handle || `#${i}`, e]));

  const missing = [...expected.keys()].filter((h) => !captured.has(h));
  const extra = [...captured].filter((h) => !expected.has(h));
  const mismatches: Mismatch[] = [];
  const scale = Math.max(expected.size, 1);

  // --- geometry -----------------------------------------------------------
  const missingGeom = missing.filter((h) => expected.get(h)!.type !== 'text');
  const share = (missingGeom.length + extra.length) / scale;
  const geometry: CheckStatus =
    missingGeom.length === 0 && extra.length === 0
      ? 'PASS'
      : share <= WARN_SHARE
        ? 'WARNING'
        : 'FAIL';
  for (const h of missingGeom.slice(0, 20)) {
    mismatches.push({
      type: 'geometry',
      id: h,
      original: expected.get(h)!.type,
      generated: 'absent',
      reason: 'inside the section area but not written to the section',
    });
  }

  // --- text ---------------------------------------------------------------
  //
  // Compared as STRINGS, not as a count. A section with the same number of
  // labels but the neighbouring detail's text in it is the failure that a
  // count check cannot see.
  const wantText = [...expected.values()].map(textOf).filter((t): t is string => !!t);
  const gotText = [...captured]
    .map((h) => byHandle.get(h))
    .map((e) => (e ? textOf(e) : null))
    .filter((t): t is string => !!t);
  const gotSet = new Set(gotText);
  const lostText = wantText.filter((t) => !gotSet.has(t));
  const text: CheckStatus = lostText.length === 0 ? 'PASS' : TEXT_IS_CRITICAL ? 'FAIL' : 'WARNING';
  for (const t of [...new Set(lostText)].slice(0, 10)) {
    mismatches.push({
      type: 'text',
      id: t,
      original: t,
      generated: 'missing',
      reason: 'text inside the section area is not in the section',
    });
  }

  // --- dimensions ---------------------------------------------------------
  //
  // The value is not the whole question. A dimension whose ENDPOINTS reach
  // geometry outside the section still prints the right number while measuring
  // something the section does not contain — right answer, wrong drawing.
  const dims = doc.annotations?.dimensions ?? [];
  const inArea = dims.filter((d) => {
    const b = dimensionBox(d, unitScale);
    return b ? boundsIntersect(b, section.bounds) : false;
  });
  let dimensions: CheckStatus = 'PASS';
  for (const d of inArea) {
    const from = d.from ? { x: d.from.x * unitScale, y: d.from.y * unitScale } : null;
    const to = d.to ? { x: d.to.x * unitScale, y: d.to.y * unitScale } : null;
    const inside = (p: { x: number; y: number } | null): boolean =>
      !p ||
      (p.x >= section.bounds.xMin &&
        p.x <= section.bounds.xMax &&
        p.y >= section.bounds.yMin &&
        p.y <= section.bounds.yMax);
    if (inside(from) && inside(to)) continue;
    dimensions = worst(dimensions, 'WARNING');
    mismatches.push({
      type: 'dimension',
      id: d.handle,
      original: d.measurement != null ? String(d.measurement) : '—',
      generated: d.measurement != null ? String(d.measurement) : '—',
      reason: 'value matches, but an endpoint lies outside the section',
    });
  }

  // --- tags ---------------------------------------------------------------
  //
  // The splitter asserted these marks. If the text they were read from is not
  // in the section, the assertion has no evidence behind it any more.
  const haystack = gotText.join('  ').toUpperCase();
  const claimed = [...(section.memberHints ?? []).map((m) => m.mark), ...(section.calloutHints ?? [])];
  let tags: CheckStatus = 'PASS';
  for (const mark of claimed) {
    if (!mark || haystack.includes(mark.toUpperCase())) continue;
    tags = worst(tags, 'WARNING');
    mismatches.push({
      type: 'tag',
      id: mark,
      original: mark,
      generated: 'no supporting text in the section',
      reason: 'the section claims this mark but carries no text that says so',
    });
  }

  // --- ownership ----------------------------------------------------------
  //
  // Not the finalisation's ownership map — this asks the narrower question the
  // section itself can answer: is everything it claims real, and is it here?
  let ownership: CheckStatus = 'PASS';
  for (const h of extra.slice(0, 20)) {
    const e = byHandle.get(h);
    const b = e ? entityBoundsMm(e, doc) : null;
    const known = Boolean(e);
    const here = b ? boundsIntersect(b, section.bounds) : false;
    ownership = worst(ownership, known ? 'WARNING' : 'FAIL');
    mismatches.push({
      type: 'ownership',
      id: h,
      original: known ? (here ? 'in the drawing, in this area' : 'in the drawing, elsewhere') : 'not in the drawing',
      generated: 'listed in this section',
      reason: known
        ? 'the section lists an entity its own area does not select'
        : 'the section lists a handle that is not in the drawing',
    });
  }

  const checks = { geometry, text, dimensions, tags, ownership };
  const status = Object.values(checks).reduce<CheckStatus>((a, b) => worst(a, b), 'PASS');
  // Confidence is arithmetic on what did not match, NOT a model's self-report.
  // A model asked how sure it is will say "0.96" either way.
  const penalty = Math.min(1, (missing.length + extra.length) / scale + mismatches.length * 0.01);
  return {
    sectionId: section.sectionId,
    status,
    confidence: Math.max(0, Math.round((1 - penalty) * 100) / 100),
    checks,
    counts: {
      original: countsOf(selection.entities, inArea.length),
      generated: countsOf(
        [...captured].map((h) => byHandle.get(h)).filter((e): e is CadEntity => !!e),
        inArea.length,
      ),
    },
    missing,
    extra,
    mismatches,
    ai: null,
  };
}

// ---------------------------------------------------------------------------
// the escalation
// ---------------------------------------------------------------------------

/** Nothing to argue about — no call, no tokens. */
export const needsReview = (v: SectionValidation): boolean => v.mismatches.length > 0;

const DIFF_SYSTEM = [
  'You are checking whether a cut section of a construction drawing faithfully',
  'contains its part of the original. A deterministic pass has ALREADY compared',
  'handles, counts, layers, coordinates and dimension endpoints exactly.',
  '',
  'You are shown only the discrepancies it could not settle. For each, say',
  'whether it is a real fault or an expected artefact of cutting a rectangle',
  'out of a drawing (a boundary line clipped, a leader crossing the edge).',
  '',
  'RULES:',
  '- Judge only the listed items. Do not comment on anything else.',
  '- Do not propose changes. This is a report, not a repair.',
  '- If an item is an ordinary consequence of clipping, say so — that is a',
  '  PASS for that item, not a fault.',
  '',
  'Answer as JSON only, and keep it short:',
  '{"status":"PASS|WARNING|FAIL","missing":[],"issues":[{"id":"<id>","reason":"<≤12 words>"}]}',
].join('\n');

/**
 * The DEEP check asks a different question, so it gets a different brief.
 *
 * Not "is this diff a real fault?" but "does this section hold what its area
 * of the drawing holds?". Code cannot answer that — it can tell you a handle
 * is absent, not that a column schedule is missing the column it is named
 * after — and it is the only thing worth spending a call per section on.
 */
const DEEP_SYSTEM = [
  'You are validating ONE cut section of a construction drawing against the',
  'area of the original drawing it was cut from. You are shown both, summarised.',
  '',
  'ENTITY COUNTS, HANDLES, LAYERS, COORDINATES, TEXT STRINGS AND DIMENSION',
  'VALUES HAVE ALREADY BEEN COMPARED EXACTLY, IN CODE. Those results are given',
  'to you as the deterministic diff, and they are authoritative. Do not',
  're-derive them and do not contradict them.',
  '',
  'Answer the question code CANNOT: is this section SEMANTICALLY coherent as',
  'what it claims to be?',
  '',
  'Check:',
  '- does the content match the label and kind the section claims',
  '- does a mark or callout it carries belong to something else on the sheet',
  '- do its dimensions describe THIS content, or something outside it',
  '- is there content here that plainly belongs to a neighbouring detail',
  '',
  'RULES, all absolute:',
  '- REPORT ONLY. Never propose moving, adding, deleting or reassigning',
  '  anything, and never suggest a new section. You are not editing a drawing.',
  '- Name only strings that appear in the data you were given. Do not invent a',
  '  mark, a dimension or an id.',
  '- A section is a rectangle cut through a drawing: a clipped boundary line is',
  '  normal and is not a fault.',
  '- FAIL ONLY WITH A REASON. If you answer FAIL you MUST name what is wrong in',
  '  `missing` or `issues`. A fault you cannot name is not a fault — answer',
  '  PASS instead.',
  '- If the content is coherent, answer PASS and list nothing.',
  '',
  'JSON only:',
  '{"status":"PASS|WARNING|FAIL",',
  ' "missing":["<text or mark in the original area that the section lacks>"],',
  ' "issues":[{"id":"<the thing>","reason":"<≤12 words>"}]}',
].join('\n');

/** Keep only what we actually showed it — a verdict about anything else is not a reading. */
function parseVerdict(
  raw: Record<string, unknown> | null,
  known: ReadonlySet<string>,
): SectionValidation['ai'] {
  if (!raw) return null;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const status = String(raw.status ?? '').toUpperCase();
  return {
    status: (status === 'PASS' || status === 'WARNING' || status === 'FAIL'
      ? status
      : 'WARNING') as CheckStatus,
    missing: Array.isArray(raw.missing) ? raw.missing.map(str).filter(Boolean).slice(0, 20) : [],
    issues: Array.isArray(raw.issues)
      ? raw.issues
          .map((i) => (i && typeof i === 'object' ? (i as Record<string, unknown>) : {}))
          // An empty whitelist means "the payload was the content itself", so
          // any id in it is fair; the diff check passes a real one.
          .filter((i) => known.size === 0 || known.has(String(i.id)))
          .map((i) => ({ id: String(i.id), reason: str(i.reason) }))
          .slice(0, 20)
      : [],
  };
}

/**
 * This section's content, and its area's, side by side — no geometry.
 *
 * Text strings, counts and dimension values. A few hundred tokens, and the
 * only comparison the question needs: the whole drawing is never sent, and
 * neither is any other section.
 */
function contentBrief(doc: CadDocument, section: DrawingSection, v: SectionValidation): string {
  const unitScale = doc.unitScale || 1;
  const byHandle = new Map(doc.entities.map((e, i) => [e.style.handle || `#${i}`, e]));
  const inArea = entitiesInBounds(doc, section.bounds, 'intersect').entities;
  const captured = [...new Set(section.entityIds ?? [])]
    .map((h) => byHandle.get(h))
    .filter((e): e is CadEntity => !!e);
  const strings = (list: readonly CadEntity[]): string[] => [
    ...new Set(list.map(textOf).filter((t): t is string => !!t)),
  ];
  const dims = (doc.annotations?.dimensions ?? [])
    .filter((d) => {
      const b = dimensionBox(d, unitScale);
      return b ? boundsIntersect(b, section.bounds) : false;
    })
    .slice(0, 24)
    .map((d) => `${d.handle}=${d.measurement ?? '?'}`);

  return [
    `SECTION ${section.sectionId}  kind=${section.kind}  label=${JSON.stringify(section.label)}`,
    '',
    'ORIGINAL AREA (the drawing, inside this section box):',
    `  counts: ${JSON.stringify(v.counts.original)}`,
    `  text: ${JSON.stringify(strings(inArea).slice(0, 40))}`,
    `  dimensions: ${JSON.stringify(dims)}`,
    '',
    'SECTION AS CUT:',
    `  counts: ${JSON.stringify(v.counts.generated)}`,
    `  text: ${JSON.stringify(strings(captured).slice(0, 40))}`,
    `  marks claimed: ${JSON.stringify([
      ...(section.memberHints ?? []).map((m) => m.mark),
      ...(section.calloutHints ?? []),
    ])}`,
    '',
    'DETERMINISTIC DIFF (already established — do not re-derive it):',
    `  missing handles: ${v.missing.length}   extra handles: ${v.extra.length}`,
    ...v.mismatches.slice(0, 20).map((m) => `  ${m.type} ${m.id}: ${m.reason}`),
  ].join('\n');
}

export interface ValidateOptions {
  model?: string;
  signal?: AbortSignal;
  transport?: ChatTransport;
  /** never escalate; the deterministic verdict stands */
  offline?: boolean;
  /**
   * Send EVERY section, not just the ones the code could not settle.
   *
   * The two modes answer different questions and cost accordingly. The default
   * asks only about the residue — a clean drawing costs nothing. `deep` asks
   * about the CONTENT of every section: is this really the column schedule,
   * does it carry the marks it should, do its dimensions belong to it. Code
   * cannot answer that, and the price is one call per section.
   */
  deep?: boolean;
  onEvent?: (e: { sectionId: string; status: CheckStatus; asked: boolean }) => void;
}

/**
 * Ask about ONE section's unresolved mismatches — the compact diff only.
 *
 * Neither the drawing nor the section is sent. The payload is a handful of
 * tuples naming what disagreed, which is all the question needs and is two
 * orders of magnitude smaller than either document.
 */
export async function reviewMismatches(
  v: SectionValidation,
  opts: ValidateOptions = {},
): Promise<SectionValidation['ai']> {
  if (!v.mismatches.length) return null;
  const transport = opts.transport ?? openRouterTransport;
  const model = opts.model ?? getAiConfig().textModel;
  const payload = {
    section: v.sectionId,
    counts: v.counts,
    issues: v.mismatches.slice(0, 40).map((m) => [m.type.toUpperCase(), m.id, m.original, m.generated]),
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: DIFF_SYSTEM },
    { role: 'user', content: JSON.stringify(payload) },
  ];
  const reply = await transport({ model, messages, tools: [], signal: opts.signal });
  // Only ids we actually asked about. A reply naming something else is not a
  // reading of this section, and is dropped rather than believed.
  return parseVerdict(parseModelJson(reply.content), new Set(v.mismatches.map((m) => m.id)));
}

/**
 * Ask about ONE section's CONTENT — does it hold what its area of the drawing
 * holds?
 *
 * ONE SECTION PER REQUEST, always. The drawing is never sent and neither are
 * the other sections: the payload is this section's text, counts and dimension
 * values beside the same three things from the area it was cut from.
 */
export async function reviewContent(
  doc: CadDocument,
  section: DrawingSection,
  v: SectionValidation,
  opts: ValidateOptions = {},
): Promise<SectionValidation['ai']> {
  const transport = opts.transport ?? openRouterTransport;
  const model = opts.model ?? getAiConfig().textModel;
  const messages: ChatMessage[] = [
    { role: 'system', content: DEEP_SYSTEM },
    { role: 'user', content: contentBrief(doc, section, v) },
  ];
  const reply = await transport({ model, messages, tools: [], signal: opts.signal });
  // No whitelist: a content check may legitimately name a mark or a string
  // rather than a handle, and everything it can name was in the payload.
  return parseVerdict(parseModelJson(reply.content), new Set());
}

/**
 * Validate every section — ONE REQUEST EACH, never a batch.
 *
 * Two modes, because there are two questions:
 *
 *   default  ask only where the deterministic pass could not decide. On a
 *            clean drawing that is no calls at all.
 *   deep     ask about every section's CONTENT — one call per section, which
 *            is the price of a question code cannot answer.
 *
 * Sequential on purpose: the progress line is meant to be readable as it goes,
 * and a section at a time is also what keeps each payload small.
 */
export async function validateSections(
  doc: CadDocument,
  sections: readonly DrawingSection[],
  opts: ValidateOptions = {},
): Promise<SectionValidation[]> {
  const out: SectionValidation[] = [];
  for (const section of sections) {
    const v = validateSection(doc, section);
    if (!opts.offline && (opts.deep || needsReview(v))) {
      try {
        v.ai = opts.deep
          ? await reviewContent(doc, section, v, opts)
          : await reviewMismatches(v, opts);
        // A FAIL MUST NAME SOMETHING.
        //
        // This said `if (ai.status === 'FAIL' || ai.missing.length)`, so a bare
        // {"status":"FAIL"} — no `missing`, no `issues` — failed a section
        // whose every category passed with missing=0 and extra=0. On screen
        // that is a red verdict with no cause, which is worse than no verdict:
        // there is nothing to check, nothing to fix, and no way to tell it
        // from a real fault. A model that reports a fault without naming one
        // has not found anything, so it is a WARNING and says so.
        //
        // The model may still DOWNGRADE a boundary artefact to a pass, and may
        // raise a warning to a fault when it names the fault. It may not
        // overturn a missing handle: that is arithmetic, and it was not asked.
        const reasons = aiReasons(v);
        if (v.ai?.status === 'FAIL' && reasons.length) {
          v.status = 'FAIL';
        } else if (v.ai?.missing.length) {
          v.status = 'FAIL';
        } else if (v.ai?.status === 'FAIL') {
          v.status = worst(v.status, 'WARNING');
          v.ai = { ...v.ai, issues: [{ id: v.sectionId, reason: 'reported a fault but named none' }] };
        } else if (v.ai?.status === 'PASS' && v.status === 'WARNING' && !v.missing.length) {
          v.status = 'PASS';
        }
      } catch {
        // A failed review leaves the deterministic verdict standing. It was
        // never the thing deciding.
        v.ai = null;
      }
    }
    opts.onEvent?.({ sectionId: v.sectionId, status: v.status, asked: v.ai !== null });
    out.push(v);
  }
  return out;
}

/**
 * Everything the reading said, as lines — the reason behind an AI verdict.
 *
 * ONE function, used by both reports. `validationReport` printed only
 * `v.mismatches`, which is the DETERMINISTIC list, so a section failed by the
 * model showed a FAIL with nothing under it: the reason existed on the record
 * and was simply never rendered.
 */
export function aiReasons(v: SectionValidation): string[] {
  return [
    ...(v.ai?.missing ?? []).map((m) => `missing: ${m}`),
    ...(v.ai?.issues ?? []).map((i) => (i.reason ? `${i.id}: ${i.reason}` : i.id)),
  ];
}

/**
 * The verdict list, in the form the question is asked:
 *
 *   REGION-01 → PASS
 *   REGION-02 → PASS
 *   REGION-03 → FAIL
 *     - Missing: C1
 *     - Mismatch: dimension 300x300x2000
 *
 * `Missing` merges what the code found absent with what the reading named,
 * because to a reader they are the same fact arrived at two ways.
 */
export function verdictReport(results: readonly SectionValidation[]): string[] {
  const lines: string[] = [];
  for (const v of results) {
    lines.push(`${v.sectionId} → ${v.status}`);
    const missing = [
      ...(v.ai?.missing ?? []),
      ...v.mismatches.filter((m) => m.type === 'text').map((m) => m.id),
    ];
    for (const m of [...new Set(missing)].slice(0, 8)) lines.push(`  - Missing: ${m}`);
    for (const m of v.mismatches.filter((m) => m.type !== 'text').slice(0, 8)) {
      lines.push(`  - Mismatch: ${m.type} ${m.id} — ${m.reason}`);
    }
    for (const i of (v.ai?.issues ?? []).slice(0, 8)) {
      lines.push(`  - Mismatch: ${i.id} — ${i.reason}`);
    }
  }
  return lines;
}

/** One line per section, for the console. */
export function validationReport(results: readonly SectionValidation[]): string[] {
  const tally = { PASS: 0, WARNING: 0, FAIL: 0 } as Record<CheckStatus, number>;
  for (const v of results) tally[v.status] += 1;
  const lines = [
    'SECTION VALIDATION',
    `  ${results.length} sections — ${tally.PASS} PASS · ${tally.WARNING} WARNING · ${tally.FAIL} FAIL`,
    `  model calls: ${results.filter((v) => v.ai !== null).length}`,
  ];
  for (const v of results) {
    lines.push(
      '',
      `${v.sectionId}  ${v.status}  confidence ${v.confidence}`,
      `  geometry=${v.checks.geometry} text=${v.checks.text} dimensions=${v.checks.dimensions} tags=${v.checks.tags} ownership=${v.checks.ownership}`,
      `  original  lines=${v.counts.original.lines} text=${v.counts.original.text} dims=${v.counts.original.dimensions} blocks=${v.counts.original.blocks}`,
      `  generated lines=${v.counts.generated.lines} text=${v.counts.generated.text} dims=${v.counts.generated.dimensions} blocks=${v.counts.generated.blocks}`,
      `  missing=${v.missing.length} extra=${v.extra.length}`,
      ...v.mismatches.slice(0, 8).map((m) => `    ${m.type} ${m.id}: ${m.reason}`),
    );
    // WHY, when the reading is what decided. Without this a section failed by
    // the model reads as a red verdict with every category green under it.
    const reasons = aiReasons(v);
    if (reasons.length) {
      lines.push('  reason:', ...reasons.slice(0, 8).map((r) => `    - ${r}`));
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// where did each instance of a repeated label go?
// ---------------------------------------------------------------------------
//
// FOUR C1s ON THE SHEET, TWO OF THEM HIGHLIGHTED. That is the shape of the
// question this answers, and the point is that it is answerable in code: the
// ownership map already says, for every entity, exactly one thing. So the
// audit never guesses and never calls anything — it groups the drawing's text
// by what it says and reports where each instance ended up.
//
// The value is in the DISAGREEMENT. Four labels reading "C1" that all landed
// in sections is uninteresting; four that landed in three different states is
// the smell, and it separates the three failures that look identical on screen:
//
//   never-read                 the first pass never saw it
//   read-but-unowned           seen, but no section took it
//   owned-but-outside-highlight  a section owns it and its box does not reach it
//   in-section                 correct
//
// It does NOT attach anything. Matching on text alone would put every "C1" in
// one section, and four columns of a layout plan are four different places —
// position and surrounding geometry decide that, not the string.

/** One occurrence of a repeated label, and what became of it. */
export interface LabelInstance {
  entityId: string;
  /** millimetres */
  at: { x: number; y: number };
  state: OwnerState;
  owner: string;
  /** every final region whose highlight box covers this point */
  coveredBy: string[];
  verdict: 'in-section' | 'owned-but-outside-highlight' | 'read-but-unowned' | 'never-read';
}

export interface LabelGroup {
  text: string;
  instances: LabelInstance[];
  total: number;
  /** instances that ended up inside the section that owns them */
  inSections: number;
  /** everything else — the ones worth asking about */
  unaccounted: number;
  /** instances of the SAME label ended up in different states */
  inconsistent: boolean;
}

const VERDICT_OK: LabelInstance['verdict'] = 'in-section';

/**
 * Group the drawing's text and report where each instance landed.
 *
 * Deterministic and free: it reads the ownership map that finalisation already
 * computed. `minInstances` is 2 because a label that appears once cannot
 * disagree with itself.
 */
export function auditLabels(
  doc: CadDocument,
  finalization: Finalization,
  opts: { minInstances?: number; onlyUnaccounted?: boolean } = {},
): LabelGroup[] {
  const minInstances = opts.minInstances ?? 2;
  const regions = finalization.regions;
  const groups = new Map<string, LabelInstance[]>();

  doc.entities.forEach((e, i) => {
    const t = textOf(e);
    if (!t) return;
    const id = e.style.handle || `#${i}`;
    const own = finalization.ownership.get(id);
    const b = entityBoundsMm(e, doc);
    const at = b ? { x: (b.xMin + b.xMax) / 2, y: (b.yMin + b.yMax) / 2 } : { x: 0, y: 0 };
    const coveredBy = b ? regions.filter((r) => boundsIntersect(r.bounds, b)).map((r) => r.sectionId) : [];

    let verdict: LabelInstance['verdict'];
    if (!own || own.state === 'STILL_UNREAD') verdict = 'never-read';
    else if (own.state === 'EXPLAINED_RESIDUAL') verdict = 'read-but-unowned';
    else verdict = coveredBy.includes(own.owner) ? 'in-section' : 'owned-but-outside-highlight';

    const key = t.toUpperCase();
    const list = groups.get(key) ?? [];
    list.push({ entityId: id, at, state: own?.state ?? 'STILL_UNREAD', owner: own?.owner ?? '—', coveredBy, verdict });
    groups.set(key, list);
  });

  const out: LabelGroup[] = [];
  for (const [text, instances] of groups) {
    if (instances.length < minInstances) continue;
    const inSections = instances.filter((i) => i.verdict === VERDICT_OK).length;
    const unaccounted = instances.length - inSections;
    const inconsistent = new Set(instances.map((i) => i.verdict)).size > 1;
    if (opts.onlyUnaccounted && unaccounted === 0) continue;
    out.push({ text, instances, total: instances.length, inSections, unaccounted, inconsistent });
  }
  // Worst first: a label whose instances disagree is the one to look at.
  return out.sort((a, b) => b.unaccounted - a.unaccounted || b.total - a.total);
}

/** The count comparison, in the form the question is asked. */
export function labelAuditReport(groups: readonly LabelGroup[]): string[] {
  const bad = groups.filter((g) => g.unaccounted > 0);
  if (!bad.length) return ['LABEL AUDIT: every repeated label is inside the section that owns it'];
  const lines = ['LABEL AUDIT'];
  for (const g of bad) {
    lines.push(
      '',
      `"${g.text}"`,
      `  expected visible instances: ${g.total}`,
      `  captured in sections:       ${g.inSections}`,
      `  unaccounted:                ${g.unaccounted}   ← ask about ONLY these`,
    );
    for (const i of g.instances) {
      lines.push(
        `    ${i.entityId.padEnd(8)} at ${Math.round(i.at.x)},${Math.round(i.at.y)}  ` +
          `${i.state} owner=${i.owner}  covered-by=${i.coveredBy.join('/') || '—'}  → ${i.verdict}`,
      );
    }
  }
  return lines;
}
