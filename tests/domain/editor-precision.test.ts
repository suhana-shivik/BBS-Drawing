// The typed-coordinate grammar — EDITOR_TOOLS_NOTE §7.
//
// One buffer, four forms. Every point-based tool gets a keyboard path through
// this and nothing else, so the grammar is the contract.
import { describe, expect, it } from 'vitest';
import { parseNumberInput, parsePrecisionInput } from '../../src/editor/precision';

const ref = { x: 1000, y: 500 };
/** the live (already angle-snapped) cursor: due north of ref */
const dir = { x: 1000, y: 4000 };

const near = (v: number, want: number) => expect(v).toBeCloseTo(want, 6);

describe('precision grammar (§7)', () => {
  it('"500" is 500 mm along the current implied direction', () => {
    const p = parsePrecisionInput('500', ref, dir)!;
    near(p.x, 1000);
    near(p.y, 1000);
  });

  it('"300,150" is a relative dx,dy from the last point', () => {
    expect(parsePrecisionInput('300,150', ref, dir)).toEqual({ x: 1300, y: 650 });
  });

  it('"@300,150" means the same — the @ is accepted and optional', () => {
    expect(parsePrecisionInput('@300,150', ref, dir)).toEqual(
      parsePrecisionInput('300,150', ref, dir),
    );
  });

  it('"500a90" is 500 mm at 90°, CCW from +x like every other model angle', () => {
    const p = parsePrecisionInput('500a90', ref, dir)!;
    near(p.x, 1000);
    near(p.y, 1000);
    const west = parsePrecisionInput('500a180', ref, dir)!;
    near(west.x, 500);
    near(west.y, 500);
  });

  it('accepts negatives and decimals in every form', () => {
    expect(parsePrecisionInput('-300,-150', ref, dir)).toEqual({ x: 700, y: 350 });
    const p = parsePrecisionInput('250.5a0', ref, dir)!;
    near(p.x, 1250.5);
    near(p.y, 500);
  });

  it('returns null while the buffer is incomplete or not a coordinate', () => {
    for (const s of ['', '@', '300,', 'a90', '500a', 'w', '1,2,3']) {
      expect(parsePrecisionInput(s, ref, dir)).toBeNull();
    }
  });

  it('a bare distance needs a direction to resolve against', () => {
    expect(parsePrecisionInput('500', ref, ref)).toBeNull();
  });

  it('parseNumberInput takes the bare factor/angle the transforms type', () => {
    expect(parseNumberInput('1.75')).toBe(1.75);
    expect(parseNumberInput('-90')).toBe(-90);
    // a coordinate is NOT a number: the transform path must keep editing
    expect(parseNumberInput('300,150')).toBeNull();
    expect(parseNumberInput('500a90')).toBeNull();
    expect(parseNumberInput('')).toBeNull();
  });
});
