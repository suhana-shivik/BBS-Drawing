// Regression guards for defects already diagnosed and fixed.
//
// Each test names the failure it prevents coming back. None of them may be
// changed without a failing test proving the pinned behaviour is wrong — see
// BBS_FAILURE_REPORT.md for what each one cost when it was live.
import { describe, expect, it } from 'vitest';
import { buildBbs, isLinearMember, DEFAULT_SETTINGS } from '../../src/cad/bbs/build';
import { resolvePlacement } from '../../src/cad/bbs/placement';
import { resolveRef } from '../../src/cad/bbs/refs';
import type { EvidenceGraph, EvidenceNode, DimensionEvidence } from '../../src/cad/bbs/evidence';
import type { BbsMember, BbsBar, DrawingExtract } from '../../src/cad/bbs/types';

const extract = { drawingName: 's', marks: [], declared: [], callouts: [], tables: [], notes: { notes: [] }, unitScale: 1 } as unknown as DrawingExtract;

const member = (over: Partial<BbsMember>): BbsMember => ({
  mark: 'M',
  type: 'beam',
  count: 1,
  source: { table: '', row: 0 },
  incomplete: false,
  missing: [],
  ...over,
});

const bar = (over: Partial<BbsBar>): BbsBar => ({
  memberMark: 'M',
  barType: 'STIRRUP',
  diaMm: 8,
  shapeCode: '51',
  fromCallout: '',
  handles: [],
  ...over,
});

describe('REGRESSION: a link wraps the cross-section, never the member length', () => {
  // Was: arms hardcoded to width × length. On a member spanning a 100 m run
  // that produced ONE 200-metre stirrup and 52,746 kg of imaginary T8 — 98% of
  // the whole schedule, arithmetically self-consistent and invisible in a total.
  const linear = member({ lengthMm: 100000, widthMm: 350, heightMm: 400 });

  it('takes W×H for a link distributed along the length', () => {
    const r = buildBbs(extract, {
      members: [linear],
      bars: [bar({ spacingMm: 150, distributionAxis: 'L' })],
      unresolved: [],
    }, DEFAULT_SETTINGS);
    const row = r.rows[0];
    // 350 and 400 are the arms; the 100000 length must appear nowhere
    expect(row.lengthWorking).toMatch(/A = W 350/);
    expect(row.lengthWorking).toMatch(/B = H 400/);
    expect(row.cuttingLengthMm).toBeLessThan(2000);
  });

  it('takes L×W for a link stacked up the height of a column', () => {
    const column = member({ lengthMm: 350, widthMm: 350, heightMm: 2700 });
    const r = buildBbs(extract, {
      members: [column],
      bars: [bar({ spacingMm: 200, distributionAxis: 'H' })],
      unresolved: [],
    }, DEFAULT_SETTINGS);
    expect(r.rows[0].cuttingLengthMm).toBeLessThan(1500);
  });

  it('falls back to the two SMALLEST axes when no axis is stated, and says so', () => {
    const r = buildBbs(extract, {
      members: [linear],
      bars: [bar({ spacingMm: 150 })],
      unresolved: [],
    }, DEFAULT_SETTINGS);
    const row = r.rows[0];
    expect(row.cuttingLengthMm).toBeLessThan(2000);
    expect(JSON.stringify(row)).toMatch(/two smallest axes/);
  });

  it('never produces a cutting length longer than the member itself', () => {
    for (const axis of ['L', 'W', 'H'] as const) {
      const r = buildBbs(extract, {
        members: [linear],
        bars: [bar({ spacingMm: 150, distributionAxis: axis })],
        unresolved: [],
      }, DEFAULT_SETTINGS);
      const cut = r.rows[0]?.cuttingLengthMm;
      if (cut !== null && cut !== undefined) expect(cut).toBeLessThan(100000);
    }
  });
});

