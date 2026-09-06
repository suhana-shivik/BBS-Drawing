// ============================================================
// Two writes that named no drawing.
//
//   · `drawing_sections` was never written by anything. The split package
//     lived in IndexedDB and only there, so the table stayed empty and
//     `data_facts.section_id` had nothing to reference.
//   · `interview_logs.drawing_id` was resolved from a `documentId` the caller
//     never set, so every filed log recorded a null drawing — and the log's
//     `drawingName` beside it is a LABEL (a drawing number when one was read,
//     a file name when it was not), which nothing can be joined on.
//
// Both are asserted at the boundary — what reaches the data layer — because
// what they persisted locally was already correct. The defect was only ever in
// what was, and was not, said to the database.
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
  syncDrawingSections: vi.fn(async (_p: string, _d: string, _s: readonly unknown[]) => new Map<string, string>()),
  deleteDrawingSections: vi.fn(async (_documentId: string) => {}),
  listDrawingSections: vi.fn(async (_documentId: string) => [] as unknown[]),
  remoteSectionIdFor: vi.fn(() => null),
  resetSectionIdMap: vi.fn(),
}));
vi.mock('../../src/data/sections', () => remoteSections);

// jsdom ships no IndexedDB, and `savePackage` writes the package there before
// it files the index. Stubbed rather than polyfilled: what is under test is
// what reaches the DATA LAYER, and the local write is not part of it.
const repo = vi.hoisted(() => ({
  getUnderstandingPackages: vi.fn(async (_p: string) => [] as unknown[]),
  putUnderstandingPackages: vi.fn(async (_p: string, _v: unknown) => {}),
  getInterviewLogs: vi.fn(async (_p: string) => [] as unknown[]),
  putInterviewLogs: vi.fn(async (_p: string, _v: unknown) => {}),
}));
vi.mock('../../src/cad/store', () => repo);

const remoteLogs = vi.hoisted(() => ({
  insertInterviewLog: vi.fn(
    async (_p: string, _r: { documentId?: string; drawingName: string; log: unknown }) => {},
  ),
  listInterviewLogs: vi.fn(async (_p: string) => [] as unknown[]),
}));
vi.mock('../../src/data/interviewLogs', () => remoteLogs);

import { deletePackage, savePackage } from '../../src/cad/understanding/store';
import { appendInterviewLog, type StoredInterviewLog } from '../../src/interview/logStore';
import type { DrawingUnderstandingPackage } from '../../src/cad/understanding/types';

const SECTION_DXF = '0\nSECTION\n';

const section = (id: string, kind: string, label: string) =>
  ({
    sectionId: id,
    label,
    kind,
    sourceDrawing: 'Foundations drawings.dxf',
    sourceDrawingHash: 'doc:abc123',
    bounds: { minX: 0, minY: 0, maxX: 500, maxY: 400 },
    png: '',
    dxf: '0\nSECTION\n',
    entityIds: ['1A', '1B'],
    evidenceIds: ['1A'],
    memberHints: [],
    calloutHints: ['8 (2L)@100 c/c'],
    orchestratorStep: 1,
    confidence: 0.9,
    entityCount: 2,
    limitations: [],
  }) as unknown as DrawingUnderstandingPackage['sections'][number];

const pkg = (): DrawingUnderstandingPackage =>
  ({
    version: 1,
    projectId: 'proj-s',
    documentId: 'doc-footings',
    sourceDrawing: 'Foundations drawings.dxf',
    sourceDrawingHash: 'doc:abc123',
    createdAt: Date.now(),
    sheetExtents: null,
    sections: [
      section('REGION-01', 'layout', 'FOUNDATION LAYOUT'),
      section('REGION-03', 'schedule', 'FOOTING SCHEDULE'),
    ],
    requests: [],
    relationships: [],
    unresolved: [],
    coverage: { covered: 1, total: 1, fraction: 1 },
    summary: 'a foundation sheet',
    model: 'test',
    source: 'local',
  }) as unknown as DrawingUnderstandingPackage;

describe('the section index', () => {
  beforeEach(() => {
    remoteSections.syncDrawingSections.mockResolvedValue(new Map());
  });

  it('is filed when a split is saved — the table is not meant to be empty', async () => {
    await savePackage(pkg());
    expect(remoteSections.syncDrawingSections).toHaveBeenCalled();
    const [projectId, documentId, sections] = remoteSections.syncDrawingSections.mock.calls[0];
    expect(projectId).toBe('proj-s');
    expect(documentId).toBe('doc-footings');
    expect(sections.map((s) => (s as { sectionId: string }).sectionId)).toEqual(['REGION-01', 'REGION-03']);
  });

  it('carries the index fields AND the bodies the bucket needs', async () => {
    await savePackage(pkg());
    const [, , sections] = remoteSections.syncDrawingSections.mock.calls[0];
    const first = sections[0] as Record<string, unknown>;
    expect(first).toMatchObject({
      sectionId: 'REGION-01',
      label: 'FOUNDATION LAYOUT',
      kind: 'layout',
      entityCount: 2,
      sourceDrawingHash: 'doc:abc123',
    });
    // The body travels so the data layer can put it in the bucket. It is the
    // ROW that must not hold it — megabytes of DXF in a table every listing
    // query reads is the thing `storage_path_dxf` exists to avoid.
    expect(first.dxf).toBe(SECTION_DXF);
  });

  it('does not fail the split when the index cannot be filed', async () => {
    remoteSections.syncDrawingSections.mockRejectedValueOnce(new Error('offline'));
    await expect(savePackage(pkg())).resolves.toBeUndefined();
  });

  it('goes when the package goes', async () => {
    await deletePackage('proj-s', 'doc-footings');
    expect(remoteSections.deleteDrawingSections).toHaveBeenCalledWith('doc-footings');
  });
});

describe('an interview log', () => {
  const log = (over: Partial<StoredInterviewLog> = {}): StoredInterviewLog =>
    ({
      startedAt: 1,
      drawingName: 'PCD-IND-B300-S-803-R0',
      questions: [],
      answers: [],
      findings: [],
      ...over,
    }) as unknown as StoredInterviewLog;

  it('names the document it was about, which is what drawing_id resolves from', async () => {
    await appendInterviewLog('proj-l', log({ documentId: 'doc-footings' }));
    expect(remoteLogs.insertInterviewLog).toHaveBeenCalledWith(
      'proj-l',
      expect.objectContaining({ documentId: 'doc-footings' }),
    );
  });

  it('omits it rather than inventing one when no sheet was open', async () => {
    await appendInterviewLog('proj-l2', log());
    const [, record] = remoteLogs.insertInterviewLog.mock.calls[0];
    expect(record.documentId).toBeUndefined();
    expect(record.drawingName).toBe('PCD-IND-B300-S-803-R0');
  });

  it('does not put the document id inside the audit blob as well', async () => {
    await appendInterviewLog('proj-l3', log({ documentId: 'doc-footings' }));
    const [, record] = remoteLogs.insertInterviewLog.mock.calls[0];
    // The three columns beside it are the fields logStore adds ON TOP of the
    // AuditLog; duplicating them into the blob would make the row disagree
    // with itself the first time one of them was corrected.
    expect(record.log).not.toHaveProperty('documentId');
    expect(record.log).not.toHaveProperty('drawingName');
  });
});
