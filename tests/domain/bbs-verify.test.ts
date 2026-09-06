import { describe, expect, it } from 'vitest';
import {
  gateArithmetic,
  gateCompleteness,
  gateCoverage,
  gatePlacement,
  gateProvenance,
  gateReferee,
  gateRunCountedTwice,
  gateSchema,
  requiredAxes,
  verifyAll,
  type VerifyInput,
} from '../../src/cad/bbs/verify';
import { buildChatResult, artifactMessage, putChatResult, getChatResult } from '../../src/cad/bbs/chatResult';
import type { EvidenceGraph, EvidenceNode } from '../../src/cad/bbs/evidence';

const member = (over: Record<string, unknown> = {}) =>
  ({
    mark: 'C1',
    type: 'column',
    count: 5,
    lengthMm: 350,
    widthMm: 350,
    heightMm: 2700,
    placement: { kind: 'once', evidenceId: 'E1' },
    source: { table: '', row: 0 },
    incomplete: false,
    missing: [],
    ...over,
  }) as never;

const bar = (over: Record<string, unknown> = {}) =>
  ({
    memberMark: 'C1',
    barType: 'MAIN',
    diaMm: 12,
    shapeCode: '00',
    fromCallout: '8-12TOR',
    handles: [],
    ...over,
  }) as never;

const input = (over: Partial<VerifyInput> = {}): VerifyInput => ({
  interpretation: { members: [member()], bars: [bar()], unresolved: [] },
  ...over,
});

describe('gate A — schema', () => {
  it('rejects an engine-owned field supplied by the model', () => {
    const f = gateSchema(input({ interpretation: { members: [member({ cuttingLengthMm: 2600 })], bars: [bar()], unresolved: [] } }));
    expect(f.some((x) => x.field === 'cuttingLengthMm')).toBe(true);
  });

  it('rejects a member with no placement — a count cannot follow from nothing', () => {
    const f = gateSchema(input({ interpretation: { members: [member({ placement: undefined })], bars: [bar()], unresolved: [] } }));
    expect(f.some((x) => x.field === 'placement')).toBe(true);
  });

  it('accepts a well-formed interpretation', () => {
    expect(gateSchema(input())).toHaveLength(0);
  });

  it('rejects a bar with no usable diameter', () => {
    const f = gateSchema(input({ interpretation: { members: [member()], bars: [bar({ diaMm: 0 })], unresolved: [] } }));
    expect(f.some((x) => x.field === 'diaMm')).toBe(true);
  });
});

describe('gate B — provenance', () => {
  const graph = (ids: string[]): EvidenceGraph => {
    const nodes = ids.map((id) => ({ id, kind: 'text', sourceHandles: [], metadata: {} }) as EvidenceNode);
    return {
      nodes,
      edges: [],
      byId: new Map(nodes.map((n) => [n.id, n])),
      dimensions: [],
      diagnostics: [],
      related: () => [],
      inPanel: () => [],
    };
  };

  it('rejects a pointer at evidence the sheet does not carry', () => {
    const m = member({ dims: { H: { kind: 'entity-number', evidenceId: 'DIM-999', part: 1 } } });
    const f = gateProvenance(input({ interpretation: { members: [m], bars: [bar()], unresolved: [] }, graph: graph(['DIM-001']) }));
    expect(f).toHaveLength(1);
    expect(f[0].evidenceIds).toEqual(['DIM-999']);
  });

  it('follows both sides of a difference and every segment of a path', () => {
    const m = member({
      dims: {
        H: { kind: 'difference', a: { evidenceId: 'A-OK' }, b: { evidenceId: 'B-BAD' } },
        L: { kind: 'dimension-path', segmentEvidenceIds: ['S-OK', 'S-BAD'] },
      },
    });
    const f = gateProvenance(input({ interpretation: { members: [m], bars: [bar()], unresolved: [] }, graph: graph(['A-OK', 'S-OK']) }));
    expect(f.map((x) => x.evidenceIds?.[0]).sort()).toEqual(['B-BAD', 'S-BAD']);
  });
});

