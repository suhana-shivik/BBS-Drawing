// identityFromPdfTexts over synthetic text runs shaped like real Indian title
// blocks. Coordinates are page points, y-up — bottom-right of an A1 landscape
// sheet (2384 x 1684 pt) is around (2384, 0).
import { describe, expect, it } from 'vitest';
import { identityFromPdfTexts } from '../../src/cad/pdf/identity';
import type { PdfTextRun } from '../../src/cad/pdf/types';

const run = (text: string, x: number, y: number, height = 10): PdfTextRun => ({
  text,
  x,
  y,
  height,
});

// Body noise spread over the sheet so corner scoring has real bounds.
const noise: PdfTextRun[] = [
  run('FOOTING F1', 300, 1400),
  run('8-16 DIA', 350, 1350),
  run('SECTION A-A', 900, 800),
  run('150 THK PCC', 940, 760),
  run('NOTES:', 60, 1600),
  run('ALL DIMENSIONS IN MM', 60, 1560),
];

describe('identityFromPdfTexts', () => {
  it('reads an inline title block at the bottom-right', () => {
    const texts = [
      ...noise,
      run('DWG NO. GAMCO-STR-001', 2050, 60),
      run('REV: R2', 2050, 40),
      run('TITLE: FOOTING REINFORCEMENT DETAILS', 2050, 90),
      run('DATE: 12.05.2025', 2050, 20),
    ];
    const id = identityFromPdfTexts(texts, 'scan.pdf');
    expect(id.drawingNumber).toBe('GAMCO-STR-001');
    expect(id.revision).toBe('R2');
    expect(id.title).toBe('FOOTING REINFORCEMENT DETAILS');
    expect(id.date).toBe('12.05.2025');
    expect(id.confidence).toBeGreaterThan(0.85);
    expect(id.evidence.join('\n')).toContain('inline');
  });

  it('finds a value beside or below a bare label', () => {
    const texts = [
      ...noise,
      run('DRAWING NO.', 2100, 100),
      run('GAMCO-STR-002', 2100, 70), // just below the caption
    ];
    const id = identityFromPdfTexts(texts, 'scan.pdf');
    expect(id.drawingNumber).toBe('GAMCO-STR-002');
  });

  it('never reads another field caption as a value', () => {
    const texts = [
      ...noise,
      run('TITLE', 2000, 150),
      run('REVISION :', 2060, 150), // adjacent caption — must be rejected
      run('PLINTH BEAM LAYOUT', 2000, 120),
    ];
    const id = identityFromPdfTexts(texts, 'scan.pdf');
    expect(id.title).toBe('PLINTH BEAM LAYOUT');
  });

  it('prefers the bottom-right cluster over top-left for bare number shapes', () => {
    const texts = [
      ...noise,
      run('AAA-STR-999', 30, 1600), // referenced drawing listed top-left
      run('GAMCO-STR-001', 2300, 40), // title block bottom-right
    ];
    const id = identityFromPdfTexts(texts, 'scan_0001.pdf');
    expect(id.drawingNumber).toBe('GAMCO-STR-001');
    expect(id.evidence.join('\n')).toContain('shape match');
  });

  it('falls back to the filename when the sheet text says nothing', () => {
    const id = identityFromPdfTexts([], 'GAMCO-STR-001_FOOTING LAYOUT PLAN R2.pdf');
    expect(id.drawingNumber).toBe('GAMCO-STR-001');
    expect(id.revision).toBe('R2');
    expect(id.title).toContain('FOOTING LAYOUT PLAN');
    expect(id.evidence.join('\n')).toContain('filename');
  });

  it('lets a conventional filename value beat a proximity guess', () => {
    // A stray "S" beside the REV caption is a guess; the filename ends R0.
    const texts = [...noise, run('REV', 2200, 100), run('S', 2240, 100)];
    const id = identityFromPdfTexts(texts, 'GAMCO-STR-004 PLINTH BEAM R0.pdf');
    expect(id.revision).toBe('R0');
    expect(id.drawingNumber).toBe('GAMCO-STR-004');
  });

  it('lets an inline read beat the filename', () => {
    const texts = [...noise, run('REV: R3', 2200, 100)];
    const id = identityFromPdfTexts(texts, 'GAMCO-STR-004 PLINTH BEAM R0.pdf');
    expect(id.revision).toBe('R3');
  });

  it('reports what it could not find, with bounded confidence', () => {
    const id = identityFromPdfTexts([], 'scan.pdf');
    expect(id.drawingNumber).toBeUndefined();
    expect(id.revision).toBeUndefined();
    expect(id.date).toBeUndefined();
    expect(id.evidence).toContain('drawingNumber: not found');
    expect(id.confidence).toBeGreaterThanOrEqual(0);
    expect(id.confidence).toBeLessThanOrEqual(1);
  });
});
