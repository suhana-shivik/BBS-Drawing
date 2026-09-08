// ============================================================
// EDITING A SCHEDULE IS A CORRECTION, NOT A REVISION.
//
// Opening pedestal-BBS-v1, completing a blocked row and saving leaves you
// with pedestal-BBS-v1 — corrected. Same artifact id, same version, same file
// name. A recalculation is not a version; a USER_INPUT edit is not a version.
//
// A version is a deliberate act, and "Save as new version" is that act.
//
// What must NOT be lost by updating in place is the record of what changed.
// The artifact carries its own `history`, and a calculation run is filed
// beside it on every save, so the audit trail survives the file staying put.
// ============================================================
import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyEdits,
  recalculate,
  type BbsEditEvent,
  type CellEdit,
} from '../../calculations/bbsEdit';
import { validateSchedule } from '../../calculations/validation';
import {
  loadProjectArtifacts,
  saveProjectArtifact,
  updateProjectArtifact,
  type ProjectArtifact,
} from '../../src/register/artifacts';
import type { BbsBar, BbsMember, BbsSettings, EngineInputs } from '../../src/cad/bbs/types';

// ------------------------------------------------------------
// a schedule with one blocked row, as filed
// ------------------------------------------------------------
const settings = (): BbsSettings => ({
  concreteGrade: 'M25',
  steelGrade: 'Fe500',
  coverMm: 40,
  coverSource: 'stated',
  bendMode: 'CONVENTIONAL',
  wastagePct: 3,
});

const member = (over: Partial<BbsMember> & { mark: string }): BbsMember => ({
  type: 'PEDESTAL',
  count: 2,
  source: { table: 'SCHEDULE', row: 1 },
  incomplete: false,
  missing: [],
  dimSources: { L: 'DRAWING_READ — SCHEDULE', W: 'DRAWING_READ — SCHEDULE', H: 'DRAWING_READ — SCHEDULE' },
  ...over,
});

const bar = (over: Partial<BbsBar> & { memberMark: string; diaMm: number }): BbsBar => ({
  barType: 'MAIN',
  shapeCode: '00',
  fromCallout: `T${over.diaMm}`,
  handles: ['H1'],
  ...over,
});

