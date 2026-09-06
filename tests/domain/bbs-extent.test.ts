// ============================================================
// THE EXTENT HOLE — written against the GAMCO boundary-wall browser run of
// 2026-08-29, which produced a 21-row schedule from one drawn module and
// reported it as the whole job.
//
// A quantity is `detail × extent`. Every other gate in this engine inspects
// detail; the extent lives on the architectural drawing, which is a different
// file, and the structural sheet says so in its own General Notes. So "no run
// was supplied" is the NORMAL state of the input.
//
// On that run no run fact was supplied, the briefing said "PROJECT RUN: none
// was supplied", and the model placed the column family with `{kind:'marks'}` —
// "the drawn tags ARE the whole job" — which is the one placement kind that
// needs no run fact. It counted SC 5, C1 4, C2 2, F1 7 over ~24,948 mm of
// drawn layout and called that the wall.
//
// `placement.ts` already held a guard for exactly this, and it could not fire:
// it compares the drawn coverage against the run fact, and there was no run
// fact. With no extent anywhere, nothing distinguishes a 25 m module from a
// 100 m job. These tests pin the honesty that closes that hole.
//
// The rule the messages must keep: a failure names a FIELD, never a target,
// and no tonnage appears anywhere.
// ============================================================
import { describe, expect, it, vi } from 'vitest';
import { runOrchestrator } from '../../src/cad/bbs/orchestrate';
import { buildEvidenceGraph } from '../../src/cad/bbs/evidence';
import { resolvePlacement, resolveAllPlacements, type PlacementContext } from '../../src/cad/bbs/placement';
import { gateExtent, verifyAll } from '../../src/cad/bbs/verify';
import { buildChatResult, artifactMessage, type ExtentClaim } from '../../src/cad/bbs/chatResult';
import type { EvidenceGraph, EvidenceNode } from '../../src/cad/bbs/evidence';

/**
 * One drawn module of a boundary wall: five C1 tags at ~6,237 mm centres.
 * First tag to last is 24,948 mm — the same figure the live run measured — and
 * the module's own reach is that plus one closing bay.
 */
const PITCH = 6237;
const LAYOUT = [0, 1, 2, 3, 4].map((i) => ({ id: `MARK-C1-00${i + 1}`, x: i * PITCH }));

function graph(): EvidenceGraph {
  const nodes: EvidenceNode[] = LAYOUT.map((m) => ({
    id: m.id,
    kind: 'mark',
    sourceHandles: [],
    panelId: 'PANEL-1',
    position: { x: m.x, y: 0 },
    rawText: 'C1',
    metadata: { mark: 'C1' },
  }));
  nodes.push({ id: 'PANEL-1', kind: 'panel', sourceHandles: [], metadata: { caption: 'layout' } });
  return {
    nodes,
    edges: [],
    byId: new Map(nodes.map((n) => [n.id, n])),
    dimensions: [],
    diagnostics: [],
    related: () => [],
    inPanel: (p) => nodes.filter((n) => n.panelId === p),
  };
}

const ctx = (runMm?: number): PlacementContext => ({
  graph: graph(),
  userFacts: runMm ? { run: { mm: runMm, saidAs: `${runMm / 1000} m` } } : {},
});

const allIds = LAYOUT.map((m) => m.id);

// ------------------------------------------------------------
// 1. the placement itself
// ------------------------------------------------------------

