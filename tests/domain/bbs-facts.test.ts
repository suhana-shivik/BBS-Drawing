// The join between the fact ledger and the BBS engine (HOW_TO_BUILD_IT §6.3).
//
// The bug these tests exist for: a live run on the GAMCO boundary wall produced
// 21 rows, every cutting length "—", every weight 0.000 and a total of 0.0 kg —
// because the ledger and the engine were never wired to each other. The run was
// briefed with "PROJECT RUN: none was supplied" although the run was on file,
// and the questions it raised died in the run log instead of becoming MISSING
// facts anybody could answer.
//
// Nothing here calls a model.

import { describe, expect, it } from 'vitest';

import {
  answersSince,
  bbsObjective,
  blockedRowFor,
  blockedRowsOf,
  engineKeyForFactId,
  factIdForQuestion,
  holesForRow,
  missingFactsFromRun,
  projectFactsFromLedger,
  usableFactIds,
  type ScheduleShape,
} from '../../src/studio/bbsFacts';
import {
  blockedFactIds,
  isFullyBlocked,
  groupRows,
  scheduleTotalText,
  subtotalText,
  type ScheduleRow,
} from '../../src/studio/schedule';
import { renderBlockedRow } from '../../src/facts/blocked';
import { addFact, emptyLedger, recordFact, type Ledger } from '../../src/facts/ledger';
import type { Fact } from '../../src/facts/types';
import type { BbsChatRow } from '../../src/cad/bbs/chatResult';

// ------------------------------------------------------------
// fixtures
// ------------------------------------------------------------

function ledgerWith(...facts: Fact[]): Ledger {
  let l = emptyLedger();
  for (const f of facts) l = addFact(l, f);
  return l;
}

const RUN_FACT: Fact = {
  id: 'wall.total_run',
  value: 100000,
  unit: 'mm',
  state: 'SUPPLIED',
  suppliedBy: 'you',
  saidAs: 'the wall is 100 m',
  readOn: '2026-08-29',
};

function chatRow(partial: Partial<BbsChatRow> & Pick<BbsChatRow, 'barMark' | 'memberMark'>): BbsChatRow {
  return {
    id: partial.barMark,
    description: 'main T16',
    diameterMm: 16,
    unitWeightKgPerM: 1.58,
    working: [],
    evidenceIds: [],
    status: 'verified',
    ...partial,
  } as BbsChatRow;
}

function chatResult(rows: BbsChatRow[], members: ScheduleShape['members']): ScheduleShape {
  return { members, rows };
}

const RUN_BLOCKED_NOTE =
  'this bar runs the structure, and the TOTAL RUN has not been answered — answer the run question and this row computes';
const HEIGHT_BLOCKED_NOTE =
  'member H dimension not on this sheet — pedestal and column heights are usually on the foundation GA or a section drawing';

// ------------------------------------------------------------
// 1. ledger → projectFacts
// ------------------------------------------------------------

