// Splitting a drawing without asking anyone.
//
// The rule that matters is the one about annotations: they are attached AFTER
// the regions exist, and one that reaches two regions is SHARED rather than a
// reason to merge them. Let a dimension into the connectivity graph and the
// whole sheet becomes one region, because every part of a drawing is
// transitively connected through something that points at it.

import { describe, expect, it } from 'vitest';
import {
  deterministicSplitDrawing,
  gapBetween,
  type DeterministicEntity,
} from '../../src/cad/understanding/deterministic';

let seq = 0;
const box = (
  kind: DeterministicEntity['kind'],
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number,
  anchor?: { x: number; y: number },
): DeterministicEntity => {
  seq += 1;
  return {
    id: `${kind[0]}${seq}`,
    kind,
    points: [
      { x: xMin, y: yMin },
      { x: xMax, y: yMax },
    ],
    ...(anchor ? { anchor } : {}),
  };
};

/** Two footings, 500 mm apart — separate structures on one sheet. */
function twoFootings(): DeterministicEntity[] {
  return [
    box('structural', 0, 0, 100, 100),
    box('structural', 100, 0, 200, 100), // touching the first
    box('structural', 700, 0, 800, 100),
    box('structural', 800, 0, 900, 100), // touching the third
  ];
}

describe('regions come from connected structural geometry', () => {
  it('joins geometry that touches and separates geometry that does not', () => {
    const r = deterministicSplitDrawing(twoFootings());
    expect(r.regions).toHaveLength(2);
    expect(r.regions[0].entityIds).toHaveLength(2);
    expect(r.regions[1].entityIds).toHaveLength(2);
    expect(r.regions[0].geometryBounds).toEqual({ xMin: 0, yMin: 0, xMax: 200, yMax: 100 });
    expect(r.regions[1].geometryBounds).toEqual({ xMin: 700, yMin: 0, xMax: 900, yMax: 100 });
  });

  it('numbers regions the same way every run, from the same drawing', () => {
    const a = deterministicSplitDrawing(twoFootings());
    const b = deterministicSplitDrawing([...twoFootings()].reverse());
    expect(b.regions.map((x) => x.geometryBounds)).toEqual(a.regions.map((x) => x.geometryBounds));
    expect(b.regions.map((x) => x.id)).toEqual(['REGION-01', 'REGION-02']);
  });

  it('respects the connectivity tolerance', () => {
    const apart = [box('structural', 0, 0, 100, 100), box('structural', 110, 0, 200, 100)];
    expect(deterministicSplitDrawing(apart).regions).toHaveLength(2);
    expect(deterministicSplitDrawing(apart, { connectivityTolerance: 20 }).regions).toHaveLength(1);
  });
});

describe('annotations attach to regions — they never merge them', () => {
  it('THE POINT: a dimension spanning two regions leaves them two', () => {
    const parts = [
      ...twoFootings(),
      // a dimension line running from the first footing to the second
      box('dimension', 150, 40, 750, 60),
    ];
    const r = deterministicSplitDrawing(parts, { annotationDistance: 50 });
    expect(r.regions).toHaveLength(2); // NOT one
    expect(r.sharedAnnotations).toHaveLength(1);
    expect(r.sharedAnnotations[0].owners).toEqual(['REGION-01', 'REGION-02']);
    // and both regions know about it
    expect(r.regions[0].sharedAnnotationIds).toEqual(r.sharedAnnotations.map((s) => s.entityId));
    expect(r.regions[1].sharedAnnotationIds).toEqual(r.sharedAnnotations.map((s) => s.entityId));
  });

  it('a note beside one region belongs to that region alone', () => {
    const parts = [...twoFootings(), box('text', 210, 40, 260, 60)];
    const r = deterministicSplitDrawing(parts, { annotationDistance: 50 });
    expect(r.regions[0].annotationIds).toHaveLength(1);
    expect(r.regions[1].annotationIds).toHaveLength(0);
    expect(r.sharedAnnotations).toHaveLength(0);
  });

  it('grows displayBounds to cover an attached annotation, never geometryBounds', () => {
    const parts = [...twoFootings(), box('text', 210, 40, 260, 60)];
    const r = deterministicSplitDrawing(parts, { annotationDistance: 50 });
    expect(r.regions[0].geometryBounds.xMax).toBe(200); // untouched
    expect(r.regions[0].displayBounds.xMax).toBe(260); // includes the note
  });

  it('an anchor reaches a region the annotation is nowhere near', () => {
    // A leader drawn out in clear space, pointing back INTO the first footing.
    // Its box is 200 mm away, so distance alone would orphan it; the anchor is
    // what says where it belongs. (The anchor only ever ADDS a region — it is
    // an extra way in, not a filter, so a leader can still be shared.)
    const parts = [
      ...twoFootings(),
      box('leader', 400, 40, 500, 60, { x: 100, y: 50 }),
    ];
    const r = deterministicSplitDrawing(parts, { annotationDistance: 10 });
    expect(r.regions[0].annotationIds).toHaveLength(1);
    expect(r.orphans).toHaveLength(0);

    // without the anchor the very same box is an orphan
    const noAnchor = [...twoFootings(), box('leader', 400, 40, 500, 60)];
    expect(deterministicSplitDrawing(noAnchor, { annotationDistance: 10 }).orphans).toHaveLength(1);
  });

  it('an annotation far from everything is an orphan, with a reason', () => {
    const parts = [...twoFootings(), box('text', 9000, 9000, 9100, 9100)];
    const r = deterministicSplitDrawing(parts, { annotationDistance: 50 });
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0].reason).toMatch(/too far from every region/);
  });
});

