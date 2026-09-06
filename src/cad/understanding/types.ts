// ============================================================
// Drawing understanding — the vocabulary.
//
// This layer answers ONE question: "what parts of this drawing are useful
// pieces?" It is deliberately not a BBS module. A BBS run consumes what it
// produces; so, later, will quantity take-off, structural review, clash
// analysis and plain human inspection. Nothing in this file mentions a bar,
// a diameter or a schedule row, and nothing in it should ever start to.
//
// UNITS — read this before touching any bounds.
//
// `CadDocument.entities` carry SOURCE-UNIT coordinates; `CadDocument.extents`
// and `CadRegion` bounds are published in MILLIMETRES (see dxf/parse.ts,
// "Entity coordinates stay in source units"). Two spaces, one drawing, and a
// crop that mixes them is off by `unitScale` — which on an inch-headed sheet
// is a factor of 25.4 and looks almost plausible.
//
// So: every `SectionBounds` in this module is MILLIMETRES, matching
// `doc.extents`, matching what the orchestrator is shown, matching what the
// display list draws. `bounds.ts` owns the single conversion back to source
// units for DXF export. No other file may do that conversion.
// ============================================================

/** Axis-aligned section box, ALWAYS in millimetres. See the unit note above. */
export interface SectionBounds {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/**
 * Suggested vocabulary for `DrawingSection.kind` — a hint to the orchestrator,
 * NOT a closed set.
 *
 * The whole point of this feature is that the model decides what a useful
 * decomposition is; validating its answer against a fixed enum would quietly
 * re-impose the hardcoded section list this replaces. An unrecognised kind is
 * kept verbatim.
 */
export const SECTION_KINDS = [
  'overall',
  'plan',
  'elevation',
  'section',
  'detail',
  'typical-detail',
  'layout',
  'schedule',
  'note',
  'reinforcement-detail',
  'foundation',
  'wall',
  'column',
  'beam',
  'precast',
  'unknown',
] as const;

/** Free-form: `SECTION_KINDS` is the suggestion, not the constraint. */
export type SectionKind = string;

/**
 * A member the orchestrator THINKS this region is about, and why.
 *
 * A hint, never an assignment. Stage 2 owns ownership; recording "the label
 * C1 is visible in this region" is drawing understanding, deciding that a
 * given callout belongs to C1 is not.
 */
export interface MemberHint {
  mark: string;
  /** how the orchestrator knows — "visible label in region", "title text", … */
  basis: string;
}

/** Something the exporter could not do faithfully, recorded rather than hidden. */
export interface SectionLimitation {
  code:
    | 'unclippable-entity'
    | 'block-not-found'
    | 'depth-limit'
    | 'no-geometry'
    | 'render-unavailable'
    | 'degenerate-bounds'
    /**
     * The box the model asked for turned out to contain two spatially
     * disconnected clumps of content — a stray handle from a neighbouring
     * detail, most often. The minority clump was dropped and the box
     * tightened to the majority. See `connectedEntitiesInBounds` in
     * `bounds.ts` for the detection and the empirical threshold behind it.
     */
    | 'disjoint-cluster-dropped'
    /**
     * Guard 4. Re-selecting entities from this section's own stored bounds did
     * not reproduce the entity list it recorded. A section that cannot be
     * regenerated from its own metadata is corrupt regardless of how it looks:
     * the PNG, the DXF and the bounds are supposed to be one box variable, and
     * a mismatch here means something downstream of that box moved. Recorded
     * rather than repaired — the split is evidence, and a guard that silently
     * rewrote the entity list to match would destroy the thing it checks.
     */
    | 'not-reproducible';
  message: string;
  count: number;
}

/**
 * One persisted section: a real drawing object, not a viewport.
 *
 * `png` and `dxf` are produced from `bounds` and from nothing else — see
 * `section.ts`, which takes the box once and hands it to both paths.
 */
export interface DrawingSection {
  /** stable within a package: REGION-01, REGION-02, … */
  sectionId: string;
  /** the orchestrator's own words */
  label: string;
  kind: SectionKind;
  sourceDrawing: string;
  sourceDrawingHash: string;
  /** millimetres; authoritative for BOTH the PNG and the DXF */
  bounds: SectionBounds;
  /** image/png data URL, or '' when this run had no rasteriser */
  png: string;
  /** DXF text — real CAD entities, original coordinates */
  dxf: string;
  /** entity handles that went into the DXF */
  entityIds: string[];
  /** text-entity handles the orchestrator cited as evidence */
  evidenceIds: string[];
  memberHints: MemberHint[];
  calloutHints: string[];
  /** which orchestrator turn produced this */
  orchestratorStep: number;
  /** 0..1, the orchestrator's own */
  confidence: number;
  /** entity count actually written to the DXF */
  entityCount: number;
  limitations: SectionLimitation[];
}

/**
 * One thing the orchestrator asked the platform to do, and what it got.
 *
 * Kept so the question "what did the AI actually ask us to cut?" has an
 * answer that is not a guess. A request that produced no section still gets a
 * record, with `note` saying why — a silent drop is exactly what this exists
 * to prevent.
 */
export interface SectionRequestRecord {
  step: number;
  /** the tool the model called */
  tool: string;
  /** verbatim arguments, as the model sent them */
  argument: unknown;
  /** what it asked for, when it asked in coordinates */
  requestedBounds: SectionBounds | null;
  /** what it asked for, when it asked in words */
  semanticHint: string | null;
  /** what the platform actually cut */
  resolvedBounds: SectionBounds | null;
  sectionId: string | null;
  pngPath: string | null;
  dxfPath: string | null;
  evidenceIds: string[];
  timestamp: number;
  /** why nothing was produced, when nothing was */
  note?: string;
}

/** An observation about how two sections relate. Drawing understanding only. */
export interface SectionRelationship {
  from: string;
  to: string;
  /** "detail-of", "section-through", "schedule-for", "same-member", … */
  kind: string;
  basis: string;
}

export const PACKAGE_VERSION = 1;

/**
 * The reusable artifact. Produced once per drawing version, consumed many
 * times by whatever wants to know how this sheet is laid out.
 */
export interface DrawingUnderstandingPackage {
  version: number;
  projectId: string;
  documentId: string;
  sourceDrawing: string;
  /**
   * Identity of the exact bytes this was built from. A package whose hash no
   * longer matches the drawing is STALE and must be reported as such, never
   * silently used — see `isStale` in ./store.
   */
  sourceDrawingHash: string;
  createdAt: number;
  /** millimetres, from doc.extents */
  sheetExtents: SectionBounds | null;
  sections: DrawingSection[];
  /** §18 audit trail */
  requests: SectionRequestRecord[];
  relationships: SectionRelationship[];
  /** areas the orchestrator looked at and could not account for */
  unresolved: string[];
  /**
   * What fraction of the drawing's own geometry ended up in ANY section —
   * computed once, from the drawing and the final section boxes, after the
   * orchestrator has finished. See `coverage.ts`. Pure geometry: this is
   * never absent, because it costs nothing to compute and a package that
   * cannot say whether it accounts for the drawing is exactly the silent
   * gap this field exists to close.
   */
  coverage: import('./coverage').CoverageSummary;
  /** the orchestrator's closing description of the sheet */
  summary: string;
  model: string;
  /** whether a real model produced this, or a local stand-in did */
  source: 'model' | 'local';
  /**
   * SECOND PASS — what the unread leftovers turned out to be.
   *
   * Optional because it is a separate stage that runs after the split and can
   * be run again on its own: a package written before it existed, or by a run
   * that never got to it, is still a valid package. Absent means "not read
   * yet", which is a different statement from an empty array — that one means
   * "read, and there was nothing left over".
   */
  residuals?: import('./residual').ResidualResult[];
  /**
   * STEP 8 — did each section end up holding what its area of the drawing
   * holds?
   *
   * Optional for the same reason `residuals` is: it is a separate stage that
   * can be run again on its own, and a package written before it existed is
   * still a valid package. Absent means "not checked", which is a different
   * statement from an empty array.
   */
  validations?: import('./validate').SectionValidation[];
}

/** A package plus the verdict on whether it still matches the drawing. */
export interface PackageStatus {
  package: DrawingUnderstandingPackage;
  stale: boolean;
  /** human-readable when stale */
  reason?: string;
}
