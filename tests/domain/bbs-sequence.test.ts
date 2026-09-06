import { describe, expect, it } from 'vitest';
import { detectCycle, tileCycle, normaliseOccurrences, type Occurrence } from '../../src/cad/bbs/sequence';
import { buildPlacementBands, bandForMark } from '../../src/cad/bbs/bands';
import type { EvidenceGraph, EvidenceNode } from '../../src/cad/bbs/evidence';

/** build a labelled sequence from a compact spec: ['A',0], ['B',2000], … */
const seq = (spec: [string, number][]): Occurrence[] =>
  spec.map(([label, at], i) => ({ id: `O-${i}`, label, at }));

/** evenly spaced labels, repeated */
const repeat = (labels: string[], pitch: number, times: number): Occurrence[] => {
  const out: [string, number][] = [];
  for (let c = 0; c < times; c++) {
    labels.forEach((l, i) => out.push([l, (c * labels.length + i) * pitch]));
  }
  return seq(out);
};

describe('cycle detection distinguishes the layout kinds', () => {
  it('uniform repetition: cycle of one', () => {
    const r = detectCycle(repeat(['A'], 4000, 6));
    expect(r.ok).toBe(true);
    expect(r.cycle).toMatchObject({ size: 1, periodMm: 4000, labels: ['A'] });
  });

  it('alternating repetition: cycle of two, period is the PAIR not the gap', () => {
    // the exact failure the average gap caused: gaps are 2000, period is 4000
    const r = detectCycle(repeat(['A', 'B'], 2000, 5));
    expect(r.ok).toBe(true);
    expect(r.cycle!.size).toBe(2);
    expect(r.cycle!.periodMm).toBe(4000);
    expect(r.cycle!.labels).toEqual(['A', 'B']);
  });

  it('periodic special member: a rarer mark inside a longer cycle', () => {
    // A B A C — the C is an expansion-joint member appearing once per cycle
    const r = detectCycle(repeat(['A', 'B', 'A', 'C'], 2000, 3));
    expect(r.ok).toBe(true);
    expect(r.cycle!.size).toBe(4);
    expect(r.cycle!.periodMm).toBe(8000);
  });

  it('prefers the SMALLEST true cycle, never a multiple of it', () => {
    // A B repeated 6 times also "repeats" every 4; taking 4 would halve counts
    const r = detectCycle(repeat(['A', 'B'], 1000, 6));
    expect(r.cycle!.size).toBe(2);
  });

  it('non-repeating layout: refuses instead of inventing a period', () => {
    const r = detectCycle(seq([['A', 0], ['B', 1000], ['C', 4000], ['D', 9000]]));
    expect(r.ok).toBe(false);
    expect(r.cycle).toBeUndefined();
    expect(r.reason).toMatch(/no cycle repeats twice/);
  });

  it('irregular expansion gap: labels repeat but distances do not — refused', () => {
    const r = detectCycle(seq([
      ['A', 0], ['B', 2000],
      ['A', 4000], ['B', 6000],
      ['A', 11000], ['B', 13000], // an expansion joint widened this bay
    ]));
    expect(r.ok).toBe(false);
    expect(r.notes.join(' ')).toMatch(/period varies/);
  });

  it('a group shown only once is not a cycle', () => {
    const r = detectCycle(seq([['A', 0], ['B', 2000], ['C', 4000]]));
    expect(r.ok).toBe(false);
  });

  it('duplicate marks at one position collapse', () => {
    const list = normaliseOccurrences(seq([['A', 0], ['A', 10], ['B', 2000]]));
    expect(list).toHaveLength(2);
  });

  it('reversed drawing direction gives the same cycle', () => {
    const forward = detectCycle(repeat(['A', 'B'], 2000, 4));
    const reversed = detectCycle([...repeat(['A', 'B'], 2000, 4)].reverse());
    expect(reversed.cycle!.periodMm).toBe(forward.cycle!.periodMm);
    expect(reversed.cycle!.size).toBe(forward.cycle!.size);
  });
});

describe('tiling keeps phase over a partial final cycle', () => {
  const cycle = detectCycle(repeat(['A', 'B', 'A', 'C'], 2000, 3)).cycle!;
  // one cycle = A@0 B@2000 A@4000 C@6000, period 8000

  it('an exact number of cycles', () => {
    const t = tileCycle(cycle, { runMm: 24000, boundaryRule: 'start-only' });
    expect(t.counts).toEqual({ A: 6, B: 3, C: 3 });
  });

  it('an early member appears in a short tail; a late one does not', () => {
    // 8000 + a 3000 tail: reaches A@8000 and B@10000, not A@12000 or C@14000
    const t = tileCycle(cycle, { runMm: 11000, boundaryRule: 'start-only' });
    expect(t.counts.A).toBe(3); // 0, 4000, 8000
    expect(t.counts.B).toBe(2); // 2000, 10000
    expect(t.counts.C).toBe(1); // 6000 only
  });

  it('counts a tail by POSITION, never by proportion', () => {
    // a proportional split of a 50%-tail would give fractional members
    const t = tileCycle(cycle, { runMm: 12000, boundaryRule: 'start-only' });
    for (const v of Object.values(t.counts)) expect(Number.isInteger(v)).toBe(true);
  });

  it('both-ends includes a member landing exactly on the closing station', () => {
    const uniform = detectCycle(repeat(['A'], 5000, 4)).cycle!;
    expect(tileCycle(uniform, { runMm: 20000, boundaryRule: 'both-ends' }).counts.A).toBe(5);
    expect(tileCycle(uniform, { runMm: 20000, boundaryRule: 'start-only' }).counts.A).toBe(4);
  });

  it('shows its working', () => {
    const t = tileCycle(cycle, { runMm: 11000 });
    expect(t.working).toMatch(/every 8000 mm/);
    expect(t.working).toMatch(/tail, counted by position/);
  });
});

