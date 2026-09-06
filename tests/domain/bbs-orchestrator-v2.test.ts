// The orchestrator architecture — the AI leads, the engine calculates.
//
// Runs 004–010 were one model walking one loop with the order of work written
// in code. These tests hold the inversion: that the model plans, invents its own
// tasks, dispatches independent ones together, reads what comes back, reacts to
// the verifier, and that NONE of the sequence is imposed by this codebase.
//
// They also hold the boundary. Three live runs died on malformed model output —
// an unknown kind, a bad enum, a string where an array was declared. The gate in
// schema.ts is general; these tests prove it stays general.
//
// Every controller here is a scripted fake. What is under test is the machine.
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOrchestrator, ORCHESTRATOR_REPLY } from '../../src/cad/bbs/orchestrate';
import { TaskBoard, runBatch, runSpecialist, SPECIALIST_REPLY } from '../../src/cad/bbs/tasks';
import {
  validate, explain, object, required, optional, str, num, arrayOf, enumOf, bool, taggedUnion, describeValue,
} from '../../src/cad/bbs/schema';
import { parseDXF } from '../../src/cad/dxf/parse';
import { extractDrawing } from '../../src/cad/bbs/extract';
import { BY_LAYER, type CadDocument, type CadLayer } from '../../src/cad/types';
import type { DrawingExtract } from '../../src/cad/bbs/types';

// ------------------------------------------------------------
// a small sheet
// ------------------------------------------------------------

const NODES = [0, 4000, 8000, 12000, 16000];

// A complete layer/style — the real parser never hands out a partial one,
// and displayList.ts's `emit`/`resolveStyle` now reads both on every entity
// (no early return on a layer's own visible/frozen state skips them first,
// per src/cad/displayList.ts: the viewer draws regardless of what the file's
// last CAD session had toggled, so `resolveStyle` is always reached).
const LAYER_0: CadLayer = {
  name: '0', color: BY_LAYER, lineweight: -3, linetype: 'CONTINUOUS', visible: true, frozen: false, transparency: 0,
};

function doc(): CadDocument {
  const e: Record<string, unknown>[] = [];
  let h = 0x2000;
  const next = (): string => (h++).toString(16).toUpperCase();
  const text = (t: string, x: number, y: number, height = 100) =>
    e.push({
      type: 'text',
      text: t,
      position: { x, y },
      height,
      style: { handle: next(), layer: '0', color: BY_LAYER, lineweight: -1, linetype: '', linetypeScale: 1, transparency: -1, normal: null },
    });
  for (const x of NODES) text('C1', x, 0);
  text('200 THK. RCC WALL', 0, -20000, 120);
  text('8-12TOR', 200, 500, 80);
  text('10TOR@200C/C', 300, -19500, 80);
  return {
    name: 'synthetic', sourceFile: 'synthetic.dxf', entities: e as never,
    layers: new Map([['0', LAYER_0]]) as never, blocks: new Map(), unitScale: 1, extents: null,
  } as unknown as CadDocument;
}

const extract = (): DrawingExtract =>
  ({
    drawingName: 'synthetic.dxf',
    marks: ['C1'],
    declared: [
      { name: 'C1', sizeText: '350x350', dimsMm: [350, 350], occurrences: 5, raw: 'C1 350x350', handles: [] },
      { name: 'RCC WALL', sizeText: '200', dimsMm: [200], occurrences: 1, raw: '200 THK. RCC WALL', handles: [] },
    ],
    callouts: [
      { raw: '8-12TOR', handle: 'A1', position: { x: 200, y: 500 }, diaMm: 12, count: 8 },
      { raw: '10TOR@200C/C', handle: 'A2', position: { x: 300, y: -19500 }, diaMm: 10, spacingMm: 200 },
    ],
    tables: [],
    notes: { notes: [], coverByMember: [{ member: 'COLUMN', coversMm: [40] }] },
    unitScale: 1,
  }) as unknown as DrawingExtract;

const RUN = { run: { mm: 100000, saidAs: '100 m' } };
const rasterise = async () => `data:image/png;base64,${'A'.repeat(800)}`;

/**
 * A scripted controller.
 *
 * One queue per label, so an orchestrator reply and a specialist reply can be
 * scripted independently — which is what lets a test drive a real delegation.
 */
function controller(script: {
  orchestrator?: unknown[];
  specialist?: unknown[] | ((label: string, prompt: string) => unknown);
}) {
  const orch = [...(script.orchestrator ?? [])];
  const spec = Array.isArray(script.specialist) ? [...script.specialist] : script.specialist;
  return vi.fn(async (args: { label: string; prompt: string }) => {
    if (args.label === 'orchestrator') {
      return (orch.shift() ?? { done: { why: 'nothing left to do' } }) as Record<string, unknown>;
    }
    if (typeof spec === 'function') return spec(args.label, args.prompt) as Record<string, unknown>;
    return (spec?.shift() ?? { findings: [{ statement: 'looked, found nothing', confidence: 0.2 }], done: true }) as Record<string, unknown>;
  });
}

const run = (ask: unknown, over: Record<string, unknown> = {}) =>
  runOrchestrator({
    doc: doc(), extract: extract(), projectFacts: RUN, structureClass: 'boundary wall',
    ask: ask as never, rasterise, now: () => 1,
    limits: { maxOrchestratorTurns: 6, specialistTurns: 2, ...(over.limits as object ?? {}) },
    ...over,
  });

const promptFor = (ask: unknown, label: string, n = 0): string => {
  const calls = (ask as { mock: { calls: { 0: { label: string; prompt: string } }[] } }).mock.calls
    .filter((c) => c[0].label === label);
  return String(calls[n]?.[0].prompt ?? '');
};

// ============================================================
// 1–4 · planning, dynamic tasks, execution, batching
// ============================================================

describe('the orchestrator leads', () => {
  it('1 · it produces a plan in its own words', async () => {
    const ask = controller({
      orchestrator: [
        {
          understanding: 'a boundary wall sheet: four layout bands over a detail column',
          plan: ['map the details', 'settle how the bands relate to the run', 'build'],
          done: { why: 'stopping for the test' },
        },
      ],
    });
    const out = await run(ask);
    expect(out.understanding).toMatch(/boundary wall sheet/);
    expect(out.plans).toHaveLength(1);
    expect(out.plans[0]).toHaveLength(3);
    expect(out.stoppedBecause).toBe('stopping for the test');
  });

  it('2–3 · it creates tasks of its own invention, and they execute', async () => {
    const ask = controller({
      orchestrator: [
        {
          createTasks: [
            { type: 'detail-read', objective: 'Read the C1 detail', inputs: ['MEM-01'], requestedEvidence: ['a crop'] },
          ],
        },
        { done: { why: 'done' } },
      ],
      specialist: [
        { findings: [{ statement: 'the C1 detail draws 8-12TOR', evidenceIds: ['CALL-001'], confidence: 0.9 }], done: true },
      ],
    });
    const out = await run(ask);
    const tasks = out.board.all();
    expect(tasks).toHaveLength(1);
    // the type is the model's own word, not one of ours
    expect(tasks[0].type).toBe('detail-read');
    expect(tasks[0].status).toBe('completed');
    expect(tasks[0].result!.findings[0].statement).toMatch(/8-12TOR/);
    expect(out.tasksCreated).toBe(1);
  });

  it('4 · independent tasks created together are dispatched as ONE batch', async () => {
    const seen: string[] = [];
    const ask = controller({
      orchestrator: [
        {
          createTasks: [
            { type: 'read', objective: 'A' }, { type: 'read', objective: 'B' },
            { type: 'read', objective: 'C' }, { type: 'read', objective: 'D' },
          ],
        },
        { done: { why: 'done' } },
      ],
      specialist: (label) => {
        seen.push(label);
        return { findings: [{ statement: `answered ${label}`, confidence: 0.8 }], done: true };
      },
    });
    const out = await run(ask);
    expect(out.tasksBatched).toEqual([4]);      // four tasks, ONE dispatch
    expect(seen).toHaveLength(4);
    expect(out.board.byStatus('completed')).toHaveLength(4);
    // and the orchestrator spent one turn on all four, not four turns
    const orchestratorCalls = (ask as never as { mock: { calls: { 0: { label: string } }[] } }).mock.calls
      .filter((c) => c[0].label === 'orchestrator');
    expect(orchestratorCalls).toHaveLength(2);
  });
});

// ============================================================
// 5–9 · the investigation loop
// ============================================================

