// Search ranking (UI_REQUIREMENTS_UPDATE §6.3) and the location rule (§6.4).
//
// One synthetic project: two revisions of GW-01 (R1 superseded), a structural
// sheet, its split sections, a small fact ledger and the extracted
// marks/callouts. Every §6.1 example query must land on the right kind, the
// §6.3 tier order must hold, superseded hits are labelled and never hidden,
// and every hit carries enough to navigate.

import { describe, expect, it } from 'vitest';
import { buildProjectIndex } from '../../src/search/index';
import type { ProjectIndex } from '../../src/search/index';
import { search } from '../../src/search/query';
import type { SearchHit } from '../../src/search/types';
import { addFact, emptyLedger } from '../../src/facts/ledger';
import type { Fact } from '../../src/facts/types';
import type { DrawingRegisterEntry } from '../../src/register/types';
import type {
  DrawingSection,
  DrawingUnderstandingPackage,
} from '../../src/cad/understanding/types';

const JAN = Date.parse('2026-01-10T09:00:00Z');
const FEB = Date.parse('2026-02-05T09:00:00Z');
const MAR = Date.parse('2026-03-12T09:00:00Z');
const JUN = Date.parse('2026-06-18T09:00:00Z');

function entry(over: Partial<DrawingRegisterEntry>): DrawingRegisterEntry {
  return {
    id: 'drw_x',
    projectId: 'prj_1',
    documentId: 'doc_x',
    assetId: 'ast_x',
    originalFileName: 'sheet.dxf',
    displayName: 'sheet',
    drawingNumber: 'GW-01',
    identityKey: 'gw-01',
    title: 'General wall details',
    revision: 'R2',
    revisionRank: 2,
    issueDate: '2026-06-01',
    discipline: 'structural',
    health: 'ready',
    revisionState: 'current',
    versionNo: 1,
    versionCount: 1,
    importedAt: JUN,
    warnings: [],
    evidence: {},
    ...over,
  };
}

function section(over: Partial<DrawingSection>): DrawingSection {
  return {
    sectionId: 'REGION-01',
    label: 'SECTION AT 1-1',
    kind: 'detail',
    sourceDrawing: 'GW-01.dxf',
    sourceDrawingHash: 'hash-r2',
    bounds: { xMin: 100, yMin: 200, xMax: 1100, yMax: 900 },
    png: '',
    dxf: '',
    entityIds: ['E1'],
    evidenceIds: ['T1'],
    memberHints: [],
    calloutHints: [],
    orchestratorStep: 1,
    confidence: 0.9,
    entityCount: 1,
    limitations: [],
    ...over,
  };
}

function pkg(
  documentId: string,
  sections: DrawingSection[],
  createdAt = JUN,
): DrawingUnderstandingPackage {
  return {
    version: 1,
    projectId: 'prj_1',
    documentId,
    sourceDrawing: 'GW-01.dxf',
    sourceDrawingHash: 'hash-r2',
    createdAt,
    sheetExtents: null,
    sections,
    requests: [],
    relationships: [],
    unresolved: [],
    coverage: { measurableEntities: 0, coveredEntities: 0, uncoveredEntities: 0, gaps: [] },
    summary: '',
    model: 'test',
    source: 'local',
  };
}

function fact(over: Partial<Fact> & Pick<Fact, 'id' | 'state'>): Fact {
  return { value: null, readOn: '2026-06-18', ...over } as Fact;
}

