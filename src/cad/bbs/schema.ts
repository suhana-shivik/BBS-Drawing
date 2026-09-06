// ============================================================
// The AI-output boundary — one gate, not a hundred hand-written checks.
//
// WHY THIS EXISTS
//
// Three consecutive live runs died at this seam, each one field further along:
//
//   Run 008  an unknown decision `kind` fell through a switch → undefined.ok
//   Run 009  `"distributionAxis":"y"` reached a lookup table → names[0] threw
//   Run 010  `"basis":"visual-inspection"` where string[] was declared → .join
//
// Each was fixed where it bit. That is why there were three of them. The values
// were different, the field was different, the file was different — the DEFECT
// was identical: model output crossing into deterministic code without anything
// checking that it had the shape the code assumed.
//
// So the fix is not another field check. It is a gate every model response
// passes through, which knows the shape that was asked for, and which reports
// what arrived when the two differ.
//
// WHAT THIS FILE IS AND IS NOT
//
// It is INFRASTRUCTURE. It knows about strings, numbers, arrays, enums and
// objects. It knows nothing about reinforcement, and it must stay that way: the
// moment a rule like "F1 means template-repeat" appears here, engineering
// meaning is being decided by a validator rather than read from a drawing.
//
// IT DOES NOT COERCE. A string where an array was asked for is reported, not
// wrapped in brackets. The model may have meant one thing or several, and
// guessing which is how a schedule acquires a fact nobody established. The one
// exception is whitespace on a string, which carries no meaning at all.
//
// THE REPORT IS FOR A READER WHO CAN FIX IT. Every problem names the path, what
// was expected and what arrived, because the response goes back to the model
// and a message it cannot act on is a wasted turn.
// ============================================================

export interface Problem {
  /** dot/bracket path from the root of the response, e.g. `decisions[2].basis` */
  path: string;
  expected: string;
  received: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; problems: Problem[] };

export interface Validator<T> {
  /** how this shape is described back to the model */
  readonly describe: string;
  /** returns [] when acceptable; never throws */
  check(value: unknown, path: string): Problem[];
  /** the value, once `check` has passed */
  coerce?(value: unknown): T;
}

// ------------------------------------------------------------
// describing what actually arrived
// ------------------------------------------------------------

/** a short, honest rendering of a value — enough to see the mistake */
export function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'nothing (the field was absent)';
  if (Array.isArray(v)) return `an array of ${v.length} (${JSON.stringify(v).slice(0, 60)})`;
  switch (typeof v) {
    case 'string':
      return `the string ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)}`;
    case 'number':
      return `the number ${v}`;
    case 'boolean':
      return `the boolean ${v}`;
    case 'object':
      return `an object with keys ${JSON.stringify(Object.keys(v as object).slice(0, 8))}`;
    default:
      return typeof v;
  }
}

const problem = (path: string, expected: string, value: unknown): Problem => ({
  path,
  expected,
  received: describeValue(value),
});

// ------------------------------------------------------------
// leaves
// ------------------------------------------------------------

export function str(opts: { min?: number } = {}): Validator<string> {
  const describe = opts.min ? `a non-empty string` : 'a string';
  return {
    describe,
    check: (v, path) => {
      if (typeof v !== 'string') return [problem(path, describe, v)];
      if (opts.min && v.trim().length < opts.min) return [problem(path, describe, v)];
      return [];
    },
    coerce: (v) => (v as string).trim(),
  };
}

export function num(opts: { min?: number; max?: number; int?: boolean } = {}): Validator<number> {
  const bits = ['a number'];
  if (opts.int) bits.push('whole');
  if (opts.min !== undefined) bits.push(`at least ${opts.min}`);
  if (opts.max !== undefined) bits.push(`at most ${opts.max}`);
  const describe = bits.join(', ');
  return {
    describe,
    check: (v, path) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return [problem(path, describe, v)];
      if (opts.int && !Number.isInteger(v)) return [problem(path, describe, v)];
      if (opts.min !== undefined && v < opts.min) return [problem(path, describe, v)];
      if (opts.max !== undefined && v > opts.max) return [problem(path, describe, v)];
      return [];
    },
  };
}

export function bool(): Validator<boolean> {
  return {
    describe: 'true or false',
    check: (v, path) => (typeof v === 'boolean' ? [] : [problem(path, 'true or false', v)]),
  };
}

/**
 * One of a closed set.
 *
 * The legal values are quoted back in full. A model told only "invalid" has to
 * guess again; a model told the set can pick.
 */
export function enumOf<T extends string>(values: readonly T[]): Validator<T> {
  const describe = `one of: ${values.join(', ')}`;
  return {
    describe,
    check: (v, path) => (typeof v === 'string' && (values as readonly string[]).includes(v) ? [] : [problem(path, describe, v)]),
  };
}

/** anything at all — for payloads a later, better-informed check owns */
export function passthrough(describe = 'any value'): Validator<unknown> {
  return { describe, check: () => [] };
}

// ------------------------------------------------------------
// composites
// ------------------------------------------------------------

/**
 * An array of one shape.
 *
 * A BARE VALUE IS NOT SILENTLY WRAPPED. Run 010 sent `"basis":"visual-inspection"`
 * where `string[]` was declared; wrapping it would have worked that once and
 * hidden the mismatch for good. It is reported, with the fix spelled out.
 */
