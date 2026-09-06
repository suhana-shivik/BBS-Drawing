// The fact-to-calculation pipeline, end to end through the orchestrator:
//
//   · a dimension already on the project record (a USER_INPUT fact) reaches
//     the row without the model having to point at it;
//   · a schedule table's cell outranks a pointer, for the dimension AND the
//     axis the bar runs along;
//   · an answer given after the rebuild budget is spent still produces a
//     rebuilt schedule — the old one is never returned as current;
//   · a cover nobody stated is asked for, and the answer computes the rows;
//   · "no project fact covers them" is not a request for a COUNT.
import { describe, expect, it, vi } from 'vitest';
import { runOrchestrator } from '../../src/cad/bbs/orchestrate';
import { inferWritesTo } from '../../src/interview/facts';
import { BY_LAYER, type CadDocument, type CadLayer } from '../../src/cad/types';
import type { DrawingExtract, ExtractedTable } from '../../src/cad/bbs/types';

const LAYER_0: CadLayer = {
  name: '0', color: BY_LAYER, lineweight: -3, linetype: 'CONTINUOUS', visible: true, frozen: false, transparency: 0,
};

/** a footing sheet: F8 tagged on plan, one bottom mesh callout, a schedule table */
function doc(): CadDocument {
  const e: Record<string, unknown>[] = [];
  let h = 0x3000;
  const next = (): string => (h++).toString(16).toUpperCase();
  const text = (t: string, x: number, y: number, height = 100) =>
    e.push({
      type: 'text',
      text: t,
      position: { x, y },
      height,
      style: { handle: next(), layer: '0', color: BY_LAYER, lineweight: -1, linetype: '', linetypeScale: 1, transparency: -1, normal: null },
    });
  for (const x of [0, 6000, 12000, 18000]) text('F8', x, 0);
  text('10@100c/c', 14000, -21000, 80);
  text('10@100c/c', 15000, -21000, 80);
  return {
    name: 'footings', sourceFile: 'footings.dxf', entities: e as never,
    layers: new Map([['0', LAYER_0]]) as never, blocks: new Map(), unitScale: 1, extents: null,
  } as unknown as CadDocument;
}

const TABLE: ExtractedTable = {
  title: 'FOOTING SCHEDULE :',
  header: ['FOOT. MKD.', 'W SIZE', 'L', 'DEPTH D', 'a(LONG BAR)', 'b(SHORT BAR)'],
  rows: [['F8', '3200', '3500', '575', '0 10@100c/c', '0 10@100c/c']],
  min: { x: 10000, y: -22000 },
  max: { x: 16000, y: -20000 },
  handles: [],
};

const extract = (over: Partial<DrawingExtract> = {}): DrawingExtract =>
  ({
    drawingName: 'footings.dxf',
    sourceFile: 'footings.dxf',
    marks: ['F8'],
    declared: [],
    callouts: [
      { raw: '10@100c/c', handle: 'B1', position: { x: 14000, y: -21000 }, diaMm: 10, spacingMm: 100, layer: '0' },
      { raw: '10@100c/c', handle: 'B2', position: { x: 15000, y: -21000 }, diaMm: 10, spacingMm: 100, layer: '0' },
    ],
    tables: [],
    notes: { notes: [] },
    unitScale: 1,
    ...over,
  }) as unknown as DrawingExtract;

/** the model has settled ownership: both callouts are F8's bottom steel */
const OWN_LONG = {
  kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail',
  barType: 'BOTTOM', distributionAxis: 'W', evidenceIds: ['CALL-001'],
};
const OWN_SHORT = {
  kind: 'own', calloutId: 'CALL-002', memberId: 'MEM-01', basis: 'in-detail',
  barType: 'BOTTOM', distributionAxis: 'L', evidenceIds: ['CALL-002'],
};

const rasterise = async () => `data:image/png;base64,${'A'.repeat(800)}`;

function controller(replies: unknown[]) {
  const queue = [...replies];
  return vi.fn(async (args: { label: string }) => {
    if (args.label === 'orchestrator') return (queue.shift() ?? { done: { why: 'nothing left' } }) as Record<string, unknown>;
    return { findings: [], done: true } as Record<string, unknown>;
  });
}

