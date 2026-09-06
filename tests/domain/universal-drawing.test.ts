// THE SAME ENGINE, ANY DRAWING. Nothing in calculations/schedule.ts,
// tableFacts.ts or the orchestrator's fact resolution knows a member name:
// a footing schedule, a beam schedule, a column schedule, a slab and a
// custom detail all reach rows through the same fact → geometry → length →
// quantity → weight stages. These cases pin that — the member names and
// figures below are DATA, and the code under test contains none of them.
import { describe, expect, it, vi } from 'vitest';
import { buildBbs, DEFAULT_SETTINGS } from '../../src/cad/bbs/build';
import { memberFactsFromTables, tableCellsForCallouts, tableDimsByMark } from '../../src/cad/bbs/tableFacts';
import { runOrchestrator } from '../../src/cad/bbs/orchestrate';
import { BY_LAYER, type CadDocument, type CadLayer } from '../../src/cad/types';
import type { BbsBar, BbsMember, BbsSettings, DrawingExtract, ExtractedTable } from '../../src/cad/bbs/types';

const STATED: BbsSettings = { ...DEFAULT_SETTINGS, coverMm: 40, coverSource: 'stated' };

const extractOf = (over: Partial<DrawingExtract> = {}): DrawingExtract =>
  ({ drawingName: 'x.dxf', sourceFile: 'x.dxf', marks: [], declared: [], callouts: [], tables: [], notes: { notes: [] }, unitScale: 1, ...over }) as unknown as DrawingExtract;

/** a member whose dimensions are STATED facts — a schedule row, as the reader files them */
const member = (mark: string, type: string, dims: { L?: number; W?: number; H?: number }, count: number): BbsMember => ({
  mark,
  type,
  lengthMm: dims.L,
  widthMm: dims.W,
  heightMm: dims.H,
  dimSources: Object.fromEntries(
    (['L', 'W', 'H'] as const).filter((a) => dims[a] !== undefined).map((a) => [a, `DRAWING_READ — schedule row ${mark}, ${a} = ${dims[a]}`]),
  ),
  count,
  source: { table: '', row: 0 },
  incomplete: false,
  missing: [],
});

const bar = (memberMark: string, over: Partial<BbsBar>): BbsBar =>
  ({ memberMark, barType: 'MAIN', diaMm: 12, shapeCode: '00', fromCallout: 'callout', handles: [], ...over }) as BbsBar;

describe('Case 2 — a plinth beam sheet (PB03)', () => {
  it('computes top/bottom bars along the span and stirrups over the run, from facts alone', () => {
    const r = buildBbs(
      extractOf(),
      {
        members: [member('PB03', 'plinth beam', { L: 4500, W: 230, H: 450 }, 6)],
        bars: [
          bar('PB03', { barType: 'TOP', diaMm: 16, manualCount: 2, distributionAxis: 'W', fromCallout: '2-16 TOP' }),
          bar('PB03', { barType: 'BOTTOM', diaMm: 16, manualCount: 3, distributionAxis: 'W', fromCallout: '3-16 BOT' }),
          bar('PB03', { barType: 'STIRRUP', diaMm: 8, shapeCode: '51', spacingMm: 150, distributionAxis: 'L', fromCallout: '8@150 c/c' }),
        ],
        unresolved: [],
      },
      STATED,
    );
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.trace?.stages).toContain('VALIDATED');
      expect(row.weightKg).not.toBeNull();
      expect(row.memberCount).toBe(6);
    }
    // main bars run along the span
    expect(r.rows[0].cuttingLengthMm).toBe(4500 - 2 * 40);
    expect(r.rows[0].totalBars).toBe(12);
    expect(r.rows[1].totalBars).toBe(18);
    // the stirrup wraps the cross-section and marches the span at 150 c/c
    const st = r.rows[2];
    expect(st.trace?.method.quantity).toBe('RUN');
    expect(st.barsPerMember).toBe(Math.floor(4500 / 150) + 1);
    expect(st.lengthWorking).toMatch(/230 − 2×40 − 8/);
    expect(st.lengthWorking).toMatch(/450 − 2×40 − 8/);
    expect(r.reconciliation?.ok).toBe(true);
    expect(r.rows[0].trace?.factsUsed).toEqual(expect.arrayContaining(['PB03.length', 'PB03.count']));
  });
});

