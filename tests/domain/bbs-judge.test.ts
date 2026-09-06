// The second reader.
//
// The gates ask whether a schedule is consistent with itself, and they are good
// at it. What none of them can ask is whether it READS THE DRAWING correctly:
// Run 028 and Run 029 differed by an order of magnitude — 2.4 t against 16 t —
// on the single question of whether the tie beam runs the boundary once or
// exists twelve times. Both were internally consistent; every gate agreed with
// both. Only the drawing settles it, and settling it is a reading.
//
// So these tests hold the two things that make a judge worth having: it is
// shown everything, and it may not state a quantity.
import { describe, expect, it, vi } from 'vitest';
import {
  runJudge, buildJudgePrompt, renderBbsTable, renderReasoning, renderVerdict,
  JUDGE_SYSTEM, JUDGE_REPLY,
} from '../../src/cad/bbs/judge';
import { validate } from '../../src/cad/bbs/schema';
import type { BbsChatResult } from '../../src/cad/bbs/chatResult';

const result = (): BbsChatResult =>
  ({
    id: 'r1',
    status: 'partial',
    project: { drawingName: 'GAMCO.dxf', runMm: 100_000 },
    members: [
      { mark: 'TB', type: 'member', count: 12, dims: { L: 400, W: 350 }, placementWorking: '12 — one per MEM-01 (12)', rowIds: ['TB-M1'], weightKg: 14_000 },
      { mark: 'C1', type: 'member', count: 19, dims: { L: 350, W: 350, H: 2700 }, coverMm: 40, coverSource: 'member-cover-table', placementWorking: 'template 29106 mm carries 5; 100000 mm run', rowIds: ['C1-M1'], weightKg: 391 },
    ],
    rows: [
      { id: 'TB-M1', barMark: 'TB-M1', memberMark: 'TB', description: 'MAIN T16', diameterMm: 16, memberCount: 12, barsPerMember: 2, totalBars: 24, cuttingLengthMm: 106_400, totalLengthM: 2553.6, unitWeightKgPerM: 1.578, totalWeightKg: 14_000, working: [], evidenceIds: [], status: 'verified' },
      { id: 'C1-M1', barMark: 'C1-M1', memberMark: 'C1', description: 'MAIN T12', diameterMm: 12, memberCount: 19, barsPerMember: 8, totalBars: 152, cuttingLengthMm: 2600, totalLengthM: 395.2, unitWeightKgPerM: 0.888, totalWeightKg: 391, working: [], evidenceIds: [], status: 'verified' },
      { id: 'SC-T1', barMark: 'SC-T1', memberMark: 'SC', description: 'STIRRUP T8', diameterMm: 8, memberCount: 23, barsPerMember: 0, totalBars: 0, unitWeightKgPerM: 0.395, working: [], evidenceIds: [], status: 'unavailable', note: 'H is not resolved' },
    ],
    diameterSummary: [
      { diaMm: 16, barCount: 24, totalLengthM: 2553.6, unitWeightKgPerM: 1.578, totalWeightKg: 14_000, totalWeightWithWastageKg: 14_420, nonStandardDiameter: false },
    ],
    netWeightKg: 14_391,
    procurementWeightKg: 14_822,
    assumptions: [],
    warnings: [],
    gaps: [],
    verification: { passed: [], failures: [], ok: false },
  }) as unknown as BbsChatResult;

const dossier = () => ({
  drawing: 'MEM-02 "TB" declared TB-(350X400)',
  facts: 'PROJECT RUN: 100000 mm (100 m)',
  calculation: renderBbsTable(result()),
  reasoning: renderReasoning(result()),
  objections: 'arithmetic TB.memberCount — the same run is scheduled 12 times over',
});

