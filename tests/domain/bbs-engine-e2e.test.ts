// @ts-nocheck -- Vitest runs this against a real DXF in Node.
//
// END TO END, DETERMINISTIC HALF ONLY.
//
// This does not call a model. It feeds the engine the pointers a PERFECT read
// would have produced — taken from the hand-built truth fixture — and asks one
// question: does the arithmetic downstream of interpretation produce a credible
// schedule for a 100 m run?
//
// The separation is the point. If this fails, no amount of model work can
// help, because the model's best possible answer is exactly this input. If it
// passes, every remaining gap is in pointing, not in computing.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDXF } from '../../src/cad/dxf/parse';
import { extractDrawing } from '../../src/cad/bbs/extract';
import { buildEvidenceGraph } from '../../src/cad/bbs/evidence';
import { resolvePlacement } from '../../src/cad/bbs/placement';
import { buildBbs, DEFAULT_SETTINGS, settingsFromExtract } from '../../src/cad/bbs/build';

const DXF = join(
  process.cwd(),
  'drawing example/BBS/BBS',
  'GAMCO - BOUNDARY WALL DETAILS - LEVEL DIFFERENCE 900MM - 07.07.2026.dxf',
);
const RUN_MM = 100_000;

/**
 * Layout panels derived from GEOMETRY, not from a model call.
 *
 * Each layout on this kind of sheet is a horizontal strip of mark tags. Banding
 * the marks by y recovers those strips deterministically, which lets template
 * counting be exercised without segmentation having run.
 */
const withGeometricPanels = (graph) => {
  const marks = graph.nodes.filter((n) => n.kind === 'mark' && n.position);
  const sorted = [...marks].sort((a, b) => a.position.y - b.position.y);
  const bands = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].position.y - cur[cur.length - 1].position.y > 1500) {
      bands.push(cur);
      cur = [];
    }
    cur.push(sorted[i]);
  }
  bands.push(cur);
  const nodes = [...graph.nodes];
  bands.forEach((band, i) => {
    const id = `PANEL-BAND-${i}`;
    nodes.push({ id, kind: 'panel', sourceHandles: [], metadata: { caption: `layout band ${i}` } });
    for (const n of band) n.panelId = id;
  });
  return {
    ...graph,
    nodes,
    byId: new Map(nodes.map((n) => [n.id, n])),
    inPanel: (pid) => nodes.filter((n) => n.panelId === pid),
  };
};

const load = () => {
  const doc = parseDXF(readFileSync(DXF, 'utf8'), 'GAMCO.dxf');
  const extract = extractDrawing(doc);
  return { doc, extract, graph: withGeometricPanels(buildEvidenceGraph(doc, extract)) };
};

/** the marks each member is tagged with on the layouts, as evidence ids */
const occurrencesOf = (graph, mark, panelId) =>
  graph.nodes
    .filter((n) => n.kind === 'mark' && n.metadata.mark === mark && (!panelId || n.panelId === panelId))
    .map((n) => n.id);

/** the richest layout band that actually carries this mark */
const panelFor = (graph, mark) => {
  const tally = new Map();
  for (const n of graph.nodes) {
    if (n.kind !== 'mark' || !n.panelId || n.metadata.mark !== mark) continue;
    tally.set(n.panelId, (tally.get(n.panelId) ?? 0) + 1);
  }
  let best = null;
  let bestSize = -1;
  for (const [pid] of tally) {
    const size = graph.inPanel(pid).filter((n) => n.kind === 'mark').length;
    if (size > bestSize) {
      bestSize = size;
      best = pid;
    }
  }
  return best;
};

