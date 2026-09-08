// ============================================================
// THE WHOLE WORKFLOW, END TO END.
//
//   drawing read → AI questions → partial DIAGNOSTIC schedule (never FINAL)
//   → Expand/Edit → the person completes the residue → recalculation through
//   the one pipeline → validation → reconciliation → FINAL, filed, versioned.
//
// The two mechanisms are SEQUENTIAL, not alternative. Questioning goes first
// and takes everything it can safely take; the editable schedule exists for
// what is left — a shape that must be read off a section, a design cutting
// length. Neither is allowed to call a partial schedule finished.
// ============================================================
import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyEdits,
  buildEditGrid,
  disputesOf,
  editsFromWorkbook,
  questionsFor,
  recalculate,
  reconstructEngineInputs,
  validateEdit,
  CONFIRM_COLUMN_LABEL,
  FIELD_BY_ID,
  EDITABLE_FIELDS,
  type CellEdit,
} from '../../calculations/bbsEdit';
import { buildChatResult } from '../../src/cad/bbs/chatResult';
import { writeBbsXlsx, defaultColumns } from '../../src/io/bbsWorkbook';
import { readXlsxGrids } from '../../src/io/xlsx';
import { validateSchedule } from '../../calculations/validation';
import { emptyLedger, recordFact, resolveFact, type Ledger } from '../../src/facts/ledger';
import { projectFactsFromLedger } from '../../src/studio/bbsFacts';
import { saveProjectArtifact, loadProjectArtifacts } from '../../src/register/artifacts';
import { dedupeByDependency, dependencyOf } from '../../src/cad/bbs/askFrom';
import type { BbsBar, BbsMember, BbsSettings, EngineInputs } from '../../src/cad/bbs/types';
import type { Fact } from '../../src/facts/types';

// ------------------------------------------------------------
// a job with four members and one problem each — generic marks, no drawing
// ------------------------------------------------------------
const settings = (): BbsSettings => ({
  concreteGrade: 'M25',
  steelGrade: 'Fe500',
  coverMm: 50,
  // the sheet states no cover and nobody has established whether one exists:
  // the 50 is the PROJECT DEFAULT, every row computes on it and says ASSUMED,
  // and the schedule cannot be FINAL until somebody states the cover
  coverSource: undefined,
  bendMode: 'CONVENTIONAL',
  wastagePct: 3,
});

const member = (over: Partial<BbsMember> & { mark: string }): BbsMember => ({
  type: 'FOOTING',
  count: 4,
  source: { table: 'SCHEDULE', row: 1 },
  incomplete: false,
  missing: [],
  dimSources: { L: 'DRAWING_READ — SCHEDULE row', W: 'DRAWING_READ — SCHEDULE row', H: 'DRAWING_READ — SCHEDULE row' },
  ...over,
});

const bar = (over: Partial<BbsBar> & { memberMark: string; diaMm: number }): BbsBar => ({
  barType: 'MAIN',
  shapeCode: '00',
  fromCallout: `T${over.diaMm} @ ${over.spacingMm ?? 150} c/c`,
  handles: ['1A2B'],
  ...over,
});

/**
 * M1 computes. M2 has no member count (askable). M3 has no width (askable).
 * M4 needs a shape read off a section (NOT safely askable — editor only).
 * Cover is the project default throughout, so nothing is fully validated.
 */
function job(): EngineInputs {
  return {
    members: {
      M1: member({ mark: 'M1', lengthMm: 2500, widthMm: 2300, heightMm: 350, count: 4 }),
      M2: member({ mark: 'M2', lengthMm: 3400, widthMm: 2900, heightMm: 450, count: 0 }),
      M3: member({ mark: 'M3', lengthMm: 4300, heightMm: 575, count: 6, dimSources: { L: 'DRAWING_READ — SCHEDULE row', H: 'DRAWING_READ — SCHEDULE row' } }),
      M4: member({ mark: 'M4', lengthMm: 3600, widthMm: 3100, heightMm: 550, count: 3 }),
    },
    bars: {
      'M1-A': bar({ memberMark: 'M1', diaMm: 10, spacingMm: 150, distributionAxis: 'L' }),
      'M2-A': bar({ memberMark: 'M2', diaMm: 12, spacingMm: 125, distributionAxis: 'L' }),
      'M3-A': bar({ memberMark: 'M3', diaMm: 12, spacingMm: 100, distributionAxis: 'L' }),
      // the detail draws a shape the reader could not make out — recorded as
      // CUS with nothing drawn behind it. No question can safely settle a
      // shape; this is the row a person must complete from the drawing.
      'M4-A': bar({ memberMark: 'M4', diaMm: 16, spacingMm: 200, distributionAxis: 'L', shapeCode: 'CUS' }),
    },
    settings: settings(),
    runMm: null,
    coverTable: [],
    takeoffCounts: {},
    enteredCuttingLengthMm: {},
    declaredInputs: {},
  };
}

const build = (inputs: EngineInputs) => {
  const { rows, summary, reconciliation } = recalculate(inputs);
  const validation = validateSchedule(rows, { reconciliationOk: reconciliation.ok });
  return { rows, summary, reconciliation, validation };
};

