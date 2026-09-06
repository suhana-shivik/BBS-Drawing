import { beforeEach, describe, expect, it } from 'vitest';
import { getDrawingRegister, loadDrawingRegister, registerDrawing, updateDrawingEntry } from '../../src/register/register';
import type { CadDocument } from '../../src/cad/types';

/**
 * Renaming a drawing — the Files view's Name column shows
 * `originalFileName || displayName` (`fileNodeFor`), so a rename that only
 * ever touched `displayName` would have no visible effect on an imported
 * drawing, which always carries a non-empty `originalFileName`.
 *
 * Seeded through `registerDrawing`, not a saved/reloaded register: IndexedDB
 * is unavailable under jsdom, and `registerDrawing` is the one path that
 * updates the module's in-memory register regardless of whether persistence
 * succeeds (it is only ever best-effort here, same as `updateDrawingEntry`).
 */
function minimalDoc(id: string): CadDocument {
  return {
    id,
    name: 'Foundations drawings',
    sourceFile: 'Foundations drawings.dxf',
    unitScale: 1,
    layers: new Map(),
    linetypes: new Map(),
    textStyles: new Map(),
    blocks: new Map(),
    entities: [],
    layouts: [],
    regions: [],
    diagnostics: [],
    extents: null,
  };
}

async function seed(): Promise<string> {
  await loadDrawingRegister('prj_1');
  const entry = await registerDrawing(
    'prj_1',
    minimalDoc('doc_a'),
    'Foundations drawings.dxf',
    'asset_a',
  );
  return entry.id;
}

describe('renaming a drawing', () => {
  let id: string;
  beforeEach(async () => {
    id = await seed();
  });

  it('overwrites originalFileName — the name the Files list actually shows', async () => {
    await updateDrawingEntry(id, { originalFileName: 'Foundation drawings — revised.dxf' });
    const updated = getDrawingRegister()?.entries.find((e) => e.id === id);
    expect(updated?.originalFileName).toBe('Foundation drawings — revised.dxf');
  });

  it('leaves the drawing number, title and revision untouched', async () => {
    const before = getDrawingRegister()?.entries.find((e) => e.id === id);
    await updateDrawingEntry(id, { originalFileName: 'Renamed.dxf' });
    const updated = getDrawingRegister()?.entries.find((e) => e.id === id);
    expect(updated?.drawingNumber).toBe(before?.drawingNumber);
    expect(updated?.title).toBe(before?.title);
    expect(updated?.revision).toBe(before?.revision);
  });

  it('does nothing for an id the register does not hold', async () => {
    await updateDrawingEntry('nope', { originalFileName: 'X.dxf' });
    expect(getDrawingRegister()?.entries).toHaveLength(1);
    expect(getDrawingRegister()?.entries[0].originalFileName).toBe('Foundations drawings.dxf');
  });
});