function projectIndex(): ProjectIndex {
  let ledger = emptyLedger();
  ledger = addFact(
    ledger,
    fact({
      id: 'wall.total_run',
      state: 'SUPPLIED',
      value: 100000,
      unit: 'mm',
      saidAs: 'the wall is 100 m',
      suppliedBy: 'site engineer',
    }),
  );
  ledger = addFact(
    ledger,
    fact({
      id: 'TB.section',
      state: 'DECLARED',
      value: '350X400',
      source: {
        drawingNumber: 'GW-01',
        revision: 'R2',
        documentId: 'doc-gw01-r2',
        sectionId: 'REGION-12',
        handles: ['79A47'],
        rawText: '350X400',
      },
    }),
  );
  ledger = addFact(
    ledger,
    fact({ id: 'columns.main_pitch', state: 'MEASURED', value: 4157, unit: 'mm', method: 'buildPlacementBands()' }),
  );
  ledger = addFact(
    ledger,
    fact({ id: 'wall.corners', state: 'MISSING', ask: 'How many corners does the wall turn?' }),
  );

  return buildProjectIndex({
    registerEntries: [
      entry({
        id: 'drw_gw01_r1',
        documentId: 'doc-gw01-r1',
        revision: 'R1',
        revisionRank: 1,
        revisionState: 'superseded',
        importedAt: JAN,
      }),
      entry({ id: 'drw_gw01_r2', documentId: 'doc-gw01-r2', revision: 'R2', importedAt: JUN }),
      entry({
        id: 'drw_str001',
        documentId: 'doc-str001',
        drawingNumber: 'GAMCO-STR-001',
        title: 'Boundary wall details',
        revision: 'R0',
        revisionRank: 0,
        importedAt: FEB,
      }),
      entry({
        id: 'drw_c1100',
        documentId: 'doc-c1100',
        drawingNumber: 'GAMCO-C1-100',
        title: 'Compound layout',
        revision: 'R0',
        revisionRank: 0,
        importedAt: MAR,
      }),
    ],
    sections: [
      pkg('doc-gw01-r1', [section({ sectionId: 'REGION-01', label: 'OLD TIE BEAM DETAIL' })], JAN),
      pkg(
        'doc-gw01-r2',
        [
          section({
            sectionId: 'REGION-09',
            label: 'TIE BEAM LAYOUT',
            kind: 'layout',
            memberHints: [{ mark: 'TB', basis: 'title text' }],
          }),
          section({
            sectionId: 'REGION-12',
            label: 'C/S OF TB-(350X400)',
            calloutHints: ['2-16TOR+2-12TOR', '8 (2L)@150 C/C'],
          }),
        ],
        JUN,
      ),
    ],
    ledger,
    marks: [
      { documentId: 'doc-gw01-r1', marks: ['C1'] },
      {
        documentId: 'doc-gw01-r2',
        marks: ['C1', 'F1'],
        callouts: [
          { raw: '2-16TOR+2-12TOR', handle: '79A4C' },
          { raw: '8 (2L)@150 C/C', handle: '7A118' },
        ],
      },
    ],
  });
}

