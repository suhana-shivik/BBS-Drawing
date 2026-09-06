// ============================================================
// The resolution loop — PRODUCT_AS_HARNESS.md §4.2, implemented faithfully:
//
//   facts ← memory.load(project)
//   for each req in skill.requires not satisfied by facts:
//       candidate ← register.search(req.likelyIn, cross-references)
//       if candidate:  split it → transcribe it → append facts
//       else:          facts.record(req.key, state='missing', ask=req.ask)
//   output ← skill.compute(facts)            # deterministic
//   rows whose requirements are 'missing' emit as BLOCKED formulas
//
// This module is the HARNESS side of the layering rule: the skill never sees
// the splitter or the transcriber; it reads the FactSet this loop deposits in
// memory. Every collaborator (splitter harness, transcriber, document loader,
// ledger store) is injected — the loop is proven unpaid, with fakes.
//
// Bounded everywhere: drawings searched and splits per run are capped, and
// EVERY skip is named in `skips` — no silent fallbacks. Everything a run
// learns is deposited in the ledger and persisted, so the next run starts
// from it instead of re-searching (the §4.2 payoff).
//
// Drawing selection follows HOW_TO_BUILD_IT.md §6.5's three signals:
//   1. the register's discipline + title            — implemented below
//   2. the drawing's own cross-references           — seam, see selectCandidateDrawing
//   3. the shape of the missing fact                — carried by req.likelyIn,
//      which the skill author encoded from exactly this signal
// ============================================================

import type { CadDocument } from '../cad/types';
import type { DrawingDiscipline, DrawingRegisterData, DrawingRegisterEntry } from '../register/types';
import { emptyLedger, recordFact, resolveFact, type Ledger } from '../facts/ledger';
import { loadLedgerIdb, saveLedgerIdb } from '../facts/store';
import { factsFromTranscription, type DeclaredFactInput } from '../facts/writers';
import { isUsable, type Fact } from '../facts/types';
import { requirementsUnmet } from './index';
import {
  SkillNotComputable,
  type FactRequirement,
  type FactSet,
  type Skill,
  type SkillFactState,
  type SkillFactValue,
  type SkillOutput,
} from './types';

// ------------------------------------------------------------
// injected collaborators — structural, so this module depends on the
// harness CONTRACT's shape, never on a concrete harness implementation
// ------------------------------------------------------------

/** The slice of a split package the loop consumes. */
export interface SplitPackageLike {
  sections: readonly { sectionId: string; label: string; kind?: string; png?: string }[];
  sourceDrawingHash?: string;
}

/**
 * The splitter, as the loop sees it: anything satisfying the harness
 * contract's `run` whose output is a split package. The real adapter
 * (src/harness/splitterHarness.ts) satisfies this structurally.
 */
export interface SplitRunner {
  run(input: { doc: CadDocument; projectId: string }): Promise<{ output: SplitPackageLike }>;
}

/** What the transcription stage is asked for (see src/harness/transcribe.ts). */
export interface TranscribeRequest {
  drawingNumber: string;
  revision: string;
  sections: readonly { sectionId: string; label: string; kind?: string; png?: string }[];
  /** the facts the caller is hunting — steer the model, never dictate values */
  wanted: readonly { key: string; ask: string }[];
}

/** Section package → DECLARED fact inputs. Throws rather than guessing. */
export type Transcriber = (req: TranscribeRequest) => Promise<DeclaredFactInput[]>;

export interface LedgerStore {
  load(projectId: string): Promise<Ledger | null>;
  save(projectId: string, ledger: Ledger): Promise<unknown>;
}

export interface RunSkillBounds {
  /** register entries examined across the whole run */
  maxDrawingsSearched: number;
  /** split-harness invocations per run */
  maxSplitsPerRun: number;
}

export const DEFAULT_RUN_BOUNDS: RunSkillBounds = {
  maxDrawingsSearched: 12,
  maxSplitsPerRun: 2,
};

export interface RunSkillContext {
  projectId: string;
  register: DrawingRegisterData | null;
  /**
   * Explicit spend gate: only when true may the loop invoke the splitter or
   * the transcriber. When false, a found candidate is recorded MISSING with
   * the skip named — never a silent model call.
   */
  allowModelCalls: boolean;
  splitter?: SplitRunner;
  transcribe?: Transcriber;
  loadDocument?: (entry: DrawingRegisterEntry) => Promise<CadDocument | null>;
  /** defaults to the IndexedDB-with-localStorage-fallback store in src/facts */
  ledgerStore?: LedgerStore;
  bounds?: Partial<RunSkillBounds>;
  /**
   * Per-run conclusions the harness deposits for the skill — e.g. the BBS
   * orchestrator's 'bbs.extract' / 'bbs.interpretation' objects. The ledger's
   * Fact.value is scalar by design (rule 1: no field a dimension could be
   * typed into, and provenance-first storage); these are structured per-run
   * artifacts, so they ride alongside memory rather than inside it.
   * Ledger facts always win over a conclusion under the same key.
   */
  // seam: when FACT-HISTORY grows an object-valued conclusions store, move
  // these deposits there and delete this channel.
  conclusions?: Record<string, SkillFactValue>;
}

