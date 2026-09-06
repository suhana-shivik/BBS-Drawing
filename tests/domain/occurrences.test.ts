import { describe, expect, it } from 'vitest';
import { buildOccurrenceIndex } from '../../src/cad/occurrences';
// v1: not ported — src/cad/takeoff (quantity side comes later)
import { BY_LAYER, type CadDocument, type CadStyle } from '../../src/cad/types';

const style = (handle: string, layer = '0'): CadStyle => ({
  layer,
  color: BY_LAYER,
  lineweight: -1,
  linetype: '',
  linetypeScale: 1,
  transparency: -1,
  normal: null,
  handle,
});

function fixture(): CadDocument {
  return {
    id: 'doc-1', name: 'fixture', sourceFile: 'fixture.dxf', unitScale: 1,
    layers: new Map(), linetypes: new Map(), textStyles: new Map(),
    blocks: new Map([
      ['CHILD', {
        name: 'CHILD', basePoint: { x: 0, y: 0 },
        entities: [{
          type: 'circle', center: { x: 0, y: 0 }, radius: 10, style: style('child-circle'),
        }],
      }],
      ['PARENT', {
        name: 'PARENT', basePoint: { x: 0, y: 0 },
        entities: [{
          type: 'insert', blockName: 'CHILD', position: { x: 5, y: 0 },
          scale: { x: 1, y: 1 }, rotation: 0, cols: 1, rows: 1,
          colSpacing: 0, rowSpacing: 0, style: style('nested'),
        }],
      }],
    ]),
    entities: [{
      type: 'insert', blockName: 'PARENT', position: { x: 100, y: 200 },
      scale: { x: 1, y: 1 }, rotation: 0, cols: 2, rows: 1,
      colSpacing: 50, rowSpacing: 0, style: style('root', 'POWER'),
    }],
    layouts: [], regions: [], diagnostics: [], extents: null,
  };
}

describe('canonical CAD occurrence index', () => {
  it('separates expanded placements from selectable source inserts', () => {
    const doc = fixture();
    const index = buildOccurrenceIndex(doc);
    const parent = index.blocks.find((b) => b.name === 'PARENT')!;
    const child = index.blocks.find((b) => b.name === 'CHILD')!;

    expect(parent.placementCount).toBe(2);
    expect(child.placementCount).toBe(2);
    expect(parent.sourceEntityCount).toBe(1);
    expect(child.sourceHandles).toEqual(['root']);
    expect(index.occurrences.every((o) => o.effectiveLayer === 'POWER')).toBe(true);

    // v1: not ported — takeoff assertions dropped with src/cad/takeoff
  });
});

