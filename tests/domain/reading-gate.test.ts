// THE GATE BETWEEN READING A DRAWING AND SCHEDULING FROM IT.
//
// Splitting, the second-pass residual read and section validation all existed.
// All three were optional actions sitting beside a Calculate BBS button that
// consulted none of them, so a schedule could be built over a drawing whose
// sections had never been cut, or one with a fifth of its geometry outside
// every section box that nobody had ever looked at.
//
// That is not a cosmetic gap. Steel no section carries is steel the schedule
// cannot see, and a total that quietly omits it looks exactly like a correct
// one — smaller, arithmetically consistent, and wrong in the direction that
// under-orders.

import { describe, expect, it } from 'vitest';
import { drawingReadiness } from '../../src/cad/understanding/readiness';
import type { DrawingUnderstandingPackage } from '../../src/cad/understanding/types';

const HASH = 'doc:abc123';

const pkg = (over: Record<string, unknown> = {}): DrawingUnderstandingPackage =>
  ({
    documentId: 'doc_1',
    sourceDrawingHash: HASH,
    sections: [{ sectionId: 'REGION-01' }],
    coverage: { measurableEntities: 100, coveredEntities: 100, uncoveredEntities: 0, gaps: [] },
    ...over,
  }) as unknown as DrawingUnderstandingPackage;

const gap = (layer: string, count: number, sampleText: string[] = []) => ({
  layer,
  count,
  sampleHandles: [],
  sampleText,
  bounds: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
});

const residual = (gapId: string, status: 'read' | 'unread' | 'failed', over = {}) => ({
  gapId,
  status,
  entityCount: 12,
  linkedTo: null,
  reading: null,
  bounds: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
  entityTypes: [],
  layers: [],
  text: [],
  ...over,
});

// ------------------------------------------------------------
// 1 + 12 — an unread drawing cannot be scheduled
// ------------------------------------------------------------

describe('a drawing that has not been read', () => {
  it('blocks a schedule when it has never been split', () => {
    const r = drawingReadiness({ pkg: null, currentHash: HASH });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('unsplit');
    expect(r.remedy).toBe('split');
  });

  it('blocks while a split or second pass is still running, and says to wait', () => {
    for (const jobStatus of ['queued', 'splitting'] as const) {
      const r = drawingReadiness({ pkg: pkg(), jobStatus, currentHash: HASH });
      expect(r.ok).toBe(false);
      expect(r.state).toBe('working');
      expect(r.remedy).toBe('wait');
    }
  });

  it('allows a schedule only once every part has been read', () => {
    const r = drawingReadiness({ pkg: pkg(), jobStatus: 'split', currentHash: HASH });
    expect(r).toMatchObject({ ok: true, state: 'ready', remedy: null, unread: [] });
  });
});

// ------------------------------------------------------------
// 2 — unread geometry triggers the re-read, and names it
// ------------------------------------------------------------

describe('geometry outside every section', () => {
  const uncovered = pkg({
    coverage: {
      measurableEntities: 500,
      coveredEntities: 382,
      uncoveredEntities: 118,
      gaps: [gap('RBAR', 96, ['12-DIA 20 THRU', 'TYP']), gap('TEXT', 22)],
    },
  });

  it('blocks the schedule and asks for the second pass', () => {
    const r = drawingReadiness({ pkg: uncovered, jobStatus: 'split', currentHash: HASH });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('unread');
    expect(r.remedy).toBe('second-pass');
  });

  it('names where to look, not just how much — a count is not actionable', () => {
    const r = drawingReadiness({ pkg: uncovered, jobStatus: 'split', currentHash: HASH });
    expect(r.unread[0]).toContain('layer RBAR');
    expect(r.unread[0]).toContain('12-DIA 20 THRU');
    expect(r.reason).toContain('118');
  });
});

// ------------------------------------------------------------
// 3 + 4 — what the second pass settles, and what it does not
// ------------------------------------------------------------

describe('after the second pass has run', () => {
  it('a successful read releases the gate', () => {
    const r = drawingReadiness({
      pkg: pkg({
        coverage: { measurableEntities: 500, coveredEntities: 382, uncoveredEntities: 118, gaps: [gap('RBAR', 118)] },
        residuals: [residual('GAP-01', 'read'), residual('GAP-02', 'read')],
      }),
      jobStatus: 'split',
      currentHash: HASH,
    });
    expect(r.ok).toBe(true);
  });

  it('a failed read keeps it shut, and says which piece', () => {
    const r = drawingReadiness({
      pkg: pkg({
        coverage: { measurableEntities: 500, coveredEntities: 382, uncoveredEntities: 118, gaps: [gap('RBAR', 118)] },
        residuals: [
          residual('GAP-01', 'read'),
          residual('GAP-02', 'unread', { entityCount: 96, note: 'no legible text' }),
          residual('GAP-03', 'failed', { linkedTo: 'REGION-02' }),
        ],
      }),
      jobStatus: 'split',
      currentHash: HASH,
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('unreadable');
    expect(r.unread).toHaveLength(2);
    expect(r.unread[0]).toContain('GAP-02');
    expect(r.unread[0]).toContain('96 entities');
    expect(r.unread[0]).toContain('no legible text');
    expect(r.unread[1]).toContain('near REGION-02');
    // and it must not quietly assume the unread piece carries nothing
    expect(r.reason).toMatch(/[Nn]othing has been assumed/);
  });
});

// ------------------------------------------------------------
// 10 — source integrity
// ------------------------------------------------------------

describe('a reading taken from a different version of the drawing', () => {
  it('cannot silently drive a calculation', () => {
    const r = drawingReadiness({ pkg: pkg(), jobStatus: 'split', currentHash: 'doc:different' });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('stale');
    expect(r.remedy).toBe('split');
    expect(r.reason).toMatch(/different version/);
  });

  it('outranks an unread gap — a stale box measures geometry that may be gone', () => {
    const r = drawingReadiness({
      pkg: pkg({
        coverage: { measurableEntities: 500, coveredEntities: 100, uncoveredEntities: 400, gaps: [gap('RBAR', 400)] },
      }),
      jobStatus: 'split',
      currentHash: 'doc:different',
    });
    expect(r.state).toBe('stale');
  });

  it('says nothing about staleness when the current hash is not known', () => {
    // The gate reports what it can check. Inventing a staleness verdict from a
    // hash nobody supplied would block every drawing on a missing input.
    expect(drawingReadiness({ pkg: pkg(), jobStatus: 'split' }).ok).toBe(true);
  });
});
