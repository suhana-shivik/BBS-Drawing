import { describe, expect, it } from 'vitest';
import type { AskableQuestion } from '../../src/cad/bbs/askFrom';
import type { BbsChatRow } from '../../src/cad/bbs/chatResult';
import {
  applyFormatChange,
  classify,
  evidencedColumns,
  formatChangeIn,
  formatReply,
  vetFormatChange,
  type FormatView,
} from '../../src/interview/intent';

const row = (over: Partial<BbsChatRow> = {}): BbsChatRow => ({
  id: 'C1-L1',
  barMark: 'C1-L1',
  memberMark: 'C1',
  description: 'link T8',
  diameterMm: 8,
  spacingMm: 150,
  memberCount: 4,
  barsPerMember: 12,
  totalBars: 48,
  cuttingLengthMm: 1240,
  totalLengthM: 59.5,
  unitWeightKgPerM: 0.395,
  totalWeightKg: 23.5,
  working: ['bars: 12 per member × 4 = 48'],
  evidenceIds: ['CALL-014'],
  status: 'verified',
  ...over,
});

const view = (): FormatView => ({
  columns: ['mark', 'member', 'dia', 'shape', 'spacing', 'weight'],
  derived: ['mark', 'member', 'dia', 'shape', 'spacing', 'weight'],
  group: 'member',
  unit: 'mm',
});

const question = (over: Partial<AskableQuestion> = {}): AskableQuestion => ({
  id: 'dimension:C1:H',
  question: "What is C1's height?",
  why: 'the verticals are cut to it',
  blocks: ['C1'],
  evidence: [],
  answerType: 'number-mm',
  writesTo: { memberMark: 'C1', field: 'H' },
  ...over,
});

describe('what the user asked for, in words', () => {
  it('reads a request for a schedule, scoped or not', () => {
    expect(classify('give me the BBS')).toMatchObject({ kind: 'build-schedule' });
    expect(classify('produce the bar bending schedule please')).toMatchObject({
      kind: 'build-schedule',
    });
    expect(classify('give me the BBS for the tie beam')).toMatchObject({
      kind: 'build-schedule',
      memberMark: 'TIE BEAM',
    });
    expect(classify('make the schedule for C1')).toMatchObject({
      kind: 'build-schedule',
      memberMark: 'C1',
    });
  });

  it('reads every §7.3 format request', () => {
    expect(formatChangeIn('add a spacing column')).toEqual({ op: 'add-column', column: 'spacing' });
    expect(formatChangeIn('group by diameter')).toEqual({ op: 'group-by', by: 'dia' });
    expect(formatChangeIn('only the 16Ø bars')).toEqual({ op: 'filter-diameter', diaMm: 16 });
    expect(formatChangeIn('lengths in metres')).toEqual({ op: 'unit', unit: 'm' });
    expect(formatChangeIn("drop the shape column, we don't bend these")).toEqual({
      op: 'hide-column',
      column: 'shape',
    });
    expect(formatChangeIn('use our house format')).toEqual({ op: 'use-house-format' });
    expect(formatChangeIn('save this as our house format')).toEqual({ op: 'save-house-format' });
    expect(formatChangeIn('put it back the way the drawing has it')).toEqual({
      op: 'restore-derived',
    });
    expect(formatChangeIn('what does the shape code mean?')).toBeNull();
  });

  it('treats a reply as an answer while a question is open, and an explicit request as a request', () => {
    const pendingQuestions = [question({ id: 'six', blocks: ['a', 'b', 'c'] }), question({ id: 'one' })];

    expect(classify('1200', { pendingQuestions })).toEqual({
      kind: 'answer-question',
      said: '1200',
      questionId: 'six',
    });
    expect(classify('group by diameter', { pendingQuestions })).toMatchObject({
      kind: 'format-change',
    });
    // a click on a specific card beats every guess
    expect(classify('1200', { pendingQuestions, answeringQuestionId: 'one' })).toMatchObject({
      questionId: 'one',
    });
  });

  it('falls back to ordinary chat when nothing is open and nothing was requested', () => {
    expect(classify('thanks, that looks right')).toMatchObject({ kind: 'other' });
    expect(classify('')).toMatchObject({ kind: 'other' });
  });
});

