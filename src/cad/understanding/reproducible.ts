// ============================================================
// Guard 4 — reproducibility.
//
// For EVERY saved section, re-select entities from its stored bounds and check
// that they reproduce exactly the entity list it recorded. A section that
// cannot be regenerated from its own metadata is corrupt regardless of how it
// looks — the PNG, the DXF and the bounds are written from one box variable,
// so a mismatch means something moved after that box was fixed.
//
// This runs on pure geometry, after the model has finished, and the model is
// never asked whether it did well. Like the other guards it RECORDS rather
// than repairs: rewriting the recorded entity list to match the re-selection
// would destroy exactly the evidence being checked, and a section quietly
// "fixed" is a section nobody knows to distrust.
//
// Not every difference is corruption. A section written with `skipPng` or one
// whose DXF dropped an entity it could not clip faithfully already says so in
// its own limitations; what this guard catches is the silent case — bounds and
// entity list that no longer describe each other.
// ============================================================
import type { CadDocument } from '../types';
import { entitiesInBounds } from './bounds';
import type { DrawingSection, SectionLimitation } from './types';

/** One section that did not reproduce from its own bounds. */
export interface ReproducibilityFinding {
  sectionId: string;
  /** recorded on the section, but not re-selected from its bounds */
  missing: string[];
  /** re-selected from its bounds, but never recorded */
  extra: string[];
}

function difference(a: readonly string[], b: readonly string[]): string[] {
  const inB = new Set(b);
  return a.filter((h) => !inB.has(h)).sort();
}

/**
 * Check one section against its own stored bounds.
 *
 * Returns null when it reproduces. `entityCount` is deliberately NOT compared:
 * a hatch can be written as several boundary polylines, so the count and the
 * handle list answer different questions. The handle list is the identity.
 */
export function checkSectionReproducible(
  doc: CadDocument,
  section: DrawingSection,
): ReproducibilityFinding | null {
  const recut = entitiesInBounds(doc, section.bounds);
  const missing = difference(section.entityIds, recut.handles);
  const extra = difference(recut.handles, section.entityIds);
  if (!missing.length && !extra.length) return null;
  return { sectionId: section.sectionId, missing, extra };
}

/** Every section that did not reproduce, in package order. */
export function checkReproducible(
  doc: CadDocument,
  sections: readonly DrawingSection[],
): ReproducibilityFinding[] {
  const out: ReproducibilityFinding[] = [];
  for (const s of sections) {
    const finding = checkSectionReproducible(doc, s);
    if (finding) out.push(finding);
  }
  return out;
}

/** The finding as the limitation carried on the section itself. */
export function reproducibilityLimitation(f: ReproducibilityFinding): SectionLimitation {
  const parts: string[] = [];
  if (f.missing.length) {
    parts.push(
      `${f.missing.length} recorded entit${f.missing.length === 1 ? 'y is' : 'ies are'} not inside ` +
        `its own bounds (${f.missing.slice(0, 4).join(', ')}${f.missing.length > 4 ? ', …' : ''})`,
    );
  }
  if (f.extra.length) {
    parts.push(
      `${f.extra.length} entit${f.extra.length === 1 ? 'y' : 'ies'} inside its bounds ` +
        `${f.extra.length === 1 ? 'was' : 'were'} never recorded ` +
        `(${f.extra.slice(0, 4).join(', ')}${f.extra.length > 4 ? ', …' : ''})`,
    );
  }
  return {
    code: 'not-reproducible',
    message:
      `this section does not regenerate from its own bounds — ${parts.join('; ')}. ` +
      'The saved geometry and the saved box no longer describe each other.',
    count: f.missing.length + f.extra.length,
  };
}

/** The line the package carries in `unresolved`, so a reader sees it too. */
export function reproducibilityNote(f: ReproducibilityFinding): string {
  return (
    `${f.sectionId} does not reproduce from its own bounds ` +
    `(${f.missing.length} recorded entities outside the box, ${f.extra.length} inside it unrecorded) ` +
    '— the section is kept, and should not be trusted as a faithful cut until that is explained.'
  );
}
