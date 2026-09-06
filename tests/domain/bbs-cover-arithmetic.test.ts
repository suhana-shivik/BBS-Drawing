// ============================================================
// THE COVER JOIN — the sheet's own cover table, spent in the cutting lengths.
//
// `cover.ts` has always resolved cover per member. Its answer reached
// `buildChatResult` and stopped there: the table was extracted, resolved,
// printed for the reader, and used in ZERO cutting lengths, because
// `buildBbs` read one flat `settings.coverMm` (default 50) for the whole
// sheet. Every arm of every link on a member whose cover is not 50 was wrong,
// always in the direction that under-orders.
//
// These tests are deliberately written against `runOrchestrator` — the product
// path — and not against `buildBbs` directly. A test that hands `buildBbs` a
// member with `coverMm` already on it proves the arithmetic and nothing about
// the wiring, and the wiring is the whole defect: delete the one line in
// `orchestrate.ts` that attaches the resolved cover to the member and a
// build-level test stays green while the product goes back to flat 50.
//
// THE REFERENCE FIGURES ARE HAND-WORKED. Each is derived in a comment from
// IS 2502 arithmetic and written as a literal, so the engine cannot define its
// own expected value.
// ============================================================
import { describe, expect, it, vi } from 'vitest';
import { runOrchestrator } from '../../src/cad/bbs/orchestrate';

// ------------------------------------------------------------
// the sheet
// ------------------------------------------------------------
//
// A consultant sheet of the ordinary kind: three members, and a cover table
// that names two of them and forgets the third.
//
//     a. FOUNDATION BEAM & SLAB   50
//     b. COLUMN                   40
//     c. TIE BEAM                 30
//
// C1 is a column (cover 40). TB is a tie beam (cover 30). PC1 is a pile cap,
// which the table does not describe at all — `cover.ts` refuses to lend it the
// COLUMN row, so it falls back to the flat project figure and the row says so.

const COVER_TABLE = [
  { member: 'FOUNDATION BEAM & SLAB', coversMm: [50], raw: 'a. FOUNDATION BEAM & SLAB — 50' },
  { member: 'COLUMN', coversMm: [40], raw: 'b. COLUMN — 40' },
  { member: 'TIE BEAM.', coversMm: [30], raw: 'c. TIE BEAM. — 30' },
];

const doc = () => {
  const entities: Record<string, unknown>[] = [];
  let h = 0x4000;
  const next = (): string => (h++).toString(16).toUpperCase();
  const text = (t: string, x: number, y: number): void => {
    entities.push({
      type: 'text', text: t, position: { x, y }, height: 100,
      style: { handle: next(), layer: '0' },
    });
  };
  text('C1', 0, 0);
  text('TB', 2000, 0);
  text('PC1', 4000, 0);
  text('8TOR @150 C/C', 200, 500);
  text('8TOR (2L) - 20 NOS', 2200, 500);
  text('8TOR - 10 NOS', 4200, 500);
  return {
    name: 'covers', sourceFile: 'covers.dxf', entities,
    layers: new Map([['0', { name: '0' }]]), blocks: new Map(), unitScale: 1, extents: null,
  } as never;
};

/**
 * @param withTable false reproduces the world before this join: no cover
 *   table on the sheet, so every member falls back to the flat 50 mm the
 *   engine used to apply to all of them unconditionally.
 */
const extract = (withTable: boolean) =>
  ({
    drawingName: 'covers.dxf',
    marks: ['C1', 'TB', 'PC1'],
    declared: [
      {
        name: 'C1', sizeText: '350x350', dimsMm: [350, 350, 2700], occurrences: 1,
        raw: 'TYPICAL DETAIL OF COLUMN C1-350x350', handles: [],
      },
      {
        name: 'TB', sizeText: '350x400', dimsMm: [350, 400], occurrences: 1,
        raw: 'TIE BEAM TB-(350X400)', handles: [],
      },
      {
        name: 'PC1', sizeText: '1200x1200', dimsMm: [1200, 1200, 600], occurrences: 1,
        raw: 'PILE CAP PC1-(1200X1200X600)', handles: [],
      },
    ],
    callouts: [
      { raw: '8TOR @150 C/C', handle: 'A1', position: { x: 200, y: 500 }, diaMm: 8, spacingMm: 150, legs: 2 },
      { raw: '8TOR (2L) - 20 NOS', handle: 'A2', position: { x: 2200, y: 500 }, diaMm: 8, count: 20, legs: 2 },
      { raw: '8TOR - 10 NOS', handle: 'A3', position: { x: 4200, y: 500 }, diaMm: 8, count: 10, legs: 2 },
    ],
    tables: [],
    notes: withTable ? { notes: [], coverByMember: COVER_TABLE } : { notes: [] },
    unitScale: 1,
  }) as never;

// ------------------------------------------------------------
// the run
// ------------------------------------------------------------

