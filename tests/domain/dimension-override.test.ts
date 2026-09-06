// A DIMENSION OVERRIDE AS THE SHEET READS, NOT AS THE FILE ENCODES IT.
//
// DXF keeps the override in group 1 with MTEXT formatting inside it, and this
// codebase kept it raw. The cosmetic half was a panel printing
// `{\Fsimplex.shx|c228;L (LENGTH)}` where the sheet says "L (LENGTH)".
//
// The half that costs money: `dimensionValue` reads the FIRST NUMBER out of
// that string. `\A1;{\Fsimplex.shx|c228;2000}` therefore returned 1 — the
// digit in `\A1` — for a dimension the sheet writes as 2000, and a detailer's
// override outranks the measurement, so that 1 went on to be the length.
import { describe, expect, it } from 'vitest';
import { dimensionValue, readDimension } from '../../src/cad/dxf/annotations';
import type { CadDimensionRecord } from '../../src/cad/dxf/annotations';
import type { Record0 } from '../../src/cad/dxf/reader';

/** A DIMENSION record in the shape the reader actually hands over. */
function record(override: string, measurement = 2000): Record0 {
  return {
    type: 'DIMENSION',
    pairs: [
      { code: 5, value: 'ABC' },
      { code: 8, value: 'S-dim' },
      { code: 1, value: override },
      { code: 2, value: '*D1' },
      { code: 70, value: '0' },
      { code: 10, value: '0' },
      { code: 20, value: '0' },
      { code: 11, value: '100' },
      { code: 21, value: '20' },
      { code: 13, value: '0' },
      { code: 23, value: '0' },
      { code: 14, value: '2000' },
      { code: 24, value: '0' },
      { code: 42, value: String(measurement) },
    ],
  };
}

const parse = (override: string, measurement = 2000): CadDimensionRecord =>
  readDimension(record(override, measurement))!;

// ---------------------------------------------------------------------------

describe('the override reads as the sheet reads', () => {
  it('strips the font run a detailer never sees', () => {
    expect(parse('{\\Fsimplex.shx|c228;L (LENGTH)}').textOverride).toBe('L (LENGTH)');
  });

  it('strips an alignment code and keeps the note', () => {
    expect(parse('\\A1;<>{\\C1; }(O/O OF PEDESTAL LINE)').textOverride).toBe(
      '<> (O/O OF PEDESTAL LINE)',
    );
  });

  it('turns a backslash-X break into a space, and leaves the letter X alone', () => {
    // `/\X/` in a regex is just `X` — that pattern would gut "X/Y" and "TYP.X".
    expect(parse('{\\Fsimplex.shx|c228;X/Y \\PTYP.}').textOverride).toBe('X/Y TYP.');
    expect(parse('\\A1;<>\\XTYP.').textOverride).toBe('<> TYP.');
  });

  it('is undefined when the override says nothing of its own', () => {
    expect(parse('<>').textOverride).toBeUndefined();
    expect(parse('').textOverride).toBeUndefined();
    expect(parse('{\\C1;}').textOverride).toBeUndefined();
  });
});

describe('what the yard cuts to', () => {
  it('takes the MEASURED value when the override only annotates it', () => {
    // THE BUG. `\A1;<>{\C1; }(O/O OF PEDESTAL LINE)` says "print the measured
    // value, and add this note". Reading a number out of the note took
    // whichever digit came first — here the 1 of `\A1`.
    expect(dimensionValue(parse('\\A1;<>{\\C1; }(O/O OF PEDESTAL LINE)', 112170))).toBe(112170);
  });

  it('takes the WRITTEN value when the detailer replaced the measurement', () => {
    // The sheet is the contract: 2000 is written, so 2000 is cut — even where
    // the geometry measures 1998.
    expect(dimensionValue(parse('\\A1;{\\Fsimplex.shx|c228;2000}', 1998))).toBe(2000);
  });

  it('never reads a number out of a formatting code', () => {
    // `c228` is a colour. Before cleaning, this returned 228.
    const v = dimensionValue(parse('{\\Fsimplex.shx|c228;L (LENGTH)}', 3865));
    expect(v).not.toBe(228);
    expect(v).toBeNull(); // "L (LENGTH)" states no number, so nothing is asserted
  });

  it('asserts nothing when the override carries no number', () => {
    // "TYP." and "EQ" are real overrides that state no length. Falling back to
    // the measurement would print a figure the sheet does not show.
    expect(dimensionValue(parse('{\\Fsimplex.shx|c228;TYP.}', 100))).toBeNull();
    expect(dimensionValue(parse('\\A1;{\\Fsimplex.shx|c228;D}', 600))).toBeNull();
  });

  it('falls back to the measurement when there is no override at all', () => {
    expect(dimensionValue(parse('', 750))).toBe(750);
  });
});
