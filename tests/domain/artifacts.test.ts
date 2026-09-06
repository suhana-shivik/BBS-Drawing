import { describe, expect, it } from 'vitest';
import {
  artifactFingerprint,
  nextArtifactVersion,
  saveProjectArtifact,
  type ProjectArtifact,
} from '../../src/register/artifacts';

const artifact = (version: number, documentId = 'doc-1', kind: ProjectArtifact['kind'] = 'quantity'): ProjectArtifact => ({
  id: `artifact-${version}`,
  projectId: 'project-1',
  documentId,
  kind,
  fileName: `drawing-QTY-v${version}.csv`,
  drawingName: 'Drawing A',
  drawingNumber: 'A-101',
  revision: 'R1',
  version,
  mimeType: 'text/csv',
  content: 'Description,Quantity',
  createdAt: version,
});

describe('project artifact versioning', () => {
  it('starts the first quantity sheet at version 1', () => {
    expect(nextArtifactVersion([], 'doc-1', 'quantity')).toBe(1);
  });

  it('increments only within the same drawing and artifact kind', () => {
    const existing = [
      artifact(1),
      artifact(3),
      artifact(8, 'doc-2'),
      artifact(5, 'doc-1', 'bbs'),
    ];
    expect(nextArtifactVersion(existing, 'doc-1', 'quantity')).toBe(4);
    expect(nextArtifactVersion(existing, 'doc-1', 'bbs')).toBe(6);
    expect(nextArtifactVersion(existing, 'doc-2', 'quantity')).toBe(9);
  });
});

// ------------------------------------------------------------
// a version is a CHANGE, not a run
// ------------------------------------------------------------
//
// The stale-loop defect rebuilt one schedule forty-nine times and filed
// forty-nine identical workbooks, which buried the real history (v1 read the
// sheet, v2 had the cover, v3 had the run) in noise. Even with the loop fixed,
// an identical rebuild must not mint a version.
describe('identical rebuilds do not mint versions', () => {
  const base = {
    projectId: 'proj-dedupe',
    documentId: 'doc-1',
    kind: 'bbs' as const,
    drawingName: 'Foundations drawings.dxf',
    drawingNumber: 'PCD-IND-B300-S-803-R0',
    revision: 'S',
    mimeType: 'application/json' as const,
  };

  it('re-filing the same content returns the version already on file', async () => {
    const first = await saveProjectArtifact({ ...base, content: '{"rows":34}' });
    expect(first.version).toBe(1);

    for (let i = 0; i < 10; i++) {
      const again = await saveProjectArtifact({ ...base, content: '{"rows":34}' });
      expect(again.version).toBe(1);
      expect(again.id).toBe(first.id);
    }

    // Ten identical rebuilds filed nothing, so the next REAL change is v2 —
    // not v12. That is the check that proves no version was minted, without
    // needing a storage backend to count rows in.
    const changed = await saveProjectArtifact({ ...base, content: '{"rows":34,"cover":40}' });
    expect(changed.version).toBe(2);
  });

  it('a schedule that actually changed still gets its own version', async () => {
    await saveProjectArtifact({ ...base, documentId: 'doc-2', content: '{"rows":34}' });
    const changed = await saveProjectArtifact({ ...base, documentId: 'doc-2', content: '{"rows":34,"cover":40}' });
    expect(changed.version).toBe(2);
    // and a third, different again
    const third = await saveProjectArtifact({ ...base, documentId: 'doc-2', content: '{"rows":34,"cover":40,"run":160}' });
    expect(third.version).toBe(3);
  });
});

describe('what makes two filed outputs the same document', () => {
  // The subtle half. A BBS result carries its own id and a manifest with a
  // fresh UUID and timestamp on EVERY build, nested two levels down. Comparing
  // raw bytes therefore called 326 identical schedules distinct — the version
  // list the loop produced looked like real history and was not.
  const result = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: 'orchestrated-1788680000000',
      builtAt: 1788680000000,
      status: 'partial',
      rows: [{ id: 'F8-M1', barMark: 'F8-M1', totalWeightKg: 537.04 }],
      manifest: { buildId: 'e0d1…-uuid', builtAt: 1788680000000, factIds: ['F8.length'] },
      ...over,
    });

  it('ignores the result id, the timestamps and the nested build id', () => {
    const a = result();
    const b = result({
      id: 'orchestrated-1788690000000',
      builtAt: 1788690000000,
      manifest: { buildId: 'ffff…-other', builtAt: 1788690000000, factIds: ['F8.length'] },
    });
    expect(a).not.toBe(b);
    expect(artifactFingerprint(a, 'application/json')).toBe(artifactFingerprint(b, 'application/json'));
  });

  it('does NOT ignore a row id — a bar mark means something', () => {
    const a = result();
    const b = result({ rows: [{ id: 'F8-M2', barMark: 'F8-M2', totalWeightKg: 537.04 }] });
    expect(artifactFingerprint(a, 'application/json')).not.toBe(artifactFingerprint(b, 'application/json'));
  });

  it('does NOT ignore a real change to the schedule', () => {
    const a = result();
    const b = result({ rows: [{ id: 'F8-M1', barMark: 'F8-M1', totalWeightKg: 611.9 }] });
    expect(artifactFingerprint(a, 'application/json')).not.toBe(artifactFingerprint(b, 'application/json'));
  });

  it('compares CSV as it stands — it has no volatile fields to strip', () => {
    const csv = ['Mark,Weight', 'F8-M1,537.04'].join('\n');
    expect(artifactFingerprint(csv, 'text/csv')).toBe(csv);
  });

  it('falls back to the text when the payload is not JSON at all', () => {
    expect(artifactFingerprint('not json {', 'application/json')).toBe('not json {');
  });
});
