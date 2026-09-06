// ============================================================
// The BBS skill, shipped to the browser model.
//
// WHY THIS FILE EXISTS
//
// `.claude/skills/bar-bending-schedule/SKILL.md` was written to be the domain
// knowledge THIS APP reasons with — not a document for whoever happens to be
// editing the repo. It was nevertheless only ever read at development time,
// while the runtime prompts carried hand-written paraphrases of it. Two copies,
// then three (the agentic path and the single-pass fallback each grew their
// own), and they drifted:
//
//   the skill knows "10TOR@200C/C" and "4L-8TOR@150C/C" are the dialect of
//   Indian boundary-wall sheets. Neither runtime prompt did.
//
// So the skill is IMPORTED, not paraphrased. `?raw` inlines the file at build
// time, which means:
//   · one source of truth — editing SKILL.md changes what the model is told
//   · a missing or renamed file is a BUILD FAILURE, loudly, rather than a
//     prompt that quietly ships without half its knowledge
//   · the bundle carries it, so no filesystem access is needed at runtime
//
// THE FRAMING MATTERS AS MUCH AS THE TEXT
//
// The skill teaches the whole job, including the arithmetic — shape formulas,
// Ld derivations, the fence-post rule, IS 1786 weights. The model must do NONE
// of that: it assigns meaning, the engine computes every number. Handing it
// formulas without saying so would invite exactly the invented cutting length
// this project exists to prevent. `skillBriefing` therefore wraps the text in
// what the model is to do with each half.
// ============================================================
import SKILL_MD from '../../../.claude/skills/bar-bending-schedule/SKILL.md?raw';

/** The skill exactly as written. Exported so a test can prove it shipped. */
export const BBS_SKILL = SKILL_MD;

/**
 * The skill, framed for a model that is forbidden to produce a number.
 *
 * The engine-owned sections are named explicitly. A model that knows the
 * engine will count `ceil(span / spacing) + 1` gives a better
 * `distributionAxis` and a truer spacing than one guessing what its answer is
 * for — the knowledge is useful precisely because it is NOT its job.
 */
export function skillBriefing(): string {
  return `## REFERENCE — THE BAR BENDING SCHEDULE SKILL

Everything below is this practice's domain knowledge for reading Indian RCC
reinforcement drawings. Read it as the standard you are being held to.

HOW TO USE IT. Sections on what a drawing carries, callout dialects, member
kinds, marks grammar, notes that legislate, and what to ask when the sheet is
silent are YOURS — apply them directly.

Sections 3 to 6 — shape-code formulas, IS 456 / IS 2502 / IS 1786 derivations,
counting rules, weights — describe what the ENGINE does with your answer. They
are here so you understand what your answer feeds. You never perform them. You
never output a length, a count or a weight. Knowing that the engine counts
\`ceil(span / spacing) + 1\` along the axis you name is the reason to name that
axis carefully; it is not an invitation to do the division.

Where this reference and the instructions above disagree, the instructions
above win — they describe this harness, the reference describes the trade.

${SKILL_MD}`;
}
