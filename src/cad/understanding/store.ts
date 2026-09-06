// ============================================================
// Where a section package lives.
//
// Packages are persisted, not held in memory: §13 and §15 both turn on the
// same promise — SPLIT ONCE, SAVE, USE MANY TIMES. A package that evaporated
// with the tab would make every consumer re-split, which is the cost this
// whole feature exists to remove.
//
// Storage is the project's existing IndexedDB repository (`cad/store.ts`),
// one array per project keyed by project id, exactly like project artifacts.
// No second storage system: §13 asks for that explicitly, and a package full
// of DXF text is far past what localStorage could hold anyway.
//
// The logical layout the spec describes —
//
//     drawing/sections/REGION-01/{section.dxf,section.png,metadata.json}
//
// — is what `sectionFileTree` renders on demand for export or inspection. The
// browser has no directory to write into; the shape is preserved in the paths
// so a desktop or server build can lay it down verbatim.
// ============================================================
import type { CadDocument } from '../types';
import * as repo from '../store';
import * as remoteSections from '../../data/sections';
import { isSupabaseConfigured } from '../../lib/supabase';
import { drawingHash } from './hash';
import type { DrawingUnderstandingPackage, PackageStatus } from './types';

/**
 * THE PACKAGE WITHOUT ITS SECTIONS.
 *
 * What goes in `drawings.split_manifest`: everything a reader needs to judge
 * the split — the summary, the coverage, the relationships, what the model
 * asked for, what it could not account for, the second pass — and none of the
 * section bodies, which are objects in the bucket and would be megabytes here.
 */
function manifestOf(pkg: DrawingUnderstandingPackage): Record<string, unknown> {
  const { sections: _sections, ...rest } = pkg;
  return rest as Record<string, unknown>;
}

/** Packages held for one project, newest first. */
export async function loadPackages(projectId: string): Promise<DrawingUnderstandingPackage[]> {
  const saved = await repo
    .getUnderstandingPackages<DrawingUnderstandingPackage>(projectId)
    .catch(() => null);
  return saved ?? [];
}

/**
 * The package for a document, from the database, when this browser has none.
 *
 * IndexedDB is a CACHE of what the database holds, and a cache miss is the
 * ordinary state of a second machine — not a reason to offer to re-split a
 * sheet that has already been read at the cost of a model call. Reassembled
 * here and written straight back to the cache, so the next open is local
 * again.
 *
 * Returns null when the database has no split for this drawing either, which
 * is the honest answer and the one that does mean "split it".
 */
export async function restorePackage(
  projectId: string,
  documentId: string,
): Promise<DrawingUnderstandingPackage | null> {
  if (!isSupabaseConfigured()) return null;
  let split: Awaited<ReturnType<typeof remoteSections.loadRemoteSplit>>;
  try {
    split = await remoteSections.loadRemoteSplit(projectId, documentId);
  } catch (err) {
    console.warn('[sections] the split could not be read back:', err);
    return null;
  }
  if (!split) return null;

  // A package needs a `sourceDrawingHash` — it is what `stalenessOf` compares
  // and therefore what decides whether this split may be trusted at all. The
  // manifest carries it; when there is no manifest (a database still on
  // migration 0002) the section rows carry the same hash, because that is what
  // they were cut from. Falling back to them is what lets the split come back
  // at all rather than looking like a drawing nobody has read.
  const fromRows = split.sections[0]?.drawing_hash ?? '';
  const manifest = (split.manifest ?? {
    version: 1,
    projectId,
    documentId,
    sourceDrawing: '',
    sourceDrawingHash: fromRows,
    createdAt: Date.now(),
    sheetExtents: null,
    requests: [],
    relationships: [],
    unresolved: [],
    coverage: { measurableEntities: 0, coveredEntities: 0, uncoveredEntities: 0, gaps: [] },
    summary: '',
    model: '',
    source: 'model',
  }) as Omit<DrawingUnderstandingPackage, 'sections'>;
  const pkg: DrawingUnderstandingPackage = {
    ...manifest,
    projectId,
    documentId,
    sourceDrawingHash: manifest.sourceDrawingHash || fromRows,
    sections: split.sections.map(
      (row) =>
        ({
          sectionId: row.section_key,
          label: row.label ?? '',
          kind: row.kind ?? 'unknown',
          sourceDrawing: manifest.sourceDrawing,
          sourceDrawingHash: row.drawing_hash ?? manifest.sourceDrawingHash,
          bounds: row.bounds,
          png: row.png,
          dxf: row.dxf,
          // Handles, hints and limitations are the ORCHESTRATOR's working
          // notes on a section, not part of what the section is. They are not
          // columns, so a restored package says it has none rather than
          // inventing them — every consumer treats them as optional evidence.
          entityIds: [],
          evidenceIds: [],
          memberHints: [],
          calloutHints: Array.isArray(row.callouts) ? row.callouts : [],
          orchestratorStep: 0,
          confidence: 1,
          entityCount: row.entity_count ?? 0,
          limitations: [],
        }) as unknown as DrawingUnderstandingPackage['sections'][number],
    ),
  };

  const existing = await loadPackages(projectId);
  await repo
    .putUnderstandingPackages(projectId, [pkg, ...existing.filter((p) => p.documentId !== documentId)])
    .catch(() => {
      /* the cache is best effort — the package is already usable in memory */
    });
  return pkg;
}

/**
 * Save a package, replacing any earlier one for the same document.
 *
 * Replacing rather than appending is deliberate: a document has one current
 * decomposition. Keeping every past split would grow without bound and give
 * consumers a choice they have no basis to make.
 */
