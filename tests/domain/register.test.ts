import { describe, expect, it } from 'vitest';
import { reconcileRevisionStates } from '../../src/register/register';
import type { DrawingRegisterEntry } from '../../src/register/types';

const entry = (id: string, revision: string, rank: number | null, health: DrawingRegisterEntry['health'] = 'ready'): DrawingRegisterEntry => ({
  id, projectId: 'p', documentId: `doc-${id}`, assetId: `asset-${id}`,
  originalFileName: `${id}.dwg`, displayName: `S-101 · ${revision}`,
  drawingNumber: 'S-101', identityKey: 'S101', title: 'Foundation layout',
  revision, revisionRank: rank, issueDate: '', discipline: 'structural',
  health, revisionState: 'review', versionNo: 1, versionCount: 1,
  importedAt: rank ?? 99, warnings: [], evidence: {},
});

describe('drawing revision chain', () => {
  it('marks the highest trusted revision current without deleting history', () => {
    const rows = reconcileRevisionStates([entry('r0', 'R0', 0), entry('r7', 'R7', 700)]);
    expect(rows.find((r) => r.id === 'r0')?.revisionState).toBe('superseded');
    expect(rows.find((r) => r.id === 'r7')?.revisionState).toBe('current');
    expect(rows).toHaveLength(2);
  });

  it('keeps incomplete identity in review instead of silently declaring it current', () => {
    const row = { ...entry('unknown', '', null, 'review'), drawingNumber: '' };
    expect(reconcileRevisionStates([row])[0].revisionState).toBe('review');
  });
});
