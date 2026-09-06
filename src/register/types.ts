export type DrawingDiscipline =
  | 'architectural'
  | 'structural'
  | 'mep'
  | 'civil'
  | 'general';

export type RegisterHealth = 'ready' | 'review' | 'limited';
export type RegisterRevisionState = 'current' | 'superseded' | 'review';

/** Split-on-import job state for a drawing (UI_REQUIREMENTS_UPDATE §3.1/§7). */
export type SplitStatus = 'queued' | 'splitting' | 'split' | 'failed' | 'stale';

export interface RegisterEvidence {
  value: string;
  handle?: string;
  source: 'title-block' | 'filename' | 'inferred' | 'user';
  confidence: number;
}

export interface DrawingRegisterEntry {
  id: string;
  projectId: string;
  /** stable parsed CadDocument id */
  documentId: string;
  assetId: string;
  originalFileName: string;
  displayName: string;
  drawingNumber: string;
  identityKey: string;
  title: string;
  revision: string;
  revisionRank: number | null;
  issueDate: string;
  discipline: DrawingDiscipline;
  health: RegisterHealth;
  revisionState: RegisterRevisionState;
  importedAt: number;
  warnings: string[];
  evidence: {
    drawingNumber?: RegisterEvidence;
    title?: RegisterEvidence;
    revision?: RegisterEvidence;
    issueDate?: RegisterEvidence;
    discipline?: RegisterEvidence;
  };
  /**
   * Fingerprint of the file this entry was imported from (see
   * `contentHash.ts`). Two entries with the same hash are the SAME upload, not
   * two versions of one drawing — the import path refuses to file the second.
   * Absent on entries registered before hashing existed, and on the legacy
   * enrolment path, which has no source text to hash.
   */
  contentHash?: string;
  /**
   * When this exact file was last dropped in again. The register keeps one
   * row for it — this records that somebody re-uploaded it, so the properties
   * pane can say so instead of silently swallowing the action.
   */
  reuploadedAt?: number;
  /**
   * Where this sheet sits in its own revision chain, 1-based, and how long
   * that chain is. Stamped by `reconcileRevisionStates` so the number and the
   * `revisionState` beside it can never disagree: v3 of 3 IS the current one.
   * Both are 1 for a drawing held in a single version.
   */
  versionNo: number;
  versionCount: number;
  /** The entry that replaced this one. Set only on a superseded revision. */
  supersededById?: string;
  /** Split-on-import job state — drives the register's state dot (§7). */
  splitStatus?: SplitStatus;
  /** Hash the drawing's split package is keyed by — the stale marker (§7). */
  packageHash?: string;
}

export interface DrawingRegisterData {
  projectId: string;
  entries: DrawingRegisterEntry[];
  updatedAt: number;
}

