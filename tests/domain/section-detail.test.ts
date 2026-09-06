// EVERYTHING ONE SECTION SAYS, READ ONCE AND WRITTEN DOWN.
//
// The About Drawing note used to carry five lines per section — id, label,
// bounds, hints — so every dimension, every bar callout and every line of text
// on the sheet stayed in the DXF and nowhere else. Each BBS run then went back
// to the model for what had already been read.
//
// Two properties make this worth having, and both are tested below:
//
//   IT COSTS NOTHING. All of it is already in the file. A test that needed a
//   model here would mean the note was being written by one.
//
//   IT IS VERBATIM. A parsed callout is recorded BESIDE its raw string, never
//   instead of it. A note that has quietly normalised "8 (2L)@100 c/c" into a
//   number is one nobody can check against the sheet.
import { describe, expect, it } from 'vitest';
import { sectionDetail, sectionDetailLines } from '../../src/cad/bbs/sectionDetail';
import type { CadDocument, CadEntity } from '../../src/cad/types';
import type { SectionBounds } from '../../src/cad/understanding/types';

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

const line = (handle: string, x: number, y: number, layer = 'COLS'): CadEntity =>
  ({ type: 'line', a: { x, y }, b: { x: x + 10, y: y + 10 }, style: style(handle, layer) }) as CadEntity;

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

const docOf = (
  entities: CadEntity[],
  dimensions: Array<Record<string, unknown>> = [],
  unitScale = 1,
): CadDocument =>
  ({
    id: 'd',
    name: 'd',
    sourceFile: 'd.dxf',
    unitScale,
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
  }) as unknown as CadDocument;

const AREA = box(0, 0, 500, 500);

// ---------------------------------------------------------------------------

describe('the text of a section', () => {
  it('is verbatim, and in reading order', () => {
    // Down the sheet then across, the way a person reads a drawing — not the
    // order the entities happen to sit in the file.
    const doc = docOf([
      text('c', 10, 100, 'CLEAR COVER 40'),
      text('a', 10, 300, 'TYPICAL COLUMN DETAIL'),
      text('b', 200, 300, '8-16'),
    ]);
    expect(sectionDetail(doc, AREA).text).toEqual([
      'TYPICAL COLUMN DETAIL',
      '8-16',
      'CLEAR COVER 40',
    ]);
  });

  it('takes nothing from outside the section', () => {
    const doc = docOf([text('in', 10, 10, 'MINE'), text('out', 3000, 3000, 'THEIRS')]);
    expect(sectionDetail(doc, AREA).text).toEqual(['MINE']);
  });
});

describe('bar callouts', () => {
  it('records what was parsed BESIDE what was written', () => {
    const doc = docOf([text('a', 10, 100, '8@150c/c'), text('b', 10, 200, '8-16')]);
    const { callouts } = sectionDetail(doc, AREA);
    const spaced = callouts.find((c) => c.raw === '8@150c/c')!;
    expect(spaced.raw).toBe('8@150c/c'); // the sheet's own words survive
    expect(spaced.diaMm).toBe(8);
    expect(spaced.spacingMm).toBe(150);
  });

  it('keeps only text the bar grammar read something out of', () => {
    // "COLUMN LAYOUT PLAN" in the callout list is noise in the one list a
    // reader scans for steel.
    const doc = docOf([text('a', 10, 100, 'COLUMN LAYOUT PLAN'), text('b', 10, 200, '8@150c/c')]);
    const { callouts, text: all } = sectionDetail(doc, AREA);
    expect(callouts.map((c) => c.raw)).toEqual(['8@150c/c']);
    // …and the prose is still kept, under text, where it belongs
    expect(all).toContain('COLUMN LAYOUT PLAN');
  });
});

describe('dimensions', () => {
  const dim = (over: Record<string, unknown> = {}) => ({
    handle: 'D1',
    layer: 'DIMS',
    kind: 'aligned',
    from: { x: 10, y: 10 },
    to: { x: 300, y: 10 },
    textPoint: { x: 150, y: 20 },
    measurement: 290,
    ...over,
  });

  it('takes the ones whose extent falls inside the section', () => {
    const doc = docOf([line('a', 10, 10)], [dim(), dim({ handle: 'D2', from: { x: 3000, y: 3000 }, to: { x: 3200, y: 3000 }, textPoint: { x: 3100, y: 3010 } })]);
    expect(sectionDetail(doc, AREA).dimensions.map((d) => d.handle)).toEqual(['D1']);
  });

  it('keeps the WRITTEN value beside the measured one', () => {
    // A detailer's override outranks the measurement — `annotations.ts` says
    // so, and it is what the yard cuts to. Both are recorded so the note can
    // say which is which rather than quietly keeping one.
    const doc = docOf([line('a', 10, 10)], [dim({ measurement: 290, textOverride: '300' })]);
    const d = sectionDetail(doc, AREA).dimensions[0];
    expect(d.measurementMm).toBe(290);
    expect(d.textOverride).toBe('300');
    expect(sectionDetailLines(sectionDetail(doc, AREA)).join('\n')).toContain(
      'WRITTEN "300", which is what the yard cuts to',
    );
  });

  it('converts to millimetres with the document scale', () => {
    // The record is millimetres throughout; a drawing in centimetres must not
    // report its dimensions ten times short.
    const doc = docOf([line('a', 1, 1)], [dim({ measurement: 29 })], 10);
    expect(sectionDetail(doc, box(0, 0, 5000, 5000)).dimensions[0].measurementMm).toBe(290);
  });
});

describe('what a section is made of', () => {
  it('counts by type and by layer', () => {
    const doc = docOf([
      line('a', 10, 10, 'COLS'),
      line('b', 20, 20, 'COLS'),
      line('c', 30, 30, 'RBAR'),
      text('t', 40, 40, 'C1'),
    ]);
    const d = sectionDetail(doc, AREA);
    expect(d.entityCount).toBe(4);
    expect(d.byType).toEqual([
      { type: 'line', count: 3 },
      { type: 'text', count: 1 },
    ]);
    expect(d.byLayer[0]).toEqual({ layer: 'COLS', count: 2 });
  });
});

describe('the note it renders', () => {
  it('says when a list was cut short, and by how much', () => {
    // A note that silently shows the first forty of ninety is a note that will
    // be trusted for the fifty it did not mention.
    const many = Array.from({ length: 90 }, (_, i) => text(`t${i}`, 10, 400 - i, `LINE ${i}`));
    const lines = sectionDetailLines(sectionDetail(docOf(many), AREA)).join('\n');
    expect(lines).toContain('text, verbatim (90)');
    expect(lines).toContain('… and 30 more');
  });

  it('says plainly when there is nothing of a kind, rather than omitting it', () => {
    // An absent heading reads as "not looked at". A stated absence reads as
    // "looked at, and there was none".
    const lines = sectionDetailLines(sectionDetail(docOf([line('a', 10, 10)]), AREA)).join('\n');
    expect(lines).toContain('bar callouts: none the grammar could read');
    expect(lines).toContain('dimensions: none inside this section');
    expect(lines).toContain('text: none inside this section');
  });
});
