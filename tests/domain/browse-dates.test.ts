// When a thing arrived, said in the list and sorted by.
//
// The register holds three different events — a drawing's import, an output's
// filing, a section package's build — and the Files view asks one question of
// all three: when did this land? These tests pin the two rules that makes
// safe: a node with no time NEVER borrows one, and times sort as times.

import { describe, expect, it } from 'vitest';
import { compareNodes, dateLine } from '../../src/studio/browse';
import type { RegisterNode, StudioData } from '../../src/studio/data';

const DATA = { sheets: {}, groups: [] } as unknown as StudioData;

const file = (id: string, at?: number): RegisterNode => ({
  kind: 'file',
  id,
  name: id,
  state: 'ok',
  ...(at === undefined ? {} : { at }),
});

describe('dateLine', () => {
  it('prints a date and a 24-hour clock', () => {
    // Asserted by shape, not by string: the reader's zone moves the figures.
    expect(dateLine(file('a', Date.UTC(2026, 7, 12, 9, 24)))).toMatch(
      /^\d{2} \w{3} \d{4}, \d{2}:\d{2}$/,
    );
  });

  it('says nothing rather than inventing a time', () => {
    expect(dateLine(file('a'))).toBe('—');
    expect(dateLine(file('a', Number.NaN))).toBe('—');
    expect(dateLine(file('a', Number.POSITIVE_INFINITY))).toBe('—');
  });
});

describe('sorting by date', () => {
  const older = file('older', Date.UTC(2026, 0, 1, 8, 0));
  const newer = file('newer', Date.UTC(2026, 7, 30, 8, 0));
  const undated = file('undated');

  it('compares as time, not as the text it prints', () => {
    // "01 Jan 2026" sorts before "30 Aug 2026" — as strings, "3" beats "0".
    expect(compareNodes(DATA, older, newer, 'date', false)).toBeLessThan(0);
    expect(compareNodes(DATA, newer, older, 'date', false)).toBeGreaterThan(0);
  });

  it('reverses on a descending column', () => {
    expect(compareNodes(DATA, older, newer, 'date', true)).toBeGreaterThan(0);
  });

  it('puts a node with no time last, never first', () => {
    // Ascending is oldest-first; something undated is not the oldest thing
    // in the folder, it is a thing the register cannot date.
    expect(compareNodes(DATA, undated, older, 'date', false)).toBeGreaterThan(0);
  });
});
