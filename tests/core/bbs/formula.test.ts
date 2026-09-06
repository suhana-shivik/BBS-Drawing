// A CUSTOM FORMULA IS A PERSON'S ARITHMETIC, NOT A PROGRAM.
//
// The parser admits the seven engineering variables, arithmetic, and a few
// rounding functions. Everything else is refused by name. There is no eval
// anywhere in the path — the tests below feed it what an injection would look
// like and expect a refusal, not an execution.
import { describe, expect, it } from 'vitest';
import { evaluateFormula, FORMULA_VARIABLES } from '../../../calculations/formula';

const vars = { L: 2500, W: 2300, H: 350, T: 350, S: 150, COVER: 40, DIA: 10 };

describe('a formula over the approved variables', () => {
  it('evaluates the AUTO_SPACING rule written by hand', () => {
    const r = evaluateFormula('CEIL((L - 2 * COVER) / S) + 1', vars);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(Math.ceil((2500 - 80) / 150) + 1);
    expect(r.used.sort()).toEqual(['COVER', 'L', 'S']);
    expect(r.working).toContain('L=2500');
  });

  it('evaluates a cutting-length rule with diameter multiples', () => {
    const r = evaluateFormula('2 * (W - 2 * COVER) + 20 * DIA', vars);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(2 * (2300 - 80) + 200);
  });

  it('respects precedence, unary minus, powers and nested functions', () => {
    expect(evaluateFormula('2 + 3 * 4', {}).value).toBe(14);
    expect(evaluateFormula('(2 + 3) * 4', {}).value).toBe(20);
    expect(evaluateFormula('-DIA + 30', vars).value).toBe(20);
    expect(evaluateFormula('2 ^ 3 ^ 2', {}).value).toBe(512);
    expect(evaluateFormula('MAX(MIN(L, W), H)', vars).value).toBe(2300);
    expect(evaluateFormula('SQRT(ABS(-16))', {}).value).toBe(4);
  });

  it('accepts the typographic operators a schedule is typed with', () => {
    expect(evaluateFormula('2 × (L − 2 × COVER) ÷ 2', vars).value).toBe(2500 - 80);
  });

  it('is case-insensitive about names', () => {
    expect(evaluateFormula('l - 2 * cover', vars).value).toBe(2420);
  });
});

describe('what it refuses', () => {
  it('an identifier that is not on the list, by name', () => {
    const r = evaluateFormula('L * SECRET', vars);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('"SECRET"');
    expect(r.reason).toContain(FORMULA_VARIABLES.join(', '));
  });

  it('anything that looks like code', () => {
    for (const bad of [
      'process.exit(1)',
      'require("fs")',
      'globalThis',
      'L; W',
      'L => W',
      'constructor',
      '`${L}`',
      'L[0]',
      'L = 5',
      '"text"',
    ]) {
      const r = evaluateFormula(bad, vars);
      expect(r.ok, bad).toBe(false);
    }
  });

  it('a variable the row cannot supply — naming it, so the row can wait on it', () => {
    const r = evaluateFormula('L / S + 1', { S: 150 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('L is not on record for this row');
    expect(r.used).toContain('L');
  });

  it('malformed arithmetic', () => {
    expect(evaluateFormula('(L + W', vars).ok).toBe(false);
    expect(evaluateFormula('L + W)', vars).ok).toBe(false);
    expect(evaluateFormula('L +', vars).ok).toBe(false);
    expect(evaluateFormula('L W', vars).ok).toBe(false);
    expect(evaluateFormula('', vars).ok).toBe(false);
    expect(evaluateFormula('MAX(L)', vars).ok).toBe(false);
  });

  it('division by zero', () => {
    const r = evaluateFormula('L / (S - 150)', vars);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('division by zero');
  });
});
