import { describe, expect, it } from 'vitest';
import {
  aboutDrawingBriefing,
  buildAboutDrawingMemory,
  parseAboutDrawingMemory,
} from '../../src/cad/bbs/about';

describe('About Drawing memory', () => {
  it('stores evidence conclusions and deterministic per-section notes', () => {
    const conclusion = {
      kind: 'own', calloutId: 'CALL-001', memberId: 'MEM-01',
      basis: 'in-detail', evidenceIds: ['CALL-001', 'REGION-01'],
    };
    const memory = buildAboutDrawingMemory({
      documentId: 'doc-1',
      drawingName: 'wall.dxf',
      sourceDrawingHash: 'doc:abc',
      updatedAt: 10,
      outcome: {
        acceptedConclusions: [conclusion],
        understanding: 'a boundary wall reinforcement sheet',
        note: 'MEM-01 owns CALL-001 from REGION-01',
        unresolved: [],
        escalations: [],
      } as never,
      pkg: {
        sections: [{
          sectionId: 'REGION-01', label: 'WALL DETAIL', kind: 'detail',
          bounds: { xMin: 1, yMin: 2, xMax: 3, yMax: 4 },
          memberHints: [{ mark: 'W1', basis: 'printed label' }],
          calloutHints: ['T10@200'],
        }],
      } as never,
    });
    expect(memory.conclusions).toEqual([conclusion]);
    expect(memory.sectionNotes[0].conclusionIndexes).toEqual([0]);
    expect(memory.sectionNotes[0].note).toContain('T10@200');
    expect(aboutDrawingBriefing(memory)).toContain('SAVED, CURRENT READING');
    expect(parseAboutDrawingMemory(JSON.stringify(memory))).toEqual(memory);
  });

  it('refuses malformed or versionless memory', () => {
    expect(parseAboutDrawingMemory('{}')).toBeNull();
    expect(parseAboutDrawingMemory('not json')).toBeNull();
  });
});