describe('the ledger brief (§6.3 — the run begins from memory)', () => {
  it('carries a SUPPLIED wall.total_run into the engine as the `run` fact', () => {
    const { facts, used } = projectFactsFromLedger(ledgerWith(RUN_FACT));
    // the value and its words, plus the provenance the engine now carries with them
    expect(facts.run).toMatchObject({ mm: 100000, saidAs: 'the wall is 100 m', source: 'USER_INPUT', factId: 'wall.total_run' });
    expect(used).toEqual([
      { engineKey: 'run', factId: 'wall.total_run', mark: 'wall', axis: null, mm: 100000 },
    ]);
  });

  it('carries every other usable state, keyed as the engine names them', () => {
    const { facts } = projectFactsFromLedger(
      ledgerWith(
        RUN_FACT,
        { id: 'C1.height', value: 2700, unit: 'mm', state: 'DECLARED', readOn: '2026-08-01' },
        { id: 'F1.depth', value: 400, unit: 'mm', state: 'MEASURED', method: 'section chain', readOn: '2026-08-01' },
        { id: 'wall.height', value: 1200, unit: 'mm', state: 'DERIVED', basis: '900 + 300', readOn: '2026-08-01' },
      ),
    );
    expect(Object.keys(facts).sort()).toEqual(['c1_height', 'f1_depth', 'run', 'wall_height']);
    expect(facts.c1_height.mm).toBe(2700);
    expect(facts.f1_depth.mm).toBe(400);
  });

  it('never briefs the run with a MISSING fact — that is what blocks the row', () => {
    const { facts } = projectFactsFromLedger(
      ledgerWith({
        id: 'C1.height',
        value: null,
        unit: 'mm',
        state: 'MISSING',
        ask: 'How tall is C1?',
        readOn: '2026-08-29',
      }),
    );
    expect(facts).toEqual({});
  });

  it('never briefs the run with a CONTRADICTED fact — an unsettled disagreement blocks like a hole', () => {
    let l = ledgerWith({
      id: 'wall.total_run',
      value: 100000,
      unit: 'mm',
      state: 'DECLARED',
      source: { drawingNumber: 'ARCH-101', revision: 'R0' },
      readOn: '2026-08-01',
    });
    const clash = recordFact(l, {
      id: 'wall.total_run',
      value: 98000,
      unit: 'mm',
      state: 'DECLARED',
      source: { drawingNumber: 'SITE-01', revision: 'R0' },
      readOn: '2026-08-02',
    });
    expect(clash.contradicted).toBe(true);
    l = clash.ledger;
    expect(projectFactsFromLedger(l).facts).toEqual({});
  });

  it('reads metres as metres and leaves facts that are not lengths alone', () => {
    const { facts, skipped } = projectFactsFromLedger(
      ledgerWith(
        { id: 'wall.total_run', value: 100, unit: 'm', state: 'SUPPLIED', readOn: '2026-08-29' },
        { id: 'steel.grade', value: 'Fe500D', state: 'DECLARED', readOn: '2026-08-29' },
      ),
    );
    expect(facts.run.mm).toBe(100000);
    expect(skipped).toContain('steel.grade');
  });

  it('maps ids to engine keys the orchestrator can be taught', () => {
    expect(engineKeyForFactId('wall.total_run')).toBe('run');
    expect(engineKeyForFactId('C1.height')).toBe('c1_height');
    expect(engineKeyForFactId('F1.plan_w')).toBe('f1_plan_w');
  });
});

describe('the objective (the live-run teaching pattern)', () => {
  it('names the axis-to-fact map so an axis is POINTED at a fact, not asked about again', () => {
    const { used } = projectFactsFromLedger(
      ledgerWith(RUN_FACT, {
        id: 'C1.height',
        value: 2700,
        unit: 'mm',
        state: 'SUPPLIED',
        readOn: '2026-08-29',
      }),
    );
    const objective = bbsObjective(used);
    expect(objective).toContain('C1 H → c1_height');
    expect(objective).toContain('user-fact');
    expect(objective).toContain('do NOT ask again');
    expect(objective).toContain('run = 100000 mm');
  });

  it('says nothing about facts when there are none — no empty teaching', () => {
    expect(bbsObjective([])).toBe('Produce a complete bar bending schedule for this drawing.');
  });
});

// ------------------------------------------------------------
// 2. run → MISSING facts
// ------------------------------------------------------------

