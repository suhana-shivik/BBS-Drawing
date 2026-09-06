import { describe, expect, it } from 'vitest';
import {
  addFact,
  emptyLedger,
  factHistory,
  factsBySource,
  missingFacts,
  resolveFact,
  supplyFact,
  type Ledger,
} from '../../src/facts/ledger';
import { deserializeLedger, loadLedger, saveLedger, serializeLedger } from '../../src/facts/store';
import { FACT_TRUST, isUsable, factSubject, factName, type Fact } from '../../src/facts/types';

const READ_ON = '2026-08-29';

function seededLedger(): Ledger {
  let ledger = emptyLedger();
  ledger = addFact(ledger, {
    id: 'wall.total_run',
    value: 100000,
    unit: 'mm',
    state: 'DECLARED',
    source: { drawingNumber: 'ARCH-101', revision: 'C', sectionId: 'REGION-03' },
    evidence: ['handle 4F2A1', 'text "100000" (overall dimension string)'],
    readOn: READ_ON,
  });
  ledger = addFact(ledger, {
    id: 'columns.main_pitch',
    value: 4157,
    unit: 'mm',
    state: 'MEASURED',
    source: { drawingNumber: 'GW-01', revision: 'R1' },
    method: 'buildPlacementBands() over F1 and C1/C2 mark occurrences',
    readOn: READ_ON,
  });
  ledger = addFact(ledger, {
    id: 'SC.has_footing',
    value: false,
    state: 'DERIVED',
    source: { drawingNumber: 'GW-01', revision: 'R1', sectionId: 'REGION-04' },
    basis: 'detail title "FROM TIE BEAM TO +300 LVL." + footing tally 7/module',
    readOn: READ_ON,
  });
  ledger = addFact(ledger, {
    id: 'wall.finish',
    value: 'plaster both sides',
    state: 'SUPPLIED',
    suppliedBy: 'client brief',
    readOn: READ_ON,
  });
  ledger = addFact(ledger, {
    id: 'wall.corners',
    value: null,
    state: 'MISSING',
    neededFor: ['corner bar counts', 'L-bend deductions'],
    lookedIn: ['ARCH-101', 'ARCH-102'],
    ask: 'Does the boundary wall turn? How many corners, and at what angle?',
    readOn: READ_ON,
  });
  return ledger;
}

