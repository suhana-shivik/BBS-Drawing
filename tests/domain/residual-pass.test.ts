// The second pass: reading what the first pass left behind.
//
// The line this file defends is the one the stage is built around — GEOMETRY
// IS LOCAL, MEANING IS ASKED. Whether a residual overlaps, touches or sits
// near a REGION is arithmetic on boxes and must give the same answer every
// run with no model involved at all; what the residual IS, is the only thing a
// model is used for. So every test here that touches connectivity runs with no
// transport, and every test that touches a reading runs with a fake one.
//
// The other thing pinned here is the ban on invention. A prompt that says
// "never make anything up" is a wish; `validateReading` is what makes it a
// rule, and a rule that is not tested is a wish again.
import { describe, expect, it, vi } from 'vitest';
import type { CadDocument, CadEntity } from '../../src/cad/types';
import type { DrawingSection, SectionBounds } from '../../src/cad/understanding/types';
import {
  describeCandidate,
  linkFor,
  residualBrief,
  residualEntities,
  residualGeometry,
  runResidualPass,
  validateReading,
  type ResidualCandidate,
  type ResidualReading,
} from '../../src/cad/understanding/residual';

// --- fixtures ---------------------------------------------------------------

const box = (xMin: number, yMin: number, xMax: number, yMax: number): SectionBounds => ({
  xMin,
  yMin,
  xMax,
  yMax,
});

function text(handle: string, x: number, y: number, s: string): CadEntity {
  return {
    type: 'text',
    position: { x, y },
    text: s,
    height: 10,
    rotation: 0,
    hAlign: 'left',
    vAlign: 'baseline',
    widthFactor: 1,
    oblique: 0,
    styleName: 'STANDARD',
    wrapWidth: 0,
    style: {
      layer: 'TEXT',
      color: { kind: 'aci', index: 7 },
      lineweight: -1,
      linetype: 'CONTINUOUS',
      linetypeScale: 1,
      transparency: 0,
      normal: null,
      handle,
    },
  } as CadEntity;
}

function line(handle: string, x1: number, y1: number, x2: number, y2: number, layer = 'COLS'): CadEntity {
  return {
    type: 'line',
    a: { x: x1, y: y1 },
    b: { x: x2, y: y2 },
    style: {
      layer,
      color: { kind: 'aci', index: 7 },
      lineweight: -1,
      linetype: 'CONTINUOUS',
      linetypeScale: 1,
      transparency: 0,
      normal: null,
      handle,
    },
  } as CadEntity;
}

function docOf(entities: CadEntity[]): CadDocument {
  return {
    id: 'doc-1',
    name: 'columns',
    sourceFile: 'columns.dxf',
    unitScale: 1,
    layers: new Map(),
    linetypes: new Map(),
    textStyles: new Map(),
    blocks: new Map(),
    entities,
    layouts: [],
    regions: [],
    diagnostics: [],
    extents: { min: { x: 0, y: 0 }, max: { x: 4000, y: 4000 } },
  } as unknown as CadDocument;
}

function section(sectionId: string, b: SectionBounds, label = 'COLUMN SCHEDULE'): DrawingSection {
  return {
    sectionId,
    label,
    kind: 'schedule',
    sourceDrawing: 'columns.dxf',
    sourceDrawingHash: 'h',
    bounds: b,
    png: '',
    dxf: '',
    entityIds: [],
    evidenceIds: [],
    memberHints: [],
    calloutHints: [],
    orchestratorStep: 1,
    confidence: 0.9,
    entityCount: 3,
    limitations: [],
  };
}

const SHEET = box(0, 0, 4000, 4000);

// ---------------------------------------------------------------------------

