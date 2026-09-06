// ============================================================
// computeCoverage — does the package account for the drawing?
//
// The OTHER failure mode, independent of drawing-splitter-gap.test.ts's
// bloat fix. Measured on the real, saved GAMCO package: 97.3% of entities
// were covered by at least one section, but a 1.9 m strip between the
// tie-beam sections REGION-08 and REGION-10 dropped seven entities on the
// `col`, `REIN` and `BEAM` layers — real reinforcement geometry, gone
// without either section reporting anything wrong, because neither section
// was wrong. The gap between two correct cuts had no owner.
// ============================================================
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDXF } from '../../src/cad/dxf/parse';
import { boundsFromCorners } from '../../src/cad/understanding/bounds';
import { computeCoverage, coverageSummaryLines } from '../../src/cad/understanding/coverage';
import { splitDrawing, type ChatReply, type ChatTransport } from '../../src/cad/understanding/orchestrator';
import { line, makeDoc, resetHandles, text } from '../helpers/cadDoc';
import { threeAreaDoc } from '../helpers/cadDoc';

describe('computeCoverage — synthetic', () => {
  it('reports full coverage when one box spans everything', () => {
    resetHandles();
    const doc = makeDoc({
      entities: [
        line({ x: 0, y: 0 }, { x: 100, y: 0 }, 'STEEL', 'A1'),
        text({ x: 0, y: 20 }, 'label', 8, 'TEXT', 'A2'),
      ],
    });
    const summary = computeCoverage(doc, [boundsFromCorners(-10, -10, 110, 30)]);
    expect(summary.measurableEntities).toBe(2);
    expect(summary.coveredEntities).toBe(2);
    expect(summary.uncoveredEntities).toBe(0);
    expect(summary.gaps).toEqual([]);
  });

  it('reports zero coverage when there are no sections at all', () => {
    resetHandles();
    const doc = makeDoc({ entities: [line({ x: 0, y: 0 }, { x: 100, y: 0 }, 'STEEL', 'A1')] });
    const summary = computeCoverage(doc, []);
    expect(summary.coveredEntities).toBe(0);
    expect(summary.uncoveredEntities).toBe(1);
    expect(summary.gaps).toMatchObject([{ layer: 'STEEL', count: 1, sampleHandles: ['A1'], sampleText: [] }]);
    // bounds is the union of every uncovered entity on the layer — here just the one line
    expect(summary.gaps[0].bounds).toEqual({ xMin: 0, yMin: 0, xMax: 100, yMax: 0 });
  });

  it('names the layer and gives sample handles/text for what fell outside', () => {
    resetHandles();
    const doc = makeDoc({
      entities: [
        line({ x: 0, y: 0 }, { x: 100, y: 0 }, 'STEEL', 'INSIDE1'),
        line({ x: 5000, y: 0 }, { x: 5100, y: 0 }, 'REIN', 'OUT1'),
        text({ x: 5000, y: 50 }, 'ORPHAN CAPTION', 8, 'TEXT', 'OUT2'),
      ],
    });
    const summary = computeCoverage(doc, [boundsFromCorners(-10, -10, 110, 10)]);
    expect(summary.coveredEntities).toBe(1);
    expect(summary.uncoveredEntities).toBe(2);
    const layers = summary.gaps.map((g) => g.layer).sort();
    expect(layers).toEqual(['REIN', 'TEXT']);
    const textGap = summary.gaps.find((g) => g.layer === 'TEXT')!;
    expect(textGap.sampleHandles).toContain('OUT2');
    expect(textGap.sampleText).toContain('ORPHAN CAPTION');
  });

  it('an entity covered by ANY one of several sections counts as covered', () => {
    resetHandles();
    const doc = makeDoc({ entities: [line({ x: 500, y: 0 }, { x: 600, y: 0 }, 'STEEL', 'A1')] });
    const summary = computeCoverage(doc, [
      boundsFromCorners(0, -10, 100, 10), // does not reach it
      boundsFromCorners(400, -10, 700, 10), // does
    ]);
    expect(summary.coveredEntities).toBe(1);
    expect(summary.uncoveredEntities).toBe(0);
  });

  it('sorts gaps largest layer first', () => {
    resetHandles();
    const far = { x: 9000, y: 0 };
    const doc = makeDoc({
      entities: [
        line({ x: 0, y: 0 }, { x: 10, y: 0 }, 'STEEL', 'IN1'),
        line(far, { x: 9100, y: 0 }, 'BEAM', 'B1'),
        line(far, { x: 9100, y: 10 }, 'BEAM', 'B2'),
        line(far, { x: 9100, y: 20 }, 'BEAM', 'B3'),
        text(far, 'x', 8, 'TEXT', 'T1'),
      ],
    });
    const summary = computeCoverage(doc, [boundsFromCorners(-10, -10, 20, 10)]);
    expect(summary.gaps[0].layer).toBe('BEAM');
    expect(summary.gaps[0].count).toBe(3);
  });

  it('coverageSummaryLines is empty when nothing is uncovered', () => {
    resetHandles();
    const doc = makeDoc({ entities: [line({ x: 0, y: 0 }, { x: 10, y: 0 }, 'STEEL', 'A1')] });
    const summary = computeCoverage(doc, [boundsFromCorners(-10, -10, 20, 10)]);
    expect(coverageSummaryLines(summary)).toEqual([]);
  });

  it('coverageSummaryLines names layers, percentage, and gives text examples', () => {
    resetHandles();
    const doc = makeDoc({
      entities: [
        line({ x: 0, y: 0 }, { x: 10, y: 0 }, 'STEEL', 'IN1'),
        text({ x: 9000, y: 0 }, 'LOST CAPTION', 8, 'TEXT', 'OUT1'),
      ],
    });
    const summary = computeCoverage(doc, [boundsFromCorners(-10, -10, 20, 10)]);
    const lines = coverageSummaryLines(summary);
    expect(lines[0]).toMatch(/1 of 2 entities \(50\.0%\) are in no section/);
    expect(lines[0]).toContain('TEXT (1)');
    expect(lines.some((l) => l.includes('LOST CAPTION'))).toBe(true);
  });
});

