// The drawing saying, in as many words, "this figure is yours to supply".
//
// The pedestal template writes "INPUT" under CUTTING LENGTH and "ENTER DESIGN
// LENGTH / QTY" beside it: the foundation embedment and starter projection
// that would fix the vertical bar's length are design decisions the sheet does
// not carry. Nothing read that. The engine went looking for a length anyway,
// took the only dimension the member had — its height — cut a bar from it, and
// the IS 456 anchorage gate refused the result. The row then blocked with a
// sentence about development length, which is true and beside the point: the
// drawing had already said the number was an input.
//
// The detector is narrow on purpose. Asking a person for a figure the sheet
// has already given them is the fastest way to teach them the tool cannot
// read, so a cell is only believed when it says nothing BUT "input".

import { describe, expect, it, vi } from 'vitest';
import { runOrchestrator } from '../../src/cad/bbs/orchestrate';
import {
  askForDesignInput,
  designInputsFrom,
  factIdForDesignInput,
  fieldKey,
} from '../../src/cad/bbs/designInputs';
import { emptyLedger, recordFact } from '../../src/facts/ledger';
import { overridesFromLedger } from '../../src/studio/bbsFacts';
import type { DrawingExtract, ExtractedTable } from '../../src/cad/bbs/types';

const table = (over: Partial<ExtractedTable>): ExtractedTable => ({
  title: 'BAR BENDING SCHEDULE - PEDESTAL P1',
  header: ['MARK', 'DIA', 'CUTTING LENGTH', 'NO./MEMBER', 'MEMBERS'],
  rows: [],
  min: { x: 0, y: 0 },
  max: { x: 0, y: 0 },
  handles: [],
  ...over,
});

const extractOf = (tables: ExtractedTable[]): DrawingExtract =>
  ({ tables, callouts: [], notes: {}, marks: [], declared: [] }) as unknown as DrawingExtract;

describe('reading what the sheet declares an input', () => {
  it('finds the open cell, the column it sits in, and the row it belongs to', () => {
    const found = designInputsFrom(
      extractOf([table({ rows: [['P1-V1', 'DIA 16', 'INPUT', '20', 'INPUT']] })]),
    );
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      mark: 'P1-V1',
      field: 'cutting_length',
      fieldLabel: 'CUTTING LENGTH',
      saidAs: 'INPUT',
    });
    expect(found[1].field).toBe('members');
  });

  it.each(['INPUT', 'TBD', 'BY DESIGNER', 'AS PER DESIGN', 'To be confirmed', 'ENTER'])(
    'believes a cell that says only %s',
    (said) => {
      const found = designInputsFrom(extractOf([table({ rows: [['P1-V1', 'DIA 16', said]] })]));
      expect(found.map((f) => f.field)).toEqual(['cutting_length']);
    },
  );

  it('does NOT read a cell that states a value, however it is labelled', () => {
    // "INPUT 2300" is a figure with a label on it. Treating it as a gap would
    // ask a person for a number that is printed in front of them.
    const found = designInputsFrom(
      extractOf([table({ rows: [['P1-V1', 'DIA 16', 'INPUT 2300'], ['P1-T1', 'DIA 10', '3060']] })]),
    );
    expect(found).toEqual([]);
  });

  it('leaves a headerless table alone rather than guessing which figure is open', () => {
    // "Something on this row is an input" is not a question anyone can answer.
    const found = designInputsFrom(
      extractOf([table({ header: [], rows: [['P1-V1', 'DIA 16', 'INPUT']] })]),
    );
    expect(found).toEqual([]);
  });

  it('asks once for a column a template writes INPUT all the way down', () => {
    const found = designInputsFrom(
      extractOf([
        table({
          rows: [
            ['P1-V1', 'DIA 16', 'INPUT'],
            ['P1-V1', 'DIA 16', 'INPUT'],
            ['P1-T1', 'DIA 10', 'INPUT'],
          ],
        }),
      ]),
    );
    expect(found.map((f) => `${f.mark}:${f.field}`)).toEqual([
      'P1-V1:cutting_length',
      'P1-T1:cutting_length',
    ]);
  });

  it('names no mark for a row that names no member', () => {
    const found = designInputsFrom(
      extractOf([table({ rows: [['TOTAL', '', 'INPUT']] })]),
    );
    expect(found[0].mark).toBeUndefined();
    expect(factIdForDesignInput(found[0])).toBe('settings.cutting_length');
  });

  it('normalises a column heading into the shape a fact id takes', () => {
    expect(fieldKey('CUTTING LENGTH')).toBe('cutting_length');
    expect(fieldKey('NO./MEMBER')).toBe('bars_per_member');
    expect(fieldKey('SPACING c/c')).toBe('spacing_c_c');
  });
});

