// ============================================================
// FILING AND CLASSIFICATION ARE TWO DIFFERENT STATEMENTS.
//
// A drawing's DISCIPLINE is read off its title block: "Structural" is a fact
// about the sheet, and the discipline folder is a derived view that is
// recomputed from the drawings on every render. Nothing is ever filed there.
//
// A folder someone MADE is filing: it is where a person put this drawing, and
// it is the answer to "where does this live". Importing into `demofolder`
// files the drawing there and says nothing about what kind of drawing it is.
//
// A drawing is listed WHERE IT IS FILED, in one place only. The discipline
// folder is what the register does with a drawing nobody has filed; once
// somebody has, that folder stops listing it and the discipline lives on as
// what it always was — a property of the sheet, on the row and in Details.
//
// The invariant underneath both: ONE DRAWING IDENTITY. A drawing listed in a
// discipline view and in a user folder is the same node, the same documentId
// and the same row in `public.drawings` — a second membership, never a second
// record. These tests exist to keep that true, because the failure mode is
// silent: a second copy looks exactly like a correctly filed drawing until
// somebody deletes one of them.
// ============================================================
import { describe, expect, it } from 'vitest';
import { buildGroupsForTest } from '../../src/studio/realData';
import { sectionsFolderName } from '../../src/studio/sections';
import type { DrawingRegisterEntry } from '../../src/register/types';
import type { UserFolder } from '../../src/register/folders';
import type { RegisterFolderNode, RegisterNode } from '../../src/studio/data';
import type { DrawingUnderstandingPackage } from '../../src/cad/understanding/types';

const entry = (over: Partial<DrawingRegisterEntry> = {}): DrawingRegisterEntry =>
  ({
    id: 'drw_local_1',
    projectId: 'proj-1',
    documentId: 'doc-plinth',
    assetId: 'asset-1',
    originalFileName: 'Plinth beam.dxf',
    displayName: 'PCD-801 · R0',
    drawingNumber: 'PCD-801',
    identityKey: 'PCD801',
    title: 'PLINTH BEAM LAYOUT',
    revision: 'R0',
    revisionRank: 0,
    issueDate: '2026-02-01',
    discipline: 'structural',
    health: 'ready',
    revisionState: 'current',
    importedAt: 1,
    warnings: [],
    evidence: {},
    versionNo: 1,
    versionCount: 1,
    ...over,
  }) as DrawingRegisterEntry;

const folder = (over: Partial<UserFolder> = {}): UserFolder => ({
  id: 'uf_demo',
  name: 'demofolder',
  members: ['doc-plinth'],
  createdAt: 1,
  ...over,
});

const pkg = (documentId: string): DrawingUnderstandingPackage =>
  ({
    version: 1,
    projectId: 'proj-1',
    documentId,
    sourceDrawing: 'Plinth beam.dxf',
    sourceDrawingHash: 'doc:abc',
    createdAt: 5,
    sheetExtents: null,
    sections: [
      { sectionId: 'REGION-01', label: 'LAYOUT', kind: 'layout', entityCount: 10, bounds: {} },
      { sectionId: 'REGION-02', label: 'DETAIL', kind: 'detail', entityCount: 20, bounds: {} },
      { sectionId: 'REGION-03', label: 'SCHEDULE', kind: 'schedule', entityCount: 30, bounds: {} },
    ],
    requests: [],
    relationships: [],
    unresolved: [],
    coverage: { measurableEntities: 60, coveredEntities: 60, uncoveredEntities: 0, gaps: [] },
    summary: '',
    model: 'test',
    source: 'local',
  }) as unknown as DrawingUnderstandingPackage;

function build(
  entries: DrawingRegisterEntry[],
  folders: UserFolder[],
  split?: Map<string, { pkg: DrawingUnderstandingPackage }>,
) {
  const groups = buildGroupsForTest(
    entries,
    new Map(entries.map((e) => [e.documentId, `sheet-${e.documentId}`])),
    [],
    [],
    (split ?? new Map()) as never,
    folders,
  );
  const group = (id: string) => groups.find((g) => g.id === id);
  const named = (id: string, name: string): RegisterFolderNode | undefined =>
    group(id)?.folders.find((f) => f.name === name);
  return { groups, group, named };
}

const names = (f?: RegisterFolderNode): string[] => (f?.children ?? []).map((c) => c.name);
const ids = (f?: RegisterFolderNode): string[] => (f?.children ?? []).map((c) => c.id);
const groupsIds = (...fs: (RegisterFolderNode | undefined)[]): string[] => fs.flatMap((f) => ids(f));