describe('the geometry is decided locally, with no model', () => {
  it('reports overlap, touch and near SEPARATELY against every region', () => {
    // The three are different claims. Collapsing them into one "nearest" hides
    // the only question worth asking about a residual between two details:
    // which of them does it belong to?
    const g = residualGeometry(
      box(1000, 1000, 1100, 1100),
      [
        section('REGION-01', box(1050, 1050, 1500, 1500)), // overlaps
        section('REGION-02', box(1130, 1000, 1400, 1100)), // ~30mm away: touches
        section('REGION-03', box(1400, 1000, 1600, 1100)), // ~300mm: near
        section('REGION-04', box(3800, 3800, 4000, 4000)), // far side of the sheet
      ],
      SHEET,
    );
    expect(g.overlaps).toEqual(['REGION-01']);
    expect(g.touches).toEqual(['REGION-02']);
    expect(g.near.map((n) => n.sectionId)).toEqual(['REGION-03']);
    // and the far one is not reported at all — it is not context, it is noise
    expect([...g.overlaps, ...g.touches, ...g.near.map((n) => n.sectionId)]).not.toContain('REGION-04');
  });

  it('orders near regions closest first, so the reading has a ranking', () => {
    const g = residualGeometry(
      box(1000, 1000, 1100, 1100),
      [
        section('FAR', box(1600, 1000, 1700, 1100)),
        section('CLOSE', box(1300, 1000, 1400, 1100)),
      ],
      SHEET,
    );
    expect(g.near.map((n) => n.sectionId)).toEqual(['CLOSE', 'FAR']);
    expect(g.near[0].distanceMm).toBeLessThan(g.near[1].distanceMm);
  });

  it('is scale-invariant — the same drawing at 1000× reads the same', () => {
    // A millimetre threshold that suits a column detail is meaningless on a
    // site plan. The thresholds are fractions of the sheet diagonal, so the
    // classification cannot depend on what units the drawing happens to be in.
    const small = residualGeometry(
      box(100, 100, 110, 110),
      [section('R1', box(113, 100, 140, 110)), section('R2', box(300, 100, 320, 110))],
      box(0, 0, 400, 400),
    );
    const big = residualGeometry(
      box(100_000, 100_000, 110_000, 110_000),
      [
        section('R1', box(113_000, 100_000, 140_000, 110_000)),
        section('R2', box(300_000, 100_000, 320_000, 110_000)),
      ],
      box(0, 0, 400_000, 400_000),
    );
    expect(big.touches).toEqual(small.touches);
    expect(big.near.map((n) => n.sectionId)).toEqual(small.near.map((n) => n.sectionId));
  });

  it('finds exactly the entities no section covers', () => {
    const doc = docOf([
      line('A', 10, 10, 20, 20), // inside REGION-01
      line('B', 900, 900, 950, 950), // nobody looked here
      text('C', 905, 960, 'C1'),
    ]);
    const loose = residualEntities(doc, [section('REGION-01', box(0, 0, 100, 100))]);
    expect(loose.map((l) => l.entity.style.handle).sort()).toEqual(['B', 'C']);
  });
});

describe('the link combines geometry and reading, and geometry wins', () => {
  const reading = (over: Partial<ResidualReading> = {}): ResidualReading => ({
    kind: 'note',
    summary: 'a note',
    callouts: [],
    belongsTo: null,
    relation: 'annotation',
    basis: 'text',
    confidence: 0.8,
    ...over,
  });

  it('an overlap is CONNECTED whatever the model says', () => {
    // An overlap is a fact about boxes. A reading cannot withdraw it, and a
    // model that calls an overlapping piece independent is simply wrong about
    // something it was not asked to judge.
    const g = { overlaps: ['REGION-02'], touches: [], near: [] };
    expect(linkFor(g, reading({ relation: 'independent' }))).toEqual({
      link: 'connected',
      linkedTo: 'REGION-02',
    });
  });

  it('lets the reading pick BETWEEN regions it actually touches', () => {
    // Two neighbours both touch it; only the reading can say which one it
    // continues. That is the one thing the model is better at here.
    const g = { overlaps: [], touches: ['REGION-01', 'REGION-02'], near: [] };
    expect(linkFor(g, reading({ belongsTo: 'REGION-02' })).linkedTo).toBe('REGION-02');
    // with no reading it still commits, rather than reporting nothing
    expect(linkFor(g, null).linkedTo).toBe('REGION-01');
  });

  it('NEAR_CONNECTED needs BOTH proximity and an attachment', () => {
    const near = { overlaps: [], touches: [], near: [{ sectionId: 'REGION-03', distanceMm: 400 }] };
    expect(linkFor(near, reading({ belongsTo: 'REGION-03', relation: 'continuation' }))).toEqual({
      link: 'near-connected',
      linkedTo: 'REGION-03',
    });
    // close but read as its own thing → independent, which is a real answer
    expect(linkFor(near, reading({ belongsTo: null })).link).toBe('independent');
    // close but nothing was read at all → independent, not a guess
    expect(linkFor(near, null).link).toBe('independent');
  });

  it('refuses a semantic attachment to a region it is nowhere near', () => {
    // THE GUARD. A model asserting "this belongs to REGION-02" about something
    // on the far side of the sheet is guessing, and a guess dressed as a
    // relationship is worse than no relationship.
    const g = { overlaps: [], touches: [], near: [{ sectionId: 'REGION-09', distanceMm: 300 }] };
    expect(linkFor(g, reading({ belongsTo: 'REGION-02' })).link).toBe('independent');
  });
});