describe('the question it puts', () => {
  const [d] = designInputsFrom(
    extractOf([table({ rows: [['P1-V1', 'DIA 16', 'INPUT']] })]),
  );

  it('lands under the bar it belongs to', () => {
    expect(factIdForDesignInput(d)).toBe('P1-V1.cutting_length');
  });

  it('quotes the drawing, so the reader knows it is theirs to supply', () => {
    const ask = askForDesignInput(d);
    expect(ask).toContain("P1-V1's cutting length");
    expect(ask).toContain('"INPUT"');
    expect(ask).toContain('BAR BENDING SCHEDULE - PEDESTAL P1');
    expect(ask).toMatch(/nothing will be derived for it/);
  });
});

describe('the answer reaching the engine', () => {
  const answered = (id: string, mm: number) =>
    recordFact(emptyLedger(), {
      id,
      value: mm,
      unit: 'mm',
      state: 'SUPPLIED',
      saidAs: String(mm),
      readOn: '2026-09-03',
    }).ledger;

  it('becomes a bar override keyed by the mark buildBbs looks it up under', () => {
    const { bars, used } = overridesFromLedger(answered('P1-V1.cutting_length', 2300));
    expect(bars).toEqual({ 'P1-V1': { cuttingLengthMm: 2300 } });
    expect(used).toEqual(['P1-V1.cutting_length']);
  });

  it('ignores a dimension — those feed a derivation, they do not replace one', () => {
    expect(overridesFromLedger(answered('P1.height', 1200)).bars).toEqual({});
  });

  it('ignores an unanswered or unusable figure rather than passing a hole through', () => {
    const missing = recordFact(emptyLedger(), {
      id: 'P1-V1.cutting_length',
      value: null,
      unit: 'mm',
      state: 'MISSING',
      ask: 'what is it?',
      readOn: '2026-09-03',
    }).ledger;
    expect(overridesFromLedger(missing).bars).toEqual({});
    expect(overridesFromLedger(answered('P1-V1.cutting_length', 0)).bars).toEqual({});
  });
});

// ------------------------------------------------------------
// and the wire, through the product path
// ------------------------------------------------------------
//
// Written against `runOrchestrator`, not `buildBbs`. buildBbs has ALWAYS
// honoured a typed cutting length — the defect was that the orchestrator
// called it with `undefined` for overrides, so the whole facility was
// unreachable from the product. A build-level test would have stayed green
// through all of it.

const doc = () => {
  const entities: Record<string, unknown>[] = [];
  let h = 0x4000;
  const next = (): string => (h++).toString(16).toUpperCase();
  const text = (t: string, x: number, y: number): void => {
    entities.push({
      type: 'text',
      text: t,
      position: { x, y },
      height: 100,
      style: { handle: next(), layer: '0' },
    });
  };
  text('P1', 0, 0);
  text('20-DIA 16 VERTICAL BARS', 200, 500);
  return {
    name: 'pedestal',
    sourceFile: 'pedestal.dxf',
    entities,
    layers: new Map([['0', { name: '0' }]]),
    blocks: new Map(),
    unitScale: 1,
    extents: null,
  } as never;
};

/** A pedestal 1000 × 1000 × 1200 with 20 Ø16 verticals — the sheet's own words. */
const pedestalExtract = (declaresInput = false) =>
  ({
    drawingName: 'pedestal.dxf',
    marks: ['P1'],
    declared: [
      {
        name: 'P1',
        sizeText: '1000x1000',
        dimsMm: [1000, 1000, 1200],
        occurrences: 1,
        raw: 'PLAN - PEDESTAL P1 1000x1000x1200',
        handles: [],
      },
    ],
    callouts: [
      {
        raw: '20-DIA 16 VERTICAL BARS',
        handle: 'A1',
        position: { x: 200, y: 500 },
        diaMm: 16,
        count: 20,
      },
    ],
    tables: declaresInput
      ? [
          {
            title: 'BAR BENDING SCHEDULE - PEDESTAL P1',
            header: ['MARK', 'DIA', 'CUTTING LENGTH', 'NO./MEMBER'],
            rows: [['P1-V1', 'DIA 16', 'INPUT', '20']],
            min: { x: 0, y: 0 },
            max: { x: 0, y: 0 },
            handles: [],
          },
        ]
      : [],
    // The sheet states its cover. These tests are about the INPUT rule, and a
    // cover nobody established would hold every row open for its own reason
    // before the rule under test could speak.
    notes: { notes: [], coverMm: 50 },
    unitScale: 1,
  }) as never;