export interface SkillRunResult {
  /** the deterministic compute's output, or null when it refused to run */
  output: SkillOutput | null;
  /** set when compute threw SkillNotComputable — the refusal, verbatim */
  notComputable?: string;
  /** facts recordFact ACCEPTED this run (MISSING records included) */
  factsWritten: Fact[];
  /** requirements MISSING or contradicted after the run — the open questions */
  factsMissing: Fact[];
  /** every skip, named — the loop never falls back silently */
  skips: string[];
  /** split-harness invocations this run actually made */
  splitsRun: number;
  /** register entries examined this run */
  drawingsSearched: number;
  ledger: Ledger;
  /** whether the ledger landed in the injected/default store */
  persisted: boolean;
}

// ------------------------------------------------------------
// memory → FactSet
// ------------------------------------------------------------

const FACT_UNITS = ['mm', 'm', 'mm2', 'deg'] as const;

function skillUnit(unit: string | undefined): SkillFactValue['unit'] {
  return (FACT_UNITS as readonly string[]).includes(unit ?? '')
    ? (unit as SkillFactValue['unit'])
    : undefined;
}

/**
 * The current (non-superseded) facts of a ledger, as the FactSet a skill
 * reads. States map 1:1, lowercased — except a CONTRADICTED fact (two
 * equal-trust readings disagreeing, `isUsable` false), which enters as
 * 'missing': the contract's rule (open question 3) is that an unresolved
 * disagreement BLOCKS exactly like a hole, so a compute must never stand a
 * number on the disputed value. The contradicted ledger fact still wins over
 * a per-run conclusion under the same key — a dispute is not a licence to
 * fall back silently.
 */
// seam: stale facts (source drawing re-imported, hash changed) still satisfy
// requirements here; when FACT-HISTORY's revision-impact APIs land, decide
// whether stale DECLARED facts should re-enter the loop instead.
export function factSetFromLedger(
  ledger: Ledger,
  conclusions?: Record<string, SkillFactValue>,
): FactSet {
  const map = new Map<string, SkillFactValue>(Object.entries(conclusions ?? {}));
  for (const e of ledger.entries) {
    if (e.fact.supersededBy !== undefined) continue;
    map.set(e.fact.id, {
      value: e.fact.value,
      unit: skillUnit(e.fact.unit),
      state: isUsable(e.fact) ? (e.fact.state.toLowerCase() as SkillFactState) : 'missing',
    });
  }
  return map;
}

// ------------------------------------------------------------
// drawing selection — HOW_TO_BUILD_IT.md §6.5
// ------------------------------------------------------------

/**
 * Which register disciplines a requirement's `likelyIn` points at. 'site'
 * drawings file under civil (or general when unclassified); 'brief' is not a
 * drawing at all — nothing to search, straight to the ask.
 */
const LIKELY_DISCIPLINES: Record<NonNullable<FactRequirement['likelyIn']>, DrawingDiscipline[]> = {
  architectural: ['architectural'],
  structural: ['structural'],
  site: ['civil', 'general'],
  brief: [],
};

export interface CandidateSearch {
  candidate: DrawingRegisterEntry | null;
  /** what was searched, in words — becomes the MISSING fact's lookedIn */
  searched: string[];
  /** register entries examined (counts against maxDrawingsSearched) */
  examined: number;
}

/**
 * Signal 1: the register's discipline + title. Current-revision entries in
 * the requirement's likely disciplines, ranked by whether the title carries
 * the fact's subject word ('wall' from 'wall.total_run').
 *
 * Signal 2 — the drawing's own cross-references (off-sheet section marks,
 * "REFER ARCH-101" notes) — is the strongest signal available and is NOT yet
 * extracted anywhere in this codebase.
 */