describe('evidence comes back, and drives what happens next', () => {
  it('5 · a task may return only unresolved evidence — no conclusion required', async () => {
    const ask = controller({
      orchestrator: [{ createTasks: [{ type: 'extent', objective: 'is the band the whole job?' }] }, { done: { why: 'x' } }],
      specialist: [{ unresolved: ['no match line is legible at this scale'], confidence: 0.2, done: true }],
    });
    const out = await run(ask);
    const t = out.board.all()[0];
    expect(t.status).toBe('needs-more-evidence');
    expect(t.result!.unresolved[0]).toMatch(/no match line/);
    expect(t.result!.findings).toHaveLength(0);
  });

  it('6 · an unresolved result can cause the orchestrator to create another task', async () => {
    const ask = controller({
      orchestrator: [
        { createTasks: [{ type: 'extent', objective: 'is the band the whole job?' }] },
        {
          thinking: 'that did not settle it — look at the ends instead',
          createTasks: [{ type: 'extent-ends', objective: 'crop both ends of the band', supersedes: 'TASK-001' }],
        },
        { done: { why: 'x' } },
      ],
      specialist: [
        { unresolved: ['not legible'], done: true },
        { findings: [{ statement: 'the band ends in a break symbol', evidenceIds: [], confidence: 0.8 }], done: true },
      ],
    });
    const out = await run(ask);
    expect(out.board.all()).toHaveLength(2);
    expect(out.board.get('TASK-001')!.status).toBe('superseded');
    expect(out.board.get('TASK-002')!.result!.findings[0].statement).toMatch(/break symbol/);
    // the second task's question came from the first result, not from a script in our code
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/not legible/);
  });

  it('7 · a specialist can request a crop, and the picture reaches it', async () => {
    let sawImage = 0;
    const ask = vi.fn(async (args: { label: string; images: unknown[] }) => {
      if (args.label === 'orchestrator') {
        return sawImage === 0 && !(ask as never as { calledOrch?: boolean })
          ? { createTasks: [{ type: 'look', objective: 'see the layout' }] }
          : { done: { why: 'x' } };
      }
      if (args.images.length) { sawImage = args.images.length; return { findings: [{ statement: 'saw it', confidence: 0.9 }], done: true }; }
      return { requestTools: [{ tool: 'getDrawingRegionImage', args: { x1: -500, y1: -500, x2: 17000, y2: 900, reason: 'the layout' } }] };
    });
    let orchTurn = 0;
    const ask2 = vi.fn(async (args: { label: string; images: unknown[] }) => {
      if (args.label === 'orchestrator') {
        orchTurn += 1;
        return orchTurn === 1 ? { createTasks: [{ type: 'look', objective: 'see the layout' }] } : { done: { why: 'x' } };
      }
      if (args.images.length) { sawImage = args.images.length; return { findings: [{ statement: 'saw it', confidence: 0.9 }], done: true }; }
      return { requestTools: [{ tool: 'getDrawingRegionImage', args: { x1: -500, y1: -500, x2: 17000, y2: 900, reason: 'the layout' } }] };
    });
    const out = await run(ask2, { limits: { maxOrchestratorTurns: 4, specialistTurns: 3 } });
    expect(sawImage).toBe(1);
    expect(out.imagesRendered).toBe(1);
    expect(out.board.all()[0].result!.imagesInspected).toContain('IMG-1');
    expect(ask).toBeDefined();
  });

  it('8 · the orchestrator reviews results — they are on the board it reads', async () => {
    const ask = controller({
      orchestrator: [
        { createTasks: [{ type: 'read', objective: 'read the wall section' }] },
        { done: { why: 'x' } },
      ],
      specialist: [{ findings: [{ statement: 'the wall carries 10TOR@200C/C on each face', confidence: 0.9 }], done: true }],
    });
    await run(ask);
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/TASK-001 \[completed\]/);
    expect(second).toMatch(/10TOR@200C\/C on each face/);
  });

  it('9 · repeated failed tool calls are refused inside a task', async () => {
    let turns = 0;
    const ask = vi.fn(async (args: { label: string }) => {
      if (args.label === 'orchestrator') {
        return turns === 0
          ? ((turns = 1), { createTasks: [{ type: 'probe', objective: 'follow the leader' }] })
          : { done: { why: 'x' } };
      }
      return { requestTools: [{ tool: 'getRegionOf', args: { evidenceId: 'LEAD-999' } }] };
    });
    const out = await run(ask, { limits: { maxOrchestratorTurns: 3, specialistTurns: 3 } });
    const t = out.board.all()[0];
    // three turns asked the same failing question; only the first spent a call
    expect(t.result!.toolCalls).toBe(1);
  });
});

// ============================================================
// 10–14 · build, verification, and reacting to both
// ============================================================

describe('build and verification feed back into the orchestrator', () => {
  const OWN_WALL = {
    kind: 'own', calloutId: 'CALL-002', memberId: 'MEM-02', basis: 'in-detail',
    barType: 'MAIN', distributionAxis: 'L', evidenceIds: ['CALL-002'], reasoning: 'the wall section',
  };

  it('10 · the orchestrator sends a structured package to the builder and gets a schedule', async () => {
    const ask = controller({
      orchestrator: [
        {
          conclusions: [OWN_WALL, { kind: 'placement', memberId: 'MEM-02', placement: { kind: 'continuous', runFactId: 'run' }, evidenceIds: ['FACT-run'] }],
          build: true,
        },
        { done: { why: 'built' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsAccepted).toBe(2);
    expect(out.builds).toHaveLength(1);
    const row = out.result.rows.find((r) => /WALL/.test(r.memberMark))!;
    expect(row.barsPerMember).toBe(501);   // 100 m at 200 c/c, computed by the engine
    expect(row.memberCount).toBe(1);
  });

  it('11–12 · the build reports what it could NOT do, and that reaches the orchestrator', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [OWN_WALL], build: true },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    const b = out.builds[0];
    // the wall owns steel but nothing established how it repeats
    expect(b.membersWithoutPlacement).toContain('RCC WALL');
    expect(b.failures.length).toBeGreaterThan(0);
    // …and the orchestrator is shown exactly that on its next turn
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/counted ZERO for want of a placement/);
    expect(second).toMatch(/RCC WALL/);
  });

  it('13–14 · a verification failure can drive a corrective task and a rebuild', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [OWN_WALL], build: true },
        {
          thinking: 'the wall counted zero — find out how it repeats',
          createTasks: [{ type: 'placement', objective: 'How does the RCC wall occur over the run?', inputs: ['MEM-02'] }],
        },
        {
          conclusions: [{ kind: 'placement', memberId: 'MEM-02', placement: { kind: 'continuous', runFactId: 'run' }, evidenceIds: ['FACT-run'] }],
          build: true,
        },
        { done: { why: 'the wall now has a placement' } },
      ],
      specialist: [{ findings: [{ statement: 'the wall is drawn in section only and runs the length of the job', confidence: 0.8 }], done: true }],
    });
    const out = await run(ask);
    expect(out.builds).toHaveLength(2);
    expect(out.builds[0].membersWithoutPlacement).toContain('RCC WALL');
    expect(out.builds[1].membersWithoutPlacement).not.toContain('RCC WALL');
    expect(out.builds[1].rows).toBeGreaterThan(0);
  });
});

// ============================================================
// 15–17 · the boundary
// ============================================================

describe('malformed model output never crashes the host', () => {
  it('15 · every shape of nonsense is contained and reported', async () => {
    const nasty = [
      { conclusions: 'not an array' },
      { createTasks: [{ objective: 'no type' }] },
      { plan: 'a string, not a list' },
      { conclusions: [{ kind: 'invent-a-bar' }] },
      { build: 'yes' },
      { done: 'because' },
      { askUser: [{ question: 'x' }] },
      null,
      [],
      'a bare string',
      42,
    ];
    for (const bad of nasty) {
      const ask = controller({ orchestrator: [bad, { done: { why: 'x' } }] });
      const out = await run(ask);
      expect(out.result, JSON.stringify(bad)).toBeTruthy();   // the run survived
      expect(out.builds.length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });

  it('15b · the Run 010 crash — a string where an array was declared', async () => {
    // verbatim shape: "basis":"visual-inspection" on a specialist finding envelope
    const bad = { findings: 'visual-inspection', done: true };
    const checked = validate(bad, SPECIALIST_REPLY);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.problems[0].path).toBe('findings');
      expect(checked.problems[0].expected).toMatch(/if you meant one item, send it as an array/);
    }
  });

  it('16 · every envelope field is type checked, not just enums', () => {
    const cases: [unknown, string][] = [
      [{ plan: [1, 2] }, 'plan[0]'],
      [{ createTasks: [{ type: 'x', objective: 1 }] }, 'createTasks[0].objective'],
      // conclusions must still be an ARRAY at the envelope; each item's own
      // typing is checked per conclusion in applyConclusion (Run 015), so one
      // bad conclusion no longer discards the rest of a sound reply
      [{ conclusions: 'own it' }, 'conclusions'],
      [{ askUser: [{ question: 'q' }] }, 'askUser[0].whyNeeded'],
      [{ unresolved: 'one thing' }, 'unresolved'],
    ];
    for (const [value, path] of cases) {
      const checked = validate(value, ORCHESTRATOR_REPLY);
      expect(checked.ok, JSON.stringify(value)).toBe(false);
      if (!checked.ok) expect(checked.problems.map((p) => p.path)).toContain(path);
    }
  });

  it('17 · the report tells the model what to fix, and reaches it', async () => {
    const ask = controller({ orchestrator: [{ plan: 'not a list' }, { done: { why: 'x' } }] });
    await run(ask);
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/DID NOT MATCH THE CONTRACT/);
    expect(second).toMatch(/plan — expected an array of a string/);
    expect(second).toMatch(/Nothing was assumed on your behalf/);
  });

  it('17b · the validator is general — it is not a list of known fields', () => {
    const shape = object({
      name: required(str({ min: 1 })),
      count: optional(num({ int: true, min: 0 })),
      mode: optional(enumOf(['a', 'b'])),
      tags: optional(arrayOf(str())),
      on: optional(bool()),
    });
    expect(validate({ name: 'x', count: 3, mode: 'a', tags: ['t'], on: true }, shape).ok).toBe(true);
    expect(validate({ name: '', }, shape).ok).toBe(false);
    expect(validate({ name: 'x', count: 1.5 }, shape).ok).toBe(false);
    expect(validate({ name: 'x', mode: 'c' }, shape).ok).toBe(false);
    expect(validate({ name: 'x', tags: 'one' }, shape).ok).toBe(false);
    // nested and tagged unions
    const u = taggedUnion('kind', {
      p: object({ kind: required(str()), n: required(num()) }),
      q: object({ kind: required(str()), s: required(str()) }),
    });
    expect(validate({ kind: 'p', n: 1 }, u).ok).toBe(true);
    expect(validate({ kind: 'z' }, u).ok).toBe(false);
    expect(describeValue(['a'])).toMatch(/an array of 1/);
    expect(explain([{ path: 'a', expected: 'b', received: 'c' }])).toMatch(/a — expected b; received c/);
  });

  it('a specialist that returns nonsense does not take the run down', async () => {
    const ask = controller({
      orchestrator: [{ createTasks: [{ type: 'x', objective: 'y' }] }, { done: { why: 'x' } }],
      specialist: [{ findings: [{ noStatement: true }] }, 'garbage'],
    });
    const out = await run(ask);
    expect(out.board.all()[0].result!.malformed).toBeTruthy();
    expect(out.malformedReplies).toBeGreaterThan(0);
    expect(out.result).toBeTruthy();
  });
});

