import { describe, expect, it } from 'vitest';
import {
  countAtPitch,
  requirePlacement,
  resolvePlacement,
  type MemberPlacement,
  type PlacementContext,
} from '../../src/cad/bbs/placement';
import type { EvidenceGraph, EvidenceNode } from '../../src/cad/bbs/evidence';

/**
 * A synthetic layout, laid out exactly like a boundary wall's:
 *
 *   C1 ─ SC ─ C2 ─ SC ─ C1 ─ SC ─ C1      nodes every 2000 mm
 *   0   2000 4000 6000 8000 10000 12000
 *
 * Template length is therefore 12000 + 2000 = 14000 mm, and C2 occurs once in
 * it — at 4000, a quarter of the way along. Those two facts are what the
 * phase tests below turn on.
 */
const LAYOUT: { id: string; mark: string; x: number }[] = [
  { id: 'MARK-C1-001', mark: 'C1', x: 0 },
  { id: 'MARK-SC-001', mark: 'SC', x: 2000 },
  { id: 'MARK-C2-001', mark: 'C2', x: 4000 },
  { id: 'MARK-SC-002', mark: 'SC', x: 6000 },
  { id: 'MARK-C1-002', mark: 'C1', x: 8000 },
  { id: 'MARK-SC-003', mark: 'SC', x: 10000 },
  { id: 'MARK-C1-003', mark: 'C1', x: 12000 },
];