const runWith = async (
  overrides?: { members: object; bars: Record<string, object> },
  declaresInput = false,
) => {
  let first = true;
  const ask = vi.fn(async (args: { label: string }): Promise<Record<string, unknown>> => {
    if (args.label !== 'orchestrator') return { findings: [], done: true };
    if (first) {
      first = false;
      return {
        conclusions: [
          {
            kind: 'own',
            calloutId: 'CALL-001',
            memberId: 'MEM-01',
            basis: 'in-detail',
            barType: 'MAIN',
            distributionAxis: 'L',
            evidenceIds: ['CALL-001'],
            reasoning: 'the P1 plan',
          },
          { kind: 'shape', calloutId: 'CALL-001', shapeCode: '00', evidenceIds: ['CALL-001'] },
          {
            kind: 'placement',
            memberId: 'MEM-01',
            placement: { kind: 'once', evidenceId: 'DECL-01' },
            evidenceIds: ['DECL-01'],
          },
        ],
        build: true,
      };
    }
    return { done: { why: 'built' } };
  });
  return runOrchestrator({
    doc: doc(),
    extract: pedestalExtract(declaresInput),
    projectFacts: {},
    ...(overrides ? { overrides } : {}),
    ask: ask as never,
    rasterise: async () => `data:image/png;base64,${'A'.repeat(800)}`,
    now: () => 1,
    limits: { maxOrchestratorTurns: 4, specialistTurns: 1 },
  } as never);
};

describe('a cutting length the person typed', () => {
  it('reaches the schedule and is marked ENTERED, not derived', async () => {
    const out = await runWith({ members: {}, bars: { 'P1-M1': { cuttingLengthMm: 2300 } } });
    const row = out.result.rows.find((r) => r.memberMark === 'P1')!;
    expect(row.cuttingLengthMm).toBe(2300);
    // The row must never pass a typed figure off as one the engine worked out.
    expect(row.working.join(' ')).toMatch(/entered/i);
  });

  it('and without it the engine derives its own, as before', async () => {
    const out = await runWith();
    const row = out.result.rows.find((r) => r.memberMark === 'P1')!;
    expect(row.cuttingLengthMm).not.toBe(2300);
  });
});

describe('a cutting length the DRAWING declares an input', () => {
  it('is not derived from the pedestal height — the row is held open instead', async () => {
    // The whole point. P1 is 1000 x 1000 x 1200 and the sheet says the cutting
    // length is INPUT, because a starter bar continues into the foundation and
    // projects above it and neither is drawn. Taking H as the length answers a
    // different question with a number that looks like an answer.
    const out = await runWith(undefined, true);
    const row = out.result.rows.find((r) => r.memberMark === 'P1')!;
    expect(row.cuttingLengthMm ?? null).toBeNull();
    expect(row.status).toBe('unavailable');
    expect(row.note ?? '').toMatch(/declares the cutting length a design input/);
    expect(row.note ?? '').toContain('"INPUT"');
  });

  it('never turns the missing figure into a zero', async () => {
    const out = await runWith(undefined, true);
    const row = out.result.rows.find((r) => r.memberMark === 'P1')!;
    expect(row.cuttingLengthMm).not.toBe(0);
    expect(row.totalLengthM ?? null).not.toBe(0);
    expect(row.totalWeightKg ?? null).not.toBe(0);
  });

  it('computes the moment the number is supplied, and calls it ENTERED', async () => {
    // The engine marks bars P1-M1; the sheet marks the row P1-V1. The bridge is
    // the diameter the sheet states on the same row, not a guess about what
    // "V" means in one office's naming.
    const out = await runWith({ members: {}, bars: { 'P1-M1': { cuttingLengthMm: 2300 } } }, true);
    const row = out.result.rows.find((r) => r.memberMark === 'P1')!;
    expect(row.cuttingLengthMm).toBe(2300);
    expect(row.working.join(' ')).toMatch(/entered/i);
  });

  it('leaves a sheet that states its lengths alone', async () => {
    const out = await runWith(undefined, false);
    const row = out.result.rows.find((r) => r.memberMark === 'P1')!;
    expect(row.cuttingLengthMm).toBeGreaterThan(0);
  });
});

describe('the callout the grammar used to drop the count from', () => {
  it('reaches the schedule as twenty bars, not an unquantified diameter', async () => {
    // "20-DIA 16 VERTICAL BARS" is one of the commonest ways an Indian sheet
    // writes a main-bar group, and the grammar read only the 16. The pedestal
    // then had a diameter and no quantity, so the row could state no total —
    // twenty verticals reduced to a callout nobody could count.
    const out = await runWith();
    const row = out.result.rows.find((r) => r.memberMark === 'P1')!;
    expect(row.barsPerMember).toBe(20);
  });
});
