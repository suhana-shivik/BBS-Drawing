// ============================================================
// THE SKILL JOIN — the trade's own knowledge, in the prompts that read.
//
// `.claude/skills/bar-bending-schedule/SKILL.md` was written to be the domain
// knowledge THIS APP reasons with, `knowledge.ts` imports it with `?raw` so a
// rename is a build failure, and `skillBriefing()` frames it for a model that
// is forbidden to produce a number. All of that existed and NOTHING SENT IT:
// only `src/skills/bbs.ts` imported the text, and the live loop —
// orchestrate.ts and tasks.ts — never saw a line of it. The reader decoding
// `10TOR@200C/C` had never been shown the dialect documented for exactly that.
//
// These tests assert on the prompt HANDED TO THE TRANSPORT, not on the
// exported constant, because the constant proves the string exists and the
// wiring is the whole defect: revert either call site to the bare
// `*_SYSTEM` and a constant-level test stays green while the model goes back
// to reading blind.
// ============================================================
import { describe, expect, it, vi } from 'vitest';
import { runOrchestrator, ORCHESTRATOR_SYSTEM, ORCHESTRATOR_SYSTEM_SENT } from '../../src/cad/bbs/orchestrate';
import { SPECIALIST_SYSTEM, SPECIALIST_SYSTEM_SENT } from '../../src/cad/bbs/tasks';
import { BBS_SKILL, skillBriefing } from '../../src/cad/bbs/knowledge';

// A line that exists in SKILL.md and in no prompt written by hand. If the
// skill stops being sent, this is what disappears.
const DIALECT = '4L-8TOR@150C/C';

const doc = () =>
  ({
    name: 'skill', sourceFile: 'skill.dxf',
    entities: [
      { type: 'text', text: 'C1', position: { x: 0, y: 0 }, height: 100, style: { handle: '4001', layer: '0' } },
      { type: 'text', text: '8TOR @150 C/C', position: { x: 200, y: 500 }, height: 100, style: { handle: '4002', layer: '0' } },
    ],
    layers: new Map([['0', { name: '0' }]]), blocks: new Map(), unitScale: 1, extents: null,
  }) as never;

const extract = () =>
  ({
    drawingName: 'skill.dxf',
    marks: ['C1'],
    declared: [{ name: 'C1', sizeText: '350x350', dimsMm: [350, 350, 2700], occurrences: 1, raw: 'COLUMN C1-350x350', handles: [] }],
    callouts: [{ raw: '8TOR @150 C/C', handle: 'A1', position: { x: 200, y: 500 }, diaMm: 8, spacingMm: 150, legs: 2 }],
    tables: [], notes: { notes: [] }, unitScale: 1,
  }) as never;

/** Runs one turn that dispatches a task, so BOTH prompts get sent. */
async function systemsSent(): Promise<{ orchestrator: string[]; specialist: string[] }> {
  const orchestrator: string[] = [];
  const specialist: string[] = [];
  let turn = 0;
  const ask = vi.fn(async (args: { system: string; label: string }): Promise<Record<string, unknown>> => {
    if (args.label === 'orchestrator') {
      orchestrator.push(args.system);
      turn += 1;
      if (turn === 1) {
        return {
          createTasks: [
            { type: 'ownership', objective: 'which member owns CALL-001', evidenceIds: ['CALL-001'] },
          ],
        };
      }
      return { done: { why: 'enough' } };
    }
    specialist.push(args.system);
    return { findings: [], confidence: 0.5, done: true };
  });

  await runOrchestrator({
    doc: doc(), extract: extract(), projectFacts: {},
    ask: ask as never, rasterise: async () => `data:image/png;base64,${'A'.repeat(800)}`,
    now: () => 1, limits: { maxOrchestratorTurns: 3, specialistTurns: 1, taskConcurrency: 1 },
  } as never);

  return { orchestrator, specialist };
}

describe('the reader is fed the domain skill', () => {
  it('sends it to the lead — in the prompt the transport receives', async () => {
    const { orchestrator } = await systemsSent();
    expect(orchestrator.length).toBeGreaterThan(0);
    for (const system of orchestrator) expect(system).toContain(DIALECT);
  });

  it('sends it to the specialist — the one actually decoding callouts', async () => {
    const { specialist } = await systemsSent();
    expect(specialist.length).toBeGreaterThan(0);
    for (const system of specialist) expect(system).toContain(DIALECT);
  });

  it('carries the whole skill, not an excerpt that can drift', () => {
    // the point of `?raw` is one source of truth; a hand-trimmed copy is the
    // paraphrase this file exists to prevent
    expect(ORCHESTRATOR_SYSTEM_SENT).toContain(BBS_SKILL);
    expect(SPECIALIST_SYSTEM_SENT).toContain(BBS_SKILL);
  });

  it('keeps the harness rules FIRST, so the stated tie-break is true', () => {
    // skillBriefing() ends by saying the instructions above win where the two
    // disagree. That sentence is only honest if the harness rules precede it.
    for (const [base, sent] of [
      [ORCHESTRATOR_SYSTEM, ORCHESTRATOR_SYSTEM_SENT],
      [SPECIALIST_SYSTEM, SPECIALIST_SYSTEM_SENT],
    ] as const) {
      expect(sent.indexOf(base)).toBe(0);
      expect(sent.indexOf(BBS_SKILL)).toBeGreaterThan(base.length);
    }
  });

  it('frames the arithmetic as the engine job, never the model own', () => {
    // handing a model shape formulas without this framing is an invitation to
    // the invented cutting length the whole project exists to prevent
    const briefing = skillBriefing();
    expect(briefing).toMatch(/never output a length, a count or a weight/i);
    expect(briefing).toMatch(/describe what the ENGINE does/);
  });

  it('still names no expected quantity, with the skill attached', () => {
    // the standing rule: the models are never told what the answer comes to
    for (const sent of [ORCHESTRATOR_SYSTEM_SENT, SPECIALIST_SYSTEM_SENT]) {
      const p = sent.toLowerCase();
      for (const forbidden of ['24948', '6.49', '6494', '6305', 'expected total', 'reference schedule']) {
        expect(p).not.toContain(forbidden);
      }
    }
  });

  it('still says "json", as json_object mode requires', () => {
    for (const sent of [ORCHESTRATOR_SYSTEM_SENT, SPECIALIST_SYSTEM_SENT]) {
      expect(sent.toLowerCase()).toContain('json');
    }
  });
});