// ============================================================
// 18–23 · nothing may be invented
// ============================================================

describe('the engine still refuses what the drawing did not establish', () => {
  it('18 · the project run stays 100 000 mm and is marked as a project fact', async () => {
    const ask = controller({ orchestrator: [{ done: { why: 'x' } }] });
    await run(ask);
    const p = promptFor(ask, 'orchestrator');
    expect(p).toMatch(/PROJECT RUN: 100000 mm \(100 m\)/);
    expect(p).toMatch(/PROJECT FACT the client gave. It is NOT a length measured anywhere on the sheet/);
  });

  it('19 · a missing placement becomes zero, never a silent quantity', async () => {
    const ask = controller({
      orchestrator: [{
        conclusions: [{ kind: 'own', calloutId: 'CALL-002', memberId: 'MEM-02', basis: 'in-detail', barType: 'MAIN', evidenceIds: ['CALL-002'] }],
        build: true,
      }, { done: { why: 'x' } }],
    });
    const out = await run(ask);
    for (const m of out.result.members ?? []) expect(m.count ?? 0).toBe(0);
    expect(out.builds[0].membersWithoutPlacement.length).toBeGreaterThan(0);
  });

  it('20 · a dimension may not be typed — only pointed at', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'dimension', memberId: 'MEM-01', axis: 'H', ref: { value: 2700 } }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsAccepted).toBe(0);
    expect(out.conclusionsRefused).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/may not carry a typed value/);
  });

  it('21 · a member the drawing never established cannot be created', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'own', calloutId: 'CALL-001', memberId: 'BEAM-99', basis: 'in-detail', evidenceIds: ['CALL-001'] }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsRefused).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/is not a member of this drawing/);
  });

  it('22 · evidence provenance survives delegation — cited ids must exist', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', evidenceIds: ['NOPE-001'] }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsRefused).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/NOPE-001 — not evidence on this sheet/);
  });

  it('23 · a visual conclusion keeps the image it rests on', async () => {
    let orchTurn = 0;
    const ask = vi.fn(async (args: { label: string; images: unknown[] }) => {
      if (args.label === 'orchestrator') {
        orchTurn += 1;
        return orchTurn === 1 ? { createTasks: [{ type: 'look', objective: 'see the layout' }] } : { done: { why: 'x' } };
      }
      if (args.images.length) {
        return { findings: [{ statement: 'five columns at a regular pitch', evidenceIds: [], imageIds: ['IMG-1'], confidence: 0.8 }], done: true };
      }
      return { requestTools: [{ tool: 'getDrawingRegionImage', args: { x1: -500, y1: -500, x2: 17000, y2: 900, reason: 'layout' } }] };
    });
    const out = await run(ask, { limits: { maxOrchestratorTurns: 3, specialistTurns: 3 } });
    const f = out.board.all()[0].result!.findings[0];
    expect(f.imageIds).toEqual(['IMG-1']);
    expect(out.board.all()[0].result!.imagesInspected).toContain('IMG-1');
  });

  it('a crop already rendered is reused rather than paid for twice', async () => {
    const crop = { tool: 'getDrawingRegionImage', args: { x1: -500, y1: -500, x2: 17000, y2: 900, reason: 'layout' } };
    let orchTurn = 0;
    const ask = vi.fn(async (args: { label: string; images: unknown[] }) => {
      if (args.label === 'orchestrator') {
        orchTurn += 1;
        if (orchTurn === 1) return { createTasks: [{ type: 'a', objective: 'A' }] };
        if (orchTurn === 2) return { createTasks: [{ type: 'b', objective: 'B' }] };
        return { done: { why: 'x' } };
      }
      if (args.images.length) return { findings: [{ statement: 'saw it', confidence: 0.8 }], done: true };
      return { requestTools: [crop] };
    });
    const out = await run(ask, { limits: { maxOrchestratorTurns: 4, specialistTurns: 3 } });
    // two separate tasks asked for the same crop; it was rendered once
    expect(out.imagesRendered).toBe(1);
    expect(out.toolCalls).toBe(1);
  });
});

// ============================================================
// 24–25 · limits, and the real sheet
// ============================================================