// seam: when cross-reference extraction exists (splitter notes / find_text
// harvest per HOW_TO_BUILD_IT §6.5 signal 2), rank a drawing the source sheet
// itself names ABOVE any title match here, and add it to `searched` so
// lookedIn stays honest.
export function selectCandidateDrawing(
  register: DrawingRegisterData | null,
  req: FactRequirement,
  maxExamine: number,
): CandidateSearch {
  if (req.likelyIn === 'brief' || req.likelyIn === undefined) {
    return {
      candidate: null,
      searched: [
        req.likelyIn === 'brief'
          ? 'no drawing — the client brief is not in the register; ask'
          : 'no drawing — the requirement names no likely discipline; ask',
      ],
      examined: 0,
    };
  }
  const disciplines = LIKELY_DISCIPLINES[req.likelyIn];
  if (!register || register.entries.length === 0) {
    return {
      candidate: null,
      searched: [`register: empty — no ${disciplines.join('/')} drawing to read`],
      examined: 0,
    };
  }
  if (maxExamine <= 0) {
    return {
      candidate: null,
      searched: ['register: not searched — drawing search budget exhausted'],
      examined: 0,
    };
  }

  const subject = req.key.split('.')[0].toLowerCase();
  const pool = register.entries
    .filter((e) => e.revisionState === 'current' && disciplines.includes(e.discipline))
    .slice(0, maxExamine);

  const titled = (e: DrawingRegisterEntry): string =>
    `${e.title} ${e.displayName}`.toLowerCase();
  const byTitle = pool.filter((e) => titled(e).includes(subject));
  const candidate = byTitle[0] ?? pool[0] ?? null;

  const searched = [
    `register(${register.projectId}): ${disciplines.join('/')} drawings for "${req.key}"`,
    ...pool.map((e) => `${e.drawingNumber} "${e.title}" (${e.discipline}, rev ${e.revision})`),
  ];
  if (!pool.length) searched.push(`no current ${disciplines.join('/')} drawing in the register`);
  return { candidate, searched, examined: pool.length };
}

// ------------------------------------------------------------
// the loop
// ------------------------------------------------------------

const today = (): string => new Date().toISOString().slice(0, 10);