describe('fact ledger', () => {
  it('holds all five states and resolves each with its provenance intact', () => {
    const ledger = seededLedger();

    const declared = resolveFact(ledger, 'wall.total_run')!;
    expect(declared.state).toBe('DECLARED');
    expect(declared.value).toBe(100000);
    expect(declared.source).toEqual({
      drawingNumber: 'ARCH-101',
      revision: 'C',
      sectionId: 'REGION-03',
    });
    expect(declared.evidence).toContain('handle 4F2A1');

    const measured = resolveFact(ledger, 'columns.main_pitch')!;
    expect(measured.state).toBe('MEASURED');
    expect(measured.method).toMatch(/buildPlacementBands/);

    const derived = resolveFact(ledger, 'SC.has_footing')!;
    expect(derived.state).toBe('DERIVED');
    expect(derived.basis).toMatch(/footing tally/);
    expect(derived.value).toBe(false);

    const supplied = resolveFact(ledger, 'wall.finish')!;
    expect(supplied.state).toBe('SUPPLIED');
    expect(supplied.suppliedBy).toBe('client brief');

    const missing = resolveFact(ledger, 'wall.corners')!;
    expect(missing.state).toBe('MISSING');
    expect(missing.value).toBeNull();
    expect(missing.ask).toMatch(/corners/);
  });

  it('orders trust MEASURED > DECLARED > DERIVED = SUPPLIED, and MISSING blocks', () => {
    expect(FACT_TRUST.MEASURED).toBeGreaterThan(FACT_TRUST.DECLARED);
    expect(FACT_TRUST.DECLARED).toBeGreaterThan(FACT_TRUST.DERIVED);
    expect(FACT_TRUST.DERIVED).toBe(FACT_TRUST.SUPPLIED);
    const missing = resolveFact(seededLedger(), 'wall.corners')!;
    expect(isUsable(missing)).toBe(false);
    expect(isUsable(resolveFact(seededLedger(), 'wall.total_run')!)).toBe(true);
  });

  it('splits fact ids into subject and name', () => {
    expect(factSubject('wall.total_run')).toBe('wall');
    expect(factName('wall.total_run')).toBe('total_run');
  });

  it('supersedes on re-add without mutating history (append-only)', () => {
    const before = seededLedger();
    const entryCount = before.entries.length;
    const after = addFact(before, {
      id: 'wall.total_run',
      value: 104500,
      unit: 'mm',
      state: 'DECLARED',
      source: { drawingNumber: 'ARCH-101', revision: 'D', sectionId: 'REGION-03' },
      evidence: ['handle 4F2A1'],
      readOn: '2026-09-02',
    });

    // The input ledger value is untouched.
    expect(before.entries.length).toBe(entryCount);
    expect(resolveFact(before, 'wall.total_run')!.value).toBe(100000);
    expect(before.entries.find((e) => e.fact.id === 'wall.total_run')!.fact.supersededBy)
      .toBeUndefined();

    // The new ledger appended; nothing was removed.
    expect(after.entries.length).toBe(entryCount + 1);
    expect(resolveFact(after, 'wall.total_run')!.value).toBe(104500);
    expect(resolveFact(after, 'wall.total_run')!.source!.revision).toBe('D');

    // History retains the old reading, marked superseded and pointing forward.
    const history = factHistory(after, 'wall.total_run');
    expect(history.length).toBe(2);
    expect(history[0].value).toBe(100000);
    expect(history[0].supersededBy).toMatch(/^wall\.total_run@\d+$/);
    expect(history[1].supersededBy).toBeUndefined();
  });

  it('supplyFact converts MISSING to SUPPLIED, recording who and when', () => {
    const ledger = supplyFact(seededLedger(), 'wall.corners', {
      value: 4,
      suppliedBy: 'hello@shivik.in',
      on: '2026-08-30',
      evidence: ['email: "four corners, all 90 degrees"'],
    });

    const current = resolveFact(ledger, 'wall.corners')!;
    expect(current.state).toBe('SUPPLIED');
    expect(current.value).toBe(4);
    expect(current.suppliedBy).toBe('hello@shivik.in');
    expect(current.readOn).toBe('2026-08-30');
    // Context from the MISSING entry is carried over for the audit trail.
    expect(current.neededFor).toContain('corner bar counts');

    // The MISSING entry survives in history, superseded.
    const history = factHistory(ledger, 'wall.corners');
    expect(history[0].state).toBe('MISSING');
    expect(history[0].supersededBy).toBeDefined();
    expect(missingFacts(ledger)).toHaveLength(0);
  });

  it('missingFacts lists only current MISSING facts', () => {
    const ledger = seededLedger();
    const missing = missingFacts(ledger);
    expect(missing.map((f) => f.id)).toEqual(['wall.corners']);
  });

  it('factsBySource returns current facts read from a drawing', () => {
    const ledger = seededLedger();
    const fromGw01 = factsBySource(ledger, 'GW-01').map((f) => f.id);
    expect(fromGw01.sort()).toEqual(['SC.has_footing', 'columns.main_pitch']);
    // A superseded reading no longer counts against its drawing.
    const updated = addFact(ledger, {
      id: 'columns.main_pitch',
      value: 4187,
      unit: 'mm',
      state: 'MEASURED',
      source: { drawingNumber: 'GW-02', revision: 'A' },
      method: 'buildPlacementBands()',
      readOn: '2026-09-01',
    });
    expect(factsBySource(updated, 'GW-01').map((f) => f.id)).toEqual(['SC.has_footing']);
    expect(factsBySource(updated, 'GW-02').map((f) => f.id)).toEqual(['columns.main_pitch']);
  });

  it('provenance survives serialization round-trip', () => {
    const ledger = supplyFact(
      addFact(seededLedger(), {
        id: 'wall.total_run',
        value: 104500,
        unit: 'mm',
        state: 'DECLARED',
        source: { drawingNumber: 'ARCH-101', revision: 'D' },
        readOn: '2026-09-02',
      }),
      'wall.corners',
      { value: 4, suppliedBy: 'site engineer' },
    );

    const restored = deserializeLedger(serializeLedger(ledger));
    expect(restored.entries.length).toBe(ledger.entries.length);

    // Current values resolve identically.
    expect(resolveFact(restored, 'wall.total_run')).toEqual(resolveFact(ledger, 'wall.total_run'));
    // Full provenance — source, evidence, method, basis, supersededBy chain.
    expect(factHistory(restored, 'wall.total_run')).toEqual(factHistory(ledger, 'wall.total_run'));
    expect(resolveFact(restored, 'columns.main_pitch')!.method).toMatch(/buildPlacementBands/);
    expect(resolveFact(restored, 'SC.has_footing')!.basis).toMatch(/footing tally/);
    expect(factHistory(restored, 'wall.corners')[0].lookedIn).toEqual(['ARCH-101', 'ARCH-102']);
    expect(resolveFact(restored, 'wall.corners')!.suppliedBy).toBe('site engineer');
  });

  it('persists per project key to localStorage and loads back', () => {
    const ledger = seededLedger();
    expect(saveLedger('project-alpha', ledger)).toBe(true);
    const loaded = loadLedger('project-alpha')!;
    expect(loaded).not.toBeNull();
    expect(resolveFact(loaded, 'wall.total_run')!.value).toBe(100000);
    // Distinct projects do not collide.
    expect(loadLedger('project-beta')).toBeNull();
  });

  it('deserializeLedger rejects garbage', () => {
    expect(() => deserializeLedger('{"nope":true}')).toThrow(/not a serialized ledger/);
    expect(() => deserializeLedger('{"version":99,"entries":[]}')).toThrow(/version/);
  });
});