describe('gate D — coverage', () => {
  it('flags a parsed callout that is neither assigned nor excluded', () => {
    const f = gateCoverage(input({ parsedCallouts: ['8-12TOR', '10TOR@200C/C'] }));
    expect(f).toHaveLength(1);
    expect(f[0].message).toMatch(/10TOR@200C\/C/);
    expect(f[0].message).toMatch(/simply missing/);
  });

  it('accepts a callout excluded on the record', () => {
    const f = gateCoverage(
      input({
        parsedCallouts: ['8-12TOR', '10TOR@200C/C'],
        excludedCallouts: [{ callout: '10TOR@200C/C', reason: 'belongs to a precast panel' }],
      }),
    );
    expect(f).toHaveLength(0);
  });

  it('flags a reinforced member carrying no bars', () => {
    const f = gateCoverage(input({ interpretation: { members: [member(), member({ mark: 'C2' })], bars: [bar()], unresolved: [] } }));
    expect(f.some((x) => x.memberMark === 'C2')).toBe(true);
  });

  it('does not demand bars of a member excluded from the schedule', () => {
    const f = gateCoverage(
      input({
        interpretation: { members: [member(), member({ mark: 'PANEL' })], bars: [bar()], unresolved: [] },
        dispositions: [{ name: 'PANEL', disposition: { kind: 'precast-product', evidenceIds: ['E9'] } }],
      }),
    );
    expect(f.some((x) => x.memberMark === 'PANEL')).toBe(false);
  });

  it('flags a declared element with no disposition at all', () => {
    const f = gateCoverage(input({ declared: [{ name: 'H-POLE' }], dispositions: [] }));
    expect(f.some((x) => x.field === 'disposition')).toBe(true);
  });
});

describe('gate E — completeness is derived from bar behaviour', () => {
  it('a link needs its cross-section AND the axis it marches along', () => {
    expect(requiredAxes('STIRRUP', 'L').sort()).toEqual(['H', 'L', 'W']);
    expect(requiredAxes('STIRRUP', 'H').sort()).toEqual(['H', 'L', 'W']);
  });

  it('a main bar needs the height', () => {
    expect(requiredAxes('MAIN')).toEqual(['H']);
  });

  it('flags the missing axis a bar actually requires', () => {
    const f = gateCompleteness(
      input({ interpretation: { members: [member({ heightMm: undefined })], bars: [bar()], unresolved: [] } }),
    );
    expect(f).toHaveLength(1);
    expect(f[0].field).toBe('H');
    expect(f[0].message).toMatch(/needs H/);
  });

  it('reports one member-axis once, not once per bar', () => {
    const f = gateCompleteness(
      input({
        interpretation: {
          members: [member({ heightMm: undefined })],
          bars: [bar(), bar({ fromCallout: 'x' }), bar({ fromCallout: 'y' })],
          unresolved: [],
        },
      }),
    );
    expect(f).toHaveLength(1);
  });

  it('never trusts the model’s own missing list', () => {
    // the member SAYS it is complete; the bars say otherwise, and the bars win
    const f = gateCompleteness(
      input({
        interpretation: {
          members: [member({ heightMm: undefined, incomplete: false, missing: [] })],
          bars: [bar()],
          unresolved: [],
        },
      }),
    );
    expect(f).toHaveLength(1);
  });
});

