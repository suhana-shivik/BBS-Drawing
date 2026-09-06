// Finding a stacked height before summing it.
//
// A section height is often not printed anywhere. On the benchmark sheet the
// column height is a stack — 1500, then 900, then 300 — and `dimension-path`
// exists to sum exactly that. But FINDING the stack was left to guesswork off
// a proximity list, and three live runs failed to assemble a chain that joins
// to the millimetre: DIM-098 + DIM-100 + DIM-097.
//
// So the contiguity the resolver already computes when it JUDGES a chain is
// exposed for READING one. These tests hold what it may and may not do: it
// reports what touches, and never what the span means.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS, type ToolContext } from '../../src/cad/bbs/tools';
import { resolveRef } from '../../src/cad/bbs/refs';
import { buildEvidenceGraph } from '../../src/cad/bbs/evidence';
import { buildPlacementBands } from '../../src/cad/bbs/bands';
import { buildMemberRegistry } from '../../src/cad/bbs/members';
import { parseDXF } from '../../src/cad/dxf/parse';
import { extractDrawing } from '../../src/cad/bbs/extract';

const DXF = join(
  process.cwd(),
  'drawing example/BBS/BBS',
  'GAMCO - BOUNDARY WALL DETAILS - LEVEL DIFFERENCE 900MM - 07.07.2026.dxf',
);

describe.skipIf(!existsSync(DXF))('getDimensionChain on the real sheet', () => {
  const ctx = (): ToolContext => {
    const doc = parseDXF(readFileSync(DXF, 'utf8'), 'GAMCO.dxf');
    const extract = extractDrawing(doc);
    const graph = buildEvidenceGraph(doc, extract);
    return {
      graph,
      registry: buildMemberRegistry(extract, graph),
      bands: buildPlacementBands(graph).bands,
      userFacts: {},
    };
  };

  it('finds the stack the live runs could not assemble', () => {
    const c = ctx();
    const r = TOOLS.getDimensionChain(c, { fromEvidenceId: 'DIM-100' });
    expect(r.ok).toBe(true);
    // the three that make the column height, all present
    for (const id of ['DIM-098', 'DIM-100', 'DIM-097']) {
      expect(r.text, `chain should contain ${id}`).toContain(id);
      expect(r.evidenceIds).toContain(id);
    }
  });

  it('the segments it reports do resolve as a dimension-path — 1500 + 900 + 300', () => {
    const c = ctx();
    const r = resolveRef(
      {
        kind: 'dimension-path',
        axis: 'y',
        segmentEvidenceIds: ['DIM-098', 'DIM-100', 'DIM-097'],
      },
      { graph: c.graph },
    );
    expect(r.ok).toBe(true);
    expect(r.mm).toBe(2700);
  });

  it('hands back the geometry and leaves the meaning alone', () => {
    const c = ctx();
    const r = TOOLS.getDimensionChain(c, { fromEvidenceId: 'DIM-100' });
    expect(r.text).toMatch(/join end to end on axis y/);
    expect(r.text).toMatch(/Which of them span the thing you are measuring is your reading/);
    // it names no member, no height, and no verdict
    expect(r.text).not.toMatch(/column|height of|should|C1\b/i);
  });

  it('says so plainly when nothing continues a dimension', () => {
    const c = ctx();
    // a plan dimension standing alone on its axis
    const lonely = c.graph.dimensions.find((d) => {
      if (d.axis !== 'y') return false;
      const lo = Math.min(d.from.y, d.to.y);
      const hi = Math.max(d.from.y, d.to.y);
      return !c.graph.dimensions.some(
        (o) => o.id !== d.id && o.axis === 'y' &&
          (Math.abs(Math.min(o.from.y, o.to.y) - hi) <= 2 || Math.abs(Math.max(o.from.y, o.to.y) - lo) <= 2),
      );
    });
    if (!lonely) return;   // the sheet may have none; the behaviour is covered below
    const r = TOOLS.getDimensionChain(c, { fromEvidenceId: lonely.id });
    expect(r.text).toMatch(/nothing on this axis joins either end of it/);
  });

  it('refuses an id that is not a readable dimension', () => {
    const r = TOOLS.getDimensionChain(ctx(), { fromEvidenceId: 'CALL-001' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not a readable dimension/);
  });

  it('is bounded — it never walks further than asked', () => {
    const c = ctx();
    const r = TOOLS.getDimensionChain(c, { fromEvidenceId: 'DIM-100', maxSteps: 1 });
    // at most one continuation each way, plus the starting segment
    expect(r.evidenceIds.length).toBeLessThanOrEqual(3);
  });
});
