// Reading the bytes a model sent — before anything judges what they mean.
//
// A live run lost two twelve-thousand-character replies because the reader
// took `slice(indexOf('{'), lastIndexOf('}'))`, and the lead had written a
// sentence of narration before its JSON. Nothing was malformed; nothing was
// refused; the work was simply never read, and nobody was told.
import { describe, expect, it } from 'vitest';
import { extractJsonObject, parseModelJson } from '../../src/cad/ai/openrouter';

describe('reading a model reply', () => {
  it('reads a bare object', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads an object behind a sentence of narration — the Run 019 shape', () => {
    const raw =
      'Reading the board: ten investigations have reported and nothing is recorded yet. ' +
      "I'll record what is settled (SC, C1, wall verticals) and send investigators after the rest.\n\n" +
      '{"conclusions":[{"kind":"own","calloutId":"CALL-009","memberId":"MEM-01"}]}';
    const out = parseModelJson(raw) as { conclusions: { calloutId: string }[] };
    expect(out.conclusions[0].calloutId).toBe('CALL-009');
  });

  it('reads an object with prose AFTER it, even when that prose has braces', () => {
    const raw = '{"done":{"why":"finished"}}\n\nNote: the {C1} detail still needs a crop.';
    expect(parseModelJson(raw)).toEqual({ done: { why: 'finished' } });
  });

  it('is not fooled by braces inside strings', () => {
    const raw = '{"why":"the } character appears here","n":2}';
    expect(parseModelJson(raw)).toEqual({ why: 'the } character appears here', n: 2 });
  });

  it('is not fooled by an escaped quote before a brace', () => {
    const raw = '{"why":"he said \\"stop}\\" and left","n":3} trailing prose';
    expect(parseModelJson(raw)).toEqual({ why: 'he said "stop}" and left', n: 3 });
  });

  it('reads a fenced object', () => {
    expect(parseModelJson('```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
  });

  it('returns null for a genuinely truncated object rather than guessing at it', () => {
    expect(extractJsonObject('{"conclusions":[{"kind":"own"')).toBeNull();
    expect(parseModelJson('{"conclusions":[{"kind":"own"')).toBeNull();
  });

  it('returns null when there is no object at all', () => {
    expect(parseModelJson('I could not answer that.')).toBeNull();
    expect(parseModelJson('')).toBeNull();
    expect(parseModelJson(null)).toBeNull();
  });

  it('takes the FIRST complete object, not a later one', () => {
    expect(parseModelJson('{"first":true} then {"second":true}')).toEqual({ first: true });
  });
});