describe('gate G — arithmetic is recomputed independently', () => {
  const result = (rows: Record<string, unknown>[], summary: Record<string, unknown>[] = []) =>
    ({ rows, summary, members: [], incomplete: [], settings: {}, interpretation: {} }) as never;

  const good = {
    barMark: 'C1-M1',
    memberMark: 'C1',
    diaMm: 12,
    barsPerMember: 8,
    memberCount: 5,
    totalBars: 40,
    cuttingLengthMm: 2600,
    totalLengthM: 104,
    unitWeightKgPerM: 0.888,
    weightKg: 92.352,
  };

  it('passes a consistent row', () => {
    expect(gateArithmetic(input({ result: result([good]) }))).toHaveLength(0);
  });

  it('catches a wrong total bar count', () => {
    const f = gateArithmetic(input({ result: result([{ ...good, totalBars: 41 }]) }));
    expect(f.some((x) => x.field === 'totalBars')).toBe(true);
  });

  it('catches a wrong total length', () => {
    const f = gateArithmetic(input({ result: result([{ ...good, totalLengthM: 99 }]) }));
    expect(f.some((x) => x.field === 'totalLengthM')).toBe(true);
  });

  it('catches a unit weight that is not the IS 1786 nominal', () => {
    // the density-formula value for 12 mm, the classic silent substitution
    const f = gateArithmetic(input({ result: result([{ ...good, unitWeightKgPerM: 0.8878 }]) }));
    expect(f.some((x) => x.field === 'unitWeightKgPerM')).toBe(true);
  });

  it('catches a diameter summary that does not reconcile with its rows', () => {
    const f = gateArithmetic(
      input({ result: result([good], [{ diaMm: 12, totalWeightKg: 500, barCount: 40, totalLengthM: 104, unitWeightKgPerM: 0.888, totalWeightWithWastageKg: 515, totalWeightMt: 0.5, nonStandardDiameter: false }]) }),
    );
    expect(f.some((x) => x.field === 'summary.T12')).toBe(true);
  });
});

describe('gate H — placement', () => {
  it('flags an unresolved placement', () => {
    const f = gatePlacement(input({ placements: new Map([['C1', { ok: false, reason: 'no layout' }]]) }));
    expect(f).toHaveLength(1);
    expect(f[0].field).toBe('placement');
  });

  it('accepts a continuous member with no count', () => {
    const f = gatePlacement(input({ placements: new Map([['W1', { ok: true, continuous: true }]]) }));
    expect(f).toHaveLength(0);
  });

  it('flags a placement that resolved but produced no count', () => {
    const f = gatePlacement(input({ placements: new Map([['C1', { ok: true }]]) }));
    expect(f).toHaveLength(1);
  });
});

describe('gate I — the referee names fields, never a target', () => {
  const result = (kg: number) =>
    ({
      rows: [],
      summary: [{ diaMm: 12, totalWeightKg: kg, barCount: 1, totalLengthM: 1, unitWeightKgPerM: 0.888, totalWeightWithWastageKg: kg, totalWeightMt: 0, nonStandardDiameter: false }],
      members: [],
      incomplete: [],
    }) as never;

  it('is silent inside the band', () => {
    const f = gateReferee({ ...input(), result: result(6000), runMm: 100000, structureClass: 'boundary wall' });
    expect(f).toHaveLength(0);
  });

  it('objects below the band and names the deficient fields', () => {
    const f = gateReferee({
      ...input({ interpretation: { members: [member({ heightMm: undefined })], bars: [bar()], unresolved: [] } }),
      result: result(500),
      runMm: 100000,
      structureClass: 'boundary wall',
    });
    expect(f).toHaveLength(1);
    expect(f[0].message).toMatch(/C1 \(H\)/);
  });

  it('NEVER states a target tonnage or the distance to one', () => {
    const f = gateReferee({
      ...input({ interpretation: { members: [member({ heightMm: undefined })], bars: [bar()], unresolved: [] } }),
      result: result(500),
      runMm: 100000,
      structureClass: 'boundary wall',
    });
    const said = f[0].message;
    expect(said).not.toMatch(/should be|target|expected total|short by|11 t|6\.8/i);
  });

  it('says nothing about a structure class it does not know', () => {
    expect(gateReferee({ ...input(), result: result(1), runMm: 100000, structureClass: 'space elevator' })).toHaveLength(0);
  });

  it('points at assignment when every field is resolved', () => {
    const f = gateReferee({ ...input(), result: result(500), runMm: 100000, structureClass: 'boundary wall' });
    // it must point at BOTH ways a fully-valued schedule can still be wrong:
    // steel nobody claimed, and a dimension read off the wrong evidence
    expect(f[0].message).toMatch(/no member claims/);
    expect(f[0].message).toMatch(/resolved from the wrong evidence/);
  });
});

