// Identity, ownership and provenance — the contracts between passes.
//
// Everything here guards a defect observed in a real run, named in the test.
import { describe, expect, it } from 'vitest';
import { buildMemberRegistry, describeMember } from '../../src/cad/bbs/members';
import {
  auditOwnership,
  candidatesFor,
  ownedBy,
  renderCandidates,
  resolveOwnership,
  type OwnershipClaim,
} from '../../src/cad/bbs/ownership';
import { Ledgers, lostDimensions, steelByStage } from '../../src/cad/bbs/lifecycle';
import { resolveRef } from '../../src/cad/bbs/refs';
import type { EvidenceGraph, EvidenceNode } from '../../src/cad/bbs/evidence';
import type { DrawingExtract } from '../../src/cad/bbs/types';

const node = (id: string, kind: string, meta: Record<string, unknown>, over: Partial<EvidenceNode> = {}): EvidenceNode =>
  ({ id, kind, sourceHandles: [], metadata: meta, ...over }) as EvidenceNode;

function graphOf(nodes: EvidenceNode[]): EvidenceGraph {
  return {
    nodes,
    edges: [],
    byId: new Map(nodes.map((n) => [n.id, n])),
    dimensions: nodes.filter((n) => n.kind === 'dimension') as never,
    diagnostics: [],
    related: () => [],
    inPanel: (p) => nodes.filter((n) => n.panelId === p),
  };
}

// the shapes run 002 actually produced
const extract = (): DrawingExtract =>
  ({
    drawingName: 'sheet',
    marks: ['C1', 'C2', 'SC', 'F1', 'TB'],
    declared: [
      { name: 'TYPICAL DETAIL OF C1-350x350', sizeText: '350x350', dimsMm: [350, 350], occurrences: 1, raw: 'TYPICAL DETAIL OF C1-350x350', handles: [] },
      { name: 'C2- (350x525)', sizeText: '350x525', dimsMm: [350, 525], occurrences: 1, raw: 'C2- (350x525)', handles: [] },
      { name: 'S.C', sizeText: '350x350', dimsMm: [350, 350], occurrences: 1, raw: 'S.C 350x350', handles: [] },
      { name: 'RCC WALL', sizeText: '200THK', dimsMm: [200], occurrences: 1, raw: '200 THK. RCC WALL', handles: [] },
      { name: 'H-POLE', sizeText: '150X150X2400', dimsMm: [150, 150, 2400], occurrences: 1, raw: 'H-POLE (150X150X2400)', handles: [] },
    ],
    callouts: [],
    tables: [],
    notes: { notes: [] },
    unitScale: 1,
  }) as unknown as DrawingExtract;

describe('canonical member identity', () => {
  const reg = () =>
    buildMemberRegistry(
      extract(),
      graphOf([
        node('DECL-01', 'declaration', { name: 'TYPICAL DETAIL OF C1-350x350' }),
        node('MARK-C1-1', 'mark', { mark: 'C1' }),
        node('MARK-C1-2', 'mark', { mark: 'C1' }),
        node('DECL-02', 'declaration', { name: 'RCC WALL' }),
      ]),
    );

  it('folds a caption into the mark it names', () => {
    const r = reg();
    expect(r.resolve('TYPICAL DETAIL OF C1-350x350')?.mark).toBe('C1');
    expect(r.resolve('C1')?.mark).toBe('C1');
  });

  it('folds every alias run 002 invented into its real member', () => {
    const r = reg();
    // each of these became a SEPARATE member in the live run
    expect(r.resolve('C2 (525x350)')?.mark).toBe('C2');
    expect(r.resolve('C2- (350x525)')?.mark).toBe('C2');
    expect(r.resolve('TYPICAL DETAIL OF SC-350x350')?.mark).toBe('SC');
    expect(r.resolve('S.C')?.mark).toBe('SC');
    expect(r.resolve('H-POLE (150X150X2400)')?.mark).toBe('H-POLE');
  });

  it('does not let a short mark swallow a longer one', () => {
    const r = reg();
    expect(r.resolve('C2- (350x525)')?.mark).not.toBe('C1');
  });

  it('keeps a declaration that names no mark as a member in its own right', () => {
    // a wall carries steel whether or not anyone tagged it
    expect(reg().resolve('RCC WALL')?.mark).toBe('RCC WALL');
  });

  it('produces one member per real element, not fifteen', () => {
    const r = reg();
    // 5 marks + RCC WALL + H-POLE — the aliases fold in
    expect(r.members).toHaveLength(7);
  });

  it('describes a member by id, with its aliases as context only', () => {
    const c1 = reg().resolve('C1')!;
    const text = describeMember(c1);
    expect(text).toMatch(/MEMBER MEM-\d+/);
    expect(text).toMatch(/also written: "TYPICAL DETAIL OF C1-350x350"/);
  });

  it('reports a declaration it could not place rather than dropping it', () => {
    const r = buildMemberRegistry(
      { ...extract(), marks: [], declared: [] } as never,
      graphOf([node('DECL-9', 'declaration', { name: 'MYSTERY THING' })]),
    );
    expect(r.unmatched.some((u) => u.name === 'MYSTERY THING')).toBe(true);
  });
});