// ------------------------------------------------------------
// wired into a real split run
// ------------------------------------------------------------

describe('coverage is computed for every split run', () => {
  it('is present even when the package is otherwise perfectly clean', async () => {
    const doc = threeAreaDoc();
    const script: ChatReply[] = [
      {
        content: '',
        toolCalls: [
          {
            id: 'c1', type: 'function',
            function: { name: 'propose_section', arguments: JSON.stringify({ label: 'A', kind: 'detail', handles: ['AAA1', 'AAA2'] }) },
          },
        ],
      },
      { content: JSON.stringify({ summary: 'ok', relationships: [], unresolved: [] }), toolCalls: [] },
    ];
    let i = 0;
    const transport: ChatTransport = async () => script[Math.min(i++, script.length - 1)];
    const pkg = await splitDrawing(doc, { projectId: 'p1', skipPng: true, maxRounds: 4, transport });
    expect(pkg.coverage).toBeDefined();
    expect(pkg.coverage.measurableEntities).toBeGreaterThan(0);
    // this run cut only ONE small section out of a whole sheet — coverage
    // must correctly report the rest as uncovered, and unresolved must carry it
    expect(pkg.coverage.uncoveredEntities).toBeGreaterThan(0);
    expect(pkg.unresolved.some((u) => u.includes('are in no section'))).toBe(true);
  });

  it('reports zero uncovered when sections genuinely span everything measurable', async () => {
    resetHandles();
    const doc = makeDoc({
      entities: [
        line({ x: 0, y: 0 }, { x: 100, y: 0 }, 'STEEL', 'A1'),
        text({ x: 0, y: 20 }, 'label', 8, 'TEXT', 'A2'),
      ],
    });
    const script: ChatReply[] = [
      {
        content: '',
        toolCalls: [
          {
            id: 'c1', type: 'function',
            function: { name: 'propose_section', arguments: JSON.stringify({ label: 'Whole thing', kind: 'detail', x1: -50, y1: -50, x2: 200, y2: 100 }) },
          },
        ],
      },
      { content: JSON.stringify({ summary: 'ok', relationships: [], unresolved: [] }), toolCalls: [] },
    ];
    let i = 0;
    const transport: ChatTransport = async () => script[Math.min(i++, script.length - 1)];
    const pkg = await splitDrawing(doc, { projectId: 'p1', skipPng: true, maxRounds: 4, transport });
    expect(pkg.coverage.uncoveredEntities).toBe(0);
    expect(pkg.unresolved.some((u) => u.includes('are in no section'))).toBe(false);
  });
});

