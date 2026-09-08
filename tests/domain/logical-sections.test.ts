// ============================================================
// A VISUAL REGION IS NOT AN ENGINEERING SECTION.
//
// One column detail is drawn as four clusters — the section through the
// column, its dimension chain, the bar callouts leadered off to the side, a
// note underneath. Whitespace separates all four. Read as four sections, the
// detail loses three quarters of itself and the BBS sees a callout with no
// dimension and a dimension with no member.
//
// The required answer: section_count = 1, region_count = 4.
// ============================================================
import { describe, expect, it } from 'vitest';
import {
  SEMANTIC,
  SIGNAL_SCORE,
  groupRegions,
  marksIn,
  normaliseTitle,
  provenanceFor,
  renderSections,
  sectionOf,
  sectionOfRegion,
  sectionsForMark,
  subjectOf,
  titleOf,
  type GroupableRegion,
} from '../../src/cad/bbs/logicalSections';
import type { EvidenceEdge, EvidenceGraph, EvidenceNode } from '../../src/cad/bbs/evidence';

// ------------------------------------------------------------
// a sheet, built cluster by cluster
// ------------------------------------------------------------
type NodeSpec = {
  id: string;
  kind: EvidenceNode['kind'];
  x: number;
  y: number;
  text?: string;
  mark?: string;
  name?: string;
};

function sheet(specs: NodeSpec[], edges: EvidenceEdge[] = []): EvidenceGraph {
  const nodes: EvidenceNode[] = specs.map((s) => ({
    id: s.id,
    kind: s.kind,
    sourceHandles: [`H${s.id}`],
    position: { x: s.x, y: s.y },
    ...(s.text ? { rawText: s.text } : {}),
    metadata: {
      ...(s.mark ? { mark: s.mark } : {}),
      ...(s.name ? { name: s.name } : {}),
    },
  }));
  return {
    nodes,
    edges,
    byId: new Map(nodes.map((n) => [n.id, n])),
    dimensions: [],
    diagnostics: [],
    related: () => [],
    inPanel: () => [],
  };
}

const region = (
  id: string,
  ids: string[],
  bounds: { x1: number; y1: number; x2: number; y2: number },
  over: Partial<GroupableRegion> = {},
): GroupableRegion => ({ id, evidenceIds: ids, bounds, ...over });

/**
 * THE CASE FROM THE BRIEF. Section C1, drawn as four disconnected clusters:
 *   REGION-01 the column geometry, tagged C1
 *   REGION-02 the reinforcement callouts, leadered onto that geometry
 *   REGION-03 the dimension chain — no mark, no title of its own
 *   REGION-04 a note under the detail
 */
