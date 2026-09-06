// Revision pipeline — the data half of §5.2, reproducing the §5.4 GW-01
// R1 → R2 example: changed facts with both sources resolvable, supplied facts
// surviving, a new fact added, absences becoming MISSING, derived facts
// stale for recompute — and nothing lost from history.
import { describe, expect, it } from 'vitest';
import {
  emptyLedger,
  factHistory,
  factVersions,
  missingFacts,
  recordFact,
  resolveFact,
  type Ledger,
} from '../../src/facts/ledger';
import { applyRevisionFacts } from '../../src/facts/revision';
import type { Fact } from '../../src/facts/types';

const READ_ON = '2026-08-20';

const gw01r1 = (sectionId: string, handles: string[], rawText: string) => ({
  drawingNumber: 'GW-01',
  revision: 'R1',
  sectionId,
  handles,
  rawText,
});

/** The project as it stands on GW-01 R1, plus one fact from another drawing. */
function seeded(): Ledger {
  let ledger = emptyLedger();
  const seed: Fact[] = [
    {
      id: 'TB.section',
      value: '350x400',
      state: 'DECLARED',
      source: gw01r1('REGION-12', ['79A47'], 'C/S OF TB-(350X400)'),
      readOn: READ_ON,
    },
    {
      id: 'TB.top_steel',
      value: '2-16+2-12',
      state: 'DECLARED',
      source: gw01r1('REGION-12', ['79A4C'], '2-16TOR+2-12TOR'),
      readOn: READ_ON,
    },
    {
      id: 'TB.stirrups',
      value: '8@150',
      state: 'DECLARED',
      source: gw01r1('REGION-12', ['79A50'], '8 TOR @150 C/C'),
      readOn: READ_ON,
    },
    {
      id: 'TB.old_note',
      value: 'LAP AT MIDSPAN',
      state: 'DECLARED',
      source: gw01r1('REGION-12', ['79A55'], 'LAP AT MIDSPAN'),
      readOn: READ_ON,
    },
    {
      id: 'wall.total_run',
      value: 100000,
      unit: 'mm',
      state: 'SUPPLIED',
      suppliedBy: 'hello@shivik.in',
      saidAs: 'the wall is 100 m',
      source: { drawingNumber: 'GW-01', revision: 'R1' },
      readOn: READ_ON,
    },
    {
      id: 'wall.height',
      value: 1200,
      unit: 'mm',
      state: 'DERIVED',
      basis: '900 + TB.depth from TB.section',
      dependsOn: ['TB.section'],
      source: { drawingNumber: 'GW-01', revision: 'R1' },
      readOn: READ_ON,
    },
    {
      id: 'arch.grid',
      value: 6000,
      unit: 'mm',
      state: 'DECLARED',
      source: { drawingNumber: 'ARCH-101', revision: 'C' },
      readOn: READ_ON,
    },
  ];
  for (const f of seed) ledger = recordFact(ledger, f).ledger;
  return ledger;
}

/** What the transcription of GW-01 R2 reads. TB.old_note is gone from the sheet. */
const R2_FACTS: Fact[] = [
  {
    id: 'TB.section',
    value: '350x450',
    state: 'DECLARED',
    source: {
      drawingNumber: 'GW-01',
      revision: 'R2',
      sectionId: 'REGION-12',
      handles: ['79A47'],
      rawText: 'C/S OF TB-(350X450)',
    },
    readOn: '2026-08-29',
  },
  {
    id: 'TB.top_steel',
    value: '3-16+2-12',
    state: 'DECLARED',
    source: {
      drawingNumber: 'GW-01',
      revision: 'R2',
      sectionId: 'REGION-12',
      handles: ['79A4C'],
      rawText: '3-16TOR+2-12TOR',
    },
    readOn: '2026-08-29',
  },
  {
    id: 'TB.stirrups',
    value: '8@150',
    state: 'DECLARED',
    source: {
      drawingNumber: 'GW-01',
      revision: 'R2',
      sectionId: 'REGION-12',
      handles: ['79A50'],
      rawText: '8 TOR @150 C/C',
    },
    readOn: '2026-08-29',
  },
  {
    id: 'TB.stirrup_zone',
    value: '1200 at ends',
    state: 'DECLARED',
    source: {
      drawingNumber: 'GW-01',
      revision: 'R2',
      sectionId: 'REGION-12',
      handles: ['7A118'],
      rawText: 'STIRRUP ZONE 1200 AT ENDS',
    },
    readOn: '2026-08-29',
  },
  // The re-read also sees a wall run — but a human already supplied it.
  {
    id: 'wall.total_run',
    value: 99500,
    unit: 'mm',
    state: 'DECLARED',
    source: { drawingNumber: 'GW-01', revision: 'R2', handles: ['79B01'] },
    readOn: '2026-08-29',
  },
];

const revise = () =>
  applyRevisionFacts(seeded(), {
    drawingNumber: 'GW-01',
    oldRevision: 'R1',
    newRevision: 'R2',
    newFacts: R2_FACTS,
  });

