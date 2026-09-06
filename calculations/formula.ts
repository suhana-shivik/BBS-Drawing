// ============================================================
// A SAFE FORMULA — the only way a person's own arithmetic reaches a row.
//
// A schedule sometimes carries a rule the shape library does not: "bars =
// L / S + 1 on both faces", "length = 2 × (W − 2 × COVER) + 20 × DIA". Such
// a rule is a FORMULA the person states, and it is evaluated here — by a
// parser that admits exactly the seven engineering variables, arithmetic, and
// a handful of rounding functions, and nothing else. No `eval`, no
// `Function`, no identifier that is not on the list: a formula that names
// anything unknown is refused with the name, not executed with a guess.
//
// Variables (all in millimetres):
//   L      member length          W      member width
//   H      member height/depth    T      thickness (= H when not given)
//   S      bar spacing            COVER  clear cover
//   DIA    bar diameter
// ============================================================

export const FORMULA_VARIABLES = ['L', 'W', 'H', 'T', 'S', 'COVER', 'DIA'] as const;
export type FormulaVariable = (typeof FORMULA_VARIABLES)[number];
export type FormulaVariables = Partial<Record<FormulaVariable, number>>;

const FUNCTIONS: Record<string, { arity: number; fn: (...a: number[]) => number }> = {
  CEIL: { arity: 1, fn: Math.ceil },
  FLOOR: { arity: 1, fn: Math.floor },
  ROUND: { arity: 1, fn: Math.round },
  ABS: { arity: 1, fn: Math.abs },
  SQRT: { arity: 1, fn: Math.sqrt },
  MAX: { arity: 2, fn: Math.max },
  MIN: { arity: 2, fn: Math.min },
};

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: FormulaVariable }
  | { kind: 'fn'; name: string }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' | '^' | 'neg' }
  | { kind: '(' }
  | { kind: ')' }
  | { kind: ',' };

export interface FormulaResult {
  ok: boolean;
  value?: number;
  /** the variables the formula actually read — its dependency list */
  used: FormulaVariable[];
  /** the substituted arithmetic, so a trace can show why */
  working?: string;
  reason?: string;
}

const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3, neg: 4 };
const RIGHT_ASSOC = new Set(['^', 'neg']);

function tokenise(expr: string): { ok: true; tokens: Token[] } | { ok: false; reason: string } {
  const tokens: Token[] = [];
  const src = expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) return { ok: false, reason: `malformed number at position ${i + 1}` };
      tokens.push({ kind: 'num', value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      const name = m[0].toUpperCase();
      i += m[0].length;
      if ((FORMULA_VARIABLES as readonly string[]).includes(name)) {
        tokens.push({ kind: 'var', name: name as FormulaVariable });
      } else if (FUNCTIONS[name]) {
        tokens.push({ kind: 'fn', name });
      } else {
        return {
          ok: false,
          reason:
            `"${m[0]}" is not an allowed variable or function — allowed: ` +
            `${FORMULA_VARIABLES.join(', ')}; ${Object.keys(FUNCTIONS).join(', ')}`,
        };
      }
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      tokens.push({ kind: c });
      i++;
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '^') {
      const prev = tokens[tokens.length - 1];
      const unary = c === '-' && (!prev || prev.kind === 'op' || prev.kind === '(' || prev.kind === ',');
      tokens.push({ kind: 'op', op: unary ? 'neg' : c });
      i++;
      continue;
    }
    return { ok: false, reason: `character "${c}" at position ${i + 1} is not part of a formula` };
  }
  return { ok: true, tokens };
}

