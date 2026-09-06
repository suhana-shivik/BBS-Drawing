// Fact writers — one small pure adapter per producer (PRODUCT_AS_HARNESS §3.2).
//
// Today the producers write to six different places, or to nowhere. These
// adapters give them one destination: each takes a producer's existing output
// SHAPE (the producers themselves are untouched) and returns Facts tagged with
// the right state and provenance, ready for `recordFact`. No adapter invents a
// number — every value below is read off the producer's own output.
//
//   buildPlacementBands()  → MEASURED   columns.main_pitch, columns.main_run…
//   computeCoverage()      → MEASURED   sheet.coverage
//   interview exchanges    → SUPPLIED   with saidAs — the exact words
//   section transcription  → DECLARED   with handles + verbatim rawText

import type { BandsResult, PlacementBand } from '../cad/bbs/bands';
import type { EvidenceGraph } from '../cad/bbs/evidence';
import type { InterviewExchange } from '../cad/bbs/interview';
import type { CoverageSummary } from '../cad/understanding/coverage';
import type { Fact, FactValue } from './types';

/** Provenance shared by every fact one producer run emits. */
export interface FactWriteSource {
  drawingNumber: string;
  revision: string;
  documentId?: string;
  sectionId?: string;
  /** identity of the exact drawing bytes/structure — enables staleness (§3.4) */
  sourceDrawingHash?: string;
  /** ISO date; defaults to today */
  readOn?: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

function stamp(source: FactWriteSource): Pick<Fact, 'source' | 'sourceDrawingHash' | 'readOn'> {
  return {
    source: {
      drawingNumber: source.drawingNumber,
      revision: source.revision,
      ...(source.documentId !== undefined ? { documentId: source.documentId } : {}),
      ...(source.sectionId !== undefined ? { sectionId: source.sectionId } : {}),
    },
    ...(source.sourceDrawingHash !== undefined
      ? { sourceDrawingHash: source.sourceDrawingHash }
      : {}),
    readOn: source.readOn ?? today(),
  };
}

// ------------------------------------------------------------
// buildPlacementBands() → MEASURED
// ------------------------------------------------------------

/** Distinct node positions along a band's axis, in order (same rule as bandViewBox). */
function nodePositions(band: PlacementBand, graph: EvidenceGraph): number[] {
  return [
    ...new Set(
      band.occurrenceIds
        .map((id) => graph.byId.get(id)?.position?.[band.axis])
        .filter((v): v is number => typeof v === 'number')
        .map((v) => Math.round(v)),
    ),
  ].sort((p, q) => p - q);
}

/**
 * MEASURED facts from recovered placement bands: for the principal band (the
 * longest drawn layout) `columns.main_pitch` / `columns.main_run` /
 * `columns.main_nodes`, and the same trio per band under its own id
 * (`columns.band_02_pitch`, …) when several layouts share the sheet.
 *
 * Pitch needs the evidence graph (the band itself carries only ranges, not
 * node positions); without a graph only the run — a real measurement the band
 * does carry — is emitted. Nothing is estimated.
 */
export function factsFromPlacementBands(
  result: BandsResult | PlacementBand[],
  source: FactWriteSource,
  graph?: EvidenceGraph,
): Fact[] {
  const bands = Array.isArray(result) ? result : result.bands;
  if (!bands.length) return [];
  const base = stamp(source);
  const extent = (b: PlacementBand): number => b.longitudinalRange[1] - b.longitudinalRange[0];
  const main = bands.reduce((a, b) => (extent(b) > extent(a) ? b : a));

  const facts: Fact[] = [];
  for (const band of bands) {
    const key = band === main ? 'main' : band.id.toLowerCase().replace(/-/g, '_');
    const marks = Object.entries(band.tally)
      .map(([m, n]) => `${m}×${n}`)
      .join(', ');
    const method = `buildPlacementBands() over ${marks} (${band.id}, axis ${band.axis})`;
    const evidence = band.occurrenceIds;

    facts.push({
      id: `columns.${key}_run`,
      value: Math.round(extent(band)),
      unit: 'mm',
      state: 'MEASURED',
      method,
      evidence,
      ...base,
    });

    if (graph) {
      const at = nodePositions(band, graph);
      facts.push({
        id: `columns.${key}_nodes`,
        value: at.length,
        state: 'MEASURED',
        method,
        evidence,
        ...base,
      });
      if (at.length > 1) {
        facts.push({
          id: `columns.${key}_pitch`,
          value: Math.round((at[at.length - 1] - at[0]) / (at.length - 1)),
          unit: 'mm',
          state: 'MEASURED',
          method,
          evidence,
          ...base,
        });
      }
    }
  }
  return facts;
}

// ------------------------------------------------------------
// computeCoverage() → MEASURED
// ------------------------------------------------------------

/**
 * MEASURED `sheet.coverage`: the fraction of the drawing's measurable
 * entities that landed inside some section, straight off the summary.
 */
export function factsFromCoverage(coverage: CoverageSummary, source: FactWriteSource): Fact[] {
  const fraction =
    coverage.measurableEntities > 0
      ? coverage.coveredEntities / coverage.measurableEntities
      : 1;
  const gaps = coverage.gaps.slice(0, 6).map((g) => `${g.layer} (${g.count} uncovered)`);
  return [
    {
      id: 'sheet.coverage',
      value: Math.round(fraction * 1000) / 1000,
      state: 'MEASURED',
      method:
        `computeCoverage(): ${coverage.coveredEntities} of ` +
        `${coverage.measurableEntities} measurable entities inside a section`,
      ...(gaps.length ? { evidence: gaps } : {}),
      ...stamp(source),
    },
  ];
}

// ------------------------------------------------------------
// interview exchanges → SUPPLIED
// ------------------------------------------------------------

/** Who answered; the exchange itself is the transcript trace. */
export interface InterviewProvenance {
  /** name/email/channel — SUPPLIED is attributable */
  suppliedBy: string;
  /** ISO date; defaults to today */
  on?: string;
  /** the drawing the questions were raised from, if any (context, not authority) */
  source?: FactWriteSource;
}

function factIdForTarget(writes: InterviewExchange['question']['writes']): string {
  switch (writes.scope) {
    case 'member':
      return `${writes.mark}.${String(writes.field)}`;
    case 'settings':
      return `settings.${String(writes.field)}`;
    default:
      // take-off fields may already be dotted ledger ids ("wall.total_run")
      return writes.field.includes('.') ? writes.field : `takeoff.${writes.field}`;
  }
}

/**
 * SUPPLIED facts from answered interview exchanges. Values enter with
 * `saidAs` — the answer exactly as given — so every supplied number stays
 * checkable against its own transcript (skipped and unanswered questions
 * yield nothing). Table answers (per_stretch) are kept verbatim as JSON.
 */
export function factsFromInterviewAnswers(
  exchanges: readonly InterviewExchange[],
  who: InterviewProvenance,
): Fact[] {
  const facts: Fact[] = [];
  for (const ex of exchanges) {
    if (!ex.answer || ex.skipped) continue;
    const raw = ex.answer.value;
    const value: FactValue = Array.isArray(raw) ? JSON.stringify(raw) : raw;
    const saidAs = Array.isArray(raw) ? JSON.stringify(raw) : String(raw);
    facts.push({
      id: factIdForTarget(ex.question.writes),
      value,
      ...(ex.question.unit !== undefined ? { unit: ex.question.unit } : {}),
      state: 'SUPPLIED',
      suppliedBy: who.suppliedBy,
      saidAs,
      evidence: [`asked: "${ex.question.text}" (${ex.question.id})`],
      neededFor: [ex.question.why],
      ...(who.source ? { source: stamp(who.source).source } : {}),
      readOn: who.on ?? new Date(ex.at).toISOString().slice(0, 10),
    });
  }
  return facts;
}

// ------------------------------------------------------------
// section transcription → DECLARED
// ------------------------------------------------------------

/**
 * THE CONTRACT the transcription stage must emit, one entry per statement the
 * model read off a section (HOW_TO_BUILD_IT §3 stage 2).
 *
 * No typed transcription output exists yet — stage 2 currently produces prose
 * (`section-description-*.txt`), so this type defines the boundary: the model
 * points (section, verbatim text, handles) and names what the statement means
 * (`id`); the value is the drawing's own words. When the transcription stage
 * gains structured output it must produce exactly this shape.
 */
export interface DeclaredFactInput {
  /** dotted ledger id the statement resolves to, e.g. "TB.section" */
  id: string;
  /** the reading, e.g. "350x400" or 350 — from the drawing text, never invented */
  value: FactValue;
  unit?: string;
  /** which section of the split package it was read in, e.g. "REGION-11" */
  sectionId?: string;
  /** verbatim, exactly as drawn — what makes a DECLARED fact quotable */
  rawText: string;
  /** DXF entity handles behind the text, e.g. ["79A47"] — the audit trail */
  handles?: string[];
}

/**
 * DECLARED facts from a section transcription: written on a drawing, read by
 * a model, quotable — each carries its verbatim text and handles.
 */
export function factsFromTranscription(
  declared: readonly DeclaredFactInput[],
  source: FactWriteSource,
): Fact[] {
  return declared.map((d) => {
    const base = stamp(source);
    return {
      id: d.id,
      value: d.value,
      ...(d.unit !== undefined ? { unit: d.unit } : {}),
      state: 'DECLARED' as const,
      ...base,
      source: {
        ...base.source!,
        ...(d.sectionId !== undefined ? { sectionId: d.sectionId } : {}),
        rawText: d.rawText,
        ...(d.handles !== undefined ? { handles: d.handles } : {}),
      },
      evidence: [
        `"${d.rawText}"`,
        ...(d.handles ?? []).map((h) => `handle ${h}`),
      ],
    };
  });
}
