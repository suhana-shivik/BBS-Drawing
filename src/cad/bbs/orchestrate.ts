// ============================================================
// The orchestrator — the engineer leading the job.
//
// WHAT CHANGED, AND WHY
//
// Runs 004–010 were all the same shape: one model walking one loop, filling in
// a fixed vocabulary of decisions, with the ORDER OF WORK written in code. The
// agenda block in freehand.ts said "placement, then ownership, then dimensions"
// on every single turn. That is a checklist wearing the costume of an agent.
//
// Run 010 showed both what that costs and what is underneath it. The model
// independently concluded that a ~25 m drawn band was one template of a 100 m
// run — real engineering judgement, arrived at from crops. But it spent ten
// sequential turns getting there, four of them on independent detail questions
// that never needed to wait for one another, and it re-derived sheet structure
// stage 1 had already established, because that structure reached it as prose
// rather than as state.
//
// So the loop inverts. This file's model does not fill in slots. It:
//
//     understands the objective and the drawing
//     writes a plan, in its own words
//     creates tasks it invented, and dispatches independent ones together
//     reads what came back, including "still ambiguous"
//     creates more work, or changes the plan, when the evidence says to
//     decides when there is enough to build
//     reads the verifier and treats a failure as something to investigate
//
// WHAT REMAINS DETERMINISTIC, AND WHY
//
// Exactly what did before. Members come from the sheet. Every cited id must
// exist. Ownership is resolved once, from the whole claim set, by evidence
// tier. Placement kinds have closed count rules. Every number is computed by
// build.ts. The AI decides WHAT IS TRUE; code decides WHAT THAT ADDS UP TO.
//
// THERE IS NO RULE HERE ABOUT REINFORCEMENT. No band length implies a count, no
// mark implies a placement kind, no member implies a bar. If this file ever
// learns that "F1 means template-repeat", the experiment is over — that is the
// drawing's business, and the whole point is to find out whether the model can
// read it.
// ============================================================
import type { CadDocument } from '../types';
import type { ShapeCode } from '../../domain/india/bbs';
import type { EvidenceNode } from './evidence';
import type { EngineFact } from './refs';
import { skillBriefing } from './knowledge';
import type { DrawingExtract, BbsSettings, BbsBar } from './types';
import { buildEvidenceGraph, type EvidenceGraph } from './evidence';
import { buildPlacementBands, bandViewBox, type PlacementBand } from './bands';
import { buildMemberRegistry, type MemberRegistry } from './members';
import { detectRegions, renderRegions, type DrawingRegion } from './regions';
import { groupRegions, renderSections, type LogicalSection } from './logicalSections';
import { resolveOwnership, type OwnershipClaim, type OwnershipResult } from './ownership';
import { resolveAllPlacements, type MemberPlacement, type MemberPlacementSpec, isPlanLayout } from './placement';
import { resolveCover, type CoverRow } from './cover';
import type { BbsOverrides } from './overrides';
import { factSheet, type FactSheet } from './factSheet';
import { designInputsFrom } from './designInputs';
import { resolveRef } from './refs';
import {
  buildBbs,
  groundDeclaredDims,
  resolveSettings,
  settingsFromExtract,
  DEFAULT_SETTINGS, isLinearMark } from './build';
import { verifyAll, requiredAxes, type VerificationFailure } from './verify';
import { renderUnderstandingNote, assessCompleteness, completenessLine, type NoteState, type Completeness } from './notes';
import { buildChatResult, putChatResult, type BbsChatResult } from './chatResult';
import { renderToolMenu, type ToolContext } from './tools';
import type { Rasteriser } from './render';
import { Ledgers } from './lifecycle';
import {
  AXES, BAR_TYPES, OWNERSHIP_BASES, PLACEMENT_KINDS, SHAPE_CODES, isBarType, isShapeCode,
  checkDistributionAxis, checkEnum,
} from './contract';
import {
  arrayOf, bool, describeValue, enumOf, num, object, optional, passthrough, required, str,
  taggedUnion, validate, type Problem, type Validator,
} from './schema';
import { TaskBoard, runBatch, type Task, type TaskResult } from './tasks';
import {
  questionsFrom,
  countQuestion,
  coverQuestion,
  dedupeByDependency,
  dependencyOf,
  type AskableQuestion,
} from './askFrom';
import {
  distributionAxisFor,
  memberFactsFromTables,
  tableCellsForCallouts,
  tableDimsByMark,
} from './tableFacts';
import { scheduleSnapshot } from '../../../calculations/schedule';
import {
  axisOfQuestion,
  engineKeyForQuestion,
  escalationQuestion,
  typeAnswer,
} from '../../interview/facts';
import {
  renderBbsTable,
  renderReasoning,
  runJudge,
  type JudgeDossier,
  type JudgeOutcome,
} from './judge';

// ------------------------------------------------------------
// what the orchestrator may say
// ------------------------------------------------------------

const NEW_TASK = object({
  type: required(str({ min: 1 })),
  objective: required(str({ min: 1 })),
  inputs: optional(arrayOf(str())),
  requestedEvidence: optional(arrayOf(str())),
  supersedes: optional(str()),
}, { name: 'a task' });

/**
 * A placement, branch by branch — each kind's fields are part of its meaning.
 *
 * Run 014 accepted {"kind":"dependent"} carrying nothing else. The kind was a
 * legal enum value, nothing ever looked at the fields, and `.length` threw
 * INSIDE the final build, four turns after the conclusion was recorded — the
 * fifth crash of the unvalidated-model-input class, one field deeper than the
 * fourth. So the fields are checked where the kind is, and a refusal names the
 * missing field while the model still has the turn to fix it.
 */
const PITCH_REF = object(
  { kind: required(str({ min: 1 })) },
  { name: 'a pointer at the pitch dimension (a ref object, never a typed number)' },
);
const PLACEMENT: Validator<Record<string, unknown>> = taggedUnion('kind', {
  continuous: object({
    kind: required(enumOf(['continuous'])),
    runFactId: required(str({ min: 1 })),
  }, { name: 'a continuous placement — {"kind":"continuous","runFactId":"…"}' }),
  marks: object({
    kind: required(enumOf(['marks'])),
    markEvidenceIds: required(arrayOf(str({ min: 1 }), { min: 1 })),
  }, { name: 'a marks placement — {"kind":"marks","markEvidenceIds":["…"]}' }),
  'template-repeat': object({
    kind: required(enumOf(['template-repeat'])),
    panelId: required(str({ min: 1 })),
    runFactId: required(str({ min: 1 })),
    orderedOccurrenceIds: required(arrayOf(str({ min: 1 }), { min: 1 })),
  }, { name: 'a template-repeat placement — panelId, runFactId and orderedOccurrenceIds are all required' }),
  'periodic-pattern': object({
    kind: required(enumOf(['periodic-pattern'])),
    panelId: required(str({ min: 1 })),
    runFactId: required(str({ min: 1 })),
    orderedOccurrenceIds: required(arrayOf(str({ min: 1 }), { min: 1 })),
    cycleMemberIds: optional(arrayOf(str())),
  }, { name: 'a periodic-pattern placement' }),
  uniform: object({
    kind: required(enumOf(['uniform'])),
    pitchRef: required(PITCH_REF),
    along: required(enumOf(['run', 'x', 'y'])),
    boundaryRule: required(enumOf(['both-ends', 'start-only', 'end-only'])),
    runFactId: optional(str()),
  }, { name: 'a uniform placement — pitchRef, along and boundaryRule are all required' }),
  dependent: object({
    kind: required(enumOf(['dependent'])),
    parentMemberIds: required(arrayOf(str({ min: 1 }), { min: 1 })),
    relation: required(enumOf(['one-per-parent', 'one-per-bay', 'same-as-parent', 'custom'])),
  }, { name: 'a dependent placement — {"kind":"dependent","parentMemberIds":["MEM-…"],"relation":"one-per-parent"}' }),
  once: object({
    kind: required(enumOf(['once'])),
    evidenceId: required(str({ min: 1 })),
  }, { name: 'a once placement — {"kind":"once","evidenceId":"…"}' }),
  unknown: object({
    kind: required(enumOf(['unknown'])),
    reason: optional(str()),
  }, { name: 'an unknown placement' }),
}, { name: 'a placement whose "kind" carries its own required fields' });

/**
 * One conclusion, branch by branch. The ids a branch dereferences are REQUIRED
 * in that branch: Run 014's next crash waiting to happen was a placement
 * conclusion with no memberId at all, which passed the old all-optional shape
 * and died inside `registry.resolve(undefined)`.
 */
/**
 * Exported so the JUDGE can be held to the same contract it is asked to
 * write in. A correction phrased in a vocabulary the lead cannot adopt is
 * not a correction, and there must be exactly ONE definition of what a
 * conclusion is.
 */
export const CONCLUSION = taggedUnion('kind', {
  own: object({
    kind: required(enumOf(['own'])),
    calloutId: required(str({ min: 1 })),
    memberId: required(str({ min: 1 })),
    basis: optional(str()),
    barType: optional(str()),
    distributionAxis: optional(str()),
    evidenceIds: optional(arrayOf(str())),
    reasoning: optional(str()),
    confidence: optional(num({ min: 0, max: 1 })),
  }, { name: 'an ownership conclusion — calloutId and memberId are required' }),
  placement: object({
    kind: required(enumOf(['placement'])),
    memberId: required(str({ min: 1 })),
    placement: required(PLACEMENT),
    evidenceIds: optional(arrayOf(str())),
    reasoning: optional(str()),
    confidence: optional(num({ min: 0, max: 1 })),
  }, { name: 'a placement conclusion — memberId and a placement object are required' }),
  dimension: object({
    kind: required(enumOf(['dimension'])),
    memberId: required(str({ min: 1 })),
    axis: optional(str()),
    ref: required(passthrough('a pointer at a dimension')),
    evidenceIds: optional(arrayOf(str())),
    reasoning: optional(str()),
    confidence: optional(num({ min: 0, max: 1 })),
  }, { name: 'a dimension conclusion — memberId and a ref are required' }),
  shape: object({
    kind: required(enumOf(['shape'])),
    calloutId: required(str({ min: 1 })),
    shapeCode: optional(str(), ['shape', 'code']),
    evidenceIds: optional(arrayOf(str())),
    reasoning: optional(str()),
  }, { name: 'a shape conclusion — calloutId is required' }),
  exclude: object({
    kind: required(enumOf(['exclude'])),
    calloutId: optional(str()),
    memberId: optional(str()),
    why: optional(str()),
    evidenceIds: optional(arrayOf(str())),
    reasoning: optional(str()),
  }, { name: 'an exclusion — name a calloutId (steel that is not scheduled) or a memberId (a member that carries none)' }),
}, { name: 'a conclusion whose "kind" is one of: own, placement, dimension, shape, exclude' });

/**
 * The reply's fields, each with its own validator.
 *
 * SEPARATELY, because they are separate. Run 016 sent fifteen sound
 * conclusions — thirteen exclusions, an ownership and a placement, the turn the
 * job finally converted — in a reply whose `plan` was a string rather than a
 * list of strings. The whole reply was refused, all fifteen were discarded, and
 * the model resent only the plan. A narration field the engine does nothing
 * with cost the run its best turn.
 *
 * Nothing here is coerced or guessed. Each field is checked on its own and
 * applied only if it is well-formed; the rest are refused BY NAME in the same
 * report. Independence is real: `plan` has no bearing on whether a conclusion
 * is valid, and a conclusion's own shape is checked again in applyConclusion.
 */
const REPLY_FIELDS = {
  understanding: str(),
  plan: arrayOf(str()),
  thinking: str(),
  createTasks: arrayOf(NEW_TASK),
  // each conclusion is validated INDIVIDUALLY in applyConclusion too, so one
  // malformed conclusion is refused by itself and does not discard the rest
  conclusions: arrayOf(passthrough('a conclusion')),
  build: bool(),
  askUser: arrayOf(object({
    question: required(str({ min: 1 })),
    whyNeeded: required(str({ min: 1 })),
  }, { name: 'a question for the user' })),
  unresolved: arrayOf(str()),
  done: object({ why: required(str({ min: 1 })) }, { name: 'a reason for stopping' }),
} as const satisfies Record<string, Validator<unknown>>;

export interface OrchestratorReply {
  understanding?: string;
  plan?: string[];
  thinking?: string;
  createTasks?: { type: string; objective: string; inputs?: string[]; requestedEvidence?: string[]; supersedes?: string }[];
  conclusions?: Record<string, unknown>[];
  build?: boolean;
  askUser?: { question: string; whyNeeded: string }[];
  unresolved?: string[];
  done?: { why: string };
}

/**
 * Whole-envelope shape, kept for callers that want one verdict on a reply.
 * The loop below does NOT use it — see `readReply`.
 */
export const ORCHESTRATOR_REPLY: Validator<OrchestratorReply> = object(
  Object.fromEntries(Object.entries(REPLY_FIELDS).map(([k, v]) => [k, optional(v as Validator<unknown>)])),
  { name: "the lead engineer's reply" },
);

/**
 * Read a reply field by field: what is well-formed is applied, what is not is
 * named. Returns the partial reply and the problems, so the caller can act on
 * the good half and report the bad half in the same breath.
 */
/**
 * Names this contract does not read, and the ones it does.
 *
 * schema.ts has always told a model "you sent `shape`, this contract reads
 * `shapeCode`" for fields INSIDE an object. The envelope had no such courtesy:
 * an unknown top-level key was ignored in silence. Run 020 sent twenty sound
 * conclusions — nine of them the duplicate-exclusion judgements the run
 * existed to get — under `"record"` instead of `"conclusions"`, and every one
 * was dropped without a word.
 *
 * NOTHING IS RENAMED. The alias is named in the refusal and the model re-sends
 * it; guessing that `record` meant `conclusions` is the coercion this whole
 * boundary refuses to do.
 */
const FIELD_ALIASES: Readonly<Record<string, string>> = {
  record: 'conclusions', records: 'conclusions', conclusion: 'conclusions',
  decisions: 'conclusions', established: 'conclusions', establish: 'conclusions',
  tasks: 'createTasks', newTasks: 'createTasks', create_tasks: 'createTasks',
  investigations: 'createTasks',
  questions: 'askUser', ask: 'askUser',
  gaps: 'unresolved', open: 'unresolved',
  finish: 'done', complete: 'done',
};

export function readReply(raw: unknown): { value: OrchestratorReply; problems: Problem[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      value: {},
      problems: [{ path: '', expected: "the lead engineer's reply, as an object", received: describeValue(raw) }],
    };
  }
  const src = raw as Record<string, unknown>;
  const value: Record<string, unknown> = {};
  const problems: Problem[] = [];
  for (const [key, validator] of Object.entries(REPLY_FIELDS) as [string, Validator<unknown>][]) {
    const v = src[key];
    if (v === undefined || v === null) continue;
    const found = validator.check(v, key);
    if (found.length) { problems.push(...found); continue; }
    value[key] = validator.coerce ? validator.coerce(v) : v;
  }

  // a key this contract does not read carried content nobody will ever see —
  // say so, and say what it should have been called when that is knowable
  for (const [key, v] of Object.entries(src)) {
    if (key in REPLY_FIELDS || v === undefined || v === null) continue;
    const meant = FIELD_ALIASES[key];
    problems.push({
      path: key,
      expected: meant
        ? `nothing — this contract reads "${meant}". Re-send that content under "${meant}"; it was NOT applied`
        : `nothing — "${key}" is not a field of this reply, and its content was NOT applied. ` +
          `The fields are: ${Object.keys(REPLY_FIELDS).join(', ')}`,
      received: describeValue(v),
    });
  }
  return { value: value as OrchestratorReply, problems };
}

// ------------------------------------------------------------

