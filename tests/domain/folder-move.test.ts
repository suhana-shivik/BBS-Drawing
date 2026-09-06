// ============================================================
// MOVE, and the two things it must not do.
//
// It must not leave a copy behind — a drawing filed under both its document id
// and its older entry id would come out of one folder and stay in the other,
// which reads as a move that duplicated the drawing.
//
// It must not touch the discipline. That is structural, not a matter of taste:
// `src/register/folders.ts` has no reference to a register entry at all, so
// the code that moves a drawing cannot reach the field that says what kind of
// drawing it is. These tests pin that the module boundary is doing that job.
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  supabase: () => {
    throw new Error('not configured in this test');
  },
  supabaseUrl: () => '',
  SUPABASE_SETUP_MESSAGE: '',
  resetSupabaseClientForTests: () => {},
}));

import {
  createFolder,
  listFolders,
  moveMembership,
  resetFolderHydration,
  setMembership,
} from '../../src/register/folders';

const P = 'proj-move';
const membersOf = (name: string): string[] =>
  listFolders(P).find((f) => f.name === name)?.members ?? [];

describe('moving a drawing between folders someone made', () => {
  let a: string;
  let b: string;

  beforeEach(() => {
    localStorage.clear();
    resetFolderHydration();
    a = createFolder(P, 'demofolder').id;
    b = createFolder(P, 'WH-4 package').id;
  });

  it('changes membership only — it leaves and it arrives', () => {
    setMembership(P, a, 'doc-plinth', true);
    moveMembership(P, ['doc-plinth'], b);
    expect(membersOf('demofolder')).toEqual([]);
    expect(membersOf('WH-4 package')).toEqual(['doc-plinth']);
  });

  it('takes every key it was filed under, so no copy is left behind', () => {
    // The same drawing, filed once under its document id and once — long ago —
    // under the register entry id that was minted on this browser.
    setMembership(P, a, 'doc-plinth', true);
    setMembership(P, a, 'drw_local_1', true);
    moveMembership(P, ['drw_local_1', 'doc-plinth'], b, 'doc-plinth');
    expect(membersOf('demofolder')).toEqual([]);
    // …and it arrives ONCE, under the stable key.
    expect(membersOf('WH-4 package')).toEqual(['doc-plinth']);
  });

  it('files under the stable key even when asked for by the old one', () => {
    moveMembership(P, ['drw_local_1', 'doc-plinth'], a, 'doc-plinth');
    expect(membersOf('demofolder')).toEqual(['doc-plinth']);
  });

  it('null takes it out of every folder — filed by discipline alone', () => {
    setMembership(P, a, 'doc-plinth', true);
    setMembership(P, b, 'doc-plinth', true);
    moveMembership(P, ['doc-plinth'], null);
    expect(membersOf('demofolder')).toEqual([]);
    expect(membersOf('WH-4 package')).toEqual([]);
  });

  it('does not add a second copy when it is already where it is going', () => {
    setMembership(P, a, 'doc-plinth', true);
    moveMembership(P, ['doc-plinth'], a);
    expect(membersOf('demofolder')).toEqual(['doc-plinth']);
  });

  it('leaves other drawings in the folder alone', () => {
    setMembership(P, a, 'doc-plinth', true);
    setMembership(P, a, 'doc-other', true);
    moveMembership(P, ['doc-plinth'], b);
    expect(membersOf('demofolder')).toEqual(['doc-other']);
  });

  it('touches nothing at all when there is nothing to change', () => {
    const before = listFolders(P);
    moveMembership(P, ['doc-nowhere'], null);
    // Same array by reference: no write, so no re-render of the whole tree.
    expect(listFolders(P)).toBe(before);
  });
});