describe('the schedule, printed as a schedule', () => {
  it('prints the columns a checker reads, per row', () => {
    const t = renderBbsTable(result());
    expect(t).toMatch(/BAR MARK\s+MEMBER\s+TYPE\s+SHP\s+DIA\s+No\.\/MBR\s+MBRS\s+TOTAL No\.\s+CUT LEN/);
    expect(t).toMatch(/TB-M1\s+TB\s+MAIN T16/);
    expect(t).toContain('106400');      // the cutting length, as computed
    expect(t).toContain('2553.60');     // the total length, to two places
  });

  it('marks an unavailable row as unavailable rather than printing a zero', () => {
    expect(renderBbsTable(result())).toMatch(/SC-T1[\s\S]*UNAVAILABLE: H is not resolved/);
  });

  it('carries the diameter summary and both totals', () => {
    const t = renderBbsTable(result());
    expect(t).toMatch(/T16\s+24 bars/);
    expect(t).toContain('NET (no wastage): 14391.0 kg');
    expect(t).toContain('FOR PROCUREMENT: 14822.0 kg');
  });

  it('invents nothing when there are no rows', () => {
    expect(renderBbsTable({ ...result(), rows: [] } as BbsChatResult)).toBe('(the schedule has no rows)');
  });
});

describe('what the judge is shown', () => {
  it('gets the drawing, the facts, the reasoning, the calculation and the objections', () => {
    const p = buildJudgePrompt(dossier());
    for (const heading of [
      'THE DRAWING',
      'WHAT THE CLIENT STATED',
      'HOW EACH MEMBER WAS PLACED',
      'THE SCHEDULE THAT WAS PRODUCED',
      'WHAT THE AUTOMATIC CHECKS OBJECTED TO',
    ]) {
      expect(p).toContain(heading);
    }
    // the working behind each count reaches it, not just the count
    expect(p).toMatch(/12 — one per MEM-01/);
    expect(p).toMatch(/template 29106 mm carries 5/);
  });

  it('is never told what the answer should be', () => {
    const p = (buildJudgePrompt(dossier()) + JUDGE_SYSTEM).toLowerCase();
    for (const forbidden of ['6.49', '6494', '6305', 'expected total', 'reference schedule', 'should be about']) {
      expect(p).not.toContain(forbidden);
    }
  });

  it('is told plainly that it may not state a quantity', () => {
    expect(JUDGE_SYSTEM).toMatch(/YOU MAY NOT STATE A QUANTITY/);
    expect(JUDGE_SYSTEM).toMatch(/cannot-tell/);
  });
});

describe('the verdict it may return', () => {
  it('accepts a dispute phrased as a reading, with a correction the lead could adopt', async () => {
    const ask = vi.fn(async () => ({
      reading: 'a boundary wall: a tie beam running the length, on columns at intervals',
      verdict: 'disputed',
      disputes: [
        {
          subject: 'placement',
          memberMark: 'TB',
          what: 'TB is counted 12 times, once per stub column',
          why: 'the layout shows one continuous beam passing through every column, not one beam per column',
          correction: '{"kind":"placement","memberId":"MEM-02","placement":{"kind":"continuous","runFactId":"run"}}',
          confidence: 0.9,
        },
      ],
      confirmed: ['C1 at 2700 mm matches the stacked section dimensions'],
      answer: 'the schedule is sound except for the tie beam, which is placed as if it repeated',
      confidence: 0.85,
    }));
    const out = await runJudge(dossier(), ask as never);
    expect(out.ok).toBe(true);
    expect(out.reply!.verdict).toBe('disputed');
    expect(out.reply!.disputes![0].memberMark).toBe('TB');
    expect(ask).toHaveBeenCalledTimes(1); // ONE call, by design
  });

  it('refuses a verdict with an unknown subject rather than filing it anywhere', () => {
    const checked = validate(
      { reading: 'x', verdict: 'disputed', disputes: [{ subject: 'tonnage', what: 'a', why: 'b' }], answer: 'y' },
      JUDGE_REPLY,
    );
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problems[0].path).toBe('disputes[0].subject');
  });

  it('refuses a verdict that is missing its answer', () => {
    const checked = validate({ reading: 'x', verdict: 'sound' }, JUDGE_REPLY);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problems.map((p) => p.path)).toContain('answer');
  });

  it('reports an unreadable verdict instead of guessing at one', async () => {
    const out = await runJudge(dossier(), (async () => ({ verdict: 'sound' })) as never);
    expect(out.ok).toBe(false);
    expect(out.problem).toMatch(/DID NOT MATCH THE CONTRACT/);
    expect(renderVerdict(out)).toMatch(/no usable verdict/);
  });

  it('survives a judge that cannot be reached', async () => {
    const out = await runJudge(dossier(), (async () => {
      throw new Error('socket closed');
    }) as never);
    expect(out.ok).toBe(false);
    expect(out.problem).toMatch(/socket closed/);
  });

  it('renders a verdict a person can read', async () => {
    const ask = async () => ({
      reading: 'a boundary wall',
      verdict: 'disputed',
      disputes: [{ subject: 'placement', memberMark: 'TB', what: 'counted 12 times', why: 'it runs once' }],
      confirmed: ['C1 height'],
      answer: 'fix the tie beam',
    });
    const text = renderVerdict(await runJudge(dossier(), ask as never));
    expect(text).toMatch(/\*\*verdict:\*\* disputed/);
    expect(text).toMatch(/placement · TB/);
    expect(text).toMatch(/why: it runs once/);
    expect(text).toMatch(/fix the tie beam/);
  });
});

