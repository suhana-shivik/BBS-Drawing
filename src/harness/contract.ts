// ============================================================
// The harness contract — Layer 3 (PRODUCT_AS_HARNESS.md §5).
//
// Two real harnesses exist: the BBS orchestrator (src/cad/bbs/orchestrate.ts,
// ~40 paid runs of encoded regression knowledge) and the drawing splitter
// (src/cad/understanding/orchestrator.ts). They are deliberately NOT merged —
// §5's warning stands: extract the contract, not the implementation. Each gets
// a thin adapter (bbsHarness.ts, splitterHarness.ts) that translates inputs,
// outputs, budgets and events into this one shape; neither harness internal
// is rewritten, and neither harness's own event emission changes.
//
// The one event shape is §5's first cheap win: the BBS trail
// ({kind, turn?, taskId?, detail}) and the splitter trail ({step, ask, served})
// differ only by parallel evolution, and one UI component should render both.
// ============================================================

/** One tool a harness offers its model — name, purpose, and how it is called. */
export interface ToolSpec {
  name: string;
  description: string;
  /**
   * How the tool is invoked. The splitter declares JSON-schema parameter
   * objects; the BBS harness declares its args as a menu string. Both are
   * carried verbatim — the contract unifies the shape of the list, not the
   * dialect each harness speaks to its own model.
   */
  parameters?: unknown;
}

/**
 * One line of a harness's activity trail — the unified shape (§5 cheap win #1).
 * `step` is the loop round (monotonic, non-decreasing within a run), `ask` is
 * what was asked or attempted, `served` is what came back.
 */
export interface HarnessEvent {
  step: number;
  ask: string;
  served: string;
}

/**
 * Safety rails, never a plan: the harness decides the work, the budget only
 * stops a runaway. Optional fields a harness cannot natively honour are
 * enforced by its adapter (documented per adapter) — never silently dropped.
 */
export interface HarnessBudget {
  maxRounds: number;
  maxToolCalls?: number;
  maxMs?: number;
}

/**
 * What a run under the contract returns. `output` is the harness's own
 * outcome, untranslated — the adapters translate the envelope, not the
 * hard-won internals.
 */
export interface HarnessResult<T = unknown> {
  output: T;
  /** rounds actually taken (the last step observed) */
  steps: number;
  /** the full unified trail, in order */
  events: HarnessEvent[];
  /** why the run ended, when the harness or its budget can say */
  stoppedBecause?: string;
}

/**
 * The contract both harnesses implement (PRODUCT_AS_HARNESS.md §5, verbatim
 * shape). A skill's resolution loop can run on either without knowing which;
 * convergence, if it ever happens, becomes a refactor with a green test suite
 * instead of a rewrite.
 */
export interface HarnessContract<I = unknown, O = unknown> {
  tools: ToolSpec[];
  run(input: I): Promise<HarnessResult<O>>;
  onEvent?(e: HarnessEvent): void;
  budget: HarnessBudget;
}
