// A RUN IS A ROW-SPECIFIC DEPENDENCY, NOT A UNIVERSAL ONE.
//
// A foundation plan was asked "What is the total run of this structure?" —
// nine times, once per footing mark — and when a person answered 160, the
// footing counts were then read as a template of a 160 m job. A run is the
// extent of a RUNNING structure; a pad footing on a grid has none. These tests
// pin the three things that decide whether the question is put at all:
// the caller's word, the member's kind, and — failing both — the shape of the
// drawn layout, where a two-dimensional spread of tags is a plan (the job)
// and a one-dimensional band could be a module.
import { describe, expect, it } from 'vitest';
import {
  isPlanLayout,
  isPlanSpread,
  resolveAllPlacements,
  resolvePlacement,
  type PlacementContext,
} from '../../src/cad/bbs/placement';
import { isLinearMark } from '../../src/cad/bbs/build';
import type { EvidenceGraph, EvidenceNode } from '../../src/cad/bbs/evidence';

function graphOf(tags: { id: string; mark: string; x: number; y: number }[]): EvidenceGraph {
  const nodes: EvidenceNode[] = tags.map((t) => ({
    id: t.id,
    kind: 'mark',
    sourceHandles: [],
    panelId: 'PANEL-1',
    position: { x: t.x, y: t.y },
    rawText: t.mark,
    metadata: { mark: t.mark },
  }));
  nodes.push({ id: 'PANEL-1', kind: 'panel', sourceHandles: [], metadata: { caption: 'layout' } });
  return {
    nodes,
    edges: [],
    byId: new Map(nodes.map((n) => [n.id, n])),
    dimensions: [],
    diagnostics: [],
    related: () => [],
    inPanel: (p) => nodes.filter((n) => n.panelId === p),
  };
}

/** F7 as a foundation plan draws it: a 5 × 8 grid, 6 m × 8 m bays */
const GRID = Array.from({ length: 40 }, (_, i) => ({
  id: `MARK-F7-${String(i + 1).padStart(3, '0')}`,
  mark: 'F7',
  x: (i % 8) * 6000,
  y: Math.floor(i / 8) * 8000,
}));
/** C1 as a boundary-wall sheet draws it: five tags in a line at one pitch */
const BAND = Array.from({ length: 5 }, (_, i) => ({ id: `MARK-C1-00${i + 1}`, mark: 'C1', x: i * 6237, y: 0 }));

const ctx = (graph: EvidenceGraph, over: Partial<PlacementContext> = {}): PlacementContext => ({
  graph,
  userFacts: {},
  ...over,
});

describe('the layout decides when nobody has said', () => {
  it('a grid of footings is a plan — counted, no run question', () => {
    const r = resolvePlacement({ kind: 'marks', markEvidenceIds: GRID.map((t) => t.id) }, ctx(graphOf(GRID)));
    expect(r.ok).toBe(true);
    expect(r.count).toBe(40);
    expect(r.unverifiedExtent).toBeUndefined();
    expect(r.working).toMatch(/plan, not a band/);
  });

  it('a band of columns is a claim — the run question stands', () => {
    const r = resolvePlacement({ kind: 'marks', markEvidenceIds: BAND.map((t) => t.id) }, ctx(graphOf(BAND)));
    expect(r.ok).toBe(true);
    expect(r.count).toBe(5);
    expect(r.unverifiedExtent?.field).toBe('run');
  });

  it('a run answered for something else does NOT turn a plan into a template', () => {
    // The very failure: "160" filed against `run`, and F7's 40 tags read as
    // a module of a 160 m job.
    const r = resolvePlacement(
      { kind: 'marks', markEvidenceIds: GRID.map((t) => t.id) },
      ctx(graphOf(GRID), { userFacts: { run: { mm: 160_000, saidAs: '160' } } }),
    );
    expect(r.ok).toBe(true);
    expect(r.count).toBe(40);
  });

  it('measures the spread rather than judging it', () => {
    const g = graphOf(GRID);
    expect(isPlanSpread(GRID.map((t) => g.byId.get(t.id)!), 'x')).toBe(true);
    const b = graphOf(BAND);
    expect(isPlanSpread(BAND.map((t) => b.byId.get(t.id)!), 'x')).toBe(false);
    // drafting scatter across a band is not a second dimension
    const scattered = BAND.map((t, i) => ({ ...t, y: (i % 2) * 40 }));
    const s = graphOf(scattered);
    expect(isPlanSpread(scattered.map((t) => s.byId.get(t.id)!), 'x')).toBe(false);
  });
});

describe("the caller's word overrides the layout", () => {
  it('runApplies: false — counted from tags, whatever the shape', () => {
    const r = resolvePlacement(
      { kind: 'marks', markEvidenceIds: BAND.map((t) => t.id) },
      ctx(graphOf(BAND), { runApplies: false, userFacts: { run: { mm: 100_000 } } }),
    );
    expect(r.ok).toBe(true);
    expect(r.count).toBe(5);
    expect(r.unverifiedExtent).toBeUndefined();
  });

  it('runApplies: true — a grid on a running structure still consults the run', () => {
    const r = resolvePlacement(
      { kind: 'marks', markEvidenceIds: GRID.map((t) => t.id) },
      ctx(graphOf(GRID), { runApplies: true }),
    );
    expect(r.unverifiedExtent?.field).toBe('run');
  });

  it('resolveAllPlacements answers per member, from the callback', () => {
    const both = graphOf([...GRID, ...BAND]);
    const out = resolveAllPlacements(
      [
        { memberId: 'MEM-F7', placement: { kind: 'marks', markEvidenceIds: GRID.map((t) => t.id) } },
        { memberId: 'MEM-C1', placement: { kind: 'marks', markEvidenceIds: BAND.map((t) => t.id) } },
      ],
      ctx(both, { runAppliesTo: (id) => (id === 'MEM-C1' ? true : undefined) }),
    );
    expect(out.get('MEM-F7')?.unverifiedExtent).toBeUndefined();
    expect(out.get('MEM-C1')?.unverifiedExtent?.field).toBe('run');
  });
});

describe('what counts as a running structure', () => {
  it('by the words in the mark or the declared type', () => {
    for (const mark of ['RCC WALL', 'TIE BEAM', 'BOUNDARY WALL', 'PB01', 'TB2', 'GB', 'PARAPET']) {
      expect(isLinearMark(mark), mark).toBe(true);
    }
    expect(isLinearMark('F7')).toBe(false);
    expect(isLinearMark('C1')).toBe(false);
    expect(isLinearMark('F7', 'plinth beam')).toBe(true);
    expect(isLinearMark('boundary wall')).toBe(true);
    expect(isLinearMark('foundation')).toBe(false);
  });
});

describe('the sheet decides for the rest', () => {
  it('a plan layout is recognised from a grid, not from a band', () => {
    const g = graphOf(GRID);
    expect(isPlanLayout(GRID.map((t) => g.byId.get(t.id)!))).toBe(true);
    const b = graphOf(BAND);
    expect(isPlanLayout(BAND.map((t) => b.byId.get(t.id)!))).toBe(false);
    // a mark in ONE ROW of the grid, judged alone, looks like a band —
    // which is why the orchestrator judges the sheet, not the mark
    const oneRow = GRID.filter((t) => t.y === 0);
    const o = graphOf(oneRow);
    expect(isPlanLayout(oneRow.map((t) => o.byId.get(t.id)!))).toBe(false);
  });
});