describe('§7.3 rule 1 — a format request re-renders, it never re-derives', () => {
  it('changes only the view, and leaves the rows byte for byte as they were', () => {
    const rows = [row()];
    const before = JSON.stringify(rows);
    const outcome = applyFormatChange(view(), { op: 'group-by', by: 'dia' }, rows);

    expect(outcome.view.group).toBe('dia');
    expect(JSON.stringify(rows)).toBe(before);
    expect(outcome.view.columns).toEqual(view().columns);
    expect(Object.keys(outcome)).toEqual(['view']);
  });

  it('filters, re-units and restores without touching a figure', () => {
    const rows = [row()];
    expect(applyFormatChange(view(), { op: 'filter-diameter', diaMm: 16 }, rows).view.filterDiaMm).toBe(16);
    expect(applyFormatChange(view(), { op: 'unit', unit: 'm' }, rows).view.unit).toBe('m');

    const edited: FormatView = { ...view(), columns: ['mark', 'weight'] };
    expect(applyFormatChange(edited, { op: 'restore-derived' }, rows).view.columns).toEqual(
      view().derived,
    );
    expect(rows[0].totalWeightKg).toBe(23.5);
  });

  it('says so in words, with no figure in the sentence', () => {
    const outcome = applyFormatChange(view(), { op: 'group-by', by: 'dia' }, [row()]);
    const reply = formatReply({ op: 'group-by', by: 'dia' }, outcome);
    expect(reply).toMatch(/same rows/i);
    expect(reply).not.toMatch(/23\.5|59\.5|1240/);
  });
});

describe('§7.3 rule 2 — a request that would blank an evidenced column is declined, naming the rows', () => {
  it('declines dropping spacing, naming the members and the rows it would blank', () => {
    const rows = [
      row({ id: 'C1-L1', barMark: 'C1-L1', memberMark: 'C1' }),
      row({ id: 'C2-L1', barMark: 'C2-L1', memberMark: 'C2' }),
    ];
    const verdict = vetFormatChange({ op: 'hide-column', column: 'spacing' }, rows);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.members).toEqual(['C1', 'C2']);
    expect(verdict.wouldBlank).toEqual(['C1-L1', 'C2-L1']);
    expect(verdict.declined).toMatch(/C1 and C2 carry spacing/i);
    expect(verdict.declined).toMatch(/uncheckable/);
    expect(verdict.declined).toMatch(/group it away instead/);
  });

  it('leaves the column in place when the request is refused', () => {
    const rows = [row()];
    const outcome = applyFormatChange(view(), { op: 'hide-column', column: 'spacing' }, rows);
    expect(outcome.view.columns).toContain('spacing');
    expect(outcome.declined).toBeTruthy();
    expect(formatReply({ op: 'hide-column', column: 'spacing' }, outcome)).toBe(outcome.declined);
  });

  it('allows dropping a column no row can evidence', () => {
    const rows = [row({ spacingMm: undefined })];
    expect(vetFormatChange({ op: 'hide-column', column: 'spacing' }, rows).ok).toBe(true);
    expect(
      applyFormatChange(view(), { op: 'hide-column', column: 'spacing' }, rows).view.columns,
    ).not.toContain('spacing');
  });

  it('knows which columns a row can evidence at all', () => {
    const evidenced = evidencedColumns(row({ spacingMm: undefined, totalWeightKg: undefined }));
    expect(evidenced.has('spacing')).toBe(false);
    expect(evidenced.has('weight')).toBe(false);
    expect(evidenced.has('cuttingLength')).toBe(true);
  });

  it('a saved house format never hides an evidenced column either (§6.2)', () => {
    const rows = [row()];
    const outcome = applyFormatChange(view(), { op: 'use-house-format' }, rows, [
      'mark',
      'dia',
      'weight',
    ]);
    // spacing is not in the house format but this drawing evidences it, so it
    // comes back rather than being silently dropped to fit the template
    expect(outcome.view.columns).toContain('spacing');
    expect(outcome.view.columns.slice(0, 3)).toEqual(['mark', 'dia', 'weight']);
  });
});
