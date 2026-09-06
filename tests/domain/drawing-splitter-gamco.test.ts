// @ts-nocheck -- Vitest runs this against the real drawing in Node; the
// browser app does not include @types/node in its production surface.
// ============================================================
// The splitter on a REAL sheet — §24.
//
// The GAMCO boundary-wall drawing: 1 MB of DXF, a dozen separate drawings on
// one page. Nothing here hardcodes a section list; the stand-in orchestrator
// below decides what to cut from the sheet's own text, exactly as the real
// model will, and every assertion is about the PLATFORM doing what it was
// asked rather than about which regions came out.
//
// The stand-in is a TEST DOUBLE and is labelled as one. It exists so the
// cutting machinery — handle resolution, bounds measurement, entity
// selection, DXF writing, round-trip parsing — is proven on real geometry
// before a paid model is pointed at it (§26).
//
// Artifacts land in `split-output/gamco/` for the visual inspection §25 asks
// for, which is the one check no assertion here replaces.
// ============================================================
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { parseDXF } from '../../src/cad/dxf/parse';
import { splitDrawing, textIndex, type ChatReply, type ChatTransport } from '../../src/cad/understanding/orchestrator';
import { sectionFileTree } from '../../src/cad/understanding/store';
import { entitiesInBounds } from '../../src/cad/understanding/bounds';
import type { CadDocument } from '../../src/cad/types';
import type { DrawingUnderstandingPackage } from '../../src/cad/understanding/types';

const FILE = 'GAMCO - BOUNDARY WALL DETAILS - LEVEL DIFFERENCE 900MM - 07.07.2026.dxf';
const DXF = join(process.cwd(), 'drawing example/BBS/BBS', FILE);
const OUT = join(process.cwd(), 'split-output/gamco');
const have = existsSync(DXF);

/**
 * A STAND-IN for the orchestrator model.
 *
 * It clusters the sheet's biggest texts and proposes a section per cluster.
 * That is a crude decomposition and it is meant to be: its job is to drive the
 * real machinery with plausible, drawing-derived requests, not to be good at
 * reading drawings. The real model replaces it wholesale — nothing downstream
 * of `propose_section` knows or cares which one called it.
 */
function standInTransport(doc: CadDocument): ChatTransport {
  const texts = textIndex(doc);
  const tall = [...texts].sort((a, b) => b.height - a.height);
  const titles = tall.filter((t) => t.height >= (tall[0]?.height ?? 1) * 0.55).slice(0, 12);

  // one cluster per title: every text within a radius scaled to the title size
  const proposals = titles.map((title, i) => {
    const radius = Math.max(title.height * 60, 2000);
    const handles = texts
      .filter((t) => Math.hypot(t.x - title.x, t.y - title.y) <= radius)
      .map((t) => t.handle)
      .slice(0, 400);
    return {
      id: `c${i}`,
      type: 'function' as const,
      function: {
        name: 'propose_section',
        arguments: JSON.stringify({
          label: title.text.slice(0, 60),
          kind: /NOTE/i.test(title.text)
            ? 'note'
            : /SCHEDULE|TABLE/i.test(title.text)
              ? 'schedule'
              : /SECTION/i.test(title.text)
                ? 'section'
                : /LAYOUT|PLAN/i.test(title.text)
                  ? 'layout'
                  : 'detail',
          handles,
          confidence: 0.5,
          evidenceIds: [title.handle],
        }),
      },
    };
  });

  const script: ChatReply[] = [
    { content: '', toolCalls: proposals },
    {
      content: JSON.stringify({
        summary: `A stand-in decomposition of ${doc.sourceFile} into ${proposals.length} regions.`,
        relationships: [],
        unresolved: [],
      }),
      toolCalls: [],
    },
  ];
  let i = 0;
  return async () => script[Math.min(i++, script.length - 1)];
}

