// ============================================================
// IndexedDB is a cache. These are the tests that make that true rather than
// merely stated.
//
// A cache has two obligations a second copy does not:
//
//   1. A MISS MUST BE REFILLED FROM THE RECORD. Until this, a machine that had
//      never opened a project got its register from `public.drawings` and its
//      documents from an empty IndexedDB — so the Files list showed drawings
//      that nothing could open, and a sheet that had already been split looked
//      unsplit and offered to spend a model call reading it again.
//
//   2. IT MUST NOT OUTLIVE THE ACCOUNT. The stores are keyed by project, not
//      by user, so anything left behind is one person's drawings sitting in
//      the next person's browser.
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  supabase: () => {
    throw new Error('no test should reach the real client');
  },
  supabaseUrl: () => 'https://example.test',
  SUPABASE_SETUP_MESSAGE: '',
  resetSupabaseClientForTests: () => {},
}));

const remoteSections = vi.hoisted(() => ({
  syncDrawingSections: vi.fn(async () => new Map<string, string>()),
  deleteDrawingSections: vi.fn(async () => {}),
  listDrawingSections: vi.fn(async () => [] as unknown[]),
  loadRemoteSplit: vi.fn(
    async (_p: string, _d: string) =>
      null as null | { manifest: unknown; sections: Record<string, unknown>[] },
  ),
  remoteSectionIdFor: vi.fn(() => null),
  resetSectionIdMap: vi.fn(),
}));
vi.mock('../../src/data/sections', () => remoteSections);

const repo = vi.hoisted(() => ({
  getUnderstandingPackages: vi.fn(async (_p: string) => [] as unknown[]),
  putUnderstandingPackages: vi.fn(async (_p: string, _v: unknown) => {}),
}));
vi.mock('../../src/cad/store', () => repo);

import { packageFor, restorePackage } from '../../src/cad/understanding/store';
import type { CadDocument } from '../../src/cad/types';

const MANIFEST = {
  version: 1,
  projectId: 'proj-c',
  documentId: 'doc-footings',
  sourceDrawing: 'Foundations drawings.dxf',
  sourceDrawingHash: 'doc:abc123',
  createdAt: 1,
  sheetExtents: null,
  requests: [],
  relationships: [],
  unresolved: [],
  coverage: { measurableEntities: 3063, coveredEntities: 2968, uncoveredEntities: 95, gaps: [] },
  summary: 'a foundation sheet',
  model: 'test',
  source: 'model',
};

const sectionRow = () => ({
  id: 'sec-uuid-1',
  section_key: 'REGION-03',
  label: 'FOOTING SCHEDULE',
  kind: 'schedule',
  bounds: { minX: 0, minY: 0, maxX: 500, maxY: 400 },
  entity_count: 42,
  note: null,
  callouts: ['8 (2L)@100 c/c'],
  drawing_hash: 'doc:abc123',
  storage_path_dxf: 'u/p/d/sections/REGION-03.dxf',
  storage_path_png: 'u/p/d/sections/REGION-03.png',
  dxf: '0\nSECTION\n',
  png: 'data:image/png;base64,AAAA',
});

describe('a split that this browser has never seen', () => {
  beforeEach(() => {
    repo.getUnderstandingPackages.mockResolvedValue([]);
    remoteSections.loadRemoteSplit.mockResolvedValue(null);
  });

  it('comes back from the database rather than looking unsplit', async () => {
    remoteSections.loadRemoteSplit.mockResolvedValue({
      manifest: MANIFEST,
      sections: [sectionRow()],
    });
    const pkg = await restorePackage('proj-c', 'doc-footings');
    expect(pkg).not.toBeNull();
    // The parts that say whether the split accounts for the sheet — the whole
    // reason the manifest is stored at all.
    expect(pkg!.summary).toBe('a foundation sheet');
    expect(pkg!.coverage.measurableEntities).toBe(3063);
    expect(pkg!.coverage.uncoveredEntities).toBe(95);
    expect(pkg!.sections).toHaveLength(1);
    expect(pkg!.sections[0]).toMatchObject({
      sectionId: 'REGION-03',
      label: 'FOOTING SCHEDULE',
      kind: 'schedule',
      entityCount: 42,
      calloutHints: ['8 (2L)@100 c/c'],
    });
    // …bodies included, out of the bucket.
    expect(pkg!.sections[0].dxf).toContain('SECTION');
    expect(pkg!.sections[0].png).toMatch(/^data:image\/png/);
  });

  it('writes what it restored back into the cache, so the next open is local', async () => {
    remoteSections.loadRemoteSplit.mockResolvedValue({
      manifest: MANIFEST,
      sections: [sectionRow()],
    });
    await restorePackage('proj-c', 'doc-footings');
    expect(repo.putUnderstandingPackages).toHaveBeenCalled();
    const [projectId, saved] = repo.putUnderstandingPackages.mock.calls[0] as [string, unknown[]];
    expect(projectId).toBe('proj-c');
    expect((saved[0] as { documentId: string }).documentId).toBe('doc-footings');
  });

  it('still answers "never split" when the database has no split either', async () => {
    // The honest null. This is the one that DOES mean "spend the model call".
    expect(await restorePackage('proj-c', 'doc-footings')).toBeNull();
  });

  it('is asked for by packageFor on a cache miss, not concluded from it', async () => {
    remoteSections.loadRemoteSplit.mockResolvedValue({
      manifest: MANIFEST,
      sections: [sectionRow()],
    });
    const doc = { id: 'doc-footings', entities: [], layers: new Map() } as unknown as CadDocument;
    const status = await packageFor('proj-c', doc, new TextEncoder().encode('x').buffer);
    expect(remoteSections.loadRemoteSplit).toHaveBeenCalledWith('proj-c', 'doc-footings');
    expect(status?.package.summary).toBe('a foundation sheet');
  });

  it('comes back with NO manifest at all — the rows are the split', async () => {
    // A database still on migration 0002 has no `split_manifest` column. The
    // sections are what everything else is built on, so their rows decide
    // whether there is a package here; the summary is metadata that was
    // missing, not a reason to report the sheet as never read.
    remoteSections.loadRemoteSplit.mockResolvedValue({
      manifest: null,
      sections: [sectionRow()],
    });
    const pkg = await restorePackage('proj-c', 'doc-footings');
    expect(pkg).not.toBeNull();
    expect(pkg!.sections).toHaveLength(1);
    expect(pkg!.documentId).toBe('doc-footings');
    // The hash `stalenessOf` compares comes off the section rows instead —
    // they were cut from the same drawing, so they carry the same fingerprint.
    expect(pkg!.sourceDrawingHash).toBe('doc:abc123');
  });

  it('does not fail the open when the database refuses', async () => {
    remoteSections.loadRemoteSplit.mockRejectedValueOnce(new Error('offline'));
    await expect(restorePackage('proj-c', 'doc-footings')).resolves.toBeNull();
  });

  it('prefers the cache when it has the package — no round trip', async () => {
    repo.getUnderstandingPackages.mockResolvedValue([
      { ...MANIFEST, sections: [], summary: 'the cached one' },
    ]);
    const doc = { id: 'doc-footings', entities: [], layers: new Map() } as unknown as CadDocument;
    const status = await packageFor('proj-c', doc, new TextEncoder().encode('x').buffer);
    expect(status?.package.summary).toBe('the cached one');
    expect(remoteSections.loadRemoteSplit).not.toHaveBeenCalled();
  });
});