describe('candidates are restricted, and say why they were offered', () => {
  const callouts = [
    node('CALL-A', 'callout', {}, { panelId: 'DETAIL-1', position: { x: 0, y: 0 }, rawText: '8-12TOR' }),
    node('CALL-B', 'callout', {}, { panelId: 'DETAIL-2', position: { x: 50, y: 0 }, rawText: '12TOR@100C/C' }),
    node('CALL-C', 'callout', {}, { panelId: 'DETAIL-2', position: { x: 90000, y: 0 }, rawText: '10TOR@200C/C' }),
  ];
  const ctx = {
    member: { id: 'MEM-01', mark: 'C1', aliases: [], declarationIds: [], markEvidenceIds: [] },
    detailIds: ['DETAIL-1'],
    graph: { byId: new Map(), related: () => [] },
  } as never;

  it('puts a callout inside the member’s own detail first', () => {
    const c = candidatesFor(ctx, callouts, { x: 0, y: 0 });
    expect(c[0].node.id).toBe('CALL-A');
    expect(c[0].basis).toBe('in-detail');
  });

  it('ranks the rest by distance, so a far-away detail comes last', () => {
    const c = candidatesFor(ctx, callouts, { x: 0, y: 0 });
    expect(c[c.length - 1].node.id).toBe('CALL-C');
  });

  it('honours a limit rather than offering the whole sheet', () => {
    expect(candidatesFor(ctx, callouts, { x: 0, y: 0 }, 1)).toHaveLength(1);
  });

  it('states the basis for every candidate', () => {
    const text = renderCandidates(candidatesFor(ctx, callouts, { x: 0, y: 0 }));
    expect(text).toMatch(/inside the detail that draws this member/);
    expect(text).toMatch(/mm from it/);
  });

  it('says so plainly when nothing is near', () => {
    expect(renderCandidates([])).toMatch(/rather than reaching/);
  });
});

// ------------------------------------------------------------
// THE ONE THAT GATES THE NEXT LIVE RUN
// ------------------------------------------------------------

describe('a valid dimension survives from model reply to build input', () => {
  // the exact failure: the model answered for C1, SC, F1 and the wall, and the
  // finished schedule showed every dimension unresolved, with no record of where
  it('carries a pointer through parse → absorb → resolve → build, and traces it', () => {
    const dim = node('DIM-132', 'dimension', {}, { rawText: '350', valueParts: [350] });
    const graph = graphOf([dim]);
    const ledgers = new Ledgers();

    // 1. what the model returned, verbatim
    const modelOutput = { kind: 'entity-number', evidenceId: 'DIM-132', part: 1 };
    ledgers.dimFromModel('MEM-01', 'L', modelOutput);
    expect(ledgers.dims.get('MEM-01.L')!.reached).toBe('model-output');

    // 2. parsed
    ledgers.dimAdvance('MEM-01', 'L', 'parsed', { parsed: modelOutput });

    // 3. absorbed onto the draft
    ledgers.dimAdvance('MEM-01', 'L', 'absorbed', { absorbed: modelOutput });

    // 4. resolved by the engine — the step that must produce a NUMBER
    const res = resolveRef(modelOutput as never, { graph });
    expect(res.ok).toBe(true);
    expect(res.mm).toBe(350);
    ledgers.dimAdvance('MEM-01', 'L', 'resolved', { resolvedValue: res.mm });

    // 5. band-checked and 6. into build input
    ledgers.dimAdvance('MEM-01', 'L', 'band-checked');
    ledgers.dimAdvance('MEM-01', 'L', 'build-input');

    const trace = ledgers.dims.get('MEM-01.L')!;
    expect(trace.resolvedValue).toBe(350);
    expect(trace.reached).toBe('build-input');
    expect(trace.rejectedAt).toBeUndefined();
    // and nothing is reported lost
    expect(lostDimensions(ledgers)).toHaveLength(0);
  });

  it('names the stage that dropped a dimension, when one does', () => {
    const ledgers = new Ledgers();
    ledgers.dimFromModel('MEM-02', 'H', { kind: 'entity-number', evidenceId: 'DIM-999', part: 1 });
    ledgers.dimAdvance('MEM-02', 'H', 'parsed');
    ledgers.dimReject('MEM-02', 'H', 'resolved', 'DIM-999 is not evidence on this sheet');

    const lost = lostDimensions(ledgers);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatch(/MEM-02\.H/);
    expect(lost[0]).toMatch(/rejected at "resolved"/);
    expect(lost[0]).toMatch(/not evidence on this sheet/);
  });

  it('a dimension that stops with no reason is still reported', () => {
    // silence is the failure mode this exists to remove
    const ledgers = new Ledgers();
    ledgers.dimFromModel('MEM-03', 'W', {});
    expect(lostDimensions(ledgers)[0]).toMatch(/no reason recorded/);
  });
});

