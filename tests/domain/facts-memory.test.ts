// Layer 1+2 of the product-as-harness architecture (PRODUCT_AS_HARNESS §3):
// trust-ordered overwrite, hash staleness, the producer→ledger writers, and
// IndexedDB persistence with its localStorage fallback.
import { describe, expect, it } from 'vitest';
import { buildPlacementBands } from '../../src/cad/bbs/bands';
import type { EvidenceGraph, EvidenceNode } from '../../src/cad/bbs/evidence';
import type { InterviewExchange } from '../../src/cad/bbs/interview';
import type { CoverageSummary } from '../../src/cad/understanding/coverage';
import {
  addFact,
  emptyLedger,
  factHistory,
  invalidateBySource,
  recordFact,
  resolveFact,
  type Ledger,
} from '../../src/facts/ledger';
import { loadLedgerIdb, saveLedgerIdb } from '../../src/facts/store';
import type { Fact } from '../../src/facts/types';
import {
  factsFromCoverage,
  factsFromInterviewAnswers,
  factsFromPlacementBands,
  factsFromTranscription,
  type DeclaredFactInput,
} from '../../src/facts/writers';

const READ_ON = '2026-08-29';

const measuredPitch: Fact = {
  id: 'columns.main_pitch',
  value: 4157,
  unit: 'mm',
  state: 'MEASURED',
  source: { drawingNumber: 'GW-01', revision: 'R1', documentId: 'doc-gw01' },
  method: 'buildPlacementBands() over F1/C1 mark occurrences',
  sourceDrawingHash: 'hash-a',
  readOn: READ_ON,
};

describe('recordFact — trust-ordered overwrite (§3.3)', () => {
  it('a DECLARED claim cannot replace a MEASURED value; the claim is recorded as contradicted', () => {
    // The §5 failure from the build guide: GLM's prose claim about the layout
    // ("48 bays" → a much smaller pitch) is DECLARED at best; the measured
    // 4157 mm pitch must hold, and the losing claim must stay on the record.
    let ledger = recordFact(emptyLedger(), measuredPitch).ledger;

    const glmClaim: Fact = {
      id: 'columns.main_pitch',
      value: 2000,
      unit: 'mm',
      state: 'DECLARED',
      source: { drawingNumber: 'GW-01', revision: 'R1', rawText: '48 BAYS' },
      readOn: READ_ON,
    };
    const result = recordFact(ledger, glmClaim);
    ledger = result.ledger;

    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/lower trust/);

    // The measurement is still current.
    const current = resolveFact(ledger, 'columns.main_pitch')!;
    expect(current.state).toBe('MEASURED');
    expect(current.value).toBe(4157);
    // …and knows it was contradicted.
    expect(current.contradictedBy).toHaveLength(1);
    expect(current.contradictedBy![0]).toMatch(/^columns\.main_pitch@\d+$/);

    // The claim was NOT dropped: it is in history, flagged, never current.
    const history = factHistory(ledger, 'columns.main_pitch');
    expect(history).toHaveLength(2);
    const rejected = history[1];
    expect(rejected.value).toBe(2000);
    expect(rejected.contradicts).toMatch(/^columns\.main_pitch@\d+$/);
    expect(rejected.supersededBy).toBeDefined();
  });

  it('a strictly higher-trust state replaces: MEASURED over DECLARED, anything over MISSING', () => {
    let ledger = recordFact(emptyLedger(), {
      id: 'columns.main_pitch',
      value: 4000,
      unit: 'mm',
      state: 'DECLARED',
      source: { drawingNumber: 'GW-01', revision: 'R1' },
      readOn: READ_ON,
    }).ledger;

    const up = recordFact(ledger, measuredPitch);
    expect(up.accepted).toBe(true);
    expect(resolveFact(up.ledger, 'columns.main_pitch')!.value).toBe(4157);

    // SUPPLIED (trust 1) beats MISSING (trust 0).
    let l2 = recordFact(emptyLedger(), {
      id: 'wall.total_run',
      value: null,
      state: 'MISSING',
      ask: 'What is the total run?',
      readOn: READ_ON,
    }).ledger;
    const supplied = recordFact(l2, {
      id: 'wall.total_run',
      value: 96500,
      unit: 'mm',
      state: 'SUPPLIED',
      suppliedBy: 'site engineer',
      saidAs: 'run is 96.5',
      readOn: READ_ON,
    });
    expect(supplied.accepted).toBe(true);
    expect(resolveFact(supplied.ledger, 'wall.total_run')!.state).toBe('SUPPLIED');
  });

  it('same state replaces only from a newer revision of the same drawing', () => {
    const base = recordFact(emptyLedger(), measuredPitch).ledger;

    // R2 of GW-01 — newer revision, same state: accepted.
    const newer = recordFact(base, {
      ...measuredPitch,
      value: 4187,
      source: { drawingNumber: 'GW-01', revision: 'R2', documentId: 'doc-gw01' },
      sourceDrawingHash: 'hash-b',
    });
    expect(newer.accepted).toBe(true);
    expect(resolveFact(newer.ledger, 'columns.main_pitch')!.value).toBe(4187);
    expect(resolveFact(newer.ledger, 'columns.main_pitch')!.source!.revision).toBe('R2');

    // Same revision again: rejected, recorded as contradicting.
    const same = recordFact(base, { ...measuredPitch, value: 9999 });
    expect(same.accepted).toBe(false);
    expect(resolveFact(same.ledger, 'columns.main_pitch')!.value).toBe(4157);

    // Older revision (R0 < R1): rejected.
    const older = recordFact(base, {
      ...measuredPitch,
      value: 3000,
      source: { drawingNumber: 'GW-01', revision: 'R0', documentId: 'doc-gw01' },
    });
    expect(older.accepted).toBe(false);

    // Same state from a DIFFERENT drawing: rejected — it contradicts, it does
    // not silently replace.
    const other = recordFact(base, {
      ...measuredPitch,
      value: 5000,
      source: { drawingNumber: 'GW-02', revision: 'R9', documentId: 'doc-gw02' },
    });
    expect(other.accepted).toBe(false);
    expect(resolveFact(other.ledger, 'columns.main_pitch')!.contradictedBy).toHaveLength(1);
  });
});

