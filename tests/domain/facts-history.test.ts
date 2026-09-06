// Inline history (§5.3), editing (§4.5) and the contradiction-between-equals
// rule (open question 3, resolved per the CONTRACT addendum): the queryable
// version chain with replacement reasons, the 20-version cap that keeps the
// original reading, override/withdraw, and equal-trust disagreement that
// records both claims, blocks like MISSING, asks, and resolves by SUPPLIED.
import { describe, expect, it } from 'vitest';
import { computeWhenResolved } from '../../src/facts/blocked';
import {
  addFact,
  blockedFacts,
  emptyLedger,
  factHistory,
  factVersions,
  missingFacts,
  overrideFact,
  recordFact,
  resolveFact,
  supplyFact,
  withdrawFact,
  type Ledger,
} from '../../src/facts/ledger';
import { isUsable, type Fact } from '../../src/facts/types';

const READ_ON = '2026-08-29';

const declaredPitch: Fact = {
  id: 'columns.main_pitch',
  value: 4000,
  unit: 'mm',
  state: 'DECLARED',
  source: { drawingNumber: 'GW-01', revision: 'R1', handles: ['79A10'], rawText: '4000 TYP' },
  readOn: READ_ON,
};

const measuredPitchR1: Fact = {
  id: 'columns.main_pitch',
  value: 4157,
  unit: 'mm',
  state: 'MEASURED',
  source: { drawingNumber: 'GW-01', revision: 'R1', documentId: 'doc-gw01' },
  method: 'buildPlacementBands()',
  readOn: READ_ON,
};

describe('factVersions — inline history (§5.3)', () => {
  it('returns the version chain newest-first, each superseded version carrying its reason', () => {
    let ledger = recordFact(emptyLedger(), declaredPitch).ledger;
    ledger = recordFact(ledger, measuredPitchR1).ledger; // higher trust
    ledger = recordFact(ledger, {
      ...measuredPitchR1,
      value: 4187,
      source: { drawingNumber: 'GW-01', revision: 'R2', documentId: 'doc-gw01' },
    }).ledger; // same state, newer revision
    ledger = overrideFact(ledger, 'columns.main_pitch', {
      value: 4200,
      suppliedBy: 'hello@shivik.in',
      on: '2026-08-30',
    });

    const versions = factVersions(ledger, 'columns.main_pitch');
    expect(versions).toHaveLength(4);

    // Newest first: the current SUPPLIED override, not yet superseded.
    expect(versions[0].value).toBe(4200);
    expect(versions[0].state).toBe('SUPPLIED');
    expect(versions[0].supersededAt).toBeUndefined();
    expect(versions[0].reason).toBeUndefined();

    // Each older version knows why it was replaced.
    expect(versions[1].value).toBe(4187);
    expect(versions[1].reason).toBe('user-override');
    expect(versions[1].source).toMatchObject({ drawingNumber: 'GW-01', revision: 'R2' });

    expect(versions[2].value).toBe(4157);
    expect(versions[2].reason).toBe('newer-revision');

    expect(versions[3].value).toBe(4000);
    expect(versions[3].state).toBe('DECLARED');
    expect(versions[3].reason).toBe('higher-trust');
    // The old source stays resolvable — drawing, revision, handles intact.
    expect(versions[3].source).toEqual(declaredPitch.source);

    for (const v of versions) expect(typeof v.recordedAt).toBe('number');
    for (const v of versions.slice(1)) expect(typeof v.supersededAt).toBe('number');
  });

  it('a rejected lower-trust claim appears in the chain with reason "contradicted"', () => {
    let ledger = recordFact(emptyLedger(), measuredPitchR1).ledger;
    ledger = recordFact(ledger, { ...declaredPitch, value: 2000 }).ledger; // rejected

    const versions = factVersions(ledger, 'columns.main_pitch');
    expect(versions).toHaveLength(2);
    expect(versions[0].value).toBe(2000);
    expect(versions[0].reason).toBe('contradicted');
    // The measurement is still the current fact.
    expect(resolveFact(ledger, 'columns.main_pitch')!.value).toBe(4157);
  });

  it('caps at 20 versions as first + last 19 — the original reading always survives', () => {
    let ledger = recordFact(emptyLedger(), {
      ...measuredPitchR1,
      value: 1,
      source: { drawingNumber: 'GW-01', revision: 'R1', documentId: 'doc-gw01' },
    }).ledger;
    for (let i = 2; i <= 25; i++) {
      ledger = recordFact(ledger, {
        ...measuredPitchR1,
        value: i,
        source: { drawingNumber: 'GW-01', revision: `R${i}`, documentId: 'doc-gw01' },
      }).ledger;
    }

    const versions = factVersions(ledger, 'columns.main_pitch');
    expect(versions).toHaveLength(20);
    // Newest first…
    expect(versions[0].value).toBe(25);
    expect(versions[1].value).toBe(24);
    // …and the LAST slot is the original reading, not version 6.
    expect(versions[19].value).toBe(1);
    expect(versions[19].source).toMatchObject({ revision: 'R1' });
    expect(versions[19].reason).toBe('newer-revision');
    // The 19 newest fill the rest: 25 down to 7.
    expect(versions[18].value).toBe(7);
    // The underlying ledger keeps everything — the cap is only the view.
    expect(factHistory(ledger, 'columns.main_pitch')).toHaveLength(25);
  });
});

