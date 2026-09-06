import { describe, expect, it } from 'vitest';
import {
  resolveAllPlacements,
  type MemberPlacementSpec,
  type PlacementContext,
} from '../../src/cad/bbs/placement';
import type { EvidenceGraph, EvidenceNode } from '../../src/cad/bbs/evidence';

const marks = (label: string, xs: number[], panel = 'PANEL-1'): EvidenceNode[] =>
  xs.map((x, i) => ({
    id: `MARK-${label}-${i}`,
    kind: 'mark',
    sourceHandles: [],
    panelId: panel,
    position: { x, y: 0 },
    metadata: { mark: label },
  }));

function graph(nodes: EvidenceNode[]): EvidenceGraph {
  const all = [
    ...nodes,
    { id: 'PANEL-1', kind: 'panel', sourceHandles: [], metadata: {} } as EvidenceNode,
    {
      id: 'DIM-PITCH',
      kind: 'dimension',
      sourceHandles: [],
      rawText: '4000',
      valueParts: [4000],
      metadata: {},
    } as EvidenceNode,
  ];
  return {
    nodes: all,
    edges: [],
    byId: new Map(all.map((n) => [n.id, n])),
    dimensions: [],
    diagnostics: [],
    related: () => [],
    inPanel: (p) => all.filter((n) => n.panelId === p),
  };
}

// span the whole 40 m run: "marks" asserts the drawn layout IS the job, and
// the engine now checks that claim against the supplied run
const COLUMNS = [0, 4000, 8000, 12000, 16000, 20000, 24000, 28000, 32000, 36000];
const ctx = (): PlacementContext => ({
  graph: graph([...marks('COL', COLUMNS), ...marks('SUB', [2000, 14000, 26000, 38000])]),
  userFacts: { run: { mm: 40000, saidAs: '40 m' } },
});

const uniformCol: MemberPlacementSpec = {
  memberId: 'm-col',
  placement: {
    kind: 'uniform',
    pitchRef: { kind: 'entity-number', evidenceId: 'DIM-PITCH', part: 1 },
    along: 'run',
    boundaryRule: 'both-ends',
    runFactId: 'run',
  },
};

describe('dependent placement is derived, never counted', () => {
  it('one footing per column, taken from the resolved parent', () => {
    const r = resolveAllPlacements(
      [
        uniformCol,
        { memberId: 'm-ftg', placement: { kind: 'dependent', parentMemberIds: ['m-col'], relation: 'one-per-parent' } },
      ],
      ctx(),
    );
    const col = r.get('m-col')!;
    const ftg = r.get('m-ftg')!;
    expect(col.ok).toBe(true);
    // 40 m at 4 m, both ends = 11
    expect(col.count).toBe(11);
    // and the footing EQUALS it — they cannot drift apart
    expect(ftg.count).toBe(col.count);
  });

  it('preserves provenance naming the parent instances', () => {
    const r = resolveAllPlacements(
      [
        uniformCol,
        { memberId: 'm-ftg', placement: { kind: 'dependent', parentMemberIds: ['m-col'], relation: 'one-per-parent' } },
      ],
      ctx(),
    );
    expect(r.get('m-ftg')!.derivedFrom).toEqual([{ memberId: 'm-col', count: 11 }]);
    expect(r.get('m-ftg')!.working).toMatch(/one per m-col \(11\)/);
  });

  it('sums several parent types', () => {
    const r = resolveAllPlacements(
      [
        uniformCol,
        { memberId: 'm-sub', placement: { kind: 'marks', markEvidenceIds: marks('SUB', [2000, 14000, 26000, 38000]).map((m) => m.id) } },
        {
          memberId: 'm-cap',
          placement: { kind: 'dependent', parentMemberIds: ['m-col', 'm-sub'], relation: 'one-per-parent' },
        },
      ],
      ctx(),
    );
    expect(r.get('m-cap')!.count).toBe(11 + 4);
    expect(r.get('m-cap')!.derivedFrom).toHaveLength(2);
  });

  it('one-per-bay counts the gaps, not the nodes', () => {
    const r = resolveAllPlacements(
      [
        uniformCol,
        { memberId: 'm-panel', placement: { kind: 'dependent', parentMemberIds: ['m-col'], relation: 'one-per-bay' } },
      ],
      ctx(),
    );
    expect(r.get('m-panel')!.count).toBe(10); // 11 posts, 10 bays
  });

  it('same-as-parent mirrors the parent exactly', () => {
    const r = resolveAllPlacements(
      [
        uniformCol,
        { memberId: 'm-starter', placement: { kind: 'dependent', parentMemberIds: ['m-col'], relation: 'same-as-parent' } },
      ],
      ctx(),
    );
    expect(r.get('m-starter')!.count).toBe(11);
    expect(r.get('m-starter')!.working).toMatch(/the same occurrences as/);
  });

  it('parents resolved by DIFFERENT strategies still feed a dependent', () => {
    const r = resolveAllPlacements(
      [
        { memberId: 'm-a', placement: { kind: 'marks', markEvidenceIds: marks('COL', COLUMNS).map((m) => m.id) } },
        { memberId: 'm-b', placement: { kind: 'once', evidenceId: 'MARK-SUB-0' } },
        { memberId: 'm-c', placement: { kind: 'dependent', parentMemberIds: ['m-a', 'm-b'], relation: 'one-per-parent' } },
      ],
      ctx(),
    );
    expect(r.get('m-c')!.count).toBe(10 + 1);
  });
});