export const ORCHESTRATOR_SYSTEM = `You are the senior engineer leading a bar bending schedule for one reinforcement drawing.

Every reply you send is one json object and nothing else — no sentence before it, no note after it.

You do not read the drawing yourself, turn by turn. You decide what needs to be known, send investigators to find it, read what they bring back, and decide what to do next. You are responsible for the schedule being right, and for saying so plainly when the drawing cannot support one.

## HOW A JOB GOES

First, understand what you are looking at and what the job actually is. Then plan. Then investigate — several questions at once where they do not depend on each other. Then read the results and decide: is that enough, or is something still missing or contradictory?

There is NO required order. Ownership before placement, placement before dimensions — none of that is imposed. Work in whatever order the drawing makes sensible, and change your mind when a result tells you to.

## CREATING TASKS

A task is one focused question you want answered, in your own words:

{"createTasks":[
  {"type":"detail-read","objective":"Read the SC typical detail and say which callouts it draws and what each labels",
   "inputs":["REGION-07","MEM-01"],"requestedEvidence":["a crop of the detail with its leaders"]},
  {"type":"layout-extent","objective":"Determine whether the footing layout band is the whole job or a repeated module",
   "inputs":["BAND-01"],"requestedEvidence":["crops of both ends of the band","any note, match line or break symbol"]}]}

TASKS YOU CREATE IN ONE REPLY RUN TOGETHER. Put every independent question in the same reply — that is how a job of this size gets done in a few turns rather than thirty. Only hold a question back when it genuinely depends on another's answer.

An investigator may come back with "I looked and it is still ambiguous". That is a real answer. Decide whether to ask a different question, look somewhere else, or accept that the drawing does not settle it.

## RECORDING WHAT IS ESTABLISHED

When you are satisfied something is true, record it as a conclusion. These are checked against the drawing and the engine's contract, and a conclusion that fails comes back to you naming what was wrong.

RECORD AS YOU GO — IN THE SAME REPLY THAT READS THE RESULTS. A finding is not a conclusion. What an
investigator returns sits on the task board and reaches the engine only when you record it, so the
moment a batch settles something, record that part and investigate the rest in the same breath. Do
not save recording for a final turn: turns run out, a reply that tries to record everything at once
is slow and fragile, and nothing unrecorded is in the schedule. Investigating and recording belong
in the same reply, not in separate phases.

  {"kind":"own","calloutId":"CALL-009","memberId":"MEM-01","basis":"in-detail",
   "barType":"MAIN","distributionAxis":"H","evidenceIds":["CALL-009","DECL-07"],
   "reasoning":"…","confidence":0.9}
      basis            ${OWNERSHIP_BASES.join(' · ')}
      barType          ${BAR_TYPES.join(' · ')}
        These are THIS CONTRACT'S words, not the drawing's. A sheet prints whatever its office
        says — "(LINK)", "(RING)", "COL. REINFT.", or nothing — and none of that is a barType
        until you choose which of the values above describes what the bar DOES. Nothing here
        translates the drawing's word for you, because which one it means is your reading of
        the drawing, not a lookup. If no value fits, record it in unresolved rather than
        picking the nearest-looking one.
      distributionAxis ${AXES.join(' · ')} — the MEMBER'S OWN axes, never sheet x/y/z. Omit if unsure.

  {"kind":"placement","memberId":"MEM-05","placement":{…},"evidenceIds":[…]}
      placement.kind   ${PLACEMENT_KINDS.join(' · ')}
      Each kind carries its OWN required fields — use exactly these shapes:
        {"kind":"continuous","runFactId":"run"} — runs the whole stated run (a wall, a beam along it)
        {"kind":"marks","markEvidenceIds":["MARK-…","…"]} — the drawn layout IS the whole job; its tags are counted
        {"kind":"template-repeat","panelId":"BAND-…","runFactId":"run","orderedOccurrenceIds":["MARK-…","…"]}
            — the drawn layout is ONE MODULE that tiles along the run. The count is derived from the
            panel you NAME: the module's length is measured from ALL marks in that panel, and this
            member contributes its own listed occurrences per module. Name the panel whose marks you
            actually enumerated — a different band carries different marks and gives a different count.
        {"kind":"periodic-pattern","panelId":"…","runFactId":"run","orderedOccurrenceIds":["…"]}
        {"kind":"uniform","pitchRef":{"kind":"entity-number","evidenceId":"DIM-…","part":1},"along":"run",
         "boundaryRule":"both-ends","runFactId":"run"} — at a pitch that is POINTED AT, never typed
        {"kind":"dependent","parentMemberIds":["MEM-…"],"relation":"one-per-parent"}
            — relation: one-per-parent · one-per-bay · same-as-parent. parentMemberIds are MEMBER IDS
            whose own placements must be recorded; the count is derived from theirs.
        {"kind":"once","evidenceId":"…"} — genuinely a one-off, asserted against evidence
      Every id you list must be an id a tool returned — never a description in prose.

  {"kind":"dimension","memberId":"MEM-01","axis":"H","ref":{…}}
      axis ${AXES.join(' · ')}. A dimension is POINTED AT, never typed. The ref is one of:
        {"kind":"entity-number","evidenceId":"DIM-017","part":1} — one printed dimension
        {"kind":"dimension-path","axis":"y","segmentEvidenceIds":["DIM-…","DIM-…","DIM-…"]}
            — several dimensions drawn END TO END, summed as a chain. A section height is often
            stacked as two or three dims rather than printed once; list the dims of the stack and
            the engine verifies they join before it sums. Here "axis" is the SHEET axis the chain
            runs along (x or y), not the member axis. To FIND a stack, call getDimensionChain on
            any one dimension in it: that returns the dimensions which continue it end to end, and
            you choose which of them span the thing you are measuring. fromAnchor/toAnchor are
            optional provenance — evidence ids if you have them, and the chain stands without them.
        {"kind":"difference","a":{"kind":"entity-number",…},"b":{"kind":"entity-number",…}} — the span between two LEVELS
        {"kind":"table-number","tableId":"…","row":0,"column":0,"part":1} — a number in a schedule table
        {"kind":"user-fact","factId":"run"} — a fact the client stated
      Point at what MEASURES the axis you claim: a member's cross-section figure is not its height,
      however near the two are printed.
      A fact the client has stated IS a legitimate source for the axis it answers. When the facts
      list carries an answer for a member axis the sheet does not dimension — a column height, a
      footing depth, a wall height — point that axis at the fact:
        {"kind":"dimension","memberId":"MEM-…","axis":"H","ref":{"kind":"user-fact","factId":"c1_height"}}
      Asking the client again for a fact already in the list, or leaving that axis unresolved, wastes
      the answer they already gave. The engine still computes the number; the fact is its provenance.

  {"kind":"shape","calloutId":"CALL-026","shapeCode":"51"}
      shapeCode ${SHAPE_CODES.join(' · ')}

  {"kind":"exclude","calloutId":"CALL-031","why":"…"} — steel that is not this schedule's to cut
  {"kind":"exclude","memberId":"MEM-07","why":"…"} — a whole member that carries NO scheduled steel
      (a bought or precast item, a thing drawn for context). It stays on the record with your
      reason, and stops being reported as missing bars.

## WHAT YOU ARE ACTUALLY PRODUCING

A READING OF THIS DRAWING, and the schedule falls out of it. The reading is kept as a note that
is written from what you record, and you can see it on every turn: which callouts have gone to
which member and why, how each member repeats, what each of its dimensions was read from, and —
in its own section — everything not yet accounted for.

The note is finished when three things are true:

  every callout is either owned by a member or excluded with a reason. A callout nobody claimed is
    steel the schedule cannot see, and it will not announce itself later;
  every member that owns steel has a placement, because one without a placement counts ZERO
    however much it owns;
  every axis those bars need has been resolved by pointing at the drawing.

You are told at the top of each turn how much of that is done and exactly what is missing. Work
until it is finished, or until you can say honestly WHY a particular gap cannot be closed from
this sheet — an excluded callout with a reason and a recorded unresolved are both complete
answers; silence is not.

## BUILDING

Ask for the schedule when the reading is finished: say {"build":true}. The engine computes every number — counts, lengths, weights — from what you have established. You never state a quantity yourself.

EVERY CALLOUT YOU OWN BECOMES SCHEDULE ROWS FOR THAT MEMBER. So the same physical steel annotated in
two places — a plan and its section, a detail and its elevation — must be owned ONCE: own the
annotation you can best evidence and exclude the other, saying it is the same steel. Two identical
annotations can also be two REAL sets (one on each face of a wall, say); the views decide which it
is, and your reasoning says so. A schedule that is quietly short is the worst thing this job can
produce — and a schedule that counts the same bar twice is the same failure in the other direction.

The build comes back with what it produced AND what it could not. A member with no placement counts ZERO however much steel it owns; a bar whose member has no section cannot be cut. Read those as questions to investigate, not as the end of the job. Create tasks and build again.

You may build more than once.

## WHEN THE DRAWING WILL NOT ANSWER

Say so. {"unresolved":["…"]} records it; {"askUser":[{"question":"…","whyNeeded":"…"}]} puts it to the client. An honest gap is worth more than a confident number, and a schedule that is quietly short is the worst thing this job can produce.

## FINISHING

{"done":{"why":"…"}} when the schedule is as complete as the drawing allows.

## THE ONE THING YOU MUST NOT DO

Do not invent. Not a count, not a spacing, not a dimension, not a length a drawing does not give. If two pieces of evidence disagree, that is a conflict to investigate, not a number to average.`;

// What is actually sent. The harness rules come FIRST and the trade reference
// second, because skillBriefing() ends by saying the instructions above win
// where the two disagree — the order is the tie-break, not decoration.
export const ORCHESTRATOR_SYSTEM_SENT = `${ORCHESTRATOR_SYSTEM}

${skillBriefing()}`;

// ------------------------------------------------------------

/**
 * One region a drawing splitter already cut, as the orchestrator receives it.
 *
 * DELIBERATELY STRUCTURAL, not an import from the splitter module. This file
 * must not depend on how that subsystem is built or where it stores things —
 * a package produced by the live splitter, by a fixture, or by hand all arrive
 * the same way, and a caller adapts whatever it has into this.
 *
 * These are DESCRIPTIONS OF THE SHEET, never engineering conclusions.
 * `memberHints` records "the label C1 is printed in this region" and nothing
 * more; deciding which callouts are C1's steel remains the orchestrator's job,
 * done from evidence, and the briefing says so in as many words.
 */
export interface SectionEvidence {
  sectionId: string;
  label: string;
  kind: string;
  /** millimetres, the same space every crop tool takes */
  bounds: { x1: number; y1: number; x2: number; y2: number };
  entityCount?: number;
  confidence?: number;
  memberHints?: { mark: string; basis: string }[];
  /** a data URL the splitter already rendered; costs nothing to look at again */
  png?: string;
}

export interface OrchestrateOptions {
  doc: CadDocument;
  extract: DrawingExtract;
  /** the client's own words — what they actually asked for */
  objective?: string;
  /** project facts, e.g. { run: { mm: 100000, saidAs: '100 m' } } */
  projectFacts?: Record<string, EngineFact>;
  /**
   * What the CALLER states about how to compute — cover, grades, wastage, the
   * lap multiple. A patch, not a whole settings object: it is layered OVER the
   * drawing's own notes, and anything absent here stays whatever the sheet
   * said (or the default when the sheet is silent).
   */
  settings?: Partial<BbsSettings>;
  /**
   * Values a PERSON typed that replace what the engine would derive — member
   * axes, a bar's diameter or spacing, and the cutting length itself.
   *
   * `buildBbs` has always accepted these and marked the row ENTERED so a typed
   * figure never passes as a derived one. Nothing ever passed them: this call
   * site handed it `undefined`, so the whole facility was unreachable from the
   * product and an answer to "the drawing says ENTER DESIGN LENGTH — what is
   * it?" had nowhere to land. That is the gap between asking a person for a
   * number and the schedule actually using it.
   */
  overrides?: BbsOverrides;
  structureClass?: string;
  /** what a splitter already cut from this sheet, if anything has */
  sections?: readonly SectionEvidence[];
  /** the splitter's own closing description of the sheet */
  sectionSummary?: string;
  /** how the splitter read the sections as relating — its reading, not a verdict */
  sectionRelationships?: readonly { from: string; to: string; kind: string; basis?: string }[];
  /** persisted About Drawing prose; its structured conclusions arrive separately below */
  aboutDrawing?: string;
  /** evidence-addressed conclusions from a current, hash-matched About Drawing artifact */
  priorConclusions?: readonly Record<string, unknown>[];
  /** User-provided files attached to this request, kept distinct from drawing evidence. */
  supplementalEvidence?: readonly { name: string; text: string }[];
  /** User-provided images attached to this request. */
  supplementalImages?: readonly { dataUrl: string; caption: string }[];
  /** the live human interview; null means declined/unavailable and never aborts the run */
  askUser?: (question: AskableQuestion) => Promise<string | null>;
  /** run the separately configured judge model and bounded correction pass */
  independentJudge?: boolean;
  /**
   * COMPUTE ON AN ASSUMED COVER, SAYING SO. The engine's rule is that a cover
   * nobody stated holds every row open and is asked for. A command-line run
   * with nobody to answer would then deliver nothing but the question; with
   * this set, a cover neither the sheet nor a person gave is spent as the
   * project default and every row carries `coverStatus: 'ASSUMED'`, the
   * header says ASSUMED, and the cover question is still raised and listed
   * open. Never set from the studio, where a person is in the loop.
   */
  computeOnAssumedCover?: boolean;
  ask(args: {
    system: string;
    prompt: string;
    images: { dataUrl: string; caption: string }[];
    label: string;
  }): Promise<Record<string, unknown> | null>;
  rasterise?: Rasteriser;
  limits?: Partial<Limits>;
  now?: () => number;
  onEvent?: (e: OrchestratorEvent) => void;
}

/** safety rails. NOT a plan — the orchestrator decides the work, these only stop a runaway. */
export interface Limits {
  maxOrchestratorTurns: number;
  maxTasks: number;
  maxAiCalls: number;
  maxMs: number;
  maxBuilds: number;
  /**
   * How many times the run may go back to the user after rebuilding.
   *
   * More than one because answering can EXPOSE a hole: a member whose H is only
   * required once its L is known has no question worth asking in round 1. It is
   * a rail, not a plan — the loop stops on its own the moment there is nothing
   * fresh to ask.
   */
  maxAskRounds: number;
  /** questions in one batch. The user submits a round in one go, so this is generous. */
  maxQuestionsPerRound: number;
  taskConcurrency: number;
  specialistTurns: number;
  specialistToolCalls: number;
}

const LIMITS: Limits = {
  maxOrchestratorTurns: 12,
  maxTasks: 40,
  maxAiCalls: 80,
  maxMs: 30 * 60 * 1000,
  maxBuilds: 4,
  maxAskRounds: 4,
  maxQuestionsPerRound: 40,
  taskConcurrency: 4,
  specialistTurns: 3,
  specialistToolCalls: 12,
};

export interface OrchestratorEvent {
  kind: string;
  turn?: number;
  taskId?: string;
  detail: string;
}

export interface BuildAttempt {
  n: number;
  rows: number;
  netKg: number | null;
  status: string;
  passed: string[];
  failures: { gate: string; memberMark?: string; field?: string; message: string }[];
  membersWithoutPlacement: string[];
  membersWithoutBars: string[];
  /** members the orchestrator concluded carry no scheduled steel */
  membersExcluded: { mark: string; why: string }[];
  /** what the engine actually computed per member — the dims echoed back are how a mis-pointed height gets noticed */
  memberSummary: {
    mark: string; count?: number; rows: number; kg: number; L?: number; W?: number; H?: number;
    /** where each axis came from — a number nobody can trace is a number nobody can check */
    sources?: Partial<Record<'L' | 'W' | 'H', string>>;
  }[];
  /** one member owning several identical annotations — a question for the lead, never a verdict */
  duplicateSuspects: string[];
  /** members measuring the same on every axis — geometry asking a question, never a verdict */
  axisSuspects: string[];
  /** the engine's own aggregate plausibility voice, verbatim */
  sanity: string[];
}

