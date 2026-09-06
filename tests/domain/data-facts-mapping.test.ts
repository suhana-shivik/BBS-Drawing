// The ledger ⇄ data_facts mapping.
//
// The property that matters is exact round-tripping. The ledger is the audit
// trail behind every figure in a schedule — which reading was superseded, by
// what, and why — and a mapping that quietly drops `supersededReason` or
// flattens a contradiction produces a database that looks right and cannot be
// audited. So: build real ledgers with the real API, send every entry through
// the row mapper and back, and require identity.
import { describe, expect, it } from 'vitest';
import { factToRow, rowToEntry } from '../../src/data/facts';
import {
  disputeFact,
  emptyLedger,
  overrideFact,
  recordFact,
  supplyFact,
  type Ledger,
} from '../../src/facts/ledger';
import type { Fact } from '../../src/facts/types';

const CTX = { projectId: '11111111-1111-1111-1111-111111111111', userId: '22222222-2222-2222-2222-222222222222' };

const fact = (over: Partial<Fact> & { id: string }): Fact => ({
  value: null,
  state: 'MISSING',
  readOn: '2026-09-06',
  ...over,
});

/** Every entry, through the database shape and back, must be unchanged. */
function expectRoundTrip(ledger: Ledger): void {
  for (const entry of ledger.entries) {
    expect(rowToEntry(factToRow(entry, CTX))).toEqual(entry);
  }
}

describe('round trip', () => {
  it('survives a reading, a correction and the supersede chain between them', () => {
    let ledger = emptyLedger();
    ledger = recordFact(
      ledger,
      fact({
        id: 'F8.length',
        value: 3500,
        unit: 'mm',
        state: 'DECLARED',
        source: {
          drawingNumber: 'PCD-IND-B300-S-803',
          revision: 'S',
          documentId: 'doc-1',
          sectionId: 'REGION-02',
          handles: ['52F00E', '52F01E'],
          rawText: 'FOOTING SCHEDULE row F8, column "L" = 3500',
        },
        evidence: ['52F00E'],
        method: 'schedule table, read deterministically',
        sourceDrawingHash: 'doc:abc123',
        neededFor: ['F8 row F8-M1'],
        lookedIn: ['PCD-IND-B300-S-803 S', '34 callouts'],
      }),
    ).ledger;
    ledger = supplyFact(ledger, 'F8.length', { value: 3600, suppliedBy: 'you', askedOn: 'PCD-IND-B300-S-803' });
    expect(ledger.entries.length).toBeGreaterThan(1);
    expectRoundTrip(ledger);

    // and the supersede bookkeeping is really carried, not merely tolerated
    const superseded = ledger.entries.find((e) => e.fact.supersededBy !== undefined)!;
    const row = factToRow(superseded, CTX);
    expect(row.superseded_ref).toBe(superseded.fact.supersededBy);
    expect(row.status).toBe('SUPERSEDED');
  });

  it('survives a contradiction, keeping both claims and the reason', () => {
    let ledger = emptyLedger();
    ledger = recordFact(
      ledger,
      fact({
        id: 'C12.height',
        value: 3000,
        unit: 'mm',
        state: 'DECLARED',
        source: { drawingNumber: 'S-101', revision: 'A' },
      }),
    ).ledger;
    const clash = recordFact(
      ledger,
      fact({
        id: 'C12.height',
        value: 3300,
        unit: 'mm',
        state: 'DECLARED',
        source: { drawingNumber: 'S-102', revision: 'A' },
      }),
    );
    ledger = clash.ledger;
    expect(clash.accepted).toBe(false);
    expectRoundTrip(ledger);

    const incumbent = ledger.entries.find((e) => e.fact.contradicted === true);
    expect(incumbent).toBeTruthy();
    expect(factToRow(incumbent!, CTX).status).toBe('UNREADABLE');
    expect(factToRow(incumbent!, CTX).contradicted_by.length).toBeGreaterThan(0);
  });

  it('survives a disputed axis and an override', () => {
    let ledger = emptyLedger();
    ledger = recordFact(ledger, fact({ id: 'P1.height', value: 100, unit: 'mm', state: 'SUPPLIED', saidAs: '100' })).ledger;
    ledger = disputeFact(ledger, 'P1.height', {
      reason: 'a T16 measured along it comes out under its development length',
      ask: 'What is the real height of P1, in mm?',
    });
    ledger = overrideFact(ledger, 'P1.height', { value: 2400, suppliedBy: 'you' });
    expectRoundTrip(ledger);
  });

  it('survives an open question — a MISSING fact keeps its ask and where it looked', () => {
    let ledger = emptyLedger();
    ledger = recordFact(
      ledger,
      fact({
        id: 'settings.cover',
        state: 'MISSING',
        ask: 'What is the clear cover, in mm?',
        neededFor: ['every development length, lap and stirrup arm'],
        lookedIn: ['this drawing states no cover'],
      }),
    ).ledger;
    expectRoundTrip(ledger);
    const row = factToRow(ledger.entries[0], CTX);
    expect(row.status).toBe('MISSING');
    expect(row.source_type).toBe('MISSING');
    expect(row.value).toBeNull();
    expect(row.confidence).toBe(0);
    expect(row.ask).toMatch(/clear cover/);
  });
});