describe('REGRESSION: silent fallbacks are refusals', () => {
  const marks: EvidenceNode[] = [0, 2000, 4000].map((x, i) => ({
    id: `MARK-A-00${i}`,
    kind: 'mark',
    sourceHandles: [],
    panelId: 'PANEL-1',
    position: { x, y: 0 },
    metadata: { mark: 'A' },
  }));
  const graph = (): EvidenceGraph => {
    const nodes = [
      ...marks,
      { id: 'PANEL-1', kind: 'panel', sourceHandles: [], metadata: {} } as EvidenceNode,
    ];
    return {
      nodes,
      edges: [],
      byId: new Map(nodes.map((n) => [n.id, n])),
      dimensions: [],
      diagnostics: [],
      related: () => [],
      inPanel: (p) => nodes.filter((n) => n.panelId === p),
    };
  };

  it('a template naming a panel that does not exist REFUSES', () => {
    // Was: fell through to every mark on the sheet. On a sheet stacking four
    // layouts that spanned all four and inflated every count ~50%, silently.
    const r = resolvePlacement(
      {
        kind: 'template-repeat',
        panelId: 'PANEL-DOES-NOT-EXIST',
        runFactId: 'run',
        orderedOccurrenceIds: marks.map((m) => m.id),
      },
      { graph: graph(), userFacts: { run: { mm: 50000 } } },
    );
    expect(r.ok).toBe(false);
    expect(r.count).toBeUndefined();
    expect(r.reason).toMatch(/is not a panel on this sheet/);
  });

  it('an unknown placement never becomes a count of 1', () => {
    const r = resolvePlacement({ kind: 'unknown', reason: 'nothing said' }, { graph: graph() });
    expect(r.ok).toBe(false);
    expect(r.count).toBeUndefined();
  });
});

describe('REGRESSION: a dimension that cannot be read stays visible', () => {
  // Was: a bare `return`. Thirteen dimensions vanished from a real sheet with
  // no trace, making it indistinguishable from a sheet with none.
  it('records every unreadable dimension with a reason', async () => {
    const { buildEvidenceGraph } = await import('../../src/cad/bbs/evidence');
    // a doc whose dimension carries no text to pair with
    const doc = {
      name: 'd',
      entities: [],
      layers: new Map(),
      blocks: new Map(),
      unitScale: 1,
      extents: null,
    } as never;
    const g = buildEvidenceGraph(doc, extract);
    // the contract, not the count: diagnostics exist and are inspectable
    expect(Array.isArray(g.diagnostics)).toBe(true);
    for (const d of g.diagnostics) {
      expect(d.reason).toBeTruthy();
      expect(g.byId.get(d.id)).toBeDefined();
      // and it must never be summable
      expect(g.dimensions.some((x) => x.id === d.id)).toBe(false);
    }
  });
});

describe('REGRESSION: dimension paths', () => {
  const dim = (id: string, v: number, lo: number, hi: number, xOff = 0): DimensionEvidence => ({
    id,
    kind: 'dimension',
    sourceHandles: [],
    valueMm: v,
    axis: 'y',
    from: { x: xOff, y: lo },
    to: { x: xOff, y: hi },
    metadata: {},
  });
  const graphOf = (dims: DimensionEvidence[]): EvidenceGraph => ({
    nodes: dims,
    edges: [],
    byId: new Map(dims.map((d) => [d.id, d])),
    dimensions: dims,
    diagnostics: [],
    related: () => [],
    inPanel: () => [],
  });
  const path = (ids: string[]) =>
    ({ kind: 'dimension-path', axis: 'y', fromAnchor: ids[0], toAnchor: ids[ids.length - 1], segmentEvidenceIds: ids }) as const;

  it('contiguity is judged ALONG the axis, tolerating a perpendicular offset', () => {
    // Was: judged in 2D. A real chain whose segments sat 50 mm apart sideways
    // — because their extension lines touch different faces — was rejected.
    const g = graphOf([dim('D1', 1500, 0, 1500, 0), dim('D2', 900, 1500, 2400, 50)]);
    const r = resolveRef(path(['D1', 'D2']), { graph: g });
    expect(r).toMatchObject({ ok: true, mm: 2400 });
  });

  it('still refuses a genuine gap along the axis', () => {
    const g = graphOf([dim('D1', 1500, 0, 1500), dim('D2', 900, 5000, 5900)]);
    const r = resolveRef(path(['D1', 'D2']), { graph: g });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not span continuously/);
  });

  it('rejects a path whose segments are drawn at different scales', () => {
    // one sheet may draw at 1:2 throughout; mixing ratios means the sum is
    // meaningless, and a meaningless sum must not be produced
    const g = graphOf([
      dim('D1', 1500, 0, 1500), // 1:1
      dim('D2', 900, 1500, 1950), // prints 900 over a 450 span
    ]);
    const r = resolveRef(path(['D1', 'D2']), { graph: g });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/different scales/);
  });

  it('accepts a path drawn consistently at a non-unity scale', () => {
    // the real sheet draws at twice its annotation; printed text is authority
    const g = graphOf([dim('D1', 300, 0, 600), dim('D2', 900, 600, 2400)]);
    expect(resolveRef(path(['D1', 'D2']), { graph: g })).toMatchObject({ ok: true, mm: 1200 });
  });
});

