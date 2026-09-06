// References: the closed set, and every way it must refuse.
//
// A reference is how a number gets from the drawing into steel. The tests that
// matter most here are the REJECTIONS — a reference that half-resolves, or one
// that sums three dimensions that do not touch, produces a number with the
// shape of provenance and none of the substance.
import { describe, expect, it } from 'vitest';
import {
  looksLikeRef,
  resolveRef,
  toMillimetres,
  type ResolveContext,
} from '../../src/cad/bbs/refs';
import type { DimensionEvidence, EvidenceGraph, EvidenceNode } from '../../src/cad/bbs/evidence';

/** a chain of vertical dimensions drawn end to end, as a section carries them */
function graph(): EvidenceGraph {
  const dim = (
    id: string,
    valueMm: number,
    y1: number,
    y2: number,
    axis: 'x' | 'y' = 'y',
  ): DimensionEvidence => ({
    id,
    kind: 'dimension',
    sourceHandles: [id],
    position: { x: 0, y: (y1 + y2) / 2 },
    valueParts: [valueMm],
    rawText: String(valueMm),
    valueMm,
    axis,
    from: { x: 0, y: y1 },
    to: { x: 0, y: y2 },
    metadata: {},
  });

  const dims: DimensionEvidence[] = [
    dim('DIM-001', 1500, 0, 1500),
    dim('DIM-002', 900, 1500, 2400),
    dim('DIM-003', 300, 2400, 2700),
    // a fourth, parallel but NOT touching the chain
    dim('DIM-004', 400, 5000, 5400),
    // and one on the other axis
    dim('DIM-005', 1800, 0, 1800, 'x'),
  ];
  const others: EvidenceNode[] = [
    { id: 'MARK-C1-001', kind: 'mark', sourceHandles: [], position: { x: 0, y: 0 }, metadata: {} },
    { id: 'TEXT-TOP', kind: 'text', sourceHandles: [], position: { x: 0, y: 2700 }, metadata: {} },
    {
      id: 'LVL-TOP',
      kind: 'text',
      sourceHandles: [],
      rawText: '+0.300',
      valueParts: [0.3],
      metadata: {},
    },
    {
      id: 'LVL-BOT',
      kind: 'text',
      sourceHandles: [],
      rawText: '-1.500',
      valueParts: [-1.5],
      metadata: {},
    },
    {
      id: 'TEXT-SIZE',
      kind: 'text',
      sourceHandles: [],
      rawText: '350x525',
      valueParts: [350, 525],
      metadata: {},
    },
  ];
  const nodes: EvidenceNode[] = [...dims, ...others];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    nodes,
    edges: [],
    byId,
    dimensions: dims,
    diagnostics: [],
    related: () => [],
    inPanel: () => [],
  };
}

const ctx = (): ResolveContext => ({
  graph: graph(),
  tables: [{ title: 'PEDESTAL SCHEDULE', rows: [['P1', '730x1275', '4']] }],
  userFacts: { run: { mm: 100000, saidAs: '100 m' } },
});

describe('unit normalisation', () => {
  it('reads a decimal level as metres and a plain integer as millimetres', () => {
    expect(toMillimetres(0.3, '+0.300')).toBe(300);
    expect(toMillimetres(-1.5, '-1.500')).toBe(-1500);
    expect(toMillimetres(1500, '1500')).toBe(1500);
    expect(toMillimetres(350, '350')).toBe(350);
  });

  it('does not turn a decimal millimetre dimension into metres', () => {
    // 1500.0 mm is a dimension; 1500 m is not a member
    expect(toMillimetres(1500.0, '1500.0')).toBe(1500);
  });
});

