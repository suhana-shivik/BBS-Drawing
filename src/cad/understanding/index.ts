// ============================================================
// Drawing understanding — the public surface.
//
// One entry point for the product action "Split this drawing", and the
// loaders every later consumer uses. A consumer never runs the splitter as a
// side effect of its own job: it asks whether a package exists, and says so
// when one does not. §15.
// ============================================================
export type {
  DrawingSection,
  DrawingUnderstandingPackage,
  MemberHint,
  PackageStatus,
  SectionBounds,
  SectionKind,
  SectionLimitation,
  SectionRelationship,
  SectionRequestRecord,
} from './types';
export { PACKAGE_VERSION, SECTION_KINDS } from './types';
export { computeCoverage, coverageSummaryLines, type CoverageGap, type CoverageSummary } from './coverage';
export {
  checkReproducible,
  checkSectionReproducible,
  reproducibilityLimitation,
  reproducibilityNote,
  type ReproducibilityFinding,
} from './reproducible';

export {
  boundsForHandles,
  connectedEntitiesInBounds,
  type ConnectedSelection,
  boundsFromCorners,
  boundsKey,
  entitiesInBounds,
  entityBoundsMm,
  isDegenerate,
  normaliseBounds,
  padBounds,
  sheetBounds,
  type SectionPolicy,
} from './bounds';

export { writeSectionDxf, type DxfWriteResult } from './dxfWrite';
export { exportSection, sectionIdFor, defaultRenderer, SECTION_PX, type SectionRenderer } from './section';
export { drawingHash, hashDocument, hashSourceBytes } from './hash';
export {
  currentPackageFor,
  deletePackage,
  loadPackages,
  restorePackage,
  packageFor,
  savePackage,
  sectionFileTree,
  stalenessOf,
  type PackageFile,
} from './store';
export {
  ORCHESTRATOR_TOOLS,
  openRouterTransport,
  splitDrawing,
  textIndex,
  type ChatTransport,
  type OrchestratorEvent,
  type SplitOptions,
} from './orchestrator';

import type { CadDocument } from '../types';
import { splitDrawing, type SplitOptions } from './orchestrator';
import { savePackage } from './store';
import type { DrawingUnderstandingPackage } from './types';

/**
 * "Split this drawing."
 *
 * The whole product action: decompose, cut, persist. Independent of every
 * downstream capability — nothing about a schedule or a bill is involved, and
 * no caller has to be building one.
 *
 * The package is saved before it is returned, so a caller that forgets to
 * save cannot leave the user with sections that vanish on reload.
 */
export async function splitAndSaveDrawing(
  doc: CadDocument,
  opts: SplitOptions,
): Promise<DrawingUnderstandingPackage> {
  const pkg = await splitDrawing(doc, opts);
  await savePackage(pkg);
  return pkg;
}

import { runResidualPass, type ResidualPassOptions } from './residual';

export {
  finalizeSecondPass,
  finalizationReport,
  outcomeFor,
  type EntityAccounting,
  type Finalization,
  type FinalRegion,
  type RegionSource,
  type ResidualOutcome,
} from './finalize';

export {
  runResidualPass,
  readResidual,
  residualGeometry,
  residualEntities,
  residualBrief,
  describeCandidate,
  linkFor,
  validateReading,
  type ResidualCandidate,
  type ResidualGeometry,
  type ResidualLink,
  type ResidualReading,
  type ResidualResult,
} from './residual';
export type { ResidualPassOptions };

/**
 * Run the second pass over a saved package and file what it read.
 *
 * SEPARATE from the split on purpose. The split is expensive and the reading
 * of the leftovers is a different question asked of a different, much smaller
 * payload — so it can be re-run on its own when a key arrives late, or when
 * the first attempt failed, without re-cutting a single section.
 *
 * The sections are not touched: no bound moves, nothing is re-cut, nothing is
 * renumbered. Only `residuals` is written.
 */
export async function readResidualsAndSave(
  doc: CadDocument,
  pkg: DrawingUnderstandingPackage,
  opts: Omit<ResidualPassOptions, never> = {},
): Promise<DrawingUnderstandingPackage> {
  const residuals = await runResidualPass(doc, pkg.sections, opts);
  const next: DrawingUnderstandingPackage = { ...pkg, residuals };
  await savePackage(next);
  return next;
}

import { validateSections } from './validate';

export {
  validateSection,
  validateSections,
  reviewMismatches,
  needsReview,
  validationReport,
  verdictReport,
  reviewContent,
  auditLabels,
  labelAuditReport,
  type LabelGroup,
  type LabelInstance,
  type CheckStatus,
  type EntityCounts,
  type Mismatch,
  type SectionValidation,
  type ValidateOptions,
} from './validate';

/**
 * Run the section validation over a saved package and file what it found.
 *
 * Validated against the ORIGINAL sections — the immutable snapshot the first
 * pass filed — never against the finalised regions. Finalisation grows a
 * region's highlight and moves ownership around; checking the pipeline's
 * output against the pipeline's own later opinion of it would pass by
 * construction and prove nothing.
 *
 * Sections are not touched. This writes only `validations`.
 */
export async function validateAndSave(
  doc: CadDocument,
  pkg: DrawingUnderstandingPackage,
  opts: import('./validate').ValidateOptions = {},
): Promise<DrawingUnderstandingPackage> {
  const validations = await validateSections(doc, pkg.sections, opts);
  const next: DrawingUnderstandingPackage = { ...pkg, validations };
  await savePackage(next);
  return next;
}
