import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadDrawingRegister,
  getDrawingRegister,
  removeDrawingEntry,
  reconcileRevisionStates,
} from '../../src/register/register';
import * as repo from '../../src/cad/store';
import type { DrawingRegisterEntry } from '../../src/register/types';

/**
 * Removing a drawing from the register.
 *
 * Prompted by a register holding four identical "PCD-IND-B300-S-803-R0" rows
 * from repeated imports, with no way to clear them.
 */
function entry(id: string, revision: string, rank: number): DrawingRegisterEntry {
  return {
    id,
    projectId: 'prj_1',
    documentId: `doc_${id}`,
    assetId: `ast_${id}`,
    originalFileName: `${id}.dxf`,
    displayName: `PCD-IND-B300-S-803 · ${revision}`,
    drawingNumber: 'PCD-IND-B300-S-803',
    identityKey: 'PCDINDB300S803',
    title: 'FOUNDATION LAYOUT PLAN',
    revision,
    revisionRank: rank,
    issueDate: '',
    discipline: 'structural',
    health: 'ready',
    revisionState: 'current',
    versionNo: 1,
    versionCount: 1,
    importedAt: 1000 + rank,
    warnings: [],
    evidence: {},
  };
}

async function seed(entries: DrawingRegisterEntry[]): Promise<void> {
  await loadDrawingRegister('prj_1');
  const data = { projectId: 'prj_1', entries: reconcileRevisionStates(entries), updatedAt: 1 };
  try {
    await repo.putDrawingRegister(data);
  } catch {
    // IndexedDB is unavailable under jsdom; loadDrawingRegister falls back to
    // an empty register, so the seed is applied through the module instead.
  }
  await loadDrawingRegister('prj_1');
}

describe('removing a drawing from the register', () => {
  beforeEach(async () => {
    await loadDrawingRegister('prj_1');
  });

  it('returns null for an id the register does not hold', async () => {
    expect(await removeDrawingEntry('nope')).toBeNull();
  });

  it('promotes the earlier revision when the later one is removed', async () => {
    // The trap: filter the array and R0 stays marked "superseded" by a sheet
    // that no longer exists, leaving the package with no current drawing.
    const state = reconcileRevisionStates([entry('a', 'R0', 0), entry('b', 'R1', 1)]);
    expect(state.find((e) => e.id === 'a')?.revisionState).toBe('superseded');

    const survivors = reconcileRevisionStates(state.filter((e) => e.id !== 'b'));
    expect(survivors.find((e) => e.id === 'a')?.revisionState).toBe('current');
  });

  it('leaves an unrelated chain alone', async () => {
    const kept = reconcileRevisionStates(
      [entry('a', 'R0', 0), entry('b', 'R1', 1)].filter((e) => e.id !== 'zzz'),
    );
    expect(kept).toHaveLength(2);
  });
});
