// SECOND PASS — reading what the first pass left behind.
//
// The orchestrator cuts REGIONs until it decides the sheet is accounted for.
// What it does not cut is not therefore meaningless: a continuation of a
// detail, a callout that sits outside the box its detail was cut to, a whole
// small detail nobody looked at. `findGapClusters` already finds and groups
// those entities. This stage is what happens next — it READS each one.
//
// Two halves, and the line between them is the point of the file:
//
//   GEOMETRY IS DECIDED HERE, LOCALLY.  Whether a residual overlaps, touches
//   or merely sits near a REGION is arithmetic on boxes. It is deterministic,
//   it costs nothing, and it is the same answer every run. No model is asked.
//
//   MEANING IS ASKED OF THE MODEL.  What the residual IS — a continuation, an
//   annotation, its own detail — is a reading question, and the only thing a
//   model is used for here.
//
// The two are then combined, not blended: `CONNECTED` is a geometric fact and
// the model cannot grant or withdraw it; `NEAR_CONNECTED` needs BOTH local
// proximity and a semantic attachment; anything else is `INDEPENDENT`.
//
// NOTHING in this file computes BBS relevance, and nothing here touches the
// splitter. The whole drawing is never re-sent: each call carries one residual
// and the context around it.

import type { CadDocument, CadEntity } from '../types';
import { boundsIntersect, entityBoundsMm, padBounds, sheetBounds } from './bounds';
import { boundsDistance, findGapClusters, type GapCluster } from './gaps';
import { defaultRenderer, type SectionRenderer } from './section';
import type { DrawingSection, SectionBounds } from './types';
import {
  openRouterTransport,
  type ChatMessage,
  type ChatTransport,
} from './orchestrator';
import { parseModelJson } from '../ai/openrouter';
import { getAiConfig } from '../ai/config';

// ---------------------------------------------------------------------------
// what a residual is, once it has been looked at
// ---------------------------------------------------------------------------

/**
 * How a residual stands to the REGIONs around it.
 *
 * `connected` is geometry and nothing else. `near-connected` is the only one
 * that needs the reading, and it needs the proximity too — a model saying "this
 * belongs to REGION-02" about something on the far side of the sheet is not
 * evidence, it is a guess, and it is refused here.
 */
export type ResidualLink = 'connected' | 'near-connected' | 'independent';

/** What the boxes say, before anybody reads anything. */
export interface ResidualGeometry {
  /** REGIONs whose box this residual actually overlaps */
  overlaps: string[];
  /** REGIONs it reaches within the join distance without overlapping */
  touches: string[];
  /** every REGION within the near threshold, closest first — NOT just one */
  near: { sectionId: string; distanceMm: number }[];
}

/** The model's answer, after it has been checked against what it was sent. */
export interface ResidualReading {
  /** what kind of drawing content this is, in the model's words */
  kind: string;
  /** what it is — one or two sentences */
  summary: string;
  /** text actually present; anything not in the payload is dropped */
  callouts: string[];
  /** an existing REGION id, or null. Never an id that was not offered. */
  belongsTo: string | null;
  relation: 'part-of' | 'continuation' | 'annotation' | 'reference' | 'independent';
  /** why the model says so */
  basis: string;
  /** 0..1 */
  confidence: number;
}

export interface ResidualCandidate {
  /** the GAP id it was found under — GAP-01, GAP-02, … */
  gapId: string;
  bounds: SectionBounds;
  entityCount: number;
  /** entity types present, most common first */
  entityTypes: { type: string; count: number }[];
  layers: { layer: string; count: number }[];
  /** every text string inside it, verbatim */
  text: string[];
  /**
   * The handles that make this piece up.
   *
   * Finalisation needs them, not just a count: attaching a residual to a
   * REGION means moving these exact entities into that region's ownership, and
   * "3 entities" cannot be moved anywhere.
   */
  entityIds: string[];
  geometry: ResidualGeometry;
}