const run = (ask: unknown, over: Record<string, unknown> = {}) =>
  runOrchestrator({
    doc: doc(),
    extract: extract(),
    projectFacts: {},
    ask: ask as never,
    rasterise,
    now: () => 1,
    limits: { maxOrchestratorTurns: 4, specialistTurns: 1, ...((over.limits as object) ?? {}) },
    priorConclusions: [OWN_LONG, OWN_SHORT],
    ...over,
  });

const rowsOf = (out: Awaited<ReturnType<typeof run>>) => out.result.rows.filter((r) => r.memberMark === 'F8');

describe('AVAILABLE FACT = MUST CALCULATE', () => {
  it('reads F8.length / F8.width / F8.height off the project record without the model pointing at them', async () => {
    const ask = controller([{ done: { why: 'the record has everything' } }]);
    const out = await run(ask, {
      projectFacts: {
        f8_length: { mm: 3500, saidAs: '3500' },
        f8_width: { mm: 3200, saidAs: '3200' },
        f8_height: { mm: 575, saidAs: '575' },
        f8_count: { mm: 8, saidAs: '8' },
      },
      settings: { coverMm: 50 },
    });
    const rows = rowsOf(out);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).not.toBe('unavailable');
      expect(r.note ?? '').not.toMatch(/needs F8|not on this sheet|not resolved/);
      expect(r.memberCount).toBe(8);
    }
    // the long bar (spaced along W) runs along L; the short one along W
    expect(rows[0].cuttingLengthMm).toBe(3500 - 100);
    expect(rows[1].cuttingLengthMm).toBe(3200 - 100);
    const member = out.result.members.find((m) => m.mark === 'F8')!;
    expect(member.dims).toEqual({ L: 3500, W: 3200, H: 575 });
    expect(rows[0].trace?.factsUsed).toEqual(expect.arrayContaining(['F8.length', 'F8.width', 'F8.count']));
    expect(out.snapshot.join('\n')).toMatch(/CALCULATED ROWS\s+2/);
    expect(out.snapshot.join('\n')).toMatch(/BLOCKED ROWS\s+0/);
    expect(out.snapshot.join('\n')).toMatch(/RECONCILED/);
  });
});

describe('the schedule table is the latest validated DRAWING_READ fact', () => {
  it('dimensions every axis from the table and fixes the axis each bar runs along', async () => {
    const ask = controller([{ done: { why: 'the table says it all' } }]);
    const out = await run(ask, {
      extract: extract({ tables: [TABLE] }),
      // the model got the long bar's axis backwards; the table's column header does not
      priorConclusions: [{ ...OWN_LONG, distributionAxis: 'L' }, OWN_SHORT],
      projectFacts: { f8_count: { mm: 8, saidAs: '8' } },
      settings: { coverMm: 50 },
    });
    const rows = rowsOf(out);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status !== 'unavailable')).toBe(true);
    expect(rows[0].cuttingLengthMm).toBe(3400); // a(LONG BAR) runs along L = 3500
    expect(rows[1].cuttingLengthMm).toBe(3100); // b(SHORT BAR) runs along W = 3200
    const member = out.result.members.find((m) => m.mark === 'F8')!;
    expect(member.dims).toEqual({ L: 3500, W: 3200, H: 575 });
    // the table's own ownership claim (the cell names the member and the
    // column names the direction) outranks the backwards pointer — the row
    // is cut along L, and nothing was asked
    expect(out.escalations).toEqual([]);
    expect(out.tableFacts.dims.map((d) => d.factId)).toEqual(['F8.width', 'F8.length', 'F8.height']);
  });

  it('outranks a project fact that disagrees with it, and records the override', async () => {
    const ask = controller([{ done: { why: 'x' } }]);
    const out = await run(ask, {
      extract: extract({ tables: [TABLE] }),
      // an earlier answer said 1400 — the sheet says 3500, and names the member
      projectFacts: { f8_length: { mm: 1400, saidAs: '1400' }, f8_count: { mm: 8, saidAs: '8' } },
      settings: { coverMm: 50 },
    });
    expect(out.result.members.find((m) => m.mark === 'F8')!.dims.L).toBe(3500);
    expect(rowsOf(out)[0].cuttingLengthMm).toBe(3400);
  });
});