describe('scalar references', () => {
  it('reads the nth number out of a text', () => {
    const r = resolveRef({ kind: 'entity-number', evidenceId: 'TEXT-SIZE', part: 2 }, ctx());
    expect(r).toMatchObject({ ok: true, mm: 525 });
    expect(r.evidenceIds).toContain('TEXT-SIZE');
  });

  it('refuses a number index the text does not have, and says what it read', () => {
    const r = resolveRef({ kind: 'entity-number', evidenceId: 'TEXT-SIZE', part: 5 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no number 5/);
    expect(r.reason).toMatch(/350x525/);
  });

  it('refuses evidence that is not on the sheet', () => {
    const r = resolveRef({ kind: 'entity-number', evidenceId: 'DIM-999', part: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no evidence/);
  });

  it('reads a verified user fact and keeps its provenance', () => {
    const r = resolveRef({ kind: 'user-fact', factId: 'run' }, ctx());
    expect(r).toMatchObject({ ok: true, mm: 100000 });
    expect(r.evidenceIds).toEqual(['FACT-run']);
    expect(r.working).toMatch(/you told us/);
  });

  it('refuses a user fact nobody gave', () => {
    const r = resolveRef({ kind: 'user-fact', factId: 'height' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not on the record/);
  });

  it('reads a table cell by row, column and part', () => {
    const r = resolveRef(
      { kind: 'table-number', tableId: 'PEDESTAL SCHEDULE', row: 0, column: 1, part: 2 },
      ctx(),
    );
    expect(r).toMatchObject({ ok: true, mm: 1275 });
  });
});

describe('difference references', () => {
  it('subtracts two levels and normalises both to millimetres', () => {
    const r = resolveRef(
      {
        kind: 'difference',
        a: { kind: 'entity-number', evidenceId: 'LVL-TOP', part: 1 },
        b: { kind: 'entity-number', evidenceId: 'LVL-BOT', part: 1 },
      },
      ctx(),
    );
    expect(r).toMatchObject({ ok: true, mm: 1800 });
  });

  it('is absolute — the model need not know which level is higher', () => {
    const flip = (a: string, b: string) =>
      resolveRef(
        {
          kind: 'difference',
          a: { kind: 'entity-number', evidenceId: a, part: 1 },
          b: { kind: 'entity-number', evidenceId: b, part: 1 },
        },
        ctx(),
      );
    expect(flip('LVL-TOP', 'LVL-BOT').mm).toBe(flip('LVL-BOT', 'LVL-TOP').mm);
  });

  it('drops the whole value when one side fails, and names WHICH side', () => {
    const r = resolveRef(
      {
        kind: 'difference',
        a: { kind: 'entity-number', evidenceId: 'LVL-TOP', part: 1 },
        b: { kind: 'entity-number', evidenceId: 'NOPE', part: 1 },
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.mm).toBeUndefined();
    expect(r.reason).toMatch(/side b/);
  });

  it('refuses a zero span rather than reporting a 0 mm member', () => {
    const r = resolveRef(
      {
        kind: 'difference',
        a: { kind: 'entity-number', evidenceId: 'LVL-TOP', part: 1 },
        b: { kind: 'entity-number', evidenceId: 'LVL-TOP', part: 1 },
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
  });
});

describe('dimension-path references', () => {
  const path = (ids: string[], axis: 'x' | 'y' = 'y') => ({
    kind: 'dimension-path',
    axis,
    fromAnchor: 'MARK-C1-001',
    toAnchor: 'TEXT-TOP',
    segmentEvidenceIds: ids,
  });

  it('walks a connected chain and sums it', () => {
    const r = resolveRef(path(['DIM-001', 'DIM-002', 'DIM-003']), ctx());
    expect(r).toMatchObject({ ok: true, mm: 2700 });
    expect(r.working).toMatch(/chain verified/);
    expect(r.evidenceIds).toEqual(expect.arrayContaining(['DIM-001', 'DIM-002', 'DIM-003']));
  });

  it('accepts the segments in any order — the engine sorts them', () => {
    expect(resolveRef(path(['DIM-003', 'DIM-001', 'DIM-002']), ctx()).mm).toBe(2700);
  });

  it('refuses a broken chain and says how big the gap is', () => {
    const r = resolveRef(path(['DIM-001', 'DIM-004']), ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not span continuously/);
    // 1500 ends at 1500; DIM-004 starts at 5000
    expect(r.reason).toMatch(/3500 mm/);
  });

  it('tolerates a perpendicular offset between segments of one chain', () => {
    // extension lines touch different faces, so a real chain is never
    // perfectly collinear — this is the case that used to be rejected
    const g = graph();
    const shifted = g.dimensions.find((d) => d.id === 'DIM-002')!;
    shifted.from = { x: 50, y: 1500 };
    shifted.to = { x: 50, y: 2400 };
    const r = resolveRef(path(['DIM-001', 'DIM-002', 'DIM-003']), {
      graph: g,
      userFacts: {},
    });
    expect(r).toMatchObject({ ok: true, mm: 2700 });
  });

  it('refuses to sum segments drawn at different scales', () => {
    // a printed value that does not bear its neighbours' ratio to its own span
    // means the sheet mixes dimension scales; the total would be meaningless
    const g = graph();
    const odd = g.dimensions.find((d) => d.id === 'DIM-002')!;
    odd.from = { x: 0, y: 1500 };
    odd.to = { x: 0, y: 1950 }; // prints 900 over a 450 span; neighbours are 1:1
    const r = resolveRef(path(['DIM-001', 'DIM-002']), { graph: g, userFacts: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/different scales/);
  });

  it('refuses a segment on the wrong axis', () => {
    const r = resolveRef(path(['DIM-001', 'DIM-005']), ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/measures along x, not y/);
  });

  it('refuses a segment counted twice', () => {
    const r = resolveRef(path(['DIM-001', 'DIM-001']), ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/listed twice/);
  });

  it('refuses a segment that is not a dimension at all', () => {
    const r = resolveRef(path(['DIM-001', 'TEXT-SIZE']), ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/is text, not a dimension/);
  });

  // The anchors are provenance, not arithmetic. The chain's own segments are
  // what prove the span, and one live run lost every column height — having
  // chosen exactly the right segments — because it wrote "footing base" where
  // an evidence id was demanded. A label that is not an id is now reported in
  // the working rather than discarding a verified sum.
  it('keeps a verified chain when an anchor is named in words, and says so', () => {
    const r = resolveRef(
      { ...path(['DIM-001', 'DIM-002', 'DIM-003']), toAnchor: 'top of column (+300 LVL)' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.mm).toBe(2700);
    expect(r.working).toMatch(/named in words, not as evidence ids/);
    // and the label is NOT smuggled in as provenance
    expect(r.evidenceIds).not.toContain('top of column (+300 LVL)');
  });

  it('still records an anchor that IS an evidence id', () => {
    const r = resolveRef(
      { ...path(['DIM-001', 'DIM-002', 'DIM-003']), fromAnchor: 'MARK-C1-001', toAnchor: 'TEXT-TOP' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.evidenceIds).toContain('MARK-C1-001');
    expect(r.evidenceIds).toContain('TEXT-TOP');
    expect(r.working).not.toMatch(/named in words/);
  });

  it('a chain with no anchors at all still resolves on its own geometry', () => {
    const r = resolveRef(
      { kind: 'dimension-path', axis: 'y', segmentEvidenceIds: ['DIM-001', 'DIM-002', 'DIM-003'] },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.mm).toBe(2700);
  });

  it('a chain that does NOT join is still refused, anchors or no anchors', () => {
    const r = resolveRef(
      { kind: 'dimension-path', axis: 'y', segmentEvidenceIds: ['DIM-001', 'DIM-004'] },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not span continuously/);
  });

  it('refuses an empty path rather than returning zero', () => {
    const r = resolveRef(path([]), ctx());
    expect(r.ok).toBe(false);
    expect(r.mm).toBeUndefined();
  });
});

describe('the closed set', () => {
  it('rejects a general sum by name', () => {
    const r = resolveRef({ kind: 'sum', parts: [] }, ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not a permitted reference/);
    expect(r.reason).toMatch(/no general arithmetic/);
  });

  it('rejects a raw number smuggled where a reference belongs', () => {
    expect(resolveRef(2700, ctx()).ok).toBe(false);
    expect(resolveRef({ mm: 2700 }, ctx()).ok).toBe(false);
  });

  it('recognises exactly the permitted shapes', () => {
    expect(looksLikeRef({ kind: 'entity-number', evidenceId: 'X', part: 1 })).toBe(true);
    expect(looksLikeRef({ kind: 'difference' })).toBe(true);
    expect(looksLikeRef({ kind: 'dimension-path' })).toBe(true);
    expect(looksLikeRef({ kind: 'sum' })).toBe(false);
    expect(looksLikeRef(2700)).toBe(false);
  });
});

// A refusal that names the hole it found.
//
// One live run re-sent the same broken chain three times: the message said the
// segments did not join and left nowhere to go, while the graph held the very
// dimension that filled the gap. Naming it reports geometry the engine has
// already measured; which segments belong to the span stays the caller's call.
describe('dimension-path — the gap is described, not just declared', () => {
  const ctx = (): ResolveContext => ({ graph: graph() });

  it('names the dimension lying inside the gap when one is there', () => {
    // 1500 then 300, skipping the 900 that joins them
    const r = resolveRef(
      {
        kind: 'dimension-path', axis: 'y',
        fromAnchor: 'MARK-C1-001', toAnchor: 'TEXT-TOP',
        segmentEvidenceIds: ['DIM-001', 'DIM-003'],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not span continuously/);
    expect(r.reason).toMatch(/Dimension\(s\) lying in that 900 mm gap/);
    expect(r.reason).toMatch(/DIM-002 \(900\)/);
  });

  it('says so plainly when nothing on that axis fills the gap', () => {
    const r = resolveRef(
      {
        kind: 'dimension-path', axis: 'y',
        fromAnchor: 'MARK-C1-001', toAnchor: 'TEXT-TOP',
        // 2400→2700, then a dimension starting at 5000: the 2700–5000 gap
        // holds no dimension on this axis at all
        segmentEvidenceIds: ['DIM-003', 'DIM-004'],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Nothing on this axis was found inside that gap/);
  });

  it('a chain that does join is still summed, and gains no hint', () => {
    const r = resolveRef(
      {
        kind: 'dimension-path', axis: 'y',
        fromAnchor: 'MARK-C1-001', toAnchor: 'TEXT-TOP',
        segmentEvidenceIds: ['DIM-001', 'DIM-002', 'DIM-003'],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.mm).toBe(2700);
  });

  it('never offers a segment already used in the chain', () => {
    const r = resolveRef(
      {
        kind: 'dimension-path', axis: 'y',
        fromAnchor: 'MARK-C1-001', toAnchor: 'TEXT-TOP',
        segmentEvidenceIds: ['DIM-001', 'DIM-002', 'DIM-004'],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).not.toMatch(/DIM-001|DIM-002/);
  });
});
