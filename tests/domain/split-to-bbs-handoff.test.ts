// The split → reader handover.
//
// A BBS run is supposed to LOAD an existing split rather than re-derive the
// layout. The two sides speak different dialects — the splitter records a box
// as xMin/yMin/xMax/yMax, the reader takes x1/y1/x2/y2 — and both are
// millimetres in sheet space. `packageSectionEvidence` is the only place that
// knows both, so a swap here would crop the wrong rectangle on every tool call
// and read as a bad model rather than a bad adapter. That is what these pin.
import { describe, expect, it } from 'vitest';
import {
  packageRelationships,
  packageSectionEvidence,
} from '../../src/cad/understanding/consume';
import type { DrawingSection, DrawingUnderstandingPackage } from '../../src/cad/understanding/types';

function section(over: Partial<DrawingSection> = {}): DrawingSection {
  return {
    sectionId: 'REGION-01',
    label: 'C/S OF TB-(350X400)',
    kind: 'detail',
    sourceDrawing: 'GW-01',
    sourceDrawingHash: 'h1',
    bounds: { xMin: 100, yMin: 200, xMax: 900, yMax: 700 },
    png: 'data:image/png;base64,AAAA',
    dxf: '0\nSECTION\n',
    entityIds: ['79A47', '79A48'],
    evidenceIds: ['79A47'],
    memberHints: [{ mark: 'TB', basis: 'visible label in region' }],
    calloutHints: ['2-16TOR+2-12TOR'],
    orchestratorStep: 3,
    confidence: 0.82,
    entityCount: 112,
    limitations: [],
    ...over,
  };
}

function pkg(sections: DrawingSection[]): DrawingUnderstandingPackage {
  return {
    version: 1,
    sourceDrawing: 'GW-01',
    sourceDrawingHash: 'h1',
    createdAt: 0,
    sections,
    relationships: [],
    requests: [],
    unresolved: [],
    summary: 'a boundary wall sheet',
  } as unknown as DrawingUnderstandingPackage;
}

describe('a saved split crosses to the reader intact', () => {
  it('translates the box between the two dialects, corner for corner', () => {
    const [ev] = packageSectionEvidence(pkg([section()]));
    expect(ev.bounds).toEqual({ x1: 100, y1: 200, x2: 900, y2: 700 });
  });

  it('does not transpose x and y', () => {
    // The failure this guards against is legible only as a wrong crop: a
    // transposed box is still a valid rectangle, so nothing downstream throws.
    const [ev] = packageSectionEvidence(
      pkg([section({ bounds: { xMin: 1, yMin: 2, xMax: 3, yMax: 4 } })]),
    );
    expect(ev.bounds.x1).toBe(1);
    expect(ev.bounds.y1).toBe(2);
    expect(ev.bounds.x2).toBe(3);
    expect(ev.bounds.y2).toBe(4);
  });

  it('carries the label, kind, counts and the splitter own confidence', () => {
    const [ev] = packageSectionEvidence(pkg([section()]));
    expect(ev.sectionId).toBe('REGION-01');
    expect(ev.label).toBe('C/S OF TB-(350X400)');
    expect(ev.kind).toBe('detail');
    expect(ev.entityCount).toBe(112);
    expect(ev.confidence).toBe(0.82);
  });

  it('keeps a member hint attached to its BASIS', () => {
    // §11: "the label C1 is printed in this region" must never arrive as
    // "these bars belong to C1". The basis is what stops the crossing from
    // promoting a hint into an assignment.
    const [ev] = packageSectionEvidence(pkg([section()]));
    expect(ev.memberHints).toEqual([{ mark: 'TB', basis: 'visible label in region' }]);
  });

  it('omits an empty image rather than serving one, and keeps the box', () => {
    const [ev] = packageSectionEvidence(pkg([section({ png: '' })]));
    expect(ev.png).toBeUndefined();
    // the section is still evidence: its bounds survive, so it can be cropped
    expect(ev.bounds).toEqual({ x1: 100, y1: 200, x2: 900, y2: 700 });
  });

  it('hands over every section, in package order', () => {
    const evs = packageSectionEvidence(
      pkg([section(), section({ sectionId: 'REGION-02', label: 'FOOTING PLAN' })]),
    );
    expect(evs.map((e) => e.sectionId)).toEqual(['REGION-01', 'REGION-02']);
  });

  it('passes relationships across as the splitter reading, basis included', () => {
    const p = pkg([section()]);
    (p as { relationships: unknown[] }).relationships = [
      { from: 'REGION-01', to: 'REGION-02', kind: 'detail-of', basis: 'section mark 1-1' },
    ];
    expect(packageRelationships(p)).toEqual([
      { from: 'REGION-01', to: 'REGION-02', kind: 'detail-of', basis: 'section mark 1-1' },
    ]);
  });

  it('survives a package with no relationships recorded', () => {
    const p = pkg([section()]);
    delete (p as { relationships?: unknown[] }).relationships;
    expect(packageRelationships(p)).toEqual([]);
  });
});
