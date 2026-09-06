import { describe, expect, it } from 'vitest';
import { extractTitleBlock } from '../../src/register/titleBlock';
import { BY_LAYER, type CadDocument, type CadText } from '../../src/cad/types';

const text = (handle: string, value: string, x: number, y: number): CadText => ({
  type: 'text', text: value, position: { x, y }, height: 2.5, rotation: 0,
  hAlign: 'left', vAlign: 'baseline', widthFactor: 1, oblique: 0,
  styleName: 'STANDARD', wrapWidth: 0,
  style: { layer: 'TITLE', color: BY_LAYER, lineweight: -1, linetype: '', linetypeScale: 1, transparency: -1, normal: null, handle },
});

const doc = (entities: CadText[]): CadDocument => ({
  id: 'doc-title', name: 'sheet', sourceFile: 'sheet.dxf', unitScale: 1,
  layers: new Map(), linetypes: new Map(), textStyles: new Map(), blocks: new Map(),
  entities, layouts: [], regions: [], diagnostics: [], extents: null,
});

describe('title-block registration', () => {
  it('names and marks a drawing from source text with evidence handles', () => {
    const result = extractTitleBlock(doc([
      text('n', 'DRAWING NO: S-101', 0, 0),
      text('r', 'REV: R7', 0, 10),
      text('d', 'DATE: 19-08-2026', 0, 20),
      text('t', 'TITLE: FOUNDATION LAYOUT', 0, 30),
    ]), 'foundation.dwg');

    expect(result.drawingNumber.value).toBe('S-101');
    expect(result.revision.value).toBe('R7');
    expect(result.title.value).toBe('FOUNDATION LAYOUT');
    expect(result.discipline.value).toBe('structural');
    expect(result.displayName).toBe('S-101 · R7');
    expect(result.drawingNumber.handle).toBe('n');
    expect(result.needsReview).toBe(false);
  });

  it('uses filename fallbacks but keeps incomplete identity in review', () => {
    const result = extractTitleBlock(doc([]), '01-Security Room R5 04-08-2026.dwg');
    expect(result.title.value).toBe('Security Room');
    expect(result.revision.value).toBe('R5');
    expect(result.issueDate.value).toBe('04-08-2026');
    expect(result.needsReview).toBe(true);
  });
});


/**
 * Regressions from a real tender package (Oriental Nagpur, electrical).
 *
 * Every drawing in it entered the register as "no number · rev S · structural",
 * with a phantom entry named "REVISION :". Four separate faults, one visible
 * symptom, and everything above the register — the Tender folder, the revision
 * chains, the practice dashboard — read wrongly because of it.
 */
describe('identity from the filename when the title block cannot be read', () => {
  const bare = () => doc([]);

  it('reads a dash-joined drawing number, which had no fallback at all', () => {
    // title, revision and date each fell back to the filename; the NUMBER did
    // not, so every unreadable title block produced "no number"
    const r = extractTitleBlock(bare(), 'ORI-NAG-TD-EL-02_POWER DISTRIBUTION SCHEME R0.dwg');
    expect(r.drawingNumber.value).toBe('ORI-NAG-TD-EL-02');
    expect(r.revision.value).toBe('R0');
  });

  it('stops the number at the underscore that begins the title', () => {
    // accepting both separators read "ORI-NAG-TD-EL-1.0_MASTER" — the
    // underscore that ENDS a number also looks like part of one
    const r = extractTitleBlock(bare(), 'ORI-NAG-TD-EL-1.0_MASTER SITE LAYOUT PLAN R1.dwg');
    expect(r.drawingNumber.value).toBe('ORI-NAG-TD-EL-1.0');
    expect(r.revision.value).toBe('R1');
  });

  it('takes the trade from the drawing number, not from the drawing body', () => {
    // an electrical site plan mentions foundations and columns constantly;
    // scanning the body with structural tested first filed all four as
    // structural
    for (const f of [
      'ORI-NAG-TD-EL-1.0_MASTER SITE LAYOUT PLAN R0.dwg',
      'ORI-NAG-TD-EL-03_LIGHTNING PROTECTION R0.dwg',
    ]) {
      expect(extractTitleBlock(bare(), f).discipline.value).toBe('mep');
    }
  });

  it('does not invent a number from an ordinary filename', () => {
    // a single word is not a drawing number, and guessing one is worse than
    // leaving the field empty
    expect(extractTitleBlock(bare(), 'Foundations drawings.dxf').drawingNumber.value).toBe('');
  });

  it('never takes one caption as another field’s value', () => {
    // "TITLE" with the caption "REVISION :" beside it produced a drawing
    // called "REVISION : · 00"
    const r = extractTitleBlock(
      doc([text('t', 'TITLE', 0, 0), text('x', 'REVISION :', 30, 0)]),
      'sheet.dxf',
    );
    expect(r.title.value).not.toMatch(/REVISION/i);
  });

  it('prefers a filename revision over a stray letter found by proximity', () => {
    // a lone "S" beside a REV caption beat the correct R0 in the filename,
    // because a proximity hit scored higher than a fallback
    const r = extractTitleBlock(
      doc([text('r', 'REV', 0, 0), text('s', 'S', 20, 0)]),
      'ORI-NAG-TD-EL-02_POWER DISTRIBUTION SCHEME R0.dwg',
    );
    expect(r.revision.value).toBe('R0');
  });
});