describe('dependent placement refuses rather than substituting', () => {
  it('a missing parent leaves the child unresolved', () => {
    const r = resolveAllPlacements(
      [{ memberId: 'm-ftg', placement: { kind: 'dependent', parentMemberIds: ['m-nope'], relation: 'one-per-parent' } }],
      ctx(),
    );
    const ftg = r.get('m-ftg')!;
    expect(ftg.ok).toBe(false);
    expect(ftg.count).toBeUndefined();
    expect(ftg.reason).toMatch(/No independent count was substituted/);
  });

  it('an unresolved parent leaves the child unresolved', () => {
    const r = resolveAllPlacements(
      [
        { memberId: 'm-col', placement: { kind: 'unknown', reason: 'no layout drawn' } },
        { memberId: 'm-ftg', placement: { kind: 'dependent', parentMemberIds: ['m-col'], relation: 'one-per-parent' } },
      ],
      ctx(),
    );
    expect(r.get('m-ftg')!.ok).toBe(false);
    expect(r.get('m-ftg')!.count).toBeUndefined();
  });

  it('a parent that legitimately resolves to zero gives zero, not one', () => {
    const r = resolveAllPlacements(
      [
        { memberId: 'm-col', placement: { kind: 'marks', markEvidenceIds: [] } },
        { memberId: 'm-ftg', placement: { kind: 'dependent', parentMemberIds: ['m-col'], relation: 'one-per-parent' } },
      ],
      ctx(),
    );
    // an empty mark list is itself a refusal, so the child must not invent one
    expect(r.get('m-ftg')!.ok).toBe(false);
    expect(r.get('m-ftg')!.count).toBeUndefined();
  });

  it('detects a dependency cycle and names the loop', () => {
    const r = resolveAllPlacements(
      [
        { memberId: 'a', placement: { kind: 'dependent', parentMemberIds: ['b'], relation: 'one-per-parent' } },
        { memberId: 'b', placement: { kind: 'dependent', parentMemberIds: ['a'], relation: 'one-per-parent' } },
      ],
      ctx(),
    );
    expect(r.get('a')!.ok).toBe(false);
    const said = `${r.get('a')!.reason} ${r.get('b')!.reason}`;
    expect(said).toMatch(/placement cycle/);
  });

  it('detects a longer cycle through a chain', () => {
    const r = resolveAllPlacements(
      ['a', 'b', 'c'].map((id, i, all) => ({
        memberId: id,
        placement: { kind: 'dependent', parentMemberIds: [all[(i + 1) % all.length]], relation: 'one-per-parent' },
      })),
      ctx(),
    );
    expect([...r.values()].every((v) => !v.ok)).toBe(true);
  });

  it('a custom relation is reported, not approximated', () => {
    const r = resolveAllPlacements(
      [
        uniformCol,
        { memberId: 'm-x', placement: { kind: 'dependent', parentMemberIds: ['m-col'], relation: 'custom' } },
      ],
      ctx(),
    );
    expect(r.get('m-x')!.ok).toBe(false);
    expect(r.get('m-x')!.reason).toMatch(/no engine rule/);
  });

  it('a partial final run still keeps parent and child equal', () => {
    const partial: PlacementContext = { ...ctx(), userFacts: { run: { mm: 38500 } } };
    const r = resolveAllPlacements(
      [
        uniformCol,
        { memberId: 'm-ftg', placement: { kind: 'dependent', parentMemberIds: ['m-col'], relation: 'one-per-parent' } },
      ],
      partial,
    );
    expect(r.get('m-ftg')!.count).toBe(r.get('m-col')!.count);
  });
});
