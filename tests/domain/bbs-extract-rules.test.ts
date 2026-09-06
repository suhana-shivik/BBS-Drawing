import { describe, expect, it } from 'vitest';
import {
  extractDeclared,
  extractMarks,
  notesFromTexts,
  type TextCell,
} from '../../src/cad/bbs/extract';

/**
 * The extraction upgrades forced by the GAMCO boundary wall sheet.
 *
 * A typical-detail drawing declares its members by name and size — "RCC WALL
 * 200THK.", "TB-(350X400)" — carries its cover as a table, and legislates bar
 * rules in the notes. The old extractor, tuned to schedule tables and "P1"
 * marks, saw three members on a sheet that draws seven kinds and read no
 * cover at all. Each test here is one of those blind spots.
 */

let nextHandle = 0;
function cell(text: string, x = 0, y = 0, height = 3): TextCell {
  nextHandle += 1;
  const w = text.length * height * 0.62;
  return {
    text,
    x,
    y,
    x0: x,
    x1: x + w,
    height,
    rotation: 0,
    layer: '',
    handle: `h${nextHandle}`,
  };
}

describe('declared members — name + size, no schedule table', () => {
  it('reads a mark tied to its cross-section: "TB-(350X400)"', () => {
    const out = extractDeclared([cell('TB-(350X400)')]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('TB');
    expect(out[0].dimsMm).toEqual([350, 400]);
  });

  it('reads a named member with a thickness: "200 THK. RCC WALL"', () => {
    const out = extractDeclared([cell('200 THK. RCC WALL')]);
    expect(out[0]).toMatchObject({ name: 'RCC WALL', dimsMm: [200] });
  });

  it('joins a lone "200THK." line to the name beside it', () => {
    // "RCC WALL" and "200THK." are two lines of one MTEXT on the real sheet
    const out = extractDeclared([cell('RCC WALL', 0, 10), cell('200THK.', 0, 6)]);
    expect(out[0]).toMatchObject({ name: 'RCC WALL', dimsMm: [200] });
  });

  it('joins a bare "(2000x300x50thk)" to the nearest name', () => {
    const out = extractDeclared([cell('PRECAST PANEL', 0, 10), cell('(2000x300x50thk)', 0, 5)]);
    expect(out[0]).toMatchObject({ name: 'PRECAST PANEL', dimsMm: [2000, 300, 50] });
  });

  it('prefers a mark over a farther word when joining a bare size', () => {
    // "(525x350)" beside a C2 tag is C2's section; joining it to some word
    // farther away filed the size under the wrong member on the real sheet
    const out = extractDeclared([
      cell('S.C', 0, 20),
      cell('C2', 0, 11),
      cell('(525x350)', 0, 8),
    ]);
    expect(out[0]).toMatchObject({ name: 'C2', dimsMm: [525, 350] });
  });

  it('takes the mark+size from the tail of a caption it rejects as a name', () => {
    const out = extractDeclared([cell('TYPICAL DETAIL OF SC-350x350')]);
    expect(out[0]).toMatchObject({ name: 'SC', dimsMm: [350, 350] });
  });

  it('refuses title-block noise as a member name', () => {
    // "(350x350)" printed near the consultant's name must not declare a
    // member called STRUCTURAL ENGINEERS
    const out = extractDeclared([cell('STRUCTURAL ENGINEERS', 0, 10), cell('(350x350)', 0, 6)]);
    expect(out).toHaveLength(0);
  });

  it('counts repeats as occurrences of one declaration', () => {
    const out = extractDeclared([cell('TB-(350X400)', 0, 0), cell('TB-(350X400)', 50, 90)]);
    expect(out).toHaveLength(1);
    expect(out[0].occurrences).toBe(2);
  });
});

describe('bare marks corroborated by declarations', () => {
  it('accepts "S.C" as SC once a declaration vouches for it', () => {
    const texts = [cell('S.C'), cell('S.C'), cell('TYPICAL DETAIL OF SC-350x350')];
    const marks = extractMarks(texts, [], extractDeclared(texts));
    expect(marks).toContain('SC');
  });

  it('still refuses a bare token nothing on the sheet vouches for', () => {
    // "TB" with no declaration anywhere is as likely a stray label
    expect(extractMarks([cell('TB'), cell('TB')], [], [])).not.toContain('TB');
  });
});

describe('cover stated as a table', () => {
  const coverSheet = (): TextCell[] => [
    cell('13. MINIMUM CLEAR COVER TO MAIN REINFORCEMENT IS AS FOLLOWS:', 0, 100),
    cell('a. FOUNDATION BEAM & SLAB', 4, 90),
    cell('50', 70, 90),
    cell('b. COLUMN', 4, 84),
    cell('40', 70, 84),
    cell('d. TIE BEAM.', 4, 78),
    cell('30', 70, 78),
  ];

  it('reads member rows with their values', () => {
    const notes = notesFromTexts(coverSheet());
    expect(notes.coverByMember).toEqual([
      expect.objectContaining({ member: 'FOUNDATION BEAM & SLAB', coversMm: [50] }),
      expect.objectContaining({ member: 'COLUMN', coversMm: [40] }),
      expect.objectContaining({ member: 'TIE BEAM.', coversMm: [30] }),
    ]);
  });

  it('leaves the single coverMm UNSET when the sheet tabulates it', () => {
    // there is no one cover; picking the first row would put a foundation
    // cover on a slab bar and nobody would ever see it happen
    expect(notesFromTexts(coverSheet()).coverMm).toBeUndefined();
  });
});

describe('notes that are really rules', () => {
  it('parses distribution, spacer, chairs and lap rules', () => {
    const notes = notesFromTexts([
      cell('8. ALL DISTRIBUTION BARS ARE 8 @ 250 C/C AND TO BE PROVIDED', 0, 40),
      cell('9. ALL CHAIRS ARE 10 AND TO BE PROVIDED WHEREVER REQUIRED.', 0, 36),
      cell('10. ALL SPACER BARS ARE 25 @ 300 C/C AND TO BE PROVIDED', 0, 32),
      cell("11. LAPS, SPLICES & BOND LENGTH SHOULD BE 50 D WHERE 'D' IS", 0, 28),
    ]);
    expect(notes.globalRules).toEqual([
      expect.objectContaining({ kind: 'distribution', diaMm: 8, spacingMm: 250 }),
      expect.objectContaining({ kind: 'chairs', diaMm: 10 }),
      expect.objectContaining({ kind: 'spacer', diaMm: 25, spacingMm: 300 }),
      expect.objectContaining({ kind: 'lap', multiple: 50 }),
    ]);
  });

  it('keeps the verbatim note on every rule, so the rule stays checkable', () => {
    const notes = notesFromTexts([cell('8. ALL DISTRIBUTION BARS ARE 8 @ 250 C/C', 0, 40)]);
    expect(notes.globalRules?.[0].raw).toContain('DISTRIBUTION');
  });
});