describe('applyRevisionFacts — GW-01 R1 → R2 (§5.4)', () => {
  it('produces the impact report in the §5.4 shape', () => {
    const { impact } = revise();

    expect(impact.drawing).toBe('GW-01');
    expect(impact.from).toBe('R1');
    expect(impact.to).toBe('R2');

    // CHANGED 2 — each line carries both values and both resolvable sources.
    expect(impact.changed).toHaveLength(2);
    const section = impact.changed.find((c) => c.id === 'TB.section')!;
    expect(section.oldValue).toBe('350x400');
    expect(section.newValue).toBe('350x450');
    expect(section.oldSource).toMatchObject({
      drawingNumber: 'GW-01',
      revision: 'R1',
      sectionId: 'REGION-12',
      handles: ['79A47'],
    });
    expect(section.newSource).toMatchObject({
      drawingNumber: 'GW-01',
      revision: 'R2',
      sectionId: 'REGION-12',
      handles: ['79A47'],
    });
    const steel = impact.changed.find((c) => c.id === 'TB.top_steel')!;
    expect(steel.oldValue).toBe('2-16+2-12');
    expect(steel.newValue).toBe('3-16+2-12');

    expect(impact.unchanged).toEqual(['TB.stirrups']);
    expect(impact.added).toEqual(['TB.stirrup_zone']);
    expect(impact.nowMissing).toEqual(['TB.old_note']);
    expect(impact.survived).toContain('wall.total_run');
  });

  it('replaces changed facts via the newer-revision path and moves unchanged sources to R2', () => {
    const { ledger } = revise();

    const current = resolveFact(ledger, 'TB.section')!;
    expect(current.value).toBe('350x450');
    expect(current.state).toBe('DECLARED');
    expect(current.source!.revision).toBe('R2');

    // The old reading survives in history with its source and the reason.
    const versions = factVersions(ledger, 'TB.section');
    expect(versions).toHaveLength(2);
    expect(versions[1].value).toBe('350x400');
    expect(versions[1].reason).toBe('newer-revision');
    expect(versions[1].source).toMatchObject({ revision: 'R1', handles: ['79A47'] });

    // Unchanged facts are re-recorded too, so their provenance is the new sheet.
    expect(resolveFact(ledger, 'TB.stirrups')!.source!.revision).toBe('R2');
    expect(resolveFact(ledger, 'TB.stirrup_zone')!.value).toBe('1200 at ends');
  });

  it('facts absent from the new revision become MISSING, recording where it was looked for', () => {
    const { ledger } = revise();

    const gone = resolveFact(ledger, 'TB.old_note')!;
    expect(gone.state).toBe('MISSING');
    expect(gone.value).toBeNull();
    expect(gone.lookedIn).toEqual(['GW-01 R2']);
    expect(gone.ask).toMatch(/TB\.old_note/);
    expect(gone.ask).toMatch(/R1/);
    expect(gone.ask).toMatch(/not found on R2/);
    expect(missingFacts(ledger).map((f) => f.id)).toEqual(['TB.old_note']);

    // It was on R1 — the reading is in history, not deleted.
    const versions = factVersions(ledger, 'TB.old_note');
    expect(versions[1].value).toBe('LAP AT MIDSPAN');
    expect(versions[1].reason).toBe('newer-revision');
  });

  it('SUPPLIED facts survive untouched; DERIVED facts are marked stale for recompute', () => {
    const { ledger, impact } = revise();

    // Survival rule 1: the human's 100 m answer stands, the R2 re-read did
    // not displace it.
    const run = resolveFact(ledger, 'wall.total_run')!;
    expect(run.state).toBe('SUPPLIED');
    expect(run.value).toBe(100000);
    expect(factHistory(ledger, 'wall.total_run')).toHaveLength(1);
    expect(impact.survived).toEqual(['wall.total_run']);

    // Survival rule 2: derived facts are recomputed, not carried.
    const height = resolveFact(ledger, 'wall.height')!;
    expect(height.state).toBe('DERIVED');
    expect(height.stale).toBe(true);
  });

  it('touches nothing sourced from other drawings, and the input ledger is not mutated', () => {
    const before = seeded();
    const entryCount = before.entries.length;
    const { ledger } = applyRevisionFacts(before, {
      drawingNumber: 'GW-01',
      oldRevision: 'R1',
      newRevision: 'R2',
      newFacts: R2_FACTS,
    });

    const grid = resolveFact(ledger, 'arch.grid')!;
    expect(grid.value).toBe(6000);
    expect(grid.stale).toBeFalsy();
    expect(grid.source!.drawingNumber).toBe('ARCH-101');

    expect(before.entries.length).toBe(entryCount);
    expect(resolveFact(before, 'TB.section')!.value).toBe('350x400');
  });

  it('loses nothing: every pre-revision value is still reachable', () => {
    const { ledger } = revise();
    for (const [id, oldValue] of [
      ['TB.section', '350x400'],
      ['TB.top_steel', '2-16+2-12'],
      ['TB.stirrups', '8@150'],
      ['TB.old_note', 'LAP AT MIDSPAN'],
    ] as const) {
      const values = factHistory(ledger, id).map((f) => f.value);
      expect(values).toContain(oldValue);
    }
  });
});
