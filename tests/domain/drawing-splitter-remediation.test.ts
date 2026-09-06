// ============================================================
// Automated coverage-gap REMEDIATION.
//
// drawing-splitter-coverage.test.ts proves computeCoverage finds a gap.
// That alone only produces a banner telling a HUMAN to fix it — "Split
// again, or cut an extra section over the missing area." Asked directly
// whether that was automated or just reported, the honest answer was: only
// detection was automated. This file is the fix — the orchestrator itself
// is given the gap and a bounded number of extra chances to close it, or to
// say on the record why it should not, before a human ever sees it.
//
// The mechanism reuses the SAME loop and the SAME four tools (find_text,
// text_near, look_at, propose_section) a normal round has — there is no
// separate remediation code path to fall out of sync with the real one.
// ============================================================
import { describe, expect, it } from 'vitest';
import { splitDrawing, type ChatReply, type ChatTransport } from '../../src/cad/understanding/orchestrator';
import { line, makeDoc, resetHandles, text, threeAreaDoc } from '../helpers/cadDoc';

let callSeq = 0;
function call(name: string, args: Record<string, unknown>): ChatReply['toolCalls'][number] {
  callSeq += 1;
  return { id: `call-${callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** Replies handed out in order; the last one repeats if the loop runs on. */
function scripted(replies: ChatReply[]): { transport: ChatTransport; turns: () => number } {
  let i = 0;
  const transport: ChatTransport = async () => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return reply;
  };
  return { transport, turns: () => i };
}

const done = (summary = 'done', unresolved: string[] = []): ChatReply => ({
  content: JSON.stringify({ summary, relationships: [], unresolved }),
  toolCalls: [],
});

const base = { projectId: 'p1', skipPng: true, maxRounds: 8 };

// threeAreaDoc has three clusters (AAA left, BBB middle, CCC right) plus
// GRID1, a line crossing all of them at y=-50 — deliberately outside every
// cluster's own text-driven bounding box, so a run that cuts the three
// clusters and stops still leaves GRID1 with no owner. That is the fixture
// this whole file exploits: an honest, reproducible gap that is nobody's
// individual mistake.

describe('coverage remediation — the model gets a real chance to fix it', () => {
  it('does not accept a close that leaves real geometry uncovered — it asks again, and the model closes the gap', async () => {
    const doc = threeAreaDoc();
    const { transport, turns } = scripted([
      // round 1 — only two of three clusters
      {
        content: '',
        toolCalls: [
          call('propose_section', { label: 'A', kind: 'detail', handles: ['AAA1', 'AAA2'] }),
          call('propose_section', { label: 'B', kind: 'layout', handles: ['BBB1', 'BBB2'] }),
        ],
      },
      // round 2 — tries to close. CCC and GRID1 are still uncovered.
      done('two of three areas'),
      // remediation round 1 — the model reacts to the gap description and cuts the third cluster
      { content: '', toolCalls: [call('propose_section', { label: 'C', kind: 'note', handles: ['CCC1', 'CCC2', 'CCC3'] })] },
      // tries to close again — GRID1 (a shared boundary line) is still uncovered, and this time it says so
      done('three areas, plus a shared boundary line', ['GRID1 crosses all three areas and was left out on purpose']),
    ]);

    const pkg = await splitDrawing(doc, { ...base, transport });

    // the gap forced a real extra tool call, not just a re-asked question
    expect(pkg.sections.map((s) => s.label)).toEqual(['A', 'B', 'C']);
    expect(turns()).toBe(4);

    // the model's own explanation survived into the package…
    expect(pkg.unresolved).toContain('GRID1 crosses all three areas and was left out on purpose');
    // …and the residual gap is still reported honestly, not hidden because it was explained
    expect(pkg.unresolved.some((u) => u.includes('are in no section'))).toBe(true);
    expect(pkg.coverage.uncoveredEntities).toBeGreaterThan(0);
  });

  it('stops trying once the model explains the gap — an explained gap is not nagged again', async () => {
    const doc = threeAreaDoc();
    const { transport, turns } = scripted([
      { content: '', toolCalls: [call('propose_section', { label: 'A', kind: 'detail', handles: ['AAA1', 'AAA2'] })] },
      done('one area', []), // round 2: no explanation yet — must trigger remediation
      done('one area, rest is not worth its own section', ['everything else is title-block or shared framing']), // remediation round 1: explains — must be honoured immediately
    ]);

    const pkg = await splitDrawing(doc, { ...base, transport });

    expect(pkg.sections).toHaveLength(1);
    expect(turns()).toBe(3); // exactly one remediation round, not the full budget
    expect(pkg.unresolved).toContain('everything else is title-block or shared framing');
  });

  it('is bounded — a model that keeps closing without addressing the gap still terminates', async () => {
    const doc = threeAreaDoc();
    const { transport, turns } = scripted([
      { content: '', toolCalls: [call('propose_section', { label: 'A', kind: 'detail', handles: ['AAA1', 'AAA2'] })] },
      done('one area'), // empty unresolved every time — never addresses the gap, and repeats forever
    ]);

    const pkg = await splitDrawing(doc, { ...base, transport, maxRounds: 8 });

    expect(pkg.sections).toHaveLength(1); // remediation never fabricated a section on its own
    expect(pkg.coverage.uncoveredEntities).toBeGreaterThan(0);
    expect(pkg.unresolved.some((u) => u.includes('are in no section'))).toBe(true);
    // 1 propose + 1 first close + 3 remediation rounds (REMEDIATION_ROUNDS) = 5, never unbounded
    expect(turns()).toBe(5);
  });

  it('does not remediate a close that already has full coverage', async () => {
    // A single tight, connected doc — deliberately NOT threeAreaDoc, whose
    // three widely-separated clusters would trip the disjoint-cluster
    // tightening in bounds.ts (a different, already-tested fix) rather than
    // exercising this one.
    resetHandles();
    const doc = makeDoc({
      entities: [
        line({ x: 0, y: 0 }, { x: 100, y: 0 }, 'STEEL', 'S1'),
        text({ x: 0, y: 20 }, 'label', 8, 'TEXT', 'T1'),
      ],
    });
    const { transport, turns } = scripted([
      {
        content: '',
        toolCalls: [
          call('propose_section', { label: 'everything', kind: 'detail', x1: -10, y1: -10, x2: 110, y2: 30 }),
        ],
      },
      done('one region'),
    ]);

    const pkg = await splitDrawing(doc, { ...base, transport });

    expect(pkg.coverage.uncoveredEntities).toBe(0);
    expect(turns()).toBe(2); // no remediation round spent — nothing to remediate
  });
});