describe('§6.1 — every example query lands on the right kind', () => {
  const index = projectIndex();

  it('a drawing number fragment hits the drawing: STR-001', () => {
    const hits = search(index, 'STR-001');
    expect(hits[0].kind).toBe('drawing');
    expect(hits[0]).toMatchObject({ drawingNumber: 'GAMCO-STR-001', documentId: 'doc-str001' });
  });

  it('free text over the title hits the drawing: boundary wall', () => {
    const hits = search(index, 'boundary wall');
    expect(hits[0].kind).toBe('drawing');
    expect(hits[0]).toMatchObject({ documentId: 'doc-str001', matchedOn: 'title' });
  });

  it('a section label hits the section: tie beam layout', () => {
    const hits = search(index, 'tie beam layout');
    expect(hits[0].kind).toBe('section');
    expect(hits[0]).toMatchObject({ sectionId: 'REGION-09', parentDocumentId: 'doc-gw01-r2' });
  });

  it('a section id hits the section: REGION-12', () => {
    const hits = search(index, 'REGION-12');
    expect(hits[0].kind).toBe('section');
    expect(hits[0]).toMatchObject({ sectionId: 'REGION-12', matchedOn: 'sectionId' });
  });

  it('a fact key hits the fact: total_run', () => {
    const hits = search(index, 'total_run');
    expect(hits[0].kind).toBe('fact');
    expect(hits[0]).toMatchObject({ factId: 'wall.total_run', state: 'SUPPLIED' });
  });

  it('a fact value hits the fact: 100000', () => {
    const hits = search(index, '100000');
    const factHit = hits.find((h) => h.kind === 'fact');
    expect(factHit).toMatchObject({ factId: 'wall.total_run', matchedOn: 'value' });
  });

  it('a fact key fragment hits the fact: pitch', () => {
    const hits = search(index, 'pitch');
    expect(hits[0].kind).toBe('fact');
    expect(hits[0]).toMatchObject({ factId: 'columns.main_pitch', matchedOn: 'factKey' });
  });

  it('a MISSING fact is findable: corners', () => {
    const hits = search(index, 'corners');
    expect(hits[0].kind).toBe('fact');
    expect(hits[0]).toMatchObject({ factId: 'wall.corners', state: 'MISSING' });
  });

  it('a member mark hits the mark: C1', () => {
    const hits = search(index, 'C1');
    expect(hits[0].kind).toBe('mark');
    expect(hits[0]).toMatchObject({ text: 'C1' });
  });

  it('a compound callout fragment hits the callout: 2-16TOR', () => {
    const hits = search(index, '2-16TOR');
    const mark = hits.find((h) => h.kind === 'mark');
    expect(mark).toMatchObject({
      text: '2-16TOR+2-12TOR',
      documentId: 'doc-gw01-r2',
      handles: ['79A4C'],
      matchedOn: 'callout',
    });
  });

  it('a spacing callout hits despite spacing noise and leg qualifier: 8@150', () => {
    const hits = search(index, '8@150');
    const mark = hits.find((h) => h.kind === 'mark');
    expect(mark).toMatchObject({ text: '8 (2L)@150 C/C', handles: ['7A118'] });
  });

  it('matching is case-insensitive', () => {
    expect(search(index, 'region-12')[0]).toMatchObject({ kind: 'section', sectionId: 'REGION-12' });
    expect(search(index, 'c1')[0]).toMatchObject({ kind: 'mark', text: 'C1' });
    expect(search(index, 'TOTAL_RUN')[0]).toMatchObject({ kind: 'fact', factId: 'wall.total_run' });
  });
});