describe('the reading may not invent anything', () => {
  const candidate: ResidualCandidate = {
    gapId: 'GAP-01',
    bounds: box(1000, 1000, 1100, 1100),
    entityCount: 5,
    entityTypes: [{ type: 'line', count: 4 }],
    layers: [{ layer: 'COLS', count: 4 }],
    text: ['C1'],
    entityIds: ['A1', 'A2', 'A3', 'A4', 'A5'],
    geometry: { overlaps: [], touches: ['REGION-02'], near: [{ sectionId: 'REGION-03', distanceMm: 400 }] },
  };

  it('drops callouts that are not in the text it was given', () => {
    const r = validateReading(
      { kind: 'callout', summary: 'a column mark', callouts: ['C1', '300x300x2000'], confidence: 0.9 },
      candidate,
    );
    // "300x300x2000" reads like a plausible size and appears nowhere in the
    // payload. That is exactly the failure this stage must not produce.
    expect(r!.callouts).toEqual(['C1']);
  });

  it('drops a belongsTo naming a region it was never shown', () => {
    const r = validateReading({ kind: 'note', summary: 's', belongsTo: 'REGION-99' }, candidate);
    expect(r!.belongsTo).toBeNull();
  });

  it('keeps a belongsTo that was offered', () => {
    expect(validateReading({ kind: 'n', summary: 's', belongsTo: 'REGION-02' }, candidate)!.belongsTo).toBe(
      'REGION-02',
    );
    expect(validateReading({ kind: 'n', summary: 's', belongsTo: 'REGION-03' }, candidate)!.belongsTo).toBe(
      'REGION-03',
    );
  });

  it('falls back to independent on an unknown relation, and clamps confidence', () => {
    const r = validateReading(
      { kind: 'n', summary: 's', relation: 'definitely-part-of-it', confidence: 42 },
      candidate,
    )!;
    expect(r.relation).toBe('independent');
    expect(r.confidence).toBe(1);
  });

  it('returns null for an empty answer rather than an empty reading', () => {
    expect(validateReading(null, candidate)).toBeNull();
    expect(validateReading({ callouts: [] }, candidate)).toBeNull();
  });
});

describe('the payload carries the piece and its context, never the sheet', () => {
  it('sends the verbatim text, the local relationships and only the offered ids', () => {
    const doc = docOf([line('B', 900, 900, 950, 950), text('C', 905, 960, 'REINFORCEMENT')]);
    const sections = [section('REGION-02', box(600, 600, 800, 800), 'TYPICAL COLUMN DETAIL')];
    const loose = residualEntities(doc, sections);
    const candidate = describeCandidate(
      doc,
      { id: 'GAP-01', bounds: box(890, 890, 960, 970), entityCount: 2, layers: [], touches: [], nearest: null, sampleText: [] },
      loose,
      sections,
      SHEET,
    );
    const brief = residualBrief(candidate, sections);

    expect(brief).toContain('UNREAD PIECE GAP-01');
    expect(brief).toContain('"REINFORCEMENT"');
    expect(brief).toContain('REGION-02');
    // the label is context the model needs to judge "does this belong to it?"
    expect(brief).toContain('TYPICAL COLUMN DETAIL');
    // and it says the text it sent IS all of it, so silence means absence
    expect(brief).toContain('this is ALL of it');
  });

  it('describes the entity types actually present', () => {
    const doc = docOf([
      line('A', 900, 900, 950, 950),
      line('B', 900, 910, 950, 960),
      text('C', 905, 960, 'C1'),
    ]);
    const loose = residualEntities(doc, []);
    const c = describeCandidate(
      doc,
      { id: 'GAP-01', bounds: box(880, 880, 980, 980), entityCount: 3, layers: [], touches: [], nearest: null, sampleText: [] },
      loose,
      [],
      SHEET,
    );
    expect(c.entityTypes).toEqual([
      { type: 'line', count: 2 },
      { type: 'text', count: 1 },
    ]);
    expect(c.text).toEqual(['C1']);
  });
});