function c1Sheet() {
  const graph = sheet(
    [
      // geometry
      { id: 'MARK-C1', kind: 'mark', x: 100, y: 900, text: 'C1', mark: 'C1' },
      { id: 'DECL-C1', kind: 'declaration', x: 100, y: 1000, text: 'TYPICAL COLUMN DETAIL C1', name: 'C1' },
      { id: 'DIM-A', kind: 'dimension', x: 140, y: 880, text: '300' },
      { id: 'DIM-B', kind: 'dimension', x: 160, y: 860, text: '300' },
      // callouts, far to the right
      { id: 'CALL-1', kind: 'callout', x: 2400, y: 900, text: '8-T16' },
      { id: 'CALL-2', kind: 'callout', x: 2400, y: 860, text: 'T8 @ 150 c/c' },
      { id: 'LEAD-1', kind: 'leader', x: 1400, y: 900 },
      { id: 'LEAD-2', kind: 'leader', x: 1400, y: 860 },
      // dimension chain, below — names nothing
      { id: 'DIM-C', kind: 'dimension', x: 120, y: 200, text: '2000' },
      { id: 'DIM-D', kind: 'dimension', x: 160, y: 200, text: '450' },
      { id: 'DIM-E', kind: 'dimension', x: 200, y: 200, text: '450' },
      { id: 'DIM-F', kind: 'dimension', x: 240, y: 200, text: '75' },
      // a note, further below
      { id: 'NOTE-1', kind: 'convention', x: 120, y: -400, text: 'ALL BARS Fe500' },
      { id: 'NOTE-2', kind: 'convention', x: 120, y: -440, text: 'CLEAR COVER 40' },
      { id: 'NOTE-3', kind: 'convention', x: 120, y: -480, text: 'LAPS 50d' },
      { id: 'NOTE-4', kind: 'convention', x: 120, y: -520, text: 'CONCRETE M25' },
    ],
    [
      // the leaders tie the callouts to the geometry they annotate
      { from: 'LEAD-1', to: 'CALL-1', rel: 'carries' },
      { from: 'LEAD-1', to: 'MARK-C1', rel: 'points-at' },
      { from: 'LEAD-2', to: 'CALL-2', rel: 'carries' },
      { from: 'LEAD-2', to: 'DIM-A', rel: 'points-at' },
    ],
  );
  const regions = [
    region('REGION-01', ['MARK-C1', 'DECL-C1', 'DIM-A', 'DIM-B'], { x1: 80, y1: 850, x2: 200, y2: 1020 }, {
      kind: 'section',
      label: 'TYPICAL COLUMN DETAIL C1',
    }),
    region('REGION-02', ['CALL-1', 'CALL-2', 'LEAD-1', 'LEAD-2'], { x1: 1380, y1: 840, x2: 2500, y2: 920 }, {
      kind: 'detail',
    }),
    region('REGION-03', ['DIM-C', 'DIM-D', 'DIM-E', 'DIM-F'], { x1: 100, y1: 180, x2: 260, y2: 220 }, {
      kind: 'unknown',
    }),
    region('REGION-04', ['NOTE-1', 'NOTE-2', 'NOTE-3', 'NOTE-4'], { x1: 100, y1: -540, x2: 400, y2: -380 }, {
      kind: 'notes',
    }),
  ];
  return { graph, regions };
}

describe('four visual clusters, one engineering section', () => {
  it('groups geometry, callouts, dimensions and notes into ONE section', () => {
    const { graph, regions } = c1Sheet();
    const { sections } = groupRegions(regions, graph);

    expect(sections).toHaveLength(1);
    expect(sections[0].regionIds).toEqual(['REGION-01', 'REGION-02', 'REGION-03', 'REGION-04']);
    expect(sections[0].regionIds).toHaveLength(4);
    expect(sections[0].marks).toEqual(['C1']);
    expect(sections[0].title).toBe('TYPICAL COLUMN DETAIL C1');
  });

  it('the section sees every entity in all four clusters together', () => {
    const { graph, regions } = c1Sheet();
    const [section] = groupRegions(regions, graph).sections;

    // the callout AND the dimension that fixes what it is spaced along
    expect(section.evidenceIds).toContain('CALL-2');
    expect(section.evidenceIds).toContain('DIM-C');
    expect(section.evidenceIds).toContain('NOTE-2');
    expect(section.evidenceIds).toHaveLength(16);
  });

  it('says why each cluster is in there', () => {
    const { graph, regions } = c1Sheet();
    const [section] = groupRegions(regions, graph).sections;
    const why = section.basis.join(' ');
    expect(why).toMatch(/leader runs from/);
    expect(why).toMatch(/names no member and carries no title/);
  });

  it('keeps the regions addressable — they are not dissolved', () => {
    const { graph, regions } = c1Sheet();
    const { sections } = groupRegions(regions, graph);
    for (const id of ['REGION-01', 'REGION-02', 'REGION-03', 'REGION-04']) {
      expect(sectionOfRegion(sections, id)!.id).toBe(sections[0].id);
    }
    // and the union bounds cover every cluster, so one crop shows the detail
    expect(sections[0].bounds).toEqual({ x1: 80, y1: -540, x2: 2500, y2: 1020 });
  });

  it('a fact read from any cluster carries the section AND every region', () => {
    const { graph, regions } = c1Sheet();
    const { sections } = groupRegions(regions, graph);

    const fromCallout = provenanceFor(sections, 'CALL-1');
    const fromDimension = provenanceFor(sections, 'DIM-C');
    expect(fromCallout.sectionId).toBe('SECTION-01');
    expect(fromDimension.sectionId).toBe(fromCallout.sectionId);
    expect(fromCallout.regionIds).toHaveLength(4);
    expect(fromDimension.regionIds).toEqual(fromCallout.regionIds);
  });

  it('is reported to the model as one section drawn across four regions', () => {
    const { graph, regions } = c1Sheet();
    const text = renderSections(groupRegions(regions, graph).sections);
    expect(text).toMatch(/SECTION-01 "TYPICAL COLUMN DETAIL C1"/);
    expect(text).toMatch(/drawn across 4 region\(s\): REGION-01, REGION-02, REGION-03, REGION-04/);
  });
});

