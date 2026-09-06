// Where an imported PDF page is filed.
//
// Every PDF used to land in General — the projection pinned it there, and the
// entry carried no discipline at all. So a foundation PDF sat in General while
// its own DXF sat in Structural, and importing while standing in Structural
// changed nothing. These pin the classifier half of the fix; the "lands where
// you are standing" half is the import path's, and it simply beats this.

import { describe, expect, it } from 'vitest';
import { inferDiscipline } from '../../src/register/titleBlock';

describe('a PDF page is read like a title block, not defaulted to General', () => {
  it('reads the discipline out of a drawing number', () => {
    // The same rule a DXF gets: the number's own discipline segment.
    expect(inferDiscipline('PCD-IND-B300-S-803-R0 Foundations drawings.pdf', '')).toBe('structural');
  });

  it('falls back to what the sheet says when the number is silent', () => {
    expect(inferDiscipline('scan-0001.pdf', 'FOOTING REINFORCEMENT DETAIL RCC')).toBe('structural');
    expect(inferDiscipline('scan-0002.pdf', 'EXTERNAL LIGHTING LAYOUT — CABLE SCHEDULE')).toBe('mep');
  });

  it('still says general when nothing in the page says otherwise', () => {
    expect(inferDiscipline('scan-0003.pdf', 'COVER SHEET')).toBe('general');
  });
});