describe('USER ANSWER → AUTOMATIC RECALCULATION', () => {
  it('rebuilds on answers that arrive after the rebuild budget is spent — the old schedule is never returned', async () => {
    const answers: Record<string, string> = { LENGTH: '3500', WIDTH: '3200', DEPTH: '575' };
    const askUser = vi.fn(async (q: { question: string }) => {
      const key = Object.keys(answers).find((k) => q.question.toUpperCase().includes(k));
      return key ? answers[key] : null;
    });
    const ask = controller([
      { build: true },
      {
        askUser: [
          { question: 'What is the LENGTH of footing F8, in mm?', whyNeeded: 'its long bars run along it' },
          { question: 'What is the WIDTH of footing F8, in mm?', whyNeeded: 'its short bars run along it' },
          { question: 'What is the DEPTH of footing F8, in mm?', whyNeeded: 'the return legs' },
        ],
        done: { why: 'answers are in' },
      },
    ]);
    const out = await run(ask, {
      askUser,
      projectFacts: { f8_count: { mm: 8, saidAs: '8' } },
      settings: { coverMm: 50 },
      limits: { maxBuilds: 1 },
    });
    expect(askUser).toHaveBeenCalled();
    // the first build was blind; the schedule returned is not that build
    expect(out.builds.length).toBeGreaterThanOrEqual(2);
    const rows = rowsOf(out);
    expect(rows.every((r) => r.status !== 'unavailable')).toBe(true);
    expect(rows[0].cuttingLengthMm).toBe(3400);
    expect(out.result.members.find((m) => m.mark === 'F8')!.dims).toEqual({ L: 3500, W: 3200, H: 575 });
  });
});

describe('COVER', () => {
  it('asks for the cover nobody stated, and the answer computes the rows as USER_INPUT', async () => {
    const askUser = vi.fn(async (q: { question: string; writesTo: { field: string } }) =>
      q.writesTo.field === 'cover' ? '40' : null,
    );
    const ask = controller([{ build: true, done: { why: 'over to the user' } }]);
    const out = await run(ask, {
      askUser,
      projectFacts: {
        f8_length: { mm: 3500, saidAs: '3500' },
        f8_width: { mm: 3200, saidAs: '3200' },
        f8_height: { mm: 575, saidAs: '575' },
        f8_count: { mm: 8, saidAs: '8' },
      },
      limits: { maxBuilds: 1 },
    });
    const coverAsk = askUser.mock.calls.map((c) => c[0]).find((q) => q.writesTo.field === 'cover');
    expect(coverAsk).toBeTruthy();
    expect(coverAsk!.question).toMatch(/clear cover/i);
    expect(coverAsk!.question).toMatch(/50 mm/);
    const rows = rowsOf(out);
    expect(rows.every((r) => r.status !== 'unavailable')).toBe(true);
    expect(rows[0].cuttingLengthMm).toBe(3500 - 80);
    expect(rows[0].coverStatus).toBe('USER_INPUT');
    expect(out.result.settings?.coverMm).toBe(40);
    expect(out.result.settingSources?.coverMm).toBe('stated');
  });

  it('holds every row open on settings.cover when the cover is neither stated nor answered', async () => {
    const ask = controller([{ done: { why: 'x' } }]);
    const out = await run(ask, {
      projectFacts: {
        f8_length: { mm: 3500, saidAs: '3500' },
        f8_width: { mm: 3200, saidAs: '3200' },
        f8_height: { mm: 575, saidAs: '575' },
        f8_count: { mm: 8, saidAs: '8' },
      },
    });
    const rows = rowsOf(out);
    expect(rows.every((r) => r.status === 'unavailable')).toBe(true);
    expect(rows[0].trace?.missingFact).toBe('settings.cover');
    expect(rows[0].trace?.coverStatus).toBe('ASSUMED');
    expect(rows[0].note).toMatch(/no cover is established for F8/);
    expect(out.snapshot.join('\n')).toMatch(/MISSING FACTS\s+1 — settings\.cover/);
  });
});

describe('a question about a size is not a question about a count', () => {
  it('"no project fact covers them" no longer types the question as number-count', () => {
    const w = inferWritesTo(
      'What are the plan SIZE (L × W) of footing F8 in mm? The FOOTING SCHEDULE row appears to read L=3500, W=3200 but the numeric cells are not machine-readable from this sheet and no project fact covers them.',
      ['F8'],
    );
    expect(w?.field).not.toBe('count');
  });

  it('still reads "how many" and "nos" as counts', () => {
    expect(inferWritesTo('How many F8 are there in the whole job?', ['F8'])).toEqual({ memberMark: 'F8', field: 'count' });
    expect(inferWritesTo('F8 — 8 nos on plan; confirm', ['F8'])).toEqual({ memberMark: 'F8', field: 'count' });
  });
});