// ------------------------------------------------------------
// what must still be separate
// ------------------------------------------------------------
describe('a different detail is a different section', () => {
  it('two details naming different members do not merge', () => {
    const graph = sheet([
      { id: 'M-C1', kind: 'mark', x: 0, y: 0, text: 'C1', mark: 'C1' },
      { id: 'D-C1', kind: 'declaration', x: 0, y: 40, text: 'COLUMN C1', name: 'C1' },
      { id: 'CA-1', kind: 'callout', x: 20, y: 20, text: '8-T16' },
      { id: 'DI-1', kind: 'dimension', x: 30, y: 10, text: '300' },
      { id: 'M-C2', kind: 'mark', x: 5000, y: 0, text: 'C2', mark: 'C2' },
      { id: 'D-C2', kind: 'declaration', x: 5000, y: 40, text: 'COLUMN C2', name: 'C2' },
      { id: 'CA-2', kind: 'callout', x: 5020, y: 20, text: '6-T20' },
      { id: 'DI-2', kind: 'dimension', x: 5030, y: 10, text: '400' },
    ]);
    const { sections } = groupRegions(
      [
        region('REGION-01', ['M-C1', 'D-C1', 'CA-1', 'DI-1'], { x1: 0, y1: 0, x2: 100, y2: 60 }),
        region('REGION-02', ['M-C2', 'D-C2', 'CA-2', 'DI-2'], { x1: 5000, y1: 0, x2: 5100, y2: 60 }),
      ],
      graph,
    );
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.marks)).toEqual([['C1'], ['C2']]);
  });

  it('a layout naming nine marks does not swallow the details it indexes', () => {
    const marks = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9'];
    const graph = sheet([
      ...marks.map((m, i) => ({ id: `TAG-${m}`, kind: 'mark' as const, x: i * 1000, y: 5000, text: m, mark: m })),
      { id: 'PLAN', kind: 'declaration' as const, x: 0, y: 5200, text: 'FOUNDATION LAYOUT PLAN' },
      { id: 'M-F1', kind: 'mark' as const, x: 0, y: 0, text: 'F1', mark: 'F1' },
      { id: 'D-F1', kind: 'declaration' as const, x: 0, y: 40, text: 'F1 SECTION', name: 'F1' },
      { id: 'CA-F1', kind: 'callout' as const, x: 20, y: 20, text: '10@150c/c' },
      { id: 'DI-F1', kind: 'dimension' as const, x: 30, y: 10, text: '2300' },
    ]);
    const { sections } = groupRegions(
      [
        region('REGION-01', [...marks.map((m) => `TAG-${m}`), 'PLAN'], { x1: 0, y1: 5000, x2: 9000, y2: 5200 }, {
          kind: 'layout',
          label: 'FOUNDATION LAYOUT PLAN',
        }),
        region('REGION-02', ['M-F1', 'D-F1', 'CA-F1', 'DI-F1'], { x1: 0, y1: 0, x2: 100, y2: 60 }, {
          kind: 'section',
          label: 'F1 SECTION',
        }),
      ],
      graph,
    );
    expect(sections).toHaveLength(2);
    expect(sections.find((s) => s.kind === 'layout')!.marks).toHaveLength(9);
    expect(sections.find((s) => s.kind === 'section')!.marks).toEqual(['F1']);
  });
});

