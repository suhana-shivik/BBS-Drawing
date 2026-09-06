// "Is this unread part needed for the schedule?" — and the honest answer when
// nothing can tell.
//
// There are two verdicts and deliberately not three. `required` is asserted
// only from a bar the callout grammar actually READ, which is a fact about
// what is written on the drawing. Everything else is `unknown`, shown as
// "Unknown / Needs Review".
//
// There is no `not-required`, and that is the point of this file. The only way
// to reach one would be a layer-name rule, and `coverage.ts` says plainly why
// this project refuses those — they are "wrong on the next drawing's layer
// names". An unread part quietly marked irrelevant is a missed quantity nobody
// was told about.

import { describe, expect, it } from 'vitest';
import { bbsVerdict } from '../../src/studio/realData';

describe('the schedule verdict on an unread part', () => {
  it('is required when the grammar read a bar out of the text in it', () => {
    const v = bbsVerdict(['T16@150 C/C']);
    expect(v.bbs).toBe('required');
    // The basis quotes the evidence, so the reader can check the call.
    expect(v.bbsBasis).toContain('"T16@150 C/C"');
  });

  it('quotes every callout it found, not just the first', () => {
    expect(bbsVerdict(['T16@150 C/C', '8 (2L)@100']).bbsBasis).toContain('"8 (2L)@100"');
  });

  it('is Unknown — never "not required" — when nothing readable is there', () => {
    const v = bbsVerdict([]);
    expect(v.bbs).toBe('unknown');
    expect(v.bbsBasis).toMatch(/no bar callout/i);
  });

  it('has no third verdict: nothing can answer "this does not matter"', () => {
    // Whatever it is handed, the answer is one of two — and the negative is
    // not among them.
    for (const input of [[], ['NORTH'], ['T16@150'], ['', 'x']]) {
      expect(['required', 'unknown']).toContain(bbsVerdict(input).bbs);
    }
  });
});
