// ============================================================
// The skill manifests — Layer 2 of the product-as-harness architecture.
//
// What is on trial here:
//   · knowledge is the SKILL.md file, shipped verbatim via ?raw. Each test
//     asserts a phrase that exists ONLY in the real file, so a broken or
//     renamed import fails loudly instead of shipping an empty prompt.
//   · every requirement carries an ask and a blocks list — a requirement
//     with no ask cannot enter the resolution loop.
//   · requirementsUnmet treats an absent fact and a recorded-'missing' fact
//     the same way: both block.
//   · the bbs compute adapter typechecks and computes against a minimal
//     FactSet, and BLOCKS the per-pitch counts when wall.total_run is
//     missing — the GAMCO lesson, as a regression test.
//   · billing.ts now carries the indian-construction knowledge verbatim,
//     and its existing deterministic API still stands.
// ============================================================
import { describe, expect, it } from 'vitest';
import {
  SKILLS,
  requirementsUnmet,
  bbsSkill,
  boqTenderSkill,
  SkillNotComputable,
  BBS_FACT_KEYS,
  type FactSet,
  type SkillFactValue,
} from '../../src/skills';
import type { BbsInterpretation, DrawingExtract } from '../../src/cad/bbs/types';
import {
  INDIAN_CONSTRUCTION_SKILL,
  allSections,
  readSpec,
  missingSpec,
} from '../../src/domain/india/billing';

const factSet = (entries: Record<string, SkillFactValue>): FactSet =>
  new Map(Object.entries(entries));

// ------------------------------------------------------------
// the registry
// ------------------------------------------------------------

describe('the skill registry', () => {
  it('registers every skill under its own manifest name', () => {
    for (const [key, skill] of Object.entries(SKILLS)) {
      expect(skill.name).toBe(key);
    }
    expect(SKILLS['bar-bending-schedule']).toBe(bbsSkill);
    expect(SKILLS['boq-tender']).toBe(boqTenderSkill);
  });

  it('every skill ships real knowledge — a phrase only the true SKILL.md carries', () => {
    // bar-bending-schedule/SKILL.md — its governing rule, verbatim
    expect(bbsSkill.knowledge).toContain('we extract INPUTS, we never invent a');
    // boq-tender/SKILL.md — the counted structural claim, verbatim
    expect(boqTenderSkill.knowledge).toContain(
      'Under 12% of a tender BOQ is a measurable line',
    );
    for (const skill of Object.values(SKILLS)) {
      expect(skill.knowledge.length).toBeGreaterThan(1000);
    }
  });

  it('every requirement carries an ask and a blocks list', () => {
    for (const skill of Object.values(SKILLS)) {
      expect(skill.requires.length).toBeGreaterThan(0);
      for (const req of skill.requires) {
        expect(req.key).toBeTruthy();
        expect(req.ask.trim().length).toBeGreaterThan(0);
        expect(Array.isArray(req.blocks)).toBe(true);
        expect(req.blocks.length).toBeGreaterThan(0);
        if (req.likelyIn !== undefined) {
          expect(['architectural', 'structural', 'site', 'brief']).toContain(req.likelyIn);
        }
      }
    }
  });
});

// ------------------------------------------------------------
// requirementsUnmet
// ------------------------------------------------------------

describe('requirementsUnmet', () => {
  it('an empty fact set leaves every requirement unmet', () => {
    const unmet = requirementsUnmet(bbsSkill, factSet({}));
    expect(unmet).toEqual(bbsSkill.requires);
  });

  it('a live fact satisfies its requirement; the rest stay unmet', () => {
    const unmet = requirementsUnmet(
      bbsSkill,
      factSet({
        [BBS_FACT_KEYS.totalRun]: { value: 100000, unit: 'mm', state: 'supplied' },
      }),
    );
    expect(unmet.map((r) => r.key)).not.toContain(BBS_FACT_KEYS.totalRun);
    expect(unmet.length).toBe(bbsSkill.requires.length - 1);
  });

  it("a fact recorded as 'missing' documents a failed search — it satisfies nothing", () => {
    const unmet = requirementsUnmet(
      bbsSkill,
      factSet({
        [BBS_FACT_KEYS.totalRun]: { value: null, state: 'missing' },
      }),
    );
    expect(unmet.map((r) => r.key)).toContain(BBS_FACT_KEYS.totalRun);
  });
});

// ------------------------------------------------------------
// the bbs compute adapter
// ------------------------------------------------------------

// the GAMCO shape: a typical-detail sheet — one drawn bay, a dimensioned
// pitch, no count column. The run lives on another drawing.
const EXTRACT: DrawingExtract = {
  drawingName: 'g',
  sourceFile: 'g.dxf',
  tables: [],
  callouts: [],
  notes: { notes: [] },
  marks: ['TB'],
  declared: [],
  unitScale: 1,
};