describe('the pass as a whole', () => {
  const doc = docOf([
    line('IN', 2750, 2750, 2800, 2800),
    line('OUT1', 3000, 3000, 3050, 3050),
    text('OUT2', 3005, 3060, 'COLUMN LAYOUT PLAN'),
  ]);
  // Near enough to be offered as context — which is the interesting case: the
  // reading has something it COULD attach to, and still says independent.
  const sections = [section('REGION-01', box(2700, 2700, 2900, 2900))];

  it('reads each leftover and returns a relationship for it', async () => {
    const transport = vi.fn(async () => ({
      content: JSON.stringify({
        kind: 'layout',
        summary: 'A column layout plan nobody cut.',
        callouts: ['COLUMN LAYOUT PLAN'],
        belongsTo: null,
        relation: 'independent',
        basis: 'its own title text',
        confidence: 0.9,
      }),
      toolCalls: [],
    }));
    const out = await runResidualPass(doc, sections, { transport, skipPng: true });

    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('read');
    expect(out[0].link).toBe('independent');
    expect(out[0].reading!.kind).toBe('layout');
    expect(out[0].reading!.callouts).toEqual(['COLUMN LAYOUT PLAN']);
    // ONE call for ONE piece — the sheet is never re-sent.
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not send the whole drawing — the payload is the piece', async () => {
    // The request is captured rather than read off the mock, so the assertion
    // is about what the stage SENDS, not about vitest's tuple typing.
    let sent = '';
    const transport = vi.fn(async (req: { messages: unknown }) => {
      sent = JSON.stringify(req.messages);
      return { content: '{"kind":"n","summary":"s"}', toolCalls: [] };
    });
    await runResidualPass(doc, sections, { transport, skipPng: true });
    expect(sent).toContain('COLUMN LAYOUT PLAN'); // the residual's own text
    expect(sent).toContain('REGION-01'); // offered as context
    expect(sent.length).toBeLessThan(4000); // not a sheet dump
  });

  it('carries on when one piece fails, and says which and why', async () => {
    const transport = vi.fn(async () => {
      throw new Error('429 rate limited');
    });
    const out = await runResidualPass(doc, sections, { transport, skipPng: true });
    // A failed reading still reports its LOCAL geometry — that half never
    // needed the model, so losing the model must not lose it.
    expect(out[0].status).toBe('failed');
    expect(out[0].note).toContain('429');
    expect(out[0].link).toBe('independent');
    expect(out[0].bounds).toBeTruthy();
  });

  it('says plainly when a piece was not read rather than dropping it', async () => {
    // An unread piece that is silently absent looks exactly like a sheet that
    // was fully accounted for, which is the lie this whole stage exists to
    // stop telling.
    const transport = vi.fn(async () => ({ content: '{"kind":"n","summary":"s"}', toolCalls: [] }));
    const out = await runResidualPass(doc, sections, { transport, skipPng: true, maxReads: 0 });
    expect(out[0].status).toBe('unread');
    expect(out[0].note).toContain('not read');
    expect(transport).not.toHaveBeenCalled();
  });

  it('returns nothing when the first pass left nothing behind', async () => {
    const transport = vi.fn();
    const out = await runResidualPass(doc, [section('ALL', box(0, 0, 4000, 4000))], { transport });
    expect(out).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it('never re-cuts a section — the sections it is given come back untouched', async () => {
    const transport = vi.fn(async () => ({ content: '{"kind":"n","summary":"s"}', toolCalls: [] }));
    const before = JSON.stringify(sections);
    await runResidualPass(doc, sections, { transport, skipPng: true });
    expect(JSON.stringify(sections)).toBe(before);
  });
});