export interface ResidualResult extends ResidualCandidate {
  link: ResidualLink;
  /** the REGION it was attached to, when it was attached to one */
  linkedTo: string | null;
  /** null when the second pass did not run for this one, or failed */
  reading: ResidualReading | null;
  status: 'read' | 'unread' | 'failed';
  /** why it is `unread` or `failed`, when it is */
  note?: string;
}

// ---------------------------------------------------------------------------
// thresholds
// ---------------------------------------------------------------------------

/**
 * "Touching" and "near", as fractions of the sheet's diagonal.
 *
 * Scale-invariant on purpose: a 47 m site plan and a 300 mm column detail are
 * both drawings, and a millimetre threshold that suits one is meaningless on
 * the other. JOIN matches `gaps.ts` so "touches" means the same thing in both
 * files rather than two nearly-equal numbers drifting apart.
 */
const JOIN_FRACTION = 0.015;
const NEAR_FRACTION = 0.09;

/** A reading costs a model call, so the long tail of specks is not sent. */
const MIN_ENTITIES = 1;
/** Largest first; the rest are reported honestly as not read. */
const MAX_READS = 12;
/** Verbatim text sent per residual. */
const MAX_TEXT = 24;
/** REGIONs offered as possible parents. More than this is noise, not context. */
const MAX_CONTEXT = 6;
/** The crop is padded so the residual is seen IN its surroundings. */
const CROP_PAD = 0.6;
const CROP_PX = 900;

const diagonal = (b: SectionBounds): number =>
  Math.hypot(b.xMax - b.xMin, b.yMax - b.yMin);

// ---------------------------------------------------------------------------
// half one: the geometry, decided locally
// ---------------------------------------------------------------------------

const grow = (b: SectionBounds, by: number): SectionBounds => ({
  xMin: b.xMin - by,
  yMin: b.yMin - by,
  xMax: b.xMax + by,
  yMax: b.yMax + by,
});

/**
 * Compare one residual against ALL sections — not against the nearest one.
 *
 * "Nearest" is a single number that hides the question: a residual can sit
 * between two details, and which one it belongs to is exactly what is being
 * asked. Every section within reach is reported so the reading has something
 * to choose BETWEEN, and so a wrong choice is visible rather than assumed.
 */
export function residualGeometry(
  bounds: SectionBounds,
  sections: readonly { sectionId: string; bounds: SectionBounds }[],
  sheet: SectionBounds | null,
): ResidualGeometry {
  const span = diagonal(sheet ?? bounds) || 1;
  const join = Math.max(span * JOIN_FRACTION, 1e-6);
  const nearMm = Math.max(span * NEAR_FRACTION, join);

  const overlaps: string[] = [];
  const touches: string[] = [];
  const near: { sectionId: string; distanceMm: number }[] = [];

  for (const s of sections) {
    if (boundsIntersect(bounds, s.bounds)) {
      overlaps.push(s.sectionId);
      continue;
    }
    const d = boundsDistance(bounds, s.bounds);
    // Touching is "within the join distance" — the same grown-box test the
    // clusterer used to decide these entities were one thing in the first
    // place, so a residual cannot be judged by a looser rule than made it.
    if (boundsIntersect(grow(bounds, join), s.bounds)) touches.push(s.sectionId);
    else if (d <= nearMm) near.push({ sectionId: s.sectionId, distanceMm: d });
  }
  near.sort((a, b) => a.distanceMm - b.distanceMm);
  return { overlaps, touches, near };
}

/**
 * The link, from the geometry and the reading TOGETHER.
 *
 * Order matters. Geometry first, because an overlap is a fact and no reading
 * overturns it. Then proximity plus attachment. Then independent — which is a
 * real answer, not a failure: a separate detail nobody cut is exactly the
 * thing this stage exists to surface.
 */