const READING: BbsInterpretation = {
  members: [
    {
      mark: 'TB',
      type: 'tie beam',
      lengthMm: 4157,
      widthMm: 350,
      heightMm: 400,
      count: 1,
      countRule: { pitchMm: 4157, endsInclusive: true },
      source: { table: '', row: -1 },
      incomplete: false,
      missing: [],
    },
  ],
  bars: [
    {
      barMark: 'TB-M1',
      memberMark: 'TB',
      barType: 'MAIN',
      diaMm: 16,
      shapeCode: '00',
      manualCount: 2,
      fromCallout: '2-16TOR',
      handles: [],
    },
    {
      barMark: 'TB-S1',
      memberMark: 'TB',
      barType: 'STIRRUP',
      diaMm: 8,
      shapeCode: '51',
      spacingMm: 150,
      fromCallout: '4L-8TOR@150C/C',
      handles: [],
    },
  ],
  unresolved: [],
};

const conclusions: Record<string, SkillFactValue> = {
  [BBS_FACT_KEYS.extract]: { value: EXTRACT, state: 'derived' },
  [BBS_FACT_KEYS.interpretation]: { value: READING, state: 'derived' },
};

describe('the bbs skill compute adapter', () => {
  it('refuses to compute without the orchestrator conclusions in memory', () => {
    expect(() => bbsSkill.compute(factSet({}))).toThrow(SkillNotComputable);
    expect(() =>
      bbsSkill.compute(
        factSet({ [BBS_FACT_KEYS.extract]: { value: EXTRACT, state: 'derived' } }),
      ),
    ).toThrow(/bbs\.interpretation/);
  });

  it('refuses a wrongly-shaped conclusion rather than computing from it', () => {
    expect(() =>
      bbsSkill.compute(
        factSet({
          [BBS_FACT_KEYS.extract]: { value: { nonsense: true }, state: 'derived' },
          [BBS_FACT_KEYS.interpretation]: { value: READING, state: 'derived' },
        }),
      ),
    ).toThrow(/wrong shape/);
  });

  it('BLOCKS per-pitch counts with the formula and named hole when the run is missing', () => {
    const out = bbsSkill.compute(factSet(conclusions));
    expect(out.rows.length).toBeGreaterThan(0);
    const tb = out.blocked.find((b) => b.rowId === 'TB');
    expect(tb).toBeDefined();
    expect(tb!.missingKeys).toEqual([BBS_FACT_KEYS.totalRun]);
    // the §6.4 shape: a formula with the hole named, never an invented number
    expect(tb!.formula).toContain(BBS_FACT_KEYS.totalRun);
    expect(tb!.formula).toContain('4157');
  });

  it('computes the fence-post count once the run is supplied — in metres or mm', () => {
    const out = bbsSkill.compute(
      factSet({
        ...conclusions,
        [BBS_FACT_KEYS.totalRun]: { value: 100, unit: 'm', state: 'supplied' },
      }),
    );
    // floor(100000 / 4157) + 1 — the GAMCO under-count, ended
    const row = (out.rows as { memberMark: string; memberCount: number }[]).find(
      (r) => r.memberMark === 'TB',
    );
    expect(row).toBeDefined();
    expect(row!.memberCount).toBe(25);
    expect(out.blocked.filter((b) => b.missingKeys.length > 0)).toEqual([]);
  });
});

// ------------------------------------------------------------
// the boq-tender manifest — honest about what it cannot do yet
// ------------------------------------------------------------

describe('the boq-tender skill', () => {
  it('declares its requirements from its own SKILL.md', () => {
    const keys = boqTenderSkill.requires.map((r) => r.key);
    expect(keys).toContain('boq.document');
    expect(keys).toContain('boq.revision');
  });

  it('throws SkillNotComputable with the reason, instead of faking a compute', () => {
    expect(() => boqTenderSkill.compute(factSet({}))).toThrow(SkillNotComputable);
    try {
      boqTenderSkill.compute(factSet({}));
      expect.unreachable('compute must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SkillNotComputable);
      expect((e as SkillNotComputable).reason).toMatch(/not written yet/);
    }
  });
});

// ------------------------------------------------------------
// billing.ts — knowledge imported, computation intact
// ------------------------------------------------------------

describe('billing.ts after the ?raw import', () => {
  it('carries the indian-construction skill verbatim — its rule of use, exactly', () => {
    expect(INDIAN_CONSTRUCTION_SKILL).toContain(
      'this knowledge assigns MEANING. It never produces a quantity.',
    );
    // frontmatter proves it is the whole file, not a paraphrase
    expect(INDIAN_CONSTRUCTION_SKILL).toContain('name: indian-construction');
  });

  it('its deterministic API still stands', () => {
    expect(allSections()).toContain('Switchgear');
    expect(allSections()).toContain('Unclassified');

    const spec = readSpec(['63A TPN MCB', '10kA']);
    expect(spec.rating).toBe('63A');
    expect(spec.poles).toBe('3-pole + neutral');
    expect(spec.breaking).toBe('10kA');

    // an MCCB with no breaking capacity reports itself unpriceable
    expect(missingSpec('MCCB incomer', { rating: '125A', poles: '4-pole' })).toEqual([
      'breaking',
    ]);
  });
});