// ------------------------------------------------------------
// filing
// ------------------------------------------------------------

describe('a drawing imported while a user folder is open', () => {
  it('appears in that folder', () => {
    const { named } = build([entry()], [folder()]);
    expect(names(named('g-folders', 'demofolder'))).toContain('Plinth beam.dxf');
  });

  it('keeps its Structural discipline as classification, carried on the row', () => {
    const { named } = build([entry()], [folder()]);
    // The discipline did not go anywhere — it is on the node, which is what
    // the DISCIPLINE column and the Details row read.
    const node = named('g-folders', 'demofolder')!.children[0] as RegisterNode & { discipline?: string };
    expect(node.discipline).toBe('Structural');
  });

  it('is no longer listed under the discipline folder as well', () => {
    // The complaint this rule exists for: two identical rows, and no way to
    // tell from the tree which was the filing and which the classification.
    const { named } = build([entry()], [folder()]);
    expect(named('g-drawings', 'Structural')).toBeUndefined();
  });

  it('goes back to its discipline folder when it is filed nowhere', () => {
    const { named } = build([entry()], []);
    expect(names(named('g-drawings', 'Structural'))).toEqual(['Plinth beam.dxf']);
    expect(named('g-folders', 'demofolder')).toBeUndefined();
  });

  it('leaves the discipline folder standing for the drawings still in it', () => {
    const filedOne = entry();
    const looseOne = entry({ id: 'drw_2', documentId: 'doc-slab', originalFileName: 'Slab.dxf' });
    const { named } = build([filedOne, looseOne], [folder()]);
    expect(names(named('g-drawings', 'Structural'))).toEqual(['Slab.dxf']);
    expect(names(named('g-folders', 'demofolder'))).toEqual(['Plinth beam.dxf']);
  });

  it('is ONE drawing, not two — same node, same documentId, one register entry', () => {
    // Filed in two folders at once, which "File into" allows: still one node
    // object, held by both. There is no path here that can mint a second
    // drawing record, and identity — not equality — is what proves it.
    const { named } = build(
      [entry()],
      [folder(), folder({ id: 'uf_b', name: 'Priced', members: ['doc-plinth'] })],
    );
    const a = named('g-folders', 'demofolder')!.children[0];
    const b = named('g-folders', 'Priced')!.children[0];
    expect(a).toBe(b);
    expect(a.id).toBe('drw_local_1');
    expect((a as { documentId?: string }).documentId).toBe('doc-plinth');
  });

  it('is listed once per folder even when filed under both of its keys', () => {
    // A membership written before `documentId` existed named the entry id.
    // Both must resolve — and both resolving must not mean two rows.
    const { named } = build([entry()], [folder({ members: ['doc-plinth', 'drw_local_1'] })]);
    expect(names(named('g-folders', 'demofolder'))).toEqual(['Plinth beam.dxf']);
  });

  it('resolves a membership stored under the OLD entry id, so nothing is orphaned', () => {
    const { named } = build([entry()], [folder({ members: ['drw_local_1'] })]);
    expect(names(named('g-folders', 'demofolder'))).toContain('Plinth beam.dxf');
  });

  it('survives a machine where the entry id came from the database instead', () => {
    // What `mergeEntries` produces on a browser with an empty IndexedDB: the
    // entry carries the DATABASE row id, not the local `drw_…` one. The
    // membership is stored under the documentId precisely so this still works.
    const { named } = build(
      [entry({ id: '3f7c1e5a-0000-4000-8000-000000000000' })],
      [folder({ members: ['doc-plinth'] })],
    );
    expect(names(named('g-folders', 'demofolder'))).toContain('Plinth beam.dxf');
  });

  it('carries a ghost row for a member that no longer exists', () => {
    const { named } = build([], [folder({ members: ['doc-deleted'] })]);
    expect(names(named('g-folders', 'demofolder'))).toEqual([]);
  });
});

// ------------------------------------------------------------
// the section folder
// ------------------------------------------------------------