describe('invalidateBySource — hash staleness (§3.4)', () => {
  function seeded(): Ledger {
    let ledger = addFact(emptyLedger(), measuredPitch); // hash-a, GW-01
    ledger = addFact(ledger, {
      id: 'TB.section',
      value: '350x400',
      state: 'DECLARED',
      source: { drawingNumber: 'GW-01', revision: 'R1', documentId: 'doc-gw01', handles: ['79A47'] },
      sourceDrawingHash: 'hash-a',
      readOn: READ_ON,
    });
    ledger = addFact(ledger, {
      id: 'BW.height',
      value: 1200,
      unit: 'mm',
      state: 'SUPPLIED',
      suppliedBy: 'client',
      saidAs: '1.2 m above the footing',
      source: { drawingNumber: 'GW-01', revision: 'R1', documentId: 'doc-gw01' },
      sourceDrawingHash: 'hash-a',
      readOn: READ_ON,
    });
    ledger = addFact(ledger, {
      id: 'arch.grid',
      value: 6000,
      unit: 'mm',
      state: 'MEASURED',
      source: { drawingNumber: 'ARCH-101', revision: 'C' },
      sourceDrawingHash: 'hash-x',
      readOn: READ_ON,
    });
    return ledger;
  }

  it('marks facts from the re-imported drawing stale — never deleted — and spares SUPPLIED', () => {
    const ledger = invalidateBySource(seeded(), 'GW-01', 'hash-b');

    expect(resolveFact(ledger, 'columns.main_pitch')!.stale).toBe(true);
    expect(resolveFact(ledger, 'TB.section')!.stale).toBe(true);
    // The values themselves survive with provenance intact.
    expect(resolveFact(ledger, 'columns.main_pitch')!.value).toBe(4157);

    // A human's answer does not expire when a drawing is revised.
    expect(resolveFact(ledger, 'BW.height')!.stale).toBeFalsy();

    // Facts from other drawings are untouched.
    expect(resolveFact(ledger, 'arch.grid')!.stale).toBeFalsy();
  });

  it('matches by documentId too, and un-marks when the hash matches again', () => {
    const stale = invalidateBySource(seeded(), 'doc-gw01', 'hash-b');
    expect(resolveFact(stale, 'columns.main_pitch')!.stale).toBe(true);

    const fresh = invalidateBySource(stale, 'doc-gw01', 'hash-a');
    expect(resolveFact(fresh, 'columns.main_pitch')!.stale).toBeFalsy();
  });
});