describe.skipIf(!have)('the splitter on the real GAMCO sheet', () => {
  let doc: CadDocument;
  let pkg: DrawingUnderstandingPackage;

  beforeAll(async () => {
    doc = parseDXF(readFileSync(DXF, 'utf8'), FILE);
    pkg = await splitDrawing(doc, {
      projectId: 'gamco',
      skipPng: true, // no rasteriser in Node; §25 is the visual check
      maxRounds: 6,
      transport: standInTransport(doc),
    });

    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    for (const file of sectionFileTree(pkg)) {
      const path = join(OUT, file.path);
      mkdirSync(join(path, '..'), { recursive: true });
      if (file.text !== undefined) writeFileSync(path, file.text, 'utf8');
    }

    // the §24 report, written where a person can read it
    const report = [
      `SOURCE     ${doc.sourceFile}`,
      `HASH       ${pkg.sourceDrawingHash}`,
      `ENTITIES   ${doc.entities.length}`,
      `EXTENTS    ${JSON.stringify(pkg.sheetExtents)}`,
      `SECTIONS   ${pkg.sections.length}`,
      '',
      ...pkg.sections.map((s) => {
        const b = s.bounds;
        return [
          `${s.sectionId}  ${s.label}`,
          `  kind        ${s.kind}`,
          `  bounds mm   x ${b.xMin.toFixed(0)}..${b.xMax.toFixed(0)}  y ${b.yMin.toFixed(0)}..${b.yMax.toFixed(0)}`,
          `  entities    ${s.entityCount}`,
          `  dxf         sections/${s.sectionId}/section.dxf`,
          `  png         ${s.png ? `sections/${s.sectionId}/section.png` : '(none — headless run)'}`,
          `  evidence    ${s.evidenceIds.join(', ') || '—'}`,
          `  hints       ${s.memberHints.map((h) => h.mark).join(', ') || '—'}`,
          `  confidence  ${s.confidence}`,
          `  notes       ${s.limitations.map((l) => `${l.message} (x${l.count})`).join('; ') || '—'}`,
        ].join('\n');
      }),
    ].join('\n');
    writeFileSync(join(OUT, 'REPORT.txt'), report, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`\n${report}\n`);
  }, 120_000);

  it('parses the real drawing', () => {
    expect(doc.entities.length).toBeGreaterThan(1000);
    expect(pkg.sheetExtents).not.toBeNull();
  });

  it('produces sections the orchestrator chose, with no hardcoded list', () => {
    expect(pkg.sections.length).toBeGreaterThan(2);
    // the labels come from the sheet, so they must not be a fixed set
    const labels = pkg.sections.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('cuts real CAD geometry into every section', () => {
    for (const s of pkg.sections) {
      expect(s.entityCount, `${s.sectionId} "${s.label}" is empty`).toBeGreaterThan(0);
      expect(s.dxf).toContain('ENTITIES');
      expect(s.dxf).not.toMatch(/base64|OLE2FRAME/);
    }
  });

  it('every section DXF parses back successfully', () => {
    for (const s of pkg.sections) {
      const reparsed = parseDXF(s.dxf, `${s.sectionId}.dxf`);
      expect(reparsed.entities.length, `${s.sectionId} lost entities on re-parse`).toBe(s.entityCount);
      expect(reparsed.extents, `${s.sectionId} has no extents`).not.toBeNull();
    }
  });

  it('keeps every section inside the sheet, with real area', () => {
    const sheet = pkg.sheetExtents!;
    for (const s of pkg.sections) {
      expect(s.bounds.xMin).toBeGreaterThanOrEqual(sheet.xMin - 1);
      expect(s.bounds.xMax).toBeLessThanOrEqual(sheet.xMax + 1);
      expect(s.bounds.xMax - s.bounds.xMin, `${s.sectionId} has no width`).toBeGreaterThan(0);
      expect(s.bounds.yMax - s.bounds.yMin, `${s.sectionId} has no height`).toBeGreaterThan(0);
    }
  });

  it('preserves original coordinates — a section is not moved to the origin', () => {
    const s = pkg.sections.find((x) => x.bounds.xMin > 1000) ?? pkg.sections[0];
    const reparsed = parseDXF(s.dxf, 'x.dxf');
    const k = doc.unitScale || 1;
    // at least one entity sits where it sat on the original sheet
    const anyFar = reparsed.entities.some((e) => {
      const b = e.type === 'line' ? e.a : e.type === 'text' ? e.position : null;
      return b !== null && b.x * k >= s.bounds.xMin - 1 && b.x * k <= s.bounds.xMax + 1;
    });
    expect(anyFar).toBe(true);
  });

  it('preserves layers into the section DXFs', () => {
    const s = pkg.sections.reduce((a, b) => (a.entityCount > b.entityCount ? a : b));
    const reparsed = parseDXF(s.dxf, 'x.dxf');
    const layers = new Set(reparsed.entities.map((e) => e.style.layer));
    expect(layers.size).toBeGreaterThan(1);
    for (const name of layers) expect(reparsed.layers.has(name)).toBe(true);
  });

  it('is reproducible: re-cutting from the stored bounds selects the same entities', () => {
    for (const s of pkg.sections.slice(0, 5)) {
      const recut = entitiesInBounds(doc, s.bounds);
      expect(recut.handles, `${s.sectionId} is not reproducible from its own bounds`).toEqual(
        s.entityIds,
      );
    }
  });

  it('counts DXF records, which a hatch makes more numerous than source entities', () => {
    // one HATCH becomes one polyline per boundary loop, so entityCount >=
    // entityIds.length. The two are different questions and this sheet is
    // full of hatches, which is what made the difference show up at all.
    const hatched = pkg.sections.filter((s) => s.entityCount > s.entityIds.length);
    expect(hatched.length).toBeGreaterThan(0);
    for (const s of pkg.sections) {
      expect(s.entityCount).toBeGreaterThanOrEqual(s.entityIds.length);
    }
  });

  it('writes every section to disk as dxf + metadata', () => {
    for (const s of pkg.sections) {
      expect(existsSync(join(OUT, 'sections', s.sectionId, 'section.dxf'))).toBe(true);
      expect(existsSync(join(OUT, 'sections', s.sectionId, 'metadata.json'))).toBe(true);
    }
    expect(existsSync(join(OUT, 'drawing-understanding.json'))).toBe(true);
  });

  it('records every request the orchestrator made', () => {
    expect(pkg.requests.length).toBeGreaterThanOrEqual(pkg.sections.length);
    for (const r of pkg.requests) {
      expect(r.step).toBeGreaterThan(0);
      expect(r.timestamp).toBeGreaterThan(0);
      expect(r.tool).toBeTruthy();
    }
  });
});
