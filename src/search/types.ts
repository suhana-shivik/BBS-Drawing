// Search — hit types (UI_REQUIREMENTS_UPDATE §6).
//
// One search, four kinds of hit. The rule that shapes every type here is
// §6.4: **a result is a location** — selecting a hit navigates and
// highlights, never merely filters. So every variant of the union carries
// exactly what the palette needs to take you there:
//
//   drawing  → open that document (at that revision)
//   section  → open the section file / zoom the parent sheet to `bounds`
//   fact     → open the Specification view scrolled to the fact
//   mark     → open the drawing with the mark's handles lit in amber
//
// A hit that cannot say where it lives must not be constructed. There is no
// "text-only" variant on purpose.

import type { FactState } from '../facts/types';
import type { SectionBounds } from '../cad/understanding/types';

/** Which indexed field the query matched — shown in the palette row. */
export type MatchedField =
  | 'mark'
  | 'callout'
  | 'drawingNumber'
  | 'fileName'
  | 'title'
  | 'discipline'
  | 'revision'
  | 'label'
  | 'sectionId'
  | 'kind'
  | 'memberHint'
  | 'calloutHint'
  | 'factKey'
  | 'value'
  | 'saidAs'
  | 'rawText';

interface HitBase {
  /** Ranking score (§6.3). Higher first; ties broken by recency. */
  score: number;
  /** The field the query matched on. */
  matchedOn: MatchedField;
  /** The matched text, verbatim from the index — what the row displays. */
  snippet: string;
}

/** A register entry. Navigation: open `documentId` at this revision. */
export interface DrawingHit extends HitBase {
  kind: 'drawing';
  documentId: string;
  /** The imported file name — the label the palette shows. */
  fileName: string;
  drawingNumber: string;
  revision: string;
  /**
   * §6.3 — a superseded revision is labelled as such, never hidden.
   * Finding the old value is often the point.
   */
  superseded: boolean;
}

/** A split section. Navigation: open the section, or zoom parent to bounds. */
export interface SectionHit extends HitBase {
  kind: 'section';
  sectionId: string;
  /** the orchestrator's own words, verbatim */
  label: string;
  /** the document the section was split from */
  parentDocumentId: string;
  /** millimetres, authoritative — what the viewport zooms to */
  bounds: SectionBounds;
  /** set when the parent drawing has been superseded — labelled, never hidden */
  superseded?: boolean;
}

/** A ledger fact. Navigation: Specification view scrolled to `factId`. */
export interface FactHit extends HitBase {
  kind: 'fact';
  factId: string;
  state: FactState;
}

/** A member mark or rebar callout. Navigation: open drawing, light handles. */
export interface MarkHit extends HitBase {
  kind: 'mark';
  /** the mark/callout text, verbatim as drawn */
  text: string;
  documentId: string;
  /** entity handles to highlight in selection amber (may be empty) */
  handles: string[];
  /** set when the parent drawing has been superseded — labelled, never hidden */
  superseded?: boolean;
}

export type SearchHit = DrawingHit | SectionHit | FactHit | MarkHit;

export type SearchHitKind = SearchHit['kind'];