export interface OrchestrateOutcome {
  result: BbsChatResult;
  /**
   * The ENGINEERING sections this sheet carries — the details, each owning the
   * visual regions it is drawn across. Provenance for anything read from the
   * sheet comes from here (`provenanceFor`), so a fact belongs to a detail and
   * still names the cluster it was read in.
   */
  sections: LogicalSection[];
  understanding?: string;
  plans: string[][];
  board: TaskBoard;
  builds: BuildAttempt[];
  turns: number;
  aiCalls: number;
  toolCalls: number;
  tasksCreated: number;
  tasksBatched: number[];
  imagesRendered: number;
  conclusionsAccepted: number;
  conclusionsRefused: number;
  malformedReplies: number;
  /** validated replies that carried no action at all */
  noopReplies: number;
  /** the reading, rendered — what was understood and what was not */
  note: string;
  /** whether that reading left anything unaccounted for */
  completeness: Completeness;
  /** replies whose bytes could not be read as JSON at all */
  unreadableReplies: number;
  escalations: { question: string; whyNeeded: string }[];
  /**
   * Every value the schedule was built from, with its origin — DRAWING, USER
   * INPUT, DERIVED, PROJECT DEFAULT or MISSING — and the open ones separated
   * out. Read this before the schedule, not after: a wrong input produces a
   * table indistinguishable from a right one.
   */
  factSheet?: FactSheet;
  unresolved: string[];
  stoppedBecause: string;
  ownership: OwnershipResult;
  /** validated evidence decisions, suitable for hash-keyed About Drawing persistence */
  acceptedConclusions: Record<string, unknown>[];
  /** independent second-reader outcomes, when enabled */
  judge?: JudgeOutcome;
  judgeAfterRepair?: JudgeOutcome;
  /**
   * CURRENT DRAWING / DRAWING HASH / FACT VERSION / TOTAL ROWS / CALCULATED /
   * BLOCKED / STALE / MISSING FACTS / UNREADABLE FACTS / reconciliation — the
   * lines printed before the schedule is returned.
   */
  snapshot: string[];
  /** the member dimensions the sheet's schedule tables state — DRAWING_READ facts */
  tableFacts: import('./tableFacts').TableFacts;
}

