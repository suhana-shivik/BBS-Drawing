// A blocked row that nobody could unblock.
//
// The defect, from a real pedestal run: P1's height was answered as 100 mm.
// The engine cut a 100 mm vertical bar out of it, refused it (a bar shorter
// than its own development length is not a bar) and blocked the row. The row
// then said so in the Status column of a spreadsheet and nowhere else — the
// height was on the record, so nothing re-asked it, and the schedule read
// "blocked — every row is open" with no question a person could answer.
//
// Two things had to be true for that to happen, and both are pinned here: the
// run could not name the answer it had just disproved, and the ledger would
// have refused the correction anyway.

import { describe, expect, it } from 'vitest';
import { axisDisputesFromRun, blamedAxisFromNote, holesForRow } from '../../src/studio/bbsFacts';
import {
  blockedFacts,
  disputeFact,
  emptyLedger,
  recordFact,
  resolveFact,
} from '../../src/facts/ledger';
import { isUsable, type Fact } from '../../src/facts/types';

/** The sentence build.ts's IS 456 cl 26.2.1 gate writes, verbatim in shape. */
const LD_NOTE =
  "this bar comes out 100 mm long, measured along the member's H = 100 mm, which is under the " +
  '752 mm development length a T16 needs to anchor (IS 456 cl 26.2.1) — so it is not a bar, it ' +
  'is a dimension that was read as one. Check "distributionAxis" (the axis the bars are SPACED ' +
  "along; they RUN along its perpendicular) and the member's H.";

const row = (over: Record<string, unknown> = {}) => ({
  id: 'P1-M1',
  barMark: 'P1-M1',
  memberMark: 'P1',
  status: 'unavailable' as const,
  note: LD_NOTE,
  working: [],
  unitWeightKgPerM: null,
  totalBars: null,
  barsPerMember: null,
  memberCount: 250,
  spacingMm: null,
  ...over,
});

const result = (dims: { L?: number; W?: number; H?: number }, rows = [row()]) =>
  ({ members: [{ mark: 'P1', dims }], rows }) as never;

describe('reading which answer the engine disproved', () => {
  it('names the axis, what it holds, and what the bar needed', () => {
    expect(blamedAxisFromNote(LD_NOTE)).toEqual({
      axis: 'H',
      heldMm: 100,
      cameOutMm: 100,
      needsMm: 752,
    });
  });

  it('reads nothing from a note that blames no axis', () => {
    expect(blamedAxisFromNote('the shape code on this callout could not be read')).toBeNull();
  });

  it('still finds no HOLE — which is why the row could never be re-asked', () => {
    // The regression itself. Every axis has a value, so there is no gap to
    // file, and the old code stopped here with the row blocked for good.
    expect(holesForRow(row(), { L: 1000, W: 1000, H: 100 })).toEqual([]);
  });
});

describe('what the run now files instead', () => {
  it('disputes the axis the row blames, quoting the engine and asking again', () => {
    const [dispute] = axisDisputesFromRun(result({ L: 1000, W: 1000, H: 100 }));
    expect(dispute.factId).toBe('P1.height');
    expect(dispute.axis).toBe('H');
    expect(dispute.blocks).toEqual(['P1 row P1-M1']);
    expect(dispute.reason).toBe(LD_NOTE);
    // The question has to carry the value on record: asked "what is the height
    // of P1?" a second time, a person answers 100 again — they already said 100.
    expect(dispute.ask).toContain('100 mm');
    expect(dispute.ask).toContain('752 mm');
    expect(dispute.ask).toMatch(/real height of P1/);
  });

  it('disputes nothing when the axis is simply absent — that is a hole, not a dispute', () => {
    expect(axisDisputesFromRun(result({ L: 1000, W: 1000 }))).toEqual([]);
    expect(holesForRow(row(), { L: 1000, W: 1000 }).map((h) => h.factId)).toEqual(['P1.height']);
  });

  it('gathers every row waiting on one axis into a single question', () => {
    const disputes = axisDisputesFromRun(
      result({ L: 1000, W: 1000, H: 100 }, [row(), row({ id: 'P1-T1', barMark: 'P1-T1' })]),
    );
    expect(disputes).toHaveLength(1);
    expect(disputes[0].blocks).toEqual(['P1 row P1-M1', 'P1 row P1-T1']);
  });

  it('leaves a row that computed alone', () => {
    expect(axisDisputesFromRun(result({ H: 100 }, [row({ status: 'verified' })]))).toEqual([]);
  });
});