function graph(): EvidenceGraph {
  const nodes: EvidenceNode[] = LAYOUT.map((m) => ({
    id: m.id,
    kind: 'mark',
    sourceHandles: [],
    panelId: 'PANEL-1',
    position: { x: m.x, y: 0 },
    rawText: m.mark,
    metadata: { mark: m.mark },
  }));
  nodes.push({
    id: 'PANEL-1',
    kind: 'panel',
    sourceHandles: [],
    metadata: { caption: 'layout' },
  });
  nodes.push({
    id: 'DIM-PITCH',
    kind: 'dimension',
    sourceHandles: [],
    rawText: '2000',
    valueParts: [2000],
    metadata: {},
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    nodes,
    edges: [],
    byId,
    dimensions: [],
    diagnostics: [],
    related: () => [],
    inPanel: (p) => nodes.filter((n) => n.panelId === p),
  };
}

const ctx = (runMm?: number): PlacementContext => ({
  graph: graph(),
  userFacts: runMm ? { run: { mm: runMm, saidAs: `${runMm / 1000} m` } } : {},
});

const occ = (mark: string): string[] => LAYOUT.filter((m) => m.mark === mark).map((m) => m.id);

describe('the fence-post, written once', () => {
  it('counts both ends on an exact multiple', () => {
    // 100 m at 10 m: 0,10,…,100 — eleven, not ten
    expect(countAtPitch(100000, 10000, 'both-ends')).toMatchObject({ count: 11, partial: false });
  });

  it('gives a short final bay its closing member', () => {
    // 0,10,…,90,95 — the 95 is real steel
    expect(countAtPitch(95000, 10000, 'both-ends')).toMatchObject({ count: 11, partial: true });
  });

  it('omits the closing member when only the start is occupied', () => {
    expect(countAtPitch(100000, 10000, 'start-only')).toMatchObject({ count: 10 });
    expect(countAtPitch(95000, 10000, 'start-only')).toMatchObject({ count: 10, partial: true });
  });

  it('a pitch wider than the span still leaves the two ends', () => {
    expect(countAtPitch(3000, 10000, 'both-ends').count).toBe(2);
    expect(countAtPitch(3000, 10000, 'start-only').count).toBe(1);
  });
});

describe('placement resolution', () => {
  it('NEVER turns an unknown into 1', () => {
    const r = resolvePlacement({ kind: 'unknown', reason: 'no layout was drawn' }, ctx(100000));
    expect(r.ok).toBe(false);
    expect(r.count).toBeUndefined();
    expect(r.reason).toMatch(/No count was assumed/);
  });

  it('treats a missing placement as unknown, not as one', () => {
    const p = requirePlacement(undefined, 'C1');
    expect(p.kind).toBe('unknown');
    expect(resolvePlacement(p, ctx(100000)).count).toBeUndefined();
  });

  it('refuses a pitch that resolves to zero rather than dividing by it', () => {
    const g = graph();
    g.byId.get('DIM-PITCH')!.valueParts = [0];
    const r = resolvePlacement(
      {
        kind: 'uniform',
        pitchRef: { kind: 'entity-number', evidenceId: 'DIM-PITCH', part: 1 },
        along: 'run',
        boundaryRule: 'both-ends',
        runFactId: 'run',
      },
      { graph: g, userFacts: { run: { mm: 100000 } } },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot space anything/);
  });

  it('a continuous member takes the run as its span, not a count', () => {
    const r = resolvePlacement({ kind: 'continuous', runFactId: 'run' }, ctx(100000));
    expect(r).toMatchObject({ ok: true, count: 1, continuous: true, spanMm: 100000 });
  });

  it('counts drawn tags when the layout IS the job', () => {
    const r = resolvePlacement({ kind: 'marks', markEvidenceIds: occ('C1') }, ctx());
    expect(r).toMatchObject({ ok: true, count: 3 });
  });

  it('names the occurrences it was given that do not exist', () => {
    const r = resolvePlacement({ kind: 'marks', markEvidenceIds: ['MARK-C1-001', 'MARK-XX-999'] }, ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/MARK-XX-999/);
  });
});

describe('a drawn layout is a template, not the job', () => {
  const tpl = (mark: string): MemberPlacement => ({
    kind: 'template-repeat',
    panelId: 'PANEL-1',
    runFactId: 'run',
    orderedOccurrenceIds: occ(mark),
  });

  it('measures the template from the marks, so every member shares one length', () => {
    // 14 m template over 98 m = exactly 7 repeats
    expect(resolvePlacement(tpl('C1'), ctx(98000))).toMatchObject({ ok: true, count: 21 });
    expect(resolvePlacement(tpl('SC'), ctx(98000))).toMatchObject({ ok: true, count: 21 });
    expect(resolvePlacement(tpl('C2'), ctx(98000))).toMatchObject({ ok: true, count: 7 });
  });

  it('does not apply one pitch independently to every mark', () => {
    // The prohibition made concrete: C1, SC and C2 sit at the same 2000 mm
    // pitch, and counting each of them at that pitch would give all three the
    // same count. C2 is periodic within the sequence and must stay rarer.
    const run = ctx(98000);
    const c1 = resolvePlacement(tpl('C1'), run).count!;
    const c2 = resolvePlacement(tpl('C2'), run).count!;
    expect(c2).toBeLessThan(c1);
    expect(c1 / c2).toBeCloseTo(3, 5);
  });

  it('preserves phase in a short tail — an early member appears, a late one does not', () => {
    // 14 m template + a 5 m tail. C2 sits at 4 m into the template, so it is
    // inside the tail; the C1 at 8 m and 12 m are not.
    const r2 = resolvePlacement(tpl('C2'), ctx(19000));
    expect(r2).toMatchObject({ ok: true, count: 2 }); // 1 whole + 1 in the tail
    const r1 = resolvePlacement(tpl('C1'), ctx(19000));
    expect(r1).toMatchObject({ ok: true, count: 4 }); // 3 whole + only the x=0 one
  });

  it('refuses a panel that does not exist rather than using the whole sheet', () => {
    // the silent fallback that produced counts ~50% high on a real sheet
    const r = resolvePlacement(
      { kind: 'template-repeat', panelId: 'PANEL-NOPE', runFactId: 'run', orderedOccurrenceIds: occ('C1') },
      ctx(98000),
    );
    expect(r.ok).toBe(false);
    expect(r.count).toBeUndefined();
    expect(r.reason).toMatch(/is not a panel on this sheet/);
  });

  it('refuses when the named panel carries no drawn sequence', () => {
    const base = graph();
    const empty: EvidenceNode = { id: 'PANEL-EMPTY', kind: 'panel', sourceHandles: [], metadata: {} };
    const nodes = [...base.nodes, empty];
    const g: EvidenceGraph = {
      ...base,
      nodes,
      byId: new Map(nodes.map((n) => [n.id, n])),
      inPanel: (pid) => nodes.filter((n) => n.panelId === pid),
    };
    const r = resolvePlacement(
      { kind: 'template-repeat', panelId: 'PANEL-EMPTY', runFactId: 'run', orderedOccurrenceIds: occ('C1') },
      { graph: g, userFacts: { run: { mm: 98000 } } },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no drawn sequence/);
  });

  it('refuses without a run rather than counting the template once', () => {
    const r = resolvePlacement(tpl('C1'), ctx());
    expect(r.ok).toBe(false);
    expect(r.count).toBeUndefined();
  });

  it('shows its working, so a reviewer can check the arithmetic', () => {
    const r = resolvePlacement(tpl('C1'), ctx(98000));
    expect(r.working).toMatch(/template 14000 mm/);
    expect(r.working).toMatch(/7 whole template/);
  });
});