describe('overrideFact (§4.5)', () => {
  it('records the override as SUPPLIED and keeps the overridden value in history', () => {
    let ledger = recordFact(emptyLedger(), {
      id: 'TB.section',
      value: '350x400',
      state: 'DECLARED',
      source: { drawingNumber: 'GW-01', revision: 'R1', sectionId: 'REGION-12', handles: ['79A47'] },
      readOn: READ_ON,
    }).ledger;

    ledger = overrideFact(ledger, 'TB.section', {
      value: '350x450',
      suppliedBy: 'hello@shivik.in',
      on: '2026-08-30',
      evidence: ['site instruction 14'],
    });

    const current = resolveFact(ledger, 'TB.section')!;
    expect(current.state).toBe('SUPPLIED');
    expect(current.value).toBe('350x450');
    expect(current.suppliedBy).toBe('hello@shivik.in');

    // The ledger never loses what the drawing said.
    const versions = factVersions(ledger, 'TB.section');
    expect(versions).toHaveLength(2);
    expect(versions[1].value).toBe('350x400');
    expect(versions[1].state).toBe('DECLARED');
    expect(versions[1].reason).toBe('user-override');
    expect(versions[1].source).toMatchObject({
      drawingNumber: 'GW-01',
      revision: 'R1',
      handles: ['79A47'],
    });
  });
});

describe('withdrawFact (§4.5)', () => {
  function suppliedWithDependent(): Ledger {
    let ledger = addFact(emptyLedger(), {
      id: 'wall.corners',
      value: null,
      state: 'MISSING',
      neededFor: ['corner bar counts'],
      lookedIn: ['ARCH-101', 'ARCH-102'],
      ask: 'How many corners does the wall turn?',
      readOn: READ_ON,
    });
    ledger = supplyFact(ledger, 'wall.corners', {
      value: 4,
      suppliedBy: 'hello@shivik.in',
      on: '2026-08-30',
    });
    ledger = addFact(ledger, {
      id: 'wall.corner_bars',
      value: 8,
      state: 'DERIVED',
      basis: '2 extra bars per corner × wall.corners',
      dependsOn: ['wall.corners'],
      readOn: '2026-08-30',
    });
    return ledger;
  }

  it('marks a SUPPLIED fact withdrawn — back to MISSING with its context — and never deletes it', () => {
    const { ledger, withdrawn, staleDependents } = withdrawFact(
      suppliedWithDependent(),
      'wall.corners',
    );
    expect(withdrawn).toBe(true);

    // The fact blocks again, with the original ask and search trail restored.
    const current = resolveFact(ledger, 'wall.corners')!;
    expect(current.state).toBe('MISSING');
    expect(current.value).toBeNull();
    expect(current.ask).toBe('How many corners does the wall turn?');
    expect(current.lookedIn).toEqual(['ARCH-101', 'ARCH-102']);
    expect(missingFacts(ledger).map((f) => f.id)).toContain('wall.corners');

    // The withdrawn answer stays in history, reason 'withdrawn'.
    const versions = factVersions(ledger, 'wall.corners');
    const withdrawnVersion = versions.find((v) => v.state === 'SUPPLIED')!;
    expect(withdrawnVersion.value).toBe(4);
    expect(withdrawnVersion.reason).toBe('withdrawn');

    // Dependents are surfaced for recompute, marked stale.
    expect(staleDependents).toEqual(['wall.corner_bars']);
    expect(resolveFact(ledger, 'wall.corner_bars')!.stale).toBe(true);
  });

  it('withdraws only SUPPLIED facts', () => {
    const ledger = recordFact(emptyLedger(), declaredPitch).ledger;
    const result = withdrawFact(ledger, 'columns.main_pitch');
    expect(result.withdrawn).toBe(false);
    expect(result.ledger).toBe(ledger);
    expect(resolveFact(ledger, 'columns.main_pitch')!.state).toBe('DECLARED');
  });
});

