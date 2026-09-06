// WHERE the read did not reach — and what each unread part is joined to.
//
// `coverage.ts` already answers "how much is in no section", grouped BY LAYER.
// That is the right shape for an audit line and the wrong shape for a person
// looking at a drawing: a layer's uncovered entities can be scattered across
// the whole sheet, so their union is a box CONTAINING the gap rather than the
// gap, and six sample handles are not a location.
//
// The question these tests pin is the one that decides what to do about a gap:
// is it joined to something that was read (a section cut short) or is it on
// its own (a part of the drawing nobody looked at)? Geometry answers that
// exactly, with no model, no key and no second read.

import { describe, expect, it } from 'vitest';
import { boundsDistance, findGapClusters } from '../../src/cad/understanding/gaps';
import type { CadDocument, CadEntity } from '../../src/cad/types';

const style = (layer: string, handle: string) => ({
  layer,
  color: { kind: 'aci' as const, index: 7 },
  lineweight: -1,
  linetype: '',
  linetypeScale: 1,
  transparency: -1,
  normal: null,
  handle,
});

let seq = 0;
function line(x1: number, y1: number, x2: number, y2: number, layer = 'CONC'): CadEntity {
  seq += 1;
  return {
    type: 'line',
    a: { x: x1, y: y1 },
    b: { x: x2, y: y2 },
    style: style(layer, 'h' + seq),
  } as CadEntity;
}

function text(x: number, y: number, body: string, layer = 'TEXT'): CadEntity {
  seq += 1;
  return {
    type: 'text',
    position: { x, y },
    text: body,
    height: 20,
    rotation: 0,
    hAlign: 'left',
    vAlign: 'baseline',
    widthFactor: 1,
    oblique: 0,
    styleName: 'STANDARD',
    wrapWidth: 0,
    style: style(layer, 'h' + seq),
  } as CadEntity;
}

function doc(entities: CadEntity[]): CadDocument {
  return {
    id: 'doc',
    name: 'test',
    sourceFile: 'test.dxf',
    unitScale: 1,
    layers: new Map(),
    linetypes: new Map(),
    textStyles: new Map(),
    blocks: new Map(),
    entities,
    layouts: [],
    regions: [],
    diagnostics: [],
  } as unknown as CadDocument;
}

const SHEET = { xMin: 0, yMin: 0, xMax: 10_000, yMax: 10_000 };
/** One read section, occupying the bottom-left quarter of the sheet. */
const READ = [{ sectionId: 'REGION-01', bounds: { xMin: 0, yMin: 0, xMax: 5_000, yMax: 5_000 } }];