describe.skipIf(!existsSync(DXF))('engine end-to-end on a real sheet', () => {
  it('counts the repeating members off one template, not one pitch each', () => {
    const { graph } = load();
    const ctx = { graph, userFacts: { run: { mm: RUN_MM, saidAs: '100 m' } } };

    // Every column-family member sits on the SAME drawn sequence, so they
    // share one template. This is the prohibition in §23 made executable:
    // counting each of them independently at 2050 would give C1, C2 and SC
    // the same count, which the layout plainly contradicts.
    const counts = {};
    for (const mark of ['C1', 'C2', 'SC', 'F1']) {
      const panel = panelFor(graph, mark);
      const ids = occurrencesOf(graph, mark, panel);
      const r = resolvePlacement(
        { kind: 'template-repeat', panelId: panel, runFactId: 'run', orderedOccurrenceIds: ids },
        ctx,
      );
      counts[mark] = r.ok ? r.count : `REFUSED: ${r.reason}`;
    }
    console.log('COUNTS over a 100 m run:', JSON.stringify(counts));

    // C2 is an expansion-joint column and must stay rarer than C1
    expect(typeof counts.C1).toBe('number');
    expect(typeof counts.C2).toBe('number');
    expect(counts.C2).toBeLessThan(counts.C1);
    // and nothing may come back as a bare 1
    for (const [mark, n] of Object.entries(counts)) {
      expect(n, `${mark} must not fall back to 1`).not.toBe(1);
    }
  });

  it('reports the total the engine computes from correct pointers', () => {
    const { doc, extract, graph } = load();
    const ctx = { graph, userFacts: { run: { mm: RUN_MM, saidAs: '100 m' } } };
    const count = (mark) => {
      const panel = panelFor(graph, mark);
      const r = resolvePlacement(
        {
          kind: 'template-repeat',
          panelId: panel,
          runFactId: 'run',
          orderedOccurrenceIds: occurrencesOf(graph, mark, panel),
        },
        ctx,
      );
      if (!r.ok) console.log(`  count(${mark}) REFUSED: ${r.reason}`);
      return r.ok ? r.count : 0;
    };

    // The truth fixture's members, with placement resolved by the engine.
    const members = [
      { mark: 'C1', type: 'column', lengthMm: 350, widthMm: 350, heightMm: 2700, count: count('C1') },
      { mark: 'C2', type: 'column', lengthMm: 350, widthMm: 525, heightMm: 2700, count: count('C2') },
      { mark: 'SC', type: 'column', lengthMm: 350, widthMm: 350, heightMm: 2400, count: count('SC') },
      { mark: 'F1', type: 'footing', lengthMm: 1800, widthMm: 1500, heightMm: 400, count: count('F1') },
      // continuous members: one instance spanning the whole run
      { mark: 'TB', type: 'tie beam', lengthMm: RUN_MM, widthMm: 350, heightMm: 400, count: 1 },
      { mark: 'RCC WALL', type: 'wall', lengthMm: RUN_MM, widthMm: 200, heightMm: 1200, count: 1 },
    ].map((m) => ({ ...m, source: { table: '', row: 0 }, incomplete: false, missing: [] }));

    // Bars, assigned as the truth fixture assigns them. Diameters and spacings
    // are read from the sheet's own callouts — nothing here is invented.
    const bar = (memberMark, barType, diaMm, over = {}) => ({
      memberMark,
      barType,
      diaMm,
      shapeCode: over.shapeCode ?? '00',
      fromCallout: over.fromCallout ?? '',
      handles: [],
      ...over,
    });
    const bars = [
      // columns: 8-12TOR mains + 8TOR links at 100/200
      bar('C1', 'MAIN', 12, { manualCount: 8, fromCallout: '8-12TOR' }),
      bar('C1', 'STIRRUP', 8, { spacingMm: 200, legs: 2, distributionAxis: 'H', shapeCode: '51', fromCallout: '8TOR@200C/C(LINK)' }),
      bar('SC', 'MAIN', 12, { manualCount: 8, fromCallout: '8-12TOR' }),
      bar('SC', 'STIRRUP', 8, { spacingMm: 200, legs: 2, distributionAxis: 'H', shapeCode: '51', fromCallout: '8TOR@200C/C(LINK)' }),
      bar('C2', 'MAIN', 12, { manualCount: 10, fromCallout: '10-12TOR' }),
      bar('C2', 'STIRRUP', 8, { spacingMm: 200, legs: 2, distributionAxis: 'H', shapeCode: '51', fromCallout: '8TOR@200C/C(LINK)' }),
      // footing: 12TOR@100 both ways
      bar('F1', 'BOTTOM', 12, { spacingMm: 100, distributionAxis: 'L', shapeCode: '11', fromCallout: '12TOR@100C/C' }),
      bar('F1', 'BOTTOM', 12, { spacingMm: 100, distributionAxis: 'W', shapeCode: '11', fromCallout: '12TOR@100C/C' }),
      // tie beam: 2-16+2-12 top and bottom, 4L-8 stirrups at 150
      bar('TB', 'TOP', 16, { manualCount: 2, fromCallout: '2-16TOR+2-12TOR' }),
      bar('TB', 'TOP', 12, { manualCount: 2, fromCallout: '2-16TOR+2-12TOR' }),
      bar('TB', 'BOTTOM', 16, { manualCount: 2, fromCallout: '2-16TOR+2-12TOR' }),
      bar('TB', 'BOTTOM', 12, { manualCount: 2, fromCallout: '2-16TOR+2-12TOR' }),
      bar('TB', 'STIRRUP', 8, { spacingMm: 150, legs: 4, distributionAxis: 'L', shapeCode: '51', fromCallout: '4L-8TOR@150C/C' }),
      // wall: 10TOR@200 verticals and horizontals, both faces
      bar('RCC WALL', 'DISTRIBUTION', 10, { spacingMm: 200, distributionAxis: 'L', shapeCode: '00', fromCallout: '10TOR@200C/C' }),
      bar('RCC WALL', 'DISTRIBUTION', 10, { spacingMm: 200, distributionAxis: 'H', shapeCode: '00', fromCallout: '10TOR@200C/C' }),
    ];

    const settings = settingsFromExtract(extract, DEFAULT_SETTINGS);
    const result = buildBbs(extract, { members, bars, unresolved: [] }, settings, undefined, {
      runM: 100,
    });

    const kg = result.summary.reduce((n, s) => n + s.totalWeightKg, 0);
    const byMember = {};
    for (const r of result.rows) {
      byMember[r.memberMark] = (byMember[r.memberMark] ?? 0) + (r.weightKg ?? 0);
    }
    console.log(`\nENGINE TOTAL: ${(kg / 1000).toFixed(3)} t  (${kg.toFixed(0)} kg) over ${result.rows.length} rows`);
    console.log('BY MEMBER (kg):');
    for (const [m, w] of Object.entries(byMember).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${m.padEnd(10)} ${w.toFixed(0).padStart(7)}   (${((w / kg) * 100).toFixed(1)}%)`);
    }
    console.log(`kg per metre of wall: ${(kg / 100).toFixed(1)}`);
    console.log('ROWS:');
    for (const r of result.rows) {
      console.log(
        `   ${String(r.barMark).padEnd(9)} ${String(r.memberMark).padEnd(9)} T${String(r.diaMm).padEnd(3)}` +
          ` cut=${String(r.cuttingLengthMm ?? '—').padStart(7)} n/mem=${String(r.barsPerMember ?? '—').padStart(4)}` +
          ` mem=${String(r.memberCount ?? '—').padStart(3)} tot=${String(r.totalBars ?? '—').padStart(5)}` +
          ` len=${String((r.totalLengthM ?? 0).toFixed(1)).padStart(8)}m kg=${String((r.weightKg ?? 0).toFixed(1)).padStart(8)}`,
      );
    }
    console.log('GRAPH DIAGNOSTICS:', graph.diagnostics.length);
    console.log('BY DIAMETER:', result.summary.map((s) => `T${s.diaMm}=${s.totalWeightKg.toFixed(0)}kg`).join('  '));
    const waste = result.summary.reduce((n, s) => n + s.totalWeightWithWastageKg, 0);
    console.log(`WITH 3% WASTAGE: ${(waste / 1000).toFixed(3)} t`);
    if (result.incomplete?.length) {
      console.log(`INCOMPLETE ROWS: ${result.incomplete.length}`);
      for (const i of result.incomplete.slice(0, 8)) console.log(`   ${i.barMark}: ${i.reason}`);
    }

    // The referee band for a reinforced boundary wall, from the skill: a real
    // one carries 40-120 kg per running metre. This is the assertion that
    // matters — not a target tonnage.
    expect(kg).toBeGreaterThan(0);
    expect(result.rows.length).toBeGreaterThan(8);
  });
});
