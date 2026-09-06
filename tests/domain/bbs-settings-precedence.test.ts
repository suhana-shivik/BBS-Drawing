// What the arithmetic is allowed to assume, and who gets to say so.
//
// The order is defaults < what the SHEET states < what the PERSON states, and
// every one of these tests was failing before the run was wired to honour it:
// the orchestrator handed `DEFAULT_SETTINGS` to `settingsFromExtract` AS the
// caller's override, which put the defaults back on top of the drawing's own
// notes. A sheet stating M30 / Fe415 / CLEAR COVER 40 was scheduled at
// M25 / Fe500 / 50 — and cover governs every stirrup arm and every
// spacing-derived bar count, so the error lands in tonnage, silently.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, settingsFromExtract } from '../../src/cad/bbs/build';
import { appliedLine, isComputedWith } from '../../src/interview/facts';
import { settingsFromLedger } from '../../src/studio/bbsFacts';
import type { DrawingExtract } from '../../src/cad/bbs/types';
import type { Fact } from '../../src/facts/types';
import type { Ledger } from '../../src/facts/ledger';

const extractSaying = (notes: Record<string, unknown>): DrawingExtract =>
  ({
    drawingName: 'test sheet',
    notes: { globalRules: [], ...notes },
    members: [],
    bars: [],
    tables: [],
  }) as unknown as DrawingExtract;

const ledgerOf = (facts: readonly Partial<Fact>[]): Ledger =>
  ({
    entries: facts.map((fact) => ({
      fact: { state: 'SUPPLIED', ...fact } as Fact,
      history: [],
    })),
  }) as unknown as Ledger;

describe('settings precedence — defaults < the sheet < the person', () => {
  it('the drawing’s own notes beat the defaults', () => {
    const sheet = extractSaying({ concreteGrade: 'M30', steelGrade: 'Fe415', coverMm: 40 });
    const settings = settingsFromExtract(sheet, {});
    expect(settings.concreteGrade).toBe('M30');
    expect(settings.steelGrade).toBe('Fe415');
    expect(settings.coverMm).toBe(40);
  });

  it('a whole DEFAULT_SETTINGS passed as the override erases the sheet — the bug', () => {
    // Kept as a regression witness: this is exactly what the run used to do.
    const sheet = extractSaying({ concreteGrade: 'M30', steelGrade: 'Fe415', coverMm: 40 });
    const asTheRunUsedTo = settingsFromExtract(sheet, DEFAULT_SETTINGS);
    expect(asTheRunUsedTo.coverMm).toBe(50);
    expect(asTheRunUsedTo.concreteGrade).toBe('M25');
  });

  it('what the person states beats the sheet, field by field', () => {
    const sheet = extractSaying({ concreteGrade: 'M30', coverMm: 40 });
    const settings = settingsFromExtract(sheet, { coverMm: 30 });
    expect(settings.coverMm).toBe(30); // theirs
    expect(settings.concreteGrade).toBe('M30'); // still the sheet's
    expect(settings.wastagePct).toBe(DEFAULT_SETTINGS.wastagePct); // still the default
  });
});

describe('the ledger’s settings reach the engine', () => {
  it('reads cover, grades, wastage and the lap multiple', () => {
    const { settings, used } = settingsFromLedger(
      ledgerOf([
        { id: 'settings.cover', value: 40, unit: 'mm' },
        { id: 'settings.concrete_grade', value: 'M30' },
        { id: 'settings.steel_grade', value: 'Fe415' },
        { id: 'settings.wastage_pct', value: 5 },
        { id: 'settings.lap_multiple', value: 50 },
      ]),
    );
    expect(settings).toEqual({
      coverMm: 40,
      concreteGrade: 'M30',
      steelGrade: 'Fe415',
      wastagePct: 5,
      ldMultiple: 50,
    });
    expect(used).toHaveLength(5);
  });

  it('normalises a cover given in metres, as the dimension reader does', () => {
    const { settings } = settingsFromLedger(ledgerOf([{ id: 'settings.cover', value: 0.05, unit: 'm' }]));
    expect(settings.coverMm).toBe(50);
  });

  it('refuses a value it cannot type rather than computing with a guess', () => {
    const { settings, used } = settingsFromLedger(
      ledgerOf([
        { id: 'settings.concrete_grade', value: 'good quality' },
        { id: 'settings.wastage_pct', value: 400 },
      ]),
    );
    expect(settings).toEqual({});
    expect(used).toHaveLength(0);
  });

  it('leaves a MISSING fact out — a gap never becomes a setting', () => {
    const { settings } = settingsFromLedger(
      ledgerOf([{ id: 'settings.cover', value: null, state: 'MISSING' }]),
    );
    expect(settings.coverMm).toBeUndefined();
  });
});

describe('the thread does not claim more than the arithmetic does', () => {
  it('knows which facts a calculation actually reads', () => {
    expect(isComputedWith('wall.total_run')).toBe(true);
    expect(isComputedWith('C1.height')).toBe(true);
    expect(isComputedWith('settings.cover')).toBe(true);
    expect(isComputedWith('C1.cover')).toBe(true);
    expect(isComputedWith('settings.steel_grade')).toBe(true);
    // recorded, auditable, and read by no formula
    expect(isComputedWith('settings.anchorage')).toBe(false);
    expect(isComputedWith('C1.placement')).toBe(false);
  });

  it('says "applied" only when it is', () => {
    const applied = appliedLine({
      id: 'settings.cover',
      state: 'SUPPLIED',
      value: 40,
      unit: 'mm',
      saidAs: '40',
    } as Fact);
    expect(applied).toContain('applied');

    const recorded = appliedLine({
      id: 'C1.placement',
      state: 'SUPPLIED',
      value: 'every 3 m',
      saidAs: 'every 3 m',
    } as Fact);
    expect(recorded).toContain('does not read it');
    expect(recorded).not.toContain('— applied');
  });
});