describe('§6.3 — ranking', () => {
  it('orders the tiers: exact mark > drawing number > section label > fact key > rawText', () => {
    // one token planted in all five places
    let ledger = emptyLedger();
    ledger = addFact(ledger, fact({ id: 'zzz.thing', state: 'DECLARED', value: 1 }));
    ledger = addFact(
      ledger,
      fact({
        id: 'other.fact',
        state: 'DECLARED',
        value: 42,
        source: { drawingNumber: 'DWG-ZZZ', revision: 'R0', rawText: 'ZZZ 42' },
      }),
    );
    const index = buildProjectIndex({
      registerEntries: [
        entry({ documentId: 'doc-z', drawingNumber: 'DWG-ZZZ', title: 'plain', importedAt: FEB }),
      ],
      sections: [pkg('doc-z', [section({ sectionId: 'REGION-77', label: 'ZZZ DETAIL' })], FEB)],
      ledger,
      marks: [{ documentId: 'doc-z', marks: ['ZZZ'] }],
    });

    const hits = search(index, 'ZZZ');
    const kindsInOrder = hits.map((h) => `${h.kind}:${h.matchedOn}`);
    expect(kindsInOrder).toEqual([
      'mark:mark',
      'drawing:drawingNumber',
      'section:label',
      'fact:factKey',
      'fact:rawText',
    ]);
  });

  it('an exact mark match outranks a drawing-number match on the same token', () => {
    const index = projectIndex();
    const hits = search(index, 'C1');
    expect(hits[0].kind).toBe('mark');
    const drawing = hits.find((h) => h.kind === 'drawing');
    expect(drawing).toMatchObject({ drawingNumber: 'GAMCO-C1-100' });
    expect(hits.indexOf(drawing!)).toBeGreaterThan(hits.indexOf(hits[0]));
  });

  it('current revisions rank above superseded ones — which stay, labelled', () => {
    const index = projectIndex();
    const hits = search(index, 'GW-01', { kinds: ['drawing'] });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ revision: 'R2', superseded: false });
    expect(hits[1]).toMatchObject({ revision: 'R1', superseded: true });
  });

  it('a section under a superseded drawing is labelled superseded, never hidden', () => {
    const index = projectIndex();
    const hits = search(index, 'OLD TIE BEAM');
    expect(hits[0]).toMatchObject({
      kind: 'section',
      sectionId: 'REGION-01',
      superseded: true,
    });
  });

  it('a mark on a superseded drawing ranks below the same mark on the current one', () => {
    const index = projectIndex();
    const hits = search(index, 'C1', { kinds: ['mark'] });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ documentId: 'doc-gw01-r2' });
    expect((hits[0] as { superseded?: boolean }).superseded).toBeUndefined();
    expect(hits[1]).toMatchObject({ documentId: 'doc-gw01-r1', superseded: true });
  });

  it('recency breaks ties, newest first', () => {
    const index = projectIndex();
    // GAMCO-C1-100 (March) and GAMCO-STR-001 (February): same prefix quality
    const hits = search(index, 'GAMCO', { kinds: ['drawing'] });
    expect(hits.map((h) => (h.kind === 'drawing' ? h.drawingNumber : ''))).toEqual([
      'GAMCO-C1-100',
      'GAMCO-STR-001',
    ]);
  });

  it('an empty query returns nothing', () => {
    expect(search(projectIndex(), '   ')).toEqual([]);
  });

  it('kinds and limit options restrict the result', () => {
    const index = projectIndex();
    const facts = search(index, 'wall', { kinds: ['fact'] });
    expect(facts.every((h) => h.kind === 'fact')).toBe(true);
    expect(search(index, 'GW-01', { limit: 1 })).toHaveLength(1);
  });
});

describe('§6.4 — a result is a location', () => {
  const index = projectIndex();
  const queries = [
    'GW-01',
    'STR-001',
    'boundary wall',
    'tie beam',
    'REGION-12',
    'total_run',
    '100000',
    'C1',
    '2-16TOR',
    '8@150',
    'corners',
  ];

  it('every hit of every kind carries enough to navigate and highlight', () => {
    const seen = new Set<SearchHit['kind']>();
    for (const q of queries) {
      for (const hit of search(index, q)) {
        seen.add(hit.kind);
        expect(hit.score).toBeGreaterThan(0);
        expect(hit.matchedOn).toBeTruthy();
        switch (hit.kind) {
          case 'drawing':
            expect(hit.documentId).toBeTruthy();
            expect(hit.drawingNumber).toBeTruthy();
            expect(hit.revision).toBeTruthy();
            expect(typeof hit.superseded).toBe('boolean');
            break;
          case 'section':
            expect(hit.sectionId).toBeTruthy();
            expect(hit.parentDocumentId).toBeTruthy();
            for (const v of [hit.bounds.xMin, hit.bounds.yMin, hit.bounds.xMax, hit.bounds.yMax]) {
              expect(Number.isFinite(v)).toBe(true);
            }
            break;
          case 'fact':
            expect(hit.factId).toBeTruthy();
            expect(hit.state).toBeTruthy();
            break;
          case 'mark':
            expect(hit.text).toBeTruthy();
            expect(hit.documentId).toBeTruthy();
            expect(Array.isArray(hit.handles)).toBe(true);
            break;
        }
      }
    }
    // the fixture exercises all four kinds
    expect([...seen].sort()).toEqual(['drawing', 'fact', 'mark', 'section']);
  });
});
