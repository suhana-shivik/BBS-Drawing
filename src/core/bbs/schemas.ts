export type FactStatus = 'DRAWING_READ' | 'DERIVED' | 'USER_INPUT' | 'MISSING' | 'UNREADABLE';

export interface DataFact<T> {
  id?: string;
  value: T | null;
  unit?: string;
  semanticType: string; // e.g., 'spacing', 'dimension', 'embedment', 'quantity', 'shapeCode'
  status: FactStatus;
  confidence?: number;
  
  // Provenance
  sourceSection?: string; // e.g., 'Section A-A'
  sourceText?: string; // The exact text snippet (e.g., "20-DIA 16 VERTICAL BARS")
  drawingReference?: string; // ID or link to the specific drawing/entity
  /**
   * The ledger sequence number of this fact at the time it was consumed by a
   * BBS build. Stored in BBSBuildManifest.factVersions; any change to the seq
   * after the build marks the schedule STALE.
   */
  ledgerSeq?: number;
}

// Generic Member Schema
export interface MemberDef {
  memberType: DataFact<string>; // e.g., 'PEDESTAL', 'BEAM', 'COLUMN', but strictly from drawing
  memberMark: DataFact<string>;
  numberOfMembers: DataFact<number>;
  dimensions: Record<string, DataFact<number>>; // e.g., length, width, depth, diameter
  cover: Record<string, DataFact<number>>; // top, bottom, sides
}

// Generic Bar Shape Representation
export interface ShapeDef {
  shapeCode?: DataFact<string>;
  straightSegments: Array<DataFact<number>>;
  legs: Array<DataFact<number>>;
  bends: Array<{
    angle: DataFact<number>;
    deduction: DataFact<number>;
  }>;
  hooks: {
    start?: { type: DataFact<string>; length: DataFact<number>; };
    end?: { type: DataFact<string>; length: DataFact<number>; };
  };
  dimensions: Record<string, DataFact<number>>; // A, B, C, etc.
}

// Generic Bar Schema
export interface BarDef {
  barMark: DataFact<string>;
  diameter: DataFact<number>;
  
  // Quantity can be explicit or spacing-based
  quantityPerMember?: DataFact<number>;
  
  // Spacing can be uniform or zoned
  spacing?: {
    isZoned: boolean;
    uniformSpacing?: DataFact<number>;
    zones?: Array<{
      length: DataFact<number>;
      spacing: DataFact<number>;
    }>;
  };

  // Shape and Geometry
  shape: ShapeDef;
  
  // Engineering Parameters
  lapLength?: DataFact<number>;
  embedmentLength?: DataFact<number>;
  
  // Computed (Engine Outputs)
  cuttingLength?: number | 'MISSING';
  totalQuantity?: number | 'MISSING';
  totalLength?: number | 'MISSING';
  unitWeight?: number | 'MISSING';
  totalWeight?: number | 'MISSING';

  /**
   * Set when cover was not explicitly stated for this member in the drawing's
   * cover table and a project/settings default was applied instead.
   *
   *   'ASSUMED'          — a plausible default was used; the row still computes
   *                        but the assumption must be confirmed.
   *   'TO_BE_VERIFIED'  — a default was used AND the calculation involves an
   *                        anchorage/development-length check that depends on
   *                        cover; must be verified before the schedule is FINAL.
   *   'BLOCKED'          — cover is required for this calculation type and no
   *                        default can safely substitute; cuttingLength = MISSING.
   */
  coverAssumption?: 'ASSUMED' | 'TO_BE_VERIFIED' | 'BLOCKED';
}

export interface BBSOutput {
    members: Array<{
        member: MemberDef;
        bars: Array<BarDef>;
    }>;
    totalProjectWeight: number | 'MISSING';
}

export interface BBSEngineResult {
    output: BBSOutput;
    manifest: BBSBuildManifest;
}

// ============================================================
// BBS Lifecycle — dependency tracking and staleness detection
// ============================================================

/**
 * The full lifecycle of a BBS build.
 *
 *   BUILDING   — the engine is currently running.
 *   STALE      — at least one dependent fact or the drawing has changed since
 *                the schedule was produced. Do NOT show this schedule as the
 *                current schedule. Trigger an automatic rebuild.
 *   REBUILDING — a new run is in progress to replace the stale schedule.
 *   VALIDATED  — the run finished and every row either has a verified cutting
 *                length or an explicit reason it could not be computed.
 *   FINAL      — validated + every ASSUMED/TO_BE_VERIFIED cover assumption has
 *                been resolved or explicitly acknowledged.
 */
