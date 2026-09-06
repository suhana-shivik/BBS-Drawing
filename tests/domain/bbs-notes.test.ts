// The understanding note — the reading, made into a thing with gaps you can see.
//
// Coverage used to be invisible until a build came back. One run claimed
// thirty-four callouts and totalled 3.0 t; the next claimed ten and totalled
// 1.3 t; both passed the same gates, because what varied was how much of the
// drawing had been READ and nothing said so.
//
// These tests hold the two properties that make the note worth having: every
// callout appears in it exactly once with a verdict or a loud absence, and the
// note is RENDERED FROM THE RECORD, so it cannot describe work nobody did.
import { describe, expect, it } from 'vitest';
import {
  renderUnderstandingNote,
  assessCompleteness,
  completenessLine,
  axisSuspicions,
  type NoteState,
} from '../../src/cad/bbs/notes';

const member = (over: Record<string, unknown> = {}) =>
  ({ id: 'MEM-01', mark: 'C1', aliases: [], declarationIds: [], markEvidenceIds: ['MARK-C1-001', 'MARK-C1-002'], declaredAs: 'C1-350x350', ...over }) as never;

const base = (over: Partial<NoteState> = {}): NoteState => ({
  drawingName: 'GAMCO.dxf',
  understanding: 'a boundary wall drawn as one typical module',
  facts: { run: { mm: 100_000, saidAs: '100 m' } },
  members: [member(), member({ id: 'MEM-02', mark: 'H-POLE', markEvidenceIds: [], declaredAs: 'H-POLE (150X150X2400)' })],
  callouts: [
    { id: 'CALL-001', text: '8-12TOR' },
    { id: 'CALL-002', text: '8TOR@200C/C(LINK)' },
    { id: 'CALL-003', text: '10TOR@200C/C' },
  ],
  claims: [{ calloutId: 'CALL-001', memberId: 'MEM-01', basis: 'in-detail', reason: 'its leader terminates on the section bars', barType: 'MAIN', distributionAxis: 'H' } as never],
  excluded: [{ calloutId: 'CALL-002', reason: 'the same links drawn again in the elevation' }],
  memberExclusions: new Map([['MEM-02', { mark: 'H-POLE', why: 'a bought precast item, no reinforcement callouts' }]]),
  placements: new Map([['MEM-01', { kind: 'template-repeat' } as never]]),
  placementWorking: new Map([['C1', 'template 29106 mm carries 5; 100000 mm run = 19']]),
  dims: new Map([['MEM-01', { L: 350, W: 350, H: 2700 }]]),
  dimSources: new Map([['MEM-01', { H: '1500 + 900 + 300 = 2700 mm (chain verified end to end on y)' }]]),
  shapes: new Map([['CALL-001', '00']]),
  requiredAxes: new Map([['MEM-01', ['H']]]),
  unresolved: ['whether the closing bay is a full module'],
  escalations: [{ question: 'Is the run a single straight length?', whyNeeded: 'it sets every repeated count' }],
  findings: [{ taskId: 'TASK-001', statement: 'the SC detail draws 8-12TOR', evidenceIds: ['CALL-001'] }],
  ...over,
});

