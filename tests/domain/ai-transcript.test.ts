// The Ask conversation must survive leaving the tab.
//
// It did not. `Assistant.tsx` renders the panel as `tab === 'chat' &&
// <DrawingAI/>`, so a visit to Quantities or BBS unmounted it and took the
// whole conversation with it — and collapsing the workbench routes through
// Overview, so the loss happened on the most ordinary navigation there is. A
// BBS interview conducted over ten minutes of questions and answers vanished
// on one click with no way back.
//
// A transcript is not a cache: if it is missing it is gone, not recomputed.
// These tests pin the store's contract — per drawing, trimmed, quota-safe.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTranscript,
  loadTranscript,
  saveTranscript,
  type ChatEntry,
} from '../../src/cad/ai/transcript';
import type { CadDocument } from '../../src/cad/types';

function doc(sourceFile: string, name = 'Sheet'): CadDocument {
  return {
    id: sourceFile,
    name,
    sourceFile,
    unitScale: 1,
    layers: new Map(),
    linetypes: new Map(),
    textStyles: new Map(),
    blocks: new Map(),
    entities: [],
    layouts: [],
    regions: [],
    diagnostics: [],
    extents: null,
  };
}

const say = (role: 'user' | 'assistant', content: string): ChatEntry => ({
  turn: { role, content },
});

describe('the chat transcript', () => {
  beforeEach(() => localStorage.clear());

  it('comes back after the panel is unmounted and remounted', () => {
    const a = doc('S-101.dxf');
    saveTranscript(a, [say('user', 'Create the BBS'), say('assistant', 'How long is the wall?')]);

    // a remount reads it straight back — this is the whole point
    const back = loadTranscript(a);
    expect(back).toHaveLength(2);
    expect(back[1].turn.content).toBe('How long is the wall?');
  });

  it('keeps each drawing’s conversation to itself', () => {
    saveTranscript(doc('S-101.dxf'), [say('user', 'about the footings')]);
    saveTranscript(doc('E-201.dxf'), [say('user', 'about the panel board')]);

    expect(loadTranscript(doc('S-101.dxf'))[0].turn.content).toBe('about the footings');
    expect(loadTranscript(doc('E-201.dxf'))[0].turn.content).toBe('about the panel board');
  });

  it('is empty for a drawing never spoken about, and for no drawing at all', () => {
    expect(loadTranscript(doc('never-opened.dxf'))).toEqual([]);
    expect(loadTranscript(null)).toEqual([]);
  });

  it('clears on request', () => {
    const a = doc('S-101.dxf');
    saveTranscript(a, [say('user', 'hello')]);
    clearTranscript(a);
    expect(loadTranscript(a)).toEqual([]);
  });

  it('trims a runaway conversation rather than growing without bound', () => {
    const a = doc('S-101.dxf');
    saveTranscript(
      a,
      Array.from({ length: 400 }, (_, i) => say('user', `turn ${i}`)),
    );
    const back = loadTranscript(a);
    expect(back.length).toBeLessThanOrEqual(120);
    // the RECENT end is what is kept — a conversation is read from the bottom
    expect(back[back.length - 1].turn.content).toBe('turn 399');
  });

  it('never lets a full quota break the turn that is happening', () => {
    const a = doc('S-101.dxf');
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    // losing the ability to come back to a conversation is bad; throwing in
    // the middle of one is far worse
    expect(() => saveTranscript(a, [say('user', 'hello')])).not.toThrow();
    setItem.mockRestore();
  });

  it('survives a corrupt store instead of throwing', () => {
    localStorage.setItem('bimcad.ai.transcript', '{ not json');
    expect(loadTranscript(doc('S-101.dxf'))).toEqual([]);
  });
});
