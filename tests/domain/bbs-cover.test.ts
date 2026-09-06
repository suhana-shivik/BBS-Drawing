import { describe, expect, it } from 'vitest';
import { resolveCover, type CoverInputs } from '../../src/cad/bbs/cover';

// the shape a real sheet's notes produce
const TABLE = [
  { member: 'FOUNDATION BEAM & SLAB', coversMm: [50, 50, 50] },
  { member: 'COLUMN', coversMm: [40] },
  { member: 'FLOOR BEAM.', coversMm: [30, 30, 30] },
  { member: 'TIE BEAM.', coversMm: [30, 30, 30] },
  { member: 'FLOOR SLAB.', coversMm: [20, 20, 20] },
];

const inputs = (over: Partial<CoverInputs> = {}): CoverInputs => ({ table: TABLE, ...over });

describe('cover precedence', () => {
  it('a user override beats everything', () => {
    const r = resolveCover(['TB', 'tie beam'], 'beam', inputs({ overrides: { TB: 25 } }));
    expect(r).toMatchObject({ ok: true, mm: 25, source: 'user-override' });
  });

  it('an exact table row beats a name match', () => {
    const r = resolveCover(['COLUMN'], 'column', inputs());
    expect(r).toMatchObject({ ok: true, mm: 40, source: 'member-cover-table' });
  });

  it('matches a mark to the table row that describes it', () => {
    // "TB" alone cannot match; the member's TYPE is what the table is written
    // against. Punctuation is normalised away, so "tie beam" reaches
    // "TIE BEAM." as an exact row rather than needing token scoring.
    const r = resolveCover(['TB', 'tie beam'], 'beam', inputs());
    expect(r).toMatchObject({ ok: true, mm: 30, source: 'member-cover-table' });
    expect(r.matchedOn).toBe('TIE BEAM.');
  });

  it('scores tokens when the member is named more fully than the table row', () => {
    const r = resolveCover(['PB1', 'tie beam at plinth level'], 'beam', inputs());
    expect(r).toMatchObject({ ok: true, mm: 30, source: 'normalised-name-match' });
    expect(r.matchedOn).toBe('TIE BEAM.');
  });

  it('refuses a row that only half describes the member', () => {
    // "FOUNDATION BEAM & SLAB" needs both words; a bare "slab" must not take it
    const r = resolveCover(['S1', 'slab'], undefined, {
      table: [{ member: 'FOUNDATION BEAM & SLAB', coversMm: [50] }],
    });
    expect(r.ok).toBe(false);
  });

  it('does NOT confuse a tie beam with a floor beam', () => {
    // a substring test on "BEAM" matches both; token scoring must not
    const tie = resolveCover(['TB', 'tie beam'], 'beam', inputs());
    const floor = resolveCover(['FB', 'floor beam'], 'beam', inputs());
    expect(tie.matchedOn).toBe('TIE BEAM.');
    expect(floor.matchedOn).toBe('FLOOR BEAM.');
  });

  it('ignores punctuation and casing in the sheet’s wording', () => {
    const r = resolveCover(['floor slab'], 'slab', inputs());
    expect(r.mm).toBe(20);
  });

  it('falls to the element kind when the table names nothing like it', () => {
    const r = resolveCover(['PC1', 'pile cap'], 'pilecap', inputs({ byKind: { pilecap: 75 } }));
    expect(r).toMatchObject({ ok: true, mm: 75, source: 'element-kind' });
  });

  it('falls to a single stated sheet cover only as a last resort', () => {
    const r = resolveCover(['XX', 'mystery'], undefined, { sheetDefault: 45 });
    expect(r).toMatchObject({ ok: true, mm: 45, source: 'sheet-default' });
  });

  it('refuses when nothing governs it, and says what the sheet does name', () => {
    const r = resolveCover(['XX', 'mystery'], undefined, inputs());
    expect(r.ok).toBe(false);
    expect(r.mm).toBeUndefined();
    expect(r.reason).toMatch(/none of which describes it/);
    expect(r.reason).toMatch(/Nothing was assumed/);
  });

  it('takes the SMALLEST cover a row lists', () => {
    // a row giving top/bottom/side takes the governing (smallest) one
    const r = resolveCover(['F1', 'foundation beam & slab'], 'footing', {
      table: [{ member: 'FOUNDATION BEAM & SLAB', coversMm: [50, 75, 60] }],
    });
    expect(r.mm).toBe(50);
  });

  it('reports how it was arrived at, every time', () => {
    for (const r of [
      resolveCover(['TB', 'tie beam'], 'beam', inputs()),
      resolveCover(['COLUMN'], 'column', inputs()),
      resolveCover(['XX'], 'pile', inputs({ byKind: { pile: 60 } })),
    ]) {
      expect(r.ok).toBe(true);
      expect(r.source).toBeTruthy();
      expect(r.working).toMatch(/mm —/);
    }
  });

  it('is not fooled by an RCC prefix', () => {
    const r = resolveCover(['W1', 'RCC floor slab'], 'slab', inputs());
    expect(r.mm).toBe(20);
  });
});
