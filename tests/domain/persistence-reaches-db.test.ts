// ============================================================
// Does the WRITE actually reach Postgres?
//
// Three things in this app used to answer no, all in the same shape: the code
// updated an in-memory cache and an IndexedDB/localStorage mirror, the screen
// redrew, and nothing was said to the database. That reads as success until
// the next reload, when the mirror is refilled from rows that were never
// touched and the "deleted" thing is back.
//
//   · a filed BBS output, deleted — the row survived, the workbook returned;
//   · an imported drawing — no row and no stored file at all, so the register
//     existed in exactly one browser profile;
//   · a folder someone made — `localStorage` only, lost with site data.
//
// So these tests assert the CALL, not the cache. Each one stubs the data layer
// and pins that the mutation names the right table with the right id. A test
// that only checked the list afterwards would have passed against every one of
// the defects above.
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

// Typed parameter lists on purpose: an argument-less `vi.fn` makes
// `mock.calls` a tuple of length zero, and then the assertions below cannot
// name the argument they exist to check.
const remoteArtifacts = vi.hoisted(() => ({
  listArtifacts: vi.fn(async (_projectId: string) => [] as unknown[]),
  insertArtifact: vi.fn(async (_artifact: unknown) => 'db-uuid-1'),
  deleteArtifact: vi.fn(async (_id: string) => {}),
  deleteArtifactsForDocument: vi.fn(async (_projectId: string, _documentId: string) => {}),
}));
vi.mock('../../src/data/artifacts', () => remoteArtifacts);

const remoteDrawings = vi.hoisted(() => ({
  syncDrawing: vi.fn(
    async (_projectId: string, _entry: { documentId: string; drawingNumber: string }) => 'drawing-row-1',
  ),
  listDrawings: vi.fn(async (_projectId: string) => [] as unknown[]),
  deleteDrawingRow: vi.fn(async (_projectId: string, _documentId: string) => {}),
  toRegisterEntry: vi.fn(),
}));
vi.mock('../../src/data/drawings', () => remoteDrawings);

const remoteFolders = vi.hoisted(() => ({
  listFolderRows: vi.fn(async (_projectId: string) => [] as unknown[]),
  upsertFolderRow: vi.fn(async (_projectId: string, _folder: unknown) => {}),
  deleteFolderRow: vi.fn(async (_projectId: string, _localId: string) => {}),
}));
vi.mock('../../src/data/folders', () => remoteFolders);

import {
  loadProjectArtifacts,
  removeProjectArtifact,
  removeProjectArtifactsForDocument,
  saveProjectArtifact,
} from '../../src/register/artifacts';
import {
  loadDrawingRegister,
  registerDrawing,
  removeDrawingEntry,
  updateDrawingEntry,
} from '../../src/register/register';
import {
  createFolder,
  deleteFolder,
  hydrateFolders,
  listFolders,
  renameFolder,
  resetFolderHydration,
  setMembership,
} from '../../src/register/folders';
import type { CadDocument } from '../../src/cad/types';
import type { DrawingRow } from '../../src/data/drawings';

// ------------------------------------------------------------
// filed outputs
// ------------------------------------------------------------

const output = {
  projectId: 'proj-db',
  documentId: 'doc-1',
  kind: 'bbs' as const,
  drawingName: 'Foundations drawings.dxf',
  drawingNumber: 'PCD-IND-B300-S-803-R0',
  revision: 'S',
  mimeType: 'application/json' as const,
};