/**
 * One scripted orchestrator turn. The model does exactly what a model is
 * allowed to do — point at evidence and assign meaning — and emits no number:
 * TB's cross-section arrives as two pointers at the declaration's own
 * `350 X 400`, which the engine reads.
 */
const run = async (withTable: boolean) => {
  let first = true;
  const cite = (ids: string[]) => ({ evidenceIds: ids });
  const ask = vi.fn(async (args: { label: string }): Promise<Record<string, unknown>> => {
    if (args.label !== 'orchestrator') return { findings: [], done: true };
    if (first) {
      first = false;
      return {
        conclusions: [
          { kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', barType: 'STIRRUP', distributionAxis: 'H', ...cite(['CALL-001']), reasoning: 'the C1 detail' },
          { kind: 'own', calloutId: 'CALL-002', memberId: 'MEM-02', basis: 'in-detail', barType: 'STIRRUP', distributionAxis: 'L', ...cite(['CALL-002']), reasoning: 'the TB section' },
          { kind: 'own', calloutId: 'CALL-003', memberId: 'MEM-03', basis: 'in-detail', barType: 'STIRRUP', distributionAxis: 'H', ...cite(['CALL-003']), reasoning: 'the PC1 detail' },
          { kind: 'shape', calloutId: 'CALL-001', shapeCode: '51', ...cite(['CALL-001']) },
          { kind: 'shape', calloutId: 'CALL-002', shapeCode: '51', ...cite(['CALL-002']) },
          { kind: 'shape', calloutId: 'CALL-003', shapeCode: '51', ...cite(['CALL-003']) },
          // TB's declaration reads "TB-(350X400)" — width then depth. The
          // model points at part 1 and part 2; refs.ts reads the millimetres.
          { kind: 'dimension', memberId: 'MEM-02', axis: 'W', ref: { kind: 'entity-number', evidenceId: 'DECL-02', part: 1 }, ...cite(['DECL-02']) },
          { kind: 'dimension', memberId: 'MEM-02', axis: 'H', ref: { kind: 'entity-number', evidenceId: 'DECL-02', part: 2 }, ...cite(['DECL-02']) },
          { kind: 'placement', memberId: 'MEM-01', placement: { kind: 'once', evidenceId: 'DECL-01' }, ...cite(['DECL-01']) },
          { kind: 'placement', memberId: 'MEM-02', placement: { kind: 'once', evidenceId: 'DECL-02' }, ...cite(['DECL-02']) },
          { kind: 'placement', memberId: 'MEM-03', placement: { kind: 'once', evidenceId: 'DECL-03' }, ...cite(['DECL-03']) },
        ],
        build: true,
      };
    }
    return { done: { why: 'built' } };
  });
  return runOrchestrator({
    doc: doc(), extract: extract(withTable), projectFacts: {},
    ask: ask as never, rasterise: async () => `data:image/png;base64,${'A'.repeat(800)}`,
    now: () => 1, limits: { maxOrchestratorTurns: 4, specialistTurns: 1 },
  } as never);
};

const rowFor = (out: Awaited<ReturnType<typeof run>>, mark: string) =>
  out.result.rows.find((r) => r.memberMark === mark)!;

// ------------------------------------------------------------
// 1. the hand-worked references
// ------------------------------------------------------------

describe('the cover the drawing states reaches the cutting length', () => {
  it('a column link is cut to the COLUMN row, 40 mm — not to the flat 50', async () => {
    // C1 350 × 350, 8⌀ closed link (shape 51), cover 40 off the sheet's table.
    //
    //   arm  = section − 2 × cover − φ        (centre-line, IS 2502)
    //   A    = 350 − 2×40 − 8 = 262
    //   B    = 350 − 2×40 − 8 = 262
    //   base = 2 × (A + B)    = 2 × 524 = 1048
    //   less four 90° corners, CONVENTIONAL 2φ each:  4 × 2 × 8 = 64
    //   cut  = 1048 − 64 = 984 mm
    //
    // At the flat 50 the engine used to apply: arm 242, base 968, cut 904.
    // 80 mm short on every link in the column, always downward.
    const row = rowFor(await run(true), 'C1');
    expect(row.cuttingLengthMm).toBe(984);
    // And WITHOUT the table there is now no length at all. 904 was the flat-50
    // answer, and 50 is a project default nobody stated — cover is in every
    // arm, so that figure was a plausible number resting on an invention.
    expect(rowFor(await run(false), 'C1').cuttingLengthMm ?? null).toBeNull();
  });

  it('a tie-beam link is cut to the TIE BEAM row, 30 mm — the worst of the three', async () => {
    // TB 350 wide × 400 deep, 8⌀ closed link, cover 30 off the sheet's table.
    // The link marches along L and wraps W × H.
    //
    //   A    = W 350 − 2×30 − 8 = 282
    //   B    = H 400 − 2×30 − 8 = 332
    //   base = 2 × (282 + 332)  = 1228
    //   less 4 × 2 × 8 = 64
    //   cut  = 1228 − 64 = 1164 mm
    //
    // At flat 50: A 242, B 292, base 1068, cut 1004 — 160 mm short per link.
    const row = rowFor(await run(true), 'TB');
    expect(row.cuttingLengthMm).toBe(1164);
    // Same as C1: with no table and no stated cover, the row is held open
    // rather than cut to a default.
    expect(rowFor(await run(false), 'TB').cuttingLengthMm ?? null).toBeNull();
  });

  it('names the cover and its source on the row, so the arm can be checked', async () => {
    const c1 = rowFor(await run(true), 'C1');
    expect(c1.coverMm).toBe(40);
    expect(c1.coverSource).not.toBe('settings-default');
    // the derivation a QS reads, opening with the cover that went into it
    expect(c1.working.join(' ')).toMatch(/cover 40 mm/);
    expect(c1.working.join(' ')).toMatch(/350 − 2×40 − 8 = 262/);
  });
});

// ------------------------------------------------------------
// 2. per member, not per sheet
// ------------------------------------------------------------

describe('cover is applied per member', () => {
  it('two members in ONE schedule are cut to two different covers', async () => {
    // The failure this guards against is the fix wearing the defect's clothes:
    // a run where every member suddenly uses 30 is just as wrong as one where
    // every member uses 50, and both move the total.
    const out = await run(true);
    expect(rowFor(out, 'C1').coverMm).toBe(40);
    expect(rowFor(out, 'TB').coverMm).toBe(30);
    const cut = out.result.rows.filter((r) => r.cuttingLengthMm !== undefined);
    expect(new Set(cut.map((r) => r.coverMm)).size).toBe(2);
  });

  it('a member the table does not describe is HELD OPEN, not cut to the default', async () => {
    // cover.ts refuses to lend PC1 the COLUMN row, and there is no sheet-wide
    // cover either. It used to fall back to the flat project figure and say so
    // in a warning — but a warning beside a number is still a number, and this
    // one was in every arm of the link. The row now carries no length at all.
    const pc1 = rowFor(await run(true), 'PC1');
    expect(pc1.cuttingLengthMm ?? null).toBeNull();
    expect(pc1.note ?? '').toMatch(/no cover is established for PC1/i);
    expect(pc1.note ?? '').toMatch(/was NOT used to cut it/i);
    // and it must not have quietly become a zero on the way
    expect(pc1.totalWeightKg ?? null).not.toBe(0);
  });

  it('a sheet with NO cover table holds every row open', async () => {
    // The case the report used to miss entirely, now refused outright. A sheet
    // that states no cover anywhere took the 50 in silence, the row read as
    // computed, and the workbook header printed "Clear cover 50" as though the
    // drawing had said it.
    const out = await run(false);
    for (const mark of ['C1', 'TB', 'PC1']) {
      const row = rowFor(out, mark);
      expect(row.cuttingLengthMm ?? null).toBeNull();
      expect(row.note ?? '').toMatch(new RegExp(`no cover is established for ${mark}`, 'i'));
    }
  });

  it('names the cover the row would have taken, so the reader can supply it', async () => {
    // Refusing without saying what was refused is not better than guessing.
    const pc1 = rowFor(await run(false), 'PC1');
    expect(pc1.note ?? '').toContain('50 mm project default');
    expect(pc1.note ?? '').toMatch(/give the clear cover in mm/i);
  });
});

// ------------------------------------------------------------
// 3. the total moves
// ------------------------------------------------------------

describe('the tonnage', () => {
  it('counts only the members whose cover the sheet actually states', async () => {
    // Hand-worked, T8 = 0.395 kg/m (IS 1786 Table 1):
    //
    //   C1   984 mm x 19 = 18.696 m -> 7.38492 kg   (cover 40, off the table)
    //   TB  1164 mm x 20 = 23.280 m -> 9.19560 kg   (cover 30, off the table)
    //   PC1 held open - the table does not describe it and the sheet states
    //       no cover, so it contributes nothing rather than 17 kg computed
    //       from a figure nobody supplied.
    //                                  ---------
    //                                  16.58052 kg
    const after = (await run(true)).result.netWeightKg!;
    expect(after).toBeCloseTo(16.58052, 4);
  });

  it('a sheet stating no cover at all yields no tonnage — not a smaller one', async () => {
    // The dangerous shape: a total that is simply lower reads as a correct
    // total for a lighter job. Every row is open, so there is no total.
    const out = await run(false);
    expect(out.result.rows.every((r) => r.cuttingLengthMm === undefined)).toBe(true);
    expect(out.result.netWeightKg ?? 0).toBe(0);
  });

  it('the count is untouched where a cover IS stated — the move is length, not bars', async () => {
    // 2700 - 2x40 = 2620 at 150 c/c is 18 gaps, 19 bars.
    expect(rowFor(await run(true), 'C1').totalBars).toBe(19);
  });
});
