// The generic DataFact projection: any ledger fact — whatever member, whatever
// drawing — leaves the store with the same fields, its source type decided by
// its ledger state and never by its value.
import { describe, expect, it } from 'vitest';
import { dataFactUsable, dataFactsOf, semanticTypeOf, sourceTypeOf, toDataFact } from '../../src/facts/dataFact';
import { emptyLedger, recordFact } from '../../src/facts/ledger';
import type { Fact } from '../../src/facts/types';

const fact = (over: Partial<Fact> & { id: string }): Fact => ({
  value: null,
  state: 'MISSING',
  readOn: '2026-09-06',
  ...over,
});

describe('DataFact projection', () => {
  it('types parameters by name pattern, not by member', () => {
    expect(semanticTypeOf('length')).toBe('member_dimension');
    expect(semanticTypeOf('span')).toBe('member_dimension');
    expect(semanticTypeOf('depth')).toBe('member_dimension');
    expect(semanticTypeOf('cover')).toBe('cover');
    expect(semanticTypeOf('count')).toBe('count');
    expect(semanticTypeOf('tie_spacing')).toBe('spacing');
    expect(semanticTypeOf('main_bar_dia')).toBe('bar_diameter');
    expect(semanticTypeOf('cutting_length')).toBe('cutting_length');
    expect(semanticTypeOf('concrete_grade')).toBe('material_grade');
    expect(semanticTypeOf('x')).toBe('bar_geometry');
  });

  it('maps ledger states to source types', () => {
    expect(sourceTypeOf(fact({ id: 'PB03.span', state: 'DECLARED', value: 3500 }))).toBe('DRAWING_READ');
    expect(sourceTypeOf(fact({ id: 'PB03.span', state: 'MEASURED', value: 3500 }))).toBe('DRAWING_READ');
    expect(sourceTypeOf(fact({ id: 'PB03.span', state: 'SUPPLIED', value: 3500 }))).toBe('USER_INPUT');
    expect(sourceTypeOf(fact({ id: 'PB03.span', state: 'DERIVED', value: 3500, basis: 'sum of bays' }))).toBe('DERIVED');
    expect(sourceTypeOf(fact({ id: 'settings.cover', state: 'DERIVED', value: 50, basis: 'project default' }))).toBe('ASSUMED');
    expect(sourceTypeOf(fact({ id: 'PB03.span', state: 'MISSING' }))).toBe('MISSING');
    expect(sourceTypeOf(fact({ id: 'PB03.span', state: 'MISSING', ask: 'the span cell is not machine-readable — what is it?' }))).toBe('UNREADABLE');
    expect(sourceTypeOf(fact({ id: 'PB03.span', state: 'DECLARED', value: 3500, contradicted: true }))).toBe('UNREADABLE');
  });

  it('projects a declared table fact with its provenance, version and handles', () => {
    let ledger = emptyLedger();
    ledger = recordFact(ledger, fact({
      id: 'PB03.span',
      value: 3500,
      unit: 'mm',
      state: 'DECLARED',
      source: { drawingNumber: 'S-806', revision: 'R0', documentId: 'doc-1', sectionId: 'REGION-03', handles: ['1A2B', '1A2C'], rawText: 'BEAM SCHEDULE — SPAN: 3500' },
      sourceDrawingHash: 'hash-1',
    })).ledger;
    const [d] = dataFactsOf(ledger);
    expect(d).toMatchObject({
      factId: 'PB03.span',
      drawingId: 'doc-1',
      drawingHash: 'hash-1',
      sectionId: 'REGION-03',
      memberId: 'PB03',
      parameter: 'span',
      value: 3500,
      unit: 'mm',
      semanticType: 'member_dimension',
      sourceType: 'DRAWING_READ',
      sourceText: 'BEAM SCHEDULE — SPAN: 3500',
      sourceEntityHandles: ['1A2B', '1A2C'],
      confidence: 1,
      status: 'VALID',
      version: 1,
    });
    expect(dataFactUsable(d)).toBe(true);
  });

  it('carries a user answer as USER_INPUT with a new version, and the old value as SUPERSEDED', () => {
    let ledger = emptyLedger();
    ledger = recordFact(ledger, fact({ id: 'C12.height', state: 'MISSING', ask: 'What is the height of C12?' })).ledger;
    ledger = recordFact(ledger, fact({ id: 'C12.height', state: 'SUPPLIED', value: 3000, unit: 'mm', saidAs: '3000', suppliedBy: 'you' })).ledger;
    const current = dataFactsOf(ledger);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ factId: 'C12.height', sourceType: 'USER_INPUT', value: 3000, version: 2, status: 'VALID', sourceText: '3000' });
    const missing = toDataFact(ledger.entries[0]);
    expect(missing.status).toBe('SUPERSEDED');
    expect(dataFactUsable(missing)).toBe(false);
  });

  it('never makes a MISSING fact usable, and never turns it into zero', () => {
    let ledger = emptyLedger();
    ledger = recordFact(ledger, fact({ id: 'SLAB1.thickness', state: 'MISSING', unit: 'mm', ask: 'What is the slab thickness?' })).ledger;
    const [d] = dataFactsOf(ledger, { drawingId: 'doc-9', drawingHash: 'h9' });
    expect(d.value).toBeNull();
    expect(d.sourceType).toBe('MISSING');
    expect(d.status).toBe('MISSING');
    expect(d.confidence).toBe(0);
    expect(d.drawingId).toBe('doc-9');
    expect(d.ask).toMatch(/slab thickness/);
    expect(dataFactUsable(d)).toBe(false);
  });

  it('filters to the ids a row used', () => {
    let ledger = emptyLedger();
    ledger = recordFact(ledger, fact({ id: 'RW1.height', state: 'DECLARED', value: 2400, unit: 'mm' })).ledger;
    ledger = recordFact(ledger, fact({ id: 'RW1.thickness', state: 'DECLARED', value: 300, unit: 'mm' })).ledger;
    ledger = recordFact(ledger, fact({ id: 'settings.cover', state: 'SUPPLIED', value: 40, unit: 'mm' })).ledger;
    expect(dataFactsOf(ledger, {}, ['RW1.height', 'settings.cover']).map((d) => d.factId)).toEqual(['RW1.height', 'settings.cover']);
  });
});