describe('deleting a filed BBS output', () => {
  beforeEach(() => {
    remoteArtifacts.listArtifacts.mockResolvedValue([]);
    remoteArtifacts.insertArtifact.mockResolvedValue('db-uuid-1');
  });

  it('keeps the DATABASE id, not the browser one, so the row can be addressed again', async () => {
    const filed = await saveProjectArtifact({ ...output, projectId: 'p-id', content: '{"a":1}' });
    // `newId('artifact')` never leaves this machine — the uuid the row was
    // given is what Delete has to send back.
    expect(filed.id).toBe('db-uuid-1');
    expect(filed.id).not.toMatch(/^artifact/);
  });

  it('deletes the row, not only the local mirror', async () => {
    const filed = await saveProjectArtifact({ ...output, projectId: 'p-one', content: '{"a":2}' });
    await removeProjectArtifact('p-one', filed.id);
    expect(remoteArtifacts.deleteArtifact).toHaveBeenCalledWith('db-uuid-1');
  });

  it('takes every output filed under a drawing when the drawing goes', async () => {
    await saveProjectArtifact({ ...output, projectId: 'p-two', content: '{"a":3}' });
    await removeProjectArtifactsForDocument('p-two', 'doc-1');
    expect(remoteArtifacts.deleteArtifactsForDocument).toHaveBeenCalledWith('p-two', 'doc-1');
  });

  it('reports a refused delete rather than swallowing it', async () => {
    const filed = await saveProjectArtifact({ ...output, projectId: 'p-three', content: '{"a":4}' });
    remoteArtifacts.deleteArtifact.mockRejectedValueOnce(new Error('row level security'));
    await expect(removeProjectArtifact('p-three', filed.id)).rejects.toThrow(/row level security/);
  });

  it('does not call the database for an id that is not filed', async () => {
    await loadProjectArtifacts('p-empty');
    await removeProjectArtifact('p-empty', 'not-a-real-id');
    expect(remoteArtifacts.deleteArtifact).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
// the drawing register
// ------------------------------------------------------------

const doc = (id: string): CadDocument =>
  ({
    id,
    name: 'Foundations drawings.dxf',
    units: 'mm',
    entities: [],
    layers: [],
    layouts: [],
    blocks: new Map(),
    texts: [],
    diagnostics: [],
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  }) as unknown as CadDocument;

const drawingRow = (over: Partial<DrawingRow> = {}): DrawingRow =>
  ({
    id: 'row-uuid-9',
    project_id: 'proj-hydrate',
    user_id: 'user-1',
    document_id: 'doc-remote',
    asset_id: null,
    original_file_name: 'Site plan.dxf',
    display_name: 'PCD-001 · R2',
    drawing_number: 'PCD-001',
    identity_key: 'PCD001',
    title: 'SITE PLAN',
    revision: 'R2',
    revision_rank: 2,
    issue_date: '2026-01-04',
    discipline: 'structural',
    health: 'ready',
    revision_state: 'current',
    file_type: 'application/dxf',
    file_size_bytes: 4096,
    storage_path: 'user-1/proj-hydrate/row-uuid-9/Site_plan.dxf',
    content_hash: 'hash-9',
    drawing_hash: null,
    status: 'UPLOADED',
    split_status: null,
    package_hash: null,
    version_no: 1,
    version_count: 1,
    superseded_by: null,
    warnings: [],
    evidence: {},
    imported_at: '2026-01-04T09:00:00.000Z',
    reuploaded_at: null,
    ...over,
  }) as DrawingRow;

describe('an imported drawing', () => {
  beforeEach(() => {
    remoteDrawings.listDrawings.mockResolvedValue([]);
    remoteDrawings.toRegisterEntry.mockImplementation((row: DrawingRow) => ({
      id: row.id,
      projectId: row.project_id,
      documentId: row.document_id,
      assetId: `remote:${row.id}`,
      originalFileName: row.original_file_name,
      displayName: row.display_name,
      drawingNumber: row.drawing_number,
      identityKey: row.identity_key,
      title: row.title,
      revision: row.revision,
      revisionRank: row.revision_rank,
      issueDate: row.issue_date,
      discipline: row.discipline,
      health: row.health,
      revisionState: row.revision_state,
      importedAt: Date.parse(row.imported_at),
      warnings: [],
      evidence: {},
      versionNo: 1,
      versionCount: 1,
    }));
  });

  it('files a row — the register is not a browser document', async () => {
    await loadDrawingRegister('proj-reg');
    await registerDrawing('proj-reg', doc('doc-a'), 'Foundations drawings.dxf', 'asset-a', 'hash-a');
    expect(remoteDrawings.syncDrawing).toHaveBeenCalled();
    const [projectId, entry] = remoteDrawings.syncDrawing.mock.calls[0];
    expect(projectId).toBe('proj-reg');
    expect(entry.documentId).toBe('doc-a');
  });

  it('files the row again when its identity is corrected by hand', async () => {
    await loadDrawingRegister('proj-edit');
    const entry = await registerDrawing('proj-edit', doc('doc-b'), 'b.dxf', 'asset-b', 'hash-b');
    remoteDrawings.syncDrawing.mockClear();
    await updateDrawingEntry(entry.id, { drawingNumber: 'PCD-777', revision: 'R3' });
    const filed = remoteDrawings.syncDrawing.mock.calls.map(([, entry]) => entry.drawingNumber);
    expect(filed).toContain('PCD-777');
  });

  it('deletes the row when the drawing is deleted', async () => {
    await loadDrawingRegister('proj-del');
    const entry = await registerDrawing('proj-del', doc('doc-c'), 'c.dxf', 'asset-c', 'hash-c');
    await removeDrawingEntry(entry.id);
    expect(remoteDrawings.deleteDrawingRow).toHaveBeenCalledWith('proj-del', 'doc-c');
  });

  it('does NOT drop it locally when the database refuses the delete', async () => {
    await loadDrawingRegister('proj-refuse');
    const entry = await registerDrawing('proj-refuse', doc('doc-d'), 'd.dxf', 'asset-d', 'hash-d');
    remoteDrawings.deleteDrawingRow.mockRejectedValueOnce(new Error('row level security'));
    // The whole point: a local-only delete looks identical to a real one
    // until the next reload puts the drawing back.
    await expect(removeDrawingEntry(entry.id)).rejects.toThrow(/row level security/);
    const after = await loadDrawingRegister('proj-refuse');
    expect(after.entries.some((e) => e.documentId === 'doc-d')).toBe(true);
  });

  it('comes back from the rows on a machine that has never seen the project', async () => {
    remoteDrawings.listDrawings.mockResolvedValue([drawingRow()]);
    const register = await loadDrawingRegister('proj-hydrate');
    expect(register.entries.map((e) => e.drawingNumber)).toContain('PCD-001');
  });

  it('pushes up an import that never reached the database', async () => {
    await loadDrawingRegister('proj-late');
    remoteDrawings.syncDrawing.mockRejectedValueOnce(new Error('offline'));
    await registerDrawing('proj-late', doc('doc-late'), 'late.dxf', 'asset-late', 'hash-late');
    remoteDrawings.syncDrawing.mockClear();
    remoteDrawings.syncDrawing.mockResolvedValue('row-late');
    // Reopening the project is the retry: the row list has no such document,
    // so the local entry is filed rather than treated as deleted elsewhere.
    const register = await loadDrawingRegister('proj-late');
    expect(register.entries.some((e) => e.documentId === 'doc-late')).toBe(true);
    expect(remoteDrawings.syncDrawing).toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
// folders someone made
// ------------------------------------------------------------

describe('a folder a person made', () => {
  beforeEach(() => {
    localStorage.clear();
    resetFolderHydration();
    remoteFolders.listFolderRows.mockResolvedValue([]);
  });

  it('is filed as a row when it is created', () => {
    const folder = createFolder('proj-f', 'WH-4 package');
    expect(remoteFolders.upsertFolderRow).toHaveBeenCalledWith(
      'proj-f',
      expect.objectContaining({ id: folder.id, name: 'WH-4 package' }),
    );
  });

  it('files the rename and the membership, not just the create', () => {
    const folder = createFolder('proj-f2', 'Priced');
    remoteFolders.upsertFolderRow.mockClear();

    renameFolder('proj-f2', folder.id, 'Priced — Feb');
    expect(remoteFolders.upsertFolderRow).toHaveBeenLastCalledWith(
      'proj-f2',
      expect.objectContaining({ name: 'Priced — Feb' }),
    );

    setMembership('proj-f2', folder.id, 'drw-1', true);
    expect(remoteFolders.upsertFolderRow).toHaveBeenLastCalledWith(
      'proj-f2',
      expect.objectContaining({ members: ['drw-1'] }),
    );
  });

  it('deletes the row, addressed by the id the browser filed it under', () => {
    const folder = createFolder('proj-f3', 'Issued to Sharma');
    deleteFolder('proj-f3', folder.id);
    expect(remoteFolders.deleteFolderRow).toHaveBeenCalledWith('proj-f3', folder.id);
  });

  it('arrives on a machine that has never seen the project', async () => {
    remoteFolders.listFolderRows.mockResolvedValue([
      {
        id: 'uuid-1',
        local_id: 'uf_abc',
        name: 'WH-4 package',
        members: ['drw-7'],
        created_at: '2026-02-01T10:00:00.000Z',
      },
    ]);
    await hydrateFolders('proj-f4');
    const folders = listFolders('proj-f4');
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ id: 'uf_abc', name: 'WH-4 package', members: ['drw-7'] });
  });

  it('brings the MEMBERSHIP back too — the filing survives a cleared browser', async () => {
    // The whole point of `project_folders.members`. A browser with nothing in
    // it gets the folder AND what was filed into it, keyed by the document id
    // rather than the register entry id that was minted on the other machine.
    remoteFolders.listFolderRows.mockResolvedValue([
      {
        id: 'uuid-2',
        local_id: 'uf_demo',
        name: 'demofolder',
        members: ['doc-plinth', 'doc-footings'],
        created_at: '2026-02-01T10:00:00.000Z',
      },
    ]);
    await hydrateFolders('proj-f6');
    expect(listFolders('proj-f6')[0].members).toEqual(['doc-plinth', 'doc-footings']);
  });

  it('keeps — and files — a folder made while the database was unreachable', async () => {
    const folder = createFolder('proj-f5', 'Made offline');
    remoteFolders.upsertFolderRow.mockClear();
    remoteFolders.listFolderRows.mockResolvedValue([]);
    await hydrateFolders('proj-f5');
    // An empty row list is not "somebody deleted it": this browser's copy is
    // the only record of it, so it is pushed up rather than dropped.
    expect(listFolders('proj-f5').map((f) => f.name)).toContain('Made offline');
    expect(remoteFolders.upsertFolderRow).toHaveBeenCalledWith(
      'proj-f5',
      expect.objectContaining({ id: folder.id }),
    );
  });
});
