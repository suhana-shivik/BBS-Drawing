// Search index builders (UI_REQUIREMENTS_UPDATE §6.1) — every kind of row
// carries what its hit will need to navigate (§6.4), superseded sources stay
// in the index labelled, and the whole thing is rebuilt from plain inputs.

import { describe, expect, it } from 'vitest';
import {
  buildProjectIndex,
  indexDrawings,
  indexFacts,
  indexMarks,
  indexSections,
} from '../../src/search/index';
import type { MarkSource } from '../../src/search/index';
import { addFact, emptyLedger } from '../../src/facts/ledger';
import type { Ledger } from '../../src/facts/ledger';
import type { Fact } from '../../src/facts/types';
import type { DrawingRegisterEntry } from '../../src/register/types';
import type {
  DrawingSection,
  DrawingUnderstandingPackage,
} from '../../src/cad/understanding/types';

const JAN = Date.parse('2026-01-10T09:00:00Z');
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
    bounds: { xMin: 0, yMin: 0, xMax: 1000, yMax: 800 },
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
  return {
    value: null,
    readOn: '2026-06-18',
    ...over,
  } as Fact;
}

describe('indexDrawings', () => {
  it('maps a register entry to a navigable drawing row', () => {
    const rows = indexDrawings([
      entry({ documentId: 'doc-1', drawingNumber: 'GAMCO-STR-001', revision: 'R0' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      documentId: 'doc-1',
      drawingNumber: 'GAMCO-STR-001',
      revision: 'R0',
      superseded: false,
      recency: JUN,
    });
  });

  it('keeps superseded entries, labelled', () => {
    const rows = indexDrawings([
      entry({ documentId: 'doc-r1', revision: 'R1', revisionState: 'superseded' }),
      entry({ documentId: 'doc-r2', revision: 'R2', revisionState: 'current' }),
    ]);
    expect(rows.map((r) => r.superseded)).toEqual([true, false]);
  });
});

describe('indexSections', () => {
  const regions = [
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
  ];

  it('indexes label, kind, memberHints and calloutHints from packages (§6.1)', () => {
    const rows = indexSections([pkg('doc-gw01-r2', regions)]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sectionId: 'REGION-09',
      label: 'TIE BEAM LAYOUT',
      kind: 'layout',
      parentDocumentId: 'doc-gw01-r2',
      memberHints: ['TB'],
      recency: JUN,
    });
    expect(rows[1].calloutHints).toEqual(['2-16TOR+2-12TOR', '8 (2L)@150 C/C']);
    expect(rows[1].bounds).toEqual({ xMin: 0, yMin: 0, xMax: 1000, yMax: 800 });
  });

  it('accepts bare DrawingSection[], falling back to sourceDrawing as parent', () => {
    const rows = indexSections(regions);
    expect(rows).toHaveLength(2);
    expect(rows[0].parentDocumentId).toBe('GW-01.dxf');
  });

  it('returns nothing for an empty input', () => {
    expect(indexSections([])).toEqual([]);
  });
});

describe('indexFacts', () => {
  function ledgerFixture(): Ledger {
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
    // superseded history: the R1 reading, replaced by the R2 reading
    ledger = addFact(
      ledger,
      fact({
        id: 'TB.section',
        state: 'DECLARED',
        value: '350X400',
        source: {
          drawingNumber: 'GW-01',
          revision: 'R1',
          sectionId: 'REGION-12',
          rawText: '350X400',
        },
      }),
    );
    ledger = addFact(
      ledger,
      fact({
        id: 'TB.section',
        state: 'DECLARED',
        value: '350X450',
        source: {
          drawingNumber: 'GW-01',
          revision: 'R2',
          sectionId: 'REGION-12',
          rawText: '350X450',
        },
      }),
    );
    ledger = addFact(
      ledger,
      fact({ id: 'wall.corners', state: 'MISSING', ask: 'How many corners does the wall turn?' }),
    );
    return ledger;
  }

  it('indexes key, value, saidAs and rawText (§6.1)', () => {
    const rows = indexFacts(ledgerFixture());
    const run = rows.find((r) => r.factId === 'wall.total_run');
    expect(run).toMatchObject({
      state: 'SUPPLIED',
      valueText: '100000',
      saidAs: 'the wall is 100 m',
    });
    const tb = rows.find((r) => r.factId === 'TB.section');
    expect(tb).toMatchObject({ valueText: '350X450', rawText: '350X450' });
  });

  it('indexes only the current entry for an id — history stays in the ledger', () => {
    const rows = indexFacts(ledgerFixture());
    expect(rows.filter((r) => r.factId === 'TB.section')).toHaveLength(1);
  });

  it('indexes MISSING facts — the open question must be findable', () => {
    const rows = indexFacts(ledgerFixture());
    const missing = rows.find((r) => r.factId === 'wall.corners');
    expect(missing).toBeDefined();
    expect(missing!.state).toBe('MISSING');
    expect(missing!.valueText).toBe('');
  });
});

describe('indexMarks', () => {
  const sources: MarkSource[] = [
    {
      documentId: 'doc-gw01-r2',
      marks: ['C1', 'F1'],
      callouts: [
        { raw: '2-16TOR+2-12TOR', handle: '79A4C' },
        { raw: '8 (2L)@150 C/C', handle: '7A118' },
      ],
    },
  ];

  it('indexes member marks and callout raw text with their handles', () => {
    const rows = indexMarks(sources);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      text: 'C1',
      documentId: 'doc-gw01-r2',
      handles: [],
      markKind: 'mark',
    });
    const callout = rows.find((r) => r.text === '8 (2L)@150 C/C');
    expect(callout).toMatchObject({ markKind: 'callout', handles: ['7A118'] });
  });
});