// ------------------------------------------------------------
// the real GAMCO drawing — a stable, committed fixture
//
// Two DIFFERENT live runs of this feature found two DIFFERENT real gaps on
// this same sheet: the first, by hand, found 7 entities on `col`/`REIN`/
// `BEAM` missing between two tie-beam sections; a later live run of the
// actual model found a different 16-entity `REIN` gap plus a small hook
// detail caught between SECTION AT 1-1 and SECTION AT 2-2. Both were real,
// both were on the drawing this whole feature exists to protect, and
// neither package survived — a live run's own output directory is
// deliberately ephemeral (git-ignored, overwritten by the next run), which
// is why THIS test depends on neither.
//
// What is committed instead is fixtures/understanding/gamco-package.json: a
// section layout produced deterministically (a scripted, non-LLM stand-in —
// see drawing-splitter-gamco.test.ts, same approach) from the real DXF, so
// it reproduces identically on every run. Its own coverage gap (an ASHADE
// hatching layer, benign) is smaller than either live finding, which is
// exactly what is being tested here: the MECHANISM, run against the actual
// 1335-entity sheet, not a specific historical number that a stochastic
// model run can never be relied on to reproduce twice.
// ------------------------------------------------------------

const FILE = 'GAMCO - BOUNDARY WALL DETAILS - LEVEL DIFFERENCE 900MM - 07.07.2026.dxf';
const DXF = join(process.cwd(), 'drawing example/BBS/BBS', FILE);
const FIXTURE = join(process.cwd(), 'fixtures/understanding/gamco-package.json');
const haveDxf = existsSync(DXF);
const haveFixture = existsSync(FIXTURE);

describe.skipIf(!haveDxf || !haveFixture)('coverage against the real, committed GAMCO fixture', () => {
  it('measures well over a thousand real entities and finds the fixture is nearly fully covered', () => {
    const doc = parseDXF(readFileSync(DXF, 'utf8'), FILE);
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const boxes = fixture.sections.map((s: { bounds: unknown }) => s.bounds);

    const summary = computeCoverage(doc, boxes);
    expect(summary.measurableEntities).toBeGreaterThan(1000);
    const pct = (summary.coveredEntities / summary.measurableEntities) * 100;
    expect(pct).toBeGreaterThan(95);
  });

  it('recomputing from the fixture reproduces the SAME coverage the fixture itself recorded', () => {
    // the fixture carries the coverage its own generating run computed —
    // recomputing it fresh from the same sections must agree exactly,
    // proving the check is deterministic and not order- or cache-sensitive
    const doc = parseDXF(readFileSync(DXF, 'utf8'), FILE);
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const boxes = fixture.sections.map((s: { bounds: unknown }) => s.bounds);
    const summary = computeCoverage(doc, boxes);
    expect(summary.measurableEntities).toBe(fixture.coverage.measurableEntities);
    expect(summary.coveredEntities).toBe(fixture.coverage.coveredEntities);
    expect(summary.gaps).toEqual(fixture.coverage.gaps);
  });

  it('names the uncovered layer with sample handles, on real drawing data', () => {
    const doc = parseDXF(readFileSync(DXF, 'utf8'), FILE);
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const boxes = fixture.sections.map((s: { bounds: unknown }) => s.bounds);
    const summary = computeCoverage(doc, boxes);
    expect(summary.gaps.length).toBeGreaterThan(0);
    for (const g of summary.gaps) {
      expect(g.sampleHandles.length).toBeGreaterThan(0);
      expect(g.count).toBeGreaterThan(0);
    }
    const lines = coverageSummaryLines(summary);
    expect(lines[0]).toMatch(/entities.*are in no section/);
  });

  it('removing the largest section widens the measured gap — proves the check is live geometry, not a cached number', () => {
    const doc = parseDXF(readFileSync(DXF, 'utf8'), FILE);
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    type Sec = { bounds: { xMin: number; yMin: number; xMax: number; yMax: number }; entityCount: number };
    const allSections: Sec[] = fixture.sections;
    const biggest = allSections.reduce((a, b) => (b.entityCount > a.entityCount ? b : a));
    const fewerBoxes = allSections.filter((s) => s !== biggest).map((s) => s.bounds);
    const allBoxes = allSections.map((s) => s.bounds);

    const full = computeCoverage(doc, allBoxes);
    const reduced = computeCoverage(doc, fewerBoxes);
    expect(reduced.uncoveredEntities).toBeGreaterThan(full.uncoveredEntities);
  });
});
