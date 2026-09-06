// The inputs, listed before the arithmetic spends them.
//
// A finished schedule is very good at hiding what it was built from: every row
// is arithmetically consistent with whatever went in, so a dropped bar count,
// a cover nobody stated and a quantity carried over from an old answer all
// produce a table that looks exactly like a right one. The only place those
// are visible is here, as inputs, each saying where it came from.
//
// The rule the whole thing turns on: MISSING is an origin like any other. A
// fact the schedule does not have is never omitted and never shows a zero —
// it is precisely what a reader is checking for.

import { describe, expect, it } from 'vitest';
import { factSheet, factSheetLines } from '../../src/cad/bbs/factSheet';
import { DEFAULT_SETTINGS } from '../../src/cad/bbs/build';
import type { BbsInterpretation, BbsSettings } from '../../src/cad/bbs/types';

const settings = (over: Partial<BbsSettings> = {}): BbsSettings => ({
  ...DEFAULT_SETTINGS,
  coverSource: 'sheet',
  ...over,
});

/** The pedestal, as the sheet states it: 1000 x 1000 x 1200, 20-Ø16 + Ø10 ties. */
const pedestal = (over: Record<string, unknown> = {}): BbsInterpretation =>
  ({
    members: [
      {
        mark: 'P1',
        type: 'pedestal',
        lengthMm: 1000,
        widthMm: 1000,
        heightMm: 1200,
        count: 1,
        ...(over.member ?? {}),
      },
    ],
    bars: [
      {
        memberMark: 'P1',
        barType: 'MAIN',
        diaMm: 16,
        shapeCode: '00',
        manualCount: 20,
        fromCallout: '20-DIA 16 VERTICAL BARS',
        handles: [],
      },
      {
        memberMark: 'P1',
        barType: 'STIRRUP',
        diaMm: 10,
        shapeCode: '51',
        spacingMm: 150,
        fromCallout: 'DIA 10 CLOSED TIES @150 c/c',
        handles: [],
      },
    ],
    unresolved: [],
    ...(over.top ?? {}),
  }) as unknown as BbsInterpretation;

const find = (sheet: ReturnType<typeof factSheet>, subject: string, field: string) =>
  sheet.lines.find((l) => l.subject === subject && l.field === field)!;

describe('every value says where it came from', () => {
  const sheet = factSheet({ interpretation: pedestal(), settings: settings() });

  it('reads a dimension the sheet dimensions as DRAWING', () => {
    expect(find(sheet, 'P1', 'height')).toMatchObject({ value: '1200', origin: 'DRAWING' });
    expect(find(sheet, 'P1', 'length')).toMatchObject({ value: '1000', origin: 'DRAWING' });
  });

  it('reads a bar count and diameter off the callout, quoting it', () => {
    expect(find(sheet, 'P1-M1', 'diameter')).toMatchObject({
      value: '16',
      origin: 'DRAWING',
      saidAs: '20-DIA 16 VERTICAL BARS',
    });
    expect(find(sheet, 'P1-M1', 'bars_per_member')).toMatchObject({ value: '20', origin: 'DRAWING' });
  });

  it('separates a tie from a main bar and states its spacing and shape', () => {
    expect(find(sheet, 'P1-T1', 'diameter').value).toBe('10');
    expect(find(sheet, 'P1-T1', 'spacing')).toMatchObject({ value: '150', unit: 'mm c/c' });
    expect(find(sheet, 'P1-T1', 'shape').value).toBe('51');
  });

  it('tells a figure a PERSON gave from one the drawing carries', () => {
    const supplied = factSheet({
      interpretation: pedestal(),
      settings: settings(),
      userFacts: { p1_height: { mm: 2500, saidAs: '2500' } },
    });
    // The same member, the same axis — and never the same line, because one is
    // checkable against the sheet and the other is not.
    expect(find(supplied, 'P1', 'height')).toMatchObject({
      value: '2500',
      origin: 'USER INPUT',
      saidAs: '2500',
    });
  });

  it('says where the cutting length is going to come from', () => {
    expect(find(sheet, 'P1-M1', 'cutting_length')).toMatchObject({
      value: null,
      origin: 'DERIVED',
    });
    expect(find(sheet, 'P1-M1', 'cutting_length').saidAs).toMatch(/shape 00/);
  });

  it('lists the Ld basis rather than leaving it implied', () => {
    expect(find(sheet, 'schedule', 'ld')).toMatchObject({ origin: 'DERIVED' });
    expect(find(sheet, 'schedule', 'ld').saidAs).toMatch(/concrete and steel grades/);
    const stated = factSheet({ interpretation: pedestal(), settings: settings({ ldMultiple: 50 }) });
    expect(find(stated, 'schedule', 'ld')).toMatchObject({ value: '50φ', origin: 'DRAWING' });
  });
});

