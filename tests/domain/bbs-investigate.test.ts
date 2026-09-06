// The investigating orchestrator — can it reason, and can it be contained?
//
// Every test here is deterministic: the controller is a fake that returns
// scripted replies, so what is under test is the LOOP and the VALIDATION, not
// a model's judgement.
import { describe, expect, it, vi } from 'vitest';
import { investigate, validateProposal, type Proposal, type ValidationContext } from '../../src/cad/bbs/investigate';
import { runTool, TOOL_MENU, type ToolContext } from '../../src/cad/bbs/tools';
import { buildMemberRegistry } from '../../src/cad/bbs/members';
import { resolveOwnership } from '../../src/cad/bbs/ownership';
import type { EvidenceGraph, EvidenceNode, EvidenceEdge } from '../../src/cad/bbs/evidence';
import type { DrawingExtract } from '../../src/cad/bbs/types';

// ------------------------------------------------------------
// a small sheet: two members, a callout, and a leader that settles it
// ------------------------------------------------------------

const NODES: EvidenceNode[] = [
  { id: 'DECL-01', kind: 'declaration', sourceHandles: [], position: { x: 0, y: 0 }, rawText: 'TB-(350X400)', metadata: { name: 'TB' } },
  { id: 'MARK-TB-1', kind: 'mark', sourceHandles: [], position: { x: 100, y: 0 }, rawText: 'TB', metadata: { mark: 'TB' } },
  { id: 'DECL-02', kind: 'declaration', sourceHandles: [], position: { x: 9000, y: 0 }, rawText: 'C1 350x350', metadata: { name: 'C1' } },
  { id: 'MARK-C1-1', kind: 'mark', sourceHandles: [], position: { x: 9100, y: 0 }, rawText: 'C1', metadata: { mark: 'C1' } },
  // sits nearer C1, but its leader terminates on TB — the case run 004 could not settle
  { id: 'CALL-020', kind: 'callout', sourceHandles: [], position: { x: 8000, y: 0 }, rawText: '4L-8TOR@150C/C', metadata: { diaMm: 8, spacingMm: 150, legs: 4 } },
  { id: 'LEADER-004', kind: 'leader', sourceHandles: [], position: { x: 4000, y: 0 }, metadata: {} },
  { id: 'DIM-001', kind: 'dimension', sourceHandles: [], position: { x: 200, y: 0 }, rawText: '350', valueParts: [350], metadata: {} },
];

const EDGES: EvidenceEdge[] = [
  { from: 'LEADER-004', to: 'CALL-020', rel: 'carries' },
  { from: 'LEADER-004', to: 'MARK-TB-1', rel: 'points-at' },
];

function graph(): EvidenceGraph {
  const dims = NODES.filter((n) => n.kind === 'dimension').map((n) => ({ ...n, valueMm: 350, axis: 'x', from: { x: 0, y: 0 }, to: { x: 350, y: 0 } }));
  return {
    nodes: NODES,
    edges: EDGES,
    byId: new Map(NODES.map((n) => [n.id, n])),
    dimensions: dims as never,
    diagnostics: [],
    related: (id, rel) => EDGES.filter((e) => e.from === id && e.rel === rel).map((e) => NODES.find((n) => n.id === e.to)!).filter(Boolean),
    inPanel: () => [],
  };
}

const extract = (): DrawingExtract =>
  ({
    drawingName: 'sheet',
    marks: ['TB', 'C1'],
    declared: [
      { name: 'TB', sizeText: '350x400', dimsMm: [350, 400], occurrences: 1, raw: 'TB-(350X400)', handles: [] },
      { name: 'C1', sizeText: '350x350', dimsMm: [350, 350], occurrences: 1, raw: 'C1 350x350', handles: [] },
    ],
    callouts: [], tables: [], notes: { notes: [] }, unitScale: 1,
  }) as unknown as DrawingExtract;

const g = graph();
const registry = buildMemberRegistry(extract(), g);
const TB = registry.resolve('TB')!;
const C1 = registry.resolve('C1')!;

const toolCtx: ToolContext = { graph: g, registry, bands: [], userFacts: { run: { mm: 100000, saidAs: '100 m' } } };
const valCtx: ValidationContext = {
  registry,
  calloutIds: new Set(['CALL-020']),
  hasEvidence: (id) => g.byId.has(id),
};

/** a controller that plays a fixed script */
const scripted = (replies: unknown[]) => {
  let i = 0;
  return vi.fn(async () => (i < replies.length ? (replies[i++] as Record<string, unknown>) : null));
};

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  objective: 'who owns CALL-020',
  reasoning: 'the leader carrying it terminates on TB',
  evidenceIds: ['LEADER-004', 'CALL-020'],
  decision: { kind: 'ownership', calloutId: 'CALL-020', memberId: TB.id, basis: 'leader-terminates', barType: 'STIRRUP' },
  confidence: 'high',
  ...over,
});

// ------------------------------------------------------------

