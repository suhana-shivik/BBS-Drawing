// What counts as an answer to a question about a number.
//
// The old parser took the first number it could find anywhere in the reply.
// That is generous in the wrong direction: "about 900" became 900 and "900 to
// 1200" became 900, and once either is in a cell nothing downstream can tell
// it from a dimension somebody measured. A hedge and a range are refusals to
// commit, and the schedule has a first-class way to record those — skip, which
// files a named gap. Guessing on the user's behalf is the one thing this
// module exists not to do.

import { describe, expect, it } from 'vitest';
import { applyAnswer, type AskableQuestion } from '../../src/cad/bbs/askFrom';

const mm: AskableQuestion = {
  id: 'geometry:P1:H',
  question: 'What is the height of P1?',
  why: 'every vertical bar is cut from it',
  blocks: ['P1'],
  evidence: [],
  answerType: 'number-mm',
  writesTo: { memberMark: 'P1', field: 'H' },
};

const count: AskableQuestion = { ...mm, answerType: 'number-count', writesTo: { memberMark: 'P1', field: 'count' } };

const err = (q: AskableQuestion, raw: string): string => {
  const out = applyAnswer(q, raw);
  if (!('error' in out)) throw new Error(`"${raw}" was accepted as ${JSON.stringify(out)}`);
  return out.error;
};

const mmOf = (raw: string): number | undefined => {
  const out = applyAnswer(mm, raw);
  if ('error' in out) throw new Error(`"${raw}" was rejected: ${out.error}`);
  return out.mm;
};

describe('a figure, said plainly', () => {
  it('takes a bare number', () => {
    expect(mmOf('900')).toBe(900);
    expect(mmOf('1200.5')).toBe(1200.5);
  });

  it('takes a thousands separator and a unit — those do not change the figure', () => {
    expect(mmOf('1,200')).toBe(1200);
    expect(mmOf('900 mm')).toBe(900);
    expect(mmOf('1.2 m')).toBe(1200);
  });

  it('takes a count', () => {
    const out = applyAnswer(count, '250');
    expect(out).toMatchObject({ count: 250, field: 'count', memberMark: 'P1' });
  });
});

describe('an estimate is not a measurement', () => {
  it.each(['about 900', 'approx 900', 'roughly 900', '~900', 'say 900', 'probably 900'])(
    'refuses %s',
    (said) => {
      expect(err(mm, said)).toMatch(/estimate, not a measurement/);
    },
  );

  it('refuses a bound offered in place of the value', () => {
    expect(err(mm, 'at least 900')).toMatch(/estimate/);
    expect(err(mm, 'up to 900')).toMatch(/estimate/);
    expect(err(mm, 'min 900')).toMatch(/estimate/);
  });

  it('names the figure it would have taken, so the fix is one keystroke', () => {
    expect(err(mm, 'about 900')).toContain('(900)');
  });

  it('refuses a hedged count too', () => {
    expect(err(count, 'around 250')).toMatch(/estimate/);
  });
});

describe('one question, one figure', () => {
  it('refuses a range instead of silently taking its lower end', () => {
    const message = err(mm, '900 to 1200');
    expect(message).toMatch(/carries 2 numbers/);
    expect(message).toContain('900, 1200');
  });

  it('refuses two values offered as alternatives', () => {
    expect(err(mm, '900 or 1000')).toMatch(/carries 2 numbers/);
  });

  it('refuses a reply with no number at all', () => {
    expect(err(mm, 'nine hundred')).toMatch(/carries no number/);
    expect(err(mm, 'see the section')).toMatch(/carries no number/);
  });
});

describe('what the guard must not refuse', () => {
  it('leaves an ordinary figure alone even when the words around it contain a hedge letter-run', () => {
    // "scaled" contains "ca", "essay" contains "say" — a word-boundary-less
    // guard rejected both, which would make a legitimate answer unenterable.
    expect(mmOf('900 scaled')).toBe(900);
    expect(mmOf('900 (cast in place)')).toBe(900);
  });

  it('still refuses a zero or a negative — that gate is unchanged', () => {
    expect(err(mm, '0')).toMatch(/not a usable measurement/);
    expect(err(mm, '-900')).toMatch(/not a usable measurement/);
  });

  it('still refuses a fractional count', () => {
    expect(err(count, '3.5')).toMatch(/not a count/);
  });
});
