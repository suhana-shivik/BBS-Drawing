import { describe, expect, it } from 'vitest';
import { buildChangeLog, matchesQuery, type ChangeLogProject } from '../../src/register/changeLog';
import { reconcileRevisionStates } from '../../src/register/register';
import type { DrawingRegisterEntry } from '../../src/register/types';

const JAN = Date.parse('2026-01-10T09:00:00Z');
const JUN = Date.parse('2026-06-18T09:00:00Z');

function entry(over: Partial<DrawingRegisterEntry>): DrawingRegisterEntry {
  return {
    id: 'drw_x',
    projectId: 'prj_1',
    documentId: 'doc_x',
    assetId: 'ast_x',
    originalFileName: 'sheet.dxf',
    displayName: 'sheet',
    drawingNumber: 'ORI-NAG-TD-EL-02',
    identityKey: 'ORINAGTDEL02',
    title: 'POWER DISTRIBUTION SCHEME',
    revision: 'R0',
    revisionRank: 0,
    issueDate: '',
    discipline: 'mep',
    health: 'ready',
    revisionState: 'current',
    versionNo: 1,
    versionCount: 1,
    importedAt: JAN,
    warnings: [],
    evidence: {},
    ...over,
  };
}

/** The pair the plan names: R1 imported over an R0 already on file. */
function revisedProject(): ChangeLogProject {
  const r0 = entry({ id: 'drw_r0', documentId: 'doc_r0', revision: 'R0', revisionRank: 0, importedAt: JAN });
  const r1 = entry({ id: 'drw_r1', documentId: 'doc_r1', revision: 'R1', revisionRank: 1, importedAt: JUN });
  return {
    id: 'prj_1',
    name: 'Oriental Nagpur',
    // through the real reconciler, so the states are the register's own
    entries: reconcileRevisionStates([r0, r1]),
    artifacts: [],
  };
}

describe('change log', () => {
  it('records a supersession naming both revisions', () => {
    const events = buildChangeLog([revisedProject()]);
    const superseded = events.filter((e) => e.kind === 'superseded');

    expect(superseded).toHaveLength(1);
    expect(superseded[0].detail).toBe('R0 replaced by R1');
    expect(superseded[0].what).toBe('ORI-NAG-TD-EL-02');
  });

  it('dates a supersession when the replacement arrived, not when the old sheet did', () => {
    // Dating it by the superseded sheet's own importedAt would put the event
    // five months before the drawing that caused it existed.
    const [superseded] = buildChangeLog([revisedProject()]).filter((e) => e.kind === 'superseded');
    expect(superseded.at).toBe(JUN);
  });

  it('logs every arrival, so a drawing is never in the register unaccounted for', () => {
    const events = buildChangeLog([revisedProject()]);
    expect(events.filter((e) => e.kind === 'registered')).toHaveLength(2);
  });

  it('does not claim a supersession for a chain nobody has confirmed', () => {
    // No revision read means the register marks both 'review'. Asserting one
    // replaced the other would invent a chain from a guess.
    const a = entry({ id: 'a', documentId: 'doc_a', revision: '', revisionRank: null, health: 'review' });
    const b = entry({ id: 'b', documentId: 'doc_b', revision: '', revisionRank: null, health: 'review', importedAt: JUN });
    const events = buildChangeLog([
      { id: 'prj_1', name: 'P', entries: reconcileRevisionStates([a, b]), artifacts: [] },
    ]);
    expect(events.filter((e) => e.kind === 'superseded')).toHaveLength(0);
  });

  it('marks a drawing whose identity a person typed', () => {
    const typed = entry({
      evidence: { revision: { value: 'R1', source: 'user', confidence: 1 } },
    });
    const [event] = buildChangeLog([{ id: 'p', name: 'P', entries: [typed], artifacts: [] }]);
    expect(event.corrected).toBe(true);
  });

  it('puts issued outputs in the same stream, newest first', () => {
    const project: ChangeLogProject = {
      ...revisedProject(),
      artifacts: [{ kind: 'quantity', createdAt: JUN + 86_400_000, fileName: 'ORI-EL-02-QTY-v1.csv' }],
    };
    const events = buildChangeLog([project]);

    expect(events[0].kind).toBe('issued');
    expect(events[0].what).toBe('ORI-EL-02-QTY-v1.csv');
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort((a, b) => b - a));
  });

  it('searches the detail, not just the file name', () => {
    const [superseded] = buildChangeLog([revisedProject()]).filter((e) => e.kind === 'superseded');
    expect(matchesQuery(superseded, 'replaced by R1')).toBe(true);
    expect(matchesQuery(superseded, 'plumbing')).toBe(false);
  });
});
