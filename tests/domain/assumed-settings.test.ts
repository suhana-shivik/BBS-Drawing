// The three figures a schedule computes on that nobody ever supplied.
//
// M25, Fe500 and 50 mm cover are DEFAULT_SETTINGS. When the drawing states
// none of them they were merged in silently, printed in the workbook header
// beside the drawing number, and used: the two grades derive the development
// length — the gate that decides whether a bar is long enough to be a bar at
// all — and cover sits in every stirrup arm. A schedule resting on three
// assumptions read exactly like one resting on three readings.
//
// They are not refused (a schedule honest about an assumption beats no
// schedule) but they are now SAID, and asked about.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, resolveSettings } from '../../src/cad/bbs/build';
import { assumedSettings } from '../../src/studio/bbsFacts';
import type { DrawingExtract } from '../../src/cad/bbs/types';

const extractWith = (notes: Record<string, unknown>): DrawingExtract =>
  ({
    callouts: [],
    tables: [],
    declared: [],
    marks: [],
    dimensions: [],
    notes: { ...notes },
  }) as unknown as DrawingExtract;

describe('where each setting came from', () => {
  it('calls a figure the sheet never stated a default', () => {
    const { settings, sources } = resolveSettings(extractWith({}));
    expect(settings.coverMm).toBe(DEFAULT_SETTINGS.coverMm);
    expect(sources).toMatchObject({
      coverMm: 'default',
      concreteGrade: 'default',
      steelGrade: 'default',
    });
  });

  it('calls a figure the sheet states a reading', () => {
    const { settings, sources } = resolveSettings(
      extractWith({ coverMm: 40, concreteGrade: 'M30' }),
    );
    expect(settings.coverMm).toBe(40);
    expect(settings.concreteGrade).toBe('M30');
    expect(sources.coverMm).toBe('sheet');
    expect(sources.concreteGrade).toBe('sheet');
    // Untouched by the sheet, so still an assumption.
    expect(sources.steelGrade).toBe('default');
  });

  it('calls a figure the person gave stated, and it outranks the sheet', () => {
    const { settings, sources } = resolveSettings(extractWith({ coverMm: 40 }), { coverMm: 30 });
    expect(settings.coverMm).toBe(30);
    expect(sources.coverMm).toBe('stated');
  });

  it('reads the sheet lap rule as a stated development-length multiple', () => {
    const { settings, sources } = resolveSettings(
      extractWith({ globalRules: [{ kind: 'lap', multiple: 50 }] }),
    );
    expect(settings.ldMultiple).toBe(50);
    expect(sources.ldMultiple).toBe('sheet');
  });
});

describe('what gets asked about afterwards', () => {
  it('asks for the three that decide every length, and nothing else', () => {
    const { settings, sources } = resolveSettings(extractWith({}));
    const asked = assumedSettings(sources, settings);
    expect(asked.map((a) => a.factId).sort()).toEqual([
      'settings.concrete_grade',
      'settings.cover',
      'settings.steel_grade',
    ]);
  });

  it('quotes what the schedule actually computed on, so the reader can judge it', () => {
    const { settings, sources } = resolveSettings(extractWith({}));
    const cover = assumedSettings(sources, settings).find((a) => a.factId === 'settings.cover')!;
    expect(cover.usedValue).toBe('50');
    expect(cover.ask).toContain('50 mm');
    expect(cover.ask).toContain('project default');
  });

  it('says why the grades matter, not just that they were assumed', () => {
    const { settings, sources } = resolveSettings(extractWith({}));
    const asked = assumedSettings(sources, settings);
    const concrete = asked.find((a) => a.factId === 'settings.concrete_grade')!;
    expect(concrete.ask).toMatch(/development length/);
    expect(concrete.ask).toMatch(/IS 456 Table 21/);
  });

  it('asks nothing once the sheet or the person has supplied them', () => {
    const stated = resolveSettings(
      extractWith({ coverMm: 40, concreteGrade: 'M30', steelGrade: 'Fe415' }),
    );
    expect(assumedSettings(stated.sources, stated.settings)).toEqual([]);
  });

  it('asks only about the one still missing', () => {
    const partial = resolveSettings(extractWith({ concreteGrade: 'M30', steelGrade: 'Fe415' }));
    expect(assumedSettings(partial.sources, partial.settings).map((a) => a.factId)).toEqual([
      'settings.cover',
    ]);
  });
});
