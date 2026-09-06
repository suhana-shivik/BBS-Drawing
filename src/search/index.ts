// Search — the project index (UI_REQUIREMENTS_UPDATE §6.1).
//
// Pure builders over data other modules already produce: the register, the
// splitter's understanding packages, the fact ledger and the extractor's
// marks/callouts. Nothing here persists anything and nothing is incremental —
// the whole index is cheap to rebuild from scratch, and v1 does exactly that.
//
// Every indexed row keeps the navigation payload its SearchHit will need
// (§6.4: a result is a location), plus two ranking inputs (§6.3):
//   recency     — millisecond timestamp; breaks ties, newest first
//   superseded  — current revisions rank above superseded ones, which stay
//                 in the index labelled, never hidden

import type { DrawingRegisterEntry } from '../register/types';
import type {
  DrawingSection,
  DrawingUnderstandingPackage,
  SectionBounds,
} from '../cad/understanding/types';
import type { Ledger } from '../facts/ledger';
import type { FactState } from '../facts/types';

// ------------------------------------------------------------
// indexed rows
// ------------------------------------------------------------

export interface IndexedDrawing {
  documentId: string;
  /** The name the file was imported under — what every surface calls it. */
  fileName: string;
  drawingNumber: string;
  title: string;
  discipline: string;
  revision: string;
  superseded: boolean;
  recency: number;
}

export interface IndexedSection {
  sectionId: string;
  label: string;
  kind: string;
  parentDocumentId: string;
  bounds: SectionBounds;
  /** member marks the orchestrator saw in the region, e.g. "C1", "TB" */
  memberHints: string[];
  /** callouts inside the region, verbatim */
  calloutHints: string[];
  superseded: boolean;
  recency: number;
}

export interface IndexedFact {
  factId: string;
  state: FactState;
  /** String form of the value, '' when the fact is MISSING (value null). */
  valueText: string;
  /** SUPPLIED: the human's exact words. */
  saidAs: string;
  /** DECLARED: the text exactly as drawn. */
  rawText: string;
  recency: number;
}

export interface IndexedMark {
  /** verbatim mark or callout text */
  text: string;
  documentId: string;
  handles: string[];
  /** 'mark' = member mark (C1, F3); 'callout' = rebar annotation (8@150 C/C) */
  markKind: 'mark' | 'callout';
  superseded: boolean;
  recency: number;
}

export interface ProjectIndex {
  drawings: IndexedDrawing[];
  sections: IndexedSection[];
  facts: IndexedFact[];
  marks: IndexedMark[];
}

// ------------------------------------------------------------
// builders
// ------------------------------------------------------------

/** Register entries → drawing rows. Superseded entries stay in (§6.3). */
export function indexDrawings(entries: readonly DrawingRegisterEntry[]): IndexedDrawing[] {
  return entries.map((e) => ({
    documentId: e.documentId,
    fileName: e.originalFileName,
    drawingNumber: e.drawingNumber,
    title: e.title,
    discipline: e.discipline,
    revision: e.revision,
    superseded: e.revisionState === 'superseded',
    recency: e.importedAt,
  }));
}

/**
 * The mark/callout side needs a document to navigate to, which
 * `DrawingExtract` does not carry — so the caller pairs each extract (or a
 * bare list of marks/callouts) with its documentId. `ExtractedCallout[]`
 * satisfies `callouts` structurally, so `{ documentId, callouts: extract.callouts,
 * marks: extract.marks }` is the whole adaptation.
 */
export interface MarkSource {
  documentId: string;
  /** member marks found on the sheet, e.g. "C1", "F3" */
  marks?: readonly string[];
  /** rebar callouts, verbatim, with the entity handle behind each */
  callouts?: readonly { raw: string; handle?: string }[];
  /** when known: import time of the drawing, for recency tie-breaks */
  recency?: number;
}

function isPackageArray(
  input: readonly DrawingUnderstandingPackage[] | readonly DrawingSection[],
): input is readonly DrawingUnderstandingPackage[] {
  return input.length > 0 && 'sections' in input[0];
}

/**
 * Understanding packages (preferred — they know their documentId) or bare
 * `DrawingSection[]` → section rows. Bare sections fall back to their
 * `sourceDrawing` name as the parent id, which is the best a section alone
 * can say about where it came from.
 */
