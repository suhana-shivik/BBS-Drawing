// R3 — sections as files: pure projections from a DrawingUnderstandingPackage
// onto the studio's register/Files vocabulary, plus the small helpers a
// section sheet needs. Nothing here extracts anything new: every field shown
// is read straight off the package the splitter already writes (§3.2–§3.4).

import type { CadDocument } from '../cad/types';
import { entitiesInBounds } from '../cad/understanding/bounds';
import type {
  CoverageSummary,
  DrawingSection,
  DrawingUnderstandingPackage,
} from '../cad/understanding';
import type { RegisterFileNode, RegisterFolderNode } from './data';

// ------------------------------------------------------------
// ids — a section opens as a sheet in its own right
// ------------------------------------------------------------

const SECTION_SHEET_PREFIX = 'sec:';

export function sectionSheetId(documentId: string, sectionId: string): string {
  return `${SECTION_SHEET_PREFIX}${documentId}:${sectionId}`;
}

export function parseSectionSheetId(
  id: string,
): { documentId: string; sectionId: string } | null {
  if (!id.startsWith(SECTION_SHEET_PREFIX)) return null;
  const rest = id.slice(SECTION_SHEET_PREFIX.length);
  const at = rest.lastIndexOf(':');
  if (at <= 0) return null;
  return { documentId: rest.slice(0, at), sectionId: rest.slice(at + 1) };
}

export function sectionsFolderId(documentId: string): string {
  return `f-sections-${documentId}`;
}

// ------------------------------------------------------------
// coverage lines (§3.4)
// ------------------------------------------------------------

export function coveragePct(coverage: CoverageSummary | undefined): number | null {
  if (!coverage || coverage.measurableEntities <= 0) return null;
  return (coverage.coveredEntities / coverage.measurableEntities) * 100;
}

/** "97.5% of 1,335 entities" */
export function coverageLineFor(coverage: CoverageSummary | undefined): string | null {
  const pct = coveragePct(coverage);
  if (pct === null || !coverage) return null;
  return `${pct.toFixed(1)}% of ${coverage.measurableEntities.toLocaleString('en-IN')} entities`;
}

/** The folder line: "12 items · 97.5% covered" (§3.2). */
export function sectionsFolderMeta(pkg: DrawingUnderstandingPackage): string {
  const n = pkg.sections.length;
  const pct = coveragePct(pkg.coverage);
  const items = `${n} item${n === 1 ? '' : 's'}`;
  return pct === null ? items : `${items} · ${pct.toFixed(1)}% covered`;
}

export interface ResidualLayer {
  layer: string;
  count: number;
  /**
   * True when the splitter's own closing accounting (`pkg.unresolved`) names
   * this layer — it looked, and said so. A residual layer the orchestrator
   * never accounted for is an UNEXPLAINED gap and a warning state (§3.4).
   */
  explained: boolean;
  /** example texts among the orphans — the fastest way to recognise a gap */
  sampleText: string[];
}

export function residualFor(pkg: DrawingUnderstandingPackage): ResidualLayer[] {
  const unresolved = (pkg.unresolved ?? []).join('\n');
  return (pkg.coverage?.gaps ?? []).map((g) => ({
    layer: g.layer,
    count: g.count,
    explained: unresolved.includes(g.layer),
    sampleText: g.sampleText ?? [],
  }));
}

export function hasUnexplainedGap(pkg: DrawingUnderstandingPackage): boolean {
  return residualFor(pkg).some((r) => !r.explained);
}

// ------------------------------------------------------------
// register / Files projection (§3.2)
// ------------------------------------------------------------

export function sectionFileNode(
  documentId: string,
  s: DrawingSection,
  /** when the package these sections came out of was built */
  at?: number,
): RegisterFileNode {
  const limited = (s.limitations ?? []).length > 0;
  return {
    kind: 'file',
    id: sectionSheetId(documentId, s.sectionId),
    name: `${s.sectionId} · ${s.label}`,
    tag: s.kind,
    state: limited ? 'warn' : 'ok',
    sheetId: sectionSheetId(documentId, s.sectionId),
    meta: `${(s.entityCount ?? 0).toLocaleString('en-IN')} entities`,
    ext: 'dxf',
    // A section has no time of its own: it came into being when the split
    // ran, so it carries the package's own moment rather than none at all.
    ...(typeof at === 'number' ? { at } : {}),
  };
}

/**
 * The display name of a drawing's section folder: `section-<drawing name>`.
 *
 * The extension goes. "section-Plinth beam.dxf" reads as a file with a
 * peculiar name; "section-Plinth beam" reads as what it is — the folder of
 * regions cut out of Plinth beam. The drawing's own name is folded in because
 * folders always sort above files (`compareNodes`), so this folder routinely
 * drifts away from the row it belongs to and has to say whose sections it
 * carries on its own.
 *
 * The NAME is for reading. Identity is `sectionsFolderId(documentId)` — the
 * stable document id — so renaming a drawing renames this folder rather than
 * minting a second one, and two drawings that happen to share a file name
 * still get one section folder each.
 */
export function sectionsFolderName(drawingName: string): string {
  return `section-${drawingName.replace(/\.[A-Za-z0-9]+$/, '')}`;
}

/** The per-drawing section folder, carrying the coverage line as its meta. */
export function sectionsFolderFor(
  pkg: DrawingUnderstandingPackage,
  drawingName: string,
): RegisterFolderNode {
  return {
    kind: 'folder',
    id: sectionsFolderId(pkg.documentId),
    name: sectionsFolderName(drawingName),
    icon: 'section',
    meta: sectionsFolderMeta(pkg),
    at: pkg.createdAt,
    children: pkg.sections.map((s) => sectionFileNode(pkg.documentId, s, pkg.createdAt)),
  };
}

// ------------------------------------------------------------
// section sheets — the render decision (§3.2)
// ------------------------------------------------------------
//
// A section renders as the parent document's ENTITY SUBSET pushed through the
// existing sheet render path (buildDisplayList → groupedSheetSvg). That is
// what the ported code makes cheapest: the package's `entityIds` (or, when a
// trimmed package lacks them, `entitiesInBounds` over the section's mm box)
// select entities; a shallow document copy keeps the real symbol tables, so
// blocks, linetypes and text styles resolve exactly as on the parent sheet
// and every op keeps its original handle for the shared selection path.

export function sectionEntityHandles(doc: CadDocument, s: DrawingSection): string[] {
  const ids = s.entityIds ?? [];
  if (ids.length) return ids;
  // Trimmed packages (fixtures, exports) carry bounds but not the handle list.
  return entitiesInBounds(doc, s.bounds).handles;
}

/** Shallow copy of the parent doc holding only the section's entities. */
export function sectionSubsetDoc(doc: CadDocument, s: DrawingSection): CadDocument {
  const wanted = new Set(sectionEntityHandles(doc, s));
  return {
    ...doc,
    id: `${doc.id}#${s.sectionId}`,
    name: `${s.sectionId} ${s.label}`,
    entities: doc.entities.filter((e) => wanted.has(e.style.handle)),
    regions: [],
  };
}