describe('the DataFact projection is generic', () => {
  const cases: { id: string; member: string; parameter: string; semantic: string }[] = [
    { id: 'F8.length', member: 'F8', parameter: 'length', semantic: 'member_dimension' },
    { id: 'PB03.span', member: 'PB03', parameter: 'span', semantic: 'member_dimension' },
    { id: 'C12.tie_spacing', member: 'C12', parameter: 'tie_spacing', semantic: 'spacing' },
    { id: 'SLAB-2A.thickness', member: 'SLAB-2A', parameter: 'thickness', semantic: 'member_dimension' },
    { id: 'RW-7A.main_bar_dia', member: 'RW-7A', parameter: 'main_bar_dia', semantic: 'bar_diameter' },
    { id: 'settings.cover', member: 'settings', parameter: 'cover', semantic: 'cover' },
    { id: 'wall.total_run', member: 'wall', parameter: 'total_run', semantic: 'member_dimension' },
  ];

  it('splits any member.parameter key without knowing the member', () => {
    for (const c of cases) {
      const entry = { seq: 0, fact: fact({ id: c.id, value: 1, unit: 'mm', state: 'DECLARED' }) };
      const row = factToRow(entry, CTX);
      expect(row.member_id).toBe(c.member);
      expect(row.parameter).toBe(c.parameter);
      expect(row.semantic_type).toBe(c.semantic);
      expect(rowToEntry(row)).toEqual(entry);
    }
  });

  it('version is the ledger sequence plus one, so (project, key, version) is the entry', () => {
    const entry = { seq: 7, fact: fact({ id: 'B1.depth', value: 600, unit: 'mm', state: 'MEASURED' }) };
    const row = factToRow(entry, CTX);
    expect(row.entry_seq).toBe(7);
    expect(row.version).toBe(8);
    expect(rowToEntry(row).seq).toBe(7);
  });

  it('maps ledger states onto the required source-type vocabulary', () => {
    const state = (s: Fact['state'], extra: Partial<Fact> = {}) =>
      factToRow({ seq: 0, fact: fact({ id: 'X1.length', value: 1, state: s, ...extra }) }, CTX).source_type;
    expect(state('MEASURED')).toBe('DRAWING_READ');
    expect(state('DECLARED')).toBe('DRAWING_READ');
    expect(state('SUPPLIED')).toBe('USER_INPUT');
    expect(state('DERIVED', { basis: 'sum of bays' })).toBe('DERIVED');
    expect(state('DERIVED', { basis: 'project default' })).toBe('ASSUMED');
    expect(state('MISSING')).toBe('MISSING');
    expect(state('DECLARED', { contradicted: true })).toBe('UNREADABLE');
  });

  it('stamps the owner and project from the caller, never from the fact', () => {
    const row = factToRow({ seq: 0, fact: fact({ id: 'F1.width', value: 2300, state: 'DECLARED' }) }, CTX);
    expect(row.project_id).toBe(CTX.projectId);
    expect(row.user_id).toBe(CTX.userId);
  });
});
