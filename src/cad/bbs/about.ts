// Persistent "About Drawing" memory for the BBS reader.
//
// This is not a cache of calculated quantities. The model conclusions stored
// here are evidence-addressed decisions (ownership, placement, dimension
// references and shapes). On the next run the orchestrator validates and
// resolves every conclusion against the current drawing again, so a saved
// number can never bypass the deterministic evidence and arithmetic layers.

import type { DrawingUnderstandingPackage } from '../understanding/types';
import type { CadDocument } from '../types';
import type { OrchestrateOutcome } from './orchestrate';
import { sectionDetail, sectionDetailLines, type SectionDetail } from './sectionDetail';

export const ABOUT_DRAWING_VERSION = 1;

export interface AboutDrawingSectionNote {
  sectionId: string;
  label: string;
  kind: string;
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number };
  memberHints: { mark: string; basis: string }[];
  calloutHints: string[];
  /** indexes into AboutDrawingMemory.conclusions that cite this section */
  conclusionIndexes: number[];
  /** deterministic rendering of the fields above, never model-authored facts */
  note: string;
  /**
   * Everything the section itself says — text, dimensions, callouts, what it
   * is made of — read straight out of the drawing.
   *
   * Absent on a note written before this existed, and on one built without the
   * document to read. The note text degrades with it rather than lying about
   * what it looked at.
   */
  detail?: SectionDetail;
}

export interface AboutDrawingMemory {
  version: number;
  documentId: string;
  drawingName: string;
  sourceDrawingHash: string;
  updatedAt: number;
  understanding?: string;
  /** validated, evidence-addressed conclusions to re-check on every load */
  conclusions: Record<string, unknown>[];
  /** rendered from the exact state used for the build */
  note: string;
  sectionNotes: AboutDrawingSectionNote[];
  /**
   * THE ENGINEERING DETAILS, reported separately from the visual regions
   * above. A detail drawn as four clusters is one entry here and four
   * `sectionNotes` — so a reader of this memory sees what the sheet MEANS
   * before what the splitter CUT, and the two are never confused.
   */
  logicalSections?: {
    id: string;
    title?: string;
    kind: string;
    marks: string[];
    regionIds: string[];
    relation: 'CONFIRMED' | 'POSSIBLE_CONTINUATION';
  }[];
  unresolved: string[];
  escalations: { question: string; whyNeeded: string }[];
}

function citedBy(conclusion: Record<string, unknown>, sectionId: string): boolean {
  const ids = Array.isArray(conclusion.evidenceIds) ? conclusion.evidenceIds : [];
  return ids.includes(sectionId);
}

function sectionNote(
  section: DrawingUnderstandingPackage['sections'][number],
  conclusions: readonly Record<string, unknown>[],
  doc?: CadDocument | null,
): AboutDrawingSectionNote {
  const memberHints = (section.memberHints ?? []).map((h) => ({ mark: h.mark, basis: h.basis }));
  const calloutHints = [...(section.calloutHints ?? [])];
  const conclusionIndexes = conclusions
    .map((c, i) => (citedBy(c, section.sectionId) ? i : -1))
    .filter((i) => i >= 0);
  const b = section.bounds;
  const lines = [
    `${section.sectionId} — ${section.label} [${section.kind}]`,
    `bounds: x ${Math.round(b.xMin)}..${Math.round(b.xMax)}, y ${Math.round(b.yMin)}..${Math.round(b.yMax)} mm`,
    memberHints.length
      ? `member labels seen: ${memberHints.map((h) => `${h.mark} (${h.basis})`).join('; ')}`
      : 'member labels seen: none recorded',
    calloutHints.length ? `callouts seen: ${calloutHints.join(' · ')}` : 'callouts seen: none recorded',
    `${conclusionIndexes.length} validated conclusion(s) cite this section`,
  ];
  // EVERYTHING THE SECTION ITSELF SAYS, read once from the drawing so no later
  // run has to ask a model for it again. Only when the document is to hand:
  // a note that cannot read is honest about it rather than silent.
  const detail = doc ? sectionDetail(doc, section.bounds) : null;
  if (detail) lines.push(...sectionDetailLines(detail));
  return {
    ...(detail ? { detail } : {}),
    sectionId: section.sectionId,
    label: section.label,
    kind: section.kind,
    bounds: { ...section.bounds },
    memberHints,
    calloutHints,
    conclusionIndexes,
    note: lines.join('\n'),
  };
}

