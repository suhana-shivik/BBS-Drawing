// ============================================================
// THE SECTION ROWS GO FIRST, AND THE SUMMARY CANNOT TAKE THEM DOWN.
//
// `drawing_sections` needs no column that migration 0001 did not already
// create. `drawings.split_manifest` needs 0003. Writing the manifest first
// meant a project whose database was still on 0002 threw on the very first
// statement of the sync — so a split filed NOTHING at all, and the section
// folder existed in exactly one browser's IndexedDB. The optional half was
// taking the essential half with it.
//
// The order is the fix, and the order is what this pins.
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  supabase: () => client,
  supabaseUrl: () => 'https://example.test',
  SUPABASE_SETUP_MESSAGE: '',
  resetSupabaseClientForTests: () => {},
}));

vi.mock('../../src/data/session', () => ({
  requireUserId: async () => 'user-1',
  describeDbError: (e: { message?: string }, doing: string) => `${doing}: ${e.message ?? ''}`,
  unwrap: <T,>(r: { data: T }) => r.data,
}));

/** Every statement the sync issued, in order — which is what is under test. */
let calls: string[] = [];
/** Tables whose write should be refused, standing in for a missing column. */
let refuse = new Set<string>();

const result = (table: string, op: string, data: unknown = []) => {
  calls.push(`${table}.${op}`);
  return refuse.has(table)
    ? { data: null, error: { message: `column "split_manifest" does not exist` } }
    : { data, error: null };
};

const client = {
  from(table: string) {
    const chain = {
      delete: () => ({ eq: async () => result(table, 'delete') }),
      update: (_v: unknown) => ({ eq: async () => result(table, 'update') }),
      insert: (rows: Record<string, unknown>[]) => ({
        select: () => ({
          then: (res: (v: unknown) => void) =>
            res(
              result(
                table,
                'insert',
                rows.map((r, i) => ({ id: `sec-${i}`, section_key: r.section_key })),
              ),
            ),
        }),
      }),
      select: (_c: string) => ({
        eq: () => ({ maybeSingle: async () => result(table, 'select', null) }),
      }),
    };
    return chain as never;
  },
  storage: {
    from: () => ({
      upload: async () => {
        calls.push('storage.upload');
        return { error: null };
      },
    }),
  },
};

vi.mock('../../src/data/drawings', () => ({
  remoteDrawingIdFor: () => 'drawing-row-1',
  resolveDrawingId: async () => 'drawing-row-1',
  sectionStoragePathFor: (_u: string, _p: string, _d: string, key: string, ext: string) =>
    `u/p/d/sections/${key}.${ext}`,
  uploadSectionBody: async (path: string) => {
    calls.push('storage.upload');
    return path;
  },
  setSplitManifest: async () => {
    calls.push('drawings.update');
    if (refuse.has('drawings')) throw new Error('column "split_manifest" does not exist');
  },
  downloadDrawingFile: async () => new Blob(['']),
}));

import { syncDrawingSections } from '../../src/data/sections';

const section = (id: string) => ({
  sectionId: id,
  label: `${id} label`,
  kind: 'schedule',
  bounds: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
  entityCount: 3,
  dxf: '0\nSECTION\n',
  sourceDrawingHash: 'doc:abc',
});

describe('filing a split', () => {
  beforeEach(() => {
    calls = [];
    refuse = new Set();
  });

  it('writes the section rows BEFORE the summary', async () => {
    await syncDrawingSections('p', 'doc-1', [section('REGION-01')], { summary: 'x' });
    const insert = calls.indexOf('drawing_sections.insert');
    const update = calls.indexOf('drawings.update');
    expect(insert).toBeGreaterThanOrEqual(0);
    expect(update).toBeGreaterThan(insert);
  });

  it('still files the sections when the summary column does not exist', async () => {
    refuse.add('drawings');
    const filed = await syncDrawingSections('p', 'doc-1', [section('REGION-01')], { summary: 'x' });
    // The whole point: 0003 not applied must cost the summary, not the split.
    expect(calls).toContain('drawing_sections.insert');
    expect(filed.get('REGION-01')).toBe('sec-0');
  });

  it('clears the drawing’s old sections before filing the new ones', async () => {
    await syncDrawingSections('p', 'doc-1', [section('REGION-01')], undefined);
    expect(calls.indexOf('drawing_sections.delete')).toBeLessThan(
      calls.indexOf('drawing_sections.insert'),
    );
  });

  it('puts each section body in the bucket before the row that points at it', async () => {
    await syncDrawingSections('p', 'doc-1', [section('REGION-01')], undefined);
    expect(calls.indexOf('storage.upload')).toBeLessThan(calls.indexOf('drawing_sections.insert'));
  });
});