export function indexSections(
  input: readonly DrawingUnderstandingPackage[] | readonly DrawingSection[],
): IndexedSection[] {
  const rows: IndexedSection[] = [];
  const push = (s: DrawingSection, parentDocumentId: string, recency: number): void => {
    rows.push({
      sectionId: s.sectionId,
      label: s.label,
      kind: s.kind,
      parentDocumentId,
      bounds: s.bounds,
      memberHints: s.memberHints.map((h) => h.mark),
      calloutHints: [...s.calloutHints],
      superseded: false,
      recency,
    });
  };
  if (isPackageArray(input)) {
    for (const pkg of input) {
      for (const s of pkg.sections) push(s, pkg.documentId, pkg.createdAt);
    }
  } else {
    for (const s of input as readonly DrawingSection[]) push(s, s.sourceDrawing, 0);
  }
  return rows;
}

/**
 * Ledger → fact rows. Only CURRENT (non-superseded) entries are indexed —
 * the ledger's history is reachable from the fact once you are looking at
 * it; search finds the fact that is in force. MISSING facts are indexed too:
 * finding the open question by its key is half the point of §6.
 */
export function indexFacts(ledger: Ledger): IndexedFact[] {
  const rows: IndexedFact[] = [];
  for (const entry of ledger.entries) {
    const f = entry.fact;
    if (f.supersededBy !== undefined) continue;
    const readOnMs = Date.parse(f.readOn);
    rows.push({
      factId: f.id,
      state: f.state,
      valueText: f.value === null || f.value === undefined ? '' : String(f.value),
      saidAs: f.saidAs ?? '',
      rawText: f.source?.rawText ?? '',
      recency: Number.isNaN(readOnMs) ? 0 : readOnMs,
    });
  }
  return rows;
}

/** Extracted marks and callouts → mark rows, one per occurrence. */
export function indexMarks(sources: readonly MarkSource[]): IndexedMark[] {
  const rows: IndexedMark[] = [];
  for (const src of sources) {
    const recency = src.recency ?? 0;
    for (const mark of src.marks ?? []) {
      rows.push({
        text: mark,
        documentId: src.documentId,
        handles: [],
        markKind: 'mark',
        superseded: false,
        recency,
      });
    }
    for (const c of src.callouts ?? []) {
      rows.push({
        text: c.raw,
        documentId: src.documentId,
        handles: c.handle ? [c.handle] : [],
        markKind: 'callout',
        superseded: false,
        recency,
      });
    }
  }
  return rows;
}

// ------------------------------------------------------------
// the combined index
// ------------------------------------------------------------

export interface ProjectIndexInput {
  registerEntries?: readonly DrawingRegisterEntry[];
  /** understanding packages (preferred) or bare sections */
  sections?: readonly DrawingUnderstandingPackage[] | readonly DrawingSection[];
  ledger?: Ledger;
  marks?: readonly MarkSource[];
}

/**
 * Build the whole queryable index in one pass. Also propagates what only the
 * register knows onto the other kinds: a section or mark whose parent
 * document is superseded is itself demoted-and-labelled (§6.3), and marks
 * inherit their drawing's import time for recency unless the source said
 * otherwise.
 */
export function buildProjectIndex(input: ProjectIndexInput): ProjectIndex {
  const drawings = indexDrawings(input.registerEntries ?? []);
  const sections = indexSections(input.sections ?? []);
  const facts = input.ledger ? indexFacts(input.ledger) : [];
  const marks = indexMarks(input.marks ?? []);

  const byDoc = new Map<string, IndexedDrawing>();
  for (const d of drawings) byDoc.set(d.documentId, d);

  for (const s of sections) {
    const parent = byDoc.get(s.parentDocumentId);
    if (parent) {
      s.superseded = parent.superseded;
      if (s.recency === 0) s.recency = parent.recency;
    }
  }
  for (const m of marks) {
    const parent = byDoc.get(m.documentId);
    if (parent) {
      m.superseded = parent.superseded;
      if (m.recency === 0) m.recency = parent.recency;
    }
  }

  return { drawings, sections, facts, marks };
}