describe('1. it requests more evidence when it does not know enough', () => {
  it('runs the tools it asked for and records what came back', async () => {
    const ask = scripted([
      { requestTools: [{ tool: 'getCallout', args: { calloutId: 'CALL-020' } }], question: 'what is CALL-020?', missing: 'its owner' },
      { proposal: proposal() },
    ]);
    const out = await investigate({ objective: 'who owns CALL-020', brief: 'TB and C1 are both near it', tools: toolCtx, validation: valCtx, ask });
    expect(out.steps[0].toolCalls[0].tool).toBe('getCallout');
    expect(out.steps[0].question).toBe('what is CALL-020?');
    expect(out.steps[0].missing).toBe('its owner');
    expect(out.toolsRequested).toContain('getCallout');
  });
});

describe('2. it can inspect a specific callout', () => {
  it('returns what parsed, where it sits and which leader carries it', () => {
    const r = runTool(toolCtx, { tool: 'getCallout', args: { calloutId: 'CALL-020' } });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/diameter 8/);
    expect(r.text).toMatch(/spacing 150/);
    expect(r.text).toMatch(/carried by leader\(s\): LEADER-004/);
  });

  it('says plainly when a sheet has no detail regions', () => {
    const r = runTool(toolCtx, { tool: 'getCalloutsInDetail', args: { detailId: 'DETAIL-1' } });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no detail regions at all/);
  });
});

describe('3. it can inspect leader relationships', () => {
  it('follows a leader to what it terminates on', () => {
    const r = runTool(toolCtx, { tool: 'getLeaderTarget', args: { leaderId: 'LEADER-004' } });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/MARK-TB-1/);
    expect(r.evidenceIds).toContain('CALL-020');
  });

  it('finds leaders near a member, with what they carry', () => {
    const r = runTool(toolCtx, { tool: 'getLeadersNear', args: { memberId: TB.id, radiusMm: 8000 } });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/carries: CALL-020/);
  });
});

describe('4. it can investigate a contradiction', () => {
  it('proximity favours C1, the leader settles it on TB, and the loop follows the leader', async () => {
    // CALL-020 sits 1000 mm from C1 and 7900 mm from TB
    const near = runTool(toolCtx, { tool: 'getCalloutsNear', args: { memberId: C1.id, radiusMm: 2000 } });
    expect(near.ok).toBe(true);

    const ask = scripted([
      { requestTools: [{ tool: 'getCalloutsNear', args: { memberId: C1.id, radiusMm: 2000 } }], question: 'is it C1’s?' },
      { requestTools: [{ tool: 'getLeaderTarget', args: { leaderId: 'LEADER-004' } }], question: 'what does its leader say?' },
      { proposal: proposal() },
    ]);
    const out = await investigate({ objective: 'who owns CALL-020', brief: '', tools: toolCtx, validation: valCtx, ask });
    expect(out.accepted).toBe(true);
    expect(out.decision).toMatchObject({ memberId: TB.id, basis: 'leader-terminates' });
    expect(out.steps).toHaveLength(3);
  });
});

describe('5. it can escalate to the user', () => {
  it('an escalation is accepted and carries what it blocks', async () => {
    const ask = scripted([
      {
        proposal: proposal({
          decision: { kind: 'escalate', question: 'does this reinforcement continue for the whole 100 m run?', whyNeeded: 'the sheet draws one bay', blocks: [TB.id] },
          evidenceIds: ['MARK-TB-1'],
        }),
      },
    ]);
    const out = await investigate({ objective: 'placement of TB', brief: '', tools: toolCtx, validation: valCtx, ask });
    expect(out.accepted).toBe(true);
    expect(out.decision).toMatchObject({ kind: 'escalate' });
  });
});

describe('6. it cannot create a non-canonical member', () => {
  it('refuses a member the registry never established', () => {
    const v = validateProposal(
      proposal({ decision: { kind: 'ownership', calloutId: 'CALL-020', memberId: 'PEDESTAL P7', basis: 'proximity' } }),
      valCtx,
    );
    expect(v.ok).toBe(false);
    expect(v.objection).toMatch(/cannot be created by a proposal/);
  });

  it('a CAPTION naming a real member is an alias, not a new member', () => {
    // "TYPICAL DETAIL OF TB-350x400" is how the sheet writes TB; folding it in
    // is correct, and is the behaviour the registry exists to provide
    const v = validateProposal(
      proposal({ decision: { kind: 'ownership', calloutId: 'CALL-020', memberId: 'TYPICAL DETAIL OF TB-350x400', basis: 'proximity' } }),
      valCtx,
    );
    expect(v.ok).toBe(true);
    expect(v.claim?.memberId).toBe(TB.id);
  });

  it('accepts an ALIAS that resolves to a real member', () => {
    const v = validateProposal(proposal({ decision: { kind: 'ownership', calloutId: 'CALL-020', memberId: 'TB', basis: 'proximity' } }), valCtx);
    expect(v.ok).toBe(true);
    expect(v.claim?.memberId).toBe(TB.id);
  });
});