describe('buildProjectIndex', () => {
  it('combines all four kinds and propagates superseded + recency from the register', () => {
    const index = buildProjectIndex({
      registerEntries: [
        entry({
          documentId: 'doc-gw01-r1',
          revision: 'R1',
          revisionState: 'superseded',
          importedAt: JAN,
        }),
        entry({ documentId: 'doc-gw01-r2', revision: 'R2', importedAt: JUN }),
      ],
      sections: [
        pkg('doc-gw01-r1', [section({ sectionId: 'REGION-01', label: 'OLD TIE BEAM DETAIL' })], JAN),
        pkg('doc-gw01-r2', [section({ sectionId: 'REGION-09', label: 'TIE BEAM LAYOUT' })], JUN),
      ],
      ledger: addFact(emptyLedger(), fact({ id: 'wall.total_run', state: 'SUPPLIED', value: 100000 })),
      marks: [
        { documentId: 'doc-gw01-r1', marks: ['C1'] },
        { documentId: 'doc-gw01-r2', marks: ['C1'] },
      ],
    });

    expect(index.drawings).toHaveLength(2);
    expect(index.sections).toHaveLength(2);
    expect(index.facts).toHaveLength(1);
    expect(index.marks).toHaveLength(2);

    const oldSection = index.sections.find((s) => s.sectionId === 'REGION-01')!;
    expect(oldSection.superseded).toBe(true);
    const newSection = index.sections.find((s) => s.sectionId === 'REGION-09')!;
    expect(newSection.superseded).toBe(false);

    const oldMark = index.marks.find((m) => m.documentId === 'doc-gw01-r1')!;
    expect(oldMark.superseded).toBe(true);
    expect(oldMark.recency).toBe(JAN);
    const newMark = index.marks.find((m) => m.documentId === 'doc-gw01-r2')!;
    expect(newMark.superseded).toBe(false);
    expect(newMark.recency).toBe(JUN);
  });

  it('builds from partial inputs — every piece is optional', () => {
    const index = buildProjectIndex({});
    expect(index).toEqual({ drawings: [], sections: [], facts: [], marks: [] });
  });
});
