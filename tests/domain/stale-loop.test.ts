// WHY ONE DRAWING PRODUCED FORTY-NINE SCHEDULES.
//
// The engine records its dependencies as ENGINE KEYS (`f1_width`, `run`),
// because that is the shape `userFacts` reaches it in. The ledger keys the
// same facts as `F1.width` and `wall.total_run`. The freshness check looked
// every manifest id up in a ledger-keyed map, so every engine key came back
// undefined, every check said STALE, and the automatic rebuild that answers a
// stale schedule ran again — filing another version each time.
//
// Three things had to be true to stop it, and all three are pinned here:
// the manifest speaks one key space; a schedule with nothing changed is
// FRESH; and an identical rebuild is not a new version.
import { describe, expect, it } from 'vitest';
import { checkManifestFreshness, type BBSBuildManifest } from '../../src/core/bbs/schemas';
import { currentFactVersions, stampManifest, staleFacts, staleRowsOf } from '../../src/studio/bbsFacts';
import { emptyLedger, overrideFact, recordFact } from '../../src/facts/ledger';
import type { Fact } from '../../src/facts/types';
import type { Ledger } from '../../src/facts/ledger';

const fact = (id: string, value: number): Fact => ({
  id,
  value,
  unit: 'mm',
  state: 'DECLARED',
  readOn: '2026-09-06',
});

/** a ledger holding the facts a footing schedule reads */
function ledgerWith(ids: readonly string[]): Ledger {
  let ledger = emptyLedger();
  ids.forEach((id, i) => {
    ledger = recordFact(ledger, fact(id, 1000 + i)).ledger;
  });
  return ledger;
}

/** what buildBbs produces: engine keys from the takeoff, ledger ids from row traces */
const engineManifest = (): BBSBuildManifest => ({
  buildId: 'build-1',
  builtAt: 1,
  drawingHash: 'doc:abc',
  factIds: ['f1_width', 'f1_length', 'f2_width', 'run', 'runM'],
  factVersions: { f1_width: 1, f1_length: 1, f2_width: 1, run: 1, runM: 1 },
  rowDeps: [
    { rowId: 'F1:F1-M1', factIds: ['F1.width', 'F1.length', 'f1_width', 'runM'], drawingHash: 'doc:abc' },
    { rowId: 'F2:F2-M1', factIds: ['F2.width', 'f2_width'], drawingHash: 'doc:abc' },
  ],
  status: 'VALIDATED',
});

const LEDGER_IDS = ['F1.width', 'F1.length', 'F2.width', 'wall.total_run'];

describe('the manifest speaks ONE key space', () => {
  it('stamps only ids the ledger can answer for', () => {
    const ledger = ledgerWith(LEDGER_IDS);
    const stamped = stampManifest(engineManifest(), ledger, 'doc:abc');

    expect([...stamped.factIds].sort()).toEqual([...LEDGER_IDS].sort());
    // the engine keys are gone — they could never be matched against a ledger
    for (const engineKey of ['f1_width', 'f1_length', 'f2_width', 'run', 'runM']) {
      expect(stamped.factIds).not.toContain(engineKey);
      expect(stamped.factVersions[engineKey]).toBeUndefined();
    }
  });

  it('a freshly stamped schedule is FRESH — this is the whole bug', () => {
    const ledger = ledgerWith(LEDGER_IDS);
    const stamped = stampManifest(engineManifest(), ledger, 'doc:abc');

    const freshness = checkManifestFreshness(stamped, currentFactVersions(ledger), 'doc:abc');
    expect(freshness.staleFactIds).toEqual([]);
    expect(freshness.drawingChanged).toBe(false);
    expect(freshness.fresh).toBe(true);
    expect(staleFacts(ledger, stamped, 'doc:abc')).toEqual([]);
  });

  it('the UNSTAMPED manifest is what reported everything stale, forever', () => {
    // Kept as the regression's own witness: this is the state the app was in.
    const ledger = ledgerWith(LEDGER_IDS);
    const raw = engineManifest();
    expect(staleFacts(ledger, raw, 'doc:abc').sort()).toEqual(
      ['F1.length', 'F1.width', 'F2.width', 'f1_length', 'f1_width', 'f2_width', 'run', 'runM', 'wall.total_run'].sort(),
    );
  });

  it('row dependencies are translated too, so a changed fact names its rows', () => {
    const ledger = ledgerWith(LEDGER_IDS);
    const stamped = stampManifest(engineManifest(), ledger, 'doc:abc');
    for (const dep of stamped.rowDeps) {
      for (const id of dep.factIds) expect(LEDGER_IDS).toContain(id);
    }
    expect(staleRowsOf(stamped, ['F1.length'])).toEqual(['F1:F1-M1']);
    expect(staleRowsOf(stamped, ['F2.width'])).toEqual(['F2:F2-M1']);
  });
});

describe('a real change is still detected', () => {
  it('an answer that supersedes a fact makes exactly that schedule stale', () => {
    let ledger = ledgerWith(LEDGER_IDS);
    const stamped = stampManifest(engineManifest(), ledger, 'doc:abc');
    expect(staleFacts(ledger, stamped, 'doc:abc')).toEqual([]);

    // `overrideFact` is the path a person's correction actually takes. A plain
    // SUPPLIED recordFact would be REFUSED here and rightly so — SUPPLIED is
    // lower trust than DECLARED, so a reading is not displaced by an answer
    // unless the answer is an explicit override.
    ledger = overrideFact(ledger, 'F1.length', { value: 3500, suppliedBy: 'you' });

    expect(staleFacts(ledger, stamped, 'doc:abc')).toEqual(['F1.length']);
    expect(staleRowsOf(stamped, ['F1.length'])).toEqual(['F1:F1-M1']);
  });

  it('a new fact nobody read yet also counts as a change', () => {
    let ledger = ledgerWith(LEDGER_IDS);
    const stamped = stampManifest(engineManifest(), ledger, 'doc:abc');
    ledger = recordFact(ledger, fact('F9.width', 2900)).ledger;
    expect(staleFacts(ledger, stamped, 'doc:abc')).toEqual(['F9.width']);
  });

  it('a re-imported drawing stales everything, by hash alone', () => {
    const ledger = ledgerWith(LEDGER_IDS);
    const stamped = stampManifest(engineManifest(), ledger, 'doc:abc');
    const stale = staleFacts(ledger, stamped, 'doc:CHANGED');
    expect(stale).toContain('drawing.hash');
    expect(staleRowsOf(stamped, stale).sort()).toEqual(['F1:F1-M1', 'F2:F2-M1']);
  });
});

describe('rebuilding is idempotent', () => {
  it('stamping the same build ten times never makes it stale', () => {
    const ledger = ledgerWith(LEDGER_IDS);
    let manifest = engineManifest();
    for (let i = 0; i < 10; i++) {
      manifest = stampManifest(manifest, ledger, 'doc:abc');
      expect(staleFacts(ledger, manifest, 'doc:abc')).toEqual([]);
    }
  });
});