describe('the unread parts of a drawing, as places', () => {
  it('finds nothing when every entity is inside a section', () => {
    const d = doc([line(100, 100, 200, 200), line(300, 300, 400, 400)]);
    expect(findGapClusters(d, READ, SHEET)).toEqual([]);
  });

  it('clusters loose entities that sit together into one place', () => {
    const d = doc([
      line(8_000, 8_000, 8_100, 8_100),
      line(8_100, 8_100, 8_200, 8_150),
      line(8_200, 8_150, 8_300, 8_200),
    ]);
    const gaps = findGapClusters(d, READ, SHEET);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].id).toBe('GAP-01');
    expect(gaps[0].entityCount).toBe(3);
    // The box is the union of the three, not one of them.
    expect(gaps[0].bounds).toEqual({ xMin: 8_000, yMin: 8_000, xMax: 8_300, yMax: 8_200 });
  });

  it('keeps two far-apart places apart, largest first', () => {
    const d = doc([
      line(9_000, 9_000, 9_100, 9_100),
      line(9_100, 9_100, 9_200, 9_200),
      line(9_200, 9_200, 9_300, 9_300),
      line(9_000, 200, 9_050, 250),
    ]);
    const gaps = findGapClusters(d, READ, SHEET);
    expect(gaps).toHaveLength(2);
    expect(gaps.map((g) => g.entityCount)).toEqual([3, 1]);
    expect(gaps.map((g) => g.id)).toEqual(['GAP-01', 'GAP-02']);
  });

  // ---- the verdict geometry CAN give ------------------------------------

  it('a strip running off the edge of a section reports as JOINED to it', () => {
    // A row of footings 40 mm past REGION-01's top edge (y = 5,000): that
    // section was cut short, which is a different problem from an element
    // nobody looked at. Well inside the join distance, which is 1.5% of the
    // sheet diagonal — 212 mm here.
    const d = doc([line(1_000, 5_040, 2_000, 5_040), line(2_000, 5_040, 3_000, 5_040)]);
    const [gap] = findGapClusters(d, READ, SHEET);
    expect(gap.touches).toEqual(['REGION-01']);
    expect(gap.nearest).toBeNull();
  });

  it('a detail on its own reports INDEPENDENT, with how far off it is', () => {
    const d = doc([line(9_000, 9_000, 9_200, 9_200)]);
    const [gap] = findGapClusters(d, READ, SHEET);
    expect(gap.touches).toEqual([]);
    // edge to edge from the section's corner at (5,000, 5,000)
    expect(gap.nearest?.sectionId).toBe('REGION-01');
    expect(gap.nearest?.distanceMm).toBeCloseTo(Math.hypot(4_000, 4_000), 6);
  });

  it('names every section a gap reaches, not just the first', () => {
    const two = [
      ...READ,
      { sectionId: 'REGION-02', bounds: { xMin: 0, yMin: 5_400, xMax: 5_000, yMax: 9_000 } },
    ];
    // sits in the strip between the two boxes, reaching both
    const d = doc([line(1_000, 5_100, 2_000, 5_200)]);
    const [gap] = findGapClusters(d, two, SHEET);
    expect(gap.touches).toEqual(['REGION-01', 'REGION-02']);
  });

  // ---- evidence, never a verdict ----------------------------------------

  it('keeps the text inside a gap, verbatim, as evidence for the reader', () => {
    const d = doc([
      line(9_000, 9_000, 9_100, 9_100),
      text(9_000, 9_050, 'T16@150 C/C'),
      text(9_000, 9_070, 'NORTH'),
    ]);
    const [gap] = findGapClusters(d, READ, SHEET);
    // Verbatim and UNCLASSIFIED. Deciding that "T16@150 C/C" is a bar callout
    // is the BBS grammar's job, and this module does not import it — the
    // splitter is its own capability ("never reaches into the BBS engine").
    // The studio layer, which may see both, sorts these afterwards.
    expect(gap.sampleText).toEqual(['T16@150 C/C', 'NORTH']);
    expect(Object.keys(gap)).not.toContain('callouts');
  });

  // (That this file does not import the BBS engine is asserted wholesale, over
  // every file in understanding/, by drawing-splitter.test.ts — "never reaches
  // into the BBS engine". It caught this module doing exactly that on the way
  // in, which is why the text comes out of here unclassified.)

  it('reports the layers it is on, largest first — and no verdict about them', () => {
    const d = doc([
      line(9_000, 9_000, 9_100, 9_100, 'S LINE'),
      line(9_100, 9_100, 9_200, 9_150, 'S LINE'),
      line(9_150, 9_150, 9_200, 9_200, 'Stair'),
    ]);
    const [gap] = findGapClusters(d, READ, SHEET);
    expect(gap.layers).toEqual([
      { layer: 'S LINE', count: 2 },
      { layer: 'Stair', count: 1 },
    ]);
    // There is deliberately no "matters"/"required" field to assert on.
    expect(Object.keys(gap)).not.toContain('bbsRelevant');
  });

  // ---- the arithmetic ----------------------------------------------------

  it('boundsDistance is zero for touching boxes and edge-to-edge otherwise', () => {
    const a = { xMin: 0, yMin: 0, xMax: 10, yMax: 10 };
    expect(boundsDistance(a, { xMin: 10, yMin: 0, xMax: 20, yMax: 10 })).toBe(0);
    expect(boundsDistance(a, { xMin: 5, yMin: 5, xMax: 15, yMax: 15 })).toBe(0);
    expect(boundsDistance(a, { xMin: 13, yMin: 0, xMax: 20, yMax: 10 })).toBe(3);
    expect(boundsDistance(a, { xMin: 13, yMin: 14, xMax: 20, yMax: 20 })).toBe(5); // 3-4-5
  });

  it('clusters the same way whatever order the entities arrive in', () => {
    const parts = [
      line(8_000, 8_000, 8_100, 8_100),
      line(8_100, 8_100, 8_200, 8_150),
      line(9_500, 500, 9_600, 600),
      line(8_200, 8_150, 8_300, 8_200),
    ];
    const forward = findGapClusters(doc(parts), READ, SHEET);
    const backward = findGapClusters(doc([...parts].reverse()), READ, SHEET);
    expect(backward.map((g) => ({ n: g.entityCount, b: g.bounds }))).toEqual(
      forward.map((g) => ({ n: g.entityCount, b: g.bounds })),
    );
  });
});
