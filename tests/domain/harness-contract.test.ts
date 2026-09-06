// ============================================================
// The harness contract (PRODUCT_AS_HARNESS.md §5).
//
// Two proven harnesses — the BBS orchestrator and the drawing splitter —
// behind ONE contract, via thin adapters. What is on trial:
//
//   · both adapters satisfy HarnessContract: tools, budget, run, onEvent
//   · the event shape is unified (§5 cheap win #1): every event from either
//     harness is {step, ask, served} with `step` monotonic non-decreasing —
//     neither harness's own emission was changed to get there
//   · budgets are enforced: the BBS budget maps onto the loop's own Limits;
//     the splitter's maxRounds is native and maxToolCalls is enforced at the
//     transport seam, keeping partial work and naming the tripped budget
//   · every controller is a scripted fake — no model call is ever made
// ============================================================
import { describe, expect, it, vi } from 'vitest';
import { createBbsHarness, BBS_DEFAULT_BUDGET, type BbsHarnessInput } from '../../src/harness/bbsHarness';
import {
  createSplitterHarness,
  SPLITTER_DEFAULT_BUDGET,
  type SplitterHarnessInput,
} from '../../src/harness/splitterHarness';
import type { HarnessContract, HarnessEvent } from '../../src/harness/contract';
import type { ChatReply, ChatTransport } from '../../src/cad/understanding/orchestrator';
import type { OrchestrateOutcome } from '../../src/cad/bbs/orchestrate';
import type { DrawingUnderstandingPackage } from '../../src/cad/understanding/types';
import type { CadDocument } from '../../src/cad/types';
import type { DrawingExtract } from '../../src/cad/bbs/types';
import { threeAreaDoc } from '../helpers/cadDoc';

// ------------------------------------------------------------
// a small BBS sheet (same synthetic shape the orchestrator tests use)
// ------------------------------------------------------------

function bbsDoc(): CadDocument {
  const e: Record<string, unknown>[] = [];
  let h = 0x2000;
  const next = (): string => (h++).toString(16).toUpperCase();
  const text = (t: string, x: number, y: number, height = 100): void => {
    e.push({ type: 'text', text: t, position: { x, y }, height, style: { handle: next(), layer: '0' } });
  };
  for (const x of [0, 4000, 8000, 12000, 16000]) text('C1', x, 0);
  text('8-12TOR', 200, 500, 80);
  return {
    name: 'synthetic',
    sourceFile: 'synthetic.dxf',
    entities: e as never,
    layers: new Map([['0', { name: '0' }]]) as never,
    blocks: new Map(),
    unitScale: 1,
    extents: null,
  } as unknown as CadDocument;
}

const bbsExtract = (): DrawingExtract =>
  ({
    drawingName: 'synthetic.dxf',
    marks: ['C1'],
    declared: [
      { name: 'C1', sizeText: '350x350', dimsMm: [350, 350], occurrences: 5, raw: 'C1 350x350', handles: [] },
    ],
    callouts: [{ raw: '8-12TOR', handle: 'A1', position: { x: 200, y: 500 }, diaMm: 12, count: 8 }],
    tables: [],
    notes: { notes: [], coverByMember: [] },
    unitScale: 1,
  }) as unknown as DrawingExtract;

/** scripted controller: one queue for the orchestrator, a default for the rest */
function controller(orchestrator: unknown[]) {
  const queue = [...orchestrator];
  return vi.fn(async (args: { label: string }) => {
    if (args.label === 'orchestrator') {
      return (queue.shift() ?? { plan: ['keep looking'] }) as Record<string, unknown>;
    }
    return { findings: [{ statement: 'looked, found nothing', confidence: 0.2 }], done: true } as Record<
      string,
      unknown
    >;
  });
}

const rasterise = async (): Promise<string> => `data:image/png;base64,${'A'.repeat(800)}`;

const bbsInput = (ask: BbsHarnessInput['ask']): BbsHarnessInput => ({
  doc: bbsDoc(),
  extract: bbsExtract(),
  structureClass: 'boundary wall',
  ask,
  rasterise,
  now: () => 1,
});

// ------------------------------------------------------------
// scripted splitter transport
// ------------------------------------------------------------

