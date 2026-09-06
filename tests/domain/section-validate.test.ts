// DOES EACH SECTION CONTAIN WHAT ITS AREA OF THE DRAWING CONTAINS?
//
// The two properties this file exists to defend:
//
//   A COUNT MATCH IS NOT A PASS. The same number of entities can be the wrong
//   entities — a section carrying the neighbouring detail's text instead of
//   its own has identical counts and is completely wrong. Every check here
//   compares IDENTITY: which handles, which strings, which endpoints.
//
//   THE MODEL IS NOT THE VALIDATOR. Handles, counts, coordinates and dimension
//   endpoints are decidable exactly, for nothing. A model asked to confirm
//   arithmetic will confirm it, including when it is wrong. So a section that
//   matches costs ZERO tokens, and the tests below prove no call is made.
//
// And the safeguard: READ → COMPARE → REPORT, never READ → DECIDE → MODIFY. A
// validator that can also repair is one whose reports you cannot trust.
import { describe, expect, it, vi } from 'vitest';
import type { CadDocument, CadEntity } from '../../src/cad/types';
import {
  needsReview,
  reviewMismatches,
  validateSection,
  validateSections,
  validationReport,
  verdictReport,
  aiReasons,
  auditLabels,
  labelAuditReport,
} from '../../src/cad/understanding/validate';
import type { DrawingSection, SectionBounds } from '../../src/cad/understanding/types';

const box = (xMin: number, yMin: number, xMax: number, yMax: number): SectionBounds => ({
  xMin,
  yMin,
  xMax,
  yMax,
});

const style = (handle: string, layer = 'COLS') => ({
  layer,
  color: { kind: 'aci' as const, index: 7 },
  lineweight: -1,
  linetype: 'CONTINUOUS',
  linetypeScale: 1,
  transparency: 0,
  normal: null,
  handle,
});

const line = (handle: string, x: number, y: number): CadEntity =>
  ({ type: 'line', a: { x, y }, b: { x: x + 10, y: y + 10 }, style: style(handle) }) as CadEntity;

const text = (handle: string, x: number, y: number, s: string): CadEntity =>
  ({
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
    style: style(handle, 'TEXT'),
  }) as CadEntity;

function docOf(
  entities: CadEntity[],
  dimensions: Array<Record<string, unknown>> = [],
): CadDocument {
  return {
    id: 'd',
    name: 'd',
    sourceFile: 'd.dxf',
    unitScale: 1,
    layers: new Map(),
    linetypes: new Map(),
    textStyles: new Map(),
    blocks: new Map(),
    entities,
    annotations: { dimensions, leaders: [] },
    layouts: [],
    regions: [],
    diagnostics: [],
    extents: { min: { x: 0, y: 0 }, max: { x: 4000, y: 4000 } },
  } as unknown as CadDocument;
}