describe('verifyAll runs every gate, not just the first', () => {
  it('reports failures from several gates at once', () => {
    const r = verifyAll({
      interpretation: {
        members: [member({ placement: undefined, heightMm: undefined })],
        bars: [bar()],
        unresolved: [],
      },
      parsedCallouts: ['8-12TOR', 'UNASSIGNED@100'],
    });
    expect(r.ok).toBe(false);
    const gates = new Set(r.failures.map((f) => f.gate));
    expect(gates.has('schema')).toBe(true);
    expect(gates.has('completeness')).toBe(true);
    expect(gates.has('coverage')).toBe(true);
  });

  it('is ok only when every gate is silent', () => {
    const r = verifyAll(input());
    expect(r.ok).toBe(true);
    expect(r.passed).toContain('schema');
  });
});

// ------------------------------------------------------------
// the chat artifact
// ------------------------------------------------------------

describe('the chat artifact is an immutable rendering', () => {
  const engineResult = {
    rows: [
      {
        barMark: 'C1-M1',
        memberMark: 'C1',
        barType: 'MAIN',
        diaMm: 12,
        description: 'Vertical T12 - 8 nos',
        barsPerMember: 8,
        memberCount: 5,
        totalBars: 40,
        cuttingLengthMm: 2600,
        totalLengthM: 104,
        unitWeightKgPerM: 0.888,
        weightKg: 92.352,
        lengthWorking: 'A = 2700 − 2×50 = 2600;  A = 2600  →  2600 mm',
        lengthSource: 'SHAPE_FORMULA',
      },
    ],
    summary: [
      { diaMm: 12, barCount: 40, totalLengthM: 104, unitWeightKgPerM: 0.888, totalWeightKg: 92.352, totalWeightWithWastageKg: 95.12, totalWeightMt: 0.09, nonStandardDiameter: false },
    ],
    members: [{ mark: 'C1', type: 'column', count: 5, lengthMm: 350, widthMm: 350, heightMm: 2700 }],
    incomplete: [],
  } as never;

  const built = () =>
    buildChatResult({
      id: 'bbs-1',
      drawingName: 'sheet.dxf',
      runMm: 100000,
      result: engineResult,
      verification: { ok: true, passed: ['schema'], failures: [] },
      placementWorking: new Map([['C1', '5 — one per node']]),
      cover: new Map([['C1', { mm: 40, source: 'member-cover-table' }]]),
    });

  it('carries every figure from the engine unchanged', () => {
    const r = built();
    expect(r.rows[0]).toMatchObject({ totalBars: 40, cuttingLengthMm: 2600, totalWeightKg: 92.352 });
    expect(r.netWeightKg).toBeCloseTo(92.352, 3);
  });

  it('shows the working line by line', () => {
    const w = built().rows[0].working;
    expect(w.some((l) => /2600 mm/.test(l))).toBe(true);
    expect(w.some((l) => /8 per member × 5 = 40/.test(l))).toBe(true);
    expect(w.some((l) => /IS 1786 nominal/.test(l))).toBe(true);
  });

  it('records cover and how it was resolved', () => {
    expect(built().members[0]).toMatchObject({ coverMm: 40, coverSource: 'member-cover-table' });
  });

  it('is complete only when verification passed and no row is blocked', () => {
    expect(built().status).toBe('complete');
    const partial = buildChatResult({
      id: 'x',
      drawingName: 'd',
      result: engineResult,
      verification: { ok: false, passed: [], failures: [{ gate: 'referee', message: 'thin' }] },
    });
    expect(partial.status).toBe('partial');
  });

  it('marks a row with no cutting length as unavailable, with the reason', () => {
    const blocked = buildChatResult({
      id: 'y',
      drawingName: 'd',
      result: {
        ...(engineResult as unknown as Record<string, unknown>),
        rows: [
          {
            ...(engineResult as unknown as { rows: Record<string, unknown>[] }).rows[0],
            cuttingLengthMm: null,
            missing: 'H not on this sheet',
          },
        ],
      } as never,
      verification: { ok: false, passed: [], failures: [] },
    });
    expect(blocked.rows[0].status).toBe('unavailable');
    expect(blocked.rows[0].note).toMatch(/H not on this sheet/);
  });

  it('the assistant message states NO numbers — it points at the artifact', () => {
    const msg = artifactMessage(built());
    expect(msg.artifact).toEqual({ type: 'bbs-result', resultId: 'bbs-1' });
    expect(msg.content).not.toMatch(/\d/);
  });

  it('round-trips through the store the message points into', () => {
    const r = built();
    putChatResult(r);
    expect(getChatResult('bbs-1')).toBe(r);
  });
});