// ------------------------------------------------------------
// STAGE 1 — the questions come first
// ------------------------------------------------------------
describe('stage 1 — missing data is ASKED for, once per dependency', () => {
  it('a missing input raises a question naming the fact it writes to', () => {
    const { rows } = build(job());
    const grid = buildEditGrid(rows, job());
    const questions = questionsFor(grid);

    const keys = questions.map((q) => q.dependencyKey).sort();
    expect(keys).toContain('M2.count');
    expect(keys).toContain('M3.width');
    expect(keys).toContain('settings.cover');
    const count = questions.find((q) => q.dependencyKey === 'M2.count')!;
    expect(count.question).toMatch(/How many M2/);
    expect(count.blocks).toContain('M2-A');
    expect(count.editorOnly).toBe(false);
  });

  it('one question per dependency, however many rows wait on it', () => {
    // every row is cut to the same assumed cover
    const { rows } = build(job());
    const questions = questionsFor(buildEditGrid(rows, job()));
    const cover = questions.filter((q) => q.dependencyKey === 'settings.cover');
    expect(cover).toHaveLength(1);
    expect(cover[0].blocks.length).toBeGreaterThan(1);
    expect(new Set(questions.map((q) => q.dependencyKey)).size).toBe(questions.length);
  });

  it('a question already answered is never asked again', () => {
    const { rows } = build(job());
    const grid = buildEditGrid(rows, job());
    const asked = new Set(['settings.cover', 'M2.count']);
    const again = questionsFor(grid, asked).map((q) => q.dependencyKey);
    expect(again).not.toContain('settings.cover');
    expect(again).not.toContain('M2.count');
  });

  it('shares its identity with the interview — the same dependency key', () => {
    // the interview keys a question by the fact its answer writes to; so does
    // this. One key space, so the two mechanisms cannot double-ask.
    expect(dependencyOf({ writesTo: { field: 'cover' } })).toBe('settings.cover');
    expect(dependencyOf({ writesTo: { memberMark: 'M2', field: 'count' } })).toBe('M2.count');
    const deduped = dedupeByDependency([
      { id: 'a', question: 'q', why: '', whyNeeded: '', writesTo: { field: 'cover' } } as never,
      { id: 'b', question: 'q2', why: '', whyNeeded: '', writesTo: { field: 'cover' } } as never,
    ]);
    expect(deduped).toHaveLength(1);
  });

  it('marks what CANNOT be safely asked as editor-only', () => {
    const { rows } = build(job());
    const questions = questionsFor(buildEditGrid(rows, job()));
    const geometry = questions.filter((q) => q.editorOnly);
    expect(geometry.length).toBeGreaterThan(0);
    for (const q of geometry) {
      expect(FIELD_BY_ID.get(q.field!)?.requiresEvidence).toBe(true);
      expect(q.question).toMatch(/read from the drawing|editable schedule/i);
    }
  });

  it("an answer becomes a USER_INPUT DataFact and reaches the engine as one", () => {
    let ledger: Ledger = emptyLedger();
    const answer: Fact = {
      id: 'M2.count',
      value: 5,
      unit: 'mm',
      state: 'SUPPLIED',
      suppliedBy: 'you',
      saidAs: '5 footings',
      readOn: '2026-09-07',
    };
    ledger = recordFact(ledger, answer).ledger;
    expect(resolveFact(ledger, 'M2.count')?.value).toBe(5);
    const { facts } = projectFactsFromLedger(ledger);
    expect(facts.m2_count).toMatchObject({ mm: 5, source: 'USER_INPUT', factId: 'M2.count' });
  });
});

