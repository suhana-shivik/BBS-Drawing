// The drawing reader's schedule-table facts: "F8 | 3200 | 3500 | 575" under
// "W SIZE | L | DEPTH D" is F8.width / F8.length / F8.height, DRAWING_READ,
// with the table, row and column as its source — and a callout sitting in a
// cell headed "a(LONG BAR)" runs along L.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  axisOfHeader,
  barCellOf,
  distributionAxisFor,
  memberFactsFromTables,
  tableCellsForCallouts,
  tableDimsByMark,
} from '../../src/cad/bbs/tableFacts';
import { parseDXF } from '../../src/cad/dxf/parse';
import { extractDrawing } from '../../src/cad/bbs/extract';
import type { DrawingExtract, ExtractedTable } from '../../src/cad/bbs/types';

const FOOTING_TABLE: ExtractedTable = {
  title: 'FOOTING SCHEDULE :',
  header: [
    'FOOT. MKD.',
    'W SIZE',
    'L',
    'DEPTH D',
    'a(LONG BAR)',
    'BOTTOM REINFORCEMENT PARALLEL TO b(SHORT BAR)',
    'c(LONG BAR)',
    'd(SHORT BAR)',
    '(MM) X',
    '(MM) Y',
    'REMARKS',
  ],
  rows: [
    ['F3', '3800', '4300', '575', '0 12@100c/c', '0 12@100c/c', '0 10@200c/c', '0 10@200c/c', '100', '100', '-'],
    ['F8', '3200', '3500', '575', '0 10@100c/c', '0 10@100c/c', '-', '-', '100', '100', '-'],
  ],
  min: { x: 0, y: -3000 },
  max: { x: 11000, y: 0 },
  handles: ['T1', 'T2'],
};

const callout = (raw: string, handle: string, x: number, y: number, diaMm: number, spacingMm: number) => ({
  raw,
  handle,
  position: { x, y },
  diaMm,
  spacingMm,
  layer: '0',
});

const extract = (): Pick<DrawingExtract, 'tables' | 'callouts'> => ({
  tables: [FOOTING_TABLE],
  callouts: [
    // row F3 — four bar cells, left to right a, b, c, d
    callout('12@100c/c', 'H1', 4000, -1000, 12, 100),
    callout('12@100c/c', 'H2', 5000, -1000, 12, 100),
    callout('10@200c/c', 'H3', 6000, -1000, 10, 200),
    callout('10@200c/c', 'H4', 7000, -1000, 10, 200),
    // row F8 — two bar cells, the top steel is "-"
    callout('10@100c/c', 'H5', 4000, -2000, 10, 100),
    callout('10@100c/c', 'H6', 5000, -2000, 10, 100),
    // a callout elsewhere on the sheet, outside the table
    callout('10@150c/c', 'H7', 40000, 5000, 10, 150),
  ],
});