let callSeq = 0;
function call(name: string, args: Record<string, unknown>): ChatReply['toolCalls'][number] {
  callSeq += 1;
  return { id: `call-${callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function scripted(replies: ChatReply[]): { transport: ChatTransport; turns: () => number } {
  let i = 0;
  const transport: ChatTransport = async () => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return reply;
  };
  return { transport, turns: () => i };
}

const closing = (): ChatReply => ({
  content: JSON.stringify({ summary: 'three areas', relationships: [], unresolved: [] }),
  toolCalls: [],
});

const splitInput = (transport: ChatTransport): SplitterHarnessInput => ({
  doc: threeAreaDoc(),
  projectId: 'p1',
  skipPng: true,
  transport,
});

// ------------------------------------------------------------
// assertions shared by both harnesses — the point of the contract
// ------------------------------------------------------------

function expectUnifiedTrail(events: HarnessEvent[]): void {
  expect(events.length).toBeGreaterThan(0);
  let last = 0;
  for (const e of events) {
    expect(Object.keys(e).sort()).toEqual(['ask', 'served', 'step']);
    expect(typeof e.step).toBe('number');
    expect(typeof e.ask).toBe('string');
    expect(typeof e.served).toBe('string');
    expect(e.step).toBeGreaterThanOrEqual(last); // monotonic non-decreasing
    last = e.step;
  }
}

// ============================================================
// 1 · both adapters satisfy the contract
// ============================================================

describe('the contract shape', () => {
  it('both adapters expose tools, a budget and a run function', () => {
    const bbs: HarnessContract<BbsHarnessInput, OrchestrateOutcome> = createBbsHarness();
    const splitter: HarnessContract<SplitterHarnessInput, DrawingUnderstandingPackage> =
      createSplitterHarness();
    for (const h of [bbs, splitter] as HarnessContract[]) {
      expect(h.tools.length).toBeGreaterThan(0);
      for (const t of h.tools) {
        expect(t.name.length).toBeGreaterThan(0);
        expect(t.description.length).toBeGreaterThan(0);
      }
      expect(h.budget.maxRounds).toBeGreaterThan(0);
      expect(typeof h.run).toBe('function');
    }
    // the tool surfaces are each harness's own, carried verbatim
    expect(bbs.tools.map((t) => t.name)).toContain('getFullDrawingImage');
    expect(splitter.tools.map((t) => t.name)).toContain('propose_section');
  });

  it('default budgets mirror what each harness already enforces on its own', () => {
    expect(createBbsHarness().budget).toEqual(BBS_DEFAULT_BUDGET);
    expect(createSplitterHarness().budget).toEqual(SPLITTER_DEFAULT_BUDGET);
    // an explicit budget wins
    expect(createBbsHarness({ maxRounds: 3 }).budget.maxRounds).toBe(3);
    expect(createSplitterHarness({ maxRounds: 2 }).budget.maxRounds).toBe(2);
  });
});

// ============================================================
// 2 · the unified event trail
// ============================================================

describe('one event shape for both harnesses (§5 cheap win #1)', () => {
  it('the BBS trail arrives as {step, ask, served}, step monotonic', async () => {
    const harness = createBbsHarness({ maxRounds: 4 });
    const seen: HarnessEvent[] = [];
    harness.onEvent = (e) => seen.push(e);
    const result = await harness.run(
      bbsInput(
        controller([
          { understanding: 'a wall sheet', plan: ['map details', 'build'] },
          { done: { why: 'stopping for the test' } },
        ]),
      ),
    );
    expectUnifiedTrail(result.events);
    expect(seen).toEqual(result.events); // onEvent saw exactly the trail
    expect(result.steps).toBeGreaterThan(0);
    // the output is the orchestrator's own outcome, untranslated
    expect(result.output.understanding).toMatch(/wall sheet/);
    expect(result.stoppedBecause).toBe(result.output.stoppedBecause);
  });

  it('the splitter trail arrives as the same shape', async () => {
    const harness = createSplitterHarness({ maxRounds: 8 });
    const { transport } = scripted([
      { content: '', toolCalls: [call('propose_section', { label: 'SECTION AT 1-1', kind: 'detail', handles: ['AAA1', 'AAA2'] })] },
      closing(),
    ]);
    const seen: HarnessEvent[] = [];
    harness.onEvent = (e) => seen.push(e);
    const result = await harness.run(splitInput(transport));
    expectUnifiedTrail(result.events);
    expect(seen).toEqual(result.events);
    expect(result.output.sections).toHaveLength(1);
    // a scripted transport still reads as a stand-in after wrapping
    expect(result.output.source).toBe('local');
  });

  it('both trails satisfy the identical predicate — one UI component can render either', async () => {
    const bbs = await createBbsHarness({ maxRounds: 3 }).run(
      bbsInput(controller([{ plan: ['orient'], done: { why: 'done' } }])),
    );
    const { transport } = scripted([closing()]);
    const split = await createSplitterHarness().run(splitInput(transport));
    for (const trail of [bbs.events, split.events]) expectUnifiedTrail(trail);
  });
});

// ============================================================
// 3 · budgets
// ============================================================

describe('budgets are enforced', () => {
  it('BBS: maxRounds maps to the loop’s own turn limit', async () => {
    const ask = controller([]); // never finishes — every turn is another plan
    const result = await createBbsHarness({ maxRounds: 3 }).run(bbsInput(ask));
    const orchestratorCalls = ask.mock.calls.filter((c) => c[0].label === 'orchestrator');
    expect(orchestratorCalls).toHaveLength(3);
    expect(result.output.turns).toBe(3);
  });

  it('splitter: maxRounds is the loop’s base round budget', async () => {
    const { transport, turns } = scripted([
      { content: '', toolCalls: [call('find_text', { pattern: 'WALL' })] },
    ]);
    const result = await createSplitterHarness({ maxRounds: 2 }).run(splitInput(transport));
    expect(turns()).toBe(2);
    // a run that never closed says so rather than reading as finished
    expect(result.output.unresolved.join(' ')).toMatch(/without closing/);
  });

  it('splitter: maxToolCalls trips at the transport seam, keeps partial work, names itself', async () => {
    const { transport, turns } = scripted([
      { content: '', toolCalls: [call('propose_section', { label: 'SECTION AT 1-1', kind: 'detail', handles: ['AAA1', 'AAA2'] })] },
      { content: '', toolCalls: [call('find_text', { pattern: 'WALL' })] },
    ]);
    const result = await createSplitterHarness({ maxRounds: 10, maxToolCalls: 2 }).run(
      splitInput(transport),
    );
    // two tool calls were served, then the budget tripped — no more model turns
    expect(turns()).toBe(2);
    expect(result.stoppedBecause).toBe('budget: maxToolCalls (2) exhausted');
    // the section cut before the trip is kept — budgets stop, they never discard
    expect(result.output.sections).toHaveLength(1);
  });

  it('a budget-free splitter run never trips', async () => {
    const { transport } = scripted([closing()]);
    const result = await createSplitterHarness().run(splitInput(transport));
    expect(result.stoppedBecause).toBeUndefined();
    expect(result.output.summary).toBe('three areas');
  });
});