describe('what it refuses to let past', () => {
  it('calls a cover nobody stated a PROJECT DEFAULT, and blocks on it', () => {
    const sheet = factSheet({
      interpretation: pedestal(),
      settings: settings({ coverSource: 'default' }),
    });
    const cover = find(sheet, 'schedule', 'cover');
    expect(cover).toMatchObject({ value: '50', origin: 'PROJECT DEFAULT', blocking: true });
    expect(sheet.ok).toBe(false);
    expect(sheet.open.map((l) => l.label)).toContain('Clear cover');
  });

  it('blocks on a member quantity the drawing does not establish', () => {
    const sheet = factSheet({ interpretation: pedestal(), settings: settings() });
    // count 1 with no rule is not a reading of the sheet — it is what an
    // unplaced member falls to, and a schedule multiplied by it is a schedule
    // for one of something the job may hold fifty of.
    expect(find(sheet, 'P1', 'count')).toMatchObject({ value: null, origin: 'MISSING', blocking: true });
    expect(sheet.ok).toBe(false);
  });

  it('accepts a quantity a PERSON gave, and says it was theirs', () => {
    const sheet = factSheet({
      interpretation: pedestal(),
      settings: settings(),
      userFacts: { p1_count: { mm: 20, saidAs: '20' } },
    });
    expect(find(sheet, 'P1', 'count')).toMatchObject({
      value: '20',
      origin: 'USER INPUT',
      blocking: false,
    });
  });

  it('accepts a quantity DERIVED from a pitch, and shows the pitch', () => {
    const sheet = factSheet({
      interpretation: pedestal({
        member: { count: 21, countRule: { pitchMm: 4000, endsInclusive: true } },
      }),
      settings: settings(),
    });
    expect(find(sheet, 'P1', 'count')).toMatchObject({ value: '21', origin: 'DERIVED' });
    expect(find(sheet, 'P1', 'count').saidAs).toMatch(/4000 mm pitch/);
  });

  it('blocks on a missing dimension, and never shows it as a zero', () => {
    const sheet = factSheet({
      interpretation: pedestal({ member: { heightMm: undefined } }),
      settings: settings(),
    });
    const h = find(sheet, 'P1', 'height');
    expect(h).toMatchObject({ value: null, origin: 'MISSING', blocking: true });
    expect(h.value).not.toBe('0');
  });

  it('blocks on a bar stating neither a count nor a spacing', () => {
    const sheet = factSheet({
      interpretation: pedestal({
        top: {
          bars: [
            {
              memberMark: 'P1',
              barType: 'MAIN',
              diaMm: 16,
              shapeCode: '00',
              fromCallout: 'DIA 16',
              handles: [],
            },
          ],
        },
      }),
      settings: settings(),
    });
    expect(find(sheet, 'P1-M1', 'bars_per_member')).toMatchObject({
      origin: 'MISSING',
      blocking: true,
    });
    expect(find(sheet, 'P1-M1', 'bars_per_member').saidAs).toMatch(/neither a count nor a spacing/);
  });
});

describe('a cutting length the drawing says is not its to give', () => {
  const declared = [
    {
      mark: 'P1-V1',
      memberMark: 'P1',
      diaMm: 16,
      field: 'cutting_length',
      fieldLabel: 'CUTTING LENGTH',
      saidAs: 'INPUT',
      where: 'BAR BENDING SCHEDULE - PEDESTAL P1 — the CUTTING LENGTH column',
    },
  ];

  it('is MISSING, blocking, and quotes the sheet', () => {
    const sheet = factSheet({
      interpretation: pedestal(),
      settings: settings(),
      designInputs: declared,
    });
    const cl = find(sheet, 'P1-M1', 'cutting_length');
    expect(cl).toMatchObject({ value: null, origin: 'MISSING', blocking: true });
    expect(cl.saidAs).toContain('"INPUT"');
    // and the tie, which the sheet DOES state, is untouched
    expect(find(sheet, 'P1-T1', 'cutting_length').origin).toBe('DERIVED');
  });

  it('becomes USER INPUT once the number is given', () => {
    const sheet = factSheet({
      interpretation: pedestal(),
      settings: settings(),
      designInputs: declared,
      typedLengths: { 'P1-M1': 2300 },
    });
    expect(find(sheet, 'P1-M1', 'cutting_length')).toMatchObject({
      value: '2300',
      origin: 'USER INPUT',
      blocking: false,
    });
  });
});

describe('how it reads', () => {
  it('puts the origin on every line, next to the value', () => {
    const lines = factSheetLines(
      factSheet({ interpretation: pedestal(), settings: settings({ coverSource: 'default' }) }),
    );
    expect(lines).toContain('Clear cover: 50 mm  [PROJECT DEFAULT]');
    expect(lines.some((l) => l.startsWith('P1 height: 1200 mm  [DRAWING]'))).toBe(true);
    // a missing value reads as an em dash, never a zero
    expect(lines.some((l) => l.includes('P1 quantity: —  [MISSING]'))).toBe(true);
  });
});
