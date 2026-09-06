// @ts-nocheck -- Vitest runs this regression in Node; the browser app does not
// include @types/node in its production TypeScript surface.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDXF } from '../../src/cad/dxf/parse';
import { extractDrawing } from '../../src/cad/bbs/extract';

/**
 * The GAMCO boundary wall sheet — the drawing that defeated the extractor.
 *
 * A typical-detail sheet for a LINEAR structure: no schedule table, members
 * declared by name+size, cover as a table, bar rules in the notes, and the
 * ground step in the filename. BBS_PLAN.md §7 step 1 is done when everything
 * asserted here holds.
 */
const DXF = join(
  process.cwd(),
  'drawing example/BBS/BBS',
  'GAMCO - BOUNDARY WALL DETAILS - LEVEL DIFFERENCE 900MM - 07.07.2026.dxf',
);

const have = existsSync(DXF);
const extract = () =>
  extractDrawing(
    parseDXF(readFileSync(DXF, 'utf8'), 'GAMCO - BOUNDARY WALL DETAILS - LEVEL DIFFERENCE 900MM - 07.07.2026.dxf'),
  );

describe.skipIf(!have)('GAMCO boundary wall — extraction', () => {
  it('finds the marks the old grammar missed: SC and TB beside C1/C2/F1', () => {
    expect(extract().marks).toEqual(expect.arrayContaining(['SC', 'TB', 'C1', 'C2', 'F1']));
  });

  it('declares every member kind the sheet draws', () => {
    const names = new Set(extract().declared.map((d) => d.name));
    expect(names).toContain('RCC WALL');
    expect(names).toContain('TB');
    expect(names).toContain('H-POLE');
    expect(names).toContain('SC');
    expect(names).toContain('C1');
    expect(names).toContain('C2');
    // the sheet's own spelling is kept, typo and all — never re-spelled
    expect([...names].some((n) => /PANEL/.test(n))).toBe(true);
  });

  it('ties the right size to the right member', () => {
    const by = (name: string) => extract().declared.find((d) => d.name === name);
    expect(by('RCC WALL')?.dimsMm).toEqual([200]);
    expect(by('TB')?.dimsMm).toEqual([350, 400]);
    expect(by('H-POLE')?.dimsMm).toEqual([150, 150, 2400]);
    expect(by('C1')?.dimsMm).toEqual([350, 350]);
  });

  it('suppresses the junk table of clustered layout tags', () => {
    // eleven TB-(350X400) labels clustered into a fake schedule and reached
    // the model as a table saying something false
    expect(extract().tables).toHaveLength(0);
  });

  it('reads the cover TABLE and refuses to fake a single cover from it', () => {
    const ex = extract();
    const covers = Object.fromEntries(
      (ex.notes.coverByMember ?? []).map((c) => [c.member, c.coversMm[0]]),
    );
    expect(covers['FOUNDATION BEAM & SLAB']).toBe(50);
    expect(covers['COLUMN']).toBe(40);
    expect(covers['TIE BEAM.']).toBe(30);
    expect(covers['FLOOR SLAB.']).toBe(20);
    expect(ex.notes.coverMm).toBeUndefined();
  });

  it('turns the legislating notes into rules', () => {
    const rules = extract().notes.globalRules ?? [];
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'distribution', diaMm: 8, spacingMm: 250 }),
        expect.objectContaining({ kind: 'spacer', diaMm: 25, spacingMm: 300 }),
        expect.objectContaining({ kind: 'chairs', diaMm: 10 }),
        expect.objectContaining({ kind: 'lap', multiple: 50 }),
      ]),
    );
  });

  it('surfaces the filename facts — the 900 mm step lives nowhere else', () => {
    expect(extract().notes.notes[0]).toMatch(/LEVEL DIFFERENCE 900MM/);
  });

  it('still reads grades from the notes', () => {
    const ex = extract();
    expect(ex.notes.concreteGrade).toBe('M25');
    expect(ex.notes.steelGrade).toBe('Fe500');
  });
});