// ------------------------------------------------------------
// the signals, one at a time
// ------------------------------------------------------------
describe('what puts two clusters together', () => {
  const twoClusters = (a: NodeSpec[], b: NodeSpec[], labels: [string?, string?] = []) => {
    const graph = sheet([...a, ...b]);
    return groupRegions(
      [
        region('REGION-01', a.map((n) => n.id), { x1: 0, y1: 0, x2: 100, y2: 100 }, labels[0] ? { label: labels[0] } : {}),
        region('REGION-02', b.map((n) => n.id), { x1: 4000, y1: 0, x2: 4100, y2: 100 }, labels[1] ? { label: labels[1] } : {}),
      ],
      graph,
    );
  };

  it('the same member mark', () => {
    const { sections } = twoClusters(
      [{ id: 'a1', kind: 'mark', x: 0, y: 0, text: 'PB01', mark: 'PB01' }, { id: 'a2', kind: 'dimension', x: 1, y: 1 }],
      [{ id: 'b1', kind: 'callout', x: 4000, y: 0, text: 'T12', mark: 'PB01' }, { id: 'b2', kind: 'dimension', x: 4001, y: 1 }],
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].basis.join(' ')).toMatch(/both describe PB01/);
  });

  it('the same title, however it is spelled', () => {
    const { sections } = twoClusters(
      [{ id: 'a1', kind: 'dimension', x: 0, y: 0 }],
      [{ id: 'b1', kind: 'dimension', x: 4000, y: 0 }],
      ['SECTION A-A', 'Section A-A (CONTD)'],
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].basis.join(' ')).toMatch(/continuation/i);
    expect(normaliseTitle('SECTION A-A')).toBe(normaliseTitle('Section A-A (CONTD)'));
    expect(normaliseTitle('TYPICAL COLUMN DETAIL C1')).toBe('COLUMN C1');
  });

  it('a leader crossing between them', () => {
    const graph = sheet(
      [
        { id: 'geo', kind: 'mark', x: 0, y: 0, text: 'B1', mark: 'B1' },
        { id: 'lead', kind: 'leader', x: 2000, y: 0 },
        { id: 'call', kind: 'callout', x: 4000, y: 0, text: 'T10 @ 200' },
      ],
      [
        { from: 'lead', to: 'call', rel: 'carries' },
        { from: 'lead', to: 'geo', rel: 'points-at' },
      ],
    );
    const { sections } = groupRegions(
      [
        region('REGION-01', ['geo'], { x1: 0, y1: 0, x2: 100, y2: 100 }),
        region('REGION-02', ['lead', 'call'], { x1: 2000, y1: 0, x2: 4100, y2: 100 }),
      ],
      graph,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].basis.join(' ')).toMatch(/a leader runs from/);
  });

  it('proximity alone joins, but says so — POSSIBLE_CONTINUATION, not a claim', () => {
    const { sections } = twoClusters(
      [{ id: 'a1', kind: 'mark', x: 0, y: 0, text: 'C9', mark: 'C9' }],
      [{ id: 'b1', kind: 'dimension', x: 4000, y: 0 }],
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].relation).toBe('POSSIBLE_CONTINUATION');
    expect(sections[0].confidence).toBeLessThan(0.8);
    expect(sections[0].basis.join(' ')).toMatch(/proximity only, so confirm/);
  });

  it('a lone labelled cluster is its own section and says nothing joined it', () => {
    const graph = sheet([{ id: 'x', kind: 'mark', x: 0, y: 0, text: 'S1', mark: 'S1' }]);
    const { sections } = groupRegions([region('REGION-01', ['x'], { x1: 0, y1: 0, x2: 10, y2: 10 })], graph);
    expect(sections).toHaveLength(1);
    expect(sections[0].relation).toBe('CONFIRMED');
    expect(sections[0].basis[0]).toMatch(/stands alone/);
  });
});

