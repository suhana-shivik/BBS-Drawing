import { describe, expect, it } from 'vitest';
import {
  computeWhenResolved,
  renderBlockedRow,
  type BlockedRow,
} from '../../src/facts/blocked';
import { addFact, emptyLedger, supplyFact, type Ledger } from '../../src/facts/ledger';
import { requiredFactsFor } from '../../src/facts/required';
import type { Fact } from '../../src/facts/types';

const READ_ON = '2026-08-29';

// The TB-16 row from HOW_TO_BUILD_IT §6.4: everything measured off GW-01
// except the wall extent, which lives on an architectural drawing not in
// the register.
const TB16_ROW: BlockedRow = {
  formula:
    'number  4 per span × ⌈ wall.total_run / 4157 ⌉ spans\n' +
    'weight  4407 mm × 1.580 kg/m × [number]',
  missingFactIds: ['wall.total_run'],
  ask: ['What is the total run of the boundary wall?'],
};

function ledgerWithMissingRun(): Ledger {
  return addFact(emptyLedger(), {
    id: 'wall.total_run',
    value: null,
    state: 'MISSING',
    neededFor: ['span count', 'bar numbers', 'steel weight'],
    lookedIn: ['ARCH-101, ARCH-102 (not in register)'],
    ask: 'What is the total run of the boundary wall?',
    readOn: READ_ON,
  });
}

describe('blocked rows (§6.4)', () => {
  it('a MISSING dependency blocks the row and names its hole', () => {
    const result = computeWhenResolved(TB16_ROW, ledgerWithMissingRun(), () => 0);
    expect(result.computed).toBe(false);
    if (!result.computed) expect(result.missing).toEqual(['wall.total_run']);
  });

  it('a dependency absent from the ledger entirely also blocks', () => {
    const result = computeWhenResolved(TB16_ROW, emptyLedger(), () => 0);
    expect(result.computed).toBe(false);
    if (!result.computed) expect(result.missing).toEqual(['wall.total_run']);
  });

  it('renderBlockedRow emits the formula with the hole named, where it was searched, and what to ask', () => {
    const text = renderBlockedRow(TB16_ROW, ledgerWithMissingRun());
    expect(text).toBe(
      'number  4 per span × ⌈ wall.total_run / 4157 ⌉ spans\n' +
        'weight  4407 mm × 1.580 kg/m × [number]\n' +
        '⚠ BLOCKED — wall.total_run is MISSING\n' +
        '  needed for:  span count, bar numbers, steel weight\n' +
        '  searched:    ARCH-101, ARCH-102 (not in register)\n' +
        '  ask:         "What is the total run of the boundary wall?"',
    );
  });

  it('renderBlockedRow falls back to the row ask when the ledger has no entry', () => {
    const text = renderBlockedRow(TB16_ROW, emptyLedger());
    expect(text).toContain('⚠ BLOCKED — wall.total_run is MISSING');
    expect(text).toContain('ask:         "What is the total run of the boundary wall?"');
  });

  it('the moment the fact is supplied, the number computes with no re-reading', () => {
    const supplied = supplyFact(ledgerWithMissingRun(), 'wall.total_run', {
      value: 100000,
      unit: 'mm',
      suppliedBy: 'client email',
      on: '2026-08-30',
    });

    // The compute callback sees only ledger facts — no drawing is touched.
    const result = computeWhenResolved(TB16_ROW, supplied, (facts) => {
      const run = facts['wall.total_run'].value as number;
      const spans = Math.ceil(run / 4157);
      return 4 * spans; // bars
    });

    expect(result.computed).toBe(true);
    if (result.computed) {
      expect(result.value).toBe(4 * Math.ceil(100000 / 4157)); // 100 bars
      expect(result.facts['wall.total_run'].state).toBe('SUPPLIED');
    }
  });

  it('computes only when EVERY dependency is non-MISSING', () => {
    const row: BlockedRow = {
      formula: 'corner bars  2 × wall.corners × extra, spans from wall.total_run',
      missingFactIds: ['wall.total_run', 'wall.corners'],
      ask: [
        'What is the total run of the boundary wall?',
        'How many corners does the wall turn?',
      ],
    };

    let ledger = ledgerWithMissingRun();
    ledger = addFact(ledger, {
      id: 'wall.corners',
      value: null,
      state: 'MISSING',
      lookedIn: ['ARCH-101'],
      ask: 'How many corners does the wall turn?',
      readOn: READ_ON,
    });

    // One of two supplied: still blocked, and the remaining hole is named.
    ledger = supplyFact(ledger, 'wall.total_run', {
      value: 100000,
      unit: 'mm',
      suppliedBy: 'client email',
    });
    const partial = computeWhenResolved(row, ledger, () => 1);
    expect(partial.computed).toBe(false);
    if (!partial.computed) expect(partial.missing).toEqual(['wall.corners']);

    // Both supplied: computes.
    ledger = supplyFact(ledger, 'wall.corners', { value: 4, suppliedBy: 'client email' });
    const full = computeWhenResolved(row, ledger, (facts) => {
      expect(Object.keys(facts).sort()).toEqual(['wall.corners', 'wall.total_run']);
      return (facts['wall.corners'].value as number) * 2;
    });
    expect(full.computed).toBe(true);
    if (full.computed) expect(full.value).toBe(8);
  });

  it('accepts any usable state, not only SUPPLIED', () => {
    const ledger = addFact(emptyLedger(), {
      id: 'wall.total_run',
      value: 100000,
      unit: 'mm',
      state: 'DECLARED',
      source: { drawingNumber: 'ARCH-101', revision: 'C' },
      evidence: ['handle 4F2A1'],
      readOn: READ_ON,
    });
    const result = computeWhenResolved(TB16_ROW, ledger, (facts) => facts['wall.total_run'].value);
    expect(result.computed).toBe(true);
    if (result.computed) expect(result.value).toBe(100000);
  });
});

describe('requiredFactsFor', () => {
  it('bbs on a linear member requires the member run, with a reason', () => {
    const required = requiredFactsFor('bbs', { subject: 'wall', memberKind: 'linear' });
    expect(required).toHaveLength(1);
    expect(required[0].id).toBe('wall.total_run');
    expect(required[0].reason).toMatch(/run/);
  });

  it('bbs demands no up-front detail facts — those come from the drawing', () => {
    const required = requiredFactsFor('bbs', {
      subject: 'wall',
      memberKind: 'linear',
      members: ['TB', 'SC'],
    });
    expect(required.map((f) => f.id)).toEqual(['wall.total_run']);
  });

  it('concrete and formwork additionally require member cross-sections', () => {
    for (const kind of ['concrete', 'formwork'] as const) {
      const required = requiredFactsFor(kind, {
        subject: 'wall',
        memberKind: 'linear',
        members: ['TB', 'SC'],
      });
      expect(required.map((f) => f.id)).toEqual(['wall.total_run', 'TB.section', 'SC.section']);
      for (const f of required) expect(f.reason.length).toBeGreaterThan(0);
    }
  });

  it('a discrete-member context does not require a run', () => {
    expect(requiredFactsFor('boq', { subject: 'slab', memberKind: 'discrete' })).toEqual([]);
  });
});
