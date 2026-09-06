// ============================================================
// Filing a split in the Drawing Register.
//
// A split is a derived output of a drawing, exactly like a quantity sheet or
// a bar bending schedule — so it is filed the way those are: a versioned
// `ProjectArtifact` against the source drawing, appearing in its own folder.
// Inventing a second filing system for it would have left the one place a
// person looks for "what has this drawing produced" telling them nothing.
//
// WHAT IS FILED IS AN INDEX, NOT THE PACKAGE.
//
// The section DXFs and PNGs run to several megabytes. The register loads
// every artifact for a project to count its folders, so putting the bodies in
// there would make listing a folder pay for eighteen drawings' worth of
// geometry. The bodies stay in the understanding store and are read only when
// somebody opens the row.
// ============================================================
import { saveProjectArtifact, type ProjectArtifact } from '../../register/artifacts';
import type { CoverageSummary } from './coverage';
import type { DrawingUnderstandingPackage } from './types';

/** what the register row needs to describe a split without loading it */
export interface SectionsIndex {
  documentId: string;
  sourceDrawing: string;
  sourceDrawingHash: string;
  createdAt: number;
  model: string;
  source: 'model' | 'local';
  summary: string;
  sections: {
    sectionId: string;
    label: string;
    kind: string;
    entityCount: number;
    confidence: number;
    hasImage: boolean;
    bounds: DrawingUnderstandingPackage['sections'][number]['bounds'];
  }[];
  unresolved: string[];
  /** small — counts and a handful of sample handles per layer, not the drawing itself */
  coverage: CoverageSummary;
}

export function sectionsIndex(pkg: DrawingUnderstandingPackage): SectionsIndex {
  return {
    documentId: pkg.documentId,
    sourceDrawing: pkg.sourceDrawing,
    sourceDrawingHash: pkg.sourceDrawingHash,
    createdAt: pkg.createdAt,
    model: pkg.model,
    source: pkg.source,
    summary: pkg.summary,
    sections: pkg.sections.map((s) => ({
      sectionId: s.sectionId,
      label: s.label,
      kind: s.kind,
      entityCount: s.entityCount,
      confidence: s.confidence,
      hasImage: Boolean(s.png),
      bounds: s.bounds,
    })),
    unresolved: pkg.unresolved,
    coverage: pkg.coverage,
  };
}

export function readSectionsIndex(artifact: ProjectArtifact): SectionsIndex | null {
  if (artifact.kind !== 'sections') return null;
  try {
    const parsed = JSON.parse(artifact.content) as SectionsIndex;
    return Array.isArray(parsed?.sections) ? parsed : null;
  } catch {
    // a corrupt index must not take the whole folder down with it
    return null;
  }
}

export interface FileSectionsInput {
  projectId: string;
  pkg: DrawingUnderstandingPackage;
  /** register identity, when the drawing is in the register */
  drawingName?: string;
  drawingNumber?: string;
  revision?: string;
}

/**
 * File a split against its drawing.
 *
 * Versioned like every other artifact, so splitting the same sheet twice
 * leaves both in the register with v1 and v2 rather than one silently
 * replacing the other — the register's whole job is that nothing derived from
 * a drawing disappears without trace.
 */
export function fileSections(input: FileSectionsInput): Promise<ProjectArtifact> {
  const { pkg } = input;
  return saveProjectArtifact({
    projectId: input.projectId,
    documentId: pkg.documentId,
    kind: 'sections',
    drawingName: input.drawingName ?? pkg.sourceDrawing,
    drawingNumber: input.drawingNumber ?? '',
    revision: input.revision ?? '',
    mimeType: 'application/json',
    content: JSON.stringify(sectionsIndex(pkg), null, 2),
  });
}