function section(over: Partial<DrawingSection> = {}): DrawingSection {
  return {
    sectionId: 'REGION-01',
    label: 'COLUMN SCHEDULE',
    kind: 'schedule',
    sourceDrawing: 'd.dxf',
    sourceDrawingHash: 'h',
    bounds: box(0, 0, 500, 500),
    png: '',
    dxf: '',
    entityIds: [],
    evidenceIds: [],
    memberHints: [],
    calloutHints: [],
    orchestratorStep: 1,
    confidence: 0.9,
    entityCount: 0,
    limitations: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('a faithful section passes, and costs nothing', () => {
  const doc = docOf([line('a', 10, 10), line('b', 20, 20), text('t', 30, 30, 'C1')]);

  it('passes when the section holds exactly its area', () => {
    const v = validateSection(doc, section({ entityIds: ['a', 'b', 't'] }));
    expect(v.status).toBe('PASS');
    expect(v.checks).toEqual({
      geometry: 'PASS',
      text: 'PASS',
      dimensions: 'PASS',
      tags: 'PASS',
      ownership: 'PASS',
    });
    expect(v.missing).toEqual([]);
    expect(v.extra).toEqual([]);
    expect(v.confidence).toBe(1);
  });

  it('asks the model NOTHING when the code already settled it', async () => {
    // The whole economy of this design. On a clean drawing every section takes
    // this path, so validating a sheet costs zero tokens.
    const transport = vi.fn();
    const v = validateSection(doc, section({ entityIds: ['a', 'b', 't'] }));
    expect(needsReview(v)).toBe(false);
    await validateSections(doc, [section({ entityIds: ['a', 'b', 't'] })], { transport });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('a count match is not a pass', () => {
  it('catches the RIGHT NUMBER of the WRONG entities', () => {
    // THE CASE THE WHOLE FILE IS FOR. Three entities in the area, three in the
    // section — and one of them is the neighbouring detail's. Every count is
    // identical; the section is wrong.
    const doc = docOf([
      line('a', 10, 10),
      line('b', 20, 20),
      text('t', 30, 30, 'C1'),
      text('far', 3000, 3000, 'SOMEWHERE ELSE'),
    ]);
    const v = validateSection(doc, section({ entityIds: ['a', 'b', 'far'] }));

    expect(v.counts.original.total).toBe(v.counts.generated.total); // counts agree
    expect(v.status).toBe('FAIL'); // identity does not
    expect(v.missing).toEqual(['t']);
    expect(v.extra).toEqual(['far']);
    expect(v.mismatches.some((m) => m.type === 'text' && m.id === 'C1')).toBe(true);
    expect(v.mismatches.some((m) => m.type === 'ownership' && m.id === 'far')).toBe(true);
  });

  it('treats missing TEXT as a failure, not a warning', () => {
    // Text is meaning. One lost label can change what a section says.
    const doc = docOf([...Array.from({ length: 60 }, (_, i) => line(`L${i}`, i, i)), text('t', 5, 5, 'C1')]);
    const kept = Array.from({ length: 60 }, (_, i) => `L${i}`);
    const v = validateSection(doc, section({ entityIds: kept }));
    expect(v.checks.text).toBe('FAIL');
    expect(v.status).toBe('FAIL');
  });

  it('is lenient about ONE clipped line and strict about many', () => {
    // A section is a rectangle cut through a drawing; a line on the boundary
    // going either way is expected. Five per cent of them is not.
    const many = Array.from({ length: 60 }, (_, i) => line(`L${i}`, i, i));
    const doc = docOf(many);
    const one = validateSection(doc, section({ entityIds: many.slice(1).map((e) => e.style.handle) }));
    expect(one.checks.geometry).toBe('WARNING');

    const half = validateSection(doc, section({ entityIds: many.slice(30).map((e) => e.style.handle) }));
    expect(half.checks.geometry).toBe('FAIL');
  });
});

describe('dimensions: the value is not the whole question', () => {
  it('flags a dimension whose endpoint reaches outside the section', () => {
    // Right number, wrong drawing: it prints 2400 correctly while measuring
    // something the section does not contain.
    const doc = docOf(
      [line('a', 10, 10)],
      [{ handle: 'D104', layer: 'DIMS', kind: 'aligned', from: { x: 10, y: 10 }, to: { x: 2400, y: 10 }, textPoint: { x: 200, y: 20 }, measurement: 2390 }],
    );
    const v = validateSection(doc, section({ entityIds: ['a'] }));
    expect(v.checks.dimensions).toBe('WARNING');
    const m = v.mismatches.find((x) => x.type === 'dimension')!;
    expect(m.id).toBe('D104');
    expect(m.original).toBe(m.generated); // the VALUE agrees
    expect(m.reason).toContain('endpoint');
  });

  it('passes a dimension entirely inside the section', () => {
    const doc = docOf(
      [line('a', 10, 10)],
      [{ handle: 'D1', layer: 'DIMS', kind: 'aligned', from: { x: 10, y: 10 }, to: { x: 200, y: 10 }, textPoint: { x: 100, y: 20 }, measurement: 190 }],
    );
    expect(validateSection(doc, section({ entityIds: ['a'] })).checks.dimensions).toBe('PASS');
  });
});

describe('tags must have evidence in the section', () => {
  it('warns when a claimed mark has no text behind it', () => {
    const doc = docOf([text('t', 30, 30, 'C1')]);
    const v = validateSection(
      doc,
      section({ entityIds: ['t'], memberHints: [{ mark: 'C7', basis: 'visible label' }] }),
    );
    expect(v.checks.tags).toBe('WARNING');
    expect(v.mismatches.find((m) => m.type === 'tag')!.id).toBe('C7');
  });

  it('passes when the text is there', () => {
    const doc = docOf([text('t', 30, 30, 'COLUMN C7 SCHEDULE')]);
    const v = validateSection(
      doc,
      section({ entityIds: ['t'], memberHints: [{ mark: 'C7', basis: 'visible label' }] }),
    );
    expect(v.checks.tags).toBe('PASS');
  });
});

describe('ownership: what a section claims must be real, and here', () => {
  it('fails on a handle that is not in the drawing at all', () => {
    const doc = docOf([line('a', 10, 10)]);
    const v = validateSection(doc, section({ entityIds: ['a', 'ghost'] }));
    expect(v.checks.ownership).toBe('FAIL');
    expect(v.mismatches.find((m) => m.type === 'ownership')!.reason).toContain('not in the drawing');
  });
});

describe('the model sees only the residue, and cannot overturn arithmetic', () => {
  const doc = docOf([
    line('a', 10, 10),
    [line('b', 20, 20)][0],
    text('t', 30, 30, 'C1'),
  ]);

  it('sends the compact diff — never the drawing or the section', async () => {
    let sent = '';
    const transport = vi.fn(async (req: { messages: Array<{ content: unknown }> }) => {
      sent = JSON.stringify(req.messages);
      return { content: '{"status":"WARNING","issues":[]}', toolCalls: [] };
    });
    const v = validateSection(doc, section({ entityIds: ['a', 'b'] }));
    await reviewMismatches(v, { transport });

    expect(sent).toContain('REGION-01');
    expect(sent).toContain('C1'); // the mismatch itself
    expect(sent).not.toContain('"entities"'); // not the document
    expect(sent.length).toBeLessThan(2000);
  });

  it('drops a verdict about something it was not asked about', () => {
    // A reply naming an id we never raised is not a reading of this section.
    return (async () => {
      const transport = vi.fn(async () => ({
        content: '{"status":"FAIL","issues":[{"id":"C1","reason":"real"},{"id":"INVENTED","reason":"x"}]}',
        toolCalls: [],
      }));
      const v = validateSection(doc, section({ entityIds: ['a', 'b'] }));
      const ai = await reviewMismatches(v, { transport });
      expect(ai!.issues.map((i) => i.id)).toEqual(['C1']);
    })();
  });

  it('may downgrade a clipping artefact, but never a missing handle', async () => {
    // The model can say "that line was just clipped by the boundary" and turn
    // a WARNING into a PASS. It cannot make a lost entity present.
    const many = Array.from({ length: 60 }, (_, i) => line(`L${i}`, i, i));
    const clipped = docOf(many);
    const transport = vi.fn(async () => ({ content: '{"status":"PASS","issues":[]}', toolCalls: [] }));

    const [warned] = await validateSections(
      clipped,
      [section({ entityIds: many.slice(1).map((e) => e.style.handle) })],
      { transport },
    );
    // it HAS a missing handle, so the pass is refused
    expect(warned.missing).toHaveLength(1);
    expect(warned.status).toBe('WARNING');
  });

  it('leaves the deterministic verdict standing when the call fails', async () => {
    const transport = vi.fn(async () => {
      throw new Error('429');
    });
    const [v] = await validateSections(doc, [section({ entityIds: ['a', 'b'] })], { transport });
    expect(v.ai).toBeNull();
    expect(v.status).toBe('FAIL'); // the missing text, decided in code
  });

  it('never escalates at all in offline mode', async () => {
    const transport = vi.fn();
    const [v] = await validateSections(doc, [section({ entityIds: ['a', 'b'] })], {
      transport,
      offline: true,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(v.status).toBe('FAIL');
  });
});

describe('READ → COMPARE → REPORT, never MODIFY', () => {
  it('does not touch the section or the document', async () => {
    // A validator that can also repair is one whose reports you cannot trust:
    // you can no longer tell a section that was right from one it fixed.
    const doc = docOf([line('a', 10, 10), text('t', 30, 30, 'C1')]);
    const s = section({ entityIds: ['a', 'ghost'] });
    const beforeDoc = JSON.stringify(doc.entities);
    const beforeSection = JSON.stringify(s);

    const transport = vi.fn(async () => ({ content: '{"status":"FAIL","issues":[]}', toolCalls: [] }));
    await validateSections(doc, [s], { transport });

    expect(JSON.stringify(doc.entities)).toBe(beforeDoc);
    expect(JSON.stringify(s)).toBe(beforeSection);
  });
});

describe('the report', () => {
  it('says how many sections passed and how many calls it cost', () => {
    const doc = docOf([line('a', 10, 10)]);
    const out = validationReport([
      validateSection(doc, section({ entityIds: ['a'] })),
      validateSection(doc, section({ sectionId: 'REGION-02', entityIds: ['ghost'] })),
    ]).join('\n');
    expect(out).toContain('2 sections');
    expect(out).toContain('1 PASS');
    expect(out).toContain('model calls: 0');
    expect(out).toContain('REGION-02  FAIL');
  });
});

describe('where did each instance of a repeated label go?', () => {
  // FOUR C1s ON THE SHEET, TWO OF THEM HIGHLIGHTED. Three different failures
  // look identical on screen — an unhighlighted label — and the ownership map
  // already distinguishes them, so this never guesses and never calls anything.
  const finalization = (
    ownership: Record<string, { state: string; owner: string }>,
    regions: Array<{ sectionId: string; bounds: SectionBounds }>,
  ) =>
    ({
      regions,
      ownership: new Map(Object.entries(ownership).map(([k, v]) => [k, v])),
    }) as never;

  it('separates the three ways a label goes missing', () => {
    const doc = docOf([
      text('c1', 100, 100, 'C1'), // in REGION-03, and its box covers it
      text('c2', 900, 100, 'C1'), // in REGION-07, and its box covers it
      text('c3', 2000, 100, 'C1'), // owned by REGION-03, whose box does NOT reach it
      text('c4', 3000, 100, 'C1'), // nobody read it
    ]);
    const groups = auditLabels(
      doc,
      finalization(
        {
          c1: { state: 'INITIAL_REGION', owner: 'REGION-03' },
          c2: { state: 'INITIAL_REGION', owner: 'REGION-07' },
          c3: { state: 'SECOND_PASS_REGION', owner: 'REGION-03' },
          c4: { state: 'STILL_UNREAD', owner: 'GAP-01' },
        },
        [
          { sectionId: 'REGION-03', bounds: box(0, 0, 500, 500) },
          { sectionId: 'REGION-07', bounds: box(800, 0, 1200, 500) },
        ],
      ),
    );
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.text).toBe('C1');
    expect(g.total).toBe(4);
    expect(g.inSections).toBe(2);
    expect(g.unaccounted).toBe(2); // ← exactly the two to ask about
    expect(g.inconsistent).toBe(true);
    expect(g.instances.map((i) => i.verdict)).toEqual([
      'in-section',
      'in-section',
      'owned-but-outside-highlight', // ownership is fine; the BOX is the problem
      'never-read', // the first pass never saw it
    ]);
  });

  it('says nothing about a label whose instances all landed correctly', () => {
    // The value is in the disagreement. Four C1s that all landed in sections
    // is not a finding, and reporting it would bury the one that is.
    const doc = docOf([text('a', 100, 100, 'C1'), text('b', 200, 200, 'C1')]);
    const groups = auditLabels(
      doc,
      finalization(
        { a: { state: 'INITIAL_REGION', owner: 'R1' }, b: { state: 'INITIAL_REGION', owner: 'R1' } },
        [{ sectionId: 'R1', bounds: box(0, 0, 500, 500) }],
      ),
      { onlyUnaccounted: true },
    );
    expect(groups).toEqual([]);
    expect(labelAuditReport(groups)[0]).toContain('every repeated label is inside');
  });

  it('ignores a label that appears once — it cannot disagree with itself', () => {
    const doc = docOf([text('a', 100, 100, 'UNIQUE')]);
    expect(
      auditLabels(doc, finalization({ a: { state: 'STILL_UNREAD', owner: 'GAP-01' } }, [])),
    ).toEqual([]);
  });

  it('reports the count comparison in the form the question is asked', () => {
    const doc = docOf([
      text('c1', 100, 100, 'C1'),
      text('c2', 3000, 100, 'C1'),
    ]);
    const out = labelAuditReport(
      auditLabels(
        doc,
        finalization(
          {
            c1: { state: 'INITIAL_REGION', owner: 'REGION-03' },
            c2: { state: 'STILL_UNREAD', owner: 'GAP-01' },
          },
          [{ sectionId: 'REGION-03', bounds: box(0, 0, 500, 500) }],
        ),
      ),
    ).join('\n');
    expect(out).toContain('expected visible instances: 2');
    expect(out).toContain('captured in sections:       1');
    expect(out).toContain('unaccounted:                1');
    expect(out).toContain('ask about ONLY these');
    // and each instance is named with its coordinates, so it can be found
    expect(out).toContain('c2');
    expect(out).toContain('never-read');
  });

  it('does not attach anything — matching on text alone would be wrong', () => {
    // Four columns of a layout plan are four different places. Position and
    // surrounding geometry decide where each belongs, not the string, so this
    // reports and stops.
    const doc = docOf([text('c1', 100, 100, 'C1'), text('c2', 3000, 100, 'C1')]);
    const f = finalization(
      { c1: { state: 'INITIAL_REGION', owner: 'REGION-03' }, c2: { state: 'STILL_UNREAD', owner: 'GAP-01' } },
      [{ sectionId: 'REGION-03', bounds: box(0, 0, 500, 500) }],
    ) as unknown as { ownership: Map<string, unknown>; regions: unknown[] };
    const before = JSON.stringify([...f.ownership]);
    auditLabels(doc, f as never);
    expect(JSON.stringify([...f.ownership])).toBe(before);
  });
});

describe('the deep check — every section, one request each', () => {
  const doc = docOf([line('a', 10, 10), text('t', 30, 30, 'C1')]);
  const three = [
    section({ sectionId: 'REGION-01', entityIds: ['a', 't'] }),
    section({ sectionId: 'REGION-02', entityIds: ['a', 't'] }),
    section({ sectionId: 'REGION-03', entityIds: ['a', 't'] }),
  ];

  it('asks about EVERY section, even the ones that match exactly', async () => {
    // The default mode would skip all three — they are arithmetically clean.
    // `deep` asks a different question: does the section hold what it CLAIMS?
    const transport = vi.fn(async () => ({ content: '{"status":"PASS"}', toolCalls: [] }));
    const out = await validateSections(doc, three, { transport, deep: true });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(out.every((v) => v.ai !== null)).toBe(true);
  });

  it('sends ONE section per request — never the drawing, never a batch', async () => {
    const seen: string[] = [];
    const transport = vi.fn(async (req: { messages: Array<{ content: unknown }> }) => {
      seen.push(String(req.messages[1].content));
      return { content: '{"status":"PASS"}', toolCalls: [] };
    });
    await validateSections(doc, three, { transport, deep: true });

    expect(seen).toHaveLength(3);
    for (const [i, payload] of seen.entries()) {
      expect(payload).toContain(`REGION-0${i + 1}`);
      // no other section in the payload, and nothing like a document dump
      expect(payload).not.toContain(`REGION-0${((i + 1) % 3) + 1}`);
      expect(payload.length).toBeLessThan(2000);
    }
  });

  it('carries the content of BOTH sides, which is the comparison', async () => {
    let payload = '';
    const transport = vi.fn(async (req: { messages: Array<{ content: unknown }> }) => {
      payload = String(req.messages[1].content);
      return { content: '{"status":"PASS"}', toolCalls: [] };
    });
    await validateSections(doc, [three[0]], { transport, deep: true });
    expect(payload).toContain('ORIGINAL AREA');
    expect(payload).toContain('SECTION AS CUT');
    expect(payload).toContain('C1'); // the text itself, both sides
    expect(payload).toContain('DETERMINISTIC DIFF'); // already settled, not re-derived
  });

  it('FAILS a section the model says is missing something', async () => {
    // The case the whole mode exists for: the counts agree and the handles
    // agree, and the column schedule is still missing the column.
    const transport = vi.fn(async () => ({
      content: '{"status":"FAIL","missing":["C1"],"issues":[{"id":"300x300x2000","reason":"size differs"}]}',
      toolCalls: [],
    }));
    const [v] = await validateSections(doc, [three[0]], { transport, deep: true });
    expect(v.status).toBe('FAIL');
    expect(v.ai!.missing).toEqual(['C1']);
    expect(v.ai!.issues[0].id).toBe('300x300x2000');
  });

  it('prints the verdict in the form the question is asked', async () => {
    const replies = ['{"status":"PASS"}', '{"status":"PASS"}', '{"status":"FAIL","missing":["C1"],"issues":[{"id":"dimension 300x300x2000","reason":"value differs"}]}'];
    let n = 0;
    const transport = vi.fn(async () => ({ content: replies[n++], toolCalls: [] }));
    const out = await validateSections(doc, three, { transport, deep: true });
    const report = verdictReport(out).join('\n');
    expect(report).toContain('REGION-01 → PASS');
    expect(report).toContain('REGION-02 → PASS');
    expect(report).toContain('REGION-03 → FAIL');
    expect(report).toContain('  - Missing: C1');
    expect(report).toContain('  - Mismatch: dimension 300x300x2000');
  });

  it('costs nothing in the default mode when everything matches', async () => {
    const transport = vi.fn();
    await validateSections(doc, three, { transport });
    expect(transport).not.toHaveBeenCalled();
  });

  it('still modifies nothing', async () => {
    // READ → COMPARE → REPORT. The model may report a missing mark; it may not
    // move an entity, reassign ownership or invent a section.
    const before = JSON.stringify({ doc: doc.entities, sections: three });
    const transport = vi.fn(async () => ({
      content: '{"status":"FAIL","missing":["C1"],"issues":[]}',
      toolCalls: [],
    }));
    await validateSections(doc, three, { transport, deep: true });
    expect(JSON.stringify({ doc: doc.entities, sections: three })).toBe(before);
  });
});

describe('a FAIL must name what is wrong', () => {
  // THE REGION-05 BUG. Every category PASS, missing=0, extra=0 — and FAIL.
  //
  // Two defects, both in the verdict/report layer:
  //   the rule failed a section on a bare {"status":"FAIL"} with nothing
  //   behind it, and `validationReport` printed only the DETERMINISTIC
  //   mismatch list, so even a justified AI verdict showed no cause.
  //
  // A red verdict with no cause is worse than no verdict: nothing to check,
  // nothing to fix, and no way to tell it from a real fault.
  const doc = docOf([line('a', 10, 10), text('t', 30, 30, 'C1')]);
  const clean = section({ sectionId: 'REGION-05', entityIds: ['a', 't'] });
  const reply = (json: string) => vi.fn(async () => ({ content: json, toolCalls: [] }));

  it('A — every category PASS with nothing named stays PASS, not FAIL', async () => {
    const [v] = await validateSections(doc, [clean], {
      transport: reply('{"status":"FAIL"}'),
      deep: true,
    });
    expect(v.checks).toEqual({
      geometry: 'PASS',
      text: 'PASS',
      dimensions: 'PASS',
      tags: 'PASS',
      ownership: 'PASS',
    });
    expect(v.missing).toEqual([]);
    expect(v.extra).toEqual([]);
    expect(v.status).not.toBe('FAIL');
    // and it says WHY it was not simply believed
    expect(aiReasons(v).join(' ')).toContain('named none');
  });

  it('B — a NAMED semantic fault does fail the section', async () => {
    const [v] = await validateSections(doc, [clean], {
      transport: reply(
        '{"status":"FAIL","missing":[],"issues":[{"id":"SEE TYPICAL DETAIL","reason":"callout belongs to the detail opposite"}]}',
      ),
      deep: true,
    });
    expect(v.status).toBe('FAIL');
    expect(v.ai!.issues[0].id).toBe('SEE TYPICAL DETAIL');
  });

  it('C — the reason reaches BOTH reports', async () => {
    const [v] = await validateSections(doc, [clean], {
      transport: reply(
        '{"status":"FAIL","missing":["C1"],"issues":[{"id":"300x300x2000","reason":"size differs"}]}',
      ),
      deep: true,
    });
    const detailed = validationReport([v]).join('\n');
    expect(detailed).toContain('REGION-05  FAIL');
    expect(detailed).toContain('  reason:');
    expect(detailed).toContain('    - missing: C1');
    expect(detailed).toContain('    - 300x300x2000: size differs');

    const brief = verdictReport([v]).join('\n');
    expect(brief).toContain('REGION-05 → FAIL');
    expect(brief).toContain('- Missing: C1');
    expect(brief).toContain('300x300x2000');
  });

  it('D — eight sections make exactly eight model calls', async () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      section({ sectionId: `REGION-0${i + 1}`, entityIds: ['a', 't'] }),
    );
    const transport = reply('{"status":"PASS"}');
    const out = await validateSections(doc, eight, { transport, deep: true });
    expect(transport).toHaveBeenCalledTimes(8);
    expect(out).toHaveLength(8);
    expect(validationReport(out)).toContain('  model calls: 8');
  });

  it('E — each payload carries only its own section', async () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      section({ sectionId: `REGION-0${i + 1}`, entityIds: ['a', 't'] }),
    );
    const seen: string[] = [];
    const transport = vi.fn(async (req: { messages: Array<{ content: unknown }> }) => {
      seen.push(String(req.messages[1].content));
      return { content: '{"status":"PASS"}', toolCalls: [] };
    });
    await validateSections(doc, eight, { transport, deep: true });
    seen.forEach((payload, i) => {
      expect(payload).toContain(`REGION-0${i + 1}`);
      for (let j = 1; j <= 8; j += 1) {
        if (j !== i + 1) expect(payload).not.toContain(`REGION-0${j}`);
      }
    });
  });

  it('F — a deep run mutates neither the document nor the sections', async () => {
    const sections = [clean, section({ sectionId: 'REGION-06', entityIds: ['a'] })];
    const before = JSON.stringify({ e: doc.entities, s: sections });
    await validateSections(doc, sections, {
      transport: reply('{"status":"FAIL","missing":["C1"],"issues":[]}'),
      deep: true,
    });
    expect(JSON.stringify({ e: doc.entities, s: sections })).toBe(before);
  });

  it('G — the payload stays under 2 KB', async () => {
    let payload = '';
    const transport = vi.fn(async (req: { messages: Array<{ content: unknown }> }) => {
      payload = String(req.messages[1].content);
      return { content: '{"status":"PASS"}', toolCalls: [] };
    });
    await validateSections(doc, [clean], { transport, deep: true });
    expect(payload.length).toBeLessThan(2048);
  });

  it('still cannot declare a genuinely missing entity present', async () => {
    // The one thing the reading may never do. `t` is inside the area and not
    // in the section; no verdict makes it present.
    const [v] = await validateSections(doc, [section({ entityIds: ['a'] })], {
      transport: reply('{"status":"PASS"}'),
      deep: true,
    });
    expect(v.missing).toEqual(['t']);
    expect(v.status).toBe('FAIL');
  });
});