describe('contradiction between equals (open question 3)', () => {
  const archRun: Fact = {
    id: 'wall.total_run',
    value: 100000,
    unit: 'mm',
    state: 'DECLARED',
    source: { drawingNumber: 'ARCH-101', revision: 'R0', handles: ['4F2A1'], rawText: '100000' },
    readOn: READ_ON,
  };
  const siteRun: Fact = {
    id: 'wall.total_run',
    value: 98000,
    unit: 'mm',
    state: 'DECLARED',
    source: { drawingNumber: 'SITE-01', revision: 'R0', handles: ['A0011'], rawText: '98.0 M' },
    readOn: READ_ON,
  };

  function contradicted(): Ledger {
    let ledger = recordFact(emptyLedger(), archRun).ledger;
    const result = recordFact(ledger, siteRun);
    expect(result.contradicted).toBe(true);
    expect(result.accepted).toBe(false);
    return result.ledger;
  }

  it('records BOTH claims and marks the fact contradicted', () => {
    const ledger = contradicted();

    // Both readings are on the record with their sources.
    const history = factHistory(ledger, 'wall.total_run');
    expect(history).toHaveLength(2);
    expect(history.map((f) => f.value).sort()).toEqual([100000, 98000].sort());
    expect(history[1].contradicts).toMatch(/^wall\.total_run@\d+$/);

    // The incumbent stays current but is flagged — and BLOCKS like missing.
    const current = resolveFact(ledger, 'wall.total_run')!;
    expect(current.contradicted).toBe(true);
    expect(isUsable(current)).toBe(false);

    const gate = computeWhenResolved(
      { formula: 'spans = ⌈ wall.total_run / 4157 ⌉', missingFactIds: ['wall.total_run'], ask: [] },
      ledger,
      () => 0,
    );
    expect(gate.computed).toBe(false);
    if (!gate.computed) expect(gate.missing).toEqual(['wall.total_run']);
  });

  it('blockedFacts lists it beside MISSING facts, with an ask synthesised from the two sources', () => {
    let ledger = contradicted();
    ledger = addFact(ledger, {
      id: 'wall.corners',
      value: null,
      state: 'MISSING',
      ask: 'How many corners does the wall turn?',
      readOn: READ_ON,
    });

    const blocked = blockedFacts(ledger);
    expect(blocked.map((b) => `${b.kind}:${b.id}`).sort()).toEqual([
      'contradicted:wall.total_run',
      'missing:wall.corners',
    ]);

    const clash = blocked.find((b) => b.kind === 'contradicted')!;
    expect(clash.ask).toBe('ARCH-101 R0 says 100000, SITE-01 R0 says 98000 — which governs?');
    expect(clash.rivals!.map((f) => f.value)).toEqual([98000]);

    const hole = blocked.find((b) => b.kind === 'missing')!;
    expect(hole.ask).toBe('How many corners does the wall turn?');
  });

  it('resolves by a SUPPLIED answer; higher trust wins normally', () => {
    const supplied = recordFact(contradicted(), {
      id: 'wall.total_run',
      value: 98000,
      unit: 'mm',
      state: 'SUPPLIED',
      suppliedBy: 'hello@shivik.in',
      saidAs: 'the site plan governs — 98 m',
      readOn: '2026-08-30',
    });
    expect(supplied.accepted).toBe(true);

    const current = resolveFact(supplied.ledger, 'wall.total_run')!;
    expect(current.state).toBe('SUPPLIED');
    expect(current.value).toBe(98000);
    expect(current.contradicted).toBeUndefined();
    expect(isUsable(current)).toBe(true);
    expect(blockedFacts(supplied.ledger)).toHaveLength(0);

    // Both original claims are still in history; nothing was lost.
    expect(factHistory(supplied.ledger, 'wall.total_run')).toHaveLength(3);

    // A MEASURED reading also settles it — the normal trust rule.
    const measured = recordFact(contradicted(), {
      id: 'wall.total_run',
      value: 98240,
      unit: 'mm',
      state: 'MEASURED',
      source: { drawingNumber: 'SITE-01', revision: 'R0' },
      method: 'polyline length over the site plan boundary',
      readOn: '2026-08-30',
    });
    expect(measured.accepted).toBe(true);
    expect(isUsable(resolveFact(measured.ledger, 'wall.total_run')!)).toBe(true);
  });

  it('agreement from a second drawing is not a contradiction', () => {
    const ledger = recordFact(emptyLedger(), archRun).ledger;
    const corroborated = recordFact(ledger, { ...siteRun, value: 100000 });
    // Same value: recorded on the record but the fact is NOT blocked.
    expect(corroborated.contradicted).toBeUndefined();
    const current = resolveFact(corroborated.ledger, 'wall.total_run')!;
    expect(current.contradicted).toBeUndefined();
    expect(isUsable(current)).toBe(true);
    expect(blockedFacts(corroborated.ledger)).toHaveLength(0);
  });
});