/** Run one skill against project memory — §4.2, see the module header. */
export async function runSkill(skill: Skill, ctx: RunSkillContext): Promise<SkillRunResult> {
  const bounds: RunSkillBounds = { ...DEFAULT_RUN_BOUNDS, ...(ctx.bounds ?? {}) };
  const store: LedgerStore = ctx.ledgerStore ?? { load: loadLedgerIdb, save: saveLedgerIdb };

  let ledger = (await store.load(ctx.projectId)) ?? emptyLedger();
  const skips: string[] = [];
  const factsWritten: Fact[] = [];
  let splitsRun = 0;
  let drawingsSearched = 0;
  /** one split serves every requirement pointing at the same drawing */
  const splitCache = new Map<string, SplitPackageLike | null>();

  const record = (fact: Fact): void => {
    const r = recordFact(ledger, fact);
    ledger = r.ledger;
    if (r.accepted) factsWritten.push(fact);
    else skips.push(`${fact.id}: recorded as contradicted, not current — ${r.reason}`);
  };

  /**
   * Record MISSING once: a current MISSING fact already documents the failed
   * search, and re-recording it would only pile contradiction entries onto
   * the ledger. The skip is named either way.
   */
  const recordMissing = (req: FactRequirement, lookedIn: string[], why?: string): void => {
    if (why) skips.push(`${req.key}: ${why}`);
    const current = resolveFact(ledger, req.key);
    if (current && current.state === 'MISSING') {
      skips.push(`${req.key}: already recorded MISSING (${current.readOn}) — not re-recorded`);
      return;
    }
    record({
      id: req.key,
      value: null,
      state: 'MISSING',
      lookedIn,
      ask: req.ask,
      neededFor: req.blocks,
      readOn: today(),
    });
  };

  const unmet = requirementsUnmet(skill, factSetFromLedger(ledger, ctx.conclusions));

  for (const req of unmet) {
    // a transcription earlier in this run may already have landed this one
    const already = resolveFact(ledger, req.key);
    if (already && already.state !== 'MISSING') {
      // a CONTRADICTED fact reaches here (it maps to 'missing' in the
      // FactSet): re-reading drawings cannot settle which claim governs —
      // only a human answer (SUPPLIED, via recordFact's resolution path)
      // can. Blocked, named, never re-searched.
      if (already.contradicted === true) {
        skips.push(
          `${req.key}: contradicted — equal-trust readings disagree; ` +
            `blocked until a human answer settles which governs, not re-searched`,
        );
      }
      continue;
    }

    const search = selectCandidateDrawing(
      ctx.register,
      req,
      bounds.maxDrawingsSearched - drawingsSearched,
    );
    drawingsSearched += search.examined;

    if (!search.candidate) {
      recordMissing(req, search.searched);
      continue;
    }
    const cand = search.candidate;
    const candName = `${cand.drawingNumber} "${cand.title}"`;

    if (!ctx.allowModelCalls) {
      recordMissing(
        req,
        [...search.searched, `candidate ${candName} not read — model calls not allowed`],
        `candidate ${candName} found but ctx.allowModelCalls is false`,
      );
      continue;
    }
    // spending is allowed — missing wiring is a caller bug, not a search
    // failure, and recording MISSING for it would lie about what happened
    if (!ctx.splitter || !ctx.transcribe || !ctx.loadDocument) {
      throw new Error(
        `runSkill(${skill.name}): allowModelCalls is true but ` +
          `${[
            !ctx.splitter && 'splitter',
            !ctx.transcribe && 'transcribe',
            !ctx.loadDocument && 'loadDocument',
          ]
            .filter(Boolean)
            .join(', ')} not provided`,
      );
    }

    // split (once per drawing per run, bounded)
    let pkg = splitCache.get(cand.documentId);
    if (pkg === undefined) {
      if (splitsRun >= bounds.maxSplitsPerRun) {
        recordMissing(
          req,
          [...search.searched, `candidate ${candName} not read — split budget exhausted`],
          `split budget (${bounds.maxSplitsPerRun}) exhausted before reading ${candName}`,
        );
        continue;
      }
      const doc = await ctx.loadDocument(cand);
      if (!doc) {
        splitCache.set(cand.documentId, null);
        recordMissing(
          req,
          [...search.searched, `candidate ${candName} could not be loaded`],
          `document for ${candName} could not be loaded`,
        );
        continue;
      }
      splitsRun += 1;
      try {
        pkg = (await ctx.splitter.run({ doc, projectId: ctx.projectId })).output;
      } catch (err) {
        pkg = null;
        skips.push(`${req.key}: splitter failed on ${candName} — ${(err as Error).message}`);
      }
      splitCache.set(cand.documentId, pkg);
      if (pkg === null) {
        recordMissing(req, [...search.searched, `${candName} — splitter failed`]);
        continue;
      }
    } else if (pkg === null) {
      recordMissing(
        req,
        [...search.searched, `${candName} — already failed earlier this run`],
        `${candName} already failed earlier this run`,
      );
      continue;
    }

    // transcribe → DECLARED facts, appended via the trust-ordered writer
    try {
      const declared = await ctx.transcribe({
        drawingNumber: cand.drawingNumber,
        revision: cand.revision,
        sections: pkg.sections,
        wanted: [{ key: req.key, ask: req.ask }],
      });
      const facts = factsFromTranscription(declared, {
        drawingNumber: cand.drawingNumber,
        revision: cand.revision,
        documentId: cand.documentId,
        ...(pkg.sourceDrawingHash !== undefined
          ? { sourceDrawingHash: pkg.sourceDrawingHash }
          : {}),
      });
      for (const f of facts) record(f);
    } catch (err) {
      recordMissing(
        req,
        [...search.searched, `${candName} split into ${pkg.sections.length} section(s); transcription refused`],
        `transcription refused for ${candName} — ${(err as Error).message}`,
      );
      continue;
    }

    // did the drawing actually state it? absence after reading is MISSING —
    // with the drawing that WAS read named, never a guess
    const landed = resolveFact(ledger, req.key);
    if (!landed || landed.state === 'MISSING') {
      recordMissing(req, [
        ...search.searched,
        `${candName} read (${pkg.sections.length} section(s) transcribed) — "${req.key}" not stated on it`,
      ]);
    }
  }

  // output ← skill.compute(facts) — deterministic; BLOCKED rows are the
  // skill layer's own §6.4 behaviour. A refusal is returned, not swallowed:
  // everything learned is still deposited and persisted.
  let output: SkillOutput | null = null;
  let notComputable: string | undefined;
  try {
    output = skill.compute(factSetFromLedger(ledger, ctx.conclusions));
  } catch (err) {
    if (err instanceof SkillNotComputable) notComputable = err.message;
    else throw err;
  }

  // the open questions: MISSING requirements, plus contradicted ones — an
  // unresolved equal-trust disagreement blocks (and asks) the same way
  const factsMissing = skill.requires
    .map((r) => resolveFact(ledger, r.key))
    .filter((f): f is Fact => !!f && !isUsable(f));

  // saveLedgerIdb resolves false only when neither IndexedDB nor localStorage
  // landed; a void-returning injected store counts as success — a failing one
  // should throw, loudly.
  const persisted = (await store.save(ctx.projectId, ledger)) !== false;

  return {
    output,
    ...(notComputable !== undefined ? { notComputable } : {}),
    factsWritten,
    factsMissing,
    skips,
    splitsRun,
    drawingsSearched,
    ledger,
    persisted,
  };
}