describe('a repeating band read as the whole job, with no run anywhere', () => {
  it('still counts the tags — the drawing is not wrong, only unscoped', () => {
    const r = resolvePlacement({ kind: 'marks', markEvidenceIds: allIds }, ctx());
    expect(r.ok).toBe(true);
    expect(r.count).toBe(5);
  });

  it('carries the drawn extent in mm, measured — not asserted', () => {
    const r = resolvePlacement({ kind: 'marks', markEvidenceIds: allIds }, ctx());
    // 4 × 6237 = 24,948 across the tags, plus the bay past the last one
    expect(r.unverifiedExtent).toMatchObject({
      drawnExtentMm: 24_948 + PITCH,
      nodes: 5,
      pitchMm: PITCH,
      field: 'run',
    });
  });

  it('carries the question that settles it, and no target of any kind', () => {
    const r = resolvePlacement({ kind: 'marks', markEvidenceIds: allIds }, ctx());
    expect(r.unverifiedExtent!.ask).toMatch(/total run/i);
    const text = JSON.stringify(r);
    // no tonnage, no "should be", no multiple to reach for
    expect(text).not.toMatch(/\btonn?e|\bkg\b|should be|ought to/i);
  });

  it('says in its working that nothing establishes this is the whole job', () => {
    const r = resolvePlacement({ kind: 'marks', markEvidenceIds: allIds }, ctx());
    expect(r.working).toMatch(/no run was supplied/i);
    expect(r.working).toMatch(/24948|31185/);
  });

  it('leaves a member genuinely drawn ONCE completely alone', () => {
    // The distinction that keeps this honest: one tag is one member, not a
    // claim about extent. Blocking here would make the engine useless on the
    // one-off details it handles best.
    const r = resolvePlacement({ kind: 'marks', markEvidenceIds: [allIds[0]] }, ctx());
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(r.unverifiedExtent).toBeUndefined();
  });

  it('says nothing when a run IS supplied — there the old guard does the work', () => {
    // 31,185 mm of layout against a 31,185 mm run: the layout IS the job, and
    // it was checked rather than assumed.
    const r = resolvePlacement({ kind: 'marks', markEvidenceIds: allIds }, ctx(24_948 + PITCH));
    expect(r.ok).toBe(true);
    expect(r.unverifiedExtent).toBeUndefined();
  });

  it('and still refuses outright when the run says the layout is a module', () => {
    const r = resolvePlacement({ kind: 'marks', markEvidenceIds: allIds }, ctx(100_000));
    expect(r.ok).toBe(false);
    expect(r.count).toBeUndefined();
  });

  it('a dependent count inherits its parent’s scope rather than losing it', () => {
    // F1 exists because C1 stands on it. If C1 was counted off an unverified
    // band, the footings under it cover exactly that stretch too — dropping
    // the caveat on the way down turns a warned number into an unwarned one.
    const out = resolveAllPlacements(
      [
        { memberId: 'C1', placement: { kind: 'marks', markEvidenceIds: allIds } },
        { memberId: 'F1', placement: { kind: 'dependent', parentMemberIds: ['C1'], relation: 'one-per-parent' } },
      ],
      ctx(),
    );
    expect(out.get('F1')).toMatchObject({ ok: true, count: 5 });
    expect(out.get('F1')!.unverifiedExtent).toMatchObject({ field: 'run' });
  });
});

// ------------------------------------------------------------
// 2. the gate
// ------------------------------------------------------------

const interpretation = { members: [], bars: [], unresolved: [] } as never;

const claimed = new Map([
  [
    'C1',
    {
      ok: true,
      count: 5,
      unverifiedExtent: {
        drawnExtentMm: 31_185,
        nodes: 5,
        pitchMm: PITCH,
        field: 'run' as const,
        ask: 'What is the total run of this structure, in metres?',
      },
    },
  ],
]);

describe('the extent gate', () => {
  it('fails the run — a schedule for an unknown fraction is not a success', () => {
    const f = gateExtent({ interpretation, placements: claimed });
    expect(f).toHaveLength(1);
    expect(f[0].gate).toBe('extent');
  });

  it('names the FIELD it waits on, and the member', () => {
    const [f] = gateExtent({ interpretation, placements: claimed });
    expect(f.field).toBe('run');
    expect(f.memberMark).toBe('C1');
  });

  it('states the drawn extent and the question, and no target', () => {
    const [f] = gateExtent({ interpretation, placements: claimed });
    expect(f.message).toMatch(/31185 mm/);
    expect(f.message).toMatch(/total run/i);
    expect(f.message).not.toMatch(/\btonn?e|\bkg\b|should be|nearer|shortfall/i);
  });

  it('is silent once a run exists — it is the absence that it reports', () => {
    expect(gateExtent({ interpretation, placements: claimed, runMm: 100_000 })).toEqual([]);
  });

  it('is silent for a placement that claimed no extent', () => {
    const clean = new Map([['TB', { ok: true, count: 1, continuous: true }]]);
    expect(gateExtent({ interpretation, placements: clean })).toEqual([]);
  });

  it('reaches verifyAll, so the run cannot report itself ok', () => {
    const r = verifyAll({ interpretation, placements: claimed });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.gate === 'extent')).toBe(true);
    expect(r.passed).not.toContain('extent');
  });

  it('reports NOT-APPLICABLE rather than "pass" when it had nothing to look at', () => {
    const r = verifyAll({ interpretation });
    const g = r.gates.find((x) => x.gate === 'extent')!;
    expect(g.status).toBe('not-applicable');
    expect(g.because).toMatch(/nothing claimed/i);
  });
});