// An over-count is real however much else is missing.
//
// One run put a tie beam in 47 times with its cross-section as its length,
// totalled 180 tonnes on a 100 m wall — 1854 kg/m — and the report said
// "partial: one failure, a wall height is unresolved". The referee had been
// blocked by that very gap. Missing data can only make a total too SMALL.
describe('the referee speaks through a broken structure when the total is too HIGH', () => {
  const brokenInput = (kg: number) => ({
    interpretation: {
      members: [
        { mark: 'TB', type: 'beam', count: 47, lengthMm: 400, widthMm: 350, heightMm: 400, placement: { kind: 'once', evidenceId: 'X' }, incomplete: false, missing: [], source: { table: '', row: 0 } },
        // this member's missing H is what used to silence the referee
        { mark: 'WALL', type: 'wall', count: 1, lengthMm: 100000, widthMm: 200, placement: { kind: 'once', evidenceId: 'X' }, incomplete: true, missing: ['H'], source: { table: '', row: 0 } },
      ],
      bars: [
        { memberMark: 'TB', barType: 'MAIN', diaMm: 16, shapeCode: '00', fromCallout: '2-16TOR', handles: [] },
        { memberMark: 'WALL', barType: 'MAIN', diaMm: 8, shapeCode: '00', spacingMm: 200, fromCallout: 'T8@200C/C', handles: [] },
      ],
      unresolved: [],
    },
    result: {
      settings: {} as never,
      members: [] as never,
      rows: [
        { barMark: 'TB-M1', memberMark: 'TB', barType: 'MAIN', diaMm: 16, shapeCode: '00', cuttingLengthMm: 1, lengthSource: 'SHAPE_FORMULA', barsPerMember: 1, memberCount: 47, totalBars: 47, totalLengthM: 1, unitWeightKgPerM: 1, weightKg: kg, weightWithWastageKg: kg, warnings: [], handles: [], fromCallout: '', description: '' },
      ] as never,
      summary: [{ diaMm: 16, barCount: 47, totalLengthM: 1, unitWeightKgPerM: 1, totalWeightKg: kg, totalWeightWithWastageKg: kg, nonStandardDiameter: false }],
      incomplete: [],
      interpretation: {} as never,
      sanity: [],
    } as never,
    runMm: 100_000,
    structureClass: 'boundary wall',
  });

  it('reports the excess, and says why an unresolved field does not excuse it', () => {
    const report = verifyAll(brokenInput(180_000) as never);
    const referee = report.gates.find((g) => g.gate === 'referee');
    expect(referee?.status).toBe('fail');
    expect(referee?.failures[0].message).toMatch(/1800 kg per metre/);
    expect(referee?.failures[0].message).toMatch(/too SMALL, never too large/);
    // it points at the weight, not at a target
    expect(referee?.failures[0].message).toMatch(/Carrying the most weight: TB/);
    expect(referee?.failures[0].message).not.toMatch(/should be|expected total/i);
  });

  it('still stays silent on a SHORT total, where missing data is the honest explanation', () => {
    const report = verifyAll(brokenInput(500) as never);
    const referee = report.gates.find((g) => g.gate === 'referee');
    expect(referee?.status).toBe('blocked');
    expect(referee?.because).toMatch(/missing data cannot inflate a total/);
  });
});

