// ============================================================
// The drawing splitter behind the harness contract.
//
// A THIN ADAPTER (PRODUCT_AS_HARNESS.md §5): splitDrawing's loop, guards and
// package shape are untouched. This file only translates:
//
//   events   → already {step, ask, served} — the splitter is the shape the
//              contract standardised on. Forwarded verbatim (step clamped
//              monotonic for safety) and collected into the result.
//   budget   → maxRounds maps to the splitter's own maxRounds — its BASE
//              budget; the loop's coverage-remediation rule may extend the
//              round limit by up to its recorded REMEDIATION_ROUNDS, and that
//              proven behaviour is deliberately not overridden here.
//              maxToolCalls and maxMs have no native counterpart, so the
//              adapter enforces them at the transport seam: the wrapped
//              transport counts served tool calls and checks the deadline,
//              and on exhaustion aborts the run's signal — splitDrawing
//              already breaks cleanly on an aborted signal, so partial work
//              (sections cut so far, coverage, audit trail) is kept and the
//              result names the tripped budget in `stoppedBecause`. Nothing
//              is silently truncated.
//   output   → the DrawingUnderstandingPackage, untranslated.
// ============================================================

import {
  openRouterTransport,
  splitDrawing,
  ORCHESTRATOR_TOOLS,
  type ChatTransport,
  type SplitOptions,
} from '../cad/understanding/orchestrator';
import type { DrawingUnderstandingPackage } from '../cad/understanding/types';
import type { CadDocument } from '../cad/types';
import type { HarnessBudget, HarnessContract, HarnessEvent, HarnessResult, ToolSpec } from './contract';

/** Everything splitDrawing takes, minus what the adapter owns, plus the doc. */
export type SplitterHarnessInput = { doc: CadDocument } & Omit<
  SplitOptions,
  'onEvent' | 'maxRounds' | 'signal'
> & { signal?: AbortSignal };

/** Mirrors the splitter's own MAX_ROUNDS default (orchestrator.ts). */
export const SPLITTER_DEFAULT_BUDGET: HarnessBudget = { maxRounds: 14 };

/** The splitter's four tools, straight off its own declaration. */
export function splitterToolSpecs(): ToolSpec[] {
  return (ORCHESTRATOR_TOOLS as readonly { function: { name: string; description: string; parameters: unknown } }[]).map(
    (t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters }),
  );
}

/** Wrap the drawing splitter in the harness contract. */
export function createSplitterHarness(
  budget: Partial<HarnessBudget> = {},
): HarnessContract<SplitterHarnessInput, DrawingUnderstandingPackage> {
  const fullBudget: HarnessBudget = { ...SPLITTER_DEFAULT_BUDGET, ...budget };

  const harness: HarnessContract<SplitterHarnessInput, DrawingUnderstandingPackage> = {
    tools: splitterToolSpecs(),
    budget: fullBudget,
    async run(input: SplitterHarnessInput): Promise<HarnessResult<DrawingUnderstandingPackage>> {
      const { doc, ...options } = input;
      const events: HarnessEvent[] = [];
      let lastStep = 0;
      let tripped: string | undefined;

      // budget enforcement at the transport seam (see header)
      const ctl = new AbortController();
      if (options.signal) {
        if (options.signal.aborted) ctl.abort();
        else options.signal.addEventListener('abort', () => ctl.abort(), { once: true });
      }
      const startedAt = Date.now();
      const deadline = fullBudget.maxMs !== undefined ? startedAt + fullBudget.maxMs : null;
      let toolCallsServed = 0;

      const inner = options.transport ?? openRouterTransport;
      // an empty reply after abort is the transport saying "nothing served";
      // the aborted signal ends the loop at the next round boundary, and the
      // result names the budget that tripped — never a fabricated model turn.
      const trip = (what: string): { content: string; toolCalls: never[] } => {
        if (!tripped) tripped = what;
        ctl.abort();
        return { content: '', toolCalls: [] };
      };
      const transport: ChatTransport = async (req) => {
        if (deadline !== null && Date.now() > deadline) {
          return trip(`budget: maxMs (${fullBudget.maxMs}ms) exhausted`);
        }
        if (fullBudget.maxToolCalls !== undefined && toolCallsServed >= fullBudget.maxToolCalls) {
          return trip(`budget: maxToolCalls (${fullBudget.maxToolCalls}) exhausted`);
        }
        const reply = await inner(req);
        toolCallsServed += reply.toolCalls.length;
        return reply;
      };

      // the wrapped transport must not make a real model run read as a
      // stand-in — keep the splitter's own inference over the ORIGINAL wiring
      const source =
        options.source ?? (options.transport && options.transport !== openRouterTransport ? 'local' : 'model');

      const pkg = await splitDrawing(doc, {
        ...options,
        source,
        transport,
        signal: ctl.signal,
        maxRounds: fullBudget.maxRounds,
        onEvent: (e) => {
          const step = Math.max(lastStep, e.step);
          lastStep = step;
          const unified: HarnessEvent = { step, ask: e.ask, served: e.served };
          events.push(unified);
          harness.onEvent?.(unified);
        },
      });

      return { output: pkg, steps: lastStep, events, stoppedBecause: tripped };
    },
  };
  return harness;
}