describe('fact writers (§3.2)', () => {
  const source = {
    drawingNumber: 'GW-01',
    revision: 'R1',
    documentId: 'doc-gw01',
    sourceDrawingHash: 'hash-a',
    readOn: READ_ON,
  };

  function markNode(id: string, mark: string, x: number, y: number): EvidenceNode {
    return { id, kind: 'mark', sourceHandles: [id], position: { x, y }, metadata: { mark } };
  }

  function graphOf(nodes: EvidenceNode[]): EvidenceGraph {
    return {
      nodes,
      edges: [],
      byId: new Map(nodes.map((n) => [n.id, n])),
      dimensions: [],
      diagnostics: [],
      related: () => [],
      inPanel: () => [],
    };
  }

  it('factsFromPlacementBands emits MEASURED pitch/run/nodes off the geometry', () => {
    const nodes = [0, 4157, 8314, 12471].map((x, i) => markNode(`MARK-C1-${i}`, 'C1', x, 0));
    const graph = graphOf(nodes);
    const bands = buildPlacementBands(graph);
    expect(bands.bands).toHaveLength(1);

    const facts = factsFromPlacementBands(bands, source, graph);
    const byId = new Map(facts.map((f) => [f.id, f]));

    const pitch = byId.get('columns.main_pitch')!;
    expect(pitch.state).toBe('MEASURED');
    expect(pitch.value).toBe(4157);
    expect(pitch.unit).toBe('mm');
    expect(pitch.method).toMatch(/buildPlacementBands/);
    expect(pitch.source).toMatchObject({ drawingNumber: 'GW-01', revision: 'R1' });
    expect(pitch.sourceDrawingHash).toBe('hash-a');

    expect(byId.get('columns.main_run')!.value).toBe(12471);
    expect(byId.get('columns.main_nodes')!.value).toBe(4);
    // No pitch is estimated without node positions.
    expect(factsFromPlacementBands(bands, source).map((f) => f.id)).toEqual(['columns.main_run']);
  });

  it('factsFromCoverage emits MEASURED sheet.coverage', () => {
    const coverage: CoverageSummary = {
      measurableEntities: 200,
      coveredEntities: 195,
      uncoveredEntities: 5,
      gaps: [{ layer: 'DIM', count: 5, sampleHandles: ['A1'], sampleText: [], bounds: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 } }],
    };
    const [fact] = factsFromCoverage(coverage, source);
    expect(fact.id).toBe('sheet.coverage');
    expect(fact.state).toBe('MEASURED');
    expect(fact.value).toBe(0.975);
    expect(fact.method).toMatch(/computeCoverage/);
  });

  it('factsFromInterviewAnswers emits SUPPLIED facts carrying the exact words', () => {
    const exchanges: InterviewExchange[] = [
      {
        question: {
          id: 'BW-height',
          text: 'How far above the footing does the wall run?',
          why: 'vertical bar length',
          kind: 'number',
          unit: 'mm',
          writes: { scope: 'member', mark: 'BW', field: 'heightMm' },
        },
        answer: { questionId: 'BW-height', value: 1200 },
        at: Date.parse('2026-08-29T10:00:00Z'),
      },
      {
        question: {
          id: 'run-total',
          text: 'What is the total run of the boundary wall?',
          why: 'every per-running-metre quantity multiplies by it',
          kind: 'number',
          unit: 'mm',
          writes: { scope: 'takeoff', field: 'wall.total_run' },
        },
        answer: { questionId: 'run-total', value: 96500 },
        at: Date.parse('2026-08-29T10:01:00Z'),
      },
      {
        // skipped — must produce nothing
        question: {
          id: 'corners',
          text: 'How many corners?',
          why: 'corner bars',
          kind: 'number',
          writes: { scope: 'takeoff', field: 'wall.corners' },
        },
        skipped: true,
        at: Date.parse('2026-08-29T10:02:00Z'),
      },
    ];

    const facts = factsFromInterviewAnswers(exchanges, { suppliedBy: 'hello@shivik.in' });
    expect(facts.map((f) => f.id)).toEqual(['BW.heightMm', 'wall.total_run']);
    for (const f of facts) {
      expect(f.state).toBe('SUPPLIED');
      expect(f.suppliedBy).toBe('hello@shivik.in');
    }
    expect(facts[0].saidAs).toBe('1200');
    expect(facts[0].value).toBe(1200);
    expect(facts[1].saidAs).toBe('96500');
    expect(facts[1].evidence![0]).toMatch(/total run/);
  });

  it('factsFromTranscription emits DECLARED facts with verbatim text and handles', () => {
    const declared: DeclaredFactInput[] = [
      {
        id: 'TB.section',
        value: '350x400',
        sectionId: 'REGION-11',
        rawText: 'C/S OF TB-(350X400)',
        handles: ['79A47'],
      },
    ];
    const [fact] = factsFromTranscription(declared, source);
    expect(fact.state).toBe('DECLARED');
    expect(fact.id).toBe('TB.section');
    expect(fact.value).toBe('350x400');
    expect(fact.source).toMatchObject({
      drawingNumber: 'GW-01',
      revision: 'R1',
      sectionId: 'REGION-11',
      rawText: 'C/S OF TB-(350X400)',
      handles: ['79A47'],
    });
    expect(fact.evidence).toContain('handle 79A47');
    expect(fact.sourceDrawingHash).toBe('hash-a');
  });

  it('writer output flows through recordFact with the trust rule intact', () => {
    // The full §3.3 wiring: transcription (DECLARED) lands first, measurement
    // (MEASURED) replaces it, a later DECLARED re-read is held off.
    let ledger = emptyLedger();
    for (const f of factsFromTranscription(
      [{ id: 'columns.main_pitch', value: 2000, rawText: '48 BAYS', unit: 'mm' }],
      source,
    )) {
      ledger = recordFact(ledger, f).ledger;
    }
    expect(resolveFact(ledger, 'columns.main_pitch')!.state).toBe('DECLARED');

    ledger = recordFact(ledger, measuredPitch).ledger;
    expect(resolveFact(ledger, 'columns.main_pitch')!.value).toBe(4157);

    const again = recordFact(
      ledger,
      factsFromTranscription(
        [{ id: 'columns.main_pitch', value: 2000, rawText: '48 BAYS', unit: 'mm' }],
        source,
      )[0],
    );
    expect(again.accepted).toBe(false);
    expect(resolveFact(again.ledger, 'columns.main_pitch')!.value).toBe(4157);
  });
});