export async function runOrchestrator(opts: OrchestrateOptions): Promise<OrchestrateOutcome> {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const limits: Limits = { ...LIMITS, ...(opts.limits ?? {}) };

  const graph: EvidenceGraph = buildEvidenceGraph(opts.doc, opts.extract);
  const { bands } = buildPlacementBands(graph);
  const registry: MemberRegistry = buildMemberRegistry(opts.extract, graph);
  const { regions } = detectRegions(graph);
  const userFacts = { ...(opts.projectFacts ?? {}) };
  // The run the JOB has, as opposed to a run on the record. A foundation plan
  // has no run, whatever number was once filed against `run`; only a job with
  // a running member (wall, beam, fence…) reports one, cuts by one, or is
  // gated on one.
  //
  // Two things make a run apply to a member. The STRUCTURE is a running one —
  // a boundary wall's columns and footings repeat along its run, and the
  // drawn band may be a module of it, whatever each member is called. Or the
  // MEMBER is: a plinth beam on a foundation plan has a length its bars run,
  // even though the footings beside it do not. The structure's class is the
  // caller's word when given; otherwise a sheet that schedules a running
  // member is read as a running structure.
  const structureIsLinear = opts.structureClass
    ? isLinearMark(opts.structureClass)
    : registry.members.some((m) => isLinearMark(m.mark, m.declaredAs ?? ''));
  // A member that is neither is left to the layout: `resolveAllPlacements`
  // reads a two-dimensional spread of tags as a plan (the job) and a band as
  // a claim about extent. Hence `undefined`, not `false`, for those.
  //
  // THE SHEET DECIDES FOR THE REST. A drawing on which any mark's tags spread
  // in two dimensions is a PLAN — a building's footings on their grid — and
  // a plan is the whole job by construction. Every non-running member on it
  // is counted from its tags, including one that happens to sit in a single
  // row of the grid and would, judged alone, look like a band. Only a sheet
  // with no such spread anywhere leaves each member to its own layout.
  const sheetIsPlan = (() => {
    const byMark = new Map<string, EvidenceNode[]>();
    for (const n of graph.nodes) {
      if (n.kind !== 'mark' || n.metadata?.inTable === true) continue;
      const mk = String(n.metadata?.mark ?? n.rawText ?? '').trim();
      if (!mk) continue;
      const list = byMark.get(mk) ?? [];
      list.push(n);
      byMark.set(mk, list);
    }
    for (const nodes of byMark.values()) if (isPlanLayout(nodes)) return true;
    return false;
  })();
  const runAppliesToMember = (m: { mark: string; declaredAs?: string }): boolean | undefined =>
    structureIsLinear || isLinearMark(m.mark, m.declaredAs ?? '') ? true : sheetIsPlan ? false : undefined;
  const runMmForJob = (): number | undefined =>
    registry.members.some((m) => runAppliesToMember(m) === true) ? userFacts.run?.mm : undefined;

  // bands are addressable as panels, exactly as placement.ts expects
  const graphWithBands: EvidenceGraph = {
    ...graph,
    byId: new Map([
      ...graph.byId,
      ...bands.map((b): [string, never] => [b.id, { id: b.id, kind: 'panel', sourceHandles: [], metadata: {} } as never]),
    ]),
    inPanel: (pid: string) => {
      const band = bands.find((x) => x.id === pid);
      return band ? band.occurrenceIds.map((id) => graph.byId.get(id)).filter((n): n is NonNullable<typeof n> => !!n) : [];
    },
  } as EvidenceGraph;

  // `sections` is filled once the schedule table has been read — see below.
  const toolCtx: ToolContext = { graph, registry, bands, userFacts, doc: opts.doc, regions, rasterise: opts.rasterise };
  const calloutIds = new Set(graph.nodes.filter((n) => n.kind === 'callout').map((n) => n.id));
  const ledgers = new Ledgers();

  // ---- what the orchestrator has established ----
  const claims: OwnershipClaim[] = [];
  const excluded: { calloutId: string; reason: string }[] = [];
  /**
   * The inputs of the most recent build, with their origins. Kept so the
   * outcome can carry them: a schedule is only checkable against the facts it
   * was built from, and by the time the rows exist those facts are spent.
   */
  let lastFactSheet: FactSheet | undefined;
  /** members the orchestrator concluded carry no scheduled steel — kept on the record, never silently dropped */
  const memberExclusions = new Map<string, { mark: string; why: string }>();
  const placements = new Map<string, MemberPlacement>();
  const dims = new Map<string, Partial<Record<'L' | 'W' | 'H', number>>>();
  /**
   * Where each resolved axis came from, per member.
   *
   * Run 020 finished with SC, C1 and C2 all carrying H = 350 — a
   * cross-section pointed at as a height — and every gate passed, because
   * `H is resolved` was true. The build echoed the number back and the lead
   * read straight past it. A number alone cannot be checked; the evidence it
   * was read from can, so the working is carried and shown.
   */
  const dimSources = new Map<string, Partial<Record<'L' | 'W' | 'H', string>>>();
  const shapes = new Map<string, ShapeCode>();
  const escalations: { question: string; whyNeeded: string }[] = [];
  const unresolved: string[] = [];
  const acceptedConclusions: Record<string, unknown>[] = [];
  const conclusionKeys = new Set<string>();
  /**
   * The DEPENDENCIES already put to a person this run — the fact each question
   * writes to, not the question's id (askFrom.ts `dependencyKeyOf`).
   *
   * Nine members failing the extent gate mint nine question ids and one
   * dependency, `wall.total_run`. Keyed by id this set deduplicated nothing
   * and the same question went out nine times.
   */
  const askedDependencies = new Set<string>();

  const board = new TaskBoard();
  const imageCache = new Map<string, { dataUrl: string; caption: string; imageId: string }>();
  const plans: string[][] = [];
  const builds: BuildAttempt[] = [];
  const events: OrchestratorEvent[] = [];
  const emit = (e: OrchestratorEvent): void => { events.push(e); opts.onEvent?.(e); };

  let understanding: string | undefined;
  /** the most recent build's artefacts, so the outcome can carry them */
  let lastResult: BbsChatResult | undefined;
  /** the engine result behind it — the rows with their stage traces */
  let lastEngine: ReturnType<typeof buildBbs> | undefined;
  let lastOwnership: OwnershipResult | undefined;
  /** how each placement last resolved, in the engine's words — for the note */
  let lastPlacementWorking: Map<string, string> | undefined;
  let aiCalls = 0;
  let toolCalls = 0;
  let tasksCreated = 0;
  const tasksBatched: number[] = [];
  let conclusionsAccepted = 0;
  let conclusionsRefused = 0;
  let malformedReplies = 0;
  let noopReplies = 0;
  let unreadableReplies = 0;
  /** consecutive turns whose reply never arrived — a dead line, not a bad answer */
  let unreachableStreak = 0;
  let stoppedBecause = 'the orchestrator finished';
  let turn = 0;

  // WHAT THE SHEET'S OWN SCHEDULE TABLES STATE — read once, deterministically.
  //
  // A FOOTING SCHEDULE row "F8 | 3200 | 3500 | 575" under "W SIZE | L |
  // DEPTH D" is the drawing stating F8's plan size and depth, with exactly the
  // authority of any declared dimension and more than a pointer at a stray
  // dimension string. These are the latest validated DRAWING_READ facts for
  // every axis they state, and `buildOnce` resolves member dimensions from
  // them FIRST. The bar cells map onto the callouts they hold, so a column
  // headed "a(LONG BAR)" fixes the axis its bar runs along.
  const tableFacts = memberFactsFromTables(opts.extract);
  const tableDims = tableDimsByMark(tableFacts);
  const tableCells = tableCellsForCallouts(opts.extract, tableFacts);

  // THE ENGINEERING BOUNDARY. Regions are where the ink clusters; sections are
  // what the clusters describe. A detail drawn as four separated clusters is
  // ONE section owning four regions — so a callout in one and the dimension
  // that completes it in another are the same detail, and neither is orphaned.
  //
  // A bare callout names nobody; the schedule row it is printed in does. That
  // mapping is passed in, because it is the difference between clusters of
  // orphaned callouts and details that each belong to a member.
  const marksByEvidence = new Map<string, string[]>();
  {
    const byHandle = new Map<string, string>();
    for (const node of graph.nodes) {
      for (const handle of node.sourceHandles ?? []) byHandle.set(handle, node.id);
    }
    for (const [handle, cell] of tableCells) {
      const id = byHandle.get(handle) ?? handle;
      if (!cell.mark) continue;
      marksByEvidence.set(id, [...new Set([...(marksByEvidence.get(id) ?? []), cell.mark])]);
    }
  }
  const { sections: logicalSections, diagnostics: sectionDiagnostics } = groupRegions(regions, graph, {
    marksFor: (id) => marksByEvidence.get(id),
  });
  toolCtx.sections = logicalSections;
  // A grouping made on proximity alone is a weaker claim than one made on a
  // shared mark or a leader, and it goes on the record as such rather than
  // being presented as read.
  for (const section of logicalSections) {
    if (section.relation === 'POSSIBLE_CONTINUATION') {
      unresolved.push(
        `${section.id}${section.title ? ` "${section.title}"` : ''} groups ${section.regionIds.join(', ')} with at least ` +
          'one part joined on proximity alone (POSSIBLE_CONTINUATION) — confirm the grouping before anything rests on it',
      );
    }
  }
  for (const line of sectionDiagnostics) unresolved.push(`sections: ${line}`);
  for (const note of tableFacts.notes) unresolved.push(`schedule table: ${note}`);

  // A CALLOUT PRINTED IN A MEMBER'S OWN SCHEDULE ROW BELONGS TO THAT MEMBER.
  //
  // The table names the member in its mark column and the bar in the cell;
  // that is ownership stated by the sheet, and the strongest tier of evidence
  // there is. Seeding it here is what lets a run finish: the last live run
  // spent its whole model budget establishing, one callout at a time, what
  // the table had already printed, and delivered 12 rows of 34. The model
  // may still refine (bar type, axis) — a later `own` conclusion for the same
  // callout is ranked against this one by ownership.ts, never silently over
  // it. Generic: any table with a mark column and bar cells seeds this way.
  {
    const calloutIdByHandle = new Map<string, string>();
    for (const n of graph.nodes) {
      if (n.kind !== 'callout') continue;
      for (const h of n.sourceHandles ?? []) calloutIdByHandle.set(h, n.id);
    }
    let seeded = 0;
    for (const [handle, cell] of tableCells) {
      const calloutId = calloutIdByHandle.get(handle);
      const member = registry.resolve(cell.mark) ?? registry.byId.get(cell.mark);
      if (!calloutId || !member) continue;
      claims.push({
        calloutId,
        memberId: member.id,
        basis: 'in-detail',
        reason: `printed in the schedule row that names ${member.mark}: ${cell.source}`,
        barType: cell.barType ?? (cell.layer ?? 'MAIN'),
        distributionAxis: cell.runsAlong ? distributionAxisFor(cell.runsAlong) : undefined,
      });
      ledgers.calloutOffered(calloutId, member.id);
      seeded += 1;
    }
    if (seeded) emit({ kind: 'table-ownership', detail: `${seeded} callout(s) tied to the member their schedule row names` });
  }
  /** disagreements between a table cell and a pointer, said once each */
  const tableOverrides = new Set<string>();
  /**
   * Set whenever an input the build reads has changed since the last build —
   * an answer applied, a conclusion accepted, a judge correction adopted.
   * The run never returns a schedule computed without them: a final rebuild
   * happens if this is true, whatever the rebuild budget says. `buildOnce`
   * is deterministic and spends no model call.
   */
  let dirtySinceBuild = false;

  const rememberConclusion = (raw: Record<string, unknown>): void => {
    dirtySinceBuild = true;
    const copy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    const key = JSON.stringify(copy);
    if (conclusionKeys.has(key)) return;
    conclusionKeys.add(key);
    acceptedConclusions.push(copy);
  };

  // About Drawing is a head start, never inherited truth. Every saved
  // conclusion crosses the same validators and evidence resolvers as a fresh
  // model conclusion; stale ids or changed geometry are refused individually.
  for (const prior of opts.priorConclusions ?? []) {
    try {
      const applied = applyConclusion(prior);
      if (applied.ok) {
        rememberConclusion(prior);
        conclusionsAccepted += 1;
      } else {
        conclusionsRefused += 1;
        unresolved.push(`saved About Drawing conclusion was not reusable: ${applied.objection ?? 'it no longer validates'}`);
      }
    } catch (err) {
      conclusionsRefused += 1;
      unresolved.push(`saved About Drawing conclusion could not be loaded: ${(err as Error).message}`);
    }
  }

  const briefing = openingBriefing();
  const transcript: string[] = [];
  let feedback = '';

  // ------------------------------------------------------------
  for (turn = 1; turn <= limits.maxOrchestratorTurns; turn++) {
    if (now() - startedAt > limits.maxMs) { stoppedBecause = 'the time limit was reached'; break; }
    if (aiCalls >= limits.maxAiCalls) { stoppedBecause = 'the API call limit was reached'; break; }

    aiCalls += 1;
    const raw = await opts.ask({
      system: ORCHESTRATOR_SYSTEM_SENT,
      prompt: [
        briefing,
        '',
        '--- WHERE THE JOB STANDS ---',
        understanding ? `Your understanding: ${understanding}` : '(you have not yet said what you make of this drawing)',
        '',
        'TASKS',
        board.render(),
        '',
        establishedBlock(),
        builds.length ? `\nBUILDS SO FAR\n${builds.map(renderBuild).join('\n')}` : '',
        transcript.length ? `\nNOTES\n${transcript.slice(-12).map((t) => `  ${t}`).join('\n')}` : '',
        feedback ? `\n${feedback}` : '',
        '',
        `Turn ${turn} of ${limits.maxOrchestratorTurns}. ${aiCalls}/${limits.maxAiCalls} model calls used, ${board.all().length}/${limits.maxTasks} tasks created. ` +
          // RUN 013's lead never saw a clock — it budgeted turns while the
          // MINUTES ran out. A lead that cannot see the time cannot manage it.
          `TIME: ${Math.floor((now() - startedAt) / 60000)} min used of ${Math.round(limits.maxMs / 60000)} — ` +
          `${Math.max(0, Math.round((limits.maxMs - (now() - startedAt)) / 60000))} min remain. Investigations stop at the deadline; budget your batches.`,
      ].filter(Boolean).join('\n'),
      images: turn === 1 ? sectionImages() : [],
      label: 'orchestrator',
    });
    feedback = '';

    // A REPLY THAT COULD NOT BE READ MUST STILL BE ANSWERED.
    //
    // This branch used to `continue` in silence: the transcript gained a line
    // nobody acts on, `feedback` stayed empty, and the next turn opened as if
    // the last had never happened. Run 019 lost two consecutive recording
    // turns that way — twelve thousand characters of conclusions each — and
    // the lead's third reply repeated the second almost verbatim, because
    // nothing had told it the first was never received.
    if (!raw) {
      transcript.push(`turn ${turn}: no reply from the model`);
      unreadableReplies += 1;
      unreachableStreak += 1;
      // A RUN AGAINST A DEAD LINE SHOULD STOP, NOT SPEND ITS TURNS.
      // Run 038 lost every one of its twelve turns to `fetch failed` in a
      // network outage, retrying into the same silence for ten minutes and
      // reporting at the end as though the model had simply said nothing
      // useful. Repeated silence is a different fact from a bad answer, and
      // it is worth saying quickly.
      if (unreachableStreak >= 4) {
        stoppedBecause =
          `the model could not be reached — ${unreachableStreak} turns in a row brought back nothing readable. ` +
          'This is a connection or provider failure, not a disagreement about the drawing: nothing recorded so ' +
          'far is wrong, and the run stopped rather than spend its remaining turns on a line that is not answering.';
        emit({ kind: 'unreachable', turn, detail: `${unreachableStreak} consecutive turns with no reply` });
        break;
      }
      feedback = [
        // THREE SITUATIONS SHARE THIS BRANCH and the message must fit all of
        // them: the request failed, the reply came back empty, or its bytes
        // could not be read as JSON. Run 022's was the empty one — 165 seconds
        // and no content at all — and saying flatly "your JSON was unreadable"
        // would have blamed the model for something it may not have done.
        'YOUR LAST REPLY NEVER REACHED ME — it failed in transport, came back empty, or could not',
        'be read as JSON. None of it was applied, including anything you recorded in it. This is',
        'not a refusal: nothing in it was judged, because nothing in it arrived.',
        'Send it again as ONE json object and nothing else — no sentence before it, no note after it.',
        'If it was long, send it in two turns rather than one: half the conclusions now, half next.',
      ].join('\n');
      emit({ kind: 'unreadable', turn, detail: 'no JSON object could be parsed from the reply' });
      continue;
    }

    // FIELD BY FIELD. What is well-formed is applied; what is not is named,
    // and the two facts are reported together — a bad `plan` no longer
    // discards the conclusions sent beside it.
    unreachableStreak = 0;
    const { value: reply, problems } = readReply(raw);
    const applied = Object.keys(reply);
    // A reply that is ONE conclusion or ONE task, unwrapped, reads to the
    // field-by-field pass as a heap of unknown keys — true, and much less
    // useful than naming the shape it plainly is. The specific message below
    // handles those; this pass stands aside so it can.
    const bareShape = (raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (() => {
          const o = raw as Record<string, unknown>;
          return (typeof o.kind === 'string' &&
              ['own', 'placement', 'dimension', 'shape', 'exclude'].includes(o.kind)) ||
            (typeof o.type === 'string' && typeof o.objective === 'string');
        })()
      : false);
    if (problems.length && !(bareShape && !applied.length)) {
      malformedReplies += 1;
      feedback = [
        applied.length
          ? `PART OF YOUR LAST REPLY WAS APPLIED: ${applied.join(', ')}. The rest was not:`
          : 'YOUR LAST RESPONSE DID NOT MATCH THE CONTRACT. Nothing in it was applied.',
        ...problems.slice(0, 8).map(
          (p) => `  ${p.path || '(the whole response)'} — expected ${p.expected}; received ${p.received}`,
        ),
        problems.length > 8 ? `  …and ${problems.length - 8} more of the same kind` : '',
        applied.length
          ? 'Re-send ONLY those fields, corrected. Do not repeat what was already applied.'
          : 'Fix those fields and send the response again. Nothing was assumed on your behalf.',
      ].filter(Boolean).join('\n');
      emit({ kind: 'malformed', turn, detail: problems.map((p) => p.path).join(', ') });
      if (!applied.length) continue;
    }

    // A WELL-TYPED REPLY THAT DOES NOTHING IS STILL A WASTED TURN.
    //
    // Run 013's first turn was the system prompt's own worked example echoed
    // back — literal "…" and all — and it sailed through the schema, because
    // every field here is optional and an object carrying none of them is
    // perfectly typed. Types were checked; EFFECT never was. This is the
    // effect check: infrastructure only — it insists a turn does something,
    // and says nothing about what.
    const acted =
      Boolean(reply.understanding) || Boolean(reply.plan?.length) ||
      Boolean(reply.createTasks?.length) || Boolean(reply.conclusions?.length) ||
      reply.build === true || Boolean(reply.askUser?.length) ||
      Boolean(reply.unresolved?.length) || Boolean(reply.done);
    if (!acted) {
      noopReplies += 1;
      // A REPLY THAT IS A CONCLUSION, UNWRAPPED, IS NOT A REPLY THAT DID
      // NOTHING — and telling it so is the difference between recovering and
      // degenerating. Run 016's turn 10 sent one bare `own` conclusion as the
      // whole reply; the generic "no action" message named nothing it could
      // act on, and turns 11 and 12 decayed to {"createTasks":[]} and {}.
      // Recognising the shape decides no engineering meaning: it only says
      // which envelope the thing it plainly sent belongs in.
      const bare = raw as Record<string, unknown>;
      const looksLikeConclusion =
        typeof bare.kind === 'string' &&
        ['own', 'placement', 'dimension', 'shape', 'exclude'].includes(bare.kind);
      // the same slip, one envelope over: Run 020's first turn sent a single
      // task object rather than a createTasks list, and lost the turn to a
      // message that named nothing
      const looksLikeTask = typeof bare.type === 'string' && typeof bare.objective === 'string';
      feedback = [
        feedback,
        looksLikeTask
          ? [
              'YOUR LAST REPLY CONTAINED NO ACTION — nothing was recorded, and the turn was spent.',
              'It was a single task sent on its own. A task never stands as the whole reply — it goes',
              'in the "createTasks" list, with any others you want run at the same time:',
              `  {"createTasks":[${JSON.stringify(bare).slice(0, 160)}${JSON.stringify(bare).length > 160 ? '…' : ''}]}`,
              'Worked examples in the instructions are EXAMPLES — do not echo them back.',
            ].join('\n')
        : looksLikeConclusion
          ? [
              'YOUR LAST REPLY CONTAINED NO ACTION — nothing was recorded, and the turn was spent.',
              `It was a single ${String(bare.kind).toUpperCase()} conclusion sent on its own. A conclusion never stands as`,
              'the whole reply — it goes in the "conclusions" list:',
              `  {"conclusions":[${JSON.stringify(bare).slice(0, 160)}${JSON.stringify(bare).length > 160 ? '…' : ''}]}`,
              'Send it again that way, with any others you have, in one reply.',
              'Worked examples in the instructions are EXAMPLES — do not echo them back.',
            ].join('\n')
          : [
              'YOUR LAST REPLY CONTAINED NO ACTION — nothing was recorded, and the turn was spent.',
              'Every turn must do at least one of: state your understanding, give a plan, createTasks,',
              'record conclusions, set build:true, askUser, record unresolved, or done.',
              'Worked examples in the instructions are EXAMPLES — do not echo them back.',
            ].join('\n'),
      ].filter(Boolean).join('\n');
      emit({ kind: 'noop', turn, detail: 'reply carried no action' });
      continue;
    }

    if (reply.understanding) understanding = reply.understanding;
    if (reply.plan?.length) { plans.push(reply.plan); emit({ kind: 'plan', turn, detail: `${reply.plan.length} step(s)` }); }
    if (reply.thinking) transcript.push(`turn ${turn}: ${reply.thinking}`);
    const raised = reply.askUser ?? [];
    for (const q of raised) escalations.push(q);
    if (opts.askUser && raised.length) {
      const questions = raised
        .map((q, i) => escalationQuestion(q, {
          id: `orchestrator:${turn}:${i}:${q.question.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
          marks: registry.members.map((m) => m.mark),
        }))
        .filter((q): q is AskableQuestion => q !== null);
      await askAndApply(questions);
    }
    unresolved.push(...(reply.unresolved ?? []));

    // ---- conclusions it wants recorded ----
    for (const c of reply.conclusions ?? []) {
      // CONTAINED. Five runs died when one malformed conclusion crossed this
      // seam and threw levels deeper; a residual throw is now a refusal with
      // the message, never a dead run.
      let v: { ok: boolean; objection?: string };
      try {
        v = applyConclusion(c as Record<string, unknown>);
      } catch (err) {
        v = {
          ok: false,
          objection:
            `an internal check crashed on this conclusion — ${(err as Error).message}. ` +
            'The conclusion was not recorded; everything else this turn was.',
        };
        emit({ kind: 'conclusion-crash', turn, detail: (err as Error).message });
      }
      if (v.ok) {
        conclusionsAccepted += 1;
        rememberConclusion(c as Record<string, unknown>);
      } else {
        conclusionsRefused += 1;
        transcript.push(`REFUSED ${JSON.stringify(c).slice(0, 100)} — ${v.objection}`);
      }
    }

    // ---- tasks it created ----
    const fresh: Task[] = [];
    for (const spec of reply.createTasks ?? []) {
      if (board.all().length >= limits.maxTasks) { transcript.push('task limit reached — no more tasks can be created'); break; }
      const t = board.create({
        type: spec.type,
        objective: spec.objective,
        inputs: spec.inputs ?? [],
        requestedEvidence: spec.requestedEvidence ?? [],
        supersedes: spec.supersedes,
        status: 'pending',
      }, turn);
      fresh.push(t);
      tasksCreated += 1;
    }

    if (fresh.length) {
      tasksBatched.push(fresh.length);
      emit({ kind: 'dispatch', turn, detail: `${fresh.length} task(s) in one batch` });
      for (const t of fresh) t.status = 'running';
      const results = await runBatch(fresh, {
        toolCtx,
        briefing,
        ask: opts.ask,
        imageCache,
        maxTurns: limits.specialistTurns,
        maxToolCalls: limits.specialistToolCalls,
        now,
        // one closing minute is RESERVED (half the budget on a tiny one), so
        // however a batch goes, the lead always gets the review turn Run 013
        // never had
        deadline: startedAt + Math.max(limits.maxMs - 60_000, Math.floor(limits.maxMs / 2)),
        onEvent: (e) => emit({ kind: e.kind, turn, taskId: e.taskId, detail: e.detail }),
      }, limits.taskConcurrency);
      for (const r of results) {
        board.record(r.taskId, r);
        aiCalls += r.aiCalls;
        toolCalls += r.toolCalls;
        if (r.malformed) malformedReplies += 1;
      }
    }

    // ---- build, when it says so ----
    if (reply.build === true) {
      if (builds.length >= limits.maxBuilds) {
        transcript.push('the build limit was reached — no further rebuilds are possible');
      } else {
        // CONTAINED, like the conclusions. Run 014's dependent-without-parents
        // detonated inside this call and took the whole run with it — the crash
        // is now an attempt that FAILED, which the orchestrator reads and reacts to.
        let attempt: BuildAttempt;
        try {
          attempt = buildOnce(builds.length + 1);
        } catch (err) {
          attempt = crashedBuild(builds.length + 1, err as Error);
          emit({ kind: 'build-crash', turn, detail: (err as Error).message });
        }
        builds.push(attempt);
        emit({ kind: 'build', turn, detail: `${attempt.rows} row(s), ${attempt.failures.length} verification failure(s)` });
      }
    }

    if (reply.done) { stoppedBecause = reply.done.why; break; }
  }

  // the for-loop leaves `turn` one past the end when it runs to completion
  if (turn > limits.maxOrchestratorTurns) {
    stoppedBecause =
      limits.maxOrchestratorTurns === 0
        ? 'recalculated from memory — no model turn was spent'
        : 'the turn limit was reached';
    turn = limits.maxOrchestratorTurns;
  }

  // A final build — so a run that stopped mid-thought still reports what it
  // had, AND so that no schedule is ever returned computed without an input
  // that changed after the last build. The F8 rows on the foundations sheet
  // went out "needs F8.length" with the user's 3500 sitting in `dims`: the
  // answer arrived on the last turn, the rebuild budget was spent, and the
  // schedule from BEFORE the answer was published as current. `buildOnce` is
  // deterministic and costs no call; a stale schedule costs the whole run.
  if (!builds.length || dirtySinceBuild) {
    try {
      const attempt = buildOnce(builds.length + 1);
      builds.push(attempt);
      if (builds.length > 1) {
        emit({
          kind: 'build-after-change',
          detail: `inputs changed since the last build — rebuilt ${attempt.rows} row(s), ${attempt.failures.length} verification failure(s)`,
        });
      }
    } catch (err) {
      builds.push(crashedBuild(builds.length + 1, err as Error));
      emit({ kind: 'build-crash', detail: (err as Error).message });
    }
  }

  // A deterministic failure is a question for a person, not merely a line filed
  // after the run. EVERY numeric hole goes out as one batch, the schedule is
  // rebuilt on the answers, and the batch is raised again if rebuilding exposed
  // holes that were invisible before.
  //
  // WHY THIS IS A LOOP, AND WHY IT IGNORES `maxBuilds`
  //
  // It used to be one round of at most EIGHT questions, skipped entirely once
  // `builds.length` reached `maxBuilds`. Both ceilings put a schedule in the
  // user's hands with open rows and a question nobody had asked them:
  //
  //   · a ninth missing axis was never raised, and nothing came back to it
  //   · a run whose model had spent its rebuild budget asked nothing at all,
  //     even though the user was sitting there ready to answer
  //
  // `maxBuilds` exists to stop the orchestrator burning AI turns on rebuild
  // churn. `buildOnce` is deterministic and costs no call, so a rebuild the
  // USER paid for with an answer is not what that budget is rationing.
  //
  // Termination does not rest on the round cap: `questionsFrom` already drops
  // everything in `askedDependencies`, so a round with nothing fresh to ask ends
  // the loop, and so does a user who stops answering.
  if (opts.askUser) {
    for (let round = 1; round <= limits.maxAskRounds; round++) {
      if (!lastResult) break;
      const failures = lastResult.verification.failures;
      const questions = questionsFrom(failures, new Map(), {
        max: limits.maxQuestionsPerRound,
        alreadyAsked: askedDependencies,
      }).filter(
        (q) =>
          q.answerType === 'number-mm' ||
          q.answerType === 'number-m' ||
          q.answerType === 'number-count',
      );

      // A STALLED PLACEMENT IS THE BIGGEST SINGLE SOURCE OF OPEN ROWS, and it
      // was the one thing never asked about. `questionFrom` types it as a
      // six-option taxonomy — the right question for a model reading a layout,
      // the wrong one for a person, who knows the answer as a number. Asked as
      // a count it becomes an answer the engine can act on.
      for (const f of failures) {
        if (questions.length >= limits.maxQuestionsPerRound) break;
        if (f.field !== 'placement' || !f.memberMark) continue;
        const q = countQuestion(f.memberMark, { evidence: [f.message] });
        if (askedDependencies.has(dependencyOf(q)) || questions.some((x) => dependencyOf(x) === dependencyOf(q))) continue;
        questions.push(q);
      }
      // A COVER NOBODY STATED IS ASKED FOR, NOT ASSUMED IN SILENCE. Every row
      // cut to the project default is only as right as that figure, and every
      // row held open for want of it is waiting on exactly this answer. It is
      // put once, with the figure the run would otherwise rest on.
      // (Disputed axes — a length under its own anchorage — arrive through
      // `questionsFrom` as the anchorage gate's own question.)
      const coverUsed = lastResult.settings;
      if (
        coverUsed &&
        (lastResult.settingSources?.coverMm ?? coverUsed.coverSource) === 'default' &&
        questions.length < limits.maxQuestionsPerRound
      ) {
        const q = coverQuestion(coverUsed.coverMm);
        if (!askedDependencies.has(dependencyOf(q)) && !questions.some((x) => dependencyOf(x) === dependencyOf(q))) {
          questions.push(q);
        }
      }
      if (!questions.length) break;
      const applied = await askAndApply(questions);
      if (applied === 0) break;
      try {
        const attempt = buildOnce(builds.length + 1);
        builds.push(attempt);
        emit({
          kind: 'build-after-answer',
          detail:
            `round ${round}: ${applied} answer(s) applied — ` +
            `${attempt.rows} row(s), ${attempt.failures.length} verification failure(s)`,
        });
      } catch (err) {
        builds.push(crashedBuild(builds.length + 1, err as Error));
        break;
      }
    }
  }

  let judge: JudgeOutcome | undefined;
  let judgeAfterRepair: JudgeOutcome | undefined;
  // A recalculation from memory (no model budget) has no judge: the judge is
  // a paid call, and nothing it could dispute has changed since it last ran.
  const judgeAllowed = opts.independentJudge && limits.maxAiCalls > 0 && limits.maxOrchestratorTurns > 0;
  if (judgeAllowed && lastResult && lastResult.rows.length) {
    judge = await runIndependentJudge();
    aiCalls += 1;
    emit({ kind: 'judge', detail: judge.ok ? `verdict ${judge.reply?.verdict ?? 'unknown'}` : judge.problem ?? 'no verdict' });

    if (judge.ok && judge.reply?.verdict === 'disputed' && builds.length < limits.maxBuilds) {
      let adopted = 0;
      const unusable = new Set((judge.unusableCorrections ?? []).map((x) => x.correction));
      for (const dispute of judge.reply.disputes ?? []) {
        if (!dispute.correction || unusable.has(dispute.correction)) continue;
        try {
          const raw = JSON.parse(dispute.correction) as Record<string, unknown>;
          const applied = applyConclusion(raw);
          if (applied.ok) {
            rememberConclusion(raw);
            conclusionsAccepted += 1;
            adopted += 1;
          } else {
            unresolved.push(`judge correction for ${dispute.memberMark ?? dispute.subject} was refused: ${applied.objection}`);
          }
        } catch {
          unresolved.push(`judge correction for ${dispute.memberMark ?? dispute.subject} was not usable JSON`);
        }
      }
      if (adopted > 0) {
        try {
          const attempt = buildOnce(builds.length + 1);
          builds.push(attempt);
          emit({ kind: 'judge-repair', detail: `${adopted} correction(s) adopted; rebuilt ${attempt.rows} row(s)` });
          judgeAfterRepair = await runIndependentJudge();
          aiCalls += 1;
          emit({ kind: 'judge-after-repair', detail: judgeAfterRepair.ok ? `verdict ${judgeAfterRepair.reply?.verdict ?? 'unknown'}` : judgeAfterRepair.problem ?? 'no verdict' });
        } catch (err) {
          builds.push(crashedBuild(builds.length + 1, err as Error));
        }
      }
    }

    const finalJudge = judgeAfterRepair ?? judge;
    if (!finalJudge.ok || finalJudge.reply?.verdict !== 'sound') {
      const message = !finalJudge.ok
        ? `Independent verification could not complete: ${finalJudge.problem ?? 'no usable verdict'}`
        : finalJudge.reply?.verdict === 'cannot-tell'
          ? `Independent verifier could not confirm the reading: ${finalJudge.reply.answer}`
          : `Independent verifier disputes the reading: ${finalJudge.reply?.answer ?? 'see the judge disputes'}`;
      unresolved.push(message);
      if (lastResult) {
        lastResult = {
          ...lastResult,
          status: 'partial',
          warnings: [...lastResult.warnings, { message }],
        };
      }
    }
  }

  const final = lastResult ?? emptyChatResult();

  return {
    result: final,
    understanding,
    plans,
    board,
    builds,
    turns: turn,
    aiCalls,
    toolCalls,
    tasksCreated,
    tasksBatched,
    imagesRendered: imageCache.size,
    conclusionsAccepted,
    conclusionsRefused,
    malformedReplies,
    noopReplies,
    unreadableReplies,
    note: currentNote(),
    completeness: currentCompleteness(),
    escalations,
    // Undefined when no build ran at all — there were no inputs to list.
    ...(lastFactSheet ? { factSheet: lastFactSheet } : {}),
    unresolved,
    stoppedBecause,
    ownership:
      lastOwnership ?? resolveOwnership({ allCalloutIds: [...calloutIds], claims, shared: [], excluded }),
    acceptedConclusions,
    judge,
    judgeAfterRepair,
    snapshot: scheduleSnapshot({
      drawing: opts.extract.drawingName,
      drawingHash: opts.extract.hash ?? 'not computed for this run',
      factVersion: `${Object.keys(userFacts).length} project fact(s) + ${tableFacts.dims.length} table fact(s)`,
      rows: lastEngine?.rows ?? [],
      reconciliation: lastEngine?.reconciliation,
    }),
    sections: logicalSections,
    tableFacts,
  };

  // ------------------------------------------------------------

  function openingBriefing(): string {
    const run = userFacts.run;
    return [
      `THE JOB: ${opts.objective ?? 'produce a defensible bar bending schedule from this drawing.'}`,
      `DRAWING: ${opts.extract.drawingName}`,
      run
        ? `PROJECT RUN: ${run.mm} mm${run.saidAs ? ` (${run.saidAs})` : ''} — this is a PROJECT FACT the client gave. It is NOT a length measured anywhere on the sheet.`
        : 'PROJECT RUN: none was supplied.',
      '',
      `The sheet establishes ${registry.members.length} member(s): ${registry.members.map((m) => `${m.id} "${m.mark}"${m.declaredAs ? ` (declared "${m.declaredAs}")` : ''} tagged ${m.markEvidenceIds.length}×`).join('; ')}`,
      `It carries ${calloutIds.size} reinforcement callout(s), ${graph.nodes.filter((n) => n.kind === 'leader').length} leader(s) and ${graph.dimensions.length} readable dimension(s).`,
      '',
      `SECTIONS — the engineering details this sheet carries (${logicalSections.length}).`,
      'A section is the unit that means something: one detail, however many separated',
      'clusters the drafter drew it as. Read a section WHOLE — its dimensions, its',
      'callouts and its notes may sit in different clusters and are still one detail.',
      renderSections(logicalSections),
      '',
      `The ${regions.length} visual REGION(s) those sections are drawn across — use these to crop and re-read,`,
      'never as the boundary of a detail:',
      renderRegions(regions),
      '',
      `LAYOUT BANDS of repeated marks (${bands.length}):`,
      ...bands.map((b) => {
        const box = bandViewBox(b, graph);
        return `  ${b.id} axis ${b.axis} drawn extent ${Math.round(b.longitudinalRange[1] - b.longitudinalRange[0])} mm carries ${JSON.stringify(b.tally)}` +
          `\n      bounds {x1:${Math.round(box.x1)},y1:${Math.round(box.y1)},x2:${Math.round(box.x2)},y2:${Math.round(box.y2)}} — a crop of this shows the layout`;
      }),
      '',
      'LEADERS: extraction resolved the target of ' +
        `${graph.nodes.filter((n) => n.kind === 'leader' && graph.related(n.id, 'points-at').length).length} of ` +
        `${graph.nodes.filter((n) => n.kind === 'leader').length}. Where a target is unresolved the arrowhead IS drawn — it did not survive parsing, so a tool will keep returning nothing and a crop will show it.`,
      '',
      sectionsBlock(),
      opts.supplementalEvidence?.length
        ? [
            '',
            'USER-ATTACHED EVIDENCE (client-provided context, not dimensions measured from the DXF):',
            ...opts.supplementalEvidence.map((item) => `--- ${item.name} ---\n${item.text}`),
            '',
          ].join('\n')
        : '',
      opts.aboutDrawing ? `\n${opts.aboutDrawing}\n` : '',
      'TOOLS available to you and to anyone you send:',
      renderToolMenu(),
    ].join('\n');
  }

  /**
   * What a splitter already cut, handed over as a head start.
   *
   * A head start, NOT a verdict. Every section is a region of the sheet with a
   * box that can be cropped; the labels and member hints are the splitter's
   * reading of what it saw PRINTED there. Nothing here says which callouts
   * belong to whom, how anything repeats, or how many of something there are —
   * and the wording has to keep saying so, because a hint that reads like an
   * assignment is how an unexamined guess ends up in a schedule.
   */
  function sectionsBlock(): string {
    const sections = opts.sections ?? [];
    if (!sections.length) return '';
    const lines = ['', `THIS SHEET HAS ALREADY BEEN SPLIT INTO ${sections.length} SECTION(S).`];
    if (opts.sectionSummary) lines.push(`The splitter described it as: ${opts.sectionSummary}`, '');
    lines.push(
      'Each is a real region of the drawing with its own geometry. Use them as a starting point rather',
      'than working the layout out again — and look again wherever you doubt it. The labels and member',
      'hints below are what the splitter SAW PRINTED there. They are not ownership, not placement and',
      'not a count; those remain yours to establish from evidence.',
      "These section ids are the splitter's own naming — the crop tool does NOT recognise them.",
      'To look at one, ask by its BOUNDS with getDrawingRegionImage, never by that id.',
      '',
    );
    for (const sec of sections) {
      const bx = sec.bounds;
      lines.push(
        `  ${sec.sectionId}  ${JSON.stringify(sec.label)}  [${sec.kind}]` +
          (sec.entityCount ? `  ${sec.entityCount} entities` : '') +
          (typeof sec.confidence === 'number' && sec.confidence > 0 && sec.confidence < 0.6
            ? `  (the splitter was only ${Math.round(sec.confidence * 100)}% sure of this one)`
            : ''),
        `      bounds {x1:${Math.round(bx.x1)},y1:${Math.round(bx.y1)},x2:${Math.round(bx.x2)},y2:${Math.round(bx.y2)}}` +
          ' — crop it with getDrawingRegionImage to look closer',
      );
      if (sec.memberHints?.length) {
        lines.push(`      labels seen here (HINTS, not assignments): ${sec.memberHints.map((h) => `${h.mark} (${h.basis})`).join(', ')}`);
      }
    }
    const rels = opts.sectionRelationships ?? [];
    if (rels.length) {
      lines.push('', '  how the splitter read them as relating (its reading, not a verdict):');
      for (const r of rels) lines.push(`      ${r.from} ${r.kind} ${r.to}${r.basis ? ` — ${r.basis}` : ''}`);
    }
    const withPng = sections.filter((x) => x.png);
    if (withPng.length) lines.push('', `  ${withPng.length} of these are attached to this turn as images.`);
    return lines.join('\n');
  }

  /**
   * The splitter's own renders, shown once at the start.
   *
   * They cost nothing — they were produced when the sheet was split — so the
   * orchestrator opens by LOOKING at the drawing rather than reading about it.
   * Capped, because a first turn carrying twenty images buries the question.
   */
  function sectionImages(): { dataUrl: string; caption: string }[] {
    const supplied = (opts.supplementalImages ?? []).slice(0, 6);
    const sections = (opts.sections ?? [])
      .filter((sec) => typeof sec.png === 'string' && sec.png.startsWith('data:image/') && sec.png.length > 512)
      .map((sec) => ({ dataUrl: sec.png as string, caption: `${sec.sectionId} — ${sec.label} [${sec.kind}]` }));
    return [...supplied, ...sections].slice(0, 12);
  }

  /**
   * The state the note is rendered from — the SAME state the engine builds
   * from, so the note cannot describe work that was not done.
   */
  function noteState(): NoteState {
    return {
      drawingName: opts.extract.drawingName,
      understanding,
      facts: userFacts,
      members: registry.members,
      callouts: [...calloutIds].map((id) => ({ id, text: String(graph.byId.get(id)?.rawText ?? '') })),
      claims,
      excluded,
      memberExclusions,
      placements,
      placementWorking: lastPlacementWorking,
      dims,
      dimSources,
      shapes,
      requiredAxes: axesNeeded(),
      declaredDims: declaredAxes(),
      unresolved,
      escalations,
      findings: board
        .all()
        .flatMap((t) => (t.result?.findings ?? []).map((f) => ({ taskId: t.taskId, statement: f.statement, evidenceIds: f.evidenceIds }))),
    };
  }

  /**
   * Which axes each member's own bars require — asked of the engine, not
   * decided here. A member owning a link needs the section it wraps; one owning
   * a vertical main needs the height. The note reports the gap; the rule that
   * produces it belongs to verify.ts.
   */
  /**
   * The axes the SHEET declares, by member.
   *
   * "TYPICAL DETAIL OF C1-350x350" states a cross-section with the authority of
   * a schedule row, and groundDeclaredDims feeds it to the engine. The note has
   * to count it too, or it reports gaps the drawing has already filled — Run
   * 042 asked the lead to resolve a C1 length the sheet prints in its own
   * caption. Mirrors groundDeclaredDims: two dims are length and width, a third
   * is the height, and nothing here overrides a dimension the model established.
   */
  function declaredAxes(): Map<string, Partial<Record<'L' | 'W' | 'H', number>>> {
    const key = (x: string): string => x.replace(/[^a-z0-9]/gi, '').toUpperCase();
    const byName = new Map((opts.extract.declared ?? []).map((d) => [key(d.name), d]));
    const out = new Map<string, Partial<Record<'L' | 'W' | 'H', number>>>();
    for (const m of registry.members) {
      const hit = byName.get(key(m.mark));
      const dimsMm = (hit?.dimsMm ?? []).filter((v) => v >= 30 && v <= 30000);
      if (!dimsMm.length) continue;
      if (dimsMm.length === 1) { out.set(m.id, { W: dimsMm[0] }); continue; }
      const [a2, b2, c2] = dimsMm;
      out.set(m.id, { L: Math.max(a2, b2), W: Math.min(a2, b2), ...(c2 !== undefined ? { H: c2 } : {}) });
    }
    return out;
  }

  function axesNeeded(): Map<string, ('L' | 'W' | 'H')[]> {
    const out = new Map<string, ('L' | 'W' | 'H')[]>();
    for (const c of claims) {
      const node = graph.byId.get(c.calloutId);
      if (!node) continue;
      const need = requiredAxes(c.barType ?? 'MAIN', c.distributionAxis);
      out.set(c.memberId, [...new Set([...(out.get(c.memberId) ?? []), ...need])]);
    }
    return out;
  }

  /** the note, as it stands — rendered fresh so it is never stale */
  function currentNote(): string {
    return renderUnderstandingNote(noteState());
  }

  function currentCompleteness(): Completeness {
    return assessCompleteness(noteState());
  }

  /**
   * Is this dependency ALREADY settled, so that asking would waste an answer?
   *
   * Three places an answer can already be: the project facts this run was
   * briefed with (an answer given in an earlier run, now on the ledger), a
   * count established as a placement, and a cover the settings already carry.
   * A question whose fact is in any of them is dropped before it reaches a
   * person — "a fact already on the record is never re-asked" is what stops an
   * interview repeating itself across rebuilds.
   */
  function dependencyAlreadySatisfied(q: AskableQuestion): boolean {
    const key = engineKeyForQuestion(q);
    const held = userFacts[key];
    if (typeof held?.mm === 'number' && held.mm > 0) return true;

    // A count lands as a placement rather than as a millimetre fact.
    if (q.writesTo.field === 'count' && q.writesTo.memberMark) {
      const member = registry.resolve(q.writesTo.memberMark) ?? registry.byId.get(q.writesTo.memberMark);
      const placement = member ? placements.get(member.id) : undefined;
      if (placement && placement.kind === 'stated') return true;
    }
    return false;
  }

  async function askAndApply(questions: readonly AskableQuestion[]): Promise<number> {
    if (!opts.askUser || !questions.length) return 0;
    // Unique by dependency, never already asked, and never something the
    // record already answers. The last of those is what makes a rebuild
    // idempotent: run the same drawing ten times and a fact that was supplied
    // on run one is not asked about again on run two.
    const fresh = dedupeByDependency(questions, askedDependencies).filter(
      (q) => !dependencyAlreadySatisfied(q),
    );
    for (const q of fresh) askedDependencies.add(dependencyOf(q));
    if (!fresh.length) return 0;

    // Register the complete batch before awaiting any one answer. The
    // InterviewSession then presents it in unblock-value order.
    const answers = await Promise.all(
      fresh.map(async (q) => {
        try {
          return await opts.askUser!(q);
        } catch {
          return null;
        }
      }),
    );

    let applied = 0;
    for (let i = 0; i < fresh.length; i++) {
      const q = fresh[i];
      const raw = answers[i];
      if (raw === null) {
        unresolved.push(`${q.question} — the user did not supply an answer`);
        continue;
      }
      const typed = typeAnswer(q, raw);
      if ('error' in typed) {
        unresolved.push(`${q.question} — the answer could not be applied: ${typed.error}`);
        continue;
      }

      // A COUNT LANDS AS A PLACEMENT, not as a dimension.
      //
      // It has no millimetres, and the old guard here required them — so a
      // person could be asked how many footings there are, answer, and watch
      // the row stay open. That is worse than not asking: it spends their
      // attention and changes nothing.
      if (typed.patch.count !== undefined && q.writesTo.memberMark) {
        const member =
          registry.resolve(q.writesTo.memberMark) ?? registry.byId.get(q.writesTo.memberMark);
        if (!member) {
          unresolved.push(`${q.question} — answered, but ${q.writesTo.memberMark} is not a member of this job`);
          continue;
        }
        placements.set(member.id, {
          kind: 'stated',
          count: typed.patch.count,
          saidAs: typed.patch.saidAs ?? raw,
        });
        transcript.push(`USER COUNT ${member.mark} = ${typed.patch.count} (${JSON.stringify(raw)})`);
        applied += 1;
        continue;
      }

      if (typed.patch.mm === undefined) {
        unresolved.push(`${q.question} — the answer carried nothing the engine could apply`);
        continue;
      }
      const key = engineKeyForQuestion(q);
      userFacts[key] = { mm: typed.patch.mm, saidAs: typed.patch.saidAs ?? raw };
      const axis = axisOfQuestion(q);
      if (axis && q.writesTo.memberMark) {
        const member = registry.resolve(q.writesTo.memberMark) ?? registry.byId.get(q.writesTo.memberMark);
        if (member) {
          const current = dims.get(member.id) ?? {};
          current[axis] = typed.patch.mm;
          dims.set(member.id, current);
          const sources = dimSources.get(member.id) ?? {};
          sources[axis] = `FACT-${key} — supplied by the user as ${JSON.stringify(raw)}`;
          dimSources.set(member.id, sources);
        }
      }
      transcript.push(`USER FACT ${key} = ${typed.patch.mm} mm (${JSON.stringify(raw)})`);
      applied += 1;
    }
    // AN ANSWER INVALIDATES EVERY ROW THAT READ THE OLD VALUE. The next build
    // is owed, whatever the rebuild budget says — see `dirtySinceBuild`.
    if (applied > 0) dirtySinceBuild = true;
    return applied;
  }

  function judgeDossier(): JudgeDossier {
    const last = builds[builds.length - 1];
    const facts = Object.entries(userFacts)
      .map(([key, value]) => `${key} = ${value.mm} mm${value.saidAs ? ` (client said ${JSON.stringify(value.saidAs)})` : ''}`)
      .join('\n') || '(the client supplied no project facts)';
    const objections = last
      ? [
          ...last.failures.map((f) => `${f.gate} ${f.memberMark ?? ''}${f.field ? `.${f.field}` : ''} — ${f.message}`),
          ...last.duplicateSuspects.map((x) => `DUPLICATE? ${x}`),
          ...last.axisSuspects.map((x) => `AXIS? ${x}`),
          ...last.sanity,
        ].join('\n')
      : '';
    return {
      drawing: [openingBriefing(), currentNote()].join('\n\n'),
      facts,
      calculation: renderBbsTable(lastResult!),
      reasoning: renderReasoning(lastResult!),
      objections,
    };
  }

  function runIndependentJudge(): Promise<JudgeOutcome> {
    return runJudge(judgeDossier(), opts.ask, sectionImages());
  }

  function establishedBlock(): string {
    const owned = new Set([...claims.map((c) => c.calloutId), ...excluded.map((e) => e.calloutId)]);
    const homeless = [...calloutIds].filter((id) => !owned.has(id));
    const lines = [
      'ESTABLISHED SO FAR',
      `  ownership: ${claims.length} callout(s) claimed, ${excluded.length} excluded, ${homeless.length} unclaimed` +
        (homeless.length ? ` (${homeless.slice(0, 14).join(', ')}${homeless.length > 14 ? `, +${homeless.length - 14}` : ''})` : ''),
      `  placement: ${placements.size} of ${registry.members.length} member(s) — ` +
        (placements.size
          ? [...placements.entries()].map(([id, p]) => `${id}:${(p as { kind: string }).kind}`).join(', ')
          : 'none'),
      `  dimensions: ${dims.size} member(s) have an axis resolved`,
      `  shapes: ${shapes.size} callout(s)`,
      '',
      // THE READING IS THE DELIVERABLE, AND ITS GAPS ARE COUNTED.
      //
      // Coverage used to be invisible until a build came back: one run claimed
      // thirty-four callouts and totalled 3.0 t, the next claimed ten and
      // totalled 1.3 t, and both passed the same gates. What was varying was
      // how much of the drawing had been READ, and nothing said so.
      ...(() => {
        const c = currentCompleteness();
        return [`  ${completenessLine(c)}`, ...c.missing.slice(0, 8).map((x) => `    · ${x}`)];
      })(),
      memberExclusions.size
        ? `  members excluded from the schedule: ${[...memberExclusions.values()].map((x) => `${x.mark} (${x.why.slice(0, 60)})`).join('; ')}`
        : '',
    ].filter(Boolean);

    // THE IMBALANCE, NAMED. Run 015 dispatched twenty-nine investigations over
    // five turns and recorded NOTHING, twice announcing it would record next
    // turn and dispatching again instead — then tried to record everything in
    // one reply, which took longer to generate than the request allowed. This
    // states the arithmetic of that gap. It is a fact about the board, not an
    // instruction about reinforcement: it says nothing about WHAT to record.
    const reported = board.all().filter((t) => t.status === 'completed').length;
    const recorded = claims.length + excluded.length + memberExclusions.size + placements.size + dims.size + shapes.size;
    if (reported > 0 && recorded === 0) {
      lines.push(
        `  ⚠ ${reported} investigation(s) have reported and NOTHING is recorded. Their findings are on the`,
        '    board only — none of it is in the schedule, and none of it survives this run unrecorded.',
        '    Record what they settled in your NEXT reply, alongside whatever you still need to ask.',
      );
    }
    return lines.join('\n');
  }

  function renderBuild(b: BuildAttempt): string {
    return [
      `  build ${b.n}: ${b.rows} row(s), ${b.netKg === null ? 'no net weight' : `${(b.netKg / 1000).toFixed(3)} t`}, verification ${b.status}`,
      // what the engine actually computed FROM the conclusions — the dims
      // echoed back are how a mis-pointed height gets noticed, and the kg per
      // member is how a member counted from the wrong band stands out
      ...b.memberSummary.flatMap((m) => {
        const line = `      ${m.mark}: count ${m.count ?? '—'}, L ${m.L ?? '—'} W ${m.W ?? '—'} H ${m.H ?? '—'} → ${m.rows} row(s), ${Math.round(m.kg)} kg`;
        // the working behind each axis you established, so a number you can no
        // longer justify is visible as the evidence to go back to
        const src = Object.entries(m.sources ?? {}).filter(([, v]) => v);
        return src.length
          ? [line, ...src.map(([ax, w]) => `          ${ax} ← ${String(w).slice(0, 110)}`)]
          : [line];
      }),
      b.membersExcluded.length
        ? `      excluded by your conclusions (not scheduled): ${b.membersExcluded.map((x) => `${x.mark} — ${x.why.slice(0, 60)}`).join('; ')}`
        : '',
      b.membersWithoutPlacement.length ? `      counted ZERO for want of a placement: ${b.membersWithoutPlacement.join(', ')}` : '',
      b.membersWithoutBars.length ? `      no steel assigned: ${b.membersWithoutBars.join(', ')}` : '',
      ...b.duplicateSuspects.slice(0, 6).map((d) => `      DUPLICATE? ${d}`),
      ...b.axisSuspects.map((d) => `      SAME ON EVERY AXIS? ${d}`),
      ...b.sanity.map((s) => `      ${s}`),
      ...b.failures.slice(0, 10).map((f) => `      ${f.gate} ${f.memberMark ?? ''}${f.field ? `.${f.field}` : ''} — ${f.message.slice(0, 150)}`),
      b.failures.length > 10 ? `      …and ${b.failures.length - 10} more` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * One conclusion, checked exactly as before.
   *
   * The vocabulary here is narrower than the orchestrator's freedom, and that is
   * deliberate: the model may investigate anything, but what it can ASSERT is
   * only what the engine can compute from. Every check below is a contract
   * check, never an engineering opinion.
   */
  function applyConclusion(raw: Record<string, unknown>): { ok: boolean; objection?: string } {
    // THE SHAPE GATE, PER CONCLUSION. Each kind's contract — which ids are
    // required, what a placement's fields are — is checked here, before any
    // field is dereferenced. One malformed conclusion is refused alone, with
    // the field named, and costs nothing else recorded this turn.
    const shaped = validate(raw, CONCLUSION);
    if (!shaped.ok) {
      return {
        ok: false,
        objection: shaped.problems
          .slice(0, 6)
          .map((p) => `${p.path || 'the conclusion'} — expected ${p.expected}; received ${p.received}`)
          .join('; '),
      };
    }
    const c = shaped.value as Record<string, unknown>;

    const kind = c.kind as string;
    const cited = (c.evidenceIds as string[] | undefined) ?? [];
    // WHATEVER THE BRIEFING NAMES AS PART OF THIS SHEET IS CITABLE.
    //
    // This filter used to accept only evidence nodes, bands and facts, while
    // the briefing spent whole paragraphs naming REGIONS and splitter SECTIONS
    // — with their bounds, for cropping. So the model cited exactly what it had
    // been shown and was told it did not exist: Run 020 eight times over
    // REGION ids, and Run 021 three times over SPLIT-14, which cost it the tie
    // beam's placement entirely because it kept re-sending the same sound
    // conclusion with the same honest citation.
    //
    // Fixing REGION alone and leaving SECTION was the same bug twice, so the
    // rule is now the general one: a thing this run TOLD the model about is a
    // thing the model may cite. Anything else is still refused by name.
    const sectionIds = new Set((opts.sections ?? []).map((sec) => sec.sectionId));
    const bogus = cited.filter(
      (id) =>
        !id.startsWith('FACT-') &&
        !graph.byId.has(id) &&
        !bands.some((b) => b.id === id) &&
        !regions.some((r) => r.id === id) &&
        !logicalSections.some((sec) => sec.id === id) &&
        !sectionIds.has(id),
    );
    if (bogus.length) {
      return { ok: false, objection: `${bogus.join(', ')} — not evidence on this sheet. Cite only ids a tool returned.` };
    }

    /** a project fact the placement names must be on the record — checked now, not at build time */
    const knownFact = (factId: unknown): string | null => {
      if (typeof factId === 'string' && userFacts[factId]) return null;
      const have = Object.keys(userFacts);
      return `"${String(factId)}" is not a project fact on the record` +
        (have.length ? ` — the facts are: ${have.join(', ')}` : ' — no project facts were supplied');
    };

    switch (kind) {
      case 'own': {
        const calloutId = c.calloutId as string;
        if (!calloutIds.has(calloutId)) return { ok: false, objection: `${calloutId} is not a callout the extractor read` };
        const m = registry.byId.get(c.memberId as string) ?? registry.resolve(c.memberId as string);
        if (!m) return { ok: false, objection: `"${c.memberId}" is not a member of this drawing. Members come from the sheet.` };
        const bad =
          checkEnum({ decision: 'own', field: 'basis', value: c.basis, legal: OWNERSHIP_BASES, subject: calloutId, required: true, raw: c }) ??
          checkEnum({ decision: 'own', field: 'barType', value: c.barType, legal: BAR_TYPES, subject: calloutId, raw: c }) ??
          checkDistributionAxis('own', c.distributionAxis, calloutId, c);
        if (bad) return { ok: false, objection: bad };
        if (!cited.length) return { ok: false, objection: 'an ownership conclusion must cite the evidence it rests on' };
        claims.push({
          calloutId,
          memberId: m.id,
          basis: c.basis as OwnershipClaim['basis'],
          reason: `${String(c.reasoning ?? '').slice(0, 200)}${c.confidence !== undefined ? ` [confidence ${c.confidence}]` : ''}`,
          // `checkEnum` above proved this is a legal bar type; the guard
          // narrows from that same fact instead of casting past it.
          barType: isBarType(c.barType) ? c.barType : undefined,
          distributionAxis: (c.distributionAxis as 'L' | 'W' | 'H') || undefined,
        });
        ledgers.calloutOffered(calloutId, m.id);
        return { ok: true };
      }

      case 'exclude': {
        // a callout (steel that is not scheduled) or a member (an element that
        // carries none — a bought or precast item). Both stay on the record.
        if (typeof c.calloutId === 'string' && c.calloutId) {
          const calloutId = c.calloutId;
          if (!calloutIds.has(calloutId)) return { ok: false, objection: `${calloutId} is not a callout on this sheet` };
          excluded.push({ calloutId, reason: String(c.why ?? '') });
          return { ok: true };
        }
        if (typeof c.memberId === 'string' && c.memberId) {
          const m = registry.byId.get(c.memberId) ?? registry.resolve(c.memberId);
          if (!m) return { ok: false, objection: `"${c.memberId}" is not a member of this drawing` };
          memberExclusions.set(m.id, { mark: m.mark, why: String(c.why ?? '') });
          return { ok: true };
        }
        return {
          ok: false,
          objection: 'an exclusion names a calloutId (steel that is not scheduled) or a memberId (a member that carries none)',
        };
      }

      case 'placement': {
        const m = registry.byId.get(c.memberId as string) ?? registry.resolve(c.memberId as string);
        if (!m) return { ok: false, objection: `"${c.memberId}" is not a member of this drawing` };
        const p = c.placement as Record<string, unknown> & { kind: string };
        const bad = checkEnum({ decision: 'placement', field: 'placement.kind', value: p.kind, legal: PLACEMENT_KINDS, subject: m.id, required: true, raw: p });
        if (bad) return { ok: false, objection: bad };

        // EVERY ID THE PLACEMENT NAMES IS CHECKED NOW, while the model holds
        // the turn — not at build time, turns later. Run 014 listed prose like
        // "BAND-02 C1 marks" as occurrence ids; the engine silently filtered
        // the ghosts and the count quietly shrank. A ghost id is refused BY
        // NAME instead, which is a message the model can act on.
        switch (p.kind) {
          case 'template-repeat':
          case 'periodic-pattern': {
            if (!bands.some((b) => b.id === p.panelId)) {
              return {
                ok: false,
                objection:
                  `"${p.panelId}" is not a layout band on this sheet — the bands are: ` +
                  `${bands.map((b) => b.id).join(', ') || 'none'}. A template is measured from the marks of the band you name.`,
              };
            }
            const ghosts = (p.orderedOccurrenceIds as string[]).filter((id) => !graph.byId.has(id));
            if (ghosts.length) {
              return {
                ok: false,
                objection:
                  `orderedOccurrenceIds must be mark occurrence ids a tool returned — these are not evidence ` +
                  `on this sheet: ${ghosts.join(', ')}. Descriptions in prose are not ids.` +
                  // NAME THE ONES THAT DO EXIST. Run 022 guessed the padding —
                  // MARK-C1-01 for MARK-C1-001 — and was refused three times
                  // for three members over one missing digit. The registry has
                  // held this member's occurrence ids the whole time; saying
                  // which ids exist decides nothing about which of them
                  // BELONG in the template, and that choice stays the model's.
                  (m.markEvidenceIds.length
                    ? ` ${m.mark}'s occurrences on this sheet are: ${m.markEvidenceIds.slice(0, 20).join(', ')}` +
                      `${m.markEvidenceIds.length > 20 ? `, +${m.markEvidenceIds.length - 20} more` : ''}. ` +
                      'Choose from those the ones that sit in the panel you named.'
                    : ''),
              };
            }
            const factBad = knownFact(p.runFactId);
            if (factBad) return { ok: false, objection: `${p.kind}: ${factBad}` };
            break;
          }
          case 'marks': {
            const ghosts = (p.markEvidenceIds as string[]).filter((id) => !graph.byId.has(id));
            if (ghosts.length) {
              return {
                ok: false,
                objection:
                  `markEvidenceIds names ids that are not evidence on this sheet: ${ghosts.join(', ')}.` +
                  (m.markEvidenceIds.length
                    ? ` ${m.mark}'s occurrences on this sheet are: ${m.markEvidenceIds.slice(0, 20).join(', ')}` +
                      `${m.markEvidenceIds.length > 20 ? `, +${m.markEvidenceIds.length - 20} more` : ''}.`
                    : ''),
              };
            }
            break;
          }
          case 'continuous': {
            const factBad = knownFact(p.runFactId);
            if (factBad) return { ok: false, objection: `continuous: ${factBad}` };
            break;
          }
          case 'uniform': {
            if (p.along === 'run') {
              const factBad = knownFact(p.runFactId);
              if (factBad) return { ok: false, objection: `uniform along the run: ${factBad}` };
            }
            break;
          }
          case 'dependent': {
            const named = p.parentMemberIds as string[];
            const resolved = named.map((pid) => ({ pid, m: registry.byId.get(pid) ?? registry.resolve(pid) }));
            const unknown = resolved.filter((x) => !x.m).map((x) => x.pid);
            if (unknown.length) {
              return {
                ok: false,
                objection:
                  `parentMemberIds must be members of this drawing — not recognised: ${unknown.join(', ')}. ` +
                  `The members are: ${registry.members.map((x) => `${x.id} "${x.mark}"`).join(', ')}`,
              };
            }
            // normalised to stable ids, the form resolveAllPlacements keys by
            p.parentMemberIds = resolved.map((x) => (x.m as { id: string }).id);
            break;
          }
          case 'once': {
            if (!graph.byId.has(p.evidenceId as string) && !bands.some((b) => b.id === p.evidenceId)) {
              return { ok: false, objection: `once: "${p.evidenceId}" is not evidence on this sheet` };
            }
            break;
          }
        }
        placements.set(m.id, p as unknown as MemberPlacement);
        return { ok: true };
      }

      case 'dimension': {
        const m = registry.byId.get(c.memberId as string) ?? registry.resolve(c.memberId as string);
        if (!m) return { ok: false, objection: `"${c.memberId}" is not a member of this drawing` };
        const badAxis = checkEnum({ decision: 'dimension', field: 'axis', value: c.axis, legal: AXES, subject: m.id, required: true, raw: c });
        if (badAxis) return { ok: false, objection: badAxis };
        const ref = c.ref as Record<string, unknown> | undefined;
        if (!ref || typeof ref !== 'object') return { ok: false, objection: 'a dimension must be a pointer at the text that states it, not a value' };
        if (typeof (ref as { value?: unknown }).value === 'number') {
          return { ok: false, objection: 'a dimension may not carry a typed value — point at the drawing text that states it' };
        }
        const r = resolveRef(ref, { graph, userFacts });
        if (!r.ok) return { ok: false, objection: `that pointer did not resolve — ${r.reason}` };
        const cur = dims.get(m.id) ?? {};
        cur[c.axis as 'L' | 'W' | 'H'] = r.mm;
        dims.set(m.id, cur);
        const src = dimSources.get(m.id) ?? {};
        src[c.axis as 'L' | 'W' | 'H'] = r.working ?? (r.evidenceIds ?? []).join(', ');
        dimSources.set(m.id, src);
        return { ok: true };
      }

      case 'shape': {
        const calloutId = c.calloutId as string;
        if (!calloutIds.has(calloutId)) return { ok: false, objection: `${calloutId} is not a callout on this sheet` };
        const bad = checkEnum({
          decision: 'shape', field: 'shapeCode', value: c.shapeCode, legal: SHAPE_CODES,
          subject: calloutId, required: true, akaFields: ['shape', 'code'], raw: c,
        });
        if (bad) return { ok: false, objection: bad };
        // `checkEnum` has just proved this is one of SHAPE_CODES; the guard
        // narrows the type from the same fact rather than asserting past it.
        if (!isShapeCode(c.shapeCode)) return { ok: false, objection: `${calloutId}: unknown shape code` };
        shapes.set(calloutId, c.shapeCode);
        return { ok: true };
      }

      default:
        return { ok: false, objection: `"${kind}" is not a conclusion kind. Use own, placement, dimension, shape or exclude.` };
    }
  }

  /**
   * Build and verify from what is established.
   *
   * Nothing is filled in. A member with no placement arrives at the engine as
   * `unknown`, which is refused and becomes a gap — that gap is the orchestrator's
   * next question, and quietly substituting 1 would erase it.
   */
  /**
   * A member's dimensions, resolved by FACT PRIORITY — per axis:
   *
   *   1. the latest validated DRAWING_READ fact: a schedule-table cell that
   *      names the member ("FOOTING SCHEDULE row F8, column L = 3500");
   *   2. what this run established — the model's evidence pointer, or an
   *      answer the person gave IN this run (askAndApply writes `dims`);
   *   3. the latest USER_INPUT / DERIVED fact on the project record, which
   *      rides in as `userFacts` ("f8_length", "f8_depth", "f8_width");
   *   4. otherwise not on record — the row says which axis it is waiting on.
   *
   * (3) is what was missing: an F8.length already on the specification only
   * reached a row if the model happened to point at it, so the ledger said
   * 3500 and the schedule said "needs F8.length". A fact on the record is now
   * read by the build itself, and the row's trace names where it came from.
   *
   * A table value that disagrees with a pointer is not silent: the override
   * is recorded once, in the transcript and on the outcome's unresolved list.
   */
  function resolveMemberDims(m: { id: string; mark: string }): {
    dims: Partial<Record<'L' | 'W' | 'H', number>>;
    sources: Partial<Record<'L' | 'W' | 'H', string>>;
  } {
    const established = dims.get(m.id) ?? {};
    const establishedSrc = dimSources.get(m.id) ?? {};
    const fromTable = tableDims.get(m.mark.toUpperCase()) ?? {};
    const out: Partial<Record<'L' | 'W' | 'H', number>> = {};
    const src: Partial<Record<'L' | 'W' | 'H', string>> = {};
    const lower = m.mark.toLowerCase();
    const keysFor: Record<'L' | 'W' | 'H', string[]> = {
      L: [`${lower}_length`, `${lower}_plan_l`, `${lower}_l`],
      W: [`${lower}_width`, `${lower}_plan_w`, `${lower}_section_w`, `${lower}_thickness`, `${lower}_w`],
      H: [`${lower}_height`, `${lower}_depth`, `${lower}_h`],
    };
    for (const axis of ['L', 'W', 'H'] as const) {
      const table = fromTable[axis];
      const held = established[axis];
      if (table && table.mm > 0) {
        out[axis] = table.mm;
        src[axis] = `DRAWING_READ — ${table.source}`;
        if (typeof held === 'number' && held > 0 && Math.abs(held - table.mm) > 0.5) {
          const key = `${m.mark}.${axis}:${held}→${table.mm}`;
          if (!tableOverrides.has(key)) {
            tableOverrides.add(key);
            const line =
              `${m.mark} ${axis}: the schedule table states ${table.mm} mm (${table.source}); ` +
              `the reading of ${held} mm (${establishedSrc[axis] ?? 'no source recorded'}) was set aside — the table names the member, the pointer did not.`;
            transcript.push(`TABLE GOVERNS ${line}`);
            unresolved.push(`dimension override: ${line}`);
          }
        }
        continue;
      }
      if (typeof held === 'number' && held > 0) {
        out[axis] = held;
        src[axis] = establishedSrc[axis] ?? 'established this run';
        continue;
      }
      const key = keysFor[axis].find((k) => typeof userFacts[k]?.mm === 'number' && (userFacts[k].mm as number) > 0);
      if (key) {
        out[axis] = userFacts[key].mm;
        src[axis] = `${userFacts[key].source ?? 'USER_INPUT'} — project fact ${key}${
          userFacts[key].sourceText
            ? ` (${userFacts[key].sourceText})`
            : userFacts[key].saidAs
              ? ` (${userFacts[key].saidAs})`
              : ''
        }`;
      }
    }
    return { dims: out, sources: src };
  }

  function memberTypeOf(mark: string, declaredAs?: string): string {
    const fromTable = tableDims.get(mark.toUpperCase());
    const title = fromTable ? (Object.values(fromTable).find((d) => d && d.table)?.table ?? '') : '';
    const kind = title.replace(/\b(SCHEDULE|TABLE|DETAILS?)\b/gi, '').replace(/[\s:：\-–—]+$/g, '').replace(/\s+/g, ' ').trim();
    if (kind) return kind.toUpperCase();
    const declared = (declaredAs ?? '').replace(/[\d.]+\s*[x×]\s*[\d.]+(\s*[x×]\s*[\d.]+)?/gi, '').replace(mark, '').trim();
    return declared || 'member';
  }

  function buildOnce(n: number): BuildAttempt {
    const ownership = resolveOwnership({ allCalloutIds: [...calloutIds], claims, shared: [], excluded });
    lastOwnership = ownership;

    // Members the orchestrator excluded are not scheduled — but they are not
    // FORGOTTEN: they ride the attempt as membersExcluded, with the reason,
    // so "we saw the H-poles and they are a supply item" and "we never
    // noticed the H-poles" can never look the same. Before this, their
    // no-bars coverage failures were unconditional and permanently BLOCKED
    // the aggregate referee.
    const scheduled = registry.members.filter((m) => !memberExclusions.has(m.id));

    // A COUNT ALREADY ON THE RECORD IS A PLACEMENT. "F8.count = 8" answered in
    // an earlier run rides in as the project fact `f8_count`; without this it
    // reached the member count but not the placement, so the placement gate
    // failed and the person was asked "How many F8?" again — for a fact they
    // had given. An available fact is never re-asked.
    for (const m of scheduled) {
      if (placements.has(m.id)) continue;
      const fact = userFacts[`${m.mark.toLowerCase()}_count`];
      if (typeof fact?.mm === 'number' && fact.mm > 0 && Number.isInteger(fact.mm)) {
        placements.set(m.id, { kind: 'stated', count: fact.mm, saidAs: fact.saidAs ?? `${fact.mm}` });
      }
    }
    const specs: MemberPlacementSpec[] = scheduled.map((m) => ({
      memberId: m.id,
      placement: placements.get(m.id) ?? { kind: 'unknown', reason: 'nothing has established how this member repeats' },
    }));
    // A RUN IS A DIMENSION OF A RUNNING STRUCTURE, AND OF NOTHING ELSE.
    // Each member answers for itself: a wall or beam consults the run (and is
    // asked for one when none is on record); a footing, column or pedestal is
    // counted from its tags and never sees the question. One predicate,
    // `isLinearMark`, decides it — the same one the engine cuts bars by.
    const linearById = new Map(scheduled.map((m) => [m.id, runAppliesToMember(m)]));
    const placed = resolveAllPlacements(specs, {
      graph: graphWithBands,
      userFacts,
      runAppliesTo: (id) => linearById.get(id),
    });

    const coverTable = (opts.extract.notes.coverByMember ?? []) as CoverRow[];
    // "C1.cover" answered by a person arrives as the engine key `c1_cover`
    // (src/studio/bbsFacts.ts). Keyed back to the mark, it becomes
    // `resolveCover`'s user-override — the one input that outranks the sheet.
    const coverOverrides: Record<string, number> = {};
    for (const [key, value] of Object.entries(userFacts)) {
      const mark = /^(.+)_cover$/.exec(key)?.[1];
      if (mark && mark !== 'settings' && typeof value?.mm === 'number') {
        coverOverrides[mark.toUpperCase()] = value.mm;
      }
    }
    const covers = new Map<string, { mm: number; source: string }>();
    const members = scheduled.map((m) => {
      const p = placed.get(m.id);
      const { dims: d, sources: dimSourcesOf } = resolveMemberDims(m);
      // THE RESOLVED COVER RIDES THE MEMBER INTO THE ENGINE.
      //
      // It used to reach `buildChatResult` only — the sheet's cover table was
      // extracted, resolved per member, printed for the reader, and spent in
      // zero cutting lengths, because `buildBbs` read one flat
      // `settings.coverMm` (default 50). A 350×400 tie beam whose sheet says
      // 30 was scheduled at 50: 2×(242+292) instead of 2×(282+332), 160 mm
      // short on every stirrup and always in the under-ordering direction.
      //
      // Attaching it here is the whole join: `groundDeclaredDims` and the
      // continuous-span pass both spread the member, so it survives to
      // `buildBbs`, which prefers `member.coverMm` and records the fallback
      // when there is none. When `resolveCover` refuses — no row describes
      // this member — nothing is attached and nothing is invented; the engine
      // falls back to the flat figure and says so on every row.
      // A cover the user gave for THIS member is the last word on it — that is
      // `resolveCover`'s own first rule, and until now nothing ever handed it
      // one, so an answered "cover for C1?" changed no arm and no count.
      const cover = resolveCover([m.mark, m.declaredAs ?? ''], undefined, {
        table: coverTable,
        overrides: coverOverrides,
      });
      if (cover.ok) covers.set(m.mark, { mm: cover.mm!, source: cover.source ?? '' });
      return {
        mark: m.mark,
        // The member's KIND, from the schedule table that names it ("FOOTING
        // SCHEDULE" → FOOTING) or the words it was declared with — never a
        // placeholder when the sheet says what it is.
        type: memberTypeOf(m.mark, m.declaredAs),
        // the continuous span is applied AFTER grounding — see below
        lengthMm: d.L,
        widthMm: d.W,
        heightMm: d.H,
        dimSources: dimSourcesOf,
        count: p?.ok ? (p.count ?? 0) : (typeof userFacts[`${m.mark.toLowerCase()}_count`]?.mm === 'number' ? (userFacts[`${m.mark.toLowerCase()}_count`].mm as number) : 0),
        placement: placements.get(m.id),
        ...(cover.ok ? { coverMm: cover.mm, coverSource: cover.source } : {}),
        source: { table: '', row: 0 },
        incomplete: false,
        missing: [],
      };
    });

    const byId = new Map(scheduled.map((m) => [m.id, m]));
    const bars: BbsBar[] = [];
    for (const disp of ownership.dispositions.values()) {
      if (disp.state !== 'assigned' && disp.state !== 'shared') continue;
      const node = graph.byId.get(disp.calloutId);
      if (!node) continue;
      // A COMPOUND CALLOUT IS SEVERAL BAR SETS. "2-16TOR+2-12TOR" parses to a
      // first and a second component, and the parser put both on the node —
      // reading only the first silently dropped the whole second set from
      // every schedule this path built. The fan-out rule mirrors
      // interpret.ts's diametersIn/countForDia: one bar per parsed component,
      // all sharing the callout's spacing, legs and axis.
      const components: { dia: number; count?: number }[] = [];
      const dia = Number(node.metadata.diaMm);
      if (dia > 0) {
        components.push({
          dia,
          count: typeof node.metadata.count === 'number' ? node.metadata.count : undefined,
        });
      }
      const second = Number(node.metadata.secondDiaMm);
      if (second > 0) {
        components.push({
          dia: second,
          count: typeof node.metadata.secondCount === 'number' ? node.metadata.secondCount : undefined,
        });
      }
      if (!components.length) continue;
      // THE SCHEDULE COLUMN FIXES THE AXIS. A callout sitting in a cell headed
      // "a(LONG BAR)" runs along L and is spaced along W — the table says so
      // in words, and that reading outranks a pointer's guess at orientation.
      // It is applied only where the cell's header states LONG/SHORT; a
      // disagreement with the model's own axis is recorded, never silent.
      const cell = tableCells.get(disp.calloutId) ?? tableCells.get(String(node.sourceHandles?.[0] ?? ''));
      const tableAxis = cell?.runsAlong ? distributionAxisFor(cell.runsAlong) : undefined;
      if (tableAxis && disp.distributionAxis && disp.distributionAxis !== tableAxis) {
        const key = `${disp.calloutId}:axis:${disp.distributionAxis}→${tableAxis}`;
        if (!tableOverrides.has(key)) {
          tableOverrides.add(key);
          const line =
            `${disp.calloutId} "${node.rawText ?? ''}": the schedule column "${cell!.column}" says it runs along ` +
            `${cell!.runsAlong}, so it is spaced along ${tableAxis}; the reading "spaced along ${disp.distributionAxis}" was set aside.`;
          transcript.push(`TABLE GOVERNS ${line}`);
          unresolved.push(`axis override: ${line}`);
        }
      }
      for (const mid of disp.state === 'shared' ? (disp.sharedMemberIds ?? []) : [disp.memberId!]) {
        const m = byId.get(mid);
        if (!m) continue;
        for (const comp of components) {
          bars.push({
            memberMark: m.mark,
            barType: disp.barType ?? 'MAIN',
            diaMm: comp.dia,
            shapeCode: shapes.get(disp.calloutId) ?? '00',
            spacingMm: typeof node.metadata.spacingMm === 'number' ? node.metadata.spacingMm : undefined,
            manualCount: comp.count,
            legs: typeof node.metadata.legs === 'number' ? node.metadata.legs : undefined,
            distributionAxis: tableAxis ?? disp.distributionAxis,
            fromCallout: node.rawText ?? '',
            // the entity handles the callout was read from — the row's trace
            // back to the sheet (BBS row → callout → entity)
            handles: [...(node.sourceHandles ?? [])],
          });
        }
      }
    }

    // THE SHEET'S OWN DECLARATIONS FILL WHAT THEY STATE.
    //
    // "TYPICAL DETAIL OF C1-350x350" IS the drawing stating C1's cross-section,
    // with exactly the authority of a schedule row — and every other consumer
    // of this engine (BbsPanel, DrawingAI) has always grounded them. This path
    // never did, so Run 016 finished with C1.L, C1.W, C2.L/W, SC.L/W and TB.L/W
    // all "not resolved" on a sheet that prints every one of them beside the
    // member's name, and the lead was being asked to point at cross-sections
    // the drawing had already declared.
    //
    // It fills MISSING axes only: a dimension the model established by pointing
    // at the drawing always wins, so this cannot overrule a conclusion.
    const grounded = groundDeclaredDims(
      { members, bars, unresolved: [] },
      opts.extract.declared ?? [],
    );

    // A CONTINUOUS MEMBER'S LENGTH IS THE RUN, AND IT IS APPLIED LAST.
    //
    // groundDeclaredDims strips any dimension outside 30–30000 mm as an
    // impossible reading — right for a cached "1 mm width" read off the mark
    // text, and fatal for a wall whose length IS the 100 m run. Grounding
    // first and laying the span on afterwards keeps both: junk cross-sections
    // are still cleaned, and a continuous member keeps the length its
    // placement resolved.
    const spanByMark = new Map(
      registry.members
        .map((m) => [m.mark, placed.get(m.id)] as const)
        .filter(([, p]) => p?.continuous && typeof p.spanMm === 'number')
        .map(([mark, p]) => [mark, p!.spanMm as number]),
    );
    const interpretation = {
      ...grounded,
      members: grounded.members.map((m) =>
        spanByMark.has(m.mark) ? { ...m, lengthMm: spanByMark.get(m.mark) } : m,
      ),
    };
    // WHAT THE ARITHMETIC IS ALLOWED TO ASSUME.
    //
    // `settingsFromExtract` layers defaults < what the SHEET says < what the
    // CALLER says. Passing DEFAULT_SETTINGS as the caller's word — which this
    // line did — put the defaults back on top and silently discarded the
    // drawing's own notes: a sheet stating M30 / Fe415 / CLEAR COVER 40 was
    // computed at M25 / Fe500 / 50, and cover governs every stirrup arm and
    // every spacing count. An empty override restores the intended order.
    //
    // A cover the USER supplied when the sheet was silent rides in the same
    // channel, above the sheet, because they were asked for it by name.
    const { settings: resolvedSettings, sources: settingSources } = resolveSettings(opts.extract, {
      ...(opts.settings ?? {}),
      ...(userFacts.settings_cover ? { coverMm: userFacts.settings_cover.mm } : {}),
    });
    // See OrchestrateOptions.computeOnAssumedCover: an unestablished cover is
    // spent as the default and every row says ASSUMED, instead of every row
    // holding open. The question is still raised (the final ask reads
    // `settingSources`, not the stripped flag).
    const settings: BbsSettings =
      opts.computeOnAssumedCover && settingSources.coverMm === 'default'
        ? { ...resolvedSettings, coverSource: undefined }
        : resolvedSettings;
    // THE INPUTS, LISTED BEFORE THE ARITHMETIC SPENDS THEM.
    //
    // A finished schedule hides its own inputs: every row is consistent with
    // whatever went in, so a dropped bar count, a cover nobody stated and a
    // quantity carried over from an old answer all produce a table that looks
    // exactly like a right one. This is the only place they are visible as
    // inputs, each with where it came from, and it is computed from the same
    // objects the build is about to read so the two cannot describe different
    // jobs.
    lastFactSheet = factSheet({
      interpretation,
      settings,
      userFacts,
      designInputs: designInputsFrom(opts.extract),
      typedLengths: Object.fromEntries(
        Object.entries(opts.overrides?.bars ?? {})
          .filter(([, v]) => typeof v.cuttingLengthMm === 'number')
          .map(([k, v]) => [k, v.cuttingLengthMm as number]),
      ),
    });
    const engine = buildBbs(opts.extract, interpretation, settings, opts.overrides, {
      ...userFacts,
      runM: userFacts.run ? userFacts.run.mm / 1000 : undefined,
    });

    // A placement that read a drawn band as the whole job with no run fact
    // carries that claim on its result. It travels into BOTH the verifier and
    // the artifact — the gate so the run cannot be reported as a success, the
    // artifact so the person reading the table sees what it covers.
    const extentClaims = [...placed]
      .filter(([, v]) => v.ok && v.unverifiedExtent)
      .map(([k, v]) => ({ memberMark: byId.get(k)?.mark ?? k, ...v.unverifiedExtent! }));

    const report = verifyAll({
      interpretation,
      result: engine,
      graph,
      placements: new Map([...placed].map(([k, v]) => [byId.get(k)?.mark ?? k, { ok: v.ok, count: v.count, continuous: v.continuous, reason: v.reason, unverifiedExtent: v.unverifiedExtent }])),
      runMm: runMmForJob(),
      structureClass: opts.structureClass,
    });

    lastPlacementWorking = new Map([...placed].map(([k, v]) => [byId.get(k)?.mark ?? k, v.working ?? v.reason ?? '']));
    const artifact = buildChatResult({
      id: `orchestrated-${startedAt}`,
      drawingName: opts.extract.drawingName,
      runMm: runMmForJob(),
      result: engine,
      verification: report,
      manifest: engine.manifest,
      settings,
      settingSources,
      reconciliation: engine.reconciliation,
      cover: covers,
      placementWorking: new Map([...placed].map(([k, v]) => [byId.get(k)?.mark ?? k, v.working ?? v.reason ?? ''])),
      extentClaims,
    });
    putChatResult(artifact);
    lastResult = artifact;
    lastEngine = engine;
    dirtySinceBuild = false;

    // ONE MEMBER, SEVERAL IDENTICAL ANNOTATIONS — a question, never a verdict.
    // Each assigned callout becomes rows, so a member owning two callouts with
    // the same text holds either two real sets (a wall's two faces) or one set
    // annotated in two views and counted twice. The views decide which; the
    // engine's job is only to make sure the lead LOOKS.
    const duplicateSuspects: string[] = [];
    {
      const byMemberText = new Map<string, { memberId: string; text: string; calloutIds: string[] }>();
      for (const disp of ownership.dispositions.values()) {
        if (disp.state !== 'assigned' || !disp.memberId) continue;
        const node = graph.byId.get(disp.calloutId);
        const text = (node?.rawText ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
        if (!text) continue;
        const key = `${disp.memberId} ${text}`;
        const hit = byMemberText.get(key) ?? { memberId: disp.memberId, text, calloutIds: [] };
        hit.calloutIds.push(disp.calloutId);
        byMemberText.set(key, hit);
      }
      for (const { memberId: dupMid, text, calloutIds: dupIds } of byMemberText.values()) {
        if (dupIds.length < 2) continue;
        duplicateSuspects.push(
          `${byId.get(dupMid)?.mark ?? dupMid} owns ${dupIds.length} callouts all reading "${text}" (${dupIds.join(', ')}) — ` +
            'each produces its own rows. If they are ONE annotation drawn in two views, own one and exclude ' +
            'the rest; if they are distinct real sets (e.g. two faces), keep both and say so in your reasoning.',
        );
      }
    }

    // A MEMBER WHOSE AXES ARE ALL THE SAME NUMBER, ASKED ABOUT.
    //
    // Run 024 produced a schedule that passed every gate with three columns
    // 350 mm tall: the lead had pointed each one's H at its own cross-section
    // dimension, which is a perfectly resolvable pointer at entirely the wrong
    // dimension. Nothing objected, because "H is resolved" was true, and the
    // aggregate looked plausible only because another member was over-claimed.
    //
    // This counts equal numbers. It says nothing about reinforcement, nothing
    // about what a column's height ought to be, and nothing about a target —
    // it observes that a member measured the same on every axis is a cube, and
    // asks whether that is what the drawing says. A footing that genuinely is
    // square keeps its two equal axes and is never mentioned.
    const memberSources = (mark: string): string => {
      const id = registry.members.find((x) => x.mark === mark)?.id;
      const src = id ? dimSources.get(id) : undefined;
      return Object.entries(src ?? {})
        .filter(([, v]) => v)
        .map(([ax, w]) => `${ax} from ${String(w).slice(0, 60)}`)
        .join('; ');
    };
    const cubes: string[] = [];
    for (const m of artifact.members) {
      const axes = [m.dims.L, m.dims.W, m.dims.H].filter((v): v is number => typeof v === 'number' && v > 0);
      if (axes.length < 3) continue;
      const min = Math.min(...axes);
      const max = Math.max(...axes);
      if (max - min > min * 0.02) continue;
      const src = memberSources(m.mark);
      cubes.push(
        `${m.mark} measures ${Math.round(max)} mm on ALL THREE axes (L, W and H).` +
          (src ? ` Its axes were read from: ${src}.` : '') +
          ' A member equal on every axis is a cube — if it is not one, an axis is pointed at a' +
          ' dimension that measures something else. Check what each was read from.',
      );
    }

    const barsBy = new Set(bars.map((b) => b.memberMark));
    return {
      n,
      rows: artifact.rows.length,
      netKg: artifact.netWeightKg ?? null,
      status: artifact.status,
      passed: artifact.verification.passed,
      failures: artifact.verification.failures.map((f) => ({
        gate: f.gate, memberMark: f.memberMark, field: f.field, message: f.message,
      })),
      membersWithoutPlacement: scheduled.filter((m) => !placed.get(m.id)?.ok).map((m) => m.mark),
      membersWithoutBars: scheduled.filter((m) => !barsBy.has(m.mark)).map((m) => m.mark),
      membersExcluded: [...memberExclusions.values()].map((x) => ({ mark: x.mark, why: x.why })),
      memberSummary: artifact.members.map((m) => {
        const id = registry.members.find((x) => x.mark === m.mark)?.id;
        return {
          mark: m.mark,
          count: m.count,
          rows: m.rowIds.length,
          kg: m.weightKg,
          L: m.dims.L,
          W: m.dims.W,
          H: m.dims.H,
          sources: id ? dimSources.get(id) : undefined,
        };
      }),
      duplicateSuspects,
      axisSuspects: cubes,
      sanity: [...(engine.sanity ?? [])],
    };
  }

  /** a build that THREW, reported as an attempt the orchestrator can read and react to */
  function crashedBuild(n: number, err: Error): BuildAttempt {
    return {
      n,
      rows: 0,
      netKg: null,
      status: 'failed',
      passed: [],
      failures: [{
        gate: 'build',
        message:
          `the build crashed rather than computed — ${err.message}. Everything recorded so far is intact; ` +
          'the fault is in one recorded conclusion or in the engine. Re-examine the most recent conclusions.',
      }],
      membersWithoutPlacement: [],
      membersWithoutBars: [],
      membersExcluded: [...memberExclusions.values()].map((x) => ({ mark: x.mark, why: x.why })),
      memberSummary: [],
      duplicateSuspects: [],
      axisSuspects: [],
      sanity: [],
    };
  }

  /** the outcome when not even a fallback build could produce an artifact — honest, empty, blocked */
  function emptyChatResult(): BbsChatResult {
    return {
      id: `orchestrated-${startedAt}`,
      status: 'blocked',
      project: { drawingName: opts.extract.drawingName, runMm: runMmForJob() },
      members: [],
      rows: [],
      diameterSummary: [],
      assumptions: [],
      warnings: [],
      gaps: [],
      extentClaims: [],
      verification: {
        passed: [],
        failures: [{ gate: 'schema', message: 'no build could run — see the build attempts for the crash' } as never],
        ok: false,
      },
    };
  }
}