describe('completeness is mechanical', () => {
  it('names the callouts nobody claimed or excluded', () => {
    const c = assessCompleteness(base());
    expect(c.complete).toBe(false);
    expect(c.unaccountedCallouts).toEqual(['CALL-003']);
    expect(c.calloutsAccounted).toBe(2);
    expect(c.calloutsTotal).toBe(3);
    expect(c.missing[0]).toMatch(/CALL-003/);
    expect(c.missing[0]).toMatch(/Steel nobody claimed is steel the schedule cannot see/);
  });

  it('is complete when every callout has a verdict and every member is placed and measured', () => {
    const c = assessCompleteness(base({ excluded: [
      { calloutId: 'CALL-002', reason: 'duplicate' },
      { calloutId: 'CALL-003', reason: 'belongs to the precast panel' },
    ] }));
    expect(c.complete).toBe(true);
    expect(completenessLine(c)).toMatch(/THE NOTE IS COMPLETE/);
  });

  it('flags a member that owns steel with nowhere to stand', () => {
    const c = assessCompleteness(base({ placements: new Map() }));
    expect(c.membersWithoutPlacement).toEqual(['C1']);
    expect(c.missing.some((m) => /count ZERO/.test(m))).toBe(true);
  });

  it('flags an axis the member’s own bars need', () => {
    const c = assessCompleteness(base({ dims: new Map([['MEM-01', { L: 350, W: 350 }]]) }));
    expect(c.membersMissingAxes).toEqual([{ mark: 'C1', axes: ['H'] }]);
    expect(c.missing.some((m) => /C1's bars need H/.test(m))).toBe(true);
  });

  it('asks nothing of a member excluded from the schedule', () => {
    // H-POLE has no placement and no dims, and is excluded — it must not appear
    const c = assessCompleteness(base());
    expect(c.membersWithoutPlacement).not.toContain('H-POLE');
    expect(c.membersMissingAxes.map((x) => x.mark)).not.toContain('H-POLE');
  });

  it('asks nothing of a member that owns no steel yet', () => {
    const c = assessCompleteness(base({ claims: [], excluded: [] }));
    expect(c.membersWithoutPlacement).toEqual([]);   // the gap is the callouts, not the member
    expect(c.unaccountedCallouts).toHaveLength(3);
  });
});

describe('the note itself', () => {
  it('accounts for every callout, by name, exactly once', () => {
    const note = renderUnderstandingNote(base());
    expect(note).toMatch(/`CALL-001` "8-12TOR" → \*\*C1\*\*/);
    expect(note).toMatch(/`CALL-002`.*→ \*\*excluded\*\* — the same links drawn again/);
    expect(note).toMatch(/`CALL-003`.*→ \*\*NOT YET ACCOUNTED FOR\*\*/);
  });

  it('says how each member repeats, and how it was worked out', () => {
    const note = renderUnderstandingNote(base());
    expect(note).toMatch(/\*\*how it repeats:\*\* template-repeat — template 29106 mm carries 5/);
  });

  it('says where each dimension was read from, and which are missing', () => {
    const note = renderUnderstandingNote(base({ dims: new Map([['MEM-01', { L: 350, H: 2700 }]]) }));
    expect(note).toMatch(/\*\*H\*\* = 2700 mm — read from 1500 \+ 900 \+ 300/);
    expect(note).toMatch(/\*\*W\*\* — not resolved/);
  });

  it('records an excluded member with its reason, and asks nothing more of it', () => {
    const note = renderUnderstandingNote(base());
    expect(note).toMatch(/### H-POLE[\s\S]*\*\*Not scheduled\.\*\* a bought precast item/);
    // it does not then go on to demand a placement for it
    const section = note.slice(note.indexOf('### H-POLE'));
    expect(section.slice(0, 300)).not.toMatch(/how it repeats/);
  });

  it('carries the open questions rather than quietly dropping them', () => {
    const note = renderUnderstandingNote(base());
    expect(note).toMatch(/whether the closing bay is a full module/);
    expect(note).toMatch(/\*\*for the client:\*\* Is the run a single straight length\?/);
  });

  it('says plainly when the lead has not yet said what the drawing is', () => {
    expect(renderUnderstandingNote(base({ understanding: undefined })))
      .toMatch(/the lead has not yet said what it makes of this drawing/);
  });

  it('states the client fact as stated, not as measured', () => {
    expect(renderUnderstandingNote(base())).toMatch(/\*\*run\*\* — 100000 mm \(100 m\), stated by the client, not measured on the sheet/);
  });

  it('describes no work that was not done — an empty record renders an empty reading', () => {
    const note = renderUnderstandingNote(base({
      claims: [], excluded: [], placements: new Map(), dims: new Map(),
      dimSources: new Map(), shapes: new Map(), findings: [], unresolved: [], escalations: [],
    }));
    expect(note).toMatch(/NOT YET ACCOUNTED FOR/);
    expect(note).toMatch(/how it repeats: NOT ESTABLISHED/);
    expect(note).toMatch(/none has been assigned to it yet/);
    // and it claims nothing about steel it does not have
    expect(note).not.toMatch(/→ \*\*C1\*\*/);
  });
});

// Two things Run 042 taught the note.
//
// It asked the lead to resolve C1's length while the sheet prints it in the
// caption "TYPICAL DETAIL OF C1-350x350" — the completeness check counted only
// dimensions the model had pointed at, and so invented a gap the drawing had
// already filled. And it let three columns stand 350 mm on every axis: the
// cube advisory existed in the build feedback, fired ten times, and was ignored,
// because it was not part of the reading the lead was being asked to finish.
describe('what the declaration already answers', () => {
  it('counts an axis the sheet declares, and stops asking for it', () => {
    const s = base({
      dims: new Map([['MEM-01', { W: 350, H: 2700 }]]),      // the model pointed at W and H
      declaredDims: new Map([['MEM-01', { L: 350, W: 350 }]]), // the caption gives L
      requiredAxes: new Map([['MEM-01', ['L', 'W', 'H']]]),
      excluded: [{ calloutId: 'CALL-002', reason: 'dup' }, { calloutId: 'CALL-003', reason: 'panel' }],
    });
    const c = assessCompleteness(s);
    expect(c.membersMissingAxes).toEqual([]);
    expect(c.complete).toBe(true);
  });

  it('still reports an axis neither the model nor the sheet supplies', () => {
    const c = assessCompleteness(base({
      dims: new Map([['MEM-01', { W: 350 }]]),
      declaredDims: new Map([['MEM-01', { L: 350, W: 350 }]]),
      requiredAxes: new Map([['MEM-01', ['L', 'W', 'H']]]),
    }));
    expect(c.membersMissingAxes).toEqual([{ mark: 'C1', axes: ['H'] }]);
  });
});

describe('geometry worth a second look', () => {
  it('names a member measuring the same on all three axes, and what it was read from', () => {
    const s = base({
      dims: new Map([['MEM-01', { L: 350, W: 350, H: 350 }]]),
      dimSources: new Map([['MEM-01', { H: '350 — DIM-133 "350"' }]]),
    });
    const flags = axisSuspicions(s);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatch(/C1 measures 350 mm on all three axes — a cube/);
    expect(flags[0]).toMatch(/H from 350 — DIM-133/);
    expect(renderUnderstandingNote(s)).toMatch(/## Geometry worth a second look/);
  });

  it('says nothing about a member that is merely square in plan', () => {
    expect(axisSuspicions(base({ dims: new Map([['MEM-01', { L: 350, W: 350, H: 2700 }]]) }))).toEqual([]);
  });

  it('says nothing about an excluded member, or one with an axis still open', () => {
    expect(axisSuspicions(base({
      dims: new Map([['MEM-02', { L: 150, W: 150, H: 150 }]]),   // H-POLE, excluded
    }))).toEqual([]);
    expect(axisSuspicions(base({ dims: new Map([['MEM-01', { L: 350, W: 350 }]]) }))).toEqual([]);
  });

  it('never blocks the reading — it is a question, not a gate', () => {
    const s = base({
      dims: new Map([['MEM-01', { L: 350, W: 350, H: 350 }]]),
      requiredAxes: new Map([['MEM-01', ['L', 'W', 'H']]]),
      excluded: [{ calloutId: 'CALL-002', reason: 'dup' }, { calloutId: 'CALL-003', reason: 'panel' }],
    });
    expect(axisSuspicions(s)).toHaveLength(1);
    expect(assessCompleteness(s).complete).toBe(true);   // suspicious, but read
  });
});