export async function savePackage(pkg: DrawingUnderstandingPackage): Promise<void> {
  const existing = await loadPackages(pkg.projectId);
  const next = [pkg, ...existing.filter((p) => p.documentId !== pkg.documentId)];
  await repo.putUnderstandingPackages(pkg.projectId, next);

  // AND THE SAME SPLIT, IN THE DATABASE.
  //
  // An index row per section, and each section's DXF and PNG in the private
  // bucket beside the sheet they were cut from. Both halves have to go: the
  // row is what `data_facts.section_id` references — with the table empty,
  // every fact in the project recorded a null for the one column that says
  // which part of the sheet it was read from — and the bodies are what make
  // the split mean anything on a machine that did not perform it.
  //
  // Not fatal. A split that produced a usable package must not be reported as
  // a failure because the database could not be reached; the next split files
  // it.
  if (isSupabaseConfigured()) {
    try {
      await remoteSections.syncDrawingSections(
        pkg.projectId,
        pkg.documentId,
        pkg.sections.map((section) => ({
          sectionId: section.sectionId,
          label: section.label,
          kind: section.kind,
          bounds: section.bounds,
          entityCount: section.entityCount,
          calloutHints: section.calloutHints,
          sourceDrawingHash: section.sourceDrawingHash,
          dxf: section.dxf,
          png: section.png,
        })),
        manifestOf(pkg),
      );
    } catch (err) {
      console.warn('[sections] the split is not filed in the database:', err);
    }
  }
}

export async function deletePackage(projectId: string, documentId: string): Promise<void> {
  const existing = await loadPackages(projectId);
  await repo.putUnderstandingPackages(
    projectId,
    existing.filter((p) => p.documentId !== documentId),
  );
  if (isSupabaseConfigured()) {
    try {
      await remoteSections.deleteDrawingSections(documentId);
    } catch (err) {
      console.warn('[sections] the section index is still in the database:', err);
    }
  }
}

/**
 * The package for this document, with the verdict on whether it still
 * describes it.
 *
 * §16: a package built from an older revision must never be used silently.
 * The caller gets both the package and the reason it cannot be trusted, so it
 * can say so rather than quietly producing a confident answer about a sheet
 * nobody is building from.
 */
export async function packageFor(
  projectId: string,
  doc: CadDocument,
  sourceBytes?: ArrayBuffer | Uint8Array | null,
): Promise<PackageStatus | null> {
  const packages = await loadPackages(projectId);
  // A miss in the cache is not an answer — ask the database before concluding
  // this sheet has never been split.
  const hit = packages.find((p) => p.documentId === doc.id) ?? (await restorePackage(projectId, doc.id));
  if (!hit) return null;
  return stalenessOf(hit, await drawingHash(doc, sourceBytes ?? null));
}

/**
 * The staleness verdict itself — pure, so the rule that decides whether a
 * package may be trusted can be tested without a database standing in the way.
 */
export function stalenessOf(pkg: DrawingUnderstandingPackage, currentHash: string): PackageStatus {
  if (currentHash === pkg.sourceDrawingHash) return { package: pkg, stale: false };

  // A structural fingerprint and a byte hash are not comparable — a package
  // saved with one and checked with the other would look stale every time.
  // Say that plainly instead of crying wolf.
  const kindMismatch = currentHash.startsWith('doc:') !== pkg.sourceDrawingHash.startsWith('doc:');
  return {
    package: pkg,
    stale: true,
    reason: kindMismatch
      ? 'These drawing sections were saved with a different kind of source fingerprint, so they cannot be verified against this drawing. Split it again to be sure.'
      : 'Drawing sections are based on an older version of this drawing.',
  };
}

/** A package that is present AND current, or null. Never returns a stale one. */
export async function currentPackageFor(
  projectId: string,
  doc: CadDocument,
  sourceBytes?: ArrayBuffer | Uint8Array | null,
): Promise<DrawingUnderstandingPackage | null> {
  const status = await packageFor(projectId, doc, sourceBytes);
  return status && !status.stale ? status.package : null;
}

// ------------------------------------------------------------
// the on-disk shape, for export and inspection
// ------------------------------------------------------------

export interface PackageFile {
  path: string;
  /** text files carry `text`; the PNG carries its data URL in `dataUrl` */
  text?: string;
  dataUrl?: string;
}

/**
 * The package as the directory layout §13 describes.
 *
 * Every section contributes its three files; the package contributes
 * `drawing-understanding.json`, which carries everything EXCEPT the section
 * bodies — those are already on disk beside it, and duplicating a megabyte of
 * DXF into the index helps nobody.
 */
export function sectionFileTree(pkg: DrawingUnderstandingPackage): PackageFile[] {
  const files: PackageFile[] = [];
  for (const s of pkg.sections) {
    const dir = `sections/${s.sectionId}`;
    files.push({ path: `${dir}/section.dxf`, text: s.dxf });
    if (s.png) files.push({ path: `${dir}/section.png`, dataUrl: s.png });
    const { dxf: _dxf, png: _png, ...metadata } = s;
    files.push({
      path: `${dir}/metadata.json`,
      text: JSON.stringify(
        { ...metadata, png: s.png ? 'section.png' : null, dxf: 'section.dxf' },
        null,
        2,
      ),
    });
  }
  files.push({
    path: 'drawing-understanding.json',
    text: JSON.stringify(
      {
        ...pkg,
        sections: pkg.sections.map((s) => ({
          sectionId: s.sectionId,
          label: s.label,
          kind: s.kind,
          bounds: s.bounds,
          entityCount: s.entityCount,
          confidence: s.confidence,
          png: s.png ? `sections/${s.sectionId}/section.png` : null,
          dxf: `sections/${s.sectionId}/section.dxf`,
        })),
      },
      null,
      2,
    ),
  });
  return files;
}