export function arrayOf<T>(item: Validator<T>, opts: { min?: number } = {}): Validator<T[]> {
  const describe = `an array of ${item.describe}${opts.min ? ` (at least ${opts.min})` : ''}`;
  return {
    describe,
    check: (v, path) => {
      if (!Array.isArray(v)) {
        const p = problem(path, describe, v);
        if (typeof v === 'string') {
          p.expected = `${describe} — if you meant one item, send it as an array: ["${v.slice(0, 30)}"]`;
        }
        return [p];
      }
      if (opts.min && v.length < opts.min) return [problem(path, describe, v)];
      return v.flatMap((el, i) => item.check(el, `${path}[${i}]`));
    },
    coerce: (v) => (v as unknown[]).map((el) => (item.coerce ? item.coerce(el) : el) as T),
  };
}

export interface Field<T> {
  validator: Validator<T>;
  required: boolean;
  /** other spellings the model may have used — named in the report */
  aka?: readonly string[];
}

export const required = <T>(v: Validator<T>, aka?: readonly string[]): Field<T> => ({ validator: v, required: true, aka });
export const optional = <T>(v: Validator<T>, aka?: readonly string[]): Field<T> => ({ validator: v, required: false, aka });

export type Shape = Record<string, Field<unknown>>;

/**
 * An object with named fields.
 *
 * When a required field is absent but a known alias is present, the report says
 * so by name. Run 010 sent `shape` for six turns because nothing ever told it
 * the word was `shapeCode` — "missing" is true but useless; "you sent `shape`,
 * the field is `shapeCode`" is actionable.
 */
export function object<T = Record<string, unknown>>(shape: Shape, opts: { name?: string } = {}): Validator<T> {
  const describe = opts.name ?? `an object`;
  return {
    describe,
    check: (v, path) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return [problem(path, describe, v)];
      const raw = v as Record<string, unknown>;
      const out: Problem[] = [];
      for (const [key, field] of Object.entries(shape)) {
        const at = path ? `${path}.${key}` : key;
        const present = raw[key] !== undefined && raw[key] !== null;
        if (!present) {
          const alias = (field.aka ?? []).find((k) => raw[k] !== undefined && raw[k] !== null);
          if (alias) {
            out.push({
              path: at,
              expected: `${field.validator.describe} — you sent it as "${alias}"; this contract reads "${key}"`,
              received: describeValue(raw[alias]),
            });
          } else if (field.required) {
            out.push(problem(at, field.validator.describe, raw[key]));
          }
          continue;
        }
        out.push(...field.validator.check(raw[key], at));
      }
      return out;
    },
    coerce: (v) => {
      const raw = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape)) {
        if (raw[key] === undefined || raw[key] === null) continue;
        out[key] = field.validator.coerce ? field.validator.coerce(raw[key]) : raw[key];
      }
      // carry anything the shape did not name, so a richer payload is not lost
      for (const [key, value] of Object.entries(raw)) if (!(key in out) && !(key in shape)) out[key] = value;
      return out as T;
    },
  };
}

/**
 * One of several shapes, chosen by a discriminant field.
 *
 * The report names the discriminant that was not recognised rather than dumping
 * every branch's problems, which is what makes a union usable in a refusal.
 */
export function taggedUnion<T>(
  tag: string,
  branches: Record<string, Validator<unknown>>,
  opts: { name?: string } = {},
): Validator<T> {
  const kinds = Object.keys(branches);
  const describe = opts.name ?? `an object whose "${tag}" is one of: ${kinds.join(', ')}`;
  return {
    describe,
    check: (v, path) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return [problem(path, describe, v)];
      const raw = v as Record<string, unknown>;
      const which = raw[tag];
      if (typeof which !== 'string' || !branches[which]) {
        return [problem(`${path}.${tag}`, `one of: ${kinds.join(', ')}`, which)];
      }
      return branches[which].check(v, path);
    },
    coerce: (v) => {
      const raw = v as Record<string, unknown>;
      const branch = branches[raw[tag] as string];
      return (branch?.coerce ? branch.coerce(v) : v) as T;
    },
  };
}

// ------------------------------------------------------------
// running the gate
// ------------------------------------------------------------

export function validate<T>(value: unknown, schema: Validator<T>): Checked<T> {
  let problems: Problem[];
  try {
    problems = schema.check(value, '');
  } catch (err) {
    // a validator that throws is a bug in this file, and must still not take
    // the run down with it
    return { ok: false, problems: [{ path: '', expected: schema.describe, received: `unreadable — ${(err as Error).message}` }] };
  }
  if (problems.length) return { ok: false, problems };
  try {
    return { ok: true, value: (schema.coerce ? schema.coerce(value) : value) as T };
  } catch (err) {
    return { ok: false, problems: [{ path: '', expected: schema.describe, received: `unreadable — ${(err as Error).message}` }] };
  }
}

/**
 * The report the model reads.
 *
 * Capped, because a reply with fifty problems is usually one mistake repeated
 * and a wall of text buries the fix.
 */
export function explain(problems: readonly Problem[], limit = 8): string {
  const head = problems.slice(0, limit).map(
    (p) => `  ${p.path || '(the whole response)'} — expected ${p.expected}; received ${p.received}`,
  );
  const more = problems.length > limit ? [`  …and ${problems.length - limit} more of the same kind`] : [];
  return [
    'YOUR LAST RESPONSE DID NOT MATCH THE CONTRACT. Nothing in it was applied.',
    ...head,
    ...more,
    'Fix those fields and send the response again. Nothing was assumed on your behalf.',
  ].join('\n');
}
