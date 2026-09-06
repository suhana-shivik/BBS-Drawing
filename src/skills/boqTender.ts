// ============================================================
// The boq-tender skill, as a manifest (PRODUCT_AS_HARNESS.md §4.3).
//
// This SKILL.md was real, counted-against-a-real-tender knowledge that
// nothing loaded — documentation by accident. The manifest makes it a
// declared capability: knowledge imported verbatim, requirements derived
// from what the SKILL.md itself says a tender reconciliation needs (§5–§6),
// and a compute that says HONESTLY that it is not written yet. The point of
// the manifest is that this becomes live the moment someone writes the
// compute — a BOQ parser plus the four-bucket report — not that we fake one.
// ============================================================
import SKILL_MD from '../../.claude/skills/boq-tender/SKILL.md?raw';
import { SkillNotComputable, type FactSet, type Skill, type SkillOutput } from './types';

export const BOQ_TENDER_SKILL_NAME = 'boq-tender';

/** The skill exactly as written. Exported so a test can prove it shipped. */
export const BOQ_TENDER_SKILL = SKILL_MD;

export const boqTenderSkill: Skill = {
  name: BOQ_TENDER_SKILL_NAME,
  knowledge: BOQ_TENDER_SKILL,
  // Derived from the SKILL.md's own account of what a reconciliation needs:
  // §1/§6 the document and its revision, §3/§5 what a drawing take-off can
  // supply (cable lengths, countable symbols, earthing runs).
  requires: [
    {
      // §6: tender BOQs are frequently legacy binary .xls; the file is input
      key: 'boq.document',
      likelyIn: 'brief',
      ask: 'Which tender BOQ file should the take-off reconcile against? (Usually a legacy .xls issued with the tender.)',
      blocks: ['all four reconciliation buckets — nothing compares without the bill'],
    },
    {
      // §6: the title row carries the revision and must travel with any
      // comparison — a BOQ compared against the wrong revision is worse
      // than no comparison
      key: 'boq.revision',
      likelyIn: 'brief',
      ask: 'Which revision of the BOQ is current? The title row carries it (e.g. "BOQ FOR ELECTRICAL WORKS (R0)").',
      blocks: ['supported', 'disagrees — a delta against the wrong revision is noise'],
    },
    {
      // §3/§5: 43 of 70 measurable rows are linear cable; an SLD shows
      // connectivity, not length — lengths need a cable schedule or a
      // measured route
      key: 'takeoff.cable_lengths',
      ask: 'Is there a cable schedule, or routed cable layouts to measure lengths from? A single-line diagram shows connectivity, not length.',
      blocks: ['supported: cable items per size, in RM'],
    },
    {
      // §5: panels, DBs, transformers, light fittings — countable symbols
      key: 'takeoff.device_counts',
      ask: 'Which sheets carry the countable symbols (panels, DBs, transformers, light fittings, fans, sockets)?',
      blocks: ['supported: items billed in Nos'],
    },
    {
      // §5: earthing strip in RM — yes, if the earthing layout is drawn
      key: 'takeoff.earthing_run',
      likelyIn: 'site',
      ask: 'Is the earthing layout drawn, and on which sheet? Earthing strip is billed in RM off that layout.',
      blocks: ['supported: earthing strip in RM'],
    },
  ],
  compute(_facts: FactSet): SkillOutput {
    throw new SkillNotComputable(
      BOQ_TENDER_SKILL_NAME,
      'the reconciliation compute is not written yet — it needs a legacy .xls BOQ parser ' +
        '(SKILL.md §6), row classification into measurable / specification-derived / ' +
        'rate-only / preamble (§2–§4), and the four-bucket report of §5. The knowledge ' +
        'and requirements above are live; the arithmetic is not.',
    );
  },
};