describe('the callout lifecycle explains where steel went', () => {
  it('reports, per diameter, the stage each callout reached', () => {
    const l = new Ledgers();
    l.calloutExtracted('CALL-001', '8-12TOR', 12);
    l.calloutExtracted('CALL-002', '8TOR@200C/C(LINK)', 8);
    l.calloutExtracted('CALL-003', '10TOR@200C/C', 10);

    l.calloutOffered('CALL-001', 'MEM-01');
    l.calloutAdvance('CALL-001', 'built', { ownerMemberId: 'MEM-01', buildRowIds: ['C1-M1'] });

    l.calloutOffered('CALL-002', 'MEM-01');
    l.calloutDropped('CALL-002', 'claimed', 'no member claimed it');

    l.calloutDropped('CALL-003', 'offered', 'never offered to any member');

    const report = steelByStage(l);
    expect(report).toMatch(/T12\s+1 callout\(s\): 1 built/);
    expect(report).toMatch(/T8\s+1 callout\(s\): 1 dropped at claimed/);
    expect(report).toMatch(/T10\s+1 callout\(s\): 1 dropped at offered/);
  });
});

// ------------------------------------------------------------
// ORDER INDEPENDENCE — the property the design exists for
// ------------------------------------------------------------

const claim = (calloutId: string, memberId: string, over: Partial<OwnershipClaim> = {}): OwnershipClaim => ({
  calloutId,
  memberId,
  basis: 'proximity',
  reason: `claimed by ${memberId}`,
  ...over,
});

const allIds = ['CALL-001', 'CALL-002', 'CALL-003', 'CALL-004'];

