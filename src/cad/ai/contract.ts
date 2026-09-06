// The AI boundary.
//
// THE RULE: the model assigns meaning; this codebase computes every number.
// Nothing in this file carries a count, a length or an area, and the response
// validator below rejects any attempt to smuggle one in. A wrong label is a
// visible, one-click-fixable naming error; a wrong number would be invisible
// poison in a bill of quantities.
import type { CadLabel } from '../types';

// ------------------------------------------------------------
// what we send
// ------------------------------------------------------------

/** one candidate the model is asked to name */
export interface DigestItem {
  /** the raw CAD identifier — block name or layer name */
  key: string;
  kind: 'block' | 'layer';
  /** how many instances/entities — context only, the model must not echo it */
  count: number;
  /** layers the block appears on, or entity types present on the layer */
  context: string[];
  /** resolved colour, a strong hint on CAD drawings */
  color?: string;
  /**
   * Text printed BESIDE this symbol on the drawing — "63A,4P", "MCB", "10kA".
   *
   * The single most useful thing for identifying a block whose name is
   * meaningless, and it was not being sent at all. A person names
   * `A$C01413627` by reading the rating beside it, not by studying the glyph.
   */
  nearby?: string[];
  /** what a naming rule made of that text — a hint to weigh, never a verdict */
  hint?: string;
}

export interface Digest {
  drawingName: string;
  /** text harvested from the drawing — legend rows, titles, notes */
  textSamples: string[];
  items: DigestItem[];
}

/** a rendered image sent alongside the digest */
export interface CropImage {
  /** what this shows: a symbol thumbnail, the legend table, the overview */
  role: 'symbol' | 'legend' | 'overview';
  /** the digest key this image depicts, when role === 'symbol' */
  key?: string;
  /** data URL, image/png */
  dataUrl: string;
}

// ------------------------------------------------------------
// what we accept back
// ------------------------------------------------------------

export interface LabelSuggestion {
  key: string;
  label: string;
  discipline?: string;
  evidence?: string;
  confidence?: number;
}

export interface AnalysisResult {
  labels: LabelSuggestion[];
  /** free-text reading of what the drawing is; shown, never parsed */
  summary?: string;
}

const DISCIPLINES = new Set([
  'architectural',
  'structural',
  'electrical',
  'hvac',
  'plumbing',
  'fire',
  'civil',
  'annotation',
  'other',
]);

/** keys that must never appear in a model response — those are ours to compute */
const FORBIDDEN = /^(count|quantity|qty|total|length|area|volume|sum|measure)$/i;

/**
 * Parse and sanitise a model response.
 *
 * Tolerant of the usual model habits (fenced code blocks, a prose preamble),
 * strict about the contract: unknown keys are dropped, numeric quantity fields
 * are stripped, and anything that isn't a recognised digest key is discarded so
 * a hallucinated block name cannot enter the model.
 */

/**
 * Match a key the model returned against the keys we actually asked about.
 *
 * Models echo back the shape they were shown. Listing a key as "block: MCB"
 * gets "block:MCB" returned, which is not the key — and a strict lookup then
 * discards a perfectly good answer. That silently threw away all 41 labels on
 * the first real drawing this ran against. So: strip the kind prefix, trim
 * quotes and whitespace, and fall back to a case-insensitive match before
 * giving up. Unknown keys are still rejected — this widens the match, it does
 * not weaken the rule that a key must exist in the drawing.
 */
function resolveKey(raw: string, knownKeys: ReadonlySet<string>): string | null {
  let k = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (knownKeys.has(k)) return k;

  // "block: MCB" / "layer:WALL" / "block - MCB"
  const stripped = k.replace(/^\s*(block|layer|symbol)\s*[:\-]\s*/i, '').trim();
  if (stripped && knownKeys.has(stripped)) return stripped;

  // last resort: case-insensitive, since CAD names vary in case between the
  // BLOCK record and the INSERT that references it
  const lower = stripped.toLowerCase();
  for (const known of knownKeys) {
    if (known.toLowerCase() === lower) return known;
  }
  return null;
}

/**
 * Recover the complete entries from a response cut off mid-write.
 *
 * A truncated answer is not worthless: thirty symbols may be named perfectly
 * and only the thirty-first is half-written. Discarding all of it turns a
 * partial result into no result, and the request has been paid for either way.
 * Rewinds to the last point a value closed and shuts the open brackets.
 *
 * It invents nothing — it only drops the incomplete tail. Whatever survives is
 * still validated against the drawing's own key list below.
 */
function repairTruncatedJson(raw: string): string | null {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let cut = -1;
  let cutStack: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length > 0) {
        cut = i + 1;
        cutStack = [...stack];
      }
    }
  }
  if (cut < 0) return null;
  return raw.slice(0, cut) + [...cutStack].reverse().join('');
}

