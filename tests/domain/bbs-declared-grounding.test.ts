// Grounding a member from what the sheet DECLARES.
//
// `BBS_DIAGNOSIS.md` §4.4 recorded "RCC WALL 200THK is declared and did not
// ground" as undiagnosed. Change order §6.2 says: write the failing test
// first, from the verbatim declared text, then diagnose.
//
// Two holes, both generality bugs rather than sheet-specific ones:
//   1. the lookup map is keyed by the declared name VERBATIM and queried with
//      `mark.toUpperCase()`, so any office whose declarations are not already
//      upper-case grounds nothing;
//   2. the thickness token family was one spelling. "200THK" grounds and
//      "200 THICK" does not, which is a coin flip on the next drawing.
import { describe, expect, it } from 'vitest';
import { groundDeclaredDims } from '../../src/cad/bbs/build';
import { extractDeclared } from '../../src/cad/bbs/extract';
import type { BbsInterpretation, DeclaredMember } from '../../src/cad/bbs/types';

const declared = (name: string, sizeText: string, dimsMm: number[]): DeclaredMember => ({
  name,
  sizeText,
  dimsMm,
  occurrences: 16,
  raw: `${name} ${sizeText}`,
  handles: [],
});

const member = (mark: string, missing: string[] = ['L', 'W', 'H']): BbsInterpretation => ({
  members: [
    {
      mark,
      type: 'wall',
      count: 1,
      source: { table: '', row: -1 },
      incomplete: true,
      missing,
    },
  ],
  bars: [],
  unresolved: [],
});

describe('grounding from a declaration', () => {
  it('grounds a one-dimension thickness declaration', () => {
    const out = groundDeclaredDims(member('RCC WALL'), [declared('RCC WALL', '200THK', [200])]);
    expect(out.members[0].widthMm).toBe(200);
    expect(out.members[0].missing).not.toContain('W');
  });

  it('grounds regardless of the case the office declares in', () => {
    // the declaration as the sheet spells it, the mark as the model returned it
    const out = groundDeclaredDims(member('Rcc Wall'), [declared('Rcc Wall', '200thk', [200])]);
    expect(out.members[0].widthMm).toBe(200);
  });

  it('grounds a two-dimension declaration into L and W', () => {
    const out = groundDeclaredDims(member('TB'), [declared('TB', '(350X400)', [350, 400])]);
    expect(out.members[0].lengthMm).toBe(400);
    expect(out.members[0].widthMm).toBe(350);
  });

  it('does not overwrite a dimension already resolved', () => {
    const m = member('RCC WALL', ['L', 'H']);
    m.members[0].widthMm = 230;
    const out = groundDeclaredDims(m, [declared('RCC WALL', '200THK', [200])]);
    expect(out.members[0].widthMm).toBe(230);
  });
});

describe('the thickness token family', () => {
  // One test per spelling: a vocabulary miss must never be silent, and the
  // only way to know the vocabulary covers a spelling is to assert it.
  for (const [text, mm] of [
    ['200THK', 200],
    ['200 THK.', 200],
    ['230 THICK', 230],
    ['150THK.', 150],
    ['200 TH.', 200],
  ] as const) {
    it(`reads "${text}" as a ${mm} mm thickness`, () => {
      const cell = (y: number, handle: string) => ({
        text: `RCC WALL ${text}`,
        x: 0,
        y,
        x0: 0,
        x1: 100,
        height: 10,
        rotation: 0,
        handle,
        layer: '0',
      });
      const found = extractDeclared([cell(0, 'H1'), cell(500, 'H2')]);
      const wall = found.find((d: { name: string }) => /WALL/i.test(d.name));
      expect(wall?.dimsMm).toEqual([mm]);
    });
  }
});
