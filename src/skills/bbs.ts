// ============================================================
// The bar-bending-schedule skill, as a manifest (PRODUCT_AS_HARNESS.md §4).
//
// Knowledge is the SKILL.md exactly as `src/cad/bbs/knowledge.ts` already
// ships it to the model — imported, never paraphrased. Compute is a thin
// typed adapter over the existing deterministic engine `buildBbs()`.
//
// buildBbs is a contained pure call, but its first two arguments — the
// DrawingExtract and the BbsInterpretation — are the orchestrator's
// conclusions about a sheet. Per the spec's layering rule the skill cannot
// call the harness for them; they reach compute THROUGH the FactSet, as
// facts the harness deposited ('bbs.extract', 'bbs.interpretation', state
// 'derived'). The adapter validates their shape and refuses loudly rather
// than computing from garbage.
//
// THE GAMCO LESSON (HOW_TO_BUILD_IT.md §6.4): a typical-detail sheet draws
// one bay and states no count, so every member arrives as count 1 — and on a
// 100 m boundary wall that under-orders the steel by roughly fifty times.
// The run lives on the ARCHITECTURAL drawing, not the structural sheet. So
// the linear-member case declares `wall.total_run` as a requirement, and
// when it is missing the per-pitch rows come back BLOCKED with the count
// formula and its named hole — never a number.
// ============================================================
import { BBS_SKILL } from '../cad/bbs/knowledge';
import { buildBbs, settingsFromExtract } from '../cad/bbs/build';
import type {
  BbsInterpretation,
  BbsResult,
  BbsSettings,
  DrawingExtract,
} from '../cad/bbs/types';
import type { BbsOverrides } from '../cad/bbs/overrides';
import {
  SkillNotComputable,
  type BlockedRow,
  type FactSet,
  type Skill,
  type SkillOutput,
} from './types';

export const BBS_SKILL_NAME = 'bar-bending-schedule';

/** fact keys the adapter reads — exported so the harness and tests agree */
export const BBS_FACT_KEYS = {
  /** the deterministic extraction of the structural sheet (DrawingExtract) */
  extract: 'bbs.extract',
  /** the model's reading of what the extraction means (BbsInterpretation) */
  interpretation: 'bbs.interpretation',
  /** optional explicit settings (BbsSettings); else derived from the extract */
  settings: 'bbs.settings',
  /** optional per-bar user overrides (BbsOverrides) */
  overrides: 'bbs.overrides',
  /** the linear-member run, from the architectural layout — the GAMCO fact */
  totalRun: 'wall.total_run',
} as const;

// ---- typed adapter: FactSet → buildBbs inputs ----

/** a fact that is present and not in the 'missing' state */
function liveFact(facts: FactSet, key: string): unknown | undefined {
  const f = facts.get(key);
  if (!f || f.state === 'missing') return undefined;
  return f.value;
}

/**
 * The orchestrator's conclusions are objects; a wrong shape here means the
 * harness filed the wrong thing under the key, and computing from it would
 * produce confidently wrong steel. Refuse instead.
 */
function conclusionFact<T extends object>(
  facts: FactSet,
  key: string,
  mustHave: string[],
): T {
  const v = liveFact(facts, key);
  if (v === undefined) {
    throw new SkillNotComputable(
      BBS_SKILL_NAME,
      `fact "${key}" is not in memory — run the BBS reading on the structural sheet first`,
    );
  }
  if (typeof v !== 'object' || v === null || mustHave.some((k) => !(k in v))) {
    throw new SkillNotComputable(
      BBS_SKILL_NAME,
      `fact "${key}" does not carry ${mustHave.join('/')} — wrong shape for this skill`,
    );
  }
  return v as T;
}

/** the answered run in mm, honouring the fact's unit; null when not in memory */
export function totalRunMm(facts: FactSet): number | null {
  const f = facts.get(BBS_FACT_KEYS.totalRun);
  if (!f || f.state === 'missing') return null;
  const n = Number(f.value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return f.unit === 'm' ? n * 1000 : n;
}

/** BbsResult → SkillOutput, with the run-dependent counts blocked when the run is missing */
function toSkillOutput(result: BbsResult, runMm: number | null): SkillOutput {
  const blocked: BlockedRow[] = [];

  // §6.4: with no run, a countRule member's count is a formula with a hole.
  if (runMm === null) {
    for (const m of result.members) {
      if (!m.countRule || m.count > 1) continue;
      const { pitchMm, endsInclusive } = m.countRule;
      blocked.push({
        rowId: m.mark,
        formula: `count = ⌊${BBS_FACT_KEYS.totalRun} / ${pitchMm}⌋${endsInclusive ? ' + 1' : ''}`,
        missingKeys: [BBS_FACT_KEYS.totalRun],
      });
    }
  }

  // rows the engine itself could not complete — surfaced, never dropped
  for (const inc of result.incomplete) {
    blocked.push({ rowId: inc.barMark, formula: inc.reason, missingKeys: [] });
  }

  return { rows: result.rows, blocked, summary: result.summary };
}

export const bbsSkill: Skill = {
  name: BBS_SKILL_NAME,
  knowledge: BBS_SKILL,
  requires: [
    {
      key: BBS_FACT_KEYS.extract,
      likelyIn: 'structural',
      ask: 'Which structural reinforcement sheet is the schedule for? It has not been read yet.',
      blocks: ['every row — the extract is the schedule’s evidence'],
    },
    {
      key: BBS_FACT_KEYS.interpretation,
      likelyIn: 'structural',
      ask: 'The reinforcement sheet has been extracted but not interpreted — run the BBS reading on it.',
      blocks: ['every row — no bar exists until the reading assigns it a member'],
    },
    {
      // the GAMCO lesson: the run is on the architectural layout, and the
      // ask wording is HOW_TO_BUILD_IT.md §6.4's, verbatim
      key: BBS_FACT_KEYS.totalRun,
      likelyIn: 'architectural',
      ask: 'What is the total run of the boundary wall?',
      blocks: [
        'count of every per-pitch member (countRule rows)',
        'longitudinal cutting lengths measured along the run',
        'steel summary totals',
      ],
    },
  ],
  compute(facts: FactSet): SkillOutput {
    const extract = conclusionFact<DrawingExtract>(facts, BBS_FACT_KEYS.extract, [
      'callouts',
      'notes',
    ]);
    const interpretation = conclusionFact<BbsInterpretation>(
      facts,
      BBS_FACT_KEYS.interpretation,
      ['members', 'bars'],
    );
    const settings = liveFact(facts, BBS_FACT_KEYS.settings) as
      | Partial<BbsSettings>
      | undefined;
    const overrides = liveFact(facts, BBS_FACT_KEYS.overrides) as
      | BbsOverrides
      | undefined;

    const runMm = totalRunMm(facts);
    // runMmFromTakeoff matches keys on /run|length/ and treats values ≥ 1000
    // as already-mm; the unit conversion happened in totalRunMm above.
    const takeoff = runMm === null ? undefined : { total_run_mm: runMm };

    const result = buildBbs(
      extract,
      interpretation,
      settingsFromExtract(extract, settings ?? {}),
      overrides,
      takeoff,
    );
    return toSkillOutput(result, runMm);
  },
};