describe('schedule-table facts (drawing reader)', () => {
  it('classifies the headers a footing schedule actually prints', () => {
    expect(axisOfHeader('W SIZE')).toBe('W');
    expect(axisOfHeader('L')).toBe('L');
    expect(axisOfHeader('DEPTH D')).toBe('H');
    expect(axisOfHeader('LENGTH (MM)')).toBe('L');
    expect(axisOfHeader('THK')).toBe('H');
    expect(axisOfHeader('a(LONG BAR)')).toBeNull();
    expect(axisOfHeader('REMARKS')).toBeNull();
  });

  it('reads a bar cell with the leading "0" the extractor keeps from the Ø glyph', () => {
    expect(barCellOf('0 10@150c/c')).toEqual({ diaMm: 10, spacingMm: 150 });
    expect(barCellOf('Ø12@100 c/c')).toEqual({ diaMm: 12, spacingMm: 100 });
    expect(barCellOf('-')).toBeNull();
    expect(barCellOf('3200')).toBeNull();
  });

  it('states every member dimension with its table, row and column as the source', () => {
    const facts = memberFactsFromTables(extract());
    const ids = facts.dims.map((d) => `${d.factId}=${d.mm}`);
    expect(ids).toEqual([
      'F3.width=3800',
      'F3.length=4300',
      'F3.height=575',
      'F8.width=3200',
      'F8.length=3500',
      'F8.height=575',
    ]);
    const f8l = facts.dims.find((d) => d.factId === 'F8.length')!;
    expect(f8l.table).toBe('FOOTING SCHEDULE :');
    expect(f8l.column).toBe('L');
    expect(f8l.rowIndex).toBe(1);
    expect(f8l.source).toMatch(/FOOTING SCHEDULE : row F8, column "L" = 3500/);
    expect(facts.notes).toEqual([]);
    const byMark = tableDimsByMark(facts);
    expect(byMark.get('F8')?.W?.mm).toBe(3200);
  });

  it('records X/Y end figures without spending them — their meaning is the sketch\'s', () => {
    const facts = memberFactsFromTables(extract());
    expect(facts.extras.map((e) => `${e.mark}.${e.name}=${e.value}`)).toEqual(['F3.x=100', 'F3.y=100', 'F8.x=100', 'F8.y=100']);
  });

  it('ties every callout inside the table to its cell, and none outside it', () => {
    const facts = memberFactsFromTables(extract());
    const cells = tableCellsForCallouts(extract(), facts);
    expect(cells.size).toBe(6);
    expect(cells.get('H7')).toBeUndefined();
    const h1 = cells.get('H1')!;
    expect(h1.mark).toBe('F3');
    expect(h1.column).toBe('a(LONG BAR)');
    expect(h1.runsAlong).toBe('L');
    expect(distributionAxisFor(h1.runsAlong!)).toBe('W');
    const h2 = cells.get('H2')!;
    expect(h2.runsAlong).toBe('W');
    expect(h2.layer).toBe('BOTTOM');
    const h6 = cells.get('H6')!;
    expect(h6.mark).toBe('F8');
    expect(h6.column).toBe('BOTTOM REINFORCEMENT PARALLEL TO b(SHORT BAR)');
    expect(facts.notes).toEqual([]);
  });

  it('refuses to tie a row whose callouts do not match its cells — and says so', () => {
    const e = extract();
    // drop one F3 callout: three callouts against four cells
    e.callouts = e.callouts.filter((c) => c.handle !== 'H3');
    const facts = memberFactsFromTables(e);
    const cells = tableCellsForCallouts(e, facts);
    expect(cells.size).toBe(0);
    expect(facts.notes.join('\n')).toMatch(/F3: 3 callout\(s\) against 4 bar cell\(s\)/);
  });

  it('yields nothing from a table with no member column, without guessing', () => {
    const facts = memberFactsFromTables({
      tables: [{ title: 'NOTES', header: ['SL', 'TEXT'], rows: [['1', 'ALL DIMENSIONS IN MM']], min: { x: 0, y: 0 }, max: { x: 1, y: 1 }, handles: [] }],
    });
    expect(facts.dims).toEqual([]);
    expect(facts.notes[0]).toMatch(/no column names the member/);
  });
});

const FOUNDATIONS_DXF = 'C:\\Users\\abhis\\Downloads\\Foundations drawings.dxf';

describe.skipIf(!existsSync(FOUNDATIONS_DXF))('the foundations sheet (PCD-IND-B300-S-803-R0), read for real', () => {
  it('states all nine footings from its FOOTING SCHEDULE and ties all 34 callouts', () => {
    const doc = parseDXF(readFileSync(FOUNDATIONS_DXF, 'utf8'), 'Foundations drawings.dxf');
    const e = extractDrawing(doc);
    const facts = memberFactsFromTables(e);
    const byMark = tableDimsByMark(facts);
    expect([...byMark.keys()]).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9']);
    expect(byMark.get('F8')).toMatchObject({ W: { mm: 3200 }, L: { mm: 3500 }, H: { mm: 575 } });
    expect(byMark.get('F3')).toMatchObject({ W: { mm: 3800 }, L: { mm: 4300 }, H: { mm: 575 } });
    const cells = tableCellsForCallouts(e, facts);
    expect(cells.size).toBe(34);
    expect(e.callouts.length).toBe(34);
    expect(facts.notes).toEqual([]);
  });
});
