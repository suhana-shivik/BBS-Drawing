// ============================================================
// The resolution loop (PRODUCT_AS_HARNESS.md §4.2) and the transcription
// stage — proven unpaid, with a fake register, a fake splitter harness and a
// fake transcriber. What is on trial:
//
//   · no candidate → MISSING recorded with lookedIn naming what was searched
//     and the skill's own ask, and compute still emits BLOCKED formula rows
//   · candidate + allowModelCalls → split → transcribe → a DECLARED fact
//     lands with full provenance, and compute produces real numbers
//   · allowModelCalls=false NEVER invokes a transport (call counts stay 0)
//   · bounds respected: drawings searched and splits per run are capped,
//     every skip named
//   · the §4.2 payoff: the ledger persists, and a SECOND run starts from it
//     without re-searching — the splitter is not called again
//   · the transcriber validates structured output and REFUSES unparseable
//     replies rather than guessing
// ============================================================
import { describe, expect, it, vi } from 'vitest';
import {
  runSkill,
  factSetFromLedger,
  selectCandidateDrawing,
  type LedgerStore,
  type RunSkillContext,
  type SplitRunner,
  type Transcriber,
} from '../../src/skills/run';
import { bbsSkill, BBS_FACT_KEYS, type SkillFactValue } from '../../src/skills';
import { emptyLedger, resolveFact, type Ledger } from '../../src/facts/ledger';
import {
  transcribeSections,
  transcriberFrom,
  buildTranscriptionPrompt,
  TranscriptionRefused,
  TRANSCRIBE_SYSTEM,
  type TranscribeAsk,
} from '../../src/harness/transcribe';
import type { DrawingRegisterData, DrawingRegisterEntry } from '../../src/register/types';
import type { BbsInterpretation, DrawingExtract } from '../../src/cad/bbs/types';
import type { CadDocument } from '../../src/cad/types';

// ------------------------------------------------------------
// the GAMCO shape (same fixture the manifest tests prove compute with):
// one drawn bay, a dimensioned pitch, no count column — the run lives on
// the architectural drawing
// ------------------------------------------------------------

const EXTRACT: DrawingExtract = {
  drawingName: 'g',
  sourceFile: 'g.dxf',
  tables: [],
  callouts: [],
  notes: { notes: [] },
  marks: ['TB'],
  declared: [],
  unitScale: 1,
};

const READING: BbsInterpretation = {
  members: [
    {
      mark: 'TB',
      type: 'tie beam',
      lengthMm: 4157,
      widthMm: 350,
      heightMm: 400,
      count: 1,
      countRule: { pitchMm: 4157, endsInclusive: true },
      source: { table: '', row: -1 },
      incomplete: false,
      missing: [],
    },
  ],
  bars: [
    {
      barMark: 'TB-M1',
      memberMark: 'TB',
      barType: 'MAIN',
      diaMm: 16,
      shapeCode: '00',
      manualCount: 2,
      fromCallout: '2-16TOR',
      handles: [],
    },
  ],
  unresolved: [],
};

const CONCLUSIONS: Record<string, SkillFactValue> = {
  [BBS_FACT_KEYS.extract]: { value: EXTRACT, state: 'derived' },
  [BBS_FACT_KEYS.interpretation]: { value: READING, state: 'derived' },
};

// ------------------------------------------------------------
// fakes
// ------------------------------------------------------------

function entry(over: Partial<DrawingRegisterEntry>): DrawingRegisterEntry {
  return {
    id: 'e1',
    projectId: 'p1',
    documentId: 'doc-1',
    assetId: 'a1',
    originalFileName: 'x.dxf',
    displayName: 'x',
    drawingNumber: 'X-01',
    identityKey: 'x-01',
    title: 'UNTITLED',
    revision: 'R1',
    revisionRank: 1,
    issueDate: '2026-01-01',
    discipline: 'general',
    health: 'ready',
    revisionState: 'current',
    versionNo: 1,
    versionCount: 1,
    importedAt: 1,
    warnings: [],
    evidence: {},
    ...over,
  };
}

const ARCH = entry({
  id: 'e-arch',
  documentId: 'doc-arch',
  drawingNumber: 'ARCH-101',
  displayName: 'ARCH-101',
  title: 'BOUNDARY WALL LAYOUT',
  revision: 'C',
  discipline: 'architectural',
});