// ------------------------------------------------------------
// bands
// ------------------------------------------------------------

const markNode = (id: string, mark: string, x: number, y: number): EvidenceNode => ({
  id,
  kind: 'mark',
  sourceHandles: [],
  position: { x, y },
  metadata: { mark },
});

const graphOf = (nodes: EvidenceNode[]): EvidenceGraph => ({
  nodes,
  edges: [],
  byId: new Map(nodes.map((n) => [n.id, n])),
  dimensions: [],
  diagnostics: [],
  related: () => [],
  inPanel: (p) => nodes.filter((n) => n.panelId === p),
});

/** a horizontal row of tags at a given y */
const row = (prefix: string, marks: string[], y: number, pitch = 2000): EvidenceNode[] =>
  marks.map((m, i) => markNode(`${prefix}-${i}`, m, i * pitch, y));

describe('placement bands from geometry alone', () => {
  it('separates layouts stacked vertically', () => {
    const g = graphOf([
      ...row('a', ['A', 'A', 'A', 'A'], 0),
      ...row('b', ['B', 'C', 'B', 'C'], 40000),
      ...row('c', ['D', 'D', 'D', 'D'], 80000),
    ]);
    const { bands } = buildPlacementBands(g);
    expect(bands).toHaveLength(3);
    expect(bands.every((b) => b.axis === 'x')).toBe(true);
    expect(bands[0].tally).toEqual({ A: 4 });
  });

  it('separates layouts placed side by side on a vertical sheet', () => {
    const g = graphOf([
      ...['A', 'A', 'A', 'A'].map((m, i) => markNode(`l-${i}`, m, 0, i * 2000)),
      ...['B', 'B', 'B', 'B'].map((m, i) => markNode(`r-${i}`, m, 60000, i * 2000)),
    ]);
    const { bands } = buildPlacementBands(g);
    expect(bands).toHaveLength(2);
    expect(bands.every((b) => b.axis === 'y')).toBe(true);
  });

  it('excludes schedule-table marks and keeps them in diagnostics', () => {
    const table = ['t-0', 't-1', 't-2'];
    const g = graphOf([
      ...row('a', ['A', 'A', 'A', 'A'], 0),
      ...['A', 'B', 'C'].map((m, i) => markNode(`t-${i}`, m, 500, 40000 + i * 300)),
    ]);
    const { bands, diagnostics } = buildPlacementBands(g, { excludeIds: new Set(table) });
    expect(bands).toHaveLength(1);
    expect(diagnostics.join(' ')).toMatch(/schedule table/);
  });

  it('leaves a stray pair out of every band rather than merging it', () => {
    const g = graphOf([...row('a', ['A', 'A', 'A', 'A'], 0), markNode('s-0', 'X', 0, 40000), markNode('s-1', 'X', 2000, 40000)]);
    const { bands, diagnostics } = buildPlacementBands(g);
    expect(bands).toHaveLength(1);
    expect(diagnostics.join(' ')).toMatch(/too few to be a layout/);
  });

  it('is unaffected by the drawing running right-to-left', () => {
    const forward = buildPlacementBands(graphOf(row('a', ['A', 'B', 'A', 'B'], 0)));
    const reversed = buildPlacementBands(graphOf(row('a', ['A', 'B', 'A', 'B'], 0).reverse()));
    expect(reversed.bands[0].occurrenceIds).toEqual(forward.bands[0].occurrenceIds);
  });

  it('handles a layout carrying several member types', () => {
    const g = graphOf(row('a', ['A', 'B', 'A', 'C', 'A', 'B'], 0));
    const { bands } = buildPlacementBands(g);
    expect(bands[0].tally).toEqual({ A: 3, B: 2, C: 1 });
  });
});

describe('band selection reports ambiguity instead of guessing', () => {
  it('picks the layout that describes the mark most fully', () => {
    const g = graphOf([
      ...row('a', ['A', 'A', 'A', 'A'], 0), // A alone
      ...row('b', ['A', 'B', 'A', 'B'], 40000), // A in its sequence
    ]);
    const { bands } = buildPlacementBands(g);
    expect(bandForMark(bands, 'A').band?.id).toBe(bands[1].id);
  });

  it('accepts two layouts that describe it IDENTICALLY — they cannot disagree', () => {
    // a sheet draws the same column line on its footing plan and its tie-beam
    // plan; that is one layout seen twice, and refusing would block a schedule
    // over a distinction with no consequence
    const g = graphOf([
      ...row('a', ['A', 'B', 'A', 'B'], 0),
      ...row('b', ['A', 'B', 'A', 'B'], 40000),
    ]);
    const { bands } = buildPlacementBands(g);
    const hit = bandForMark(bands, 'A');
    expect(hit.band).toBeDefined();
    expect(hit.ambiguous).toBeUndefined();
  });

  it('refuses when two equally full layouts DISAGREE', () => {
    // same number of occurrences, different composition — counting from one
    // would give a different answer from the other
    const g = graphOf([
      ...row('a', ['A', 'B', 'A', 'B'], 0),
      ...row('b', ['A', 'C', 'A', 'A'], 40000),
    ]);
    const { bands } = buildPlacementBands(g);
    const hit = bandForMark(bands, 'A');
    expect(hit.band).toBeUndefined();
    expect(hit.ambiguous).toHaveLength(2);
    expect(hit.reason).toMatch(/DIFFERENTLY/);
  });

  it('says so when no band carries the mark at all', () => {
    const { bands } = buildPlacementBands(graphOf(row('a', ['A', 'A', 'A', 'A'], 0)));
    expect(bandForMark(bands, 'Z').reason).toMatch(/no layout band carries/);
  });
});
