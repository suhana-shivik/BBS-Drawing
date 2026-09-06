// The register's answer to "we already have this drawing".
//
// Two different questions hide behind one gesture. Dropping in the SAME file
// again is not a revision — it must leave one row, not two. Dropping in a NEW
// revision of the same drawing number IS a version, and the chain has to say
// which sheet is in force and where every other one sits in the sequence. A
// different drawing number is a different drawing and must never be pulled
// into either.

import { describe, expect, it } from 'vitest';
import { reconcileRevisionStates } from '../../src/register/register';
import { contentHash } from '../../src/register/contentHash';
import type { DrawingRegisterEntry } from '../../src/register/types';

const entry = (
  id: string,
  over: Partial<DrawingRegisterEntry> = {},
): DrawingRegisterEntry => ({
  id,
  projectId: 'prj_1',
  documentId: `doc_${id}`,
  assetId: `ast_${id}`,
  originalFileName: 'Foundations drawings.dxf',
  displayName: 'PCD-IND-B300-S-803 · R0',
  drawingNumber: 'PCD-IND-B300-S-803',
  identityKey: 'PCDINDB300S803',
  title: 'FOUNDATION LAYOUT PLAN',
  revision: 'R0',
  revisionRank: 0,
  issueDate: '',
  discipline: 'structural',
  health: 'ready',
  revisionState: 'review',
  versionNo: 1,
  versionCount: 1,
  importedAt: 1000,
  warnings: [],
  evidence: {},
  ...over,
});

describe('version numbering', () => {
  const chain = reconcileRevisionStates([
    entry('a', { revision: 'R0', revisionRank: 0, importedAt: 100 }),
    entry('b', { revision: 'R1', revisionRank: 100, importedAt: 200 }),
    entry('c', { revision: 'R2', revisionRank: 200, importedAt: 300 }),
  ]);
  const byId = (id: string) => chain.find((e) => e.id === id)!;

  it('numbers a chain in the same order it decides what is current', () => {
    expect([byId('a').versionNo, byId('b').versionNo, byId('c').versionNo]).toEqual([1, 2, 3]);
    expect(chain.every((e) => e.versionCount === 3)).toBe(true);
    expect(byId('c').revisionState).toBe('current');
  });

  it('points each superseded sheet at the one that replaced it, not at the head', () => {
    expect(byId('a').supersededById).toBe('b');
    expect(byId('b').supersededById).toBe('c');
    expect(byId('c').supersededById).toBeUndefined();
  });

  it('leaves a drawing held once as v1 of 1', () => {
    const [only] = reconcileRevisionStates([entry('solo')]);
    expect([only.versionNo, only.versionCount]).toEqual([1, 1]);
  });

  it('never pulls a different drawing number into the chain', () => {
    const rows = reconcileRevisionStates([
      entry('a', { revision: 'R0', revisionRank: 0 }),
      entry('other', {
        drawingNumber: 'PCD-IND-B300-S-804',
        identityKey: 'PCDINDB300S804',
        revision: 'R0',
        revisionRank: 0,
      }),
    ]);
    expect(rows.every((r) => r.versionCount === 1)).toBe(true);
    expect(rows.every((r) => r.revisionState === 'current')).toBe(true);
    expect(rows.every((r) => r.supersededById === undefined)).toBe(true);
  });

  it('will not let a sheet in review supersede a confirmed revision', () => {
    // Arrived last, but its revision was never read. It is not the newest
    // version of anything — it is a sheet nobody has identified yet.
    const rows = reconcileRevisionStates([
      entry('r1', { revision: 'R1', revisionRank: 100, importedAt: 200 }),
      entry('unread', { revision: '', revisionRank: null, health: 'review', importedAt: 300 }),
    ]);
    const seen = (id: string) => rows.find((r) => r.id === id)!;
    expect(seen('r1').revisionState).toBe('current');
    expect(seen('unread').revisionState).toBe('review');
    // Neither carries a version number: one is alone in its chain, the other
    // is in no chain at all.
    expect(seen('r1').versionCount).toBe(1);
    expect(seen('unread').versionCount).toBe(1);
  });

  it('reports the newest version first, as the register lists it', () => {
    expect(chain.map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('content hash', () => {
  it('is stable for identical text and different for a changed sheet', () => {
    const dxf = '0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0.0\n20\n0.0\n';
    expect(contentHash(dxf)).toBe(contentHash(`${dxf}`));
    expect(contentHash(dxf)).not.toBe(contentHash(dxf.replace('0.0', '1.0')));
  });

  it('separates texts a single-lane hash would collide on', () => {
    // Same characters, different order and different length — the two cases a
    // length-only or sum-only fingerprint would wave through.
    expect(contentHash('AB')).not.toBe(contentHash('BA'));
    expect(contentHash('A')).not.toBe(contentHash('AA'));
  });
});