const STRUCT = entry({
  id: 'e-struct',
  documentId: 'doc-struct',
  drawingNumber: 'GW-01',
  displayName: 'GW-01',
  title: 'BOUNDARY WALL REINFORCEMENT DETAILS',
  discipline: 'structural',
});

function register(...entries: DrawingRegisterEntry[]): DrawingRegisterData {
  return { projectId: 'p1', entries, updatedAt: 1 };
}

/** in-memory ledger store — what persists between "runs" in these tests */
function memoryStore(): LedgerStore & { map: Map<string, Ledger> } {
  const map = new Map<string, Ledger>();
  return {
    map,
    load: async (id) => map.get(id) ?? null,
    save: async (id, ledger) => {
      map.set(id, ledger);
      return true;
    },
  };
}

const fakeDoc = { id: 'doc-arch', entities: [] } as unknown as CadDocument;

function fakes() {
  const splitter: SplitRunner = {
    run: vi.fn(async () => ({
      output: {
        sections: [
          { sectionId: 'REGION-03', label: 'BOUNDARY WALL LAYOUT', kind: 'plan' },
        ],
        sourceDrawingHash: 'hash-arch',
      },
    })),
  };
  const transcribe: Transcriber = vi.fn(async () => [
    {
      id: 'wall.total_run',
      value: 100000,
      unit: 'mm',
      sectionId: 'REGION-03',
      rawText: '100000',
      handles: ['4F2A1'],
    },
  ]);
  const loadDocument = vi.fn(async () => fakeDoc);
  return { splitter, transcribe, loadDocument };
}

function ctx(over: Partial<RunSkillContext>): RunSkillContext {
  return {
    projectId: 'p1',
    register: register(ARCH, STRUCT),
    allowModelCalls: false,
    conclusions: CONCLUSIONS,
    ledgerStore: memoryStore(),
    ...over,
  };
}

const calls = (fn: unknown): number => (fn as ReturnType<typeof vi.fn>).mock.calls.length;

// ============================================================
// 1 · no candidate → MISSING + BLOCKED
// ============================================================

describe('the resolution loop with no candidate drawing', () => {
  it('records MISSING with lookedIn + the skill’s ask, and emits BLOCKED rows', async () => {
    const f = fakes();
    const store = memoryStore();
    const result = await runSkill(
      bbsSkill,
      ctx({
        register: register(STRUCT), // no architectural drawing at all
        allowModelCalls: true,
        ...f,
        ledgerStore: store,
      }),
    );

    // no candidate for an architectural fact — the splitter is never invoked
    expect(calls(f.splitter.run)).toBe(0);
    expect(calls(f.transcribe)).toBe(0);

    // the MISSING record documents the failed search, §6.2 style
    expect(result.factsMissing).toHaveLength(1);
    const missing = result.factsMissing[0];
    expect(missing.id).toBe('wall.total_run');
    expect(missing.ask).toBe('What is the total run of the boundary wall?');
    expect(missing.lookedIn!.join(' ')).toMatch(/architectural/);
    expect(missing.value).toBeNull();
    expect(missing.neededFor!.length).toBeGreaterThan(0);

    // compute still ran — the row is a FORMULA with a named hole, not a number
    expect(result.output).not.toBeNull();
    const blocked = result.output!.blocked.find((b) => b.rowId === 'TB');
    expect(blocked).toBeDefined();
    expect(blocked!.missingKeys).toEqual(['wall.total_run']);
    expect(blocked!.formula).toContain('wall.total_run');

    // everything learned was deposited and persisted
    expect(result.persisted).toBe(true);
    expect(resolveFact(store.map.get('p1')!, 'wall.total_run')!.state).toBe('MISSING');
  });

  it('an empty register still names what was (not) searched', async () => {
    const result = await runSkill(bbsSkill, ctx({ register: null, allowModelCalls: false }));
    expect(result.factsMissing[0].lookedIn!.join(' ')).toMatch(/register: empty/);
  });

  it('a compute refusal is returned, never swallowed — and memory still persists', async () => {
    // no conclusions deposited: bbs.extract / bbs.interpretation are unmet
    // and no drawing can transcribe an orchestrator conclusion
    const store = memoryStore();
    const result = await runSkill(
      bbsSkill,
      ctx({ register: null, conclusions: undefined, ledgerStore: store }),
    );
    expect(result.output).toBeNull();
    expect(result.notComputable).toMatch(/bbs\.extract/);
    expect(result.factsMissing.map((f) => f.id)).toEqual([
      'bbs.extract',
      'bbs.interpretation',
      'wall.total_run',
    ]);
    expect(store.map.get('p1')!.entries.length).toBe(3);
  });
});