// ------------------------------------------------------------
// STAGE 2 — the partial schedule is DIAGNOSTIC, never FINAL
// ------------------------------------------------------------
describe('stage 2 — a partial schedule is never called finished', () => {
  it('keeps every unresolved row visible, with what is missing and why', () => {
    const { rows } = build(job());
    const grid = buildEditGrid(rows, job());
    expect(grid.rows).toHaveLength(4);

    const blocked = grid.rows.filter((r) => r.issues.some((i) => i.kind === 'BLOCKED'));
    expect(blocked.map((r) => r.barMark).sort()).toEqual(['M2-A', 'M3-A', 'M4-A']);
    for (const row of blocked) {
      const issue = row.issues.find((i) => i.kind === 'BLOCKED')!;
      expect(issue.reason).toBeTruthy();
      expect(row.sourceCallout).toBeTruthy();
      expect(row.factIds.length).toBeGreaterThan(0);
    }
    // and a blocked row carries NO quantity — never a zero
    const m2 = grid.rows.find((r) => r.barMark === 'M2-A')!;
    expect(m2.outputs.totalBars).toBeNull();
    expect(m2.outputs.weightKg).toBeNull();
  });

  it('is INCOMPLETE even though a row calculated', () => {
    const { rows, validation } = build(job());
    expect(rows.some((r) => r.weightKg !== null)).toBe(true);
    expect(validation.label).toBe('INCOMPLETE');
    expect(validation.final).toBe(false);
    expect(buildEditGrid(rows, job()).status).toBe('INCOMPLETE');
  });

  it('does not throw away the rows that DID calculate', () => {
    const { rows, summary } = build(job());
    const m1 = rows.find((r) => r.barMark === 'M1-A')!;
    expect(m1.weightKg).toBeGreaterThan(0);
    expect(summary.reduce((n, s) => n + s.totalWeightKg, 0)).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------
// STAGE 3 — Expand exposes the unresolved inputs, and only inputs
// ------------------------------------------------------------
describe('stage 3 — the editable schedule exposes the right cells', () => {
  it('offers every engineering input the brief names', () => {
    const ids = EDITABLE_FIELDS.map((f) => f.id);
    for (const wanted of [
      'memberCount', 'barsPerMember', 'diaMm', 'spacingMm',
      'legA', 'legB', 'legC', 'memberHeight', 'memberLength', 'memberWidth',
      'coverMm', 'distributionAxis', 'shapeCode', 'legD', 'hookStart', 'hookEnd',
      'lapMm', 'anchorageMm', 'ldMultiple', 'enteredCuttingLengthMm',
    ]) {
      expect(ids, wanted).toContain(wanted);
    }
  });

  it('marks the cells a blocked row is waiting on', () => {
    const { rows } = build(job());
    const grid = buildEditGrid(rows, job());
    const m3 = grid.rows.find((r) => r.barMark === 'M3-A')!;
    expect(m3.cells.find((c) => c.field === 'memberWidth')!.blocking).toBe(true);
    expect(m3.cells.find((c) => c.field === 'memberWidth')!.source).toBe('MISSING');
    expect(m3.cells.find((c) => c.field === 'memberWidth')!.factId).toBe('M3.width');
  });

  it('never offers a calculated output as an editable cell', () => {
    const { rows } = build(job());
    const grid = buildEditGrid(rows, job());
    const fields = new Set(grid.rows[0].cells.map((c) => c.field));
    for (const output of ['cuttingLengthMm', 'totalBars', 'totalLengthM', 'weightKg', 'unitWeightKgPerM']) {
      expect(fields.has(output), output).toBe(false);
    }
    // they are present, read-only, under outputs
    expect(grid.rows[0].outputs).toHaveProperty('cuttingLengthMm');
    expect(grid.rows[0].outputs).toHaveProperty('weightKg');
  });

  it('validates a value and its unit before anything is written', () => {
    const mm = FIELD_BY_ID.get('memberWidth')!;
    expect(validateEdit(mm, '2900')).toMatchObject({ ok: true, value: 2900 });
    expect(validateEdit(mm, '2.9 m')).toMatchObject({ ok: true, value: 2900 });
    expect(validateEdit(mm, '2,900')).toMatchObject({ ok: true, value: 2900 });
    expect(validateEdit(mm, 'wide')).toMatchObject({ ok: false });
    expect(validateEdit(mm, '0').reason).toMatch(/never entered as zero/);
    expect(validateEdit(mm, '-5')).toMatchObject({ ok: false });
    expect(validateEdit(FIELD_BY_ID.get('memberCount')!, '2.5').reason).toMatch(/whole number/);
    expect(validateEdit(FIELD_BY_ID.get('shapeCode')!, 'ZZ')).toMatchObject({ ok: false });
    expect(validateEdit(FIELD_BY_ID.get('shapeCode')!, '11')).toMatchObject({ ok: true, value: '11' });
    expect(validateEdit(FIELD_BY_ID.get('distributionAxis')!, 'Q')).toMatchObject({ ok: false });
    // an empty cell CLEARS the input; it does not become zero
    expect(validateEdit(mm, '')).toMatchObject({ ok: true, value: undefined });
  });
});

// ------------------------------------------------------------
// STAGE 4 — Save: facts, invalidation, recalculation through the one engine
// ------------------------------------------------------------
describe('stage 4 — an edit becomes a fact, and the pipeline recomputes', () => {
  it('creates a USER_INPUT DataFact naming the fact and the rows it affects', () => {
    const inputs = job();
    const { rows } = build(inputs);
    const out = applyEdits(rows, inputs, [{ barMark: 'M3-A', field: 'memberWidth', value: '2900' }]);

    expect(out.rejected).toEqual([]);
    expect(out.facts).toHaveLength(1);
    expect(out.facts[0]).toMatchObject({ factId: 'M3.width', value: 2900, unit: 'mm', saidAs: '2900', override: false });
    expect(out.facts[0].affects).toContain('M3-A');
  });

  it('recalculates the affected row through the canonical pipeline', () => {
    const inputs = job();
    const { rows } = build(inputs);
    const before = rows.find((r) => r.barMark === 'M3-A')!;
    expect(before.cuttingLengthMm).toBeNull();

    const out = applyEdits(rows, inputs, [{ barMark: 'M3-A', field: 'memberWidth', value: '2900' }]);
    const after = out.rows.find((r) => r.barMark === 'M3-A')!;
    // spaced along L ⇒ runs along W ⇒ cut to W − 2 × cover, by the shape formula
    expect(after.cuttingLengthMm).toBe(2900 - 2 * 50);
    expect(after.lengthSource).toBe('SHAPE_FORMULA');
    expect(after.barsPerMember).toBe(Math.ceil((4300 - 100) / 100) + 1);
    expect(after.totalBars).toBe(after.barsPerMember! * 6);
    expect(after.weightKg).toBeGreaterThan(0);
    expect(out.invalidated).toContain('M3-A');
  });

  it('updates quantity, weight and the steel summary together', () => {
    const inputs = job();
    const { rows, summary } = build(inputs);
    const beforeKg = summary.reduce((n, s) => n + s.totalWeightKg, 0);
    const out = applyEdits(rows, inputs, [{ barMark: 'M2-A', field: 'memberCount', value: '5' }]);
    const afterKg = out.summary.reduce((n, s) => n + s.totalWeightKg, 0);

    expect(afterKg).toBeGreaterThan(beforeKg);
    const m2 = out.rows.find((r) => r.barMark === 'M2-A')!;
    expect(m2.memberCount).toBe(5);
    expect(m2.totalBars).toBe(m2.barsPerMember! * 5);
    // the summary is recomputed FROM the rows, never maintained beside them,
    // and a row with a count but no LENGTH contributes nothing to it — M3-A
    // knows how many bars it has and not yet how long they are
    const t12 = out.summary.find((s) => s.diaMm === 12)!;
    const counted = out.rows.filter((r) => r.diaMm === 12 && r.cuttingLengthMm !== null && r.totalBars);
    expect(t12.barCount).toBe(counted.reduce((n, r) => n + (r.totalBars ?? 0), 0));
    const m3 = out.rows.find((r) => r.barMark === 'M3-A')!;
    expect(m3.totalBars).toBeGreaterThan(0);
    expect(m3.cuttingLengthMm).toBeNull();
    expect(counted.map((r) => r.barMark)).not.toContain('M3-A');
    expect(out.reconciliation.ok).toBe(true);
  });

  it('invalidates every row that reads a shared fact, and no others', () => {
    const inputs = job();
    const { rows } = build(inputs);
    const out = applyEdits(rows, inputs, [{ barMark: 'M1-A', field: 'coverMm', value: '40' }]);
    // cover is in every arm of every bar
    expect(out.invalidated.sort()).toEqual(['M1-A', 'M2-A', 'M3-A', 'M4-A']);

    const narrow = applyEdits(rows, inputs, [{ barMark: 'M2-A', field: 'memberCount', value: '5' }]);
    expect(narrow.invalidated).toEqual(['M2-A']);
  });

  it('answering the cover lifts the assumption off every row at once', () => {
    const inputs = job();
    const { rows } = build(inputs);
    expect(rows.every((r) => (r.coverStatus ?? r.trace?.coverStatus) === 'ASSUMED')).toBe(true);

    const out = applyEdits(rows, inputs, [{ barMark: 'M1-A', field: 'coverMm', value: '40' }]);
    expect(out.rows.every((r) => r.coverStatus === 'USER_INPUT')).toBe(true);
    expect(out.rows.find((r) => r.barMark === 'M1-A')!.cuttingLengthMm).toBe(2300 - 80);
  });

  it('keeps the drawing value and records an OVERRIDE when a person types over it', () => {
    const inputs = job();
    const { rows } = build(inputs);
    const out = applyEdits(rows, inputs, [{ barMark: 'M1-A', field: 'memberWidth', value: '2400' }]);

    const fact = out.facts[0];
    expect(fact.override).toBe(true);
    expect(fact.previous).toEqual({ value: 2300, source: 'DRAWING_READ' });
    // the original reading is still on the record, beside the person's value
    expect(inputs.members.M1.widthMm).toBe(2300);
    expect(out.inputs.members.M1.widthMm).toBe(2400);
  });

  it('refuses an evidence-bearing figure that nobody confirmed', () => {
    const inputs = job();
    const { rows } = build(inputs);
    const out = applyEdits(rows, inputs, [{ barMark: 'M4-A', field: 'shapeCode', value: '11' }]);
    expect(out.facts).toEqual([]);
    expect(out.rejected[0].reason).toMatch(/must come from the drawing or the design/);
    // and the row is still blocked — nothing was invented
    expect(out.rows.find((r) => r.barMark === 'M4-A')!.cuttingLengthMm).toBeNull();
  });

  it('accepts it once the source is confirmed, and records the confirmation', () => {
    const inputs = job();
    const { rows } = build(inputs);
    const out = applyEdits(rows, inputs, [{ barMark: 'M4-A', field: 'shapeCode', value: '11', confirmed: true }]);
    expect(out.rejected).toEqual([]);
    expect(out.facts[0]).toMatchObject({ confirmed: true, override: true });
    expect(out.rows.find((r) => r.barMark === 'M4-A')!.cuttingLengthMm).toBeGreaterThan(0);
  });

  it('changes nothing at all when a value does not validate', () => {
    const inputs = job();
    const { rows } = build(inputs);
    const out = applyEdits(rows, inputs, [
      { barMark: 'M3-A', field: 'memberWidth', value: 'about three metres' },
      { barMark: 'M2-A', field: 'memberCount', value: '5' },
    ]);
    expect(out.rejected).toHaveLength(1);
    expect(out.facts.map((f) => f.factId)).toEqual(['M2.count']);
    expect(out.rows.find((r) => r.barMark === 'M3-A')!.cuttingLengthMm).toBeNull();
  });

  it('refuses to edit a calculated output', () => {
    const inputs = job();
    const { rows } = build(inputs);
    const out = applyEdits(rows, inputs, [{ barMark: 'M1-A', field: 'weightKg', value: '999' } as CellEdit]);
    expect(out.rejected[0].reason).toMatch(/not an editable input/);
  });
});

// ------------------------------------------------------------
// STAGE 5 — the hard gate
// ------------------------------------------------------------
describe('stage 5 — FINAL is impossible while anything is unresolved', () => {
  const completeAll = () => {
    const inputs = job();
    const { rows } = build(inputs);
    return applyEdits(rows, inputs, [
      { barMark: 'M1-A', field: 'coverMm', value: '40' },
      { barMark: 'M2-A', field: 'memberCount', value: '5' },
      { barMark: 'M3-A', field: 'memberWidth', value: '2900' },
      { barMark: 'M4-A', field: 'shapeCode', value: '11', confirmed: true },
    ]);
  };

  it('stays INCOMPLETE while one row is still blocked', () => {
    const inputs = job();
    const { rows } = build(inputs);
    const partial = applyEdits(rows, inputs, [
      { barMark: 'M1-A', field: 'coverMm', value: '40' },
      { barMark: 'M2-A', field: 'memberCount', value: '5' },
      { barMark: 'M3-A', field: 'memberWidth', value: '2900' },
    ]);
    expect(partial.rows.filter((r) => r.weightKg === null).map((r) => r.barMark)).toEqual(['M4-A']);
    expect(partial.status).toBe('INCOMPLETE');
    expect(partial.validation.gates.find((g) => g.name === 'blocked rows = 0')!.ok).toBe(false);
  });

  it('turns FINAL only when every gate passes', () => {
    const done = completeAll();
    expect(done.rows.every((r) => r.weightKg !== null)).toBe(true);
    expect(done.reconciliation.ok).toBe(true);
    expect(done.validation.counts).toMatchObject({ rows: 4, calculated: 4, open: 0, validated: 4, mismatches: 0, missingFacts: 0 });
    expect(done.validation.gates.every((g) => g.ok)).toBe(true);
    expect(done.status).toBe('FINAL');
  });

  it('names every gate, so a reader sees which one held it back', () => {
    const { validation } = build(job());
    const failed = validation.gates.filter((g) => !g.ok).map((g) => g.name);
    expect(failed).toContain('blocked rows = 0');
    expect(failed).toContain('required missing facts = 0');
    expect(failed).toContain('no assumed input');
    for (const gate of [
      'required rows complete', 'critical mismatches = 0', 'unresolved geometry = 0',
      'unresolved cutting lengths = 0', 'quantity validated', 'cutting length validated',
      'weight calculated', 'steel summary reconciled', 'drawing revision/hash current',
      'provenance present for every input',
    ]) {
      expect(validation.gates.map((g) => g.name)).toContain(gate);
    }
  });

  it('a stale drawing revision prevents FINAL even with every row computed', () => {
    const done = completeAll();
    expect(done.status).toBe('FINAL');
    const moved = validateSchedule(done.rows, { reconciliationOk: true, drawingHashMatches: false });
    expect(moved.final).toBe(false);
    expect(moved.label).toBe('INCOMPLETE');
    expect(moved.gates.find((g) => g.name === 'drawing revision/hash current')!.detail).toMatch(/drawing changed/);
  });

  it('a changed dependency prevents FINAL', () => {
    const done = completeAll();
    const stale = validateSchedule(done.rows, { reconciliationOk: true, stale: true });
    expect(stale.final).toBe(false);
    expect(stale.blockers.join(' ')).toMatch(/changed since/);
  });

  it('a summary that does not reconcile prevents FINAL', () => {
    const done = completeAll();
    const off = validateSchedule(done.rows, { reconciliationOk: false });
    expect(off.final).toBe(false);
    expect(off.gates.find((g) => g.name === 'steel summary reconciled')!.ok).toBe(false);
  });

  it('drift between the stored rows and a fresh pass prevents FINAL', () => {
    const done = completeAll();
    const drifted = validateSchedule(done.rows, { reconciliationOk: true, driftRows: ['M2-A'] });
    expect(drifted.final).toBe(false);
    expect(drifted.blockers.join(' ')).toMatch(/DRIFT/);
  });
});

// ------------------------------------------------------------
// filing — the completed schedule, and the incomplete one before it
// ------------------------------------------------------------
describe('the filed artifact keeps its history', () => {
  const base = {
    projectId: 'proj-workflow',
    documentId: 'doc-workflow',
    kind: 'bbs' as const,
    drawingName: 'Foundations.dxf',
    drawingNumber: 'X-101',
    revision: 'A',
    mimeType: 'application/json' as const,
  };

  beforeEach(async () => {
    await loadProjectArtifacts(base.projectId);
  });

  it('files the incomplete schedule, then the completed one as a new version', async () => {
    const inputs = job();
    const { rows, validation } = build(inputs);
    const first = await saveProjectArtifact({
      ...base,
      content: JSON.stringify({ status: validation.label, rows: rows.map((r) => ({ id: r.barMark, weightKg: r.weightKg })) }),
    });
    expect(first.version).toBe(1);
    expect(JSON.parse(first.content).status).toBe('INCOMPLETE');

    const done = applyEdits(rows, inputs, [
      { barMark: 'M1-A', field: 'coverMm', value: '40' },
      { barMark: 'M2-A', field: 'memberCount', value: '5' },
      { barMark: 'M3-A', field: 'memberWidth', value: '2900' },
      { barMark: 'M4-A', field: 'shapeCode', value: '11', confirmed: true },
    ]);
    const second = await saveProjectArtifact({
      ...base,
      content: JSON.stringify({ status: done.status, rows: done.rows.map((r) => ({ id: r.barMark, weightKg: r.weightKg })) }),
    });

    expect(second.version).toBe(2);
    expect(JSON.parse(second.content).status).toBe('FINAL');
    // the incomplete one is still on file, unchanged — the audit trail
    expect(first.id).not.toBe(second.id);
    expect(JSON.parse(first.content).status).toBe('INCOMPLETE');
    expect(first.documentId).toBe(second.documentId);
    expect(second.fileName).toMatch(/-BBS-v2\.json$/);
  });

  it('re-saving an unchanged schedule does not mint a version', async () => {
    const done = completeAll();
    const payload = JSON.stringify({ status: done.status, rows: done.rows.map((r) => ({ id: r.barMark, weightKg: r.weightKg })) });
    const a = await saveProjectArtifact({ ...base, documentId: 'doc-idempotent', content: payload });
    const b = await saveProjectArtifact({ ...base, documentId: 'doc-idempotent', content: payload });
    expect(b.version).toBe(a.version);
  });

  const completeAll = () => {
    const inputs = job();
    const { rows } = build(inputs);
    return applyEdits(rows, inputs, [
      { barMark: 'M1-A', field: 'coverMm', value: '40' },
      { barMark: 'M2-A', field: 'memberCount', value: '5' },
      { barMark: 'M3-A', field: 'memberWidth', value: '2900' },
      { barMark: 'M4-A', field: 'shapeCode', value: '11', confirmed: true },
    ]);
  };
});

// ------------------------------------------------------------
// the Excel round trip — take it away, complete it, bring it back
// ------------------------------------------------------------
describe('a workbook edited in Excel comes back through the same pipeline', () => {
  /** the schedule as a real .xlsx, then read back as a grid of cells */
  const workbookOf = (inputs: EngineInputs) => {
    const { rows, summary, reconciliation } = recalculate(inputs);
    const validation = validateSchedule(rows, { reconciliationOk: reconciliation.ok });
    const result = buildChatResult({
      id: 'wb-1',
      drawingName: 'Foundations.dxf',
      result: {
        settings: inputs.settings,
        members: Object.values(inputs.members),
        rows,
        summary,
        reconciliation,
        validation,
        engineInputs: inputs,
        incomplete: [],
        interpretation: { members: Object.values(inputs.members), bars: Object.values(inputs.bars), unresolved: [] },
      } as never,
      verification: { passed: [], failures: [], ok: true },
    });
    const bytes = writeBbsXlsx({ result, columns: defaultColumns(result) });
    const sheets = [...readXlsxGrids(bytes).values()];
    return { sheet: sheets[0], grid: buildEditGrid(rows, inputs, { summary, reconciliation, validation }), rows };
  };

  it('reads the schedule back, and an untouched workbook is not a correction', () => {
    const inputs = job();
    const { sheet, grid } = workbookOf(inputs);
    const header = sheet.find((r) => r.some((c) => String(c ?? '') === 'Bar Mark'))!;
    expect(header).toContain('Member Count');
    expect(header).toContain('Cutting Length (mm)');
    expect(header).toContain(CONFIRM_COLUMN_LABEL);
    expect(editsFromWorkbook(grid, sheet)).toEqual([]);
  });

  it('turns a changed cell into an edit, and the edit into a recalculated row', () => {
    const inputs = job();
    const { sheet, grid, rows } = workbookOf(inputs);
    const header = sheet.findIndex((r) => r.some((c) => String(c ?? '') === 'Bar Mark'));
    const cols = sheet[header].map((c) => String(c ?? ''));
    const markAt = cols.indexOf('Bar Mark');
    const countAt = cols.indexOf('Member Count');

    // a person types the member count into Excel, as they would
    const edited = sheet.map((line) =>
      String(line[markAt] ?? '') === 'M2-A' ? line.map((c, i) => (i === countAt ? 5 : c)) : line,
    );

    const edits = editsFromWorkbook(grid, edited);
    expect(edits).toEqual([{ barMark: 'M2-A', field: 'memberCount', value: '5' }]);

    const out = applyEdits(rows, inputs, edits);
    expect(out.facts[0].factId).toBe('M2.count');
    expect(out.rows.find((r) => r.barMark === 'M2-A')!.memberCount).toBe(5);
    expect(out.rows.find((r) => r.barMark === 'M2-A')!.weightKg).toBeGreaterThan(0);
  });

  it('honours the confirmation column for a figure that must be read from the drawing', () => {
    const inputs = job();
    const { sheet, grid, rows } = workbookOf(inputs);
    const header = sheet.findIndex((r) => r.some((c) => String(c ?? '') === 'Bar Mark'));
    const cols = sheet[header].map((c) => String(c ?? ''));
    const markAt = cols.indexOf('Bar Mark');
    const shapeAt = cols.indexOf('Shape');
    const confirmAt = cols.indexOf(CONFIRM_COLUMN_LABEL);

    const withShape = (confirm: string) =>
      sheet.map((line) =>
        String(line[markAt] ?? '') === 'M4-A'
          ? line.map((c, i) => (i === shapeAt ? '11' : i === confirmAt ? confirm : c))
          : line,
      );

    const unconfirmed = applyEdits(rows, inputs, editsFromWorkbook(grid, withShape('')));
    expect(unconfirmed.facts).toEqual([]);
    expect(unconfirmed.rejected[0].reason).toMatch(/from the drawing or the design/);

    const confirmed = applyEdits(rows, inputs, editsFromWorkbook(grid, withShape('yes')));
    expect(confirmed.rejected).toEqual([]);
    expect(confirmed.facts[0].confirmed).toBe(true);
  });

  it('completes the whole schedule from the workbook and reaches FINAL', () => {
    const inputs = job();
    const { sheet, grid, rows } = workbookOf(inputs);
    const header = sheet.findIndex((r) => r.some((c) => String(c ?? '') === 'Bar Mark'));
    const cols = sheet[header].map((c) => String(c ?? ''));
    const at = (label: string) => cols.indexOf(label);
    const markAt = at('Bar Mark');

    const filled = sheet.map((line, i) => {
      // the header row carries the labels the import reads — never write to it
      if (i <= header) return line;
      const mark = String(line[markAt] ?? '');
      const next = [...line];
      if (mark) next[at('Cover (mm)')] = 40;
      if (mark === 'M2-A') next[at('Member Count')] = 5;
      if (mark === 'M4-A') {
        next[at('Shape')] = '11';
        next[at(CONFIRM_COLUMN_LABEL)] = 'yes';
      }
      return next;
    });

    const edits = editsFromWorkbook(grid, filled);
    expect(edits.length).toBeGreaterThan(2);
    // M3's width is not a column of the schedule sheet, so it is completed in
    // the grid — the two surfaces write the same facts through the same call
    const out = applyEdits(rows, inputs, [...edits, { barMark: 'M3-A', field: 'memberWidth', value: '2900' }]);

    expect(out.rejected).toEqual([]);
    expect(out.rows.every((r) => r.weightKg !== null)).toBe(true);
    expect(out.reconciliation.ok).toBe(true);
    expect(out.status).toBe('FINAL');
  });
});

// ------------------------------------------------------------
// a schedule filed before its inputs were recorded
// ------------------------------------------------------------
describe('an older filed schedule is still editable', () => {
  /** what a schedule filed before `engineInputs` looks like: printed rows only */
  const filedWithoutInputs = () => {
    const inputs = job();
    const { rows, summary, reconciliation } = recalculate(inputs);
    const validation = validateSchedule(rows, { reconciliationOk: reconciliation.ok });
    const result = buildChatResult({
      id: 'legacy',
      drawingName: 'Foundations.dxf',
      result: {
        settings: inputs.settings,
        members: Object.values(inputs.members),
        rows,
        summary,
        reconciliation,
        validation,
        incomplete: [],
        interpretation: { members: Object.values(inputs.members), bars: Object.values(inputs.bars), unresolved: [] },
      } as never,
      verification: { passed: [], failures: [], ok: true },
    });
    delete (result as { engineInputs?: unknown }).engineInputs;
    return { filed: result as never, original: rows };
  };

  it('rebuilds the inputs and reproduces every row exactly', () => {
    const { filed, original } = filedWithoutInputs();
    const out = reconstructEngineInputs(filed)!;
    expect(out).not.toBeNull();
    expect(out.unreproduced).toEqual([]);

    const { rows } = recalculate(out.inputs);
    expect(rows).toHaveLength(original.length);
    for (const before of original) {
      const after = rows.find((r) => r.barMark === before.barMark)!;
      expect(after.cuttingLengthMm, before.barMark).toBe(before.cuttingLengthMm);
      expect(after.barsPerMember, before.barMark).toBe(before.barsPerMember);
      expect(after.totalBars, before.barMark).toBe(before.totalBars);
      if (before.weightKg === null) expect(after.weightKg).toBeNull();
      else expect(after.weightKg!).toBeCloseTo(before.weightKg, 6);
    }
  });

  it('keeps a manual count manual, so editing the spacing does not silently re-derive it', () => {
    const inputs = job();
    inputs.bars['M1-A'] = { ...inputs.bars['M1-A'], manualCount: 9 };
    const { rows, summary, reconciliation } = recalculate(inputs);
    const filed = buildChatResult({
      id: 'legacy-2',
      drawingName: 'd.dxf',
      result: {
        settings: inputs.settings,
        members: Object.values(inputs.members),
        rows,
        summary,
        reconciliation,
        incomplete: [],
        interpretation: { members: [], bars: [], unresolved: [] },
      } as never,
      verification: { passed: [], failures: [], ok: true },
    });
    delete (filed as { engineInputs?: unknown }).engineInputs;

    const out = reconstructEngineInputs(filed as never)!;
    expect(out.inputs.bars['M1-A'].manualCount).toBe(9);
    expect(recalculate(out.inputs).rows.find((r) => r.barMark === 'M1-A')!.barsPerMember).toBe(9);
  });

  it('completes a blocked row on the reconstructed schedule, exactly as on a fresh one', () => {
    const { filed } = filedWithoutInputs();
    const out = reconstructEngineInputs(filed)!;
    const { rows } = recalculate(out.inputs);
    const done = applyEdits(rows, out.inputs, [
      { barMark: 'M1-A', field: 'coverMm', value: '40' },
      { barMark: 'M2-A', field: 'memberCount', value: '5' },
      { barMark: 'M3-A', field: 'memberWidth', value: '2900' },
      { barMark: 'M4-A', field: 'shapeCode', value: '11', confirmed: true },
    ]);
    expect(done.rejected).toEqual([]);
    expect(done.status).toBe('FINAL');
  });

  it('names a row it could not reproduce, and the grid refuses to edit it', () => {
    const { filed } = filedWithoutInputs();
    // a filed row whose numbers no reconstruction can produce — a hook the
    // schedule never recorded, say, so the length is longer than any geometry
    const asObject = filed as unknown as { rows: { barMark: string; cuttingLengthMm?: number }[] };
    const tampered = {
      ...asObject,
      rows: asObject.rows.map((r) => (r.barMark === 'M1-A' ? { ...r, cuttingLengthMm: 9999 } : r)),
    };
    const out = reconstructEngineInputs(tampered as never)!;
    expect(out.unreproduced).toEqual(['M1-A']);

    const { rows } = recalculate(out.inputs);
    const grid = buildEditGrid(rows, out.inputs, { unreproduced: out.unreproduced });
    const row = grid.rows.find((r) => r.barMark === 'M1-A')!;
    expect(row.issues.some((i) => i.kind === 'MISMATCH' && /could not be reproduced/.test(i.reason))).toBe(true);
  });

  it('returns null only when there is nothing to reconstruct from', () => {
    expect(reconstructEngineInputs({ rows: [] } as never)).toBeNull();
    expect(reconstructEngineInputs({ rows: [{ barMark: 'A', memberMark: 'M', diameterMm: 10 }] } as never)).toBeNull();
  });
});

// ------------------------------------------------------------
// what the schedule itself disputes
// ------------------------------------------------------------
//
// Every row can compute and the schedule still rest on something nobody has
// settled: a sanity check saying the steel per metre is a fraction of what
// this kind of structure carries, an independent verifier rejecting a
// placement count. The arithmetic is not what those doubt, so no amount of
// recalculating answers them — and calling such a schedule FINAL is exactly
// the false "34/34 calculated" the gate exists to prevent.
describe('a dispute holds FINAL back until a person checks it', () => {
  /** a schedule where every row computes, filed with two schedule-level findings */
  const filedWithDisputes = () => {
    const inputs = job();
    // everything the arithmetic needs is present, so the ONLY thing that can
    // hold this schedule back is what it disputes
    inputs.settings.coverSource = 'stated';
    inputs.members.M2.count = 5;
    inputs.members.M3.widthMm = 2900;
    inputs.bars['M4-A'] = { ...inputs.bars['M4-A'], shapeCode: '00' };
    const { rows, summary, reconciliation } = recalculate(inputs);
    return {
      inputs,
      rows,
      summary,
      reconciliation,
      filed: {
        warnings: [
          { message: 'SANITY: 118 kg over a 160 m run is 0.7 kg/m — steel is MISSING from this schedule.' },
          { message: 'Independent verifier disputes the reading: the placement count of 4 is not supported by the drawing.' },
          // a warning that NAMES a member belongs to that row and is reported there
          { message: 'M1-A: cover was assumed', memberMark: 'M1' },
        ],
        verification: { ok: true, failures: [] },
      },
    };
  };

  it('reads the schedule-level findings, and leaves the per-row ones to their rows', () => {
    const { filed } = filedWithDisputes();
    const disputes = disputesOf(filed);
    expect(disputes).toHaveLength(2);
    expect(disputes[0]).toMatch(/SANITY/);
    expect(disputes[1]).toMatch(/Independent verifier/);
    expect(disputes.join(' ')).not.toMatch(/M1-A/);
  });

  it('a schedule with every row computed is INCOMPLETE while a dispute stands', () => {
    const { inputs, rows, summary, reconciliation, filed } = filedWithDisputes();
    expect(rows.every((r) => r.weightKg !== null)).toBe(true);

    const grid = buildEditGrid(rows, inputs, {
      summary,
      reconciliation,
      disputes: disputesOf(filed),
      verificationOk: filed.verification.ok,
    });
    expect(grid.status).toBe('INCOMPLETE');
    expect(grid.disputes).toHaveLength(2);
    // the dispute is the ONLY thing holding it back — every other gate passes
    expect(grid.validation.gates.filter((g) => !g.ok).map((g) => g.name)).toEqual(['no unresolved dispute']);
    expect(grid.validation.gates.find((g) => g.name === 'no unresolved dispute')!.ok).toBe(false);
    expect(grid.validation.blockers.some((b) => /UNRESOLVED — SANITY/.test(b))).toBe(true);
  });

  it('and stays INCOMPLETE however much is recalculated — arithmetic is not what it doubts', () => {
    const { inputs, rows, filed } = filedWithDisputes();
    const out = applyEdits(rows, inputs, [{ barMark: 'M1-A', field: 'memberCount', value: '6' }], {
      disputes: disputesOf(filed),
      verificationOk: filed.verification.ok,
    });
    expect(out.rejected).toEqual([]);
    expect(out.rows.every((r) => r.weightKg !== null)).toBe(true);
    expect(out.status).toBe('INCOMPLETE');
  });

  it('turns FINAL once a person has checked each one', () => {
    const { inputs, rows, filed } = filedWithDisputes();
    const standing = disputesOf(filed);

    // one checked, one still standing
    const half = applyEdits(rows, inputs, [], { disputes: disputesOf(filed, [standing[0]]), verificationOk: true });
    expect(half.status).toBe('INCOMPLETE');

    const settled = applyEdits(rows, inputs, [], { disputes: disputesOf(filed, standing), verificationOk: true });
    expect(settled.status).toBe('FINAL');
  });

  it('an acknowledgement already on the record is not asked for again', () => {
    const { filed } = filedWithDisputes();
    const standing = disputesOf(filed);
    const withRecord = { ...filed, acknowledged: [{ dispute: standing[0], by: 'you', at: 1 }] };
    expect(disputesOf(withRecord)).toEqual([standing[1]]);
  });

  it('a failed referee gate is a dispute too', () => {
    const { inputs, rows, summary, reconciliation } = filedWithDisputes();
    const filed = {
      warnings: [],
      verification: { ok: false, failures: [{ gate: 'placement', message: 'M2: placement did not resolve' }] },
    };
    const grid = buildEditGrid(rows, inputs, {
      summary,
      reconciliation,
      disputes: disputesOf(filed),
      verificationOk: false,
    });
    expect(grid.disputes).toEqual(['placement: M2: placement did not resolve']);
    expect(grid.status).toBe('INCOMPLETE');
  });
});