// ------------------------------------------------------------
// 3. the artifact a person actually reads
// ------------------------------------------------------------

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
      lengthSource: 'SHAPE_FORMULA',
    },
  ],
  summary: [
    { diaMm: 12, barCount: 40, totalLengthM: 104, unitWeightKgPerM: 0.888, totalWeightKg: 92.352, totalWeightWithWastageKg: 95.12, totalWeightMt: 0.09, nonStandardDiameter: false },
  ],
  members: [{ mark: 'C1', type: 'column', count: 5, lengthMm: 350, widthMm: 350, heightMm: 2700 }],
  incomplete: [],
} as never;

const CLAIM: ExtentClaim = {
  memberMark: 'C1',
  drawnExtentMm: 31_185,
  nodes: 5,
  pitchMm: PITCH,
  field: 'run',
  ask: 'What is the total run of this structure, in metres?',
};

const withClaim = () =>
  buildChatResult({
    id: 'extent-1',
    drawingName: 'GAMCO - BOUNDARY WALL DETAILS',
    result: engineResult,
    verification: { ok: true, passed: ['schema'], failures: [] },
    extentClaims: [CLAIM],
  });

const withoutClaim = () =>
  buildChatResult({
    id: 'extent-0',
    drawingName: 'GAMCO - BOUNDARY WALL DETAILS',
    runMm: 100_000,
    result: engineResult,
    verification: { ok: true, passed: ['schema'], failures: [] },
  });