/** shunting-yard to RPN; refuses anything the grammar does not cover */
function toRpn(tokens: Token[]): { ok: true; rpn: Token[] } | { ok: false; reason: string } {
  const out: Token[] = [];
  const stack: Token[] = [];
  for (const t of tokens) {
    switch (t.kind) {
      case 'num':
      case 'var':
        out.push(t);
        break;
      case 'fn':
        stack.push(t);
        break;
      case ',':
        while (stack.length && stack[stack.length - 1].kind !== '(') out.push(stack.pop()!);
        if (!stack.length) return { ok: false, reason: 'a comma outside a function call' };
        break;
      case 'op': {
        while (stack.length) {
          const top = stack[stack.length - 1];
          if (top.kind !== 'op') break;
          const higher = PRECEDENCE[top.op] > PRECEDENCE[t.op];
          const equalLeft = PRECEDENCE[top.op] === PRECEDENCE[t.op] && !RIGHT_ASSOC.has(t.op);
          if (higher || equalLeft) out.push(stack.pop()!);
          else break;
        }
        stack.push(t);
        break;
      }
      case '(':
        stack.push(t);
        break;
      case ')': {
        while (stack.length && stack[stack.length - 1].kind !== '(') out.push(stack.pop()!);
        if (!stack.length) return { ok: false, reason: 'a closing bracket with no opening one' };
        stack.pop();
        if (stack.length && stack[stack.length - 1].kind === 'fn') out.push(stack.pop()!);
        break;
      }
    }
  }
  while (stack.length) {
    const t = stack.pop()!;
    if (t.kind === '(') return { ok: false, reason: 'an opening bracket that is never closed' };
    out.push(t);
  }
  return { ok: true, rpn: out };
}

/**
 * Evaluate a formula against the variables a row can offer. A variable the
 * formula names but the row cannot supply is reported by name — the row is
 * then waiting on that fact, exactly like a missing dimension.
 */
export function evaluateFormula(expr: string, vars: FormulaVariables): FormulaResult {
  if (typeof expr !== 'string' || !expr.trim()) return { ok: false, used: [], reason: 'the formula is empty' };
  if (expr.length > 500) return { ok: false, used: [], reason: 'the formula is longer than 500 characters' };
  const lexed = tokenise(expr);
  if (!lexed.ok) return { ok: false, used: [], reason: lexed.reason };
  const parsed = toRpn(lexed.tokens);
  if (!parsed.ok) return { ok: false, used: [], reason: parsed.reason };

  const used = new Set<FormulaVariable>();
  const stack: number[] = [];
  const substituted: string[] = [];
  for (const t of parsed.rpn) {
    if (t.kind === 'num') {
      stack.push(t.value);
      continue;
    }
    if (t.kind === 'var') {
      const v = vars[t.name];
      used.add(t.name);
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return { ok: false, used: [...used], reason: `${t.name} is not on record for this row` };
      }
      stack.push(v);
      if (!substituted.includes(`${t.name}=${v}`)) substituted.push(`${t.name}=${v}`);
      continue;
    }
    if (t.kind === 'fn') {
      const f = FUNCTIONS[t.name];
      if (stack.length < f.arity) return { ok: false, used: [...used], reason: `${t.name} needs ${f.arity} argument(s)` };
      const args = stack.splice(stack.length - f.arity, f.arity);
      stack.push(f.fn(...args));
      continue;
    }
    if (t.kind === 'op') {
      if (t.op === 'neg') {
        if (!stack.length) return { ok: false, used: [...used], reason: 'a minus sign with nothing to negate' };
        stack.push(-stack.pop()!);
        continue;
      }
      if (stack.length < 2) return { ok: false, used: [...used], reason: `operator ${t.op} is missing an operand` };
      const b = stack.pop()!;
      const a = stack.pop()!;
      if (t.op === '/' && b === 0) return { ok: false, used: [...used], reason: 'division by zero' };
      stack.push(t.op === '+' ? a + b : t.op === '-' ? a - b : t.op === '*' ? a * b : t.op === '/' ? a / b : a ** b);
      continue;
    }
    return { ok: false, used: [...used], reason: 'the formula did not parse' };
  }
  if (stack.length !== 1) return { ok: false, used: [...used], reason: 'the formula does not reduce to one value' };
  const value = stack[0];
  if (!Number.isFinite(value)) return { ok: false, used: [...used], reason: 'the formula produced no finite value' };
  return {
    ok: true,
    value,
    used: [...used],
    working: `${expr.trim()} with ${substituted.join(', ') || 'no variables'} = ${value}`,
  };
}
