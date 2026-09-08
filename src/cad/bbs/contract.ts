// ============================================================
// The AI → deterministic boundary, written down in one place.
//
// WHY THIS FILE EXISTS
//
// Run 009 died with `TypeError: Cannot read properties of undefined (reading
// '0')` inside computeLength. The path was short and entirely avoidable: the
// model wrote `"distributionAxis":"y"`, applyDecision did not check it, the
// value reached build.ts, `PERPENDICULAR['y']` was undefined, and `names[0]`
// threw. Fourteen steps of correct ownership work died with it.
//
// The audit that followed found the crash was the LEAST of it. The same run
// also sent `"barType":"MESH"`, and Run 008 sent `"BAR"` and `"LINK"` — none of
// which are legal BarType values, and all of which were accepted. Those do not
// crash. A bar typed "LINK" simply fails `isStirrupBar`, is treated as a
// straight bar, and is quietly given the wrong cutting length. A wrong number
// delivered confidently is worse than a stack trace, because nothing announces
// it.
//
// So the rule is now explicit and total:
//
//     NO UNVALIDATED MODEL STRING REACHES DETERMINISTIC CODE.
//
// Every enum below is the value set the ENGINE actually consumes — imported
// from the engine's own types where one exists, so the two cannot drift. A
// value outside the set is refused by name, with the legal values quoted back,
// and the model gets another turn.
//
// WHAT THIS FILE DOES NOT DO
//
// It does not translate. "x" is not quietly rewritten to "L", and "LINK" is not
// quietly rewritten to "STIRRUP", because either would be this file deciding
// engineering meaning from a guess about what the model intended. The drawing
// decides meaning; a validator only decides whether the words are ones the
// engine knows.
// ============================================================
import { SHAPES } from '../../domain/india/bbs';
import type { ShapeCode } from '../../domain/india/bbs';

/** the axes a member is measured on, and the only ones bars may be spaced along */
export const AXES = ['L', 'W', 'H'] as const;

/**
 * Every bar type `build.ts` can reason about.
 *
 * Kept in step with `BbsBar['barType']`. `isStirrupBar` and the shape defaults
 * both branch on this, so an unknown value does not fail loudly — it silently
 * takes the non-stirrup path.
 */
export const BAR_TYPES = [
  'MAIN', 'DISTRIBUTION', 'TOP', 'BOTTOM', 'CROSS',
  'STIRRUP', 'RING', 'TIE', 'EXTRA', 'CRANK', 'CURTAILMENT',
] as const;

/**
 * The bar types as a TYPE, so what `checkEnum` proves at the gate can be
 * carried in the types afterwards rather than re-asserted with a cast at the
 * far end. `as never` at a call site does not make a value valid; it only
 * stops the compiler asking. The gate is what makes it valid — this lets the
 * gate say so.
 */
export type BarTypeName = (typeof BAR_TYPES)[number];

/** True for a value the gate would accept. Narrows, so no cast is needed. */
export function isBarType(value: unknown): value is BarTypeName {
  return typeof value === 'string' && (BAR_TYPES as readonly string[]).includes(value);
}

export function isShapeCode(value: unknown): value is ShapeCode {
  return typeof value === 'string' && SHAPE_CODES.includes(value);
}

/**
 * Shape codes, taken from the engine's own table so the two cannot diverge.
 *
 * Sorted, because `Object.keys` puts integer-like keys first and leaves "00"
 * and "POL" at the end — a legal-values list a model has to read should not
 * open with "11, 21, 31" and mention the straight bar last.
 */
export const SHAPE_CODES = Object.keys(SHAPES).sort() as readonly string[];

/** how a callout may be tied to a member — ranked by tier in ownership.ts */
export const OWNERSHIP_BASES = ['in-detail', 'leader-terminates', 'strong-geometry', 'proximity'] as const;

/** the closed set of placement kinds `placement.ts` can resolve */
export const PLACEMENT_KINDS = [
  'continuous', 'marks', 'template-repeat', 'periodic-pattern', 'uniform', 'dependent', 'once', 'unknown',
] as const;

/** the decision kinds stage 2 accepts */
export const DECISION_KINDS = [
  'own', 'shared', 'exclude', 'dimension', 'placement', 'shape', 'askUser', 'unresolved', 'done',
] as const;

export interface EnumCheck {
  /** the decision kind the field belongs to, e.g. 'own' */
  decision: string;
  /** the canonical field name — the one the contract reads */
  field: string;
  value: unknown;
  legal: readonly string[];
  /** the callout or member the decision is about, when there is one */
  subject?: string;
  /** when false, an absent value passes */
  required?: boolean;
  /**
   * Field names the model plausibly used instead. Naming them in the refusal
   * turns "that is wrong" into "that is wrong, and here is the word to use" —
   * Run 009 sent `shape` for six turns because nothing ever said `shapeCode`.
   */
  akaFields?: readonly string[];
  /** the raw decision, so a mis-named field can be spotted and reported */
  raw?: Record<string, unknown>;
}

/**
 * Check one model-supplied enum.
 *
 * Returns null when the value is acceptable, or a refusal string naming the
 * decision, the field, what arrived and what is legal. The message is written
 * to be actionable on the next turn: the orchestrator sees it in its transcript
 * and can re-send the decision correctly.
 */
export function checkEnum(c: EnumCheck): string | null {
  const present = c.value !== undefined && c.value !== null && c.value !== '';
  const about = c.subject ? ` for ${c.subject}` : '';

  if (!present) {
    // the value is missing under its canonical name — but it may have arrived
    // under another, which is a far more useful thing to say
    const alias = (c.akaFields ?? []).find(
      (k) => c.raw && c.raw[k] !== undefined && c.raw[k] !== null && c.raw[k] !== '',
    );
    if (alias) {
      return (
        `${c.decision}${about}: this contract reads "${c.field}", and you sent "${alias}". ` +
        `Re-send it as "${c.field}":${JSON.stringify(c.raw![alias])}. Legal values: ${c.legal.join(', ')}.`
      );
    }
    if (c.required) {
      return `${c.decision}${about}: "${c.field}" is missing. It must be one of: ${c.legal.join(', ')}.`;
    }
    return null;
  }

  if (typeof c.value !== 'string' || !c.legal.includes(c.value)) {
    return (
      `${c.decision}${about}: "${c.field}" was ${JSON.stringify(c.value)}, which is not a legal value. ` +
      `Use one of: ${c.legal.join(', ')}.`
    );
  }
  return null;
}

/**
 * The axis refusal, spelled out.
 *
 * `x`/`y`/`z` are the natural thing for an engineer to write and the exact
 * thing that crashed Run 009, so the refusal explains what L/W/H MEAN rather
 * than only listing them — otherwise the model has no way to map its intent
 * onto the contract and will keep guessing.
 */
export function checkDistributionAxis(
  decision: string,
  value: unknown,
  subject?: string,
  raw?: Record<string, unknown>,
): string | null {
  const base = checkEnum({
    decision, field: 'distributionAxis', value, legal: AXES, subject, required: false, raw,
  });
  if (!base) return null;
  return (
    `${base} These are the MEMBER'S OWN axes, not sheet coordinates: L is its length, ` +
    'W its width, H its height. A bar spaced along the length of a beam is "L". If you do not ' +
    'know which axis it marches along, omit the field rather than guessing.'
  );
}
