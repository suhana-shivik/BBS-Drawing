// ============================================================
// The BBS orchestrator behind the harness contract.
//
// A THIN ADAPTER (PRODUCT_AS_HARNESS.md §5): runOrchestrator is 1,700 lines
// of behaviour bought with ~forty paid runs, and none of it is rewritten or
// re-entered here. This file only translates:
//
//   budget   → the orchestrator's own Limits (maxRounds → maxOrchestratorTurns,
//              maxToolCalls → maxAiCalls — the loop's own accounting unit for
//              model spend — and maxMs → maxMs). The loop already enforces all
//              three internally and stops gracefully, so budget enforcement is
//              the harness's proven machinery, reached through the mapping.
//   events   → the unified {step, ask, served} shape (§5 cheap win #1). The
//              BBS trail is {kind, turn?, taskId?, detail}; `turn` becomes
//              `step` — clamped monotonic, because task events can arrive
//              without a turn — `kind` (plus taskId) becomes `ask`, `detail`
//              becomes `served`. The orchestrator's own emission is untouched,
//              so the existing UI progress rendering keeps working.
//   output   → returned whole (OrchestrateOutcome), untranslated.
// ============================================================

import {
  runOrchestrator,
  type Limits,
  type OrchestrateOptions,
  type OrchestrateOutcome,
} from '../cad/bbs/orchestrate';
import { TOOL_MENU } from '../cad/bbs/tools';
import type { HarnessBudget, HarnessContract, HarnessEvent, HarnessResult, ToolSpec } from './contract';

/** Everything runOrchestrator takes, minus what the adapter owns. */
export type BbsHarnessInput = Omit<OrchestrateOptions, 'limits' | 'onEvent'>;

/**
 * Mirrors the orchestrator's own default LIMITS (orchestrate.ts) — the values
 * a run gets when no budget is passed, stated here so the contract's budget is
 * never silently different from what the loop enforces.
 */
export const BBS_DEFAULT_BUDGET: Required<HarnessBudget> = {
  maxRounds: 12, // LIMITS.maxOrchestratorTurns
  maxToolCalls: 80, // LIMITS.maxAiCalls
  maxMs: 30 * 60 * 1000, // LIMITS.maxMs
};

/** The BBS tool surface, as ToolSpecs — the menu the loop itself renders. */
export function bbsToolSpecs(): ToolSpec[] {
  return TOOL_MENU.map((t) => ({ name: t.name, description: t.use, parameters: t.args }));
}

/**
 * Wrap the BBS orchestrator in the harness contract.
 *
 * `tuning` reaches the Limits fields the budget does not name (concurrency,
 * specialist turns, …); the three budget-mapped fields always win from the
 * budget, so a contract budget can never be quietly overridden.
 */
export function createBbsHarness(
  budget: Partial<HarnessBudget> = {},
  tuning: Partial<Limits> = {},
): HarnessContract<BbsHarnessInput, OrchestrateOutcome> {
  const fullBudget: Required<HarnessBudget> = { ...BBS_DEFAULT_BUDGET, ...budget };

  const harness: HarnessContract<BbsHarnessInput, OrchestrateOutcome> = {
    tools: bbsToolSpecs(),
    budget: fullBudget,
    async run(input: BbsHarnessInput): Promise<HarnessResult<OrchestrateOutcome>> {
      const events: HarnessEvent[] = [];
      // task events carry no turn; a turnless event belongs to the round in
      // progress. Clamping keeps `step` monotonic even if turns interleave.
      let lastStep = 1;

      const outcome = await runOrchestrator({
        ...input,
        limits: {
          ...tuning,
          maxOrchestratorTurns: fullBudget.maxRounds,
          maxAiCalls: fullBudget.maxToolCalls,
          maxMs: fullBudget.maxMs,
        },
        onEvent: (e) => {
          const step = Math.max(lastStep, e.turn ?? lastStep);
          lastStep = step;
          const unified: HarnessEvent = {
            step,
            ask: e.taskId ? `${e.kind} ${e.taskId}` : e.kind,
            served: e.detail,
          };
          events.push(unified);
          harness.onEvent?.(unified);
        },
      });

      return {
        output: outcome,
        steps: Math.max(outcome.turns, lastStep),
        events,
        stoppedBecause: outcome.stoppedBecause,
      };
    },
  };
  return harness;
}
