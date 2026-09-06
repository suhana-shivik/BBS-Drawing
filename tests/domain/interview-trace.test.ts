import { describe, expect, it } from 'vitest';
import {
  discardReport,
  numberAppears,
  traceFacts,
  userValueInDrawingRef,
  type CandidateFact,
  type TranscriptLine,
} from '../../src/interview/trace';

const said = (role: TranscriptLine['role'], text: string): TranscriptLine => ({ role, text });

const conversation: TranscriptLine[] = [
  said('user', 'give me the BBS for the boundary wall'),
  said('assistant', 'What is the total run of this structure, in metres?'),
  said('user', 'the run is 100 m'),
  said('assistant', "What is C1's height?"),
  said('user', '1200'),
];

describe('§7.1 — a value enters only as a transcript-traced user fact', () => {
  it('applies a value the user actually said, carrying the line it was said in', () => {
    const { applied, discarded } = traceFacts(
      [{ factId: 'C1.height', value: 1200 }],
      conversation,
    );
    expect(discarded).toHaveLength(0);
    expect(applied).toHaveLength(1);
    expect(applied[0].saidAs).toBe('1200');
    expect(applied[0].lineIndex).toBe(4);
  });

  it('DISCARDS a value that never appeared in the conversation, with the reason', () => {
    const { applied, discarded } = traceFacts(
      [{ factId: 'F1.depth', value: 900, saidAs: 'the client said 900' }],
      conversation,
    );
    expect(applied).toHaveLength(0);
    expect(discarded).toHaveLength(1);
    expect(discarded[0].reason).toMatch(/never appeared in the conversation and was DISCARDED/);
    expect(discardReport(discarded)).toMatch(/DISCARDED/);
  });

  it('discards a value the ASSISTANT volunteered and the user never confirmed', () => {
    const withOffer: TranscriptLine[] = [
      ...conversation,
      said('assistant', 'I will assume the footing depth is 900 mm unless you say otherwise.'),
    ];
    const { applied, discarded } = traceFacts([{ factId: 'F1.depth', value: 900 }], withOffer);
    expect(applied).toHaveLength(0);
    expect(discarded[0].reason).toMatch(/only in your own message/);

    // and it stands the moment the user says it themselves
    const confirmed = traceFacts(
      [{ factId: 'F1.depth', value: 900 }],
      [...withOffer, said('user', 'yes, 900')],
    );
    expect(confirmed.applied).toHaveLength(1);
  });

  it('reads a metre answer and a millimetre fact as the same fact', () => {
    const { applied } = traceFacts([{ factId: 'wall.total_run', value: 100000 }], conversation);
    expect(applied).toHaveLength(1);
    expect(applied[0].saidAs).toBe('the run is 100 m');
  });

  it('does not accept a near miss hiding inside a longer number', () => {
    expect(numberAppears('the pitch is 3000', 300)).toBe(false);
    expect(numberAppears('the pitch is 3000', 3000)).toBe(true);
    expect(numberAppears('spans 1,200 mm', 1200)).toBe(true);
  });

  it('checks a short string answer against the user\'s own words too', () => {
    const chat = [said('user', 'it repeats at a regular pitch')];
    expect(traceFacts([{ factId: 'C1.placement', value: 'it repeats at a regular pitch' }], chat).applied)
      .toHaveLength(1);
    expect(traceFacts([{ factId: 'C1.placement', value: 'there is only one' }], chat).discarded)
      .toHaveLength(1);
  });

  it('refuses a value that is not a number or a short string', () => {
    const bad = [{ factId: 'C1.height', value: { mm: 1200 } }] as unknown as CandidateFact[];
    expect(traceFacts(bad, conversation).discarded[0].reason).toMatch(/number or a short string/);
  });
});

describe('§7.1 — a user value may never ride inside a reference that points at the drawing', () => {
  it('names each drawing ref kind as illegal for a user value', () => {
    for (const kind of ['entity-number', 'table-number', 'difference', 'dimension-path']) {
      expect(userValueInDrawingRef({ kind })).toMatch(/user-fact/);
    }
  });

  it('allows a user-fact ref, and only a well-formed one', () => {
    expect(userValueInDrawingRef({ kind: 'user-fact', factId: 'run' })).toBeNull();
    expect(userValueInDrawingRef({ kind: 'user-fact' })).toMatch(/must name the factId/);
    expect(userValueInDrawingRef(undefined)).toBeNull();
    expect(userValueInDrawingRef({ kind: 'made-up' })).toMatch(/not a reference kind/);
  });

  it('DISCARDS a traced value smuggled into a drawing reference', () => {
    const { applied, discarded } = traceFacts(
      [
        {
          factId: 'C1.height',
          value: 1200,
          ref: { kind: 'entity-number', evidenceId: 'DIM-017', part: 1 },
        },
      ],
      conversation,
    );
    expect(applied).toHaveLength(0);
    expect(discarded[0].reason).toMatch(/says the number is printed on the drawing/);
  });

  it('refuses a user-fact ref pointing at a different fact than the value lands under', () => {
    const { discarded } = traceFacts(
      [{ factId: 'C1.height', value: 1200, ref: { kind: 'user-fact', factId: 'f1_depth' } }],
      conversation,
    );
    expect(discarded[0].reason).toMatch(/one of them is wrong/);
  });

  it('keeps a legitimate user-fact ref', () => {
    const { applied } = traceFacts(
      [{ factId: 'C1.height', value: 1200, ref: { kind: 'user-fact', factId: 'C1.height' } }],
      conversation,
    );
    expect(applied).toHaveLength(1);
  });
});