// A correction is only a correction if the lead could adopt it verbatim.
//
// Run 035's judge offered {"kind":"repeated","count":13} — not a placement kind
// this engine has, and carrying a typed count, which is the single thing the
// architecture refuses. `correction` was free text, so nothing looked at it.
describe('the corrections it offers', () => {
  const dispute = (correction: string) => ({
    reading: 'a boundary wall',
    verdict: 'disputed',
    disputes: [{ subject: 'placement', memberMark: 'SC', what: 'counted 23', why: 'the sheet is a module', correction }],
    answer: 'check SC',
  });

  it('accepts one phrased in the lead’s own vocabulary', async () => {
    const good = '{"kind":"placement","memberId":"MEM-01","placement":{"kind":"continuous","runFactId":"run"}}';
    const out = await runJudge(dossier(), (async () => dispute(good)) as never);
    expect(out.ok).toBe(true);
    expect(out.unusableCorrections).toBeUndefined();
  });

  it('reports the Run 035 shape as unusable — and KEEPS the dispute', async () => {
    const bad = '{"kind":"repeated","count":13}';
    const out = await runJudge(dossier(), (async () => dispute(bad)) as never);
    expect(out.ok).toBe(true);                       // the verdict still stands
    expect(out.reply!.disputes).toHaveLength(1);     // and so does the objection
    expect(out.unusableCorrections).toHaveLength(1);
    expect(out.unusableCorrections![0].why).toMatch(/one of: own, placement, dimension, shape, exclude/);
    expect(renderVerdict(out)).toMatch(/corrections that could NOT be adopted/);
  });

  it('refuses a correction that types a count, however well-formed', async () => {
    // a real placement kind, but carrying the number nobody read off the drawing
    const sneaky = '{"kind":"placement","memberId":"MEM-01","placement":{"kind":"marks","markEvidenceIds":["MARK-SC-001"],"count":13}}';
    const out = await runJudge(dossier(), (async () => dispute(sneaky)) as never);
    expect(out.unusableCorrections).toHaveLength(1);
    expect(out.unusableCorrections![0].why).toMatch(/types a count/);
  });

  it('refuses prose where a conclusion belongs', async () => {
    const out = await runJudge(dossier(), (async () => dispute('use 13 columns instead')) as never);
    expect(out.unusableCorrections).toHaveLength(1);
    expect(out.unusableCorrections![0].why).toMatch(/not json/);
  });

  it('says nothing when a dispute offers no correction at all', async () => {
    const out = await runJudge(dossier(), (async () => ({
      reading: 'a boundary wall', verdict: 'disputed',
      disputes: [{ subject: 'dimension', memberMark: 'SC', what: 'H unresolved', why: 'the sections carry it' }],
      answer: 'resolve SC height',
    })) as never);
    expect(out.ok).toBe(true);
    expect(out.unusableCorrections).toBeUndefined();
  });
});