describe('Case 3 — a column sheet (C12)', () => {
  it('computes verticals along the height and ties over the height', () => {
    const r = buildBbs(
      extractOf(),
      {
        members: [member('C12', 'column', { L: 300, W: 300, H: 3000 }, 4)],
        bars: [
          bar('C12', { barType: 'MAIN', diaMm: 16, manualCount: 8, distributionAxis: 'H', fromCallout: '8-16' }),
          bar('C12', { barType: 'TIE', diaMm: 8, shapeCode: '51', spacingMm: 200, distributionAxis: 'H', fromCallout: '8@200' }),
        ],
        unresolved: [],
      },
      STATED,
    );
    expect(r.rows[0].cuttingLengthMm).toBe(3000 - 80);
    expect(r.rows[0].totalBars).toBe(32);
    expect(r.rows[1].barsPerMember).toBe(Math.ceil((3000 - 80) / 200) + 1);
    expect(r.rows[1].trace?.method.quantity).toBe('AUTO_SPACING');
    expect(r.rows.every((x) => x.trace?.stages.includes('VALIDATED'))).toBe(true);
  });

  it('holds the ties open — naming C12.width — when the section is not on record', () => {
    const r = buildBbs(
      extractOf(),
      {
        members: [member('C12', 'column', { L: 300, H: 3000 }, 4)],
        bars: [bar('C12', { barType: 'TIE', diaMm: 8, shapeCode: '51', spacingMm: 200, distributionAxis: 'H', fromCallout: '8@200' })],
        unresolved: [],
      },
      STATED,
    );
    const t = r.rows[0].trace!;
    expect(r.rows[0].cuttingLengthMm).toBeNull();
    expect(t.failedStage).toBe('GEOMETRY_RESOLVED');
    expect(t.missingFact).toBe('C12.width');
    expect(t.action).toMatch(/C12\.width/);
    expect(r.rows[0].weightKg).toBeNull();
  });
});

describe('Case 4 — a slab', () => {
  it('computes a two-way mesh from the panel size, each direction spaced along the other', () => {
    const r = buildBbs(
      extractOf(),
      {
        members: [member('S1', 'slab', { L: 4000, W: 3000, H: 150 }, 2)],
        bars: [
          bar('S1', { barType: 'BOTTOM', diaMm: 10, spacingMm: 150, distributionAxis: 'W', fromCallout: '10@150 c/c along L' }),
          bar('S1', { barType: 'DISTRIBUTION', diaMm: 8, spacingMm: 200, distributionAxis: 'L', fromCallout: '8@200 c/c along W' }),
        ],
        unresolved: [],
      },
      STATED,
    );
    expect(r.rows[0].cuttingLengthMm).toBe(4000 - 80);
    expect(r.rows[0].barsPerMember).toBe(Math.ceil((3000 - 80) / 150) + 1);
    expect(r.rows[1].cuttingLengthMm).toBe(3000 - 80);
    expect(r.rows[1].barsPerMember).toBe(Math.ceil((4000 - 80) / 200) + 1);
    expect(r.reconciliation?.ok).toBe(true);
  });
});

describe('Case 5 — a custom detail with an unfamiliar mark', () => {
  it('needs no code to know the member: RW-7A computes like any other, with its trace', () => {
    const r = buildBbs(
      extractOf(),
      {
        members: [member('RW-7A', 'retaining wall stem', { L: 12000, W: 250, H: 2400 }, 1)],
        bars: [bar('RW-7A', { barType: 'MAIN', diaMm: 12, spacingMm: 150, distributionAxis: 'L', fromCallout: '12@150 c/c verticals', handles: ['ABCD'] })],
        unresolved: [],
      },
      STATED,
    );
    const row = r.rows[0];
    expect(row.cuttingLengthMm).toBe(2400 - 80);
    expect(row.trace?.sourceText).toBe('12@150 c/c verticals');
    expect(row.trace?.sourceHandles).toEqual(['ABCD']);
    expect(row.trace?.method).toEqual({ cuttingLength: 'SHAPE_FORMULA', quantity: 'RUN', unitWeight: 'IS_1786_NOMINAL' });
    expect(row.trace?.formula).toMatch(/2400 − 2×40/);
    expect(r.manifest?.rowDeps[0].factIds).toEqual(expect.arrayContaining(['RW-7A.height', 'RW-7A.length', 'RW-7A.count']));
  });
});