describe('ownership is decided by evidence, never by processing order', () => {
  const mixed: OwnershipClaim[] = [
    claim('CALL-001', 'MEM-02', { basis: 'proximity', distanceMm: 4000 }),
    claim('CALL-001', 'MEM-01', { basis: 'in-detail' }),
    claim('CALL-002', 'MEM-03', { basis: 'proximity', distanceMm: 300 }),
    claim('CALL-002', 'MEM-01', { basis: 'proximity', distanceMm: 9000 }),
  ];

  const ownersOf = (claims: OwnershipClaim[]): Record<string, string> => {
    const r = resolveOwnership({ allCalloutIds: allIds, claims });
    const out: Record<string, string> = {};
    for (const [id, d] of r.dispositions) out[id] = `${d.state}:${d.memberId ?? '-'}`;
    return out;
  };

  it('gives the identical result for every permutation of the claims', () => {
    const baseline = ownersOf(mixed);
    // every ordering of four claims — 24 permutations
    const permute = <T,>(xs: T[]): T[][] =>
      xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permute([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
    for (const order of permute(mixed)) {
      expect(ownersOf(order)).toEqual(baseline);
    }
  });

  it('containment beats proximity regardless of which claim arrived first', () => {
    expect(ownersOf(mixed)['CALL-001']).toBe('assigned:MEM-01');
    expect(ownersOf([...mixed].reverse())['CALL-001']).toBe('assigned:MEM-01');
  });

  it('a weaker basis never wins on arrival order', () => {
    const proximityFirst = [
      claim('CALL-003', 'MEM-09', { basis: 'proximity', distanceMm: 10 }),
      claim('CALL-003', 'MEM-01', { basis: 'leader-terminates' }),
    ];
    expect(ownersOf(proximityFirst)['CALL-003']).toBe('assigned:MEM-01');
  });
});

describe('ties are surfaced, not broken', () => {
  const resolve = (claims: OwnershipClaim[]) => resolveOwnership({ allCalloutIds: allIds, claims });

  it('two members claiming through in-detail leaves it unresolved', () => {
    const r = resolve([
      claim('CALL-001', 'MEM-01', { basis: 'in-detail' }),
      claim('CALL-001', 'MEM-02', { basis: 'in-detail' }),
    ]);
    const d = r.dispositions.get('CALL-001')!;
    expect(d.state).toBe('unresolved');
    expect(d.contenders?.map((c) => c.memberId).sort()).toEqual(['MEM-01', 'MEM-02']);
    expect(r.ambiguous).toHaveLength(1);
  });

  it('two members claiming through leader-terminates leaves it unresolved', () => {
    const d = resolve([
      claim('CALL-001', 'MEM-01', { basis: 'leader-terminates' }),
      claim('CALL-001', 'MEM-02', { basis: 'leader-terminates' }),
    ]).dispositions.get('CALL-001')!;
    expect(d.state).toBe('unresolved');
    expect(d.reason).toMatch(/equally good evidence/);
  });

  it('close proximity claims are unresolved rather than guessed', () => {
    const d = resolve([
      claim('CALL-001', 'MEM-01', { basis: 'proximity', distanceMm: 400 }),
      claim('CALL-001', 'MEM-02', { basis: 'proximity', distanceMm: 420 }),
    ]).dispositions.get('CALL-001')!;
    expect(d.state).toBe('unresolved');
  });

  it('clearly separated proximity claims produce one owner', () => {
    const d = resolve([
      claim('CALL-001', 'MEM-01', { basis: 'proximity', distanceMm: 400 }),
      claim('CALL-001', 'MEM-02', { basis: 'proximity', distanceMm: 9000 }),
    ]).dispositions.get('CALL-001')!;
    expect(d).toMatchObject({ state: 'assigned', memberId: 'MEM-01' });
  });
});

describe('every callout reaches exactly one terminal disposition', () => {
  it('covers assigned, shared, excluded and unclaimed in one pass', () => {
    const r = resolveOwnership({
      allCalloutIds: allIds,
      claims: [claim('CALL-001', 'MEM-01', { basis: 'in-detail' })],
      shared: [{ calloutId: 'CALL-002', memberIds: ['MEM-01', 'MEM-02'], reason: 'a note governing all columns' }],
      excluded: [{ calloutId: 'CALL-003', reason: 'belongs to a precast panel' }],
      // CALL-004 is claimed by nobody
    });
    expect(r.dispositions.get('CALL-001')!.state).toBe('assigned');
    expect(r.dispositions.get('CALL-002')!.state).toBe('shared');
    expect(r.dispositions.get('CALL-003')!.state).toBe('excluded');
    expect(r.dispositions.get('CALL-004')!.state).toBe('unresolved');
    expect(r.dispositions.size).toBe(allIds.length);
    expect(auditOwnership(r, allIds).ok).toBe(true);
  });

  it('an unclaimed callout says its steel is missing', () => {
    const r = resolveOwnership({ allCalloutIds: allIds, claims: [] });
    expect(r.dispositions.get('CALL-004')!.reason).toMatch(/its steel is simply missing/);
  });

  it('a shared note reaches every member it names', () => {
    const r = resolveOwnership({
      allCalloutIds: allIds,
      claims: [],
      shared: [{ calloutId: 'CALL-002', memberIds: ['MEM-01', 'MEM-02'], reason: 'rule' }],
    });
    expect(ownedBy(r, 'MEM-01')).toHaveLength(1);
    expect(ownedBy(r, 'MEM-02')).toHaveLength(1);
  });

  it('a claim cannot override an explicitly shared note', () => {
    const r = resolveOwnership({
      allCalloutIds: allIds,
      claims: [claim('CALL-002', 'MEM-09', { basis: 'in-detail' })],
      shared: [{ calloutId: 'CALL-002', memberIds: ['MEM-01'], reason: 'rule' }],
    });
    expect(r.dispositions.get('CALL-002')!.state).toBe('shared');
  });
});
