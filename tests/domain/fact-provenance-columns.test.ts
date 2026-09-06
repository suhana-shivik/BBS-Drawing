// ============================================================
// The columns that say WHERE a fact came from.
//
// `data_facts.drawing_id` and `data_facts.section_id` were null in every row
// this app had ever written, for two different reasons:
//
//   · `drawing_id` was read from a ledger-wide context that no caller ever
//     passed, so it defaulted to null forever;
//   · `section_id` was not written at all — and could not have been, because
//     `drawing_sections` had no rows to reference. Nothing wrote that table.
//
// The consequence is bigger than two empty columns. ◪ The traceability
// contract for a BBS row is drawing_id + drawing_hash + section_id + member_id
// + source fact ids; two of those five were structurally unavailable, so no
// filed schedule could be traced back to the part of the sheet it was read
// from.
//
// These tests pin the resolution rule, including the case it would be easy to
// get wrong: an ANSWER belongs to the drawing it was asked on, but it must not
// acquire a `source` — §7.1 keeps "a person said this" and "the sheet says
// this" apart, and `source` is the claim that the sheet says it.
// ============================================================
import { beforeEach, describe, expect, it } from 'vitest';
import { factToRow } from '../../src/data/facts';
import { rememberDrawingId, resetDrawingIdMap } from '../../src/data/drawings';
import { remoteSectionIdFor, resetSectionIdMap } from '../../src/data/sections';
import type { Fact } from '../../src/facts/types';
import type { LedgerEntry } from '../../src/facts/ledger';

const DRAWING_ROW = '11111111-1111-1111-1111-111111111111';
const CTX = { projectId: 'proj-1', userId: 'user-1' };

const entry = (fact: Partial<Fact> & { id: string }): LedgerEntry => ({
  seq: 0,
  fact: { value: 3500, state: 'MEASURED', readOn: '2026-09-06', ...fact } as Fact,
});

describe('which drawing a fact belongs to', () => {
  beforeEach(() => {
    resetDrawingIdMap();
    resetSectionIdMap();
    rememberDrawingId('doc-footings', DRAWING_ROW);
  });

  it('takes the drawing from the fact’s own provenance when it has one', () => {
    const row = factToRow(
      entry({
        id: 'F8.length',
        source: { drawingNumber: 'PCD-803', revision: 'R0', documentId: 'doc-footings' },
      }),
      CTX,
    );
    expect(row.drawing_id).toBe(DRAWING_ROW);
  });

  it('falls back to the open document for an ANSWER, which carries no source', () => {
    // `factFromAnswer` deliberately records no `source` — an answer is not a
    // reading. Without the fallback this row filed a null drawing, which is
    // exactly what the database showed.
    const row = factToRow(
      entry({ id: 'F8.length', state: 'SUPPLIED', suppliedBy: 'you', saidAs: '3500' }),
      { ...CTX, documentId: 'doc-footings' },
    );
    expect(row.drawing_id).toBe(DRAWING_ROW);
    expect(row.source_type).toBe('USER_INPUT');
    // …and it still does not claim the sheet says so.
    expect(row.source).toBeNull();
  });

  it('prefers the fact’s own drawing over the one that happens to be open', () => {
    rememberDrawingId('doc-beams', '22222222-2222-2222-2222-222222222222');
    const row = factToRow(
      entry({
        id: 'PB03.span',
        source: { drawingNumber: 'PCD-900', revision: 'R1', documentId: 'doc-beams' },
      }),
      { ...CTX, documentId: 'doc-footings' },
    );
    expect(row.drawing_id).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('says null rather than guessing when no drawing is involved at all', () => {
    const row = factToRow(entry({ id: 'settings.cover', value: 40 }), CTX);
    expect(row.drawing_id).toBeNull();
    expect(row.section_id).toBeNull();
  });

  it('says null for a drawing this session has no row for', () => {
    const row = factToRow(
      entry({
        id: 'F8.length',
        source: { drawingNumber: 'PCD-803', revision: 'R0', documentId: 'doc-never-filed' },
      }),
      CTX,
    );
    expect(row.drawing_id).toBeNull();
  });
});

describe('which section of the sheet a fact was read from', () => {
  beforeEach(() => {
    resetDrawingIdMap();
    resetSectionIdMap();
    rememberDrawingId('doc-footings', DRAWING_ROW);
  });

  it('is null until the split has been filed — nothing to reference', () => {
    const row = factToRow(
      entry({
        id: 'F8.length',
        source: {
          drawingNumber: 'PCD-803',
          revision: 'R0',
          documentId: 'doc-footings',
          sectionId: 'REGION-03',
        },
      }),
      CTX,
    );
    expect(row.section_id).toBeNull();
  });

  it('is never inferred from the open document — a document is not a section', () => {
    const row = factToRow(
      entry({ id: 'F8.length', state: 'SUPPLIED', suppliedBy: 'you' }),
      { ...CTX, documentId: 'doc-footings' },
    );
    expect(row.section_id).toBeNull();
  });

  it('keys the section by document AND key, so REGION-03 of two sheets differ', () => {
    // Section keys are stable WITHIN a package and meaningless across two:
    // every split produces a REGION-01. A cache keyed on the key alone would
    // hand one drawing's section id to another drawing's fact.
    expect(remoteSectionIdFor('doc-footings', 'REGION-03')).toBeNull();
    expect(remoteSectionIdFor('doc-beams', 'REGION-03')).toBeNull();
    expect(remoteSectionIdFor('doc-footings', undefined)).toBeNull();
    expect(remoteSectionIdFor(undefined, 'REGION-03')).toBeNull();
  });
});