// ============================================================
// 2 · candidate + allowModelCalls → DECLARED with provenance
// ============================================================

describe('the resolution loop with a candidate and spending allowed', () => {
  it('split → transcribe → DECLARED fact with provenance, and compute produces numbers', async () => {
    const f = fakes();
    const result = await runSkill(bbsSkill, ctx({ allowModelCalls: true, ...f }));

    // the loop picked the architectural layout by discipline + title (§6.5 signal 1)
    expect(calls(f.loadDocument)).toBe(1);
    expect((f.loadDocument as ReturnType<typeof vi.fn>).mock.calls[0][0].drawingNumber).toBe(
      'ARCH-101',
    );
    expect(calls(f.splitter.run)).toBe(1);
    expect(calls(f.transcribe)).toBe(1);
    const askedFor = (f.transcribe as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(askedFor.drawingNumber).toBe('ARCH-101');
    expect(askedFor.wanted).toEqual([
      { key: 'wall.total_run', ask: 'What is the total run of the boundary wall?' },
    ]);

    // the DECLARED fact landed with full provenance — quotable, handled, hashed
    const fact = resolveFact(result.ledger, 'wall.total_run')!;
    expect(fact.state).toBe('DECLARED');
    expect(fact.value).toBe(100000);
    expect(fact.unit).toBe('mm');
    expect(fact.source).toMatchObject({
      drawingNumber: 'ARCH-101',
      revision: 'C',
      documentId: 'doc-arch',
      sectionId: 'REGION-03',
      rawText: '100000',
      handles: ['4F2A1'],
    });
    expect(fact.sourceDrawingHash).toBe('hash-arch');
    expect(result.factsWritten.map((x) => x.id)).toContain('wall.total_run');
    expect(result.factsMissing).toHaveLength(0);

    // compute now owns the number: ⌊100000/4157⌋ + 1 = 25 — the GAMCO fix
    const rows = result.output!.rows as { memberMark: string; memberCount: number }[];
    expect(rows.find((r) => r.memberMark === 'TB')!.memberCount).toBe(25);
    expect(result.output!.blocked.filter((b) => b.missingKeys.length > 0)).toEqual([]);
  });

  it('a drawing that does not state the fact → MISSING naming the drawing that WAS read', async () => {
    const f = fakes();
    (f.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue([]); // sheet silent
    const result = await runSkill(bbsSkill, ctx({ allowModelCalls: true, ...f }));
    expect(calls(f.splitter.run)).toBe(1);
    const missing = result.factsMissing.find((x) => x.id === 'wall.total_run')!;
    expect(missing.lookedIn!.join(' ')).toMatch(/ARCH-101 .*read .*not stated on it/);
  });

  it('missing wiring under allowModelCalls is a loud error, not a fake search failure', async () => {
    await expect(
      runSkill(bbsSkill, ctx({ allowModelCalls: true })), // no splitter/transcribe/loadDocument
    ).rejects.toThrow(/splitter, transcribe, loadDocument not provided/);
  });
});

// ============================================================
// 3 · the spend gate
// ============================================================

describe('allowModelCalls = false', () => {
  it('never invokes a transport, and names the skip', async () => {
    const f = fakes();
    const result = await runSkill(bbsSkill, ctx({ allowModelCalls: false, ...f }));

    expect(calls(f.splitter.run)).toBe(0);
    expect(calls(f.transcribe)).toBe(0);
    expect(calls(f.loadDocument)).toBe(0);

    const missing = result.factsMissing.find((x) => x.id === 'wall.total_run')!;
    expect(missing.lookedIn!.join(' ')).toMatch(/ARCH-101.*model calls not allowed/);
    expect(missing.ask).toBe('What is the total run of the boundary wall?');
    expect(result.skips.join(' ')).toMatch(/allowModelCalls is false/);
  });
});

// ============================================================
// 4 · bounds
// ============================================================

describe('bounds', () => {
  it('maxDrawingsSearched caps the register scan, named', async () => {
    const f = fakes();
    const result = await runSkill(
      bbsSkill,
      ctx({ allowModelCalls: true, ...f, bounds: { maxDrawingsSearched: 0 } }),
    );
    expect(result.drawingsSearched).toBe(0);
    expect(calls(f.splitter.run)).toBe(0);
    expect(result.factsMissing[0].lookedIn!.join(' ')).toMatch(/search budget exhausted/);
  });

  it('maxSplitsPerRun caps the model spend, named', async () => {
    const f = fakes();
    const result = await runSkill(
      bbsSkill,
      ctx({ allowModelCalls: true, ...f, bounds: { maxSplitsPerRun: 0 } }),
    );
    expect(result.splitsRun).toBe(0);
    expect(calls(f.splitter.run)).toBe(0);
    expect(result.skips.join(' ')).toMatch(/split budget \(0\) exhausted/);
    expect(result.factsMissing[0].lookedIn!.join(' ')).toMatch(/split budget exhausted/);
  });
});

// ============================================================
// 5 · the §4.2 payoff — memory outlives the run
// ============================================================

describe('the second run starts from memory', () => {
  it('a DECLARED fact from run 1 means run 2 never re-searches — the splitter is not called again', async () => {
    const f = fakes();
    const store = memoryStore();
    const shared = ctx({ allowModelCalls: true, ...f, ledgerStore: store });

    const first = await runSkill(bbsSkill, shared);
    expect(calls(f.splitter.run)).toBe(1);
    expect(first.factsMissing).toHaveLength(0);

    const second = await runSkill(bbsSkill, shared);
    // the payoff: everything the first run learned was already in memory
    expect(calls(f.splitter.run)).toBe(1); // NOT called again
    expect(calls(f.transcribe)).toBe(1);
    expect(second.drawingsSearched).toBe(0);
    expect(second.factsWritten).toHaveLength(0);
    const rows = second.output!.rows as { memberMark: string; memberCount: number }[];
    expect(rows.find((r) => r.memberMark === 'TB')!.memberCount).toBe(25);
  });

  it('a MISSING fact is not re-recorded while the register still has no candidate', async () => {
    const store = memoryStore();
    const shared = ctx({ register: register(STRUCT), allowModelCalls: false, ledgerStore: store });

    await runSkill(bbsSkill, shared);
    const afterFirst = store.map.get('p1')!.entries.length;
    const second = await runSkill(bbsSkill, shared);

    expect(store.map.get('p1')!.entries.length).toBe(afterFirst); // no pile-up
    expect(second.skips.join(' ')).toMatch(/already recorded MISSING/);
  });

  it('supplying the missing fact later lets the same ledger compute with no re-reading', async () => {
    const store = memoryStore();
    await runSkill(bbsSkill, ctx({ register: register(STRUCT), ledgerStore: store }));

    // a human answers the open question (the ledger's own supply path)
    const { supplyFact } = await import('../../src/facts/ledger');
    store.map.set(
      'p1',
      supplyFact(store.map.get('p1')!, 'wall.total_run', {
        value: 100000,
        unit: 'mm',
        suppliedBy: 'hello@shivik.in',
      }),
    );

    const result = await runSkill(bbsSkill, ctx({ register: register(STRUCT), ledgerStore: store }));
    const rows = result.output!.rows as { memberMark: string; memberCount: number }[];
    expect(rows.find((r) => r.memberMark === 'TB')!.memberCount).toBe(25);
    expect(result.factsMissing).toHaveLength(0);
  });
});

// ============================================================
// 6 · drawing selection — §6.5
// ============================================================

describe('drawing selection signals', () => {
  it('signal 1: discipline first, then the fact’s subject word in the title', () => {
    const plainArch = entry({
      id: 'e-arch2',
      documentId: 'doc-arch2',
      drawingNumber: 'ARCH-090',
      title: 'DOOR AND WINDOW SCHEDULE',
      discipline: 'architectural',
    });
    const req = bbsSkill.requires.find((r) => r.key === 'wall.total_run')!;
    const picked = selectCandidateDrawing(register(plainArch, STRUCT, ARCH), req, 10);
    expect(picked.candidate!.drawingNumber).toBe('ARCH-101'); // WALL in the title wins
    expect(picked.searched.join(' ')).toContain('ARCH-090'); // lookedIn stays honest
    expect(picked.searched.join(' ')).not.toContain('GW-01'); // wrong discipline never scanned
  });

  it('a superseded revision is never a candidate', () => {
    const old = { ...ARCH, id: 'e-old', revisionState: 'superseded' as const };
    const req = bbsSkill.requires.find((r) => r.key === 'wall.total_run')!;
    expect(selectCandidateDrawing(register(old, STRUCT), req, 10).candidate).toBeNull();
  });
});

// ============================================================
// 7 · the transcription stage
// ============================================================

describe('the transcription stage', () => {
  const req = {
    drawingNumber: 'ARCH-101',
    revision: 'C',
    sections: [
      { sectionId: 'REGION-03', label: 'BOUNDARY WALL LAYOUT', kind: 'plan', png: 'data:image/png;base64,AAAA' },
      { sectionId: 'REGION-04', label: 'KEY PLAN' },
    ],
    wanted: [{ key: 'wall.total_run', ask: 'What is the total run of the boundary wall?' }],
  };

  it('a valid reply becomes DeclaredFactInput[], verbatim rawText intact', async () => {
    const ask: TranscribeAsk = async () => ({
      facts: [
        {
          id: 'wall.total_run',
          value: '100000',
          unit: 'mm',
          sectionId: 'REGION-03',
          rawText: '100000',
          handles: ['4F2A1'],
        },
      ],
    });
    const out = await transcribeSections(req, ask);
    expect(out).toEqual([
      {
        id: 'wall.total_run',
        value: '100000',
        unit: 'mm',
        sectionId: 'REGION-03',
        rawText: '100000',
        handles: ['4F2A1'],
      },
    ]);
  });

  it('the prompt points at sections and the hunted facts; images only where a png exists', async () => {
    const seen: Parameters<TranscribeAsk>[0][] = [];
    const ask: TranscribeAsk = async (args) => {
      seen.push(args);
      return { facts: [] };
    };
    await transcriberFrom(ask)(req);
    expect(seen).toHaveLength(1);
    expect(seen[0].system).toBe(TRANSCRIBE_SYSTEM);
    expect(seen[0].system).toMatch(/TRANSCRIPTION ONLY/);
    expect(seen[0].prompt).toBe(buildTranscriptionPrompt(req));
    expect(seen[0].prompt).toContain('REGION-03');
    expect(seen[0].prompt).toContain('wall.total_run — What is the total run');
    expect(seen[0].images).toEqual([
      { dataUrl: 'data:image/png;base64,AAAA', caption: 'REGION-03 — BOUNDARY WALL LAYOUT' },
    ]);
  });

  it('refuses a null reply — never guesses', async () => {
    await expect(transcribeSections(req, async () => null)).rejects.toThrow(TranscriptionRefused);
  });

  it('refuses an ill-shaped reply, naming the problem', async () => {
    const ask: TranscribeAsk = async () => ({
      facts: [{ id: 'wall.total_run', value: 100000 }], // no rawText — not quotable
    });
    await expect(transcribeSections(req, ask)).rejects.toThrow(/transcription contract/);
  });

  it('refuses a structured value — a transcription quotes scalars off the drawing', async () => {
    const ask: TranscribeAsk = async () => ({
      facts: [{ id: 'wall.total_run', value: { computed: 100000 }, rawText: '100 m' }],
    });
    await expect(transcribeSections(req, ask)).rejects.toThrow(/quotes scalars/);
  });

  it('a refused transcription surfaces in the loop as a named skip + MISSING', async () => {
    const f = fakes();
    const refusing: Transcriber = vi.fn(async () => {
      throw new TranscriptionRefused('reply does not match the transcription contract');
    });
    const result = await runSkill(
      bbsSkill,
      ctx({ allowModelCalls: true, ...f, transcribe: refusing }),
    );
    expect(result.skips.join(' ')).toMatch(/transcription refused for ARCH-101/);
    expect(result.factsMissing.map((x) => x.id)).toContain('wall.total_run');
  });
});

// ============================================================
// 8 · a contradicted fact blocks like MISSING (open question 3)
// ============================================================

describe('a contradicted fact', () => {
  /** two equal-trust DECLARED readings of the run, from different drawings */
  async function contradictedLedger(): Promise<Ledger> {
    const { recordFact } = await import('../../src/facts/ledger');
    let ledger = emptyLedger();
    ledger = recordFact(ledger, {
      id: 'wall.total_run',
      value: 100000,
      unit: 'mm',
      state: 'DECLARED',
      source: { drawingNumber: 'ARCH-101', revision: 'C', documentId: 'doc-arch' },
      readOn: '2026-08-30',
    }).ledger;
    const clash = recordFact(ledger, {
      id: 'wall.total_run',
      value: 98000,
      unit: 'mm',
      state: 'DECLARED',
      source: { drawingNumber: 'SITE-01', revision: 'C', documentId: 'doc-site' },
      readOn: '2026-08-30',
    });
    expect(clash.contradicted).toBe(true);
    return clash.ledger;
  }

  it('maps to "missing" in the FactSet — a compute never stands on a disputed value', async () => {
    const facts = factSetFromLedger(await contradictedLedger());
    expect(facts.get('wall.total_run')!.state).toBe('missing');
  });

  it('blocks the compute, surfaces as an open question, and is never re-searched', async () => {
    const f = fakes();
    const store = memoryStore();
    store.map.set('p1', await contradictedLedger());

    const result = await runSkill(
      bbsSkill,
      ctx({ allowModelCalls: true, ...f, ledgerStore: store }),
    );

    // re-reading drawings cannot settle which claim governs — no model spend
    expect(calls(f.splitter.run)).toBe(0);
    expect(calls(f.transcribe)).toBe(0);
    expect(result.skips.join(' ')).toMatch(/wall\.total_run: contradicted/);

    // the row is a formula with the named hole, not a number from either claim
    const blocked = result.output!.blocked.find((b) => b.rowId === 'TB')!;
    expect(blocked.missingKeys).toEqual(['wall.total_run']);

    // the open-question list carries the contradicted incumbent
    expect(result.factsMissing.map((x) => x.id)).toContain('wall.total_run');
    expect(result.factsMissing[0].contradicted).toBe(true);
  });

  it('a human answer settles it and the same ledger computes', async () => {
    const { supplyFact } = await import('../../src/facts/ledger');
    const store = memoryStore();
    store.map.set(
      'p1',
      supplyFact(await contradictedLedger(), 'wall.total_run', {
        value: 100000,
        unit: 'mm',
        suppliedBy: 'hello@shivik.in',
      }),
    );
    const result = await runSkill(bbsSkill, ctx({ ledgerStore: store }));
    const rows = result.output!.rows as { memberMark: string; memberCount: number }[];
    expect(rows.find((r) => r.memberMark === 'TB')!.memberCount).toBe(25);
    expect(result.factsMissing).toHaveLength(0);
  });
});

// ============================================================
// 9 · memory → FactSet
// ============================================================

describe('factSetFromLedger', () => {
  it('lowercases states, narrows units, and lets ledger facts win over conclusions', async () => {
    const { addFact } = await import('../../src/facts/ledger');
    let ledger = emptyLedger();
    ledger = addFact(ledger, {
      id: 'wall.total_run',
      value: 100000,
      unit: 'mm',
      state: 'DECLARED',
      source: { drawingNumber: 'ARCH-101', revision: 'C' },
      readOn: '2026-08-30',
    });
    const facts = factSetFromLedger(ledger, {
      'wall.total_run': { value: 1, state: 'derived' }, // must lose to the ledger
      [BBS_FACT_KEYS.extract]: { value: EXTRACT, state: 'derived' },
    });
    expect(facts.get('wall.total_run')).toEqual({ value: 100000, unit: 'mm', state: 'declared' });
    expect(facts.get(BBS_FACT_KEYS.extract)!.value).toBe(EXTRACT);
  });
});