export function linkFor(
  geometry: ResidualGeometry,
  reading: ResidualReading | null,
): { link: ResidualLink; linkedTo: string | null } {
  const attached = [...geometry.overlaps, ...geometry.touches];
  if (attached.length) {
    // When the model names one of the ones it actually touches, prefer that —
    // it is the only party that can tell two touching neighbours apart.
    const named = reading?.belongsTo && attached.includes(reading.belongsTo) ? reading.belongsTo : attached[0];
    return { link: 'connected', linkedTo: named };
  }
  const to = reading?.belongsTo ?? null;
  // NEAR needs BOTH: close enough to be plausible, and read as belonging. A
  // semantic claim about a region the residual is nowhere near is refused.
  if (to && reading?.relation !== 'independent' && geometry.near.some((n) => n.sectionId === to)) {
    return { link: 'near-connected', linkedTo: to };
  }
  return { link: 'independent', linkedTo: null };
}

// ---------------------------------------------------------------------------
// gathering one candidate
// ---------------------------------------------------------------------------

const textOf = (e: CadEntity): string | null =>
  e.type === 'text' && e.text.trim() ? e.text.trim() : null;

function tally<T extends string>(values: readonly T[]): { key: T; count: number }[] {
  const by = new Map<T, number>();
  for (const v of values) by.set(v, (by.get(v) ?? 0) + 1);
  return [...by].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/**
 * Every entity the first pass left out — the same test `coverage.ts` uses, so
 * "uncovered" means one thing across the codebase.
 */
export function residualEntities(
  doc: CadDocument,
  sections: readonly { bounds: SectionBounds }[],
): { entity: CadEntity; bounds: SectionBounds }[] {
  const boxes = sections.map((s) => s.bounds);
  const out: { entity: CadEntity; bounds: SectionBounds }[] = [];
  for (const entity of doc.entities) {
    const b = entityBoundsMm(entity, doc);
    if (!b) continue;
    if (boxes.some((box) => boundsIntersect(box, b))) continue;
    out.push({ entity, bounds: b });
  }
  return out;
}

/** One cluster, described in full: geometry, types, layers, verbatim text. */
export function describeCandidate(
  doc: CadDocument,
  cluster: GapCluster,
  loose: readonly { entity: CadEntity; bounds: SectionBounds }[],
  sections: readonly { sectionId: string; bounds: SectionBounds }[],
  sheet: SectionBounds | null,
): ResidualCandidate {
  const mine = loose.filter((l) => boundsIntersect(cluster.bounds, l.bounds));
  const text: string[] = [];
  for (const { entity } of mine) {
    const t = textOf(entity);
    if (t && !text.includes(t)) text.push(t);
    if (text.length >= MAX_TEXT) break;
  }
  return {
    gapId: cluster.id,
    bounds: cluster.bounds,
    entityCount: cluster.entityCount,
    entityIds: mine.map((m) => m.entity.style.handle).filter(Boolean),
    entityTypes: tally(mine.map((m) => m.entity.type)).map((t) => ({ type: t.key, count: t.count })),
    layers: cluster.layers,
    text,
    geometry: residualGeometry(cluster.bounds, sections, sheet),
  };
}

// ---------------------------------------------------------------------------
// half two: the reading
// ---------------------------------------------------------------------------

const SYSTEM = [
  'You are reading ONE unread piece of a construction drawing.',
  'A first pass already cut this sheet into regions. This piece was left over.',
  '',
  'Your job is to say WHAT THIS PIECE IS, and whether it belongs to one of the',
  'regions listed as nearby context.',
  '',
  'RULES, all of them absolute:',
  '- Report only what is in the payload. Every entity, coordinate and piece of',
  '  text you have is given to you below. If something cannot be determined',
  '  from it, say so — do not supply a plausible answer instead.',
  '- Never invent text. `callouts` may only contain strings that appear',
  '  verbatim in `text`.',
  '- `belongsTo` must be one of the given region ids, or null. Never any other',
  '  id, and never a region you were not shown.',
  '- A piece that is genuinely its own separate detail is a real answer. Say',
  '  `independent` rather than attaching it to the closest thing.',
  '',
  'Answer as JSON only:',
  '{"kind":"<schedule|detail|note|callout|dimension|title|legend|…>",',
  ' "summary":"<one or two sentences on what this is>",',
  ' "callouts":["<verbatim text>"],',
  ' "belongsTo":"<REGION-xx or null>",',
  ' "relation":"part-of|continuation|annotation|reference|independent",',
  ' "basis":"<why — cite the text or the geometry you used>",',
  ' "confidence":0.0}',
].join('\n');

const n2 = (v: number): string => (Math.round(v * 100) / 100).toString();
const boxLine = (b: SectionBounds): string =>
  `x ${n2(b.xMin)}..${n2(b.xMax)}, y ${n2(b.yMin)}..${n2(b.yMax)} mm`;

/**
 * The payload for ONE residual. The whole drawing is never re-sent — this is
 * the piece itself, plus the regions near enough to be its parent, plus the
 * relationships already worked out locally so the model is answering the
 * reading question rather than re-deriving arithmetic it cannot do reliably.
 */
export function residualBrief(
  candidate: ResidualCandidate,
  sections: readonly DrawingSection[],
): string {
  const byId = new Map(sections.map((s) => [s.sectionId, s]));
  const context = [
    ...candidate.geometry.overlaps.map((id) => ({ id, how: 'overlaps this piece' })),
    ...candidate.geometry.touches.map((id) => ({ id, how: 'touches this piece' })),
    ...candidate.geometry.near.map((n) => ({ id: n.sectionId, how: `${n2(n.distanceMm)} mm away` })),
  ].slice(0, MAX_CONTEXT);

  const lines = [
    `UNREAD PIECE ${candidate.gapId}`,
    `  bounds: ${boxLine(candidate.bounds)}`,
    `  entities: ${candidate.entityCount}`,
    `  types: ${candidate.entityTypes.map((t) => `${t.type}×${t.count}`).join(', ') || '—'}`,
    `  layers: ${candidate.layers.map((l) => `${l.layer}×${l.count}`).join(', ') || '—'}`,
    '  text (verbatim, this is ALL of it):',
    ...(candidate.text.length ? candidate.text.map((t) => `    ${JSON.stringify(t)}`) : ['    (none)']),
    '',
    'NEARBY REGIONS already read (the only ids you may use for belongsTo):',
    ...(context.length
      ? context.map((c) => {
          const s = byId.get(c.id);
          return `  ${c.id} — ${c.how} · ${s ? `${s.kind}: ${s.label}` : 'unknown'}${
            s ? ` · ${boxLine(s.bounds)}` : ''
          }`;
        })
      : ['  (none within reach — this piece stands alone geometrically)']),
  ];
  return lines.join('\n');
}

/**
 * Keep only what the payload supports.
 *
 * The prompt forbids inventing; this is what makes the ban mean something. A
 * callout that is not in the text we sent did not come from the drawing, and a
 * `belongsTo` naming a region we did not offer is not a reading of anything.
 * Both are dropped silently rather than trusted — the same discipline
 * `parseAnalysis` applies to hallucinated symbol keys.
 */
export function validateReading(
  raw: Record<string, unknown> | null,
  candidate: ResidualCandidate,
): ResidualReading | null {
  if (!raw) return null;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const offered = new Set([
    ...candidate.geometry.overlaps,
    ...candidate.geometry.touches,
    ...candidate.geometry.near.map((n) => n.sectionId),
  ]);
  const belongs = str(raw.belongsTo);
  const relation = str(raw.relation);
  const known = ['part-of', 'continuation', 'annotation', 'reference', 'independent'] as const;
  const conf = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : 0;
  const summary = str(raw.summary);
  if (!summary && !str(raw.kind)) return null;
  return {
    kind: str(raw.kind) || 'unknown',
    summary,
    callouts: Array.isArray(raw.callouts)
      ? raw.callouts.map(str).filter((c) => c && candidate.text.includes(c))
      : [],
    belongsTo: offered.has(belongs) ? belongs : null,
    relation: (known as readonly string[]).includes(relation)
      ? (relation as ResidualReading['relation'])
      : 'independent',
    basis: str(raw.basis),
    confidence: Math.min(1, Math.max(0, conf)),
  };
}

// ---------------------------------------------------------------------------
// the stage
// ---------------------------------------------------------------------------

export interface ResidualPassOptions {
  model?: string;
  signal?: AbortSignal;
  transport?: ChatTransport;
  renderer?: SectionRenderer;
  /** skip the crop — cheaper, and the only option on a run with no rasteriser */
  skipPng?: boolean;
  maxReads?: number;
  onEvent?: (e: { gapId: string; status: ResidualResult['status']; note?: string }) => void;
}

/** One call, one residual. Exported so the pass can be driven a piece at a time. */
export async function readResidual(
  doc: CadDocument,
  candidate: ResidualCandidate,
  sections: readonly DrawingSection[],
  opts: ResidualPassOptions = {},
): Promise<ResidualReading | null> {
  const cfg = getAiConfig();
  const transport = opts.transport ?? openRouterTransport;
  const model = opts.model ?? cfg.visionModel;
  const brief = residualBrief(candidate, sections);

  const content: unknown[] = [{ type: 'text', text: brief }];
  if (!opts.skipPng) {
    // The crop is padded well past the residual on purpose: "does this belong
    // to that detail?" cannot be answered from a picture of the piece alone.
    const renderer = opts.renderer ?? defaultRenderer;
    const pad = Math.max(diagonal(candidate.bounds) * CROP_PAD, 1);
    const png = await renderer(doc, padBounds(candidate.bounds, pad), CROP_PX).catch(() => null);
    if (png) content.push({ type: 'image_url', image_url: { url: png } });
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: content.length === 1 ? brief : content },
  ];
  const reply = await transport({ model, messages, tools: [], signal: opts.signal });
  // `ChatReply.content` is already the flattened string — `contentOf` is for
  // raw API payloads, and putting one through the other yields nothing.
  return validateReading(parseModelJson(reply.content), candidate);
}