export function buildAboutDrawingMemory(input: {
  documentId: string;
  drawingName: string;
  sourceDrawingHash: string;
  /**
   * A BBS run's outcome, when one has happened.
   *
   * OPTIONAL, and that is the point. The reading of a drawing is finished the
   * moment its sections are cut — the text, the dimensions and the callouts
   * are all on the sheet — so the note can and should be written then. Waiting
   * for a BBS run meant the Specification tab said "Nothing on file yet" about
   * a drawing that had already been read seven sections deep, and every run
   * went back to the model for what was already known.
   */
  outcome?: OrchestrateOutcome | null;
  pkg?: DrawingUnderstandingPackage | null;
  /** the drawing itself, so each section's own contents can be read into it */
  doc?: CadDocument | null;
  updatedAt?: number;
}): AboutDrawingMemory {
  const conclusions = (input.outcome?.acceptedConclusions ?? []).map((c) => ({ ...c }));
  return {
    version: ABOUT_DRAWING_VERSION,
    documentId: input.documentId,
    drawingName: input.drawingName,
    sourceDrawingHash: input.sourceDrawingHash,
    updatedAt: input.updatedAt ?? Date.now(),
    understanding: input.outcome?.understanding,
    conclusions,
    note: input.outcome?.note ?? readOnlyNote(input.pkg ?? null),
    sectionNotes: (input.pkg?.sections ?? []).map((s) => sectionNote(s, conclusions, input.doc)),
    // The details, beside the clusters — reported separately so a reader of
    // this memory never mistakes where the ink is for what the sheet means.
    ...(input.outcome?.sections?.length
      ? {
          logicalSections: input.outcome.sections.map((sec) => ({
            id: sec.id,
            ...(sec.title ? { title: sec.title } : {}),
            kind: sec.kind,
            marks: [...sec.marks],
            regionIds: [...sec.regionIds],
            relation: sec.relation,
          })),
        }
      : {}),
    unresolved: [...(input.outcome?.unresolved ?? [])],
    escalations: (input.outcome?.escalations ?? []).map((q) => ({ ...q })),
  };
}

/**
 * The headline note when the sheet has been READ but never built from.
 *
 * It says what is established and, just as plainly, that no schedule has been
 * derived — so nobody mistakes a complete reading for a complete take-off.
 */
function readOnlyNote(pkg: DrawingUnderstandingPackage | null): string {
  if (!pkg) return 'This drawing has not been read yet.';
  const n = pkg.sections.length;
  return [
    `# What this drawing says — ${pkg.sourceDrawing}`,
    '',
    `Read into ${n} section${n === 1 ? '' : 's'}. Everything below is taken straight`,
    'from the sheet — its text, its dimensions and its bar callouts, verbatim.',
    '',
    'No bar bending schedule has been built from it yet, so nothing here is a',
    'quantity: these are the readings a schedule would be derived FROM.',
    ...(pkg.summary ? ['', pkg.summary] : []),
  ].join('\n');
}

export function parseAboutDrawingMemory(raw: string): AboutDrawingMemory | null {
  try {
    const value = JSON.parse(raw) as Partial<AboutDrawingMemory>;
    if (
      value.version !== ABOUT_DRAWING_VERSION ||
      typeof value.documentId !== 'string' ||
      typeof value.sourceDrawingHash !== 'string' ||
      !Array.isArray(value.conclusions) ||
      typeof value.note !== 'string'
    ) return null;
    return {
      version: ABOUT_DRAWING_VERSION,
      documentId: value.documentId,
      drawingName: String(value.drawingName ?? ''),
      sourceDrawingHash: value.sourceDrawingHash,
      updatedAt: Number(value.updatedAt ?? 0),
      understanding: typeof value.understanding === 'string' ? value.understanding : undefined,
      conclusions: value.conclusions.filter(
        (c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c),
      ),
      note: value.note,
      sectionNotes: Array.isArray(value.sectionNotes) ? value.sectionNotes : [],
      unresolved: Array.isArray(value.unresolved) ? value.unresolved.map(String) : [],
      escalations: Array.isArray(value.escalations)
        ? value.escalations.filter(
            (q): q is { question: string; whyNeeded: string } =>
              !!q && typeof q.question === 'string' && typeof q.whyNeeded === 'string',
          )
        : [],
    };
  } catch {
    return null;
  }
}

