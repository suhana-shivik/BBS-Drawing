// AN ANSWER KEEPS THE FACT'S PLACEMENT.
//
// `factOnDrawing` lists a fact nothing can place on EVERY drawing, deliberately
// — a question nobody can find is worse than one listed twice. The interview
// path learned to place its answers (tests/domain/fact-scope.test.ts). The
// DIRECT path did not: `supplyFact`, `overrideFact` and the Specification's own
// answer box all built a SUPPLIED fact from scratch and dropped the `lookedIn`
// the MISSING entry was carrying.
//
// So the reported symptom came back through the other door: open the pedestal
// detail, and `c1.height` — answered on the columns sheet, then disputed by the
// engine — headed its specification, chipped "not tied to a drawing" over a
// fact that had been tied to one until the moment somebody answered it.
import { describe, expect, it } from 'vitest';
import { addFact, answerPlacement, emptyLedger, overrideFact, resolveFact, supplyFact } from '../../src/facts/ledger';
import { factOnDrawing, factPlaceable, type Fact } from '../../src/facts/types';

const COLUMNS = 'BBS-TEST-COLUMNS';
const PEDESTAL = 'PEDESTAL_BBS_DETAIL_LARGE';

/** The gap a run on the columns sheet files: no source, a placeable trail. */
const gap: Fact = {
  id: 'c1.height',
  value: null,
  state: 'MISSING',
  ask: 'What is the height of C1?',
  lookedIn: [`${COLUMNS} R0`, '12 callouts on this sheet'],
  neededFor: ['C1-M1'],
  readOn: '2026-09-03',
};

describe('answering a placed fact leaves it placed', () => {
  it('stays on its own drawing, and off every other one', () => {
    const l = supplyFact(addFact(emptyLedger(), gap), 'c1.height', {
      value: 300,
      suppliedBy: 'you',
    });
    const answered = resolveFact(l, 'c1.height')!;
    expect(answered.state).toBe('SUPPLIED');
    expect(factOnDrawing(answered, COLUMNS)).toBe(true);
    expect(factOnDrawing(answered, PEDESTAL)).toBe(false);
  });

  it('records it as CONTEXT, never as a reading of the sheet', () => {
    const l = supplyFact(addFact(emptyLedger(), gap), 'c1.height', {
      value: 300,
      suppliedBy: 'you',
    });
    // A `source` here would say the drawing states 300 mm. It does not.
    expect(resolveFact(l, 'c1.height')!.source).toBeUndefined();
  });

  it('an override keeps it too', () => {
    const l = overrideFact(addFact(emptyLedger(), gap), 'c1.height', {
      value: 450,
      suppliedBy: 'you',
    });
    expect(factOnDrawing(resolveFact(l, 'c1.height')!, PEDESTAL)).toBe(false);
  });

  it('a fact read off a drawing carries that drawing when it is overridden', () => {
    const declared: Fact = {
      id: 'wall.total_run',
      value: 4000,
      unit: 'mm',
      state: 'DECLARED',
      source: { drawingNumber: COLUMNS, revision: 'R0' },
      readOn: '2026-09-03',
    };
    const l = overrideFact(addFact(emptyLedger(), declared), 'wall.total_run', {
      value: 4200,
      suppliedBy: 'you',
    });
    const f = resolveFact(l, 'wall.total_run')!;
    expect(f.source).toBeUndefined(); // the override is not a reading
    expect(f.lookedIn?.[0]).toContain(COLUMNS);
    expect(factOnDrawing(f, COLUMNS)).toBe(true);
    expect(factOnDrawing(f, PEDESTAL)).toBe(false);
  });
});

describe('answering a fact nothing knew about places it where it was answered', () => {
  it('uses the open drawing, and says that is all it means', () => {
    const l = supplyFact(emptyLedger(), 'p1.count', {
      value: 250,
      suppliedBy: 'you',
      askedOn: PEDESTAL,
    });
    const f = resolveFact(l, 'p1.count')!;
    expect(f.lookedIn?.[0]).toContain(PEDESTAL);
    expect(f.lookedIn?.[0]).toContain('open when this was answered');
    expect(factOnDrawing(f, PEDESTAL)).toBe(true);
    expect(factOnDrawing(f, COLUMNS)).toBe(false);
  });

  it('and still shows everywhere when no drawing was open', () => {
    // Case 3 of `factOnDrawing` survives: a fact nothing can place is
    // reachable from every surface rather than from none.
    const l = supplyFact(emptyLedger(), 'p1.count', { value: 250, suppliedBy: 'you' });
    const f = resolveFact(l, 'p1.count')!;
    expect(factPlaceable(f)).toBe(false);
    expect(factOnDrawing(f, PEDESTAL)).toBe(true);
    expect(factOnDrawing(f, COLUMNS)).toBe(true);
  });
});

describe('answerPlacement — the honest order', () => {
  it('prefers what the fact already knew', () => {
    expect(answerPlacement(gap, PEDESTAL)).toEqual(gap.lookedIn);
  });

  it('falls back to where the value it replaces was read', () => {
    const f: Fact = { ...gap, lookedIn: undefined, source: { drawingNumber: COLUMNS, revision: 'R2' } };
    expect(answerPlacement(f, PEDESTAL)![0]).toBe(
      `${COLUMNS} R2 — where the value this answer replaces was read`,
    );
  });

  it('and only then to the drawing that happened to be open', () => {
    expect(answerPlacement(undefined, PEDESTAL)![0]).toContain(PEDESTAL);
    expect(answerPlacement(undefined, undefined)).toBeUndefined();
  });
});