function job(): EngineInputs {
  return {
    members: {
      P1: member({ mark: 'P1', lengthMm: 1000, widthMm: 450, heightMm: 1200, count: 2 }),
      P2: member({ mark: 'P2', lengthMm: 2000, heightMm: 1100, count: 3, dimSources: { L: 'DRAWING_READ — SCHEDULE', H: 'DRAWING_READ — SCHEDULE' } }),
    },
    bars: {
      'P1-V1': bar({ memberMark: 'P1', diaMm: 16, spacingMm: 200, distributionAxis: 'H' }),
      // spaced along L, so it RUNS along W — and P2's width was never read,
      // which is what leaves this row blocked
      'P2-V1': bar({ memberMark: 'P2', diaMm: 12, spacingMm: 150, distributionAxis: 'L' }),
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
  return { rows, summary, reconciliation, validation: validateSchedule(rows, { reconciliationOk: reconciliation.ok }) };
};

/** the artifact payload as the app files it, with the inputs it was built from */
const payloadOf = (inputs: EngineInputs, history: BbsEditEvent[] = []) => {
  const { rows, summary, validation } = build(inputs);
  return JSON.stringify({
    id: 'run-1',
    status: validation.final ? 'complete' : 'partial',
    rows: rows.map((r) => ({ barMark: r.barMark, weightKg: r.weightKg, cuttingLengthMm: r.cuttingLengthMm })),
    summary,
    validation,
    engineInputs: inputs,
    history,
  });
};

const BASE = {
  projectId: 'proj-inplace',
  documentId: 'doc-pedestal',
  kind: 'bbs' as const,
  drawingName: 'pedestal_bbs_detail_large.dxf',
  drawingNumber: 'PEDESTAL_BBS_DETAIL_LARGE',
  revision: 'A',
  mimeType: 'application/json' as const,
};

/** file v1, exactly as a build would */
async function fileV1(documentId = BASE.documentId): Promise<ProjectArtifact> {
  await loadProjectArtifacts(BASE.projectId);
  return saveProjectArtifact({ ...BASE, documentId, content: payloadOf(job()) });
}

/**
 * What the app's save action does, in the same order, without the React
 * layer: recalculate through the pipeline, then write back to the SAME
 * artifact with the edit recorded.
 */
async function editInPlace(
  artifact: ProjectArtifact,
  edits: readonly CellEdit[],
): Promise<{ saved: ProjectArtifact | null; status: string; rejected: number }> {
  const stored = JSON.parse(artifact.content) as { engineInputs: EngineInputs; history?: BbsEditEvent[]; validation?: { label: 'FINAL' | 'INCOMPLETE' } };
  const { rows } = recalculate(stored.engineInputs);
  const out = applyEdits(rows, stored.engineInputs, edits);
  if (out.rejected.length) return { saved: null, status: out.status, rejected: out.rejected.length };

  const event: BbsEditEvent = {
    at: Date.now(),
    by: 'you',
    edits: out.facts.map((f) => ({
      factId: f.factId,
      to: f.value,
      ...(f.previous ? { from: f.previous.value, fromSource: f.previous.source } : {}),
      override: f.override,
      affects: f.affects,
    })),
    rowsRecalculated: out.invalidated,
    statusBefore: stored.validation?.label ?? 'INCOMPLETE',
    statusAfter: out.status,
    reconciled: out.reconciliation.ok,
    netWeightKg: out.summary.reduce((n, s) => n + s.totalWeightKg, 0),
  };
  const content = JSON.stringify({
    id: `run-${Date.now()}`,
    status: out.status === 'FINAL' ? 'complete' : 'partial',
    rows: out.rows.map((r) => ({ barMark: r.barMark, weightKg: r.weightKg, cuttingLengthMm: r.cuttingLengthMm })),
    summary: out.summary,
    validation: out.validation,
    engineInputs: out.inputs,
    history: [...(stored.history ?? []), event],
  });
  const saved = await updateProjectArtifact(BASE.projectId, artifact.id, content);
  return { saved, status: out.status, rejected: 0 };
}

const FIX_P2: CellEdit[] = [{ barMark: 'P2-V1', field: 'memberWidth', value: '900' }];

describe('a normal edit updates the schedule that was opened', () => {
  beforeEach(async () => {
    await loadProjectArtifacts(BASE.projectId);
  });

  it('1 & 2 — v1 edited is still v1, under the same file name', async () => {
    const v1 = await fileV1('doc-1');
    expect(v1.version).toBe(1);
    expect(v1.fileName).toBe('PEDESTAL_BBS_DETAIL_LARGE-BBS-v1.json');

    const { saved } = await editInPlace(v1, FIX_P2);
    expect(saved!.version).toBe(1);
    expect(saved!.fileName).toBe(v1.fileName);
    expect(saved!.fileName).not.toMatch(/v2/);
  });

  it('3 — the artifact id does not change', async () => {
    const v1 = await fileV1('doc-2');
    const { saved } = await editInPlace(v1, FIX_P2);
    expect(saved!.id).toBe(v1.id);
  });

  it('4 & 5 — the calculation run and the input snapshot DO change', async () => {
    const v1 = await fileV1('doc-3');
    const before = JSON.parse(v1.content);
    expect(before.engineInputs.members.P2.widthMm).toBeUndefined();

    const { saved } = await editInPlace(v1, FIX_P2);
    const after = JSON.parse(saved!.content);
    expect(after.id).not.toBe(before.id);
    expect(after.engineInputs.members.P2.widthMm).toBe(900);
  });

  it('6 — rows, summary and reconciliation update', async () => {
    const v1 = await fileV1('doc-4');
    const before = JSON.parse(v1.content);
    expect(before.rows.find((r: { barMark: string }) => r.barMark === 'P2-V1').weightKg).toBeNull();

    const { saved, status } = await editInPlace(v1, FIX_P2);
    const after = JSON.parse(saved!.content);
    const p2 = after.rows.find((r: { barMark: string }) => r.barMark === 'P2-V1');
    expect(p2.cuttingLengthMm).toBeGreaterThan(0);
    expect(p2.weightKg).toBeGreaterThan(0);
    expect(after.summary.reduce((n: number, s: { totalWeightKg: number }) => n + s.totalWeightKg, 0)).toBeGreaterThan(
      before.summary.reduce((n: number, s: { totalWeightKg: number }) => n + s.totalWeightKg, 0),
    );
    expect(after.validation.gates.find((g: { name: string }) => g.name === 'steel summary reconciled').ok).toBe(true);
    expect(status).toBe('FINAL');
  });

  it('7 — the edit is on the record: what changed, from what, and where that came from', async () => {
    const v1 = await fileV1('doc-5');
    const { saved } = await editInPlace(v1, [
      { barMark: 'P2-V1', field: 'memberWidth', value: '900' },
      { barMark: 'P1-V1', field: 'memberCount', value: '5' },
    ]);
    const history = JSON.parse(saved!.content).history as BbsEditEvent[];
    expect(history).toHaveLength(1);

    const event = history[0];
    expect(event.by).toBe('you');
    expect(event.at).toBeGreaterThan(0);
    expect(event.statusBefore).toBe('INCOMPLETE');
    expect(event.statusAfter).toBe('FINAL');
    expect(event.reconciled).toBe(true);
    expect(event.rowsRecalculated.sort()).toEqual(['P1-V1', 'P2-V1']);

    const width = event.edits.find((e) => e.factId === 'P2.width')!;
    expect(width.to).toBe(900);
    expect(width.override).toBe(false);

    // an override keeps what the drawing said, and says it was a drawing reading
    const count = event.edits.find((e) => e.factId === 'P1.count')!;
    expect(count.from).toBe(2);
    expect(count.to).toBe(5);
    expect(count.override).toBe(true);
  });

  it('7b — a second edit appends, so the history is the whole story', async () => {
    const v1 = await fileV1('doc-6');
    const first = await editInPlace(v1, FIX_P2);
    const second = await editInPlace(first.saved!, [{ barMark: 'P1-V1', field: 'memberCount', value: '4' }]);
    const history = JSON.parse(second.saved!.content).history as BbsEditEvent[];
    expect(history).toHaveLength(2);
    expect(history[0].edits[0].factId).toBe('P2.width');
    expect(history[1].edits[0].factId).toBe('P1.count');
    expect(second.saved!.version).toBe(1);
  });

  it('11 — an edit that fails validation leaves v1 exactly as it was', async () => {
    const v1 = await fileV1('doc-7');
    const before = v1.content;
    const out = await editInPlace(v1, [{ barMark: 'P2-V1', field: 'memberWidth', value: 'about 400' }]);
    expect(out.rejected).toBe(1);
    expect(out.saved).toBeNull();

    const list = await loadProjectArtifacts(BASE.projectId);
    const still = list.find((a) => a.id === v1.id)!;
    expect(still.content).toBe(before);
    expect(still.version).toBe(1);
  });

  it('12 — reopening the register shows the corrected v1, not a second file', async () => {
    const v1 = await fileV1('doc-8');
    await editInPlace(v1, FIX_P2);

    const list = (await loadProjectArtifacts(BASE.projectId)).filter((a) => a.documentId === 'doc-8');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(v1.id);
    expect(list[0].version).toBe(1);
    expect(JSON.parse(list[0].content).engineInputs.members.P2.widthMm).toBe(900);
    expect(list[0].updatedAt).toBeGreaterThanOrEqual(list[0].createdAt);
  });
});

describe('a new version is a deliberate act', () => {
  beforeEach(async () => {
    await loadProjectArtifacts(BASE.projectId);
  });

  it('8 & 9 — "save as new version" files v2 and leaves v1 untouched', async () => {
    const v1 = await fileV1('doc-9');
    const before = v1.content;

    // the deliberate path: the recalculated content is FILED, not written back
    const stored = JSON.parse(v1.content) as { engineInputs: EngineInputs };
    const { rows } = recalculate(stored.engineInputs);
    const out = applyEdits(rows, stored.engineInputs, FIX_P2);
    const v2 = await saveProjectArtifact({
      ...BASE,
      documentId: 'doc-9',
      content: JSON.stringify({ id: 'run-2', rows: out.rows.map((r) => ({ barMark: r.barMark, weightKg: r.weightKg })), engineInputs: out.inputs }),
    });

    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id);
    expect(v2.fileName).toMatch(/-BBS-v2\./);

    const list = await loadProjectArtifacts(BASE.projectId);
    const stillV1 = list.find((a) => a.id === v1.id)!;
    expect(stillV1.content).toBe(before);
    expect(stillV1.version).toBe(1);
    expect(list.filter((a) => a.documentId === 'doc-9')).toHaveLength(2);
  });

  it('a correction after a new version applies to the version being edited', async () => {
    const v1 = await fileV1('doc-10');
    const v2 = await saveProjectArtifact({ ...BASE, documentId: 'doc-10', content: payloadOf({ ...job(), runMm: 1 }) });
    expect(v2.version).toBe(2);

    const { saved } = await editInPlace(v2, FIX_P2);
    expect(saved!.id).toBe(v2.id);
    expect(saved!.version).toBe(2);
    // v1 is untouched by an edit to v2
    const list = await loadProjectArtifacts(BASE.projectId);
    expect(JSON.parse(list.find((a) => a.id === v1.id)!.content).engineInputs.members.P2.widthMm).toBeUndefined();
  });
});

describe('an artifact filed before inputs were recorded', () => {
  beforeEach(async () => {
    await loadProjectArtifacts(BASE.projectId);
  });

  it('10 — hydrates, edits, and saves back to the SAME version', async () => {
    // v1 as an older build filed it: rows and members, no engineInputs
    const { rows, summary, validation } = build(job());
    const legacy = await saveProjectArtifact({
      ...BASE,
      documentId: 'doc-legacy',
      content: JSON.stringify({
        id: 'old-run',
        rows: rows.map((r) => ({
          barMark: r.barMark,
          memberMark: r.memberMark,
          diameterMm: r.diaMm,
          spacingMm: r.spacingMm,
          memberCount: r.memberCount ?? undefined,
          barsPerMember: r.barsPerMember ?? undefined,
          totalBars: r.totalBars ?? undefined,
          cuttingLengthMm: r.cuttingLengthMm ?? undefined,
          shapeCode: r.shapeCode,
          location: r.barType,
          description: r.description,
          trace: r.trace,
        })),
        members: Object.values(job().members).map((m) => ({
          mark: m.mark,
          type: m.type,
          count: m.count,
          dims: { L: m.lengthMm, W: m.widthMm, H: m.heightMm },
        })),
        settings: settings(),
        summary,
        validation,
      }),
    });
    expect(legacy.version).toBe(1);
    expect(JSON.parse(legacy.content).engineInputs).toBeUndefined();

    // hydrate → edit → save back to the same artifact
    const { reconstructEngineInputs } = await import('../../calculations/bbsEdit');
    const hydrated = reconstructEngineInputs(JSON.parse(legacy.content))!;
    expect(hydrated.unreproduced).toEqual([]);

    const fresh = recalculate(hydrated.inputs);
    const out = applyEdits(fresh.rows, hydrated.inputs, FIX_P2);
    expect(out.rejected).toEqual([]);

    const saved = await updateProjectArtifact(
      BASE.projectId,
      legacy.id,
      JSON.stringify({ id: 'new-run', rows: out.rows.map((r) => ({ barMark: r.barMark, weightKg: r.weightKg })), engineInputs: out.inputs }),
    );
    expect(saved!.id).toBe(legacy.id);
    expect(saved!.version).toBe(1);
    expect(saved!.fileName).toBe(legacy.fileName);
    // and it now carries the inputs, so the next edit needs no hydration
    expect(JSON.parse(saved!.content).engineInputs.members.P2.widthMm).toBe(900);
  });

  it('refuses to update an artifact that is not on file', async () => {
    expect(await updateProjectArtifact(BASE.projectId, 'no-such-artifact', '{}')).toBeNull();
  });
});