/** Compact prompt context; structured conclusions are hydrated separately. */
/**
 * How much of the section notes goes into one prompt.
 *
 * The notes are the whole point of this file, so the budget is generous — but
 * it IS a budget. A sheet cut into forty sections would otherwise put its
 * entire text content into every turn of every run.
 */
const BRIEFING_BUDGET = 24_000;

export function aboutDrawingBriefing(memory: AboutDrawingMemory): string {
  // THE NOTES THEMSELVES, NOT A LIST OF THEIR NAMES.
  //
  // This used to send `REGION-01 "COLUMN SCHEDULE"; REGION-02 "TYPICAL…"` and
  // stop — the ids and the labels, and nothing of what any section actually
  // says. Every run then re-read the sheet box by box with getText, getCallouts
  // and getDimensions to recover text, callouts and dimensions that were
  // already read, already parsed and already on file.
  //
  // What follows is that reading. It does not replace looking: a section whose
  // note is thin, or whose reading is doubted, is still there to be cropped.
  // It replaces re-deriving what was already established.
  const notes: string[] = [];
  let spent = 0;
  let dropped = 0;
  for (const s of memory.sectionNotes) {
    const block = `--- ${s.sectionId} — ${s.label} [${s.kind}] ---\n${s.note}`;
    if (spent + block.length > BRIEFING_BUDGET) {
      dropped += 1;
      continue;
    }
    notes.push(block);
    spent += block.length;
  }

  const logical = memory.logicalSections ?? [];
  const logicalBlock = logical.length
    ? [
        '',
        `ENGINEERING DETAILS this sheet carries (${logical.length}) — read a detail WHOLE.`,
        'Each is drawn across the visual regions listed after it; a dimension in one and the',
        'callout it completes in another are the same detail.',
        ...logical.map(
          (l) =>
            `  ${l.id}${l.title ? ` "${l.title}"` : ''} [${l.kind}]` +
            `${l.marks.length ? ` · ${l.marks.join(', ')}` : ''}` +
            ` · regions ${l.regionIds.join(', ')}` +
            `${l.relation === 'POSSIBLE_CONTINUATION' ? ' · POSSIBLE_CONTINUATION — confirm the grouping' : ''}`,
        ),
      ]
    : [];

  return [
    '## ABOUT DRAWING — SAVED, CURRENT READING',
    memory.understanding ? `Previous understanding: ${memory.understanding}` : '',
    `${memory.conclusions.length} evidence-addressed conclusion(s) were revalidated against this drawing before this turn.`,
    memory.note,
    ...logicalBlock,
    memory.sectionNotes.length
      ? [
          '',
          `### WHAT EACH READ AREA SAYS — ${memory.sectionNotes.length} visual region(s) of this drawing`,
          '(These are the CLUSTERS the sheet was cut into, not the details above.)',
          '',
          'Text is verbatim. Dimensions carry the measured value and, where the',
          'detailer wrote one, the WRITTEN value — which is what the yard cuts to.',
          'Callouts show what the bar grammar read beside the string it read it from.',
          'None of this is ownership, placement or a count: those remain yours to',
          'establish. It is what is PRINTED, so you do not have to read it again.',
          '',
          ...notes,
          // Said out loud, because a silently shortened briefing is a briefing
          // the model will treat as complete.
          dropped
            ? `\n(${dropped} further section note(s) did not fit this turn — crop those regions to read them.)`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : 'No section notes are on file.',
    memory.unresolved.length ? `Still unresolved last time: ${memory.unresolved.join(' · ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
