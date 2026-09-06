// ============================================================
// The skill registry — every declared capability, in one place.
//
// A skill enters the product by being listed here. The harness's contract
// with the registry (PRODUCT_AS_HARNESS.md §4.2): load memory, run
// `requirementsUnmet` to find what is absent, fill memory (register search →
// split → transcribe, or record 'missing' with the skill's own ask), then
// call the skill's deterministic compute. Skills never talk to the harness;
// this module is deliberately ignorant of any harness type.
// ============================================================
import type { FactRequirement, FactSet, Skill } from './types';
import { bbsSkill } from './bbs';
import { boqTenderSkill } from './boqTender';

export * from './types';
export { bbsSkill, BBS_FACT_KEYS, BBS_SKILL_NAME, totalRunMm } from './bbs';
export { boqTenderSkill, BOQ_TENDER_SKILL, BOQ_TENDER_SKILL_NAME } from './boqTender';

/** every registered skill, by its manifest name */
export const SKILLS: Record<string, Skill> = {
  [bbsSkill.name]: bbsSkill,
  [boqTenderSkill.name]: boqTenderSkill,
};

/**
 * The requirements memory does not yet satisfy.
 *
 * A requirement is unmet when its key is absent from the fact set OR present
 * in the 'missing' state — a recorded 'missing' fact documents the search
 * that failed (HOW_TO_BUILD_IT.md §6.2); it does not satisfy anything. Each
 * unmet entry carries its own `ask` and `likelyIn`, which is exactly what
 * the harness's resolution loop consumes.
 */
export function requirementsUnmet(skill: Skill, facts: FactSet): FactRequirement[] {
  return skill.requires.filter((req) => {
    const f = facts.get(req.key);
    return !f || f.state === 'missing';
  });
}