describe('the extent caveat on the chat artifact', () => {
  it('is the FIRST warning, ahead of every per-row one', () => {
    const r = withClaim();
    expect(r.warnings[0].message).toMatch(/COVERS ONLY WHAT IS DRAWN/);
  });

  it('names the drawn extent in mm and the question that settles it', () => {
    const w = withClaim().warnings[0].message;
    expect(w).toMatch(/31185 mm/);
    expect(w).toMatch(/total run/i);
  });

  it('names no target and no tonnage', () => {
    const w = withClaim().warnings[0].message;
    expect(w).not.toMatch(/\btonn?e|\bkg\b|should be|nearer|times|multiply by/i);
  });

  it('appears again as an assumption, with what would resolve it', () => {
    const a = withClaim().assumptions;
    expect(a).toHaveLength(1);
    expect(a[0].what).toMatch(/drawn layout is the entire structure/i);
    expect(a[0].why).toMatch(/assumed, not read/i);
    expect(a[0].toResolve).toMatch(/total run/i);
  });

  it('rides the result as a structured field, not only as prose', () => {
    const r = withClaim();
    expect(r.extentClaims).toEqual([CLAIM]);
    expect(r.coversDrawnExtentMm).toBe(31_185);
  });

  it('is NEVER a silent success — status cannot be complete', () => {
    // every gate silent, no row blocked, and still not complete: a schedule
    // for an unknown fraction of a structure is not a finished schedule
    expect(withClaim().status).toBe('partial');
    expect(withoutClaim().status).toBe('complete');
  });

  it('the assistant message leads with the caveat, and still states no numbers', () => {
    const msg = artifactMessage(withClaim());
    expect(msg.content).toMatch(/covers only the stretch that is drawn/i);
    expect(msg.content).not.toMatch(/\d/);
  });

  it('leaves a schedule with a known run completely unmarked', () => {
    const r = withoutClaim();
    expect(r.extentClaims).toEqual([]);
    expect(r.coversDrawnExtentMm).toBeUndefined();
    expect(r.assumptions).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

// ------------------------------------------------------------
// 4. the live path — the one the browser run actually walked
// ------------------------------------------------------------

describe('the orchestrated path, with no run fact and a marks placement', () => {
  // A synthetic sheet shaped like the failing run: one drawn band of five C1
  // tags at 6,237 mm centres, no run fact anywhere, and the model choosing
  // `marks` — the one placement kind that needs no run fact and therefore the
  // one it reaches for when the briefing says "PROJECT RUN: none was supplied".
  const doc = () => {
    const entities: Record<string, unknown>[] = [];
    let h = 0x3000;
    const next = (): string => (h++).toString(16).toUpperCase();
    for (const m of LAYOUT) {
      entities.push({
        type: 'text', text: 'C1', position: { x: m.x, y: 0 }, height: 100,
        style: { handle: next(), layer: '0' },
      });
    }
    entities.push({
      type: 'text', text: '8-12TOR', position: { x: 200, y: 500 }, height: 80,
      style: { handle: next(), layer: '0' },
    });
    return {
      name: 'band', sourceFile: 'band.dxf', entities,
      layers: new Map([['0', { name: '0' }]]), blocks: new Map(), unitScale: 1, extents: null,
    } as never;
  };

  const extract = () =>
    ({
      drawingName: 'band.dxf',
      marks: ['C1'],
      declared: [
        { name: 'C1', sizeText: '350x350', dimsMm: [350, 350], occurrences: 5, raw: 'C1 350x350', handles: [] },
      ],
      callouts: [{ raw: '8-12TOR', handle: 'A1', position: { x: 200, y: 500 }, diaMm: 12, count: 8 }],
      tables: [],
      notes: { notes: [] },
      unitScale: 1,
    }) as never;

  /** the mark occurrence ids the engine itself minted, not ids guessed here */
  const markIds = () =>
    buildEvidenceGraph(doc(), extract())
      .nodes.filter((n) => n.kind === 'mark' && n.metadata.mark === 'C1')
      .map((n) => n.id);

  const runIt = async (projectFacts: Record<string, unknown>) => {
    const ids = markIds();
    let first = true;
    const ask = vi.fn(async (args: { label: string }): Promise<Record<string, unknown>> => {
      if (args.label !== 'orchestrator') return { findings: [], done: true };
      if (first) {
        first = false;
        return {
          conclusions: [
            {
              kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail',
              barType: 'MAIN', evidenceIds: ['CALL-001'], reasoning: 'the C1 detail',
            },
            {
              kind: 'placement', memberId: 'MEM-01',
              placement: { kind: 'marks', markEvidenceIds: ids },
              evidenceIds: ids,
            },
          ],
          build: true,
        };
      }
      return { done: { why: 'built' } };
    });
    return runOrchestrator({
      doc: doc(), extract: extract(), projectFacts: projectFacts as never,
      ask: ask as never, rasterise: async () => `data:image/png;base64,${'A'.repeat(800)}`,
      now: () => 1, limits: { maxOrchestratorTurns: 4, specialistTurns: 1 },
    } as never);
  };

  it('the finished artifact carries the caveat, and is not reported complete', async () => {
    const out = await runIt({});
    expect(out.result.extentClaims.length).toBeGreaterThan(0);
    expect(out.result.warnings[0].message).toMatch(/COVERS ONLY WHAT IS DRAWN/);
    expect(out.result.status).not.toBe('complete');
  });

  it('the extent gate names the run, so the run cannot verify clean', async () => {
    const out = await runIt({});
    const f = out.result.verification.failures.filter((x) => x.gate === 'extent');
    expect(f.length).toBeGreaterThan(0);
    expect(f[0].field).toBe('run');
  });

  it('and none of it appears once the run IS supplied', async () => {
    // 31,185 mm of drawn band against a 31,185 mm run: the layout IS the job,
    // checked rather than assumed, and nothing is warned about
    const out = await runIt({ run: { mm: 24_948 + PITCH, saidAs: '31.2 m' } });
    expect(out.result.extentClaims).toEqual([]);
    expect(out.result.verification.failures.some((x) => x.gate === 'extent')).toBe(false);
  });
});
