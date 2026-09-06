// Guard 4 — reproducibility (SPLITTER_PROMPT.md Part 3).
//
//   "For every saved section, assert that re-selecting entities from its
//    stored bounds reproduces exactly the entity list it recorded. A section
//    that cannot be regenerated from its own metadata is corrupt regardless of
//    how it looks."
//
// This existed as a single assertion inside one gap test, which proved the
// exporter reproduces in one scenario — not that the guard runs. The guard is
// the point: PNG, DXF and bounds are written from ONE box variable, so a
// section that no longer regenerates means something moved after that box was
// fixed, and the package must say so rather than look fine.
//
// Like the other guards it is pure geometry, runs after the model is finished,
// and RECORDS rather than repairs.
import { describe, expect, it } from 'vitest';
import { entitiesInBounds } from '../../src/cad/understanding/bounds';
import { exportSection } from '../../src/cad/understanding/section';
import {
  checkReproducible,
  checkSectionReproducible,
  reproducibilityLimitation,
  reproducibilityNote,
} from '../../src/cad/understanding/reproducible';
import type { DrawingSection } from '../../src/cad/understanding/types';
import { threeAreaDoc } from '../helpers/cadDoc';

const doc = threeAreaDoc();
const WHOLE = { xMin: -1e7, yMin: -1e7, xMax: 1e7, yMax: 1e7 };

async function sectionOver(
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number },
  sectionId = 'REGION-01',
): Promise<DrawingSection> {
  return exportSection(
    doc,
    bounds,
    { sectionId, label: 'A region', kind: 'detail', sourceDrawingHash: 'h', orchestratorStep: 1, confidence: 1 },
    { skipPng: true },
  );
}

describe('Guard 4 — every saved section regenerates from its own bounds', () => {
  it('passes a section the exporter actually wrote', async () => {
    const section = await sectionOver(WHOLE);
    expect(section.entityIds.length).toBeGreaterThan(0);
    expect(checkSectionReproducible(doc, section)).toBeNull();
  });

  it('checks EVERY section, not just the first', async () => {
    // The guard's whole value is that it sweeps the package. A per-section
    // spot check would pass a package whose second cut is corrupt.
    const good = await sectionOver(WHOLE, 'REGION-01');
    const alsoGood = await sectionOver(WHOLE, 'REGION-02');
    const corrupt: DrawingSection = {
      ...(await sectionOver(WHOLE, 'REGION-03')),
      entityIds: ['NOT-ON-THIS-SHEET'],
    };
    const findings = checkReproducible(doc, [good, alsoGood, corrupt]);
    expect(findings.map((f) => f.sectionId)).toEqual(['REGION-03']);
  });

  it('names what is recorded but outside the box, and what is inside but unrecorded', async () => {
    const section = await sectionOver(WHOLE);
    const real = section.entityIds[0];
    const corrupt: DrawingSection = { ...section, entityIds: ['GHOST'] };
    const [finding] = checkReproducible(doc, [corrupt]);
    expect(finding.missing).toContain('GHOST'); // recorded, not in the bounds
    expect(finding.extra).toContain(real); // in the bounds, never recorded
  });

  it('records rather than repairs — the corrupt entity list is left alone', async () => {
    // A guard that rewrote the list to match would destroy the evidence it
    // exists to check, and the section would then look faithful.
    const section = await sectionOver(WHOLE);
    const corrupt: DrawingSection = { ...section, entityIds: ['GHOST'] };
    checkReproducible(doc, [corrupt]);
    expect(corrupt.entityIds).toEqual(['GHOST']);
  });

  it('states the failure on the section and in the package, in words', async () => {
    const section = await sectionOver(WHOLE);
    const [finding] = checkReproducible(doc, [{ ...section, entityIds: ['GHOST'] }]);
    const limitation = reproducibilityLimitation(finding);
    expect(limitation.code).toBe('not-reproducible');
    expect(limitation.count).toBeGreaterThan(0);
    expect(limitation.message).toMatch(/does not regenerate from its own bounds/);
    expect(reproducibilityNote(finding)).toContain('REGION-01');
    // it must not read as a clean cut that merely carries a note
    expect(reproducibilityNote(finding)).toMatch(/should not be trusted/);
  });

  it('does not fail a hatched section for counting differently from its handles', async () => {
    // entityCount and entityIds answer different questions — a hatch can be
    // written as several boundary polylines. The handle list is the identity,
    // and comparing counts here would fire on every hatched section.
    const section = await sectionOver(WHOLE);
    const hatched: DrawingSection = { ...section, entityCount: section.entityIds.length + 5 };
    expect(checkSectionReproducible(doc, hatched)).toBeNull();
  });

  it('an empty section with no geometry is not a reproducibility failure', async () => {
    const empty: DrawingSection = {
      ...(await sectionOver(WHOLE)),
      bounds: { xMin: 9e6, yMin: 9e6, xMax: 9.1e6, yMax: 9.1e6 },
      entityIds: [],
    };
    expect(entitiesInBounds(doc, empty.bounds).handles).toEqual([]);
    expect(checkSectionReproducible(doc, empty)).toBeNull();
  });
});