describe('escalations and unresolved axes become answerable questions (§6.3)', () => {
  const result = chatResult(
    [
      chatRow({ barMark: 'TB-16', memberMark: 'TB', status: 'unavailable', note: RUN_BLOCKED_NOTE }),
      chatRow({ barMark: 'C1-V', memberMark: 'C1', status: 'unavailable', note: HEIGHT_BLOCKED_NOTE }),
      chatRow({ barMark: 'F1-B', memberMark: 'F1', status: 'verified' }),
    ],
    [
      { mark: 'TB', dims: {} },
      { mark: 'C1', dims: { L: 350, W: 350 } },
      { mark: 'F1', dims: { L: 1800, W: 1500, H: 400 } },
    ],
  );

  const input = {
    result,
    escalations: [
      { question: 'What is the height of C2 above the footing?', whyNeeded: 'C2 vertical bars cannot be cut' },
      { question: 'Does the wall turn any corners?', whyNeeded: 'corner bar counts' },
    ],
    unresolved: ['SC H was never dimensioned on this sheet'],
    lookedIn: ['GW-01 R1', '36 callouts, 41 readable dimensions, 3 tables on this sheet'],
    readOn: '2026-08-30',
  };

  it('files one MISSING fact per hole, with the ask and where the run looked', () => {
    const facts = missingFactsFromRun(input, emptyLedger());
    const byId = new Map(facts.map((f) => [f.id, f]));
    expect([...byId.keys()]).toContain('wall.total_run');
    expect([...byId.keys()]).toContain('C1.height');
    expect([...byId.keys()]).toContain('C2.height');
    expect([...byId.keys()]).toContain('SC.height');
    for (const f of facts) {
      expect(f.state).toBe('MISSING');
      expect(f.value).toBeNull();
      expect(f.ask).toBeTruthy();
      expect(f.lookedIn).toEqual(input.lookedIn);
    }
    // the escalation is kept in the client's own words
    expect(byId.get('C2.height')!.ask).toBe('What is the height of C2 above the footing?');
  });

  it('names the member marks and row ids each hole blocks', () => {
    const facts = missingFactsFromRun(input, emptyLedger());
    const run = facts.find((f) => f.id === 'wall.total_run')!;
    expect(run.neededFor).toContain('TB row TB-16');
    const c1 = facts.find((f) => f.id === 'C1.height')!;
    expect(c1.neededFor).toContain('C1 row C1-V');
  });

  it('keeps a question that is not about a member axis as its own open question', () => {
    const facts = missingFactsFromRun(input, emptyLedger());
    const corners = facts.find((f) => f.id.startsWith('open.'))!;
    expect(corners.ask).toBe('Does the wall turn any corners?');
    expect(corners.neededFor).toContain('corner bar counts');
  });

  it('never asks again for a fact already on the record', () => {
    const facts = missingFactsFromRun(input, ledgerWith(RUN_FACT));
    expect(facts.map((f) => f.id)).not.toContain('wall.total_run');
    expect(facts.map((f) => f.id)).toContain('C1.height');
  });

  it('does not raise a hole for a row that computed', () => {
    const facts = missingFactsFromRun(input, emptyLedger());
    expect(facts.map((f) => f.id)).not.toContain('F1.height');
  });

  it('reads a question that names a member and an axis as that member\'s axis fact', () => {
    expect(factIdForQuestion('How tall is C1?', ['C1', 'C2']).id).toBe('C1.height');
    expect(factIdForQuestion('What is the total run of the wall?', ['C1']).id).toBe('wall.total_run');
    expect(factIdForQuestion('Is the cage the same on both faces?', ['C1']).id).toMatch(/^open\./);
  });
});

// ------------------------------------------------------------
// 3. blocked rows: a formula with a hole (§6.4)
// ------------------------------------------------------------

describe('a blocked row is a formula with a named hole, not a dash (§6.4)', () => {
  it('names the fact the cutting length is waiting on', () => {
    const row = chatRow({
      barMark: 'C1-V',
      memberMark: 'C1',
      status: 'unavailable',
      note: HEIGHT_BLOCKED_NOTE,
      working: ['members: 5 occurrences of C1 in BAND-01'],
      unitWeightKgPerM: 0.888,
      totalBars: 40,
    });
    const blocked = blockedRowFor(row, { L: 350, W: 350 })!;
    expect(blocked.missingFactIds).toEqual(['C1.height']);
    expect(blocked.formula).toContain('⟨C1.height⟩');
    // the engine's own working is kept verbatim — nothing is re-derived
    expect(blocked.formula).toContain('members: 5 occurrences of C1 in BAND-01');
    expect(blocked.formula).toContain('0.888 kg/m');
    expect(blocked.ask[0]).toContain('height of C1');
  });

  it('reads the run question off the engine\'s own sentence', () => {
    const holes = holesForRow({ status: 'unavailable', note: RUN_BLOCKED_NOTE, memberMark: 'TB' });
    expect(holes.map((h) => h.factId)).toEqual(['wall.total_run']);
  });

  it('names no fact where no fact would unblock the row', () => {
    const blocked = blockedRowFor(
      chatRow({
        barMark: 'X-1',
        memberMark: 'X',
        status: 'unavailable',
        note: 'unknown shape code "99"',
      }),
      {},
    );
    expect(blocked).toBeNull();
  });

  it('renders §6.4 in full once the question is on the ledger', () => {
    const result = chatResult(
      [chatRow({ barMark: 'C1-V', memberMark: 'C1', status: 'unavailable', note: HEIGHT_BLOCKED_NOTE })],
      [{ mark: 'C1', dims: { L: 350, W: 350 } }],
    );
    const blocked = blockedRowsOf(result).get('C1-V')!;
    const ledger = ledgerWith({
      id: 'C1.height',
      value: null,
      unit: 'mm',
      state: 'MISSING',
      neededFor: ['C1 row C1-V'],
      lookedIn: ['GW-01 R1', 'ARCH-101'],
      ask: 'What is the height of C1? This sheet carries no dimension for it.',
      readOn: '2026-08-30',
    });
    const text = renderBlockedRow(blocked, ledger);
    expect(text).toContain('⚠ BLOCKED — C1.height is MISSING');
    expect(text).toContain('needed for:  C1 row C1-V');
    expect(text).toContain('searched:    GW-01 R1, ARCH-101');
    expect(text).toContain('ask:');
  });
});

