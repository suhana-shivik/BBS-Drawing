// ============================================================
// Layer 2 — skills as capability (PRODUCT_AS_HARNESS.md §4).
//
// A skill is knowledge plus a contract: the SKILL.md text imported ?raw
// (never paraphrased into code), a declaration of the facts that must be in
// memory before it can run, and a DETERMINISTIC compute. The layering rule:
// skills never talk to a harness directly — memory is the only thing both
// sides touch. A skill states what it needs; the harness fills memory until
// those facts exist; compute reads memory and owns every number.
// ============================================================

/**
 * The five trust states of a project fact (HOW_TO_BUILD_IT.md §6.2).
 * `missing` is the one that BLOCKS: a quantity is only computed when every
 * fact it depends on is measured / declared / derived / supplied.
 */
// memory seam: unify with src/facts once MEMORY agent lands
export type SkillFactState =
  | 'measured'   // computed by code from geometry — reproducible
  | 'declared'   // written on a drawing, read by a model — quotable
  | 'derived'    // combined from other facts, basis recorded — auditable
  | 'supplied'   // given by a human — attributable
  | 'missing';   // required, searched for, not found — BLOCKS the quantity

/** one fact as a skill sees it — value, unit, trust state */
// memory seam: unify with src/facts once MEMORY agent lands
export interface SkillFactValue {
  value: unknown;
  unit?: 'mm' | 'm' | 'mm2' | 'deg';
  state: SkillFactState;
}

/**
 * What a skill's compute reads: a readonly map from dotted fact key
 * ('wall.total_run', 'TB.section') to its value, unit and state.
 */
// memory seam: unify with src/facts once MEMORY agent lands
export type FactSet = ReadonlyMap<string, SkillFactValue>;

/**
 * A row that could not be computed because a fact it depends on is missing.
 * It carries the FORMULA with a named hole — never an invented number — so
 * the moment someone supplies the fact it computes with no re-reading.
 */
export interface BlockedRow {
  rowId: string;
  /** the arithmetic with the hole named, e.g. "count = ⌈wall.total_run / 4157⌉" */
  formula: string;
  missingKeys: string[];
}

/** what a skill's compute returns — computed rows plus the honest holes */
// memory seam: unify with src/facts once MEMORY agent lands
export interface SkillOutput {
  rows: unknown[];
  blocked: BlockedRow[];
  summary?: unknown;
}

/** one fact a skill needs in memory before it can run (spec §4.1) */
export interface FactRequirement {
  key: string;                        // 'wall.total_run'
  /** if absent, which discipline of drawing is likely to carry it */
  likelyIn?: 'architectural' | 'structural' | 'site' | 'brief';
  /** what to ask a human if no drawing supplies it */
  ask: string;
  /** a row that needs it is BLOCKED; the rest of the schedule still computes */
  blocks: string[];
}

/** a skill: knowledge (verbatim SKILL.md), requirements, deterministic compute */
export interface Skill {
  name: string;                       // 'bar-bending-schedule'
  /** the SKILL.md text, imported ?raw — knowledge, unchanged */
  knowledge: string;
  /** what must be in memory before this can run */
  requires: FactRequirement[];
  /** DETERMINISTIC. Never a model. Every number in the output comes from here. */
  compute(facts: FactSet): SkillOutput;
}

/**
 * Thrown by a compute that cannot run — either because it is not yet written
 * (a manifest whose knowledge is live but whose arithmetic is not), or
 * because an input no FactRequirement can ask a human for is absent. Honest
 * by design: a skill becomes a live capability the moment someone writes its
 * compute, and until then it says so instead of faking one.
 */
export class SkillNotComputable extends Error {
  constructor(
    public readonly skillName: string,
    public readonly reason: string,
  ) {
    super(`skill "${skillName}" cannot compute: ${reason}`);
    this.name = 'SkillNotComputable';
  }
}