export function parseAnalysis(raw: string, knownKeys: ReadonlySet<string>): AnalysisResult {
  const json = extractJson(raw);
  if (!json) throw new Error('The model did not return JSON.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    const repaired = repairTruncatedJson(json);
    if (!repaired) {
      throw new Error(
        'The response was cut off before a single symbol was named. The drawing may have too ' +
          'many unknown symbols for one pass.',
      );
    }
    try {
      parsed = JSON.parse(repaired);
    } catch {
      throw new Error('The response was cut off and could not be recovered.');
    }
  }

  const root = parsed as { labels?: unknown; summary?: unknown };
  const rows = Array.isArray(root.labels) ? root.labels : [];
  const out: LabelSuggestion[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;

    for (const k of Object.keys(rec)) {
      if (FORBIDDEN.test(k)) delete rec[k];
    }

    const rawKey = typeof rec.key === 'string' ? rec.key : '';
    const label = typeof rec.label === 'string' ? rec.label.trim() : '';
    if (!rawKey || !label) continue;
    // only name things that actually exist in this drawing
    const key = resolveKey(rawKey, knownKeys);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const discipline =
      typeof rec.discipline === 'string' && DISCIPLINES.has(rec.discipline.toLowerCase())
        ? rec.discipline.toLowerCase()
        : undefined;
    const confidence =
      typeof rec.confidence === 'number' && Number.isFinite(rec.confidence)
        ? Math.min(1, Math.max(0, rec.confidence))
        : undefined;

    out.push({
      key,
      label: label.slice(0, 80),
      discipline,
      evidence: typeof rec.evidence === 'string' ? rec.evidence.slice(0, 200) : undefined,
      confidence,
    });
  }

  return {
    labels: out,
    summary: typeof root.summary === 'string' ? root.summary.slice(0, 1000) : undefined,
  };
}

/** pull the first JSON object out of a response that may be fenced or prefixed */
function extractJson(raw: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

export function toCadLabels(result: AnalysisResult): Map<string, CadLabel> {
  const map = new Map<string, CadLabel>();
  for (const s of result.labels) {
    map.set(s.key, {
      label: s.label,
      discipline: s.discipline,
      evidence: s.evidence,
      confidence: s.confidence,
      userSet: false,
    });
  }
  return map;
}

// ------------------------------------------------------------
// prompt
// ------------------------------------------------------------

export const SYSTEM_PROMPT = `You are a CAD drawing analyst. You are given a digest of a DXF drawing (layer names, block names, and text found in the drawing) and images (a legend table if one exists, thumbnails of individual block symbols, and an overview of the sheet).

Your ONLY job is to assign a human-readable meaning to each block and layer key.

Rules:
- Reason from evidence in the drawing itself: the legend/key table, annotation text near symbols, layer naming conventions, the shape of each symbol, and the drawing's discipline.
- CAD names are often mangled ("A$C64AE5EFA", "Tixt", "Full H Patition"). Infer what the thing IS, not what it is called.
- If a legend table is present, it is the strongest evidence. Match legend rows to symbols by shape.
- Say so when you are unsure: use a lower confidence rather than inventing a specific name.
- NEVER report counts, lengths, areas, totals or any other quantity. Those are measured from the geometry by the application. Any quantity you output is discarded.
- Only use keys that appear in the digest. Do not invent keys.

Respond with JSON only, in this exact shape:
{
  "summary": "one or two sentences on what this drawing is",
  "labels": [
    {
      "key": "<exact key from the digest>",
      "label": "Supply air diffuser",
      "discipline": "hvac",
      "evidence": "legend row 07; four-way square diffuser symbol",
      "confidence": 0.9
    }
  ]
}`;

export function buildUserPrompt(digest: Digest): string {
  const lines: string[] = [];
  lines.push(`Drawing: ${digest.drawingName}`);
  lines.push('');
  if (digest.textSamples.length) {
    lines.push('Text found in the drawing (may include a legend/key):');
    for (const t of digest.textSamples) lines.push(`  ${t}`);
    lines.push('');
  }
  lines.push(
    'Keys to name. Copy the key EXACTLY as it appears between the quotes —',
    'do not add a "block:" or "layer:" prefix, and do not change its case:',
  );
  for (const it of digest.items) {
    const ctx = it.context.length ? ` on ${it.context.slice(0, 4).join(', ')}` : '';
    const col = it.color ? `, colour ${it.color}` : '';
    lines.push(`  "${it.key}"  (${it.kind}${ctx}${col})`);
    if (it.nearby?.length) {
      lines.push(`        printed beside it: ${it.nearby.map((t) => JSON.stringify(t)).join(', ')}`);
    }
    if (it.hint) {
      lines.push(`        a naming rule suggests "${it.hint}" — a HINT only; the label may belong to a neighbouring symbol, so judge it against the text above`);
    }
  }
  return lines.join('\n');
}