describe('the coverage audit accounts for every entity', () => {
  it('counts what was assigned and what was not', () => {
    const parts = [
      ...twoFootings(),
      box('text', 210, 40, 260, 60), // attaches
      box('text', 9000, 9000, 9100, 9100), // orphan
      box('other', 5, 5, 6, 6), // never assignable
    ];
    const r = deterministicSplitDrawing(parts, { annotationDistance: 50 });
    expect(r.coverage.totalEntities).toBe(7);
    expect(r.coverage.structuralEntities).toBe(4);
    expect(r.coverage.annotationEntities).toBe(2);
    expect(r.coverage.orphanEntities).toBe(2); // the far text and the 'other'
    expect(r.coverage.assignedEntities).toBe(5);
    expect(r.coverage.coveragePercent).toBeCloseTo((5 / 7) * 100, 6);
    // an 'other' is named for what it is, not lumped in with the annotations
    expect(r.orphans.map((o) => o.reason)).toContain(
      'entity type is not structural or a recognised annotation',
    );
  });

  it('a shared annotation is counted once, not once per owner', () => {
    const parts = [...twoFootings(), box('dimension', 150, 40, 750, 60)];
    const r = deterministicSplitDrawing(parts, { annotationDistance: 50 });
    expect(r.coverage.sharedAnnotations).toBe(1);
    expect(r.coverage.assignedEntities).toBe(5);
    expect(r.coverage.coveragePercent).toBe(100);
  });

  it('an empty drawing is 100% covered, not 0/0', () => {
    expect(deterministicSplitDrawing([]).coverage.coveragePercent).toBe(100);
  });
});

describe('it finishes on a real sheet', () => {
  // Comparing every pair is n²: 4.5M comparisons at 3,000 entities, 2.4
  // BILLION at 69,000 — and this codebase states it renders sheets of 69k.
  // The grid keeps it near-linear; this test fails by TIMING OUT if the
  // quadratic ever comes back.
  it('splits 20,000 entities without hanging', () => {
    const many: DeterministicEntity[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const x = (i % 200) * 500;
      const y = Math.floor(i / 200) * 500;
      many.push(box('structural', x, y, x + 50, y + 50));
    }
    const started = Date.now();
    const r = deterministicSplitDrawing(many);
    // every one is 450 mm from its neighbour, so each is its own region
    expect(r.regions).toHaveLength(20_000);
    expect(r.coverage.coveragePercent).toBe(100);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

describe('gapBetween', () => {
  it('is zero for touching boxes and edge-to-edge otherwise', () => {
    const a = { xMin: 0, yMin: 0, xMax: 10, yMax: 10 };
    expect(gapBetween(a, { xMin: 10, yMin: 0, xMax: 20, yMax: 10 })).toBe(0);
    expect(gapBetween(a, { xMin: 5, yMin: 5, xMax: 15, yMax: 15 })).toBe(0);
    expect(gapBetween(a, { xMin: 13, yMin: 14, xMax: 20, yMax: 20 })).toBe(5); // 3-4-5
  });
});

describe('displayBounds is what gets drawn, so it has to mean something', () => {
  // A shared annotation SPANS the gap between the regions sharing it — that is
  // what made it shared. Expanding every owner by its box therefore stretches
  // every owner across that gap. Measured on the GAMCO sheet, 130 shared
  // annotations turned all nine regions into the same 47,328 x 41,683 mm box:
  // the whole drawing, nine times, as nine identical highlight rectangles.
  it('a shared annotation is recorded on both owners but enlarges neither', () => {
    const parts = [...twoFootings(), box('dimension', 150, 40, 750, 60)];
    const r = deterministicSplitDrawing(parts, { annotationDistance: 50 });

    expect(r.sharedAnnotations).toHaveLength(1);
    // both know about it — that record is what keeps them from merging
    expect(r.regions[0].sharedAnnotationIds).toHaveLength(1);
    expect(r.regions[1].sharedAnnotationIds).toHaveLength(1);
    // …and neither has grown across the 500 mm gap to swallow the other
    expect(r.regions[0].displayBounds).toEqual({ xMin: 0, yMin: 0, xMax: 200, yMax: 100 });
    expect(r.regions[1].displayBounds).toEqual({ xMin: 700, yMin: 0, xMax: 900, yMax: 100 });
  });

  it('an annotation belonging to ONE region does enlarge it', () => {
    const parts = [...twoFootings(), box('text', 210, 40, 260, 60)];
    const r = deterministicSplitDrawing(parts, { annotationDistance: 50 });
    expect(r.regions[0].displayBounds.xMax).toBe(260);
    // and the other region is untouched by it
    expect(r.regions[1].displayBounds).toEqual({ xMin: 700, yMin: 0, xMax: 900, yMax: 100 });
  });

  it('regions stay distinguishable — highlights must not all be the sheet', () => {
    const parts = [
      ...twoFootings(),
      box('dimension', 150, 40, 750, 60),
      box('dimension', 150, 20, 750, 30),
      box('dimension', 150, 70, 750, 80),
    ];
    const r = deterministicSplitDrawing(parts, { annotationDistance: 50 });
    const boxes = r.regions.map((g) => JSON.stringify(g.displayBounds));
    expect(new Set(boxes).size).toBe(r.regions.length);
  });
});
