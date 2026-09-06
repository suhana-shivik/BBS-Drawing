// ============================================================
// The independent drawing splitter.
//
// Every test here runs the REAL orchestrator loop against a SCRIPTED model.
// The transport is injected, so the whole path — tool dispatch, handle
// resolution, bounds measurement, entity selection, DXF writing, dedup, the
// audit trail — is exercised without a paid call. §26 forbids a live run
// before this passes, and a loop that can only be driven by a real endpoint
// could not be proven at all.
// ============================================================
import { describe, expect, it } from 'vitest';
import { parseDXF } from '../../src/cad/dxf/parse';
import {
  boundsForHandles,
  boundsFromCorners,
  boundsKey,
  entitiesInBounds,
  entityBoundsMm,
} from '../../src/cad/understanding/bounds';
import { writeSectionDxf } from '../../src/cad/understanding/dxfWrite';
import { exportSection } from '../../src/cad/understanding/section';
import { splitDrawing, type ChatReply, type ChatTransport } from '../../src/cad/understanding/orchestrator';
import { hashDocument } from '../../src/cad/understanding/hash';
import { sectionFileTree } from '../../src/cad/understanding/store';
import { packageBriefing, packagePanels } from '../../src/cad/understanding/consume';
import { readSectionsIndex, sectionsIndex } from '../../src/cad/understanding/file';
import { blockDoc, makeDoc, text, threeAreaDoc } from '../helpers/cadDoc';

// ------------------------------------------------------------
// a scripted model
// ------------------------------------------------------------

