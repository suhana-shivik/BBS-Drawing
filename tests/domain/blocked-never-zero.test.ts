// A blocked row's figures must be EMPTY everywhere, not zero.
//
// The schedule prints its own convention at the top of every workbook: "Open
// rows carry no quantity — a blocked cell is EMPTY, never zero, and is in no
// total below." The rows honoured it; one column did not. `Number(r.unitWeightKgPerM ?? 0)`
// turned a blocked row's absent unit weight into 0.000 kg/m, printed beside an
// empty weight — and a unit weight is a property of a diameter (d² ÷ 162), so
// zero is not a small inaccuracy. It is the one value that column can never
// legitimately hold, announcing itself as a reading.

import { describe, expect, it } from 'vitest';
import { steelLines } from '../../src/io/bbsWorkbook';
import type { BbsChatResult } from '../../src/cad/bbs/chatResult';

const row = (over: Record<string, unknown> = {}) =>
  ({
    id: 'F2-M1',
    barMark: 'F2-M1',
    memberMark: 'F2',
    description: 'main bar',
    diameterMm: 10,
    unitWeightKgPerM: null,
    cuttingLengthMm: undefined,
    totalLengthM: undefined,
    totalWeightKg: undefined,
    totalBars: undefined,
    working: [],
    evidenceIds: [],
    status: 'unavailable',
    note: 'this drawing declares the cutting length a design input',
    ...over,
  }) as never;

const resultOf = (rows: unknown[]): BbsChatResult =>
  ({ rows, members: [], summary: [], totals: {} }) as unknown as BbsChatResult;

describe('a diameter whose every row is blocked', () => {
  const { lines } = steelLines(resultOf([row(), row({ id: 'F3-M1', barMark: 'F3-M1' })]));
  const ten = lines.find((l) => l.diaMm === 10)!;

  it('is still LISTED — that a 10 mm bar exists is a fact the drawing states', () => {
    expect(ten).toBeDefined();
    expect(ten.openRows).toBe(2);
  });

  it('carries no quantity at all — every figure empty, none of them zero', () => {
    expect(ten.barCount).toBeNull();
    expect(ten.totalLengthM).toBeNull();
    expect(ten.totalWeightKg).toBeNull();
    expect(ten.totalWeightWithWastageKg).toBeNull();
  });

  it('leaves the unit weight empty rather than printing 0.000 kg/m', () => {
    expect(ten.unitWeightKgPerM).toBeNull();
    expect(ten.unitWeightKgPerM).not.toBe(0);
  });
});

describe('a diameter with one computed row and one blocked', () => {
  const { lines } = steelLines(
    resultOf([
      row(),
      row({
        id: 'F4-M1',
        barMark: 'F4-M1',
        memberMark: 'F4',
        status: 'verified',
        note: undefined,
        unitWeightKgPerM: 0.888,
        cuttingLengthMm: 900,
        totalLengthM: 43.2,
        totalWeightKg: 38.36,
        totalBars: 48,
      }),
    ]),
  );
  const ten = lines.find((l) => l.diaMm === 10)!;

  it('takes the unit weight from the row that HAS one, whichever order they arrive in', () => {
    // The blocked row is first. Reading the unit weight off whichever row came
    // first put a null into the summary of a diameter that was partly computed.
    expect(ten.unitWeightKgPerM).toBe(0.888);
  });

  it('totals only the computed row, and still says one is open', () => {
    expect(ten.totalWeightKg).toBeCloseTo(38.36, 2);
    expect(ten.totalLengthM).toBeCloseTo(43.2, 2);
    expect(ten.openRows).toBe(1);
  });
});