/**
 * Read every unread piece of `doc` that the first pass left behind.
 *
 * The package is not modified — the results are returned, so the caller
 * decides what to persist. Nothing here re-cuts a section, moves a bound or
 * touches the split.
 */
export async function runResidualPass(
  doc: CadDocument,
  sections: readonly DrawingSection[],
  opts: ResidualPassOptions = {},
): Promise<ResidualResult[]> {
  const sheet = sheetBounds(doc);
  const clusters = findGapClusters(doc, sections, sheet);
  if (!clusters.length) return [];

  const loose = residualEntities(doc, sections);
  const candidates = clusters
    .filter((c) => c.entityCount >= MIN_ENTITIES)
    .map((c) => describeCandidate(doc, c, loose, sections, sheet));

  const budget = opts.maxReads ?? MAX_READS;
  const out: ResidualResult[] = [];
  for (const candidate of candidates) {
    if (out.filter((r) => r.status === 'read').length >= budget) {
      // Said plainly rather than dropped: an unread piece that is silently
      // absent looks exactly like a sheet that was fully accounted for.
      const { link, linkedTo } = linkFor(candidate.geometry, null);
      out.push({
        ...candidate,
        link,
        linkedTo,
        reading: null,
        status: 'unread',
        note: `not read — the second pass reads the ${budget} largest pieces`,
      });
      opts.onEvent?.({ gapId: candidate.gapId, status: 'unread' });
      continue;
    }
    try {
      const reading = await readResidual(doc, candidate, sections, opts);
      const { link, linkedTo } = linkFor(candidate.geometry, reading);
      out.push({
        ...candidate,
        link,
        linkedTo,
        reading,
        status: reading ? 'read' : 'failed',
        ...(reading ? {} : { note: 'the model returned nothing that could be read' }),
      });
      opts.onEvent?.({ gapId: candidate.gapId, status: reading ? 'read' : 'failed' });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const { link, linkedTo } = linkFor(candidate.geometry, null);
      const note = err instanceof Error ? err.message : String(err);
      // One piece failing is not the pass failing. The rest are still worth
      // reading, and this one says why it was not.
      out.push({ ...candidate, link, linkedTo, reading: null, status: 'failed', note });
      opts.onEvent?.({ gapId: candidate.gapId, status: 'failed', note });
    }
  }
  return out;
}