// ------------------------------------------------------------
// 4. answers arriving after the schedule
// ------------------------------------------------------------

describe('answers since the schedule was built (§6.3 — the loop closes)', () => {
  it('sees a supplied answer as an answer, and an unanswered question as neither', () => {
    const before = ledgerWith({
      id: 'C1.height',
      value: null,
      unit: 'mm',
      state: 'MISSING',
      ask: 'How tall is C1?',
      readOn: '2026-08-30',
    });
    const baseline = usableFactIds(before);
    expect(answersSince(before, baseline)).toEqual([]);

    const after = recordFact(before, {
      id: 'C1.height',
      value: 2700,
      unit: 'mm',
      state: 'SUPPLIED',
      suppliedBy: 'you',
      saidAs: '2.7 m from the footing',
      readOn: '2026-08-31',
    }).ledger;
    expect(answersSince(after, baseline)).toEqual(['C1.height']);
    // and the answer is now what the next run is briefed with
    expect(projectFactsFromLedger(after).facts.c1_height.mm).toBe(2700);
  });
});

// ------------------------------------------------------------
// 5. a blocked total does not read as zero steel
// ------------------------------------------------------------

function scheduleRow(partial: Partial<ScheduleRow> & Pick<ScheduleRow, 'id' | 'mark' | 'member'>): ScheduleRow {
  return {
    barType: '',
    diaMm: 16,
    shapeCode: '',
    segments: [],
    cuttingLengthMm: 1000,
    lengthWorking: '',
    lengthSource: 'SHAPE_FORMULA',
    barsPerMember: 2,
    memberCount: 4,
    totalBars: 8,
    spacingMm: null,
    occurrenceBand: null,
    totalLengthM: 8,
    unitWeightKgPerM: 1.58,
    weightKg: 12.6,
    warnings: [],
    fromCallout: null,
    handles: [],
    status: 'verified',
    ...partial,
  };
}

const openRow = (id: string, mark: string, factId: string): ScheduleRow =>
  scheduleRow({
    id,
    mark,
    member: `${mark} column`,
    cuttingLengthMm: null,
    lengthSource: 'UNAVAILABLE',
    totalLengthM: null,
    weightKg: null,
    status: 'unavailable',
    blocked: {
      formula: `cutting length = f(⟨${factId}⟩)`,
      missingFactIds: [factId],
      ask: [`What is ${factId}?`],
    },
  });

describe('a fully blocked schedule says so instead of printing 0.0 kg', () => {
  it('reports the subtotal of an all-open member as blocked, naming the fact', () => {
    const rows = [openRow('r1', 'C1', 'C1.height'), openRow('r2', 'C1', 'C1.height')];
    const [block] = groupRows(rows, 'member');
    expect(isFullyBlocked(block)).toBe(true);
    expect(subtotalText(block)).toBe('blocked — 2 rows open, waiting on C1.height');
    expect(subtotalText(block)).not.toContain('0.0');
  });

  it('reports the schedule total as blocked when nothing could be weighed', () => {
    const rows = [openRow('r1', 'C1', 'C1.height'), openRow('r2', 'TB', 'wall.total_run')];
    expect(blockedFactIds(rows)).toEqual(['C1.height', 'wall.total_run']);
    const text = scheduleTotalText(rows);
    expect(text).toContain('blocked');
    expect(text).toContain('C1.height');
    expect(text).toContain('wall.total_run');
    expect(text).not.toMatch(/\b0\.0 kg\b/);
  });

  it('still totals a partly computed schedule, and says how many rows stay open', () => {
    const rows = [scheduleRow({ id: 'r0', mark: 'F1', member: 'F1 footing' }), openRow('r1', 'C1', 'C1.height')];
    const text = scheduleTotalText(rows);
    expect(text).toContain('12.6 kg');
    expect(text).toContain('1 row still open');
  });

  it('keeps the plain figure when nothing is open at all', () => {
    expect(scheduleTotalText([scheduleRow({ id: 'r0', mark: 'F1', member: 'F1 footing' })])).toBe('12.6 kg');
  });
});
