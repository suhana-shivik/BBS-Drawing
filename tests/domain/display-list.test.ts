// A DXF's own layer table can mark a layer "off" (a negative ACI colour) or
// "frozen" (layer flag bit 0) — whatever state the file's last CAD session
// happened to be saved in. The viewer used to honour that, so a drawing saved
// with its main layers off imported as an entirely blank sheet: the entity
// count still read correctly off the parsed file, nothing was drawn, and
// there was no way in the app to see it — `hiddenLayers` (the Layers menu)
// was never what was hiding it, so toggling it did nothing.
import { describe, expect, it } from 'vitest';
import { buildDisplayList } from '../../src/cad/displayList';
import { line, makeDoc } from '../helpers/cadDoc';

describe('buildDisplayList — a DXF layer\'s own visible/frozen state', () => {
  it('still draws an entity on a layer the file marks not visible', () => {
    const doc = makeDoc({ entities: [line({ x: 0, y: 0 }, { x: 100, y: 0 }, 'A')], layers: ['A'] });
    doc.layers.get('A')!.visible = false;

    const list = buildDisplayList(doc, { regionId: null, hiddenLayers: new Set(), paper: false });
    expect(list.ops).toHaveLength(1);
  });

  it('still draws an entity on a layer the file marks frozen', () => {
    const doc = makeDoc({ entities: [line({ x: 0, y: 0 }, { x: 100, y: 0 }, 'A')], layers: ['A'] });
    doc.layers.get('A')!.frozen = true;

    const list = buildDisplayList(doc, { regionId: null, hiddenLayers: new Set(), paper: false });
    expect(list.ops).toHaveLength(1);
  });

  it('hiddenLayers — the viewer\'s own toggle — is still the real gate', () => {
    const doc = makeDoc({
      entities: [
        line({ x: 0, y: 0 }, { x: 100, y: 0 }, 'A'),
        line({ x: 0, y: 0 }, { x: 100, y: 0 }, 'B'),
      ],
      layers: ['A', 'B'],
    });

    const list = buildDisplayList(doc, { regionId: null, hiddenLayers: new Set(['A']), paper: false });
    expect(list.ops).toHaveLength(1);
    expect(list.ops[0].layer).toBe('B');
  });
});
