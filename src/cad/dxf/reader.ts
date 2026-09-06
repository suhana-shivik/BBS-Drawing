// Low-level DXF group-code reader.
//
// A DXF file is a flat stream of (code, value) pairs. Everything above this
// module works on that stream rather than on raw text.
export interface Pair {
  code: number;
  value: string;
}

/**
 * Parse the whole file into a pair stream. Tolerant: blank lines, stray
 * text and odd line endings are skipped rather than throwing, because real
 * files from the wild contain all three.
 */
export function readPairs(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: Pair[] = [];
  let i = 0;
  const n = lines.length;
  while (i + 1 < n) {
    const raw = lines[i];
    // fast path: most lines are a short numeric code
    const codeStr = raw.trim();
    if (codeStr === '') {
      i += 1;
      continue;
    }
    const code = Number(codeStr);
    if (!Number.isInteger(code)) {
      i += 1; // resync
      continue;
    }
    out.push({ code, value: lines[i + 1] ?? '' });
    i += 2;
  }
  return out;
}

/** an entity/table-record: its 0-code type plus every pair up to the next 0 */
export interface Record0 {
  type: string;
  pairs: Pair[];
}

/** first value for a group code */
export function val(r: Record0, code: number): string | undefined {
  const p = r.pairs.find((q) => q.code === code);
  return p ? p.value.trim() : undefined;
}

/** first numeric value for a group code */
export function num(r: Record0, code: number): number | undefined {
  const s = val(r, code);
  if (s === undefined || s === '') return undefined;
  const f = Number(s);
  return Number.isFinite(f) ? f : undefined;
}

export function numOr(r: Record0, code: number, fallback: number): number {
  const v = num(r, code);
  return v === undefined ? fallback : v;
}

/** every value for a repeated group code, in order */
export function allNums(r: Record0, code: number): number[] {
  const out: number[] = [];
  for (const p of r.pairs) {
    if (p.code === code) {
      const f = Number(p.value);
      if (Number.isFinite(f)) out.push(f);
    }
  }
  return out;
}

/**
 * Collect (x, y) pairs from two group codes, keeping them associated in
 * declaration order. DXF interleaves 10/20 per vertex, so a naive
 * "all 10s then all 20s" read silently mismatches on malformed files.
 */
export function points(r: Record0, xCode: number, yCode: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let px: number | undefined;
  for (const p of r.pairs) {
    if (p.code === xCode) {
      px = Number(p.value);
    } else if (p.code === yCode && px !== undefined) {
      const py = Number(p.value);
      if (Number.isFinite(px) && Number.isFinite(py)) out.push({ x: px, y: py });
      px = undefined;
    }
  }
  return out;
}

/** index of the start of a named SECTION's body, or -1 */
export function findSection(pairs: Pair[], name: string): [number, number] | null {
  const upper = name.toUpperCase();
  let start = -1;
  for (let i = 0; i < pairs.length - 1; i++) {
    if (
      pairs[i].code === 0 &&
      pairs[i].value.trim().toUpperCase() === 'SECTION' &&
      pairs[i + 1].code === 2 &&
      pairs[i + 1].value.trim().toUpperCase() === upper
    ) {
      start = i + 2;
      break;
    }
  }
  if (start < 0) return null;
  for (let i = start; i < pairs.length; i++) {
    if (pairs[i].code === 0 && pairs[i].value.trim().toUpperCase() === 'ENDSEC') {
      return [start, i];
    }
  }
  return [start, pairs.length];
}

/** split a pair range into 0-code delimited records */
export function splitRecords(pairs: Pair[], from: number, to: number): Record0[] {
  const out: Record0[] = [];
  let cur: Record0 | null = null;
  for (let i = from; i < to; i++) {
    const p = pairs[i];
    if (p.code === 0) {
      cur = { type: p.value.trim().toUpperCase(), pairs: [] };
      out.push(cur);
    } else if (cur) {
      cur.pairs.push(p);
    }
  }
  return out;
}

/** a HEADER variable's pairs, e.g. headerVar(pairs, '$INSUNITS') */
export function headerVar(pairs: Pair[], name: string): Pair[] {
  const sec = findSection(pairs, 'HEADER');
  if (!sec) return [];
  const upper = name.toUpperCase();
  for (let i = sec[0]; i < sec[1]; i++) {
    if (pairs[i].code === 9 && pairs[i].value.trim().toUpperCase() === upper) {
      const out: Pair[] = [];
      for (let j = i + 1; j < sec[1] && pairs[j].code !== 9; j++) out.push(pairs[j]);
      return out;
    }
  }
  return [];
}

export function headerNum(pairs: Pair[], name: string, code: number): number | undefined {
  for (const p of headerVar(pairs, name)) {
    if (p.code === code) {
      const f = Number(p.value);
      if (Number.isFinite(f)) return f;
    }
  }
  return undefined;
}
