// THE SPECIFICATION AS A FILE, AND WHY IT IS A CONCATENATION.
//
// What is on screen is already Markdown — the drawing note and every section
// note are written that way and rendered verbatim. So the export does not
// re-render anything into a new format; it joins what is already the record.
//
// That is not laziness. The note is the ESTABLISHED READING of a drawing, and
// a checker holding the file has to be able to trust it says exactly what the
// app says. Reformatting it here would create a second version of the truth
// that drifts from the first the moment either changes.
import { describe, expect, it } from 'vitest';
import {
  specFileName,
  specificationMarkdown,
  type AboutDrawingNote,
} from '../../src/studio/exportSpec';

const about = (over: Partial<AboutDrawingNote> = {}): AboutDrawingNote => ({
  drawingName: 'BBS-TEST-columns',
  updatedAt: Date.UTC(2026, 8, 3, 5, 35),
  conclusionCount: 13,
  note: '# What this drawing says — BBS-TEST-columns\n\n## The job\n\n- **run** — 4000 mm',
  sectionNotes: [
    { sectionId: 'REGION-01', label: 'COLUMN SCHEDULE', note: 'The schedule lists C1.' },
    { sectionId: 'REGION-02', label: 'TYPICAL COLUMN DETAIL', note: '8-16 main bars.' },
  ],
  ...over,
});

describe('the exported specification', () => {
  it('carries the drawing note VERBATIM', () => {
    // Not summarised, not re-wrapped, not re-headed. The file has to be able
    // to be diffed against the screen.
    const md = specificationMarkdown(about());
    expect(md).toContain('# What this drawing says — BBS-TEST-columns');
    expect(md).toContain('- **run** — 4000 mm');
  });

  it('includes EVERY section note, unfolded', () => {
    // The panel keeps these behind a disclosure each, which is right for
    // reading on screen and wrong for a file: whoever downloads it is taking
    // it somewhere the folds do not exist.
    const md = specificationMarkdown(about());
    expect(md).toContain('## REGION-01 · COLUMN SCHEDULE');
    expect(md).toContain('The schedule lists C1.');
    expect(md).toContain('## REGION-02 · TYPICAL COLUMN DETAIL');
    expect(md).toContain('8-16 main bars.');
  });

  it('says how many sections it contains, so the file can be checked', () => {
    // A specification missing a section is worse than one that never claimed
    // to have it.
    expect(specificationMarkdown(about())).toContain('2 sections of BBS-TEST-columns.');
    expect(specificationMarkdown(about({ sectionNotes: [] }))).not.toContain('Section notes');
  });

  it('names the drawing, the conclusion count and both dates', () => {
    const md = specificationMarkdown(about(), new Date(Date.UTC(2026, 8, 3, 6, 0)));
    expect(md).toContain('# Specification — BBS-TEST-columns');
    expect(md).toContain('**Validated conclusions:** 13');
    expect(md).toContain('**Note updated:**');
    expect(md).toContain('**Exported:**');
  });

  it('says so when a section has no note, rather than leaving a blank', () => {
    const md = specificationMarkdown(
      about({ sectionNotes: [{ sectionId: 'REGION-09', label: 'GRID', note: '   ' }] }),
    );
    expect(md).toContain('_No note was established for this section._');
  });
});

describe('the filename', () => {
  it('drops a CAD extension instead of turning it into a word', () => {
    // "BBS-TEST-columns.dxf" must not become "BBS-TEST-columns_dxf-…".
    expect(specFileName('BBS-TEST-columns.dxf')).toBe('BBS-TEST-columns-specification.md');
    expect(specFileName('Foundations drawings.DWG')).toBe('Foundations-drawings-specification.md');
  });

  it('survives a name a file manager would refuse', () => {
    expect(specFileName('GAMCO / STR-001 (R2)')).toBe('GAMCO-STR-001-R2-specification.md');
    expect(specFileName('')).toBe('drawing-specification.md');
    expect(specFileName('///')).toBe('drawing-specification.md');
  });
});