describe('reading a region', () => {
  it('finds the marks and the title', () => {
    const { graph, regions } = c1Sheet();
    expect(marksIn(regions[0], graph)).toEqual(['C1']);
    expect(titleOf(regions[0], graph)).toBe('TYPICAL COLUMN DETAIL C1');
    expect(titleOf(regions[2], graph)).toBeUndefined();
  });

  it('finds every section describing a mark, and the section holding an entity', () => {
    const { graph, regions } = c1Sheet();
    const { sections } = groupRegions(regions, graph);
    expect(sectionsForMark(sections, 'c1').map((s) => s.id)).toEqual(['SECTION-01']);
    expect(sectionOf(sections, 'NOTE-3')!.id).toBe('SECTION-01');
    expect(sectionOf(sections, 'nothing-here')).toBeUndefined();
  });

  it('groups nothing when there is nothing to group', () => {
    expect(groupRegions([], sheet([])).sections).toEqual([]);
  });
});

// ------------------------------------------------------------
// what the BBS must see
// ------------------------------------------------------------
describe('a BBS fact belongs to the detail, not to the cluster', () => {
  it('every fact of one detail shares a section id and lists all four regions', () => {
    const { graph, regions } = c1Sheet();
    const { sections } = groupRegions(regions, graph);

    // three facts a schedule row needs, read from three different clusters
    const facts = ['CALL-2', 'DIM-C', 'NOTE-2'].map((evidenceId) => ({
      evidenceId,
      ...provenanceFor(sections, evidenceId),
    }));

    // none is orphaned, and none disagrees about which detail it came from
    expect(new Set(facts.map((f) => f.sectionId)).size).toBe(1);
    expect(facts.every((f) => f.sectionId === 'SECTION-01')).toBe(true);
    for (const f of facts) {
      expect(f.regionIds, f.evidenceId).toEqual(['REGION-01', 'REGION-02', 'REGION-03', 'REGION-04']);
    }
  });

  it('the required shape: section_count = 1, region_count = 4', () => {
    const { graph, regions } = c1Sheet();
    const { sections } = groupRegions(regions, graph);
    const sectionCount = sections.length;
    const regionCount = sections.reduce((n, s) => n + s.regionIds.length, 0);
    expect({ sectionCount, regionCount }).toEqual({ sectionCount: 1, regionCount: 4 });
    // and emphatically not one section per cluster
    expect(sectionCount).not.toBe(4);
  });

  it('a fact keeps its own entity handle, so the cluster is still addressable', () => {
    const { graph, regions } = c1Sheet();
    const { sections } = groupRegions(regions, graph);
    const node = graph.byId.get('DIM-C')!;
    const provenance = provenanceFor(sections, 'DIM-C');
    // the detail it belongs to, the clusters it is drawn across, and the
    // entity it was read from — all three survive
    expect(provenance.sectionId).toBe('SECTION-01');
    expect(provenance.regionIds).toContain('REGION-03');
    expect(node.sourceHandles).toEqual(['HDIM-C']);
  });
});

// ============================================================
// THE SPLITTER'S OWN REGIONS — labelled, with no evidence graph behind them
// ============================================================
//
// This is what the viewer draws: REGION-01 "PLAN - PEDESTAL P1", REGION-02
// "SECTION A-A - PEDESTAL P1", and so on. A plan and a section of one pedestal
// share no words but the ones that matter, so the subject is what is compared.
const P1_SHEET: GroupableRegion[] = [
  { id: 'REGION-01', label: 'PLAN - PEDESTAL P1', kind: 'plan', evidenceIds: ['e1'], bounds: { x1: 0, y1: 1000, x2: 900, y2: 1900 } },
  { id: 'REGION-02', label: 'SECTION A-A - PEDESTAL P1', kind: 'section', evidenceIds: ['e2'], bounds: { x1: 1100, y1: 1000, x2: 2000, y2: 1900 } },
  { id: 'REGION-03', label: '20-16 vertical bars', kind: 'detail', evidenceIds: ['e3'], bounds: { x1: 2200, y1: 1500, x2: 2900, y2: 1700 } },
  { id: 'REGION-04', label: '10-150 c/c', kind: 'detail', evidenceIds: ['e4'], bounds: { x1: 2200, y1: 1200, x2: 2900, y2: 1400 } },
  { id: 'REGION-05', label: 'CLEAR COVER 40', kind: 'notes', evidenceIds: ['e5'], bounds: { x1: 0, y1: 600, x2: 900, y2: 800 } },
];