// The same hundred metres, scheduled twenty-four times.
//
// One live run placed a tie beam as one-per-bay — 24 of them — while its
// longitudinal bars were still measured ALONG the run, at 106400 mm each. The
// product is the job counted 24 times: 78 tonnes on one member, 80 t all told,
// on a wall whose whole schedule is a few tonnes. Every other gate passed,
// because each row was internally consistent and 24 is a legal count.
describe('gate — the run counted more than once', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    barMark: 'TB-M1', memberMark: 'TB', barType: 'MAIN', diaMm: 16, shapeCode: '00',
    cuttingLengthMm: 106_400, lengthSource: 'SHAPE_FORMULA', barsPerMember: 2, memberCount: 24,
    totalBars: 48, totalLengthM: 5107.2, unitWeightKgPerM: 1.578, weightKg: 8059,
    warnings: [], handles: [], fromCallout: '2-16TOR', description: '', ...over,
  });
  const withRows = (rows: Record<string, unknown>[]) =>
    ({ ...input(), result: { settings: {}, members: [], rows, summary: [], incomplete: [], interpretation: {}, sanity: [] }, runMm: 100_000 }) as never;

  it('names the multiplication, and what it means', () => {
    const f = gateRunCountedTwice(withRows([row()]));
    expect(f).toHaveLength(1);
    expect(f[0].message).toMatch(/is the 100000 mm run itself/);
    expect(f[0].message).toMatch(/multiplied by 24 TBs/);
    expect(f[0].message).toMatch(/same run is scheduled 24 times over/);
    expect(f[0].field).toBe('memberCount');
    // never a target
    expect(f[0].message).not.toMatch(/should be|expected|tonne/i);
  });

  it('says nothing when the member exists once along the run', () => {
    expect(gateRunCountedTwice(withRows([row({ memberCount: 1 })]))).toHaveLength(0);
  });

  it('says nothing about a repeating member whose bars are measured across its own section', () => {
    // 25 footings, each bar 1976 mm — the bars repeat, the run does not
    expect(gateRunCountedTwice(withRows([row({ memberMark: 'F1', cuttingLengthMm: 1976, memberCount: 25 })]))).toHaveLength(0);
  });

  it('tolerates the laps the engine folds into a run-length cut', () => {
    // exactly the run, no laps — still the run
    expect(gateRunCountedTwice(withRows([row({ cuttingLengthMm: 100_000 })]))).toHaveLength(1);
  });

  it('reports a member once, however many of its rows span the run', () => {
    const f = gateRunCountedTwice(withRows([row(), row({ barMark: 'TB-M2', diaMm: 12 }), row({ barMark: 'TB-M3' })]));
    expect(f).toHaveLength(1);
  });

  it('is silent when no run was given at all', () => {
    const f = gateRunCountedTwice({ ...(withRows([row()]) as object), runMm: undefined } as never);
    expect(f).toHaveLength(0);
  });

  it('reaches verifyAll as an arithmetic failure, without erasing the other arithmetic checks', () => {
    const report = verifyAll(withRows([row({ totalLengthM: 999 })]));
    const arith = report.gates.find((g) => g.gate === 'arithmetic');
    expect(arith?.status).toBe('fail');
    // both the length mismatch and the double-counted run are reported
    expect(arith!.failures.some((x) => /same run is scheduled/.test(x.message))).toBe(true);
    expect(arith!.failures.some((x) => x.field === 'totalLengthM')).toBe(true);
  });
});