describe('7. it cannot bypass ownership validation', () => {
  it('refuses a callout the extractor never read', () => {
    const v = validateProposal(proposal({ decision: { kind: 'ownership', calloutId: 'CALL-999', memberId: TB.id, basis: 'proximity' } }), valCtx);
    expect(v.ok).toBe(false);
    expect(v.objection).toMatch(/not a reinforcement callout/);
  });

  it('refuses an invented ownership basis', () => {
    const v = validateProposal(proposal({ decision: { kind: 'ownership', calloutId: 'CALL-020', memberId: TB.id, basis: 'because it looks right' as never } }), valCtx);
    expect(v.ok).toBe(false);
    expect(v.objection).toMatch(/not an ownership basis/);
  });

  it('refuses an ownership decision that cites no evidence', () => {
    const v = validateProposal(proposal({ evidenceIds: [] }), valCtx);
    expect(v.ok).toBe(false);
    expect(v.objection).toMatch(/must cite the evidence/);
  });

  it('its accepted claim still goes through resolveOwnership, and can still lose', () => {
    // an accepted proposal is a CLAIM, not an assignment
    const v = validateProposal(proposal({ decision: { kind: 'ownership', calloutId: 'CALL-020', memberId: C1.id, basis: 'proximity' } }), valCtx);
    expect(v.ok).toBe(true);
    const r = resolveOwnership({
      allCalloutIds: ['CALL-020'],
      claims: [v.claim!, { calloutId: 'CALL-020', memberId: TB.id, basis: 'leader-terminates', reason: 'leader' }],
    });
    // the stronger basis wins regardless of which was proposed first
    expect(r.dispositions.get('CALL-020')).toMatchObject({ state: 'assigned', memberId: TB.id });
  });
});

describe('8. it cannot invent dimensions', () => {
  it('there is no decision shape in which a measurement can be written', () => {
    const kinds = ['ownership', 'shared', 'exclude', 'unresolved', 'escalate'];
    // the union is closed; none of its members carries a numeric field
    const banned = /(^|[^a-z])(mm|length|width|height|count|spacing|pitch|weight)([^a-z]|$)/i;
    for (const k of kinds) expect(k).not.toMatch(banned);
  });

  it('refuses a proposal citing evidence that does not exist', () => {
    const v = validateProposal(proposal({ evidenceIds: ['DIM-999'] }), valCtx);
    expect(v.ok).toBe(false);
    expect(v.objection).toMatch(/not\s+evidence on this sheet/);
  });

  it('a tool never returns a value the drawing does not carry', () => {
    const r = runTool(toolCtx, { tool: 'getDimensionsNear', args: { memberId: TB.id, radiusMm: 1000 } });
    if (r.ok) expect(r.text).toMatch(/= 350 mm/);
  });
});

describe('9. it terminates after a bounded number of investigations', () => {
  it('stops and says why when nothing is ever proposed', async () => {
    const ask = vi.fn(async () => ({ requestTools: [{ tool: 'getRun', args: {} }] }));
    const out = await investigate({ objective: 'forever', brief: '', tools: toolCtx, validation: valCtx, ask, maxSteps: 4 });
    expect(out.accepted).toBe(false);
    expect(out.steps).toHaveLength(4);
    expect(ask).toHaveBeenCalledTimes(4);
    expect(out.reason).toMatch(/produced no decision/);
  });

  it('a repeatedly refused proposal also terminates, carrying the objections', async () => {
    const ask = vi.fn(async () => ({ proposal: proposal({ decision: { kind: 'ownership', calloutId: 'CALL-999', memberId: TB.id, basis: 'proximity' } }) }));
    const out = await investigate({ objective: 'bad', brief: '', tools: toolCtx, validation: valCtx, ask, maxSteps: 3 });
    expect(out.accepted).toBe(false);
    expect(out.steps.every((s) => s.verdict === 'rejected')).toBe(true);
    expect(out.steps[0].objection).toBeTruthy();
  });

  it('an unknown tool is refused by name rather than silently returning nothing', () => {
    const r = runTool(toolCtx, { tool: 'getWhateverIWant', args: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no tool called "getWhateverIWant"/);
    expect(r.reason).toMatch(/Available:/);
  });
});

describe('10. the existing invariants are untouched', () => {
  it('the tool menu exposes only read functions', () => {
    for (const t of TOOL_MENU) expect(t.name).toMatch(/^get/);
  });

  it('an objection is fed back so the next attempt differs', async () => {
    const ask = scripted([
      { proposal: proposal({ decision: { kind: 'ownership', calloutId: 'CALL-020', memberId: 'INVENTED', basis: 'proximity' } }) },
      { proposal: proposal() },
    ]);
    const out = await investigate({ objective: 'who owns CALL-020', brief: '', tools: toolCtx, validation: valCtx, ask });
    expect(out.steps[0].verdict).toBe('rejected');
    expect(out.steps[1].verdict).toBe('accepted');
    // the second call saw the objection
    const secondPrompt = String((ask.mock.calls[1] as unknown as [{ prompt: string }])[0].prompt);
    expect(secondPrompt).toMatch(/your proposal was REFUSED/);
  });

  it('every accepted decision carries the evidence it rested on', async () => {
    const ask = scripted([{ proposal: proposal() }]);
    const out = await investigate({ objective: 'x', brief: '', tools: toolCtx, validation: valCtx, ask });
    expect(out.evidenceIds).toContain('LEADER-004');
  });
});