describe('the schedule-table reader is not a footing reader', () => {
  const BEAM_TABLE: ExtractedTable = {
    title: 'BEAM SCHEDULE',
    header: ['BEAM MARK', 'WIDTH B', 'DEPTH D', 'SPAN', 'TOP BARS', 'BOTTOM BARS', 'STIRRUPS'],
    rows: [
      ['PB03', '230', '450', '4500', '2-16', '3-16', '8@150 c/c'],
      ['B1', '300', '600', '6000', '3-20', '4-20', '10@125 c/c'],
    ],
    min: { x: 0, y: -2000 },
    max: { x: 14000, y: 0 },
    handles: [],
  };
  const COLUMN_TABLE: ExtractedTable = {
    title: 'COLUMN SCHEDULE',
    header: ['COL. MARK', 'SIZE B', 'SIZE D', 'HEIGHT', 'MAIN BARS', 'TIES'],
    rows: [['C12', '300', '300', '3000', '8-16', '8@200 c/c']],
    min: { x: 0, y: -2000 },
    max: { x: 12000, y: 0 },
    handles: [],
  };

  it('reads a beam schedule: width → W, depth → H, span → L, stirrup cells tied to callouts', () => {
    const e = { tables: [BEAM_TABLE], callouts: [
      { raw: '8@150 c/c', handle: 'S1', position: { x: 12000, y: -500 }, diaMm: 8, spacingMm: 150, layer: '0' },
      { raw: '10@125 c/c', handle: 'S2', position: { x: 12000, y: -1500 }, diaMm: 10, spacingMm: 125, layer: '0' },
    ] };
    const facts = memberFactsFromTables(e);
    const dims = tableDimsByMark(facts);
    expect(dims.get('PB03')).toMatchObject({ W: { mm: 230 }, H: { mm: 450 }, L: { mm: 4500 } });
    expect(dims.get('B1')).toMatchObject({ W: { mm: 300 }, H: { mm: 600 }, L: { mm: 6000 } });
    expect(facts.dims.find((d) => d.factId === 'PB03.length')?.source).toMatch(/BEAM SCHEDULE row PB03, column "SPAN" = 4500/);
    const cells = tableCellsForCallouts(e, facts);
    expect(cells.get('S1')?.mark).toBe('PB03');
    expect(cells.get('S2')?.mark).toBe('B1');
    expect(cells.get('S1')?.column).toBe('STIRRUPS');
  });

  it('reads a column schedule: two SIZE columns and a HEIGHT', () => {
    const dims = tableDimsByMark(memberFactsFromTables({ tables: [COLUMN_TABLE] }));
    expect(dims.get('C12')).toMatchObject({ W: { mm: 300 }, H: { mm: 3000 } });
  });
});

// ------------------------------------------------------------
// dynamic discovery through the orchestrator — a beam sheet, not a footing sheet
// ------------------------------------------------------------

const LAYER_0: CadLayer = { name: '0', color: BY_LAYER, lineweight: -3, linetype: 'CONTINUOUS', visible: true, frozen: false, transparency: 0 };

function beamDoc(): CadDocument {
  const e: Record<string, unknown>[] = [];
  let h = 0x4000;
  const next = (): string => (h++).toString(16).toUpperCase();
  const text = (t: string, x: number, y: number, height = 100) =>
    e.push({ type: 'text', text: t, position: { x, y }, height, style: { handle: next(), layer: '0', color: BY_LAYER, lineweight: -1, linetype: '', linetypeScale: 1, transparency: -1, normal: null } });
  for (const x of [0, 4500, 9000]) text('PB03', x, 0);
  text('8@150 c/c', 12000, -500, 80);
  return { name: 'beams', sourceFile: 'beams.dxf', entities: e as never, layers: new Map([['0', LAYER_0]]) as never, blocks: new Map(), unitScale: 1, extents: null } as unknown as CadDocument;
}

describe('dynamic discovery on a beam sheet', () => {
  it('grounds PB03 from its BEAM SCHEDULE row and computes its stirrups from a count on record', async () => {
    const extract = extractOf({
      drawingName: 'beams.dxf',
      marks: ['PB03'],
      callouts: [{ raw: '8@150 c/c', handle: 'S1', position: { x: 12000, y: -500 }, diaMm: 8, spacingMm: 150, layer: '0' }],
      tables: [{
        title: 'BEAM SCHEDULE',
        header: ['BEAM MARK', 'WIDTH B', 'DEPTH D', 'SPAN', 'STIRRUPS'],
        rows: [['PB03', '230', '450', '4500', '8@150 c/c']],
        min: { x: 0, y: -2000 },
        max: { x: 14000, y: 0 },
        handles: [],
      }],
    });
    const ask = vi.fn(async (args: { label: string }) =>
      args.label === 'orchestrator' ? { done: { why: 'the schedule table says it all' } } : { findings: [], done: true },
    );
    const out = await runOrchestrator({
      doc: beamDoc(),
      extract,
      projectFacts: { pb03_count: { mm: 3, saidAs: '3' } },
      settings: { coverMm: 40 },
      // ownership comes from the table row; the SHAPE is the reading's to state
      // (a link's perimeter is not derivable from a header word), so the saved
      // About Drawing conclusion supplies it — as it would on any sheet
      priorConclusions: [{ kind: 'shape', calloutId: 'CALL-001', shapeCode: '51', evidenceIds: ['CALL-001'] }],
      ask: ask as never,
      rasterise: async () => `data:image/png;base64,${'A'.repeat(800)}`,
      now: () => 1,
      limits: { maxOrchestratorTurns: 2, specialistTurns: 1 },
    });
    const m = out.result.members.find((x) => x.mark === 'PB03')!;
    expect(m.dims).toEqual({ L: 4500, W: 230, H: 450 });
    expect(m.count).toBe(3);
    const row = out.result.rows[0];
    expect(row.status).not.toBe('unavailable');
    expect(row.trace?.factsUsed).toEqual(expect.arrayContaining(['PB03.width', 'PB03.height', 'PB03.count']));
    expect(out.snapshot.join('\n')).toMatch(/BLOCKED ROWS\s+0/);
  });
});