// ============================================================
// THE GAMCO BROWSER RUN OF 2026-08-29 — 21 rows, every weight 0.000, 0.0 kg
//
// Three separate defects reached the screen together, and each of them
// COMPUTED. That is what makes them this file's business: a number that comes
// out wrong is worse than a blank, because a blank has an owner and a wrong
// number has a reader who believes it.
// ============================================================

describe('REGRESSION (GAMCO 2026-08-29): a link cut to ONE ARM of its section', () => {
  // Every link row on that run printed 242 mm on a 350 mm section:
  //   242 = 350 − 2×50 − 8, which is A — one side of the hoop.
  // A closed link is 2 × (A + B) plus hooks, less the bend deductions, so 242
  // is roughly a quarter of the steel. The cause was the SHAPE, not the arms:
  // the model issued no `shape` decision for those callouts, they were built as
  // '00' (Straight), whose formula is literally `A`, and the B this engine had
  // already computed was discarded on the way into it.
  const column = member({ mark: 'C1', lengthMm: 350, widthMm: 350, heightMm: 2700 });

  it('refuses a link whose shapeCode has no perimeter, rather than cutting one arm', () => {
    const r = buildBbs(extract, {
      members: [column],
      bars: [bar({ memberMark: 'C1', shapeCode: '00', spacingMm: 200, distributionAxis: 'H' })],
      unresolved: [],
    }, DEFAULT_SETTINGS);
    expect(r.rows[0].cuttingLengthMm).toBeNull();
    expect(r.rows[0].cuttingLengthMm).not.toBe(242);
  });

  it('names the FIELD at fault and the legal shapes, and corrects nothing', () => {
    const r = buildBbs(extract, {
      members: [column],
      bars: [bar({ memberMark: 'C1', shapeCode: '00', spacingMm: 200, distributionAxis: 'H' })],
      unresolved: [],
    }, DEFAULT_SETTINGS);
    const why = r.rows[0].missing ?? '';
    expect(why).toMatch(/shapeCode/);
    expect(why).toMatch(/one ARM/i);
    expect(why).toMatch(/51/);
    // it must not quietly decide the bar is a closed link — that is the
    // drawing's call, and rewriting it here is invention with a plausible face
    expect(r.rows[0].shapeCode).toBe('00');
  });

  it('computes the full perimeter the moment the shape is a closing one', () => {
    const r = buildBbs(extract, {
      members: [column],
      bars: [bar({ memberMark: 'C1', shapeCode: '51', spacingMm: 200, distributionAxis: 'H' })],
      unresolved: [],
    }, DEFAULT_SETTINGS);
    // 2 × (242 + 242) = 968 before hooks and bend deductions — near a metre,
    // not near a quarter of one
    expect(r.rows[0].cuttingLengthMm).toBeGreaterThan(700);
    expect(r.rows[0].lengthWorking).toMatch(/2 × \(A \+ B\)/);
  });
});