/** what the app knows and this module does not: which words are member marks */
const marksInLabel = (label: string): string[] =>
  [...label.toUpperCase().matchAll(/\b(P\d{1,3}|C\d{1,3}|F\d{1,3}|PB\d{1,3})\b/g)].map((m) => m[1]);

describe('the validation case: five regions, one pedestal', () => {
  it('logical_sections = 1, visual_regions = 5', () => {
    const { sections } = groupRegions(P1_SHEET, undefined, { marksInLabel });
    expect(sections).toHaveLength(1);
    expect(sections[0].regionIds).toEqual(['REGION-01', 'REGION-02', 'REGION-03', 'REGION-04', 'REGION-05']);
    expect(sections[0].marks).toEqual(['P1']);
  });

  it('the plan and the section are two views of one detail, not two details', () => {
    expect(subjectOf('PLAN - PEDESTAL P1')).toBe('PEDESTAL P1');
    expect(subjectOf('SECTION A-A - PEDESTAL P1')).toBe('PEDESTAL P1');
    expect(subjectOf('SECTION A-A')).toBe('');

    const { sections } = groupRegions(P1_SHEET.slice(0, 2), undefined, {});
    expect(sections).toHaveLength(1);
    expect(sections[0].basis.join(' ')).toMatch(/two views of PEDESTAL P1/);
  });

  it('the reinforcement, spacing and cover are not orphaned outside the geometry', () => {
    const { sections } = groupRegions(P1_SHEET, undefined, { marksInLabel });
    for (const id of ['REGION-03', 'REGION-04', 'REGION-05']) {
      expect(sectionOfRegion(sections, id)!.id, id).toBe('SECTION-01');
    }
  });

  it('every DataFact from any of the five carries the one section id', () => {
    const { sections } = groupRegions(P1_SHEET, undefined, { marksInLabel });
    for (const e of ['e1', 'e2', 'e3', 'e4', 'e5']) {
      const p = provenanceFor(sections, e);
      expect(p.sectionId, e).toBe('SECTION-01');
      expect(p.regionIds, e).toHaveLength(5);
    }
  });
});

describe('the second validation case: two unrelated details, drawn close', () => {
  it('stays two sections — proximity is not evidence', () => {
    const close: GroupableRegion[] = [
      { id: 'REGION-01', label: 'PLAN - PEDESTAL P1', kind: 'plan', evidenceIds: ['a'], bounds: { x1: 0, y1: 0, x2: 500, y2: 500 } },
      // 100 mm away — closer than P1's own notes were
      { id: 'REGION-02', label: 'PLAN - PEDESTAL P2', kind: 'plan', evidenceIds: ['b'], bounds: { x1: 600, y1: 0, x2: 1100, y2: 500 } },
    ];
    const { sections } = groupRegions(close, undefined, { marksInLabel });
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.marks)).toEqual([['P1'], ['P2']]);
  });

  it('and a shared note between them attaches to the nearer, flagged', () => {
    const withNote: GroupableRegion[] = [
      { id: 'REGION-01', label: 'PLAN - PEDESTAL P1', kind: 'plan', evidenceIds: ['a'], bounds: { x1: 0, y1: 0, x2: 500, y2: 500 } },
      { id: 'REGION-02', label: 'PLAN - PEDESTAL P2', kind: 'plan', evidenceIds: ['b'], bounds: { x1: 5000, y1: 0, x2: 5500, y2: 500 } },
      { id: 'REGION-03', kind: 'notes', evidenceIds: ['c'], bounds: { x1: 100, y1: -300, x2: 400, y2: -100 } },
    ];
    const { sections } = groupRegions(withNote, undefined, { marksInLabel });
    expect(sections).toHaveLength(2);
    const p1 = sections.find((s) => s.marks.includes('P1'))!;
    expect(p1.regionIds).toEqual(['REGION-01', 'REGION-03']);
    expect(p1.relation).toBe('POSSIBLE_CONTINUATION');
  });
});