describe('safety rails stop a runaway without faking completion', () => {
  it('24 · a turn limit stops cleanly and says so', async () => {
    const ask = controller({ orchestrator: Array.from({ length: 20 }, () => ({ thinking: 'still going' })) });
    const out = await run(ask, { limits: { maxOrchestratorTurns: 3 } });
    expect(out.turns).toBe(3);
    expect(out.stoppedBecause).toMatch(/turn limit/);
    // it still reports what it had, and does not claim to have finished
    expect(out.result).toBeTruthy();
    expect(out.result.rows).toHaveLength(0);
  });

  it('24b · a task limit is enforced without crashing', async () => {
    const ask = controller({
      orchestrator: [
        { createTasks: Array.from({ length: 10 }, (_, i) => ({ type: 't', objective: `Q${i}` })) },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask, { limits: { maxOrchestratorTurns: 3, maxTasks: 4, specialistTurns: 1 } });
    expect(out.board.all().length).toBeLessThanOrEqual(4);
  });

  it('the board tracks the full lifecycle', () => {
    const board = new TaskBoard();
    const t = board.create({ type: 'x', objective: 'y', inputs: [], requestedEvidence: [] }, 1);
    expect(t.status).toBe('planned');
    expect(board.runnable()).toHaveLength(1);
    board.record(t.taskId, {
      taskId: t.taskId, status: 'completed', findings: [], evidenceIds: [], imagesInspected: [],
      confidence: 0.5, unresolved: [], conflicts: [], recommendations: [], proposals: [], toolCalls: 0, aiCalls: 1,
    });
    expect(board.get(t.taskId)!.status).toBe('completed');
    expect(board.runnable()).toHaveLength(0);
    expect(board.render()).toMatch(/TASK-001 \[completed\]/);
  });
});

const DXF = join(process.cwd(), 'drawing example/BBS/BBS', 'GAMCO - BOUNDARY WALL DETAILS - LEVEL DIFFERENCE 900MM - 07.07.2026.dxf');

describe.skipIf(!existsSync(DXF))('the real GAMCO sheet', () => {
  const real = () => {
    const d = parseDXF(readFileSync(DXF, 'utf8'), 'GAMCO.dxf');
    return { doc: d, extract: extractDrawing(d) };
  };

  it('the opening briefing gives the orchestrator the sheet, not a checklist', async () => {
    const r = real();
    const ask = controller({ orchestrator: [{ done: { why: 'x' } }] });
    await runOrchestrator({
      doc: r.doc, extract: r.extract, projectFacts: RUN, ask: ask as never, rasterise,
      now: () => 1, limits: { maxOrchestratorTurns: 1 },
    });
    const p = promptFor(ask, 'orchestrator');
    // it is told what exists…
    expect(p).toMatch(/8 member\(s\)/);
    expect(p).toMatch(/32 reinforcement callout\(s\)/);
    expect(p).toMatch(/BAND-01 axis x drawn extent 24948 mm/);
    expect(p).toMatch(/a crop of this shows the layout/);
    expect(p).toMatch(/PROJECT RUN: 100000 mm/);
    // …and NOT what order to do it in
    expect(p).not.toMatch(/WHAT THE SCHEDULE STILL NEEDS/);
    expect(p).not.toMatch(/placement — \d+ of \d+ member\(s\) have none/);
    expect(p).not.toMatch(/first.*then.*then/i);
  });

  it('nothing in the briefing answers the template question for it', async () => {
    const r = real();
    const ask = controller({ orchestrator: [{ done: { why: 'x' } }] });
    await runOrchestrator({
      doc: r.doc, extract: r.extract, projectFacts: RUN, ask: ask as never, rasterise,
      now: () => 1, limits: { maxOrchestratorTurns: 1 },
    });
    const p = promptFor(ask, 'orchestrator');
    // the two numbers are both present…
    expect(p).toMatch(/24948 mm/);
    expect(p).toMatch(/100000 mm/);
    // …and nothing relates them, suggests a ratio, or names a placement kind
    expect(p).not.toMatch(/template-repeat/);
    expect(p).not.toMatch(/100000\s*\/\s*24948|four times|÷/);
    expect(p).not.toMatch(/is a template|is the whole job/);
  });

  it('the eight canonical members reach the orchestrator by name', async () => {
    const r = real();
    const ask = controller({ orchestrator: [{ done: { why: 'x' } }] });
    await runOrchestrator({
      doc: r.doc, extract: r.extract, projectFacts: RUN, ask: ask as never, rasterise,
      now: () => 1, limits: { maxOrchestratorTurns: 1 },
    });
    const p = promptFor(ask, 'orchestrator');
    for (const mark of ['SC', 'TB', 'C1', 'C2', 'F1', 'RCC WALL', 'H-POLE', 'PRECACT PANEL']) {
      expect(p).toContain(`"${mark}"`);
    }
  });
});

// ============================================================
// the splitter hand-off — sections reach the orchestrator as evidence
// ============================================================

const SECTIONS = [
  {
    sectionId: 'REGION-03', label: 'TYPICAL DETAIL OF C1-350x350', kind: 'detail',
    bounds: { x1: 10257100, y1: -6269520, x2: 10264518, y2: -6264123 },
    entityCount: 60, confidence: 0.9,
    memberHints: [{ mark: 'C1', basis: 'title text in region' }],
    png: `data:image/png;base64,${'A'.repeat(900)}`,
  },
  {
    sectionId: 'REGION-15', label: 'FOOTING LAYOUT', kind: 'foundation',
    bounds: { x1: 10245738, y1: -6294208, x2: 10277539, y2: -6279158 },
    entityCount: 628, confidence: 0.4,
    memberHints: [{ mark: 'F1', basis: 'labels printed in region' }],
    png: `data:image/png;base64,${'B'.repeat(900)}`,
  },
  {
    sectionId: 'REGION-16', label: 'NOTES', kind: 'note',
    bounds: { x1: 10275379, y1: -6277592, x2: 10282019, y2: -6268020 },
    entityCount: 57,
  },
];

describe('the drawing splitter hands over to the orchestrator', () => {
  const withSections = (ask: unknown, over: Record<string, unknown> = {}) =>
    runOrchestrator({
      doc: doc(), extract: extract(), projectFacts: RUN, ask: ask as never, rasterise, now: () => 1,
      sections: SECTIONS,
      sectionSummary: 'a single-sheet boundary wall drawing in three zones',
      sectionRelationships: [{ from: 'REGION-15', to: 'REGION-14', kind: 'supports', basis: 'F1 footings carry the tie beams' }],
      limits: { maxOrchestratorTurns: 2, specialistTurns: 1 },
      ...over,
    });

  it('every section reaches the briefing with a croppable box', async () => {
    const ask = controller({ orchestrator: [{ done: { why: 'x' } }] });
    await withSections(ask);
    const p = promptFor(ask, 'orchestrator');
    expect(p).toMatch(/THIS SHEET HAS ALREADY BEEN SPLIT INTO 3 SECTION\(S\)/);
    expect(p).toMatch(/a single-sheet boundary wall drawing in three zones/);
    for (const s of SECTIONS) {
      expect(p).toContain(s.sectionId);
      expect(p).toContain(s.label);
      expect(p).toContain(`x1:${Math.round(s.bounds.x1)}`);
    }
    expect(p).toMatch(/crop it with getDrawingRegionImage to look closer/);
    expect(p).toMatch(/REGION-15 supports REGION-14 — F1 footings carry the tie beams/);
  });

  it('the splitter\'s own renders are attached to the first turn, and cost nothing', async () => {
    const ask = controller({ orchestrator: [{ done: { why: 'x' } }] });
    const out = await withSections(ask);
    const images = (ask as never as { mock: { calls: { 0: { label: string; images: unknown[] } }[] } }).mock.calls
      .filter((c) => c[0].label === 'orchestrator')[0][0].images;
    expect(images).toHaveLength(2);                    // the two that carry a png
    expect((images[0] as { caption: string }).caption).toMatch(/REGION-03 — TYPICAL DETAIL OF C1-350x350/);
    expect(out.toolCalls).toBe(0);                     // nothing was re-rendered to show them
    expect(out.imagesRendered).toBe(0);
  });

  it('member hints travel as HINTS and are never ownership', async () => {
    const ask = controller({ orchestrator: [{ done: { why: 'x' } }] });
    await withSections(ask);
    const p = promptFor(ask, 'orchestrator');
    expect(p).toMatch(/labels seen here \(HINTS, not assignments\): C1 \(title text in region\)/);
    expect(p).toMatch(/They are not ownership, not placement and\s+not a count/);
    // and nothing is pre-owned
    expect(p).toMatch(/ownership: 0 callout\(s\) claimed/);
  });

  it('a low-confidence section says so rather than reading as settled', async () => {
    const ask = controller({ orchestrator: [{ done: { why: 'x' } }] });
    await withSections(ask);
    expect(promptFor(ask, 'orchestrator')).toMatch(/REGION-15.*\n.*|the splitter was only 40% sure of this one/);
  });

  it('specialists see the sections too, and can crop one', async () => {
    let orchTurn = 0;
    const ask = vi.fn(async (args: { label: string; images: unknown[]; prompt: string }) => {
      if (args.label === 'orchestrator') {
        orchTurn += 1;
        return orchTurn === 1
          ? { createTasks: [{ type: 'read', objective: 'read the C1 detail', inputs: ['REGION-03'] }] }
          : { done: { why: 'x' } };
      }
      if (args.images.length) return { findings: [{ statement: 'C1 carries 8-12TOR', imageIds: ['IMG-1'], confidence: 0.9 }], done: true };
      // the specialist was shown the section list, and crops one by its bounds
      expect(args.prompt).toMatch(/REGION-03/);
      return { requestTools: [{ tool: 'getDrawingRegionImage', args: { x1: -500, y1: -500, x2: 17000, y2: 900, reason: 'the C1 detail' } }] };
    });
    const out = await withSections(ask, { limits: { maxOrchestratorTurns: 3, specialistTurns: 3 } });
    expect(out.board.all()[0].result!.findings[0].statement).toMatch(/8-12TOR/);
    expect(out.imagesRendered).toBe(1);
  });

  it('no sections is still a working run — the splitter is optional', async () => {
    const ask = controller({ orchestrator: [{ done: { why: 'x' } }] });
    const out = await run(ask);
    expect(promptFor(ask, 'orchestrator')).not.toMatch(/ALREADY BEEN SPLIT/);
    expect(out.result).toBeTruthy();
  });

  it('the sections do NOT answer the run-versus-layout question', async () => {
    const ask = controller({ orchestrator: [{ done: { why: 'x' } }] });
    await withSections(ask);
    const p = promptFor(ask, 'orchestrator');
    expect(p).toMatch(/100000 mm/);
    expect(p).not.toMatch(/template-repeat/);
    expect(p).not.toMatch(/is a template|is the whole job|repeats \d+ times/);
    expect(p).not.toMatch(/100000\s*\/|÷/);
  });
});

// ============================================================
// Run 013 regressions — the lead keeps its clock, its voice and its turn
// ============================================================

describe('Run 013 — supervision plumbing', () => {
  it('the exact Run 013 turn-1 echo is refused as a no-action reply', async () => {
    // verbatim from run-013.md: the system prompt's worked example, echoed back
    const echo = {
      kind: 'own', calloutId: 'CALL-009', memberId: 'MEM-01', basis: 'in-detail',
      barType: 'MAIN', distributionAxis: 'H', evidenceIds: ['CALL-009', 'DECL-07'],
      reasoning: '…', confidence: 0.9,
    };
    const ask = controller({ orchestrator: [echo, { done: { why: 'x' } }] });
    const out = await run(ask);
    expect(out.noopReplies).toBe(1);
    expect(out.conclusionsAccepted).toBe(0);
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/CONTAINED NO ACTION/);
    expect(second).toMatch(/do not echo them back/);
  });

  it('a reply of only thinking is also a no-action reply', async () => {
    const ask = controller({ orchestrator: [{ thinking: 'pondering' }, { done: { why: 'x' } }] });
    const out = await run(ask);
    expect(out.noopReplies).toBe(1);
  });

  it('the orchestrator is shown the clock every turn', async () => {
    const ask = controller({ orchestrator: [{ done: { why: 'x' } }] });
    await run(ask);
    expect(promptFor(ask, 'orchestrator')).toMatch(/TIME: \d+ min used of \d+ — \d+ min remain/);
  });

  it('a batch stops at the deadline and hands control back, with the untouched tasks marked', async () => {
    let t = 0;
    let orchTurn = 0;
    const ask = vi.fn(async (args: { label: string }) => {
      if (args.label === 'orchestrator') {
        orchTurn += 1;
        return orchTurn === 1
          ? { createTasks: [{ type: 'a', objective: 'Q1' }, { type: 'b', objective: 'Q2' }, { type: 'c', objective: 'Q3' }] }
          : { done: { why: 'x' } };
      }
      t += 10_000_000;                     // one specialist call devours the clock
      return { findings: [{ statement: 'took forever', confidence: 0.5 }], done: true };
    });
    const out = await run(ask, {
      now: () => t,
      limits: { maxOrchestratorTurns: 4, maxMs: 120_000, taskConcurrency: 1, specialistTurns: 2 },
    });
    const results = out.board.all().map((x) => x.result!);
    // the first task ran; the deadline then stopped the batch before 2 and 3 began
    expect(results[0].findings).toHaveLength(1);
    expect(results[1].unresolved.join(' ')).toMatch(/deadline arrived before this task could begin/);
    expect(results[2].unresolved.join(' ')).toMatch(/deadline/);
    const spec = (ask as never as { mock: { calls: { 0: { label: string } }[] } }).mock.calls
      .filter((c) => c[0].label !== 'orchestrator');
    expect(spec).toHaveLength(1);          // only ONE specialist call was ever made
    expect(out.stoppedBecause).toMatch(/time limit/);
  });

  it('a specialist mid-question also stops at the deadline rather than starting another turn', async () => {
    let t = 0;
    let orchTurn = 0;
    const ask = vi.fn(async (args: { label: string }) => {
      if (args.label === 'orchestrator') {
        orchTurn += 1;
        return orchTurn === 1 ? { createTasks: [{ type: 'a', objective: 'Q1' }] } : { done: { why: 'x' } };
      }
      t += 10_000_000;
      // never says done — would loop through all its turns if time allowed
      return { requestTools: [{ tool: 'getMembers', args: {} }] };
    });
    const out = await run(ask, {
      now: () => t,
      limits: { maxOrchestratorTurns: 3, maxMs: 120_000, taskConcurrency: 1, specialistTurns: 3 },
    });
    const r = out.board.all()[0].result!;
    expect(r.aiCalls).toBe(1);             // turn 2 was never started
    expect(r.unresolved.join(' ')).toMatch(/deadline arrived before this question was finished/);
  });

  it('specialist proposals surface on the board in adoptable form', async () => {
    const ask = controller({
      orchestrator: [
        { createTasks: [{ type: 'read', objective: 'read the wall' }] },
        { done: { why: 'x' } },
      ],
      specialist: [{
        findings: [{ statement: 'the wall owns CALL-002', evidenceIds: ['CALL-002'], confidence: 0.9 }],
        proposals: [{ kind: 'own', calloutId: 'CALL-002', memberId: 'MEM-02', basis: 'in-detail', barType: 'MAIN', evidenceIds: ['CALL-002'] }],
        done: true,
      }],
    });
    await run(ask);
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/> proposes: \{"kind":"own","calloutId":"CALL-002"/);
  });

  it('the splitter briefing says its section ids are not crop-tool ids — bounds only', async () => {
    const ask = controller({ orchestrator: [{ done: { why: 'x' } }] });
    await runOrchestrator({
      doc: doc(), extract: extract(), projectFacts: RUN, ask: ask as never, rasterise, now: () => 1,
      sections: [{ sectionId: 'SPLIT-01', label: 'FOOTING LAYOUT', kind: 'layout', bounds: { x1: 0, y1: -100, x2: 100, y2: 0 } }],
      limits: { maxOrchestratorTurns: 1 },
    });
    const p = promptFor(ask, 'orchestrator');
    expect(p).toMatch(/splitter's own naming — the crop tool does NOT recognise them/);
    expect(p).toMatch(/ask by its BOUNDS/);
  });
});

// ============================================================
// Run 015 — the conclusion contract, branch by branch
//
// Run 014 died on {"kind":"dependent"} with no fields: the kind passed the
// enum check, nothing looked deeper, and `.length` threw inside the FINAL
// build. The schema audit found three siblings of the same class still alive.
// These tests replay each one and hold the two properties that matter: the
// refusal NAMES the missing piece, and the host NEVER dies.
// ============================================================

describe('Run 015 — the conclusion contract', () => {
  it('the Run 014 killer — a dependent placement without parents is refused by name, and the run survives', async () => {
    // verbatim shape from bbs-runs/run-014.md
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'placement', memberId: 'MEM-01', placement: { kind: 'dependent', runFactId: 'run' }, evidenceIds: ['FACT-run'] }], build: true },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsRefused).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/parentMemberIds/);
    // the run did not crash: the final build still ran and reported
    expect(out.builds.length).toBeGreaterThan(0);
    expect(out.result).toBeTruthy();
  });

  it('a placement conclusion with no memberId at all is refused, never dereferenced', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'placement', placement: { kind: 'continuous', runFactId: 'run' } }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsRefused).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/memberId/);
  });

  it('ghost occurrence ids — prose is not an id, and the refusal names the ghosts', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'placement', memberId: 'MEM-01', placement: {
          kind: 'template-repeat', panelId: 'BAND-01', runFactId: 'run',
          orderedOccurrenceIds: ['BAND-01 C1 marks', 'MARK-C1-001'],
        } }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsRefused).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/BAND-01 C1 marks/);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/not evidence/);
  });

  it('a template-repeat naming a band that does not exist is refused with the bands listed', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'placement', memberId: 'MEM-01', placement: {
          kind: 'template-repeat', panelId: 'BAND-99', runFactId: 'run', orderedOccurrenceIds: ['MARK-C1-001'],
        } }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsRefused).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/BAND-99.*not a layout band/);
  });

  it('a valid template-repeat with real mark ids is accepted and counted by the engine', async () => {
    const marks = ['MARK-C1-001', 'MARK-C1-002', 'MARK-C1-003', 'MARK-C1-004', 'MARK-C1-005'];
    const ask = controller({
      orchestrator: [
        {
          conclusions: [
            { kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', distributionAxis: 'H', evidenceIds: ['CALL-001'] },
            { kind: 'placement', memberId: 'MEM-01', placement: { kind: 'template-repeat', panelId: 'BAND-01', runFactId: 'run', orderedOccurrenceIds: marks }, evidenceIds: marks },
          ],
          build: true,
        },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsAccepted).toBe(2);
    // 5 nodes over 16000 mm -> template 20000 mm; 100000 mm run = 5 whole templates x 5 = 25
    const c1 = out.result.members.find((m) => m.mark === 'C1');
    expect(c1?.count).toBe(25);
  });

  it('a one-sided difference ref is refused gracefully, never crashed on', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'dimension', memberId: 'MEM-01', axis: 'H', ref: { kind: 'difference', a: { kind: 'entity-number', evidenceId: 'DIM-001', part: 1 } } }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsRefused).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/difference.*"b" is missing/);
  });

  it('a dimension-path whose segments are not an array is refused gracefully', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'dimension', memberId: 'MEM-01', axis: 'H', ref: { kind: 'dimension-path', axis: 'y', fromAnchor: 'A', toAnchor: 'B', segmentEvidenceIds: 3 } }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsRefused).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/must be an array of dimension evidence ids/);
  });

  it('one malformed conclusion no longer discards the sound ones beside it', async () => {
    const ask = controller({
      orchestrator: [
        {
          conclusions: [
            { kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', evidenceIds: ['CALL-001'] },
            { kind: 'placement', memberId: 'MEM-01', placement: { kind: 'dependent' } },
          ],
        },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsAccepted).toBe(1);
    expect(out.conclusionsRefused).toBe(1);
  });

  it('the prompt teaches every placement kind and every ref kind — dimension-path included', async () => {
    const { ORCHESTRATOR_SYSTEM } = await import('../../src/cad/bbs/orchestrate');
    for (const kind of ['continuous', 'marks', 'template-repeat', 'periodic-pattern', 'uniform', 'dependent', 'once']) {
      expect(ORCHESTRATOR_SYSTEM, `placement kind ${kind}`).toMatch(new RegExp(`"kind":"${kind}"`));
    }
    expect(ORCHESTRATOR_SYSTEM).toMatch(/parentMemberIds/);
    for (const ref of ['entity-number', 'dimension-path', 'difference', 'table-number', 'user-fact']) {
      expect(ORCHESTRATOR_SYSTEM, `ref kind ${ref}`).toMatch(new RegExp(`"kind":"${ref}"`));
    }
    // the row consequence, both directions
    expect(ORCHESTRATOR_SYSTEM).toMatch(/owned ONCE/);
    expect(ORCHESTRATOR_SYSTEM).toMatch(/counts the same bar twice/);
    // member-level exclusion
    expect(ORCHESTRATOR_SYSTEM).toMatch(/"kind":"exclude","memberId"/);
  });
});

// ============================================================
// Run 015 — member exclusion, duplicates, and what a build feeds back
// ============================================================

describe('Run 015 — exclusion and build feedback', () => {
  it('a member excluded by conclusion stops being reported as missing bars, and stays on the record', async () => {
    const ask = controller({
      orchestrator: [
        {
          conclusions: [
            { kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', evidenceIds: ['CALL-001'] },
            { kind: 'exclude', memberId: 'MEM-02', why: 'a precast supply item, drawn for context' },
          ],
          build: true,
        },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsAccepted).toBe(2);
    const b = out.builds[0];
    expect(b.membersExcluded).toEqual([{ mark: 'RCC WALL', why: 'a precast supply item, drawn for context' }]);
    expect(b.membersWithoutBars).not.toContain('RCC WALL');
    // no coverage failure for the excluded member
    expect(b.failures.filter((f) => f.memberMark === 'RCC WALL')).toHaveLength(0);
    // and the next prompt shows the exclusion, so the lead can see its own record
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/excluded by your conclusions.*RCC WALL/);
  });

  it('an exclusion naming neither a callout nor a member is refused', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'exclude', why: 'just because' }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsRefused).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/names a calloutId/);
  });

  it('one member owning two identical annotations is surfaced as a QUESTION, not silently doubled or collapsed', async () => {
    // a second callout node with the same text as CALL-002
    const ex = extract();
    (ex as unknown as { callouts: unknown[] }).callouts.push(
      { raw: '10TOR@200C/C', handle: 'A3', position: { x: 500, y: -19000 }, diaMm: 10, spacingMm: 200 },
    );
    const ask = controller({
      orchestrator: [
        {
          conclusions: [
            { kind: 'own', calloutId: 'CALL-002', memberId: 'MEM-02', basis: 'in-detail', barType: 'MAIN', distributionAxis: 'L', evidenceIds: ['CALL-002'] },
            { kind: 'own', calloutId: 'CALL-003', memberId: 'MEM-02', basis: 'in-detail', barType: 'MAIN', distributionAxis: 'L', evidenceIds: ['CALL-003'] },
            { kind: 'placement', memberId: 'MEM-02', placement: { kind: 'continuous', runFactId: 'run' }, evidenceIds: ['FACT-run'] },
          ],
          build: true,
        },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask, { extract: ex });
    const b = out.builds[0];
    expect(b.duplicateSuspects).toHaveLength(1);
    expect(b.duplicateSuspects[0]).toMatch(/RCC WALL owns 2 callouts all reading "10TOR@200C\/C"/);
    // both are still scheduled — the ENGINE does not decide which reading is right
    expect(out.result.rows.filter((r) => r.memberMark === 'RCC WALL').length).toBe(2);
    // and the question reaches the model
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/DUPLICATE\?/);
  });

  it('a compound callout fans out into one row per component — the second set is never dropped', async () => {
    const ex = extract();
    (ex as unknown as { callouts: unknown[] }).callouts.push(
      { raw: '2-16TOR+2-12TOR', handle: 'A4', position: { x: 600, y: -19000 }, diaMm: 16, count: 2, secondDiaMm: 12, secondCount: 2 },
    );
    const ask = controller({
      orchestrator: [
        {
          conclusions: [
            { kind: 'own', calloutId: 'CALL-003', memberId: 'MEM-02', basis: 'in-detail', barType: 'MAIN', evidenceIds: ['CALL-003'] },
            { kind: 'placement', memberId: 'MEM-02', placement: { kind: 'continuous', runFactId: 'run' }, evidenceIds: ['FACT-run'] },
          ],
          build: true,
        },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask, { extract: ex });
    const wall = out.result.rows.filter((r) => r.memberMark === 'RCC WALL');
    expect(wall.map((r) => r.diameterMm).sort()).toEqual([12, 16]);
  });

  it('the engine SANITY voice reaches the build attempt and the model', async () => {
    const ask = controller({
      orchestrator: [
        {
          conclusions: [
            { kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', distributionAxis: 'H', evidenceIds: ['CALL-001'] },
          ],
          build: true,
        },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    // a near-empty schedule over a 100 m run is far below any plausible kg/m
    expect(out.builds[0].sanity.some((s) => /SANITY/.test(s))).toBe(true);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/SANITY/);
  });

  it('a build reports what it computed per member — dims echoed so a mis-pointed height stands out', async () => {
    const ask = controller({
      orchestrator: [
        {
          conclusions: [
            { kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', distributionAxis: 'H', evidenceIds: ['CALL-001'] },
          ],
          build: true,
        },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.builds[0].memberSummary.length).toBeGreaterThan(0);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/C1: count /);
  });
});

// ============================================================
// Run 016 — recording cadence
//
// Run 015 crashed nothing and refused nothing. It dispatched twenty-nine
// investigations across five turns, recorded NOTHING, twice announced it would
// record next turn and dispatched again — then tried to record everything in a
// single reply and timed out generating it, twice. The board was never the
// problem: the turn-5 prompt was 12k tokens. Deferring all recording to one
// turn was.
//
// These hold the two things that make deferral visible and unnecessary.
// ============================================================

describe('Run 016 — recording cadence', () => {
  it('investigations that reported while nothing is recorded are named as an imbalance', async () => {
    const ask = controller({
      orchestrator: [
        { createTasks: [{ type: 'read', objective: 'A' }, { type: 'read', objective: 'B' }] },
        { done: { why: 'x' } },
      ],
    });
    await run(ask);
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/2 investigation\(s\) have reported and NOTHING is recorded/);
    expect(second).toMatch(/none of it survives this run unrecorded/);
  });

  it('the imbalance line disappears the moment anything is recorded', async () => {
    const ask = controller({
      orchestrator: [
        {
          createTasks: [{ type: 'read', objective: 'A' }],
          conclusions: [{ kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', evidenceIds: ['CALL-001'] }],
        },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsAccepted).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).not.toMatch(/NOTHING is recorded/);
  });

  it('the prompt requires recording in the same reply that reads the results', async () => {
    const { ORCHESTRATOR_SYSTEM } = await import('../../src/cad/bbs/orchestrate');
    expect(ORCHESTRATOR_SYSTEM).toMatch(/RECORD AS YOU GO/);
    expect(ORCHESTRATOR_SYSTEM).toMatch(/A finding is not a conclusion/);
    // the prompt is hard-wrapped, so the phrase may straddle a line break
    expect(ORCHESTRATOR_SYSTEM).toMatch(/Do\s+not save recording for a final turn/);
  });

  it('the specialist prompt says conflicts and unresolved are plain sentences', async () => {
    const { SPECIALIST_SYSTEM } = await import('../../src/cad/bbs/tasks');
    expect(SPECIALIST_SYSTEM).toMatch(/lists of PLAIN SENTENCES — one string each, not objects/);
    // and the worked example shows one, rather than an empty array that teaches nothing
    expect(SPECIALIST_SYSTEM).toMatch(/"conflicts":\["TASK-004 put CALL-009/);
  });

  it('a conflicts entry sent as an object is still refused, naming the path — never coerced', async () => {
    const checked = validate(
      { findings: [], conflicts: [{ statement: 'x', evidenceIds: ['CALL-001'] }], done: true },
      SPECIALIST_REPLY,
    );
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problems[0].path).toBe('conflicts[0]');
  });
});

// ============================================================
// Run 017 — a bad field must not discard a good one
//
// Run 016 converted on turn 8: thirteen exclusions, an ownership and a
// placement, the first real recording of the run. Its `plan` was a string
// where a list of strings was declared, the WHOLE reply was refused, all
// fifteen conclusions were discarded, and the model resent only the plan. A
// narration field the engine does nothing with cost the run its best turn.
//
// Then turn 10 sent one bare conclusion as the entire reply. The generic "no
// action" message named nothing it could act on, and turns 11 and 12 decayed
// to {"createTasks":[]} and {}.
// ============================================================

describe('Run 017 — partial application', () => {
  it('a malformed plan does not discard the conclusions sent beside it', async () => {
    const ask = controller({
      orchestrator: [
        {
          plan: 'Record now: exclude duplicates, then build',   // a string, not a list
          conclusions: [
            { kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', evidenceIds: ['CALL-001'] },
            { kind: 'own', calloutId: 'CALL-002', memberId: 'MEM-02', basis: 'in-detail', barType: 'MAIN', evidenceIds: ['CALL-002'] },
          ],
        },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsAccepted).toBe(2);      // the good half landed
    expect(out.malformedReplies).toBe(1);          // and the bad half was still reported
    expect(out.plans).toHaveLength(0);             // the malformed field was NOT applied
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/PART OF YOUR LAST REPLY WAS APPLIED: conclusions/);
    expect(second).toMatch(/plan — expected an array of a string/);
    expect(second).toMatch(/Re-send ONLY those fields, corrected/);
  });

  it('a reply whose every field is malformed is still refused whole', async () => {
    const ask = controller({
      orchestrator: [
        { plan: 'not a list', unresolved: 'not a list either' },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.malformedReplies).toBe(1);
    expect(out.conclusionsAccepted).toBe(0);
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/Nothing in it was applied/);
  });

  it('a bare conclusion sent as the whole reply is named, not called "no action"', async () => {
    const bare = { kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', evidenceIds: ['CALL-001'] };
    const ask = controller({ orchestrator: [bare, { done: { why: 'x' } }] });
    const out = await run(ask);
    expect(out.noopReplies).toBe(1);
    expect(out.conclusionsAccepted).toBe(0);        // nothing was assumed on its behalf
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/It was a single OWN conclusion sent on its own/);
    expect(second).toMatch(/goes in the "conclusions" list/);
    expect(second).toMatch(/\{"conclusions":\[\{"kind":"own"/);
  });

  it('a genuinely empty reply still gets the plain no-action message', async () => {
    const ask = controller({ orchestrator: [{}, { done: { why: 'x' } }] });
    const out = await run(ask);
    expect(out.noopReplies).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/CONTAINED NO ACTION/);
  });
});

// ============================================================
// Run 017 — the sheet's own declarations reach the orchestrated build
// ============================================================

describe('Run 017 — declared dimensions are grounded', () => {
  it("a member's declared cross-section fills the axes the model never pointed at", async () => {
    const ask = controller({
      orchestrator: [
        {
          conclusions: [
            { kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', distributionAxis: 'H', evidenceIds: ['CALL-001'] },
          ],
          build: true,
        },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    // the sheet declares C1 350x350 — the build must not report L and W missing
    const c1 = out.result.members.find((m) => m.mark === 'C1');
    expect(c1?.dims.L).toBe(350);
    expect(c1?.dims.W).toBe(350);
    expect(out.builds[0].failures.filter((f) => f.memberMark === 'C1' && (f.field === 'L' || f.field === 'W'))).toHaveLength(0);
    // H is NOT declared, and is still honestly reported as unresolved
    expect(c1?.dims.H).toBeUndefined();
  });

  it('a dimension the model established still wins over the declaration', async () => {
    const ask = controller({
      orchestrator: [
        {
          conclusions: [
            { kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', distributionAxis: 'H', evidenceIds: ['CALL-001'] },
            { kind: 'dimension', memberId: 'MEM-01', axis: 'W', ref: { kind: 'user-fact', factId: 'sectionWidth' } },
          ],
          build: true,
        },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask, {
      projectFacts: { ...RUN, sectionWidth: { mm: 900, saidAs: '900 mm' } },
    });
    const c1 = out.result.members.find((m) => m.mark === 'C1');
    expect(c1?.dims.W).toBe(900);        // the conclusion, not the declared 350
  });
});

// ============================================================
// Run 019 — a reply that cannot be READ is still answered
//
// Run 019's lead answered turn 2 with a sentence of narration and then its
// JSON: twelve conclusions, twelve thousand characters, exactly the work the
// run needed. The harness could not parse it, `runOrchestrator` took the
// null-reply branch, and that branch said NOTHING to anyone — no feedback, no
// counter, no event. Turn 3 repeated turn 2 almost verbatim, because nothing
// had told it the first was never received. Three turns, nothing recorded.
// ============================================================

describe('Run 019 — an unreadable reply', () => {
  it('is reported to the model instead of being dropped in silence', async () => {
    let call = 0;
    const ask = vi.fn(async (args: { label: string }) => {
      if (args.label !== 'orchestrator') return { findings: [], done: true };
      call += 1;
      return call === 1 ? null : { done: { why: 'x' } };   // null = the harness could not read it
    });
    const out = await run(ask);
    expect(out.unreadableReplies).toBe(1);
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/NEVER REACHED ME/);
    expect(second).toMatch(/failed in transport, came back empty, or could not/);
    expect(second).toMatch(/not a refusal/);
    expect(second).toMatch(/send it in two turns rather than one/);
  });

  it('does not count as malformed or as no-action — they are different failures', async () => {
    let call = 0;
    const ask = vi.fn(async (args: { label: string }) => {
      if (args.label !== 'orchestrator') return { findings: [], done: true };
      call += 1;
      return call === 1 ? null : { done: { why: 'x' } };
    });
    const out = await run(ask);
    expect(out.unreadableReplies).toBe(1);
    expect(out.malformedReplies).toBe(0);
    expect(out.noopReplies).toBe(0);
  });
});

// ============================================================
// Run 020 — what a run that nearly worked showed
//
// Run 020 placed and dimensioned all six reinforced members, excluded the two
// bought items, and passed every gate but the referee. Three things still cost
// it: twenty conclusions sent under "record" and dropped in silence, eight
// evidence citations of REGION ids the briefing itself advertises, and three
// columns standing 350 mm tall because a cross-section was pointed at as a
// height and nothing could be traced back.
// ============================================================

describe('Run 020 — the last silent losses', () => {
  it('conclusions sent under a synonym are named, not dropped in silence', async () => {
    const ask = controller({
      orchestrator: [
        {
          record: [{ kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', evidenceIds: ['CALL-001'] }],
          build: true,
        },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsAccepted).toBe(0);            // nothing was guessed on its behalf
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/record — expected nothing — this contract reads "conclusions"/);
    expect(second).toMatch(/PART OF YOUR LAST REPLY WAS APPLIED: build/);
  });

  it('an unrecognised field is named with the fields that do exist', async () => {
    const ask = controller({
      orchestrator: [
        { notes: 'some thoughts', understanding: 'a boundary wall sheet' },
        { done: { why: 'x' } },
      ],
    });
    await run(ask);
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/notes — expected nothing — "notes" is not a field of this reply/);
    expect(second).toMatch(/The fields are: understanding, plan, thinking, createTasks, conclusions/);
  });

  it('a region id is evidence — the briefing offers it, so the contract accepts it', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', evidenceIds: ['CALL-001', 'REGION-01'] }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsAccepted).toBe(1);
    expect(out.conclusionsRefused).toBe(0);
  });

  it('an id that is nothing at all is still refused by name', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', evidenceIds: ['REGION-99'] }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsRefused).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/REGION-99 — not evidence on this sheet/);
  });

  it('a bare task sent as the whole reply is named, like a bare conclusion is', async () => {
    const ask = controller({
      orchestrator: [
        { type: 'detail-read', objective: 'Read the C1 typical detail', inputs: ['MEM-01'] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.noopReplies).toBe(1);
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/It was a single task sent on its own/);
    expect(second).toMatch(/\{"createTasks":\[\{"type":"detail-read"/);
  });

  it('a dimension carries the working it was read from into the build feedback', async () => {
    const ask = controller({
      orchestrator: [
        {
          conclusions: [
            { kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', distributionAxis: 'H', evidenceIds: ['CALL-001'] },
            { kind: 'dimension', memberId: 'MEM-01', axis: 'H', ref: { kind: 'user-fact', factId: 'colHeight' } },
          ],
          build: true,
        },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask, { projectFacts: { ...RUN, colHeight: { mm: 2700, saidAs: '2.7 m' } } });
    const c1 = out.builds[0].memberSummary.find((m) => m.mark === 'C1');
    expect(c1?.H).toBe(2700);
    expect(c1?.sources?.H).toMatch(/2700 mm/);
    // and the lead can see WHERE it came from, not just the number
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/H ← 2700 mm/);
  });
});

// ============================================================
// Run 021 — the same contradiction, one namespace over
//
// Run 020 cited REGION ids and was told they were not evidence; that was
// fixed. Run 021 then cited SPLIT-14 — a splitter section the briefing
// describes with its bounds — and was refused three times running, losing the
// tie beam's placement, because the fix had been made for one namespace and
// not the rule. What this run TOLD the model about, the model may cite.
// ============================================================

describe('Run 021 — a splitter section is evidence too', () => {
  const withSections = {
    sections: [{ sectionId: 'SPLIT-14', label: 'TIE BEAM LAYOUT', kind: 'layout', bounds: { x1: 0, y1: -100, x2: 100, y2: 0 } }],
  };

  it('a section id the briefing named is accepted as provenance', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'placement', memberId: 'MEM-02', placement: { kind: 'continuous', runFactId: 'run' }, evidenceIds: ['SPLIT-14', 'FACT-run'] }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask, withSections);
    expect(out.conclusionsAccepted).toBe(1);
    expect(out.conclusionsRefused).toBe(0);
  });

  it('a section id that was never supplied is still refused by name', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'placement', memberId: 'MEM-02', placement: { kind: 'continuous', runFactId: 'run' }, evidenceIds: ['SPLIT-99'] }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask, withSections);
    expect(out.conclusionsRefused).toBe(1);
    expect(promptFor(ask, 'orchestrator', 1)).toMatch(/SPLIT-99 — not evidence on this sheet/);
  });

  it('everything the briefing names is citable: bands, regions and sections alike', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', evidenceIds: ['CALL-001', 'BAND-01', 'REGION-01', 'SPLIT-14'] }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask, withSections);
    expect(out.conclusionsAccepted).toBe(1);
    expect(out.conclusionsRefused).toBe(0);
  });
});

// ============================================================
// Run 022 — a refusal that names the ids that DO exist
//
// Run 022 guessed the occurrence-id padding — MARK-C1-01 where the sheet
// numbers MARK-C1-001 — and was refused three times for three members over
// one missing digit. The registry had held those ids the whole time.
// ============================================================

describe('Run 022 — the ghost-id refusal helps', () => {
  it('names the real occurrences when the ones sent do not exist', async () => {
    const ask = controller({
      orchestrator: [
        { conclusions: [{ kind: 'placement', memberId: 'MEM-01', placement: {
          kind: 'template-repeat', panelId: 'BAND-01', runFactId: 'run',
          orderedOccurrenceIds: ['MARK-C1-01', 'MARK-C1-02'],
        } }] },
        { done: { why: 'x' } },
      ],
    });
    const out = await run(ask);
    expect(out.conclusionsRefused).toBe(1);
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/MARK-C1-01, MARK-C1-02/);              // what was wrong
    expect(second).toMatch(/C1's occurrences on this sheet are: MARK-C1-001/);  // and what exists
    // choosing WHICH of them belong to the template is still the model's call
    expect(second).toMatch(/Choose from those the ones that sit in the panel you named/);
  });
});

// ============================================================
// the rebuilt product path: saved reading → interview → judge
// ============================================================

describe('the complete product handoff', () => {
  const OWN_WALL_PRODUCT = {
    kind: 'own', calloutId: 'CALL-002', memberId: 'MEM-02', basis: 'in-detail',
    barType: 'MAIN', distributionAxis: 'W', evidenceIds: ['CALL-002'],
  };

  it('revalidates About Drawing conclusions and includes saved section context', async () => {
    const ask = controller({ orchestrator: [{ done: { why: 'the saved reading is sufficient' } }] });
    const out = await run(ask, {
      aboutDrawing: '## ABOUT DRAWING\nA prior evidence reading is on file.',
      priorConclusions: [OWN_WALL_PRODUCT],
      sections: [{
        sectionId: 'REGION-01', label: 'WALL DETAIL', kind: 'detail',
        bounds: { x1: 0, y1: -21000, x2: 2000, y2: -18000 },
        entityCount: 12, memberHints: [{ mark: 'RCC WALL', basis: 'printed label' }],
      }],
      sectionSummary: 'one wall detail and one layout',
    });
    expect(out.acceptedConclusions).toContainEqual(OWN_WALL_PRODUCT);
    expect(out.conclusionsAccepted).toBeGreaterThan(0);
    const prompt = promptFor(ask, 'orchestrator');
    expect(prompt).toContain('THIS SHEET HAS ALREADY BEEN SPLIT');
    expect(prompt).toContain('REGION-01');
    expect(prompt).toContain('ABOUT DRAWING');
  });

  it('asks for a missing run, applies the typed answer, and continues the same run', async () => {
    const askUser = vi.fn(async (_question: { writesTo: { field: string } }) => '100');
    const ask = controller({
      orchestrator: [
        { askUser: [{ question: 'What is the total run of this wall?', whyNeeded: 'The wall quantity multiplies over it.' }] },
        {
          conclusions: [
            OWN_WALL_PRODUCT,
            { kind: 'placement', memberId: 'MEM-02', placement: { kind: 'continuous', runFactId: 'run' }, evidenceIds: ['FACT-run'] },
          ],
          build: true,
          done: { why: 'the user supplied the run' },
        },
      ],
    });
    const out = await run(ask, { projectFacts: {}, askUser });
    expect(askUser).toHaveBeenCalled();
    expect(askUser.mock.calls[0][0].writesTo.field).toBe('run');
    expect(out.conclusionsRefused).toBe(0);
    expect(out.builds[out.builds.length - 1]?.membersWithoutPlacement).not.toContain('RCC WALL');
    expect(out.result.project.runMm).toBe(100000);
  });

  // ----------------------------------------------------------
  // A schedule with open rows must never be handed over with a
  // question nobody put. Two ceilings used to do exactly that.
  // ----------------------------------------------------------

  it('still asks when the model has spent its rebuild budget', async () => {
    // `maxBuilds` rations AI turns spent on rebuild churn. `buildOnce` is
    // deterministic and costs no call, so a rebuild the USER paid for with an
    // answer is not what that budget is rationing — but the ask was gated on
    // `builds.length < limits.maxBuilds` and so was skipped outright, leaving
    // the user holding open rows they were never given the chance to close.
    const askUser = vi.fn(async (_q: { id: string; writesTo: { field: string } }) => '2400');
    const ask = controller({
      orchestrator: [{ build: true, done: { why: 'built once, budget spent' } }],
    });
    const out = await run(ask, { projectFacts: {}, askUser, limits: { maxBuilds: 1 } });

    expect(out.builds.length).toBeGreaterThanOrEqual(1);
    expect(askUser).toHaveBeenCalled();
  });

  it('goes back for a second round when one round could not ask everything', async () => {
    // It used to be ONE round of at most eight questions. A ninth hole was
    // never raised and nothing ever came back to it. Squeezed to one question
    // per round here, the loop must still reach the others.
    const asked: string[] = [];
    const askUser = vi.fn(async (q: { id: string }) => {
      asked.push(q.id);
      return '2400';
    });
    const ask = controller({ orchestrator: [{ done: { why: 'over to the user' } }] });
    await run(ask, {
      projectFacts: {},
      askUser,
      limits: { maxQuestionsPerRound: 1, maxAskRounds: 3 },
    });

    expect(asked.length).toBeGreaterThan(1);
    expect(new Set(asked).size).toBe(asked.length); // and never the same one twice
  });

  it('asks how many, and the answer places the member', async () => {
    // A stalled placement blocks EVERY row its member carries, and it was the
    // one failure a person was never asked about: `questionFrom` types it as a
    // six-option taxonomy, the final ask dropped everything that was not
    // millimetres, and `askAndApply` discarded any answer without `.mm`.
    //
    // So the count is the assertion under test, not the question. Being asked
    // and still blocked is worse than not being asked — it spends the user's
    // attention and changes nothing.
    const askUser = vi.fn(async (q: { id: string; answerType: string; question: string }) =>
      q.answerType === 'number-count' ? '4' : '2400',
    );
    const ask = controller({ orchestrator: [{ build: true, done: { why: 'over to the user' } }] });
    const out = await run(ask, { projectFacts: {}, askUser, limits: { maxBuilds: 1 } });

    const counts = askUser.mock.calls.map((c) => c[0]).filter((q) => q.answerType === 'number-count');
    expect(counts.length).toBeGreaterThan(0);
    expect(counts[0].question).toMatch(/how many/i);

    const last = out.builds[out.builds.length - 1];
    expect(last.membersWithoutPlacement ?? []).not.toContain('C1');
  });

  it('refuses a count that is not a whole number of things', async () => {
    // Rounding "3.5 columns" would be inventing a quantity — the one thing
    // this module exists not to do. It comes back as unresolved, named.
    const askUser = vi.fn(async (q: { answerType: string }) =>
      q.answerType === 'number-count' ? '3.5' : '2400',
    );
    const ask = controller({ orchestrator: [{ build: true, done: { why: 'over to the user' } }] });
    const out = await run(ask, { projectFacts: {}, askUser, limits: { maxBuilds: 1 } });

    expect(out.unresolved.join('\n')).toMatch(/whole number/i);
  });

  it('sends the finished schedule to the independently labelled judge model', async () => {
    const ask = controller({
      orchestrator: [{
        conclusions: [
          OWN_WALL_PRODUCT,
          { kind: 'placement', memberId: 'MEM-02', placement: { kind: 'continuous', runFactId: 'run' }, evidenceIds: ['FACT-run'] },
        ],
        build: true,
        done: { why: 'ready for checking' },
      }],
      specialist: (label) => label === 'judge'
        ? {
            reading: 'a wall reinforcement schedule over the client supplied run',
            verdict: 'sound',
            confirmed: ['the wall is continuous'],
            answer: 'The reading is consistent with the supplied drawing evidence.',
            confidence: 0.85,
          }
        : { findings: [], done: true },
    });
    const out = await run(ask, { independentJudge: true });
    expect(out.judge?.ok).toBe(true);
    expect(out.judge?.reply?.verdict).toBe('sound');
    expect((ask as never as { mock: { calls: [{ label: string }][] } }).mock.calls.some((c) => c[0].label === 'judge')).toBe(true);
  });
});

// ============================================================
// Run 024 — the cube question
//
// Run 024 produced a schedule that passed EVERY gate — schema, provenance,
// placement, coverage, completeness, arithmetic and the referee — with three
// columns 350 mm tall. Each height was a perfectly resolvable pointer at
// entirely the wrong dimension: the member's own cross-section. Nothing
// objected, because "H is resolved" was true, and the total looked plausible
// only because another member was over-claimed. Geometry can at least ask.
// ============================================================

describe('Run 024 — a member equal on every axis is asked about', () => {
  const ownAndBuild = (extra: Record<string, unknown>[] = []) => controller({
    orchestrator: [
      {
        conclusions: [
          { kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'MAIN', distributionAxis: 'H', evidenceIds: ['CALL-001'] },
          ...extra,
        ],
        build: true,
      },
      { done: { why: 'x' } },
    ],
  });

  it('asks when L, W and H are all the same number, and says where they were read from', async () => {
    // C1 is declared 350x350, so L and W ground to 350; pointing H at a
    // 350 mm section dimension makes all three equal
    const ask = ownAndBuild([
      { kind: 'dimension', memberId: 'MEM-01', axis: 'H', ref: { kind: 'user-fact', factId: 'section' } },
    ]);
    const out = await run(ask, { projectFacts: { ...RUN, section: { mm: 350, saidAs: '350 mm' } } });
    expect(out.builds[0].axisSuspects).toHaveLength(1);
    expect(out.builds[0].axisSuspects[0]).toMatch(/C1 measures 350 mm on ALL THREE axes/);
    expect(out.builds[0].axisSuspects[0]).toMatch(/H from 350 mm/);
    // and it reaches the lead as a question, not a verdict
    const second = promptFor(ask, 'orchestrator', 1);
    expect(second).toMatch(/SAME ON EVERY AXIS\?/);
    expect(second).toMatch(/if it is not one, an axis is pointed at a dimension that measures something else/);
  });

  it('says nothing about a member with two equal axes — a square footing is not a cube', async () => {
    const ask = ownAndBuild([
      { kind: 'dimension', memberId: 'MEM-01', axis: 'H', ref: { kind: 'user-fact', factId: 'height' } },
    ]);
    const out = await run(ask, { projectFacts: { ...RUN, height: { mm: 2700, saidAs: '2.7 m' } } });
    expect(out.builds[0].axisSuspects).toHaveLength(0);
  });

  it('says nothing when an axis is simply unresolved', async () => {
    const ask = ownAndBuild();
    const out = await run(ask);
    expect(out.builds[0].axisSuspects).toHaveLength(0);
  });

  it('never states a target, only what it measured', async () => {
    const ask = ownAndBuild([
      { kind: 'dimension', memberId: 'MEM-01', axis: 'H', ref: { kind: 'user-fact', factId: 'section' } },
    ]);
    const out = await run(ask, { projectFacts: { ...RUN, section: { mm: 350, saidAs: '350 mm' } } });
    const msg = out.builds[0].axisSuspects[0];
    expect(msg).not.toMatch(/should|expect|ought|too short|too small/i);
  });
});

// ============================================================
// Run 038 — a run against a dead line stops
//
// A network outage took every one of Run 038's twelve turns: 32 calls, all
// `fetch failed`, ten minutes of retrying into silence, and a final report that
// read as though the model had merely said nothing useful. Repeated silence is
// a different fact from a bad answer, and worth saying quickly.
// ============================================================

describe('Run 038 — repeated silence ends the run', () => {
  it('stops after four consecutive turns bring back nothing, and says why', async () => {
    const ask = vi.fn(async (args: { label: string }) =>
      args.label === 'orchestrator' ? null : ({ findings: [], done: true } as never),
    );
    const out = await run(ask, { limits: { maxOrchestratorTurns: 12 } });
    expect(out.unreadableReplies).toBe(4);          // not twelve
    expect(out.stoppedBecause).toMatch(/could not be reached/);
    expect(out.stoppedBecause).toMatch(/connection or provider failure, not a disagreement/);
    // and it did not keep paying for turns it could not use
    const calls = (ask as unknown as { mock: { calls: { 0: { label: string } }[] } }).mock.calls
      .filter((c) => c[0].label === 'orchestrator');
    expect(calls).toHaveLength(4);
  });

  it('a single lost reply is not an outage — the run carries on', async () => {
    let n = 0;
    const ask = vi.fn(async (args: { label: string }) => {
      if (args.label !== 'orchestrator') return { findings: [], done: true } as never;
      n += 1;
      if (n === 1 || n === 3) return null;
      return (n >= 5 ? { done: { why: 'x' } } : { understanding: 'a boundary wall' }) as never;
    });
    const out = await run(ask, { limits: { maxOrchestratorTurns: 12 } });
    expect(out.unreadableReplies).toBe(2);
    expect(out.stoppedBecause).not.toMatch(/could not be reached/);
    expect(out.understanding).toBe('a boundary wall');
  });
});