describe('IndexedDB persistence (§3.1)', () => {
  it('saveLedgerIdb/loadLedgerIdb round-trip a ledger, falling back when IndexedDB is absent', async () => {
    // jsdom carries no IndexedDB, so this exercises the guard + the
    // localStorage fallback across the same serialized format. In a browser
    // the identical calls land in the STORE_PROJECT_FACTS object store.
    let ledger = recordFact(emptyLedger(), measuredPitch).ledger;
    ledger = recordFact(ledger, {
      id: 'columns.main_pitch',
      value: 2000,
      unit: 'mm',
      state: 'DECLARED',
      source: { drawingNumber: 'GW-01', revision: 'R1' },
      readOn: READ_ON,
    }).ledger;

    expect(await saveLedgerIdb('project-idb', ledger)).toBe(true);
    const loaded = await loadLedgerIdb('project-idb');
    expect(loaded).not.toBeNull();
    // Trust bookkeeping — contradicts/contradictedBy — survives persistence.
    expect(resolveFact(loaded!, 'columns.main_pitch')!.value).toBe(4157);
    expect(resolveFact(loaded!, 'columns.main_pitch')!.contradictedBy).toHaveLength(1);
    expect(factHistory(loaded!, 'columns.main_pitch')[1].contradicts).toBeDefined();
    expect(await loadLedgerIdb('project-never-saved')).toBeNull();
  });
});