describe('the ledger, end to end', () => {
  const answered: Fact = {
    id: 'P1.height',
    value: 100,
    unit: 'mm',
    state: 'SUPPLIED',
    saidAs: '100',
    suppliedBy: 'the client',
    readOn: '2026-09-03',
  };

  it('reopens the answer the schedule disproved, and blocks on it', () => {
    const held = recordFact(emptyLedger(), answered).ledger;
    expect(isUsable(resolveFact(held, 'P1.height')!)).toBe(true);

    const [d] = axisDisputesFromRun(result({ L: 1000, W: 1000, H: 100 }));
    const after = disputeFact(held, 'P1.height', { reason: d.reason, ask: d.ask });

    const fact = resolveFact(after, 'P1.height')!;
    expect(fact.contradicted).toBe(true);
    expect(fact.disputedBecause).toBe(LD_NOTE);
    // It blocks exactly like MISSING — but the value is still there to read.
    expect(isUsable(fact)).toBe(false);
    expect(fact.value).toBe(100);

    const open = blockedFacts(after).find((b) => b.id === 'P1.height')!;
    expect(open.kind).toBe('contradicted');
    // Not "unknown source says 100 — which governs?": the dispute's own ask.
    expect(open.ask).toBe(d.ask);
  });

  it('accepts the corrected number and computes again', () => {
    const held = recordFact(emptyLedger(), answered).ledger;
    const [d] = axisDisputesFromRun(result({ L: 1000, W: 1000, H: 100 }));
    const disputed = disputeFact(held, 'P1.height', { reason: d.reason, ask: d.ask });

    const fixed = recordFact(disputed, { ...answered, value: 1200, saidAs: '1200' });
    expect(fixed.accepted).toBe(true);
    const now = resolveFact(fixed.ledger, 'P1.height')!;
    expect(now.value).toBe(1200);
    expect(isUsable(now)).toBe(true);
    expect(blockedFacts(fixed.ledger)).toEqual([]);
  });

  it('raises one dispute however many times the schedule is re-run', () => {
    const held = recordFact(emptyLedger(), answered).ledger;
    const once = disputeFact(held, 'P1.height', { reason: LD_NOTE, ask: 'a' });
    expect(disputeFact(once, 'P1.height', { reason: LD_NOTE, ask: 'a' })).toBe(once);
  });

  it('does nothing to a fact that was never recorded', () => {
    const l = emptyLedger();
    expect(disputeFact(l, 'P9.height', { reason: 'x', ask: 'y' })).toBe(l);
  });
});

describe('a person correcting their own answer', () => {
  const supplied = (value: number): Fact => ({
    id: 'P1.height',
    value,
    unit: 'mm',
    state: 'SUPPLIED',
    saidAs: String(value),
    readOn: '2026-09-03',
  });

  it('lands — the second answer is the one they mean', () => {
    // Before this, two SUPPLIED claims were equal on trust and the later one
    // was refused, so a mistyped 100 could not be taken back at all.
    const first = recordFact(emptyLedger(), supplied(100)).ledger;
    const second = recordFact(first, supplied(1200));
    expect(second.accepted).toBe(true);
    expect(resolveFact(second.ledger, 'P1.height')!.value).toBe(1200);
  });

  it('keeps the first answer in history rather than erasing it', () => {
    const first = recordFact(emptyLedger(), supplied(100)).ledger;
    const second = recordFact(first, supplied(1200)).ledger;
    const old = second.entries.find((e) => e.fact.value === 100)!;
    expect(old.fact.supersededReason).toBe('user-override');
    expect(old.fact.supersededBy).toBeDefined();
  });

  it('still cannot overrule a MEASURED reading — that rule is untouched', () => {
    const measured = recordFact(emptyLedger(), {
      id: 'C1.height',
      value: 3000,
      unit: 'mm',
      state: 'MEASURED',
      method: 'dimension string on the elevation',
      readOn: '2026-09-03',
    } as Fact).ledger;
    const guess = recordFact(measured, { ...supplied(100), id: 'C1.height' });
    expect(guess.accepted).toBe(false);
    expect(resolveFact(guess.ledger, 'C1.height')!.value).toBe(3000);
  });
});