describe('a GAP is not an engineering section', () => {
  const gapSheet = (joins: string[]): GroupableRegion[] => [
    { id: 'REGION-01', label: 'PLAN - PEDESTAL P1', kind: 'plan', evidenceIds: ['a'], bounds: { x1: 0, y1: 0, x2: 500, y2: 500 } },
    { id: 'REGION-02', label: 'SECTION A-A - PEDESTAL P1', kind: 'section', evidenceIds: ['b'], bounds: { x1: 600, y1: 0, x2: 1100, y2: 500 } },
    { id: 'GAP-01', kind: 'unknown', evidenceIds: ['g'], isGap: true, joins, bounds: { x1: 300, y1: 520, x2: 700, y2: 620 } },
  ];

  it('attaches to the detail it touches instead of becoming its own', () => {
    const { sections } = groupRegions(gapSheet(['REGION-01', 'REGION-02']), undefined, { marksInLabel });
    expect(sections).toHaveLength(1);
    expect(sections[0].regionIds).toContain('GAP-01');
    expect(sections[0].basis.join(' ')).toMatch(/GAP-01 was not placed by the splitter/);
    // everything it touches was already one detail, so this is not a guess
    expect(sections[0].relation).toBe('CONFIRMED');
  });

  it('a gap touching two different details goes to the nearer, and is flagged', () => {
    const two: GroupableRegion[] = [
      { id: 'REGION-01', label: 'PLAN - PEDESTAL P1', kind: 'plan', evidenceIds: ['a'], bounds: { x1: 0, y1: 0, x2: 500, y2: 500 } },
      { id: 'REGION-02', label: 'PLAN - PEDESTAL P2', kind: 'plan', evidenceIds: ['b'], bounds: { x1: 5000, y1: 0, x2: 5500, y2: 500 } },
      { id: 'GAP-01', kind: 'unknown', evidenceIds: ['g'], isGap: true, joins: ['REGION-01', 'REGION-02'], bounds: { x1: 520, y1: 0, x2: 700, y2: 200 } },
    ];
    const { sections } = groupRegions(two, undefined, { marksInLabel });
    expect(sections).toHaveLength(2);
    const withGap = sections.find((s) => s.regionIds.includes('GAP-01'))!;
    expect(withGap.marks).toEqual(['P1']);
    expect(withGap.relation).toBe('POSSIBLE_CONTINUATION');
  });

  it('a gap touching nothing is not orphaned — it goes to the nearest detail', () => {
    const { sections } = groupRegions(gapSheet([]), undefined, { marksInLabel });
    expect(sections).toHaveLength(1);
    expect(sections[0].regionIds).toContain('GAP-01');
    expect(sections[0].relation).toBe('POSSIBLE_CONTINUATION');
  });
});

describe('the scoring model is explicit', () => {
  it('ranks the signals, and says what a join rested on', () => {
    expect(SIGNAL_SCORE.sameMark).toBeGreaterThanOrEqual(SEMANTIC);
    expect(SIGNAL_SCORE.sameSubject).toBeGreaterThanOrEqual(SEMANTIC);
    expect(SIGNAL_SCORE.leader).toBeGreaterThanOrEqual(SEMANTIC);
    expect(SIGNAL_SCORE.gapTouches).toBeGreaterThanOrEqual(SEMANTIC);
    // proximity is NOT enough on its own
    expect(SIGNAL_SCORE.proximity).toBeLessThan(SEMANTIC);

    const { sections } = groupRegions(P1_SHEET, undefined, { marksInLabel });
    expect(sections[0].basis.join(' ')).toMatch(/\[100\]/);
  });
});