let callSeq = 0;
function call(name: string, args: Record<string, unknown>): ChatReply['toolCalls'][number] {
  callSeq += 1;
  return { id: `call-${callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** Replies handed out in order; the last one repeats if the loop runs on. */
function scripted(replies: ChatReply[]): { transport: ChatTransport; turns: () => number } {
  let i = 0;
  const transport: ChatTransport = async () => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return reply;
  };
  return { transport, turns: () => i };
}

const done = (summary = 'three areas'): ChatReply => ({
  content: JSON.stringify({ summary, relationships: [], unresolved: [] }),
  toolCalls: [],
});

/** No rasteriser in Node — every run here is DXF-only unless told otherwise. */
const base = { projectId: 'p1', skipPng: true, maxRounds: 8 };

// ------------------------------------------------------------
// 1–5  the splitter is independent, and the AI drives it
// ------------------------------------------------------------

describe('the splitter is its own capability', () => {
  it('runs from a document alone — no BBS, no schedule, no bill', async () => {
    const doc = threeAreaDoc();
    const { transport } = scripted([
      { content: '', toolCalls: [call('propose_section', { label: 'SECTION AT 1-1', kind: 'detail', handles: ['AAA1', 'AAA2'] })] },
      done(),
    ]);
    const pkg = await splitDrawing(doc, { ...base, transport });
    expect(pkg.sections).toHaveLength(1);
    expect(pkg.documentId).toBe(doc.id);
  });

  it('never reaches into the BBS engine', async () => {
    // the module graph is the assertion: understanding/ must not import bbs/
    const files = import.meta.glob('../../src/cad/understanding/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(5);
    for (const [path, src] of Object.entries(files)) {
      expect(src, `${path} imports from bbs/`).not.toMatch(/from '\.\.\/bbs\//);
    }
  });

  it('gives the orchestrator the whole sheet and its texts up front', async () => {
    const doc = threeAreaDoc();
    let firstUser = '';
    const transport: ChatTransport = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      firstUser = String(user?.content ?? '');
      return done();
    };
    await splitDrawing(doc, { ...base, transport });
    expect(firstUser).toContain('SHEET EXTENTS');
    expect(firstUser).toContain('SECTION AT 1-1');
    expect(firstUser).toContain('GENERAL NOTES');
    // handles must be offered — pointing is the whole contract
    expect(firstUser).toContain('AAA1');
  });

  it('lets the orchestrator investigate a region, then ask for a different one', async () => {
    const doc = threeAreaDoc();
    const seen: string[] = [];
    const { transport } = scripted([
      { content: '', toolCalls: [call('look_at', { x1: 0, y1: 0, x2: 50, y2: 50 })] },
      { content: '', toolCalls: [call('find_text', { pattern: 'LAYOUT' })] },
      { content: '', toolCalls: [call('propose_section', { label: 'FOOTING LAYOUT', kind: 'layout', handles: ['BBB1', 'BBB2'] })] },
      done(),
    ]);
    const pkg = await splitDrawing(doc, {
      ...base,
      transport,
      onEvent: (e) => seen.push(e.ask),
    });
    expect(seen.some((s) => s.startsWith('look_at'))).toBe(true);
    expect(seen.some((s) => s.startsWith('find_text'))).toBe(true);
    expect(pkg.sections).toHaveLength(1);
    expect(pkg.sections[0].label).toBe('FOOTING LAYOUT');
  });

  it('cuts several independent regions in one run', async () => {
    const doc = threeAreaDoc();
    const { transport } = scripted([
      {
        content: '',
        toolCalls: [
          call('propose_section', { label: 'SECTION AT 1-1', kind: 'detail', handles: ['AAA1', 'AAA2'] }),
          call('propose_section', { label: 'FOOTING LAYOUT', kind: 'layout', handles: ['BBB1', 'BBB2'] }),
          call('propose_section', { label: 'GENERAL NOTES', kind: 'note', handles: ['CCC1', 'CCC2', 'CCC3'] }),
        ],
      },
      done(),
    ]);
    const pkg = await splitDrawing(doc, { ...base, transport });
    expect(pkg.sections.map((s) => s.sectionId)).toEqual(['REGION-01', 'REGION-02', 'REGION-03']);
    expect(pkg.sections.map((s) => s.kind)).toEqual(['detail', 'layout', 'note']);
  });

  it('takes the section list from the model, not from a hardcoded vocabulary', async () => {
    const doc = threeAreaDoc();
    const { transport } = scripted([
      { content: '', toolCalls: [call('propose_section', { label: 'the squiggly bit', kind: 'whatever-i-like', handles: ['AAA1', 'AAA2'] })] },
      done(),
    ]);
    const pkg = await splitDrawing(doc, { ...base, transport });
    expect(pkg.sections[0].kind).toBe('whatever-i-like');
    expect(pkg.sections[0].label).toBe('the squiggly bit');
  });
});

// ------------------------------------------------------------
// 6–8  one box, two outputs
// ------------------------------------------------------------

describe('PNG and DXF describe the same region', () => {
  it('renders the PNG from the SAME bounds the DXF was cut with', async () => {
    const doc = threeAreaDoc();
    const rendered: { xMin: number; xMax: number; yMin: number; yMax: number }[] = [];
    const section = await exportSection(
      doc,
      boundsFromCorners(0, 0, 200, 200),
      { sectionId: 'REGION-01', label: 'L', kind: 'detail', sourceDrawingHash: 'h', orchestratorStep: 1, confidence: 1 },
      {
        renderer: async (_d, bounds) => {
          rendered.push({ ...bounds });
          return 'data:image/png;base64,AAAA';
        },
      },
    );
    expect(rendered).toHaveLength(1);
    // the box handed to the renderer IS the box stored on the section
    expect(rendered[0]).toEqual(section.bounds);
    expect(section.png).toBe('data:image/png;base64,AAAA');
    expect(section.dxf).toContain('ENTITIES');
  });

  it('refuses a zero-height box instead of rendering a blank strip', async () => {
    const doc = threeAreaDoc();
    const section = await exportSection(
      doc,
      boundsFromCorners(0, 100, 200, 100),
      { sectionId: 'REGION-01', label: 'L', kind: 'detail', sourceDrawingHash: 'h', orchestratorStep: 1, confidence: 1 },
      { skipPng: true },
    );
    expect(section.entityCount).toBe(0);
    expect(section.limitations.map((l) => l.code)).toContain('degenerate-bounds');
  });

  it('records that no PNG was produced rather than pretending one was', async () => {
    const doc = threeAreaDoc();
    const section = await exportSection(
      doc,
      boundsFromCorners(0, 0, 200, 200),
      { sectionId: 'REGION-01', label: 'L', kind: 'detail', sourceDrawingHash: 'h', orchestratorStep: 1, confidence: 1 },
      { renderer: async () => null },
    );
    expect(section.png).toBe('');
    expect(section.limitations.map((l) => l.code)).toContain('render-unavailable');
    expect(section.dxf).toContain('ENTITIES'); // the DXF is still complete
  });
});

// ------------------------------------------------------------
// 9–13  the DXF is real CAD
// ------------------------------------------------------------

describe('the section DXF is CAD, not a picture', () => {
  const doc = threeAreaDoc();
  // y reaches to -60 so the box contains the grid line at y=-50 — the
  // boundary-crossing case below depends on it
  const box = boundsFromCorners(-10, -60, 210, 210);
  const cut = () => entitiesInBounds(doc, box);

  it('contains real entities, not an embedded image', () => {
    const written = writeSectionDxf(doc, cut().entities, box);
    expect(written.text).toContain('\r\nLINE\r\n');
    expect(written.text).toContain('\r\nCIRCLE\r\n');
    expect(written.text).toContain('\r\nTEXT\r\n');
    expect(written.text).not.toMatch(/base64|IMAGE|OLE2FRAME/);
    expect(written.entityCount).toBeGreaterThan(3);
  });

  it('parses back with the app\'s own DXF reader', () => {
    const written = writeSectionDxf(doc, cut().entities, box);
    const reparsed = parseDXF(written.text, 'REGION-01.dxf');
    expect(reparsed.entities.length).toBe(written.entityCount);
    const types = new Set(reparsed.entities.map((e) => e.type));
    expect(types).toContain('line');
    expect(types).toContain('circle');
    expect(types).toContain('text');
  });

  it('preserves the ORIGINAL coordinates — nothing is moved to 0,0', () => {
    const far = makeDoc({
      entities: [
        text({ x: 12500, y: 8700 }, 'FAR DETAIL', 10, 'TEXT', 'F1'),
        text({ x: 12500, y: 8600 }, 'SECOND LINE', 10, 'TEXT', 'F2'),
      ],
      name: 'far',
    });
    const b = boundsFromCorners(12000, 8000, 13000, 9000);
    const written = writeSectionDxf(far, entitiesInBounds(far, b).entities, b);
    const reparsed = parseDXF(written.text, 'x.dxf');
    const t = reparsed.entities.find((e) => e.type === 'text');
    expect(t && t.type === 'text' && Math.round(t.position.x)).toBe(12500);
    expect(t && t.type === 'text' && Math.round(t.position.y)).toBe(8700);
  });

  it('preserves layers, and declares them in the LAYER table', () => {
    const written = writeSectionDxf(doc, cut().entities, box);
    expect(written.text).toContain('STEEL');
    expect(written.text).toContain('TEXT');
    const reparsed = parseDXF(written.text, 'x.dxf');
    expect(reparsed.layers.has('STEEL')).toBe(true);
    const steel = reparsed.entities.filter((e) => e.style.layer === 'STEEL');
    expect(steel.length).toBeGreaterThan(0);
  });

  it('preserves the original handles, so a section traces back to the sheet', () => {
    const written = writeSectionDxf(doc, cut().entities, box);
    expect(written.handles).toContain('AAA3');
    const reparsed = parseDXF(written.text, 'x.dxf');
    expect(reparsed.entities.map((e) => e.style.handle)).toContain('AAA3');
  });

  it('includes a long entity that CROSSES the section boundary', () => {
    // GRID1 runs x=100..900; the left section is x<=210. Insertion-point
    // testing would keep it (starts at 100); midpoint testing would drop it.
    // Geometric intersection is the rule, and it keeps it.
    const handles = cut().handles;
    expect(handles).toContain('GRID1');

    // and the middle section, which the same line passes straight through
    const middle = entitiesInBounds(doc, boundsFromCorners(390, -60, 610, 200));
    expect(middle.handles).toContain('GRID1');
  });

  it('excludes an entity that is wholly outside', () => {
    const left = entitiesInBounds(doc, boundsFromCorners(-10, 100, 210, 210));
    expect(left.handles).not.toContain('CCC1');
    expect(left.handles).not.toContain('BBB1');
  });

  it('measures TEXT by its rendered extent, not its insertion point', () => {
    // "GENERAL NOTES" is 13 chars at h12 → ~97mm wide from x=810
    const t = makeDoc({ entities: [text({ x: 810, y: 180 }, 'GENERAL NOTES', 12, 'TEXT', 'T1')] });
    const b = entityBoundsMm(t.entities[0], t)!;
    expect(b.xMax).toBeGreaterThan(870);
    // a box that only touches the tail of the string still selects it
    const tail = entitiesInBounds(t, boundsFromCorners(860, 175, 900, 195));
    expect(tail.handles).toContain('T1');
  });

  it('includes a BLOCK whose insertion point is outside but whose geometry is inside', () => {
    const bd = blockDoc();
    // INS1 is anchored at (90,10) with a marker extending to (150,70)
    const b = boundsFromCorners(100, 0, 200, 100);
    const sel = entitiesInBounds(bd, b);
    expect(sel.handles).toContain('INS1');
    const written = writeSectionDxf(bd, sel.entities, b);
    // the block DEFINITION has to travel with the reference
    expect(written.text).toContain('BLOCKS');
    expect(written.text).toContain('MARKER');
    const reparsed = parseDXF(written.text, 'x.dxf');
    expect(reparsed.blocks.has('MARKER')).toBe(true);
  });

  it('keeps source units when the drawing is not in millimetres', () => {
    // an inch-headed sheet: entities in inches, extents and bounds in mm
    const inches = threeAreaDoc(25.4);
    // the left area is 0..200 INCHES = 0..5080 mm
    const b = boundsFromCorners(-10, -10, 5100, 5100);
    const sel = entitiesInBounds(inches, b);
    expect(sel.handles).toContain('AAA3');
    const written = writeSectionDxf(inches, sel.entities, b);
    const reparsed = parseDXF(written.text, 'x.dxf');
    const l = reparsed.entities.find((e) => e.style.handle === 'AAA3');
    // written back in SOURCE units — 200, not 5080
    expect(l && l.type === 'line' && Math.round(l.b.x)).toBe(200);
    // and the section declares inches, so it re-imports at the same size
    expect(reparsed.unitScale).toBeCloseTo(25.4, 3);
  });

  it('does not silently corrupt what it cannot write faithfully', () => {
    const spliney = makeDoc({
      entities: [
        {
          type: 'spline',
          style: { layer: '0', color: { kind: 'byLayer' }, lineweight: -1, linetype: '', linetypeScale: 1, transparency: -1, normal: null, handle: 'SP1' },
          fitPoints: [
            { x: 0, y: 0 },
            { x: 50, y: 80 },
            { x: 100, y: 0 },
          ],
          controlPoints: [],
          degree: 3,
          closed: false,
        },
      ],
    });
    const b = boundsFromCorners(-10, -10, 110, 110);
    const written = writeSectionDxf(spliney, spliney.entities, b);
    expect(written.entityCount).toBe(1);
    // the substitution is declared, not hidden
    expect(written.limitations.some((l) => /SPLINE/.test(l.message))).toBe(true);
    expect(() => parseDXF(written.text, 'x.dxf')).not.toThrow();
  });
});

// ------------------------------------------------------------
// 14–19  metadata, package, audit, dedup, hashing
// ------------------------------------------------------------

describe('the package', () => {
  const run = async (extra: Parameters<typeof splitDrawing>[1]['transport']) =>
    splitDrawing(threeAreaDoc(), { ...base, transport: extra });

  it('writes metadata for every section', async () => {
    const { transport } = scripted([
      {
        content: '',
        toolCalls: [
          call('propose_section', {
            label: 'SECTION AT 1-1',
            kind: 'detail',
            handles: ['AAA1', 'AAA2'],
            confidence: 0.9,
            memberHints: [{ mark: 'C1', basis: 'label visible in region' }],
            calloutHints: ['300x1400'],
            evidenceIds: ['AAA2'],
          }),
        ],
      },
      done(),
    ]);
    const pkg = await run(transport);
    const s = pkg.sections[0];
    expect(s.sectionId).toBe('REGION-01');
    expect(s.kind).toBe('detail');
    expect(s.confidence).toBe(0.9);
    expect(s.memberHints).toEqual([{ mark: 'C1', basis: 'label visible in region' }]);
    expect(s.calloutHints).toEqual(['300x1400']);
    expect(s.evidenceIds).toEqual(['AAA2']);
    expect(s.entityCount).toBeGreaterThan(0);
    expect(s.sourceDrawing).toBe('three-area.dxf');
    expect(s.sourceDrawingHash).toBeTruthy();
    expect(s.orchestratorStep).toBe(1);
  });

  it('writes a package with summary, relationships and unresolved areas', async () => {
    const { transport } = scripted([
      { content: '', toolCalls: [call('propose_section', { label: 'A', kind: 'detail', handles: ['AAA1', 'AAA2'] })] },
      {
        content: JSON.stringify({
          summary: 'Three areas: a section, a layout and the notes.',
          relationships: [{ from: 'REGION-01', to: 'REGION-02', kind: 'detail-of', basis: 'same mark' }],
          unresolved: ['the block bottom-right'],
        }),
        toolCalls: [],
      },
    ]);
    const pkg = await run(transport);
    expect(pkg.summary).toContain('Three areas');
    expect(pkg.relationships).toEqual([
      { from: 'REGION-01', to: 'REGION-02', kind: 'detail-of', basis: 'same mark' },
    ]);
    // unresolved also carries the coverage check's own findings now —
    // this test is about the MODEL's reasoning surviving, not an exact list
    expect(pkg.unresolved).toContain('the block bottom-right');
    expect(pkg.sheetExtents).not.toBeNull();
    expect(pkg.version).toBe(1);
  });

  it('records what the AI actually asked for, including requests that failed', async () => {
    const { transport } = scripted([
      { content: '', toolCalls: [call('look_at', { x1: 0, y1: 0, x2: 200, y2: 200 })] },
      { content: '', toolCalls: [call('propose_section', { label: 'ghost', kind: 'detail', handles: ['NOPE'] })] },
      { content: '', toolCalls: [call('propose_section', { label: 'A', kind: 'detail', handles: ['AAA1', 'AAA2'] })] },
      done(),
    ]);
    const pkg = await run(transport);
    expect(pkg.requests).toHaveLength(3);

    const [look, ghost, good] = pkg.requests;
    expect(look.tool).toBe('look_at');
    expect(look.resolvedBounds).not.toBeNull();
    expect(look.step).toBe(1);

    expect(ghost.sectionId).toBeNull();
    expect(ghost.note).toMatch(/handles/);

    expect(good.sectionId).toBe('REGION-01');
    expect(good.semanticHint).toBe('detail: A');
    expect(good.dxfPath).toBe('REGION-01/section.dxf');
    expect(good.resolvedBounds).toEqual(pkg.sections[0].bounds);
    expect(good.timestamp).toBeGreaterThan(0);
  });

  it('deduplicates identical regions but keeps overlapping ones apart', async () => {
    const { transport } = scripted([
      {
        content: '',
        toolCalls: [
          call('propose_section', { label: 'first', kind: 'detail', handles: ['AAA1', 'AAA2'] }),
          // same handles → same bounds → the same region
          call('propose_section', { label: 'again', kind: 'detail', handles: ['AAA1', 'AAA2'] }),
          // overlapping but larger → deliberately a different section
          call('propose_section', { label: 'wider', kind: 'layout', x1: -50, y1: -100, x2: 300, y2: 250 }),
        ],
      },
      done(),
    ]);
    const pkg = await run(transport);
    expect(pkg.sections).toHaveLength(2);
    expect(pkg.sections.map((s) => s.label)).toEqual(['first', 'wider']);
    // the duplicate is still audited, pointing at the section it repeated
    const dup = pkg.requests.find((r) => r.note?.includes('duplicate'));
    expect(dup?.sectionId).toBe('REGION-01');
    // and the two surviving sections really do have different geometry
    expect(boundsKey(pkg.sections[0].bounds)).not.toBe(boundsKey(pkg.sections[1].bounds));
  });

  it('records the source drawing hash, and a changed drawing changes it', async () => {
    const a = threeAreaDoc();
    const b = threeAreaDoc();
    b.entities.push(text({ x: 900, y: 900 }, 'REVISION B', 10, 'TEXT', 'REVB'));
    b.extents = { min: { x: -100, y: -100 }, max: { x: 1100, y: 1100 } };
    const [ha, hb] = await Promise.all([hashDocument(a), hashDocument(b)]);
    expect(ha).toBeTruthy();
    expect(hb).not.toBe(ha);
  });

  it('lays the sections out as the directory structure the spec describes', async () => {
    const { transport } = scripted([
      { content: '', toolCalls: [call('propose_section', { label: 'A', kind: 'detail', handles: ['AAA1', 'AAA2'] })] },
      done(),
    ]);
    const pkg = await run(transport);
    const paths = sectionFileTree(pkg).map((f) => f.path);
    expect(paths).toContain('sections/REGION-01/section.dxf');
    expect(paths).toContain('sections/REGION-01/metadata.json');
    expect(paths).toContain('drawing-understanding.json');
    // the index must not carry a copy of every section body
    const index = sectionFileTree(pkg).find((f) => f.path === 'drawing-understanding.json')!;
    expect(index.text).not.toContain('ENDSEC');
  });

  it('clamps a request that runs off the sheet instead of cutting nothing', async () => {
    const { transport } = scripted([
      { content: '', toolCalls: [call('propose_section', { label: 'huge', kind: 'overall', x1: -1e9, y1: -1e9, x2: 1e9, y2: 1e9 })] },
      done(),
    ]);
    const pkg = await run(transport);
    const sheet = pkg.sheetExtents!;
    expect(pkg.sections[0].bounds.xMin).toBeGreaterThanOrEqual(sheet.xMin);
    expect(pkg.sections[0].bounds.xMax).toBeLessThanOrEqual(sheet.xMax);
    expect(pkg.sections[0].entityCount).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------
// pointing, not measuring
// ------------------------------------------------------------

describe('the model points and the platform measures', () => {
  it('measures a box from handles the model named', () => {
    const doc = threeAreaDoc();
    const b = boundsForHandles(doc, ['CCC1', 'CCC2', 'CCC3'])!;
    expect(b).not.toBeNull();
    expect(b.xMin).toBeLessThan(810);
    expect(b.yMax).toBeGreaterThan(180);
    // and it did NOT accidentally swallow the other areas
    expect(b.xMin).toBeGreaterThan(600);
  });

  it('drops handles the sheet does not carry', () => {
    const doc = threeAreaDoc();
    expect(boundsForHandles(doc, ['CCC1', 'NOT-A-HANDLE', 'CCC2'])).not.toBeNull();
    expect(boundsForHandles(doc, ['NOT-A-HANDLE', 'ALSO-FAKE'])).toBeNull();
  });

  it('refuses a single handle — one label is a caption, not a region', () => {
    expect(boundsForHandles(threeAreaDoc(), ['CCC1'])).toBeNull();
  });
});

// ------------------------------------------------------------
// 20–21  the consumer side
// ------------------------------------------------------------

describe('a consumer loading the package', () => {
  const build = async () => {
    const { transport } = scripted([
      {
        content: '',
        toolCalls: [
          call('propose_section', {
            label: 'SECTION AT 1-1',
            kind: 'detail',
            handles: ['AAA1', 'AAA2'],
            memberHints: [{ mark: 'C1', basis: 'label visible in region' }],
          }),
          call('propose_section', { label: 'GENERAL NOTES', kind: 'note', handles: ['CCC1', 'CCC2'] }),
        ],
      },
      { content: JSON.stringify({ summary: 'A sheet.', relationships: [], unresolved: ['a stray block'] }), toolCalls: [] },
    ]);
    return splitDrawing(threeAreaDoc(), { ...base, transport });
  };

  it('briefs a consumer with the layout it no longer has to rediscover', async () => {
    const brief = packageBriefing(await build());
    expect(brief).toContain('REGION-01');
    expect(brief).toContain('SECTION AT 1-1');
    expect(brief).toContain('GENERAL NOTES');
    expect(brief).toContain('bounds (mm)');
    expect(brief).toContain('a stray block');
  });

  it('hands member hints across as HINTS, never as assignments', async () => {
    const brief = packageBriefing(await build());
    expect(brief).toMatch(/member HINTS \(not assignments\)/);
    expect(brief).toContain('C1 (label visible in region)');
    expect(brief).toMatch(/do not decide anything about quantities, ownership or scheduling/i);
  });

  it('tells the consumer it may still look for itself', async () => {
    expect(packageBriefing(await build())).toMatch(/you still have every tool you had/i);
  });

  it('serves only sections that actually have an image', async () => {
    const pkg = await build();
    expect(packagePanels(pkg)).toHaveLength(0); // this run was DXF-only
    pkg.sections[0].png = 'data:image/png;base64,AAAA';
    const panels = packagePanels(pkg);
    expect(panels).toHaveLength(1);
    expect(panels[0].sectionId).toBe('REGION-01');
    // the one with no image is still described in the briefing
    expect(packageBriefing(pkg)).toContain('NO IMAGE — use look_at');
  });
});

// ------------------------------------------------------------
// what the first live run broke on
// ------------------------------------------------------------

describe('an empty reply is a failed turn, not a finish', () => {
  // Live run 011: the model made four good look_at calls, then spent its whole
  // completion budget on reasoning and returned a blank message. The loop read
  // "no tool calls" as "the model is done" and ended the run with ZERO
  // sections — throwing away everything it had established on the strength of
  // one empty message. $0.0068 and 281 seconds for nothing.
  it('does not end the run when the model returns nothing', async () => {
    const doc = threeAreaDoc();
    const { transport } = scripted([
      { content: '', toolCalls: [call('propose_section', { label: 'A', kind: 'detail', handles: ['AAA1', 'AAA2'] })] },
      { content: '   ', toolCalls: [] }, // the blank turn
      { content: '', toolCalls: [call('propose_section', { label: 'B', kind: 'note', handles: ['CCC1', 'CCC2'] })] },
      done(),
    ]);
    const pkg = await splitDrawing(doc, { ...base, transport });
    expect(pkg.sections.map((s) => s.label)).toEqual(['A', 'B']);
  });

  it('nudges the model with what it already has', async () => {
    const doc = threeAreaDoc();
    const seen: string[] = [];
    const replies: ChatReply[] = [
      { content: '', toolCalls: [call('propose_section', { label: 'A', kind: 'detail', handles: ['AAA1', 'AAA2'] })] },
      { content: '', toolCalls: [] },
      done(),
    ];
    let i = 0;
    const transport: ChatTransport = async (req) => {
      for (const m of req.messages) if (m.role === 'user') seen.push(String(m.content ?? ''));
      return replies[Math.min(i++, replies.length - 1)];
    };
    await splitDrawing(doc, { ...base, transport });
    const nudge = seen.find((t) => t.includes('Your last reply was empty'));
    expect(nudge).toBeTruthy();
    expect(nudge).toContain('REGION-01');
    expect(nudge).toContain('round(s) left');
    expect(nudge).toContain('propose_section');
  });

  it('gives up after three blanks, keeping what it cut and saying why', async () => {
    const doc = threeAreaDoc();
    const { transport } = scripted([
      { content: '', toolCalls: [call('propose_section', { label: 'A', kind: 'detail', handles: ['AAA1', 'AAA2'] })] },
      { content: '', toolCalls: [] }, // repeats forever
    ]);
    const pkg = await splitDrawing(doc, { ...base, transport, maxRounds: 12 });
    expect(pkg.sections).toHaveLength(1); // the work survived
    expect(pkg.unresolved.join(' ')).toMatch(/replies in a row were empty/i);
  });

  it('says so when the rounds ran out without a closing reply', async () => {
    const doc = threeAreaDoc();
    const { transport } = scripted([
      { content: '', toolCalls: [call('find_text', { pattern: 'SECTION' })] },
    ]);
    const pkg = await splitDrawing(doc, { ...base, transport, maxRounds: 3 });
    expect(pkg.unresolved.join(' ')).toMatch(/used all 3 rounds without closing/i);
  });
});

// ------------------------------------------------------------
// filing a split in the drawing register
// ------------------------------------------------------------

describe('a split is filed against its drawing', () => {
  const build = async () => {
    const { transport } = scripted([
      {
        content: '',
        toolCalls: [
          call('propose_section', { label: 'SECTION AT 1-1', kind: 'section', handles: ['AAA1', 'AAA2'], confidence: 0.8 }),
          call('propose_section', { label: 'GENERAL NOTES', kind: 'note', handles: ['CCC1', 'CCC2'] }),
        ],
      },
      { content: JSON.stringify({ summary: 'A sheet.', relationships: [], unresolved: ['a stray block'] }), toolCalls: [] },
    ]);
    return splitDrawing(threeAreaDoc(), { ...base, transport });
  };

  it('describes every section in the index', async () => {
    const index = sectionsIndex(await build());
    expect(index.sections).toHaveLength(2);
    expect(index.sections[0]).toMatchObject({
      sectionId: 'REGION-01',
      label: 'SECTION AT 1-1',
      kind: 'section',
      confidence: 0.8,
    });
    expect(index.sections[0].entityCount).toBeGreaterThan(0);
    expect(index.summary).toBe('A sheet.');
    expect(index.unresolved).toContain('a stray block');
  });

  it('does NOT copy the section bodies into the register', async () => {
    // the register loads every artifact just to count its folders; carrying
    // eighteen DXFs in there would make listing a folder pay for all of them
    const pkg = await build();
    const json = JSON.stringify(sectionsIndex(pkg));
    expect(pkg.sections[0].dxf).toContain('ENDSEC');
    expect(json).not.toContain('ENDSEC');
    expect(json).not.toContain('LWPOLYLINE');
    expect(json.length).toBeLessThan(2000);
  });

  it('records whether an image exists without carrying it', async () => {
    const pkg = await build();
    pkg.sections[0].png = 'data:image/png;base64,AAAA';
    const index = sectionsIndex(pkg);
    expect(index.sections[0].hasImage).toBe(true);
    expect(index.sections[1].hasImage).toBe(false);
    expect(JSON.stringify(index)).not.toContain('base64');
  });

  it('reads back only from a sections artifact, and survives a corrupt one', async () => {
    const pkg = await build();
    const artifact = {
      kind: 'sections' as const,
      content: JSON.stringify(sectionsIndex(pkg)),
    } as Parameters<typeof readSectionsIndex>[0];
    expect(readSectionsIndex(artifact)?.sections).toHaveLength(2);

    expect(readSectionsIndex({ ...artifact, kind: 'bbs' } as never)).toBeNull();
    expect(readSectionsIndex({ ...artifact, content: '{oops' } as never)).toBeNull();
    expect(readSectionsIndex({ ...artifact, content: '{}' } as never)).toBeNull();
  });

  it('keeps the source hash, so a filed split can be checked against the drawing', async () => {
    const pkg = await build();
    const index = sectionsIndex(pkg);
    expect(index.sourceDrawingHash).toBe(pkg.sourceDrawingHash);
    expect(index.documentId).toBe(pkg.documentId);
  });
});

// ------------------------------------------------------------
// showing the work
// ------------------------------------------------------------

describe('the run shows what it is doing', () => {
  // The Sections panel showed one line, "Looking at the sheet…", for the whole
  // of a two-minute run. Everything the orchestrator reasoned and every cut it
  // made was emitted into a variable that the next event overwrote.
  it('emits the model reasoning as a thinking event', async () => {
    const doc = threeAreaDoc();
    const events: { step: number; ask: string; served: string }[] = [];
    const replies: ChatReply[] = [
      {
        content: '',
        reasoning: 'Four bands and two sections; I will cut the left detail first.',
        toolCalls: [call('propose_section', { label: 'A', kind: 'detail', handles: ['AAA1', 'AAA2'] })],
      },
      done(),
    ];
    let i = 0;
    const transport: ChatTransport = async () => replies[Math.min(i++, replies.length - 1)];
    await splitDrawing(doc, { ...base, transport, onEvent: (e) => events.push(e) });

    const thought = events.find((e) => e.ask === 'thinking');
    expect(thought?.served).toContain('Four bands and two sections');
    expect(thought?.step).toBe(1);
  });

  it('emits the prose the model writes alongside its tool calls', async () => {
    const doc = threeAreaDoc();
    const events: { step: number; ask: string; served: string }[] = [];
    const { transport } = scripted([
      {
        content: 'I will start with the section on the left.',
        toolCalls: [call('look_at', { x1: 0, y1: 0, x2: 200, y2: 200 })],
      },
      done(),
    ]);
    await splitDrawing(doc, { ...base, transport, onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.ask === 'thinking' && e.served.includes('section on the left'))).toBe(true);
  });

  it('does not mistake the closing JSON for thinking', async () => {
    // the final reply has content and NO tool calls — that is the answer,
    // not reasoning, and echoing it into the trail would be noise
    const doc = threeAreaDoc();
    const events: { step: number; ask: string; served: string }[] = [];
    const { transport } = scripted([
      { content: '', toolCalls: [call('propose_section', { label: 'A', kind: 'detail', handles: ['AAA1', 'AAA2'] })] },
      done('the closing summary'),
    ]);
    await splitDrawing(doc, { ...base, transport, onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.ask === 'thinking' && e.served.includes('closing summary'))).toBe(false);
  });

  it('reports every cut with its section id and entity count', async () => {
    const doc = threeAreaDoc();
    const events: { step: number; ask: string; served: string }[] = [];
    const { transport } = scripted([
      {
        content: '',
        toolCalls: [
          call('propose_section', { label: 'SECTION AT 1-1', kind: 'section', handles: ['AAA1', 'AAA2'] }),
          call('propose_section', { label: 'GENERAL NOTES', kind: 'note', handles: ['CCC1', 'CCC2'] }),
        ],
      },
      done(),
    ]);
    await splitDrawing(doc, { ...base, transport, onEvent: (e) => events.push(e) });
    const cuts = events.filter((e) => e.ask.startsWith('propose_section'));
    expect(cuts).toHaveLength(2);
    expect(cuts[0].served).toMatch(/REGION-01, \d+ entities/);
    expect(cuts[1].served).toMatch(/REGION-02, \d+ entities/);
  });
});

describe('the shipped transport carries the run-011 fix', () => {
  // The reasoning cap was fixed in the live-test harness first, and the
  // BROWSER kept the configuration that had already failed once. The fix has
  // to live in the transport the product actually uses.
  it('caps reasoning and leaves a completion budget', async () => {
    const src = (await import('../../src/cad/understanding/orchestrator.ts?raw')).default as string;
    const body = src.slice(src.indexOf('export const openRouterTransport'), src.indexOf('// tool surface'));
    expect(body).toMatch(/reasoning:\s*\{\s*effort:\s*'low'\s*\}/);
    expect(body).not.toMatch(/max_tokens:\s*16_?000/);
  });
});

describe('the closing summary is prose, never raw JSON', () => {
  const finish = async (content: string) => {
    const { transport } = scripted([
      { content: '', toolCalls: [call('propose_section', { label: 'A', kind: 'detail', handles: ['AAA1', 'AAA2'] })] },
      { content, toolCalls: [] },
    ]);
    return splitDrawing(threeAreaDoc(), { ...base, transport });
  };

  it('salvages JSON with a word in front of it', async () => {
    const pkg = await finish('Here you go: {"summary":"Four bands and two sections.","relationships":[],"unresolved":[]}');
    expect(pkg.summary).toBe('Four bands and two sections.');
  });

  it('salvages a fenced block', async () => {
    const pkg = await finish('```json\n{"summary":"A boundary wall sheet.","relationships":[],"unresolved":[]}\n```');
    expect(pkg.summary).toBe('A boundary wall sheet.');
  });

  it('never shows a broken JSON object as the summary', async () => {
    // this is what put `","relationships":[{"from":"REGION-05"…` at the top of
    // the register: unparseable JSON fell through to "use the raw text"
    const pkg = await finish('{"summary":"oops unterminated, "relationships":[{"from":"REGION-05"');
    expect(pkg.summary).not.toContain('relationships');
    expect(pkg.summary).not.toContain('REGION-05');
    expect(pkg.unresolved.join(' ')).toMatch(/closing summary could not be read/i);
  });

  it('keeps real prose that has a JSON tail stuck to it', async () => {
    const pkg = await finish(
      'The sheet holds four layout bands and two wall sections plus a notes block.","relationships":[{"from":"A"',
    );
    expect(pkg.summary).toContain('four layout bands');
    expect(pkg.summary).not.toContain('relationships');
  });

  it('still records relationships and unresolved when the JSON is good', async () => {
    const pkg = await finish(
      JSON.stringify({
        summary: 'A sheet.',
        relationships: [{ from: 'REGION-01', to: 'REGION-02', kind: 'detail-of', basis: 'same mark' }],
        unresolved: ['a stray block'],
      }),
    );
    expect(pkg.relationships).toHaveLength(1);
    expect(pkg.unresolved).toContain('a stray block');
  });
});