export type BBSLifecycleStatus = 'BUILDING' | 'STALE' | 'REBUILDING' | 'VALIDATED' | 'FINAL';

/**
 * Per-row fact dependency record. Stored with every build manifest so that
 * when a new answer arrives we can name exactly which rows are stale without
 * re-running the engine.
 */
export interface BBSRowFactDep {
  /** Unique row id: "<memberMark>:<barMark>". */
  rowId: string;
  /** The ledger fact ids this row's computation depended on. */
  factIds: string[];
  /**
   * The drawing hash the cutting length was computed from. If the drawing is
   * re-imported with different bytes the hash changes and the row is stale.
   */
  drawingHash: string;
}

/**
 * Everything a completed BBS build must record so that any later change to the
 * fact ledger or the drawing can be detected and the schedule marked STALE.
 *
 * RULE: A schedule must NEVER be presented as the current schedule unless
 * checkManifestFreshness() returns { fresh: true }. If it returns false,
 * set status = 'STALE' and trigger a rebuild.
 */
export interface BBSBuildManifest {
  /** UUID assigned at build time. */
  buildId: string;
  /** Epoch ms the build started. */
  builtAt: number;
  /**
   * Hash of the drawing bytes (DXF/DWG source) this build read.
   * A re-import that changes the hash immediately stalens every row.
   */
  drawingHash: string;
  /**
   * Every usable fact id in the ledger at build time. An id that was usable
   * then but is no longer usable now (superseded, withdrawn, contradicted)
   * marks the schedule STALE.
   */
  factIds: string[];
  /**
   * The ledger sequence number for each fact id at build time.
   * A fact whose current seq differs from the stored value has been updated
   * and marks the schedule STALE.
   */
  factVersions: Record<string, number>;
  /** Per-row dependency map (which fact ids each row consumed). */
  rowDeps: BBSRowFactDep[];
  /**
   * The lifecycle status. Never trust a schedule with status 'STALE' as the
   * current schedule.
   */
  status: BBSLifecycleStatus;
  /** Epoch ms when the schedule reached 'VALIDATED' or 'FINAL'. */
  validatedAt?: number;
  /**
   * Fact ids that triggered the last STALE transition. Stored so the UI can
   * name them in the stale banner. Cleared after a successful rebuild.
   */
  staleFactIds?: string[];
}

// ============================================================
// Freshness check — the single gate
// ============================================================

export interface ManifestFreshnessResult {
  /** True only when the drawing hash matches AND no fact seq has changed. */
  fresh: boolean;
  /**
   * Fact ids whose seq changed or that are new since the build.
   * Empty when fresh = true.
   */
  staleFactIds: string[];
  /** True when the drawing was re-imported with different source bytes. */
  drawingChanged: boolean;
}

/**
 * Compare a stored manifest against the current fact-version map and drawing
 * hash. This is the ONLY gate that decides whether a stored schedule may be
 * shown as the current schedule.
 *
 * Pass `currentFactVersions` as `{ [factId]: ledgerSeq }` for every currently
 * usable fact. Pass `currentDrawingHash` as the live hash of the drawing bytes.
 *
 * Returns `fresh: false` when:
 *   - the drawing hash has changed; OR
 *   - any manifest fact id has a different seq in the current ledger; OR
 *   - any fact id that is now usable was NOT in the manifest (new answer).
 */
export function checkManifestFreshness(
  manifest: BBSBuildManifest,
  currentFactVersions: Record<string, number>,
  currentDrawingHash: string,
): ManifestFreshnessResult {
  const staleFactIds: string[] = [];
  const drawingChanged = manifest.drawingHash !== currentDrawingHash;

  // Facts the build knew about — check if any have moved or disappeared.
  for (const id of manifest.factIds) {
    const storedSeq = manifest.factVersions[id];
    const currentSeq = currentFactVersions[id];
    if (currentSeq === undefined || currentSeq !== storedSeq) {
      staleFactIds.push(id);
    }
  }

  // Facts that are new since the build — answers that the schedule never saw.
  for (const id of Object.keys(currentFactVersions)) {
    if (!(id in manifest.factVersions) && !staleFactIds.includes(id)) {
      staleFactIds.push(id);
    }
  }

  return {
    fresh: !drawingChanged && staleFactIds.length === 0,
    staleFactIds,
    drawingChanged,
  };
}
