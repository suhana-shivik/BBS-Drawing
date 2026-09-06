// The .md and the structured memory must never disagree.
//
// The specification file is what a checker takes off-site, and the whole value
// of it is that it says exactly what the app says. Two things could break that,
// and both are pinned here:
//
//   the FILE re-wording the record it was made from — a second version of the
//   truth that drifts the moment either changes
//
//   the SECTION NOTE being model prose rather than a rendering of the section's
//   own structured fields, so the sentence and the data behind it could differ
//
// Neither is a hypothetical worry: the note is the established reading of a
// drawing, and a record that has been tidied is a different document.

import { describe, expect, it } from 'vitest';
import { buildAboutDrawingMemory } from '../../src/cad/bbs/about';
import { specFileName, specificationMarkdown } from '../../src/studio/exportSpec';
import type { DrawingUnderstandingPackage } from '../../src/cad/understanding/types';

const section = (over: Record<string, unknown> = {}) => ({
  sectionId: 'REGION-01',
  label: 'PLAN - PEDESTAL P1',
  kind: 'plan',
  bounds: { xMin: 50, yMin: 4300, xMax: 2300, yMax: 5700 },
  memberHints: [{ mark: 'P1', basis: 'title text' }],
  calloutHints: ['20-DIA 16 VERTICAL BARS'],
  entityIds: [],
  ...over,
});

const pkg = (sections: unknown[]): DrawingUnderstandingPackage =>
  ({
    documentId: 'doc_1',
    sourceDrawingHash: 'doc:abc',
    sections,
    coverage: { measurableEntities: 10, coveredEntities: 10, uncoveredEntities: 0, gaps: [] },
  }) as unknown as DrawingUnderstandingPackage;

const memoryOf = (sections: unknown[]) =>
  buildAboutDrawingMemory({
    documentId: 'doc_1',
    drawingName: 'pedestal_bbs_detail_large',
    sourceDrawingHash: 'doc:abc',
    pkg: pkg(sections),
    updatedAt: Date.parse('2026-09-03T11:11:00Z'),
  });

const noteOf = (memory: ReturnType<typeof memoryOf>) => ({
  drawingName: memory.drawingName,
  updatedAt: memory.updatedAt,
  note: memory.note,
  conclusionCount: memory.conclusions.length,
  sectionNotes: memory.sectionNotes.map((s) => ({
    sectionId: s.sectionId,
    label: s.label,
    note: s.note,
  })),
});

describe('the file is the record, not a retelling of it', () => {
  const memory = memoryOf([section(), section({ sectionId: 'REGION-02', label: 'SECTION A-A', kind: 'elevation' })]);
  const md = specificationMarkdown(noteOf(memory), new Date(Date.parse('2026-09-03T11:12:00Z')));

  it('carries every section the memory holds, none dropped', () => {
    expect(md).toContain(`${memory.sectionNotes.length} sections of pedestal_bbs_detail_large.`);
    for (const s of memory.sectionNotes) {
      expect(md).toContain(`## ${s.sectionId} · ${s.label}`);
    }
  });

  it('reproduces each note VERBATIM — no summarising, no re-wording', () => {
    for (const s of memory.sectionNotes) {
      expect(md).toContain(s.note.trim());
    }
    expect(md).toContain(memory.note.trim());
  });

  it('states the same conclusion count the memory holds', () => {
    expect(md).toContain(`**Validated conclusions:** ${memory.conclusions.length}`);
  });

  it('names the same drawing the memory was built for', () => {
    expect(md).toContain('# Specification — pedestal_bbs_detail_large');
    expect(specFileName(memory.drawingName)).toBe('pedestal_bbs_detail_large-specification.md');
  });
});

describe('a section note is a rendering of the section, not prose about it', () => {
  it('says what the structured record says — id, kind, bounds, hints', () => {
    const [note] = memoryOf([section()]).sectionNotes;
    expect(note.note).toContain('REGION-01 — PLAN - PEDESTAL P1 [plan]');
    expect(note.note).toContain('bounds: x 50..2300, y 4300..5700 mm');
    expect(note.note).toContain('P1 (title text)');
    expect(note.note).toContain('20-DIA 16 VERTICAL BARS');
  });

  it('changes when the structured record changes — the two cannot drift apart', () => {
    const before = memoryOf([section()]).sectionNotes[0].note;
    const afterNote = memoryOf([
      section({ calloutHints: ['DIA 10 CLOSED TIES'], memberHints: [{ mark: 'P2', basis: 'tag' }] }),
    ]).sectionNotes[0].note;
    expect(afterNote).not.toBe(before);
    expect(afterNote).toContain('DIA 10 CLOSED TIES');
    expect(afterNote).toContain('P2 (tag)');
  });

  it('records honestly when a section carries nothing, rather than inventing a sentence', () => {
    const [note] = memoryOf([section({ memberHints: [], calloutHints: [] })]).sectionNotes;
    expect(note.note).toContain('member labels seen: none recorded');
    expect(note.note).toContain('callouts seen: none recorded');
  });
});