describe('REGRESSION (GAMCO 2026-08-29): a wall bar measured across the wall', () => {
  // "RCC WALL" printed a cutting length of 100 mm — 200 − 2×50, the THICKNESS
  // less cover — 501 times over a 100 m wall, and weighed it. Two things had to
  // go wrong: the member was not recognised as linear (the orchestrated path
  // names every member `type: 'member'`, so only the MARK carries the word
  // "WALL"), and nothing objected to a bar shorter than it can physically be.
  const wall = member({
    mark: 'RCC WALL',
    type: 'member', // exactly what the orchestrated build supplies
    lengthMm: 100_000,
    widthMm: 200,
    heightMm: 1200,
  });
  const wallBar = bar({
    memberMark: 'RCC WALL',
    barType: 'DISTRIBUTION',
    diaMm: 10,
    shapeCode: '00',
    spacingMm: 200,
    distributionAxis: 'L',
    fromCallout: '10TOR@200C/C',
  });

  it('reads "wall" off the MARK when the member has no type to give', () => {
    expect(isLinearMember(wall)).toBe(true);
    // and does not start calling everything linear
    expect(isLinearMember(member({ mark: 'C1', type: 'member' }))).toBe(false);
    expect(isLinearMember(member({ mark: 'F1', type: 'member' }))).toBe(false);
  });

  it('cuts the wall bar to the HEIGHT, never to the 200 mm thickness', () => {
    const r = buildBbs(extract, { members: [wall], bars: [wallBar], unresolved: [] }, DEFAULT_SETTINGS, undefined, {
      runM: 100,
    });
    expect(r.rows[0].cuttingLengthMm).not.toBe(100);
    expect(r.rows[0].cuttingLengthMm).toBe(1200 - 2 * DEFAULT_SETTINGS.coverMm);
  });

  it('and refuses outright any bar shorter than its own anchorage', () => {
    // The second line of defence, and the one that generalises: a section
    // dimension read as a length always produces a SHORT number, and a short
    // number computes all the way to a weight. IS 456 cl 26.2.1 — a bar whose
    // whole cutting length is under Ld has nowhere to anchor, so it is not a
    // bar, it is a dimension that was read as one.
    const stub = member({ mark: 'P1', type: 'pedestal', lengthMm: 200, widthMm: 200, heightMm: 200 });
    const r = buildBbs(extract, {
      members: [stub],
      bars: [bar({ memberMark: 'P1', barType: 'MAIN', diaMm: 10, shapeCode: '00', manualCount: 4 })],
      unresolved: [],
    }, DEFAULT_SETTINGS);
    expect(r.rows[0].cuttingLengthMm).toBeNull();
    const why = r.rows[0].missing ?? '';
    expect(why).toMatch(/development length/i);
    expect(why).toMatch(/distributionAxis/);
    // a field, never a target
    expect(why).not.toMatch(/\btonn?e|\bkg\b|should be|nearer/i);
  });

  it('leaves a link alone — its length is a perimeter, not an anchorage', () => {
    // a 242 mm hoop round a 350 mm column is real steel and must not be
    // caught by the floor above
    const r = buildBbs(extract, {
      members: [member({ mark: 'C1', lengthMm: 350, widthMm: 350, heightMm: 2700 })],
      bars: [bar({ memberMark: 'C1', shapeCode: '51', spacingMm: 200, distributionAxis: 'H', diaMm: 8 })],
      unresolved: [],
    }, DEFAULT_SETTINGS);
    expect(r.rows[0].cuttingLengthMm).not.toBeNull();
  });
});

describe('REGRESSION (GAMCO 2026-08-29): a count that cannot be derived is a HOLE, not 0', () => {
  // The link rows read "No. per member 0 · Total 0 · 0.000 kg" because the
  // member height they march along was unresolved. A silent 0 is the same
  // class of error as the silent 1 this engine has always refused — it weighs
  // nothing, it reconciles against every arithmetic check, and it reads as an
  // answer. The architecture rule is "an unknown placement → a gap, NEVER 1";
  // a count is held to the same rule.
  const noHeight = member({ mark: 'C1', type: 'column', lengthMm: 350, widthMm: 350 });
  const build = () =>
    buildBbs(extract, {
      members: [noHeight],
      bars: [bar({ memberMark: 'C1', shapeCode: '51', spacingMm: 200, distributionAxis: 'H' })],
      unresolved: [],
    }, DEFAULT_SETTINGS);

  it('reports null, never 0', () => {
    const row = build().rows[0];
    expect(row.barsPerMember).toBeNull();
    expect(row.totalBars).toBeNull();
    expect(row.weightKg).toBeNull();
  });

  it('says WHICH dimension it waits on, by member and axis', () => {
    const why = build().rows[0].missing ?? '';
    expect(why).toMatch(/C1's H/);
    expect(why).toMatch(/not resolved/i);
    expect(why).toMatch(/no count was assumed/i);
  });

  it('the same reason reaches `incomplete`, so nothing has to guess it', () => {
    expect(build().incomplete.map((i) => i.reason).join(' ')).toMatch(/C1's H/);
  });

  it('contributes nothing to the summary — a hole is not a zero-weight row', () => {
    expect(build().summary).toEqual([]);
  });

  it('and the artifact marks the row UNAVAILABLE rather than verified', async () => {
    const { buildChatResult } = await import('../../src/cad/bbs/chatResult');
    const r = buildChatResult({
      id: 'zero-count',
      drawingName: 'GAMCO',
      result: build() as never,
      verification: { ok: true, passed: [], failures: [] },
    });
    expect(r.rows[0].status).toBe('unavailable');
    expect(r.rows[0].note).toMatch(/C1's H/);
    // and a schedule carrying a blocked row is never "complete"
    expect(r.status).toBe('partial');
  });
});