describe('the section folder', () => {
  const split = () => new Map([['doc-plinth', { pkg: pkg('doc-plinth') }]]);

  it('is named section-<drawing name>, without the extension', () => {
    expect(sectionsFolderName('Plinth beam.dxf')).toBe('section-Plinth beam');
    expect(sectionsFolderName('Plinth beam')).toBe('section-Plinth beam');
  });

  it('sits inside the user folder that holds the drawing', () => {
    const { named } = build([entry()], [folder()], split());
    expect(names(named('g-folders', 'demofolder'))).toEqual([
      'Plinth beam.dxf',
      'section-Plinth beam',
    ]);
  });

  it('is NOT left behind under the discipline folder', () => {
    const { named } = build([entry()], [folder()], split());
    // Neither the sections nor the drawing: the whole thing moved.
    expect(named('g-drawings', 'Structural')).toBeUndefined();
  });

  it('holds one child per read region', () => {
    const { named } = build([entry()], [folder()], split());
    const sections = named('g-folders', 'demofolder')!.children[1] as RegisterFolderNode;
    expect(names(sections)).toEqual([
      'REGION-01 · LAYOUT',
      'REGION-02 · DETAIL',
      'REGION-03 · SCHEDULE',
    ]);
  });

  it('falls back to the discipline folder ONLY when nobody has filed the drawing', () => {
    // Not a contradiction of the rule above: with no user folder, the
    // discipline view IS the drawing's filing location, and dropping the
    // sections there would make them unreachable in the whole app.
    const { named } = build([entry()], [], split());
    expect(names(named('g-drawings', 'Structural'))).toEqual([
      'Plinth beam.dxf',
      'section-Plinth beam',
    ]);
  });

  it('moves with the drawing rather than staying where it was', () => {
    const { named } = build([entry()], [folder({ id: 'uf_b', name: 'other' })], split());
    expect(names(named('g-folders', 'other'))).toEqual(['Plinth beam.dxf', 'section-Plinth beam']);
    expect(named('g-drawings', 'Structural')).toBeUndefined();
  });

  it('is one folder keyed by the stable document id, never one per name', () => {
    const { named } = build([entry()], [folder()], split());
    const sections = named('g-folders', 'demofolder')!.children[1];
    expect(sections.id).toBe('f-sections-doc-plinth');
    // Exactly one, in exactly one place.
    const everywhere = groupsIds(named('g-folders', 'demofolder'), named('g-drawings', 'Structural'));
    expect(everywhere.filter((id) => id === 'f-sections-doc-plinth')).toHaveLength(1);
  });

  it('keeps two drawings’ section folders apart even with the same file name', () => {
    const a = entry({ id: 'drw_a', documentId: 'doc-a' });
    const b = entry({ id: 'drw_b', documentId: 'doc-b', discipline: 'architectural' });
    const splits = new Map([
      ['doc-a', { pkg: pkg('doc-a') }],
      ['doc-b', { pkg: pkg('doc-b') }],
    ]);
    const { named } = build(
      [a, b],
      [folder({ members: ['doc-a', 'doc-b'] })],
      splits as never,
    );
    const sectionIds = ids(named('g-folders', 'demofolder')).filter((id) =>
      id.startsWith('f-sections-'),
    );
    expect(sectionIds).toEqual(['f-sections-doc-a', 'f-sections-doc-b']);
  });
});

// ------------------------------------------------------------
// discipline never follows filing
// ------------------------------------------------------------

describe('discipline is never changed by where a drawing is filed', () => {
  it('stays whatever the sheet said, wherever it is filed', () => {
    const arch = entry({ discipline: 'architectural' });
    const { named } = build([arch], [folder()]);
    // Filed in demofolder, still an architectural drawing — and it says so on
    // the row, which is where the DISCIPLINE column and Details read it.
    const node = named('g-folders', 'demofolder')!.children[0] as { discipline?: string };
    expect(node.discipline).toBe('Architectural');
    // Taken out of every folder, it files itself by that same discipline.
    const loose = build([arch], []);
    expect(loose.named('g-drawings', 'Architectural')).toBeDefined();
    expect(loose.named('g-drawings', 'Structural')).toBeUndefined();
  });

  it('is unaffected by being filed into two folders at once', () => {
    const { named, group } = build(
      [entry()],
      [folder(), folder({ id: 'uf_b', name: 'Priced', members: ['doc-plinth'] })],
    );
    expect(group('g-folders')!.folders).toHaveLength(2);
    for (const name of ['demofolder', 'Priced']) {
      const node = named('g-folders', name)!.children[0] as { discipline?: string };
      expect(node.discipline).toBe('Structural');
    }
    // And filed twice is still not listed a third time under its discipline.
    expect(named('g-drawings', 'Structural')).toBeUndefined();
  });
});
