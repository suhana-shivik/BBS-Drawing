// ============================================================
// The one network call.
//
// One drawing = one request. Digest + images go up, a JSON list of MEANINGS
// comes back, and `parseAnalysis` throws away anything that is not a label for
// a key this drawing actually contains. The model never sees a quantity it
// could echo, and the validator strips quantity fields regardless — every
// count, length and area a user reads is computed from geometry by
// `metrics.ts` / `takeoff.ts`.
//
// Failures here are user-facing, so every one of them names the thing to fix:
// a missing key, a text-only model, an empty account, a rejected response.
// ============================================================
import type { CadDocument } from '../types';
import type { AnalysisResult, CropImage, Digest } from './contract';
import { SYSTEM_PROMPT, buildUserPrompt, parseAnalysis } from './contract';
import { getAiConfig, isAiConfigured, isVisionCapable } from './config';
import { buildDigest, digestKeys } from './digest';
import { MAX_SYMBOLS, buildCrops, payloadBytes } from './crops';
import { userSetKeys } from './labels';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** the model this feature was designed against; named in every model error */
export const RECOMMENDED_VISION_MODEL = 'google/gemini-2.5-flash';

export interface AiProgress {
  phase: string;
  pct: number;
}

export interface AnalyseOptions {
  onProgress?: (p: AiProgress) => void;
  signal?: AbortSignal;
  /** cap on symbol thumbnails; the legend and overview are always attempted */
  maxSymbols?: number;
  /**
   * Set false for a deliberate text-only pass (no images rendered, no images
   * sent, `textModel` used). This is the ONLY way to run a text-only model:
   * the default path refuses rather than quietly dropping the evidence.
   */
  images?: boolean;
  /**
   * Keys not to ask about. Defaults to the keys a human has already settled,
   * so a correction is never re-litigated. Ignored if it would empty the
   * digest.
   */
  skipKeys?: ReadonlySet<string>;
}

/** what actually went over the wire, for the UI's "what did this cost" line */
export interface AnalysisReport {
  result: AnalysisResult;
  digest: Digest;
  crops: CropImage[];
  model: string;
  /** base64 bytes of the attached images */
  payloadBytes: number;
}

// ------------------------------------------------------------
// cancellation
// ------------------------------------------------------------

export class AnalysisAborted extends Error {
  constructor() {
    super('Analysis cancelled.');
    this.name = 'AnalysisAborted';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AnalysisAborted();
}

// ------------------------------------------------------------
// guards — checked before a request is spent
// ------------------------------------------------------------

export function assertConfigured(): void {
  if (!isAiConfigured()) {
    throw new Error(
      'Add your OpenRouter key to run AI labelling. Paste a key from ' +
        'openrouter.ai/keys into Settings, or set VITE_OPENROUTER_API_KEY in .env and restart.',
    );
  }
}

export function assertVision(model: string): void {
  if (!isVisionCapable(model)) {
    throw new Error(
      `"${model}" is a text-only model — it cannot see the legend or the symbol ` +
        `thumbnails, which is most of the evidence for this pass. Switch to a vision ` +
        `model (${RECOMMENDED_VISION_MODEL} is the recommended one) in Settings or ` +
        `VITE_OPENROUTER_VISION_MODEL.`,
    );
  }
}

// ------------------------------------------------------------
// request / response plumbing
// ------------------------------------------------------------

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

function describeCrop(crop: CropImage): string {
  switch (crop.role) {
    case 'legend':
      return 'Image: the legend / key table cropped out of this drawing. This is the strongest evidence — match its rows to the symbols below by shape.';
    case 'overview':
      return 'Image: the whole sheet, for context about the discipline and what kind of drawing this is.';
    default:
      return `Image: the symbol drawn by block "${crop.key ?? ''}". It depicts the digest key "${crop.key ?? ''}".`;
  }
}

/** the user turn: prompt text first, then each image behind a caption */
export function buildMessageContent(digest: Digest, crops: readonly CropImage[]): ContentPart[] {
  const parts: ContentPart[] = [{ type: 'text', text: buildUserPrompt(digest) }];
  for (const crop of crops) {
    if (!crop.dataUrl) continue;
    parts.push({ type: 'text', text: describeCrop(crop) });
    parts.push({ type: 'image_url', image_url: { url: crop.dataUrl } });
  }
  return parts;
}

function referer(): string {
  try {
    if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  } catch {
    /* non-browser */
  }
  return 'https://localhost';
}

/** OpenRouter puts something useful in its 4xx bodies; dig it out */
export function messageFromErrorBody(status: number, body: string): string {
  let detail = '';
  try {
    const json = JSON.parse(body) as {
      error?: { message?: string; metadata?: Record<string, unknown> };
      message?: string;
    };
    detail = json.error?.message ?? json.message ?? '';
    // "Provider returned error" on its own is unactionable — it says something
    // broke without saying what. OpenRouter puts the upstream provider's OWN
    // complaint in error.metadata.raw, and that is the only text that names
    // the real cause. Hoist it, with the provider it came from.
    const meta = json.error?.metadata;
    if (meta) {
      const raw =
        typeof meta.raw === 'string'
          ? meta.raw
          : meta.raw !== undefined
            ? JSON.stringify(meta.raw)
            : '';
      const who = typeof meta.provider_name === 'string' ? meta.provider_name : '';
      const extra = [who && `provider: ${who}`, raw && raw.slice(0, 400)]
        .filter(Boolean)
        .join(' — ');
      if (extra) detail = detail ? `${detail} — ${extra}` : extra;
    }
  } catch {
    detail = body.slice(0, 300);
  }
  detail = detail.trim();

  const hint =
    status === 401 || status === 403
      ? 'The OpenRouter key was rejected. Check it at openrouter.ai/keys.'
      : status === 402
        ? 'This OpenRouter account has no credit left for that model.'
        : status === 404
          ? /data policy|privacy|guardrail/i.test(detail)
            ? // A 404 here is NOT always a bad model id: free/experimental models
              // are often served only by providers that may train on prompts, and
              // an account that (sensibly) blocks those gets "no endpoints". The
              // old message sent someone hunting a typo that did not exist.
              'Your OpenRouter data-policy settings block every provider serving this ' +
              'model (experimental models often require training consent). Either allow ' +
              'that at openrouter.ai/settings/privacy — noting your drawings would go to ' +
              'a provider that may train on them — or pick a non-experimental model.'
            : 'OpenRouter does not know that model id. Check VITE_OPENROUTER_VISION_MODEL.'
          : status === 429
            ? 'OpenRouter is rate-limiting this key. Wait a moment and try again.'
            : status >= 500
              ? 'OpenRouter or the upstream provider failed. This is usually transient.'
              : 'OpenRouter rejected the request.';

  return detail ? `${hint} (${detail})` : hint;
}

/** the assistant text, whether the provider returned a string or content parts */
export function contentOf(payload: unknown): string {
  const root = payload as {
    error?: { message?: string };
    choices?: { message?: { content?: unknown } }[];
  };
  if (root?.error?.message) throw new Error(`The model returned an error: ${root.error.message}`);

  const content = root?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join('');
  }
  return '';
}

/**
 * The JSON object in a reply, found by WALKING it.
 *
 * A model asked for JSON frequently sends a sentence first — "Reading the
 * board: ten investigations have reported… {…}" — and sometimes a note after.
 * Taking `slice(indexOf('{'), lastIndexOf('}'))` reaches for the last brace in
 * the WHOLE string, so a single brace in trailing prose makes the slice
 * unparseable and a long, sound reply is lost entire. One live run discarded
 * two twelve-thousand-character replies that way, and told nobody.
 *
 * So: from the first `{`, count depth, respecting strings and their escapes,
 * and stop at the brace that closes it. Returns null when the object never
 * closes, which is the honest answer for a genuinely truncated reply.
 *
 * THIS DECIDES NOTHING ABOUT MEANING. It reads the bytes; whatever the object
 * contains still faces its contract unchanged.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse a model reply that should be one JSON object, however it was wrapped. */
export function parseModelJson(raw: unknown): Record<string, unknown> | null {
  const t = String(raw ?? '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  if (!t) return null;
  try { return JSON.parse(t) as Record<string, unknown>; } catch { /* narration around it */ }
  const walked = extractJsonObject(t);
  if (walked) { try { return JSON.parse(walked) as Record<string, unknown>; } catch { /* fall through */ } }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) as Record<string, unknown>; } catch { return null; } }
  return null;
}

// ------------------------------------------------------------
// entry point
// ------------------------------------------------------------

/**
 * Label one drawing.
 *
 * Returns suggestions only — nothing is written to the session here. Apply
 * them with `applyAnalysis` so the human-correction precedence in `labels.ts`
 * is the single place that decides what wins.
 */
export async function analyseDrawing(
  doc: CadDocument,
  opts: AnalyseOptions = {},
): Promise<AnalysisResult> {
  return (await analyseDrawingDetailed(doc, opts)).result;
}

/** as `analyseDrawing`, but also reports what was sent */
export async function analyseDrawingDetailed(
  doc: CadDocument,
  opts: AnalyseOptions = {},
): Promise<AnalysisReport> {
  const report = (phase: string, pct: number): void => opts.onProgress?.({ phase, pct });
  const withImages = opts.images !== false;

  // guards first: never spend a request, or the seconds of rasterisation
  // before it, on a call that cannot succeed
  assertConfigured();
  const cfg = getAiConfig();
  const model = withImages ? cfg.visionModel : cfg.textModel;
  if (withImages) assertVision(model);

  throwIfAborted(opts.signal);
  report('Reading drawing', 4);

  const skip = opts.skipKeys ?? userSetKeys();
  let digest = buildDigest(doc, { skipKeys: skip });
  // a skip list that leaves nothing to ask about means the caller wanted a
  // re-run; ask about everything rather than sending an empty request
  if (digest.items.length === 0) digest = buildDigest(doc);
  if (digest.items.length === 0) {
    throw new Error('This drawing has no named blocks or layers to label.');
  }

  throwIfAborted(opts.signal);
  report('Reading drawing', 10);

  let crops: CropImage[] = [];
  if (withImages) {
    const total = 2 + Math.min(opts.maxSymbols ?? MAX_SYMBOLS, digest.items.length);
    crops = await buildCrops(doc, digest, {
      maxSymbols: opts.maxSymbols,
      signal: opts.signal,
      onProgress: (done) =>
        report('Rendering symbols', Math.min(45, 10 + Math.round((done / total) * 35))),
    });
    throwIfAborted(opts.signal);
  }

  report('Asking the model', 50);

  const body = {
    model,
    // low temperature: this is evidence reading, not invention
    temperature: 0.1,
    // A drawing with forty unnamed symbols needs a long answer, and an 8k cap
    // cut it off mid-word — which surfaced to the user as "malformed JSON",
    // blaming the format for what was a size problem. Same failure the BBS
    // reader had.
    max_tokens: 32000,
    // Reasoning tokens are billed against `max_tokens` BEFORE any JSON is
    // written, so a thinking model can spend the whole budget deliberating and
    // emit nothing. Naming a symbol from a legend is recognition, not
    // deduction; a low budget leaves the room for output.
    reasoning: { effort: 'low' },
    // harmless when the provider ignores it, and it removes the prose preamble
    // that otherwise has to be stripped back out
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildMessageContent(digest, crops) },
    ],
  };

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter attribution
        'HTTP-Referer': referer(),
        'X-Title': cfg.appName,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new AnalysisAborted();
    throw new Error(
      `Could not reach OpenRouter: ${err instanceof Error ? err.message : String(err)}. ` +
        'Check the network connection and try again.',
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(messageFromErrorBody(res.status, text));
  }

  report('Asking the model', 85);

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error('OpenRouter returned a response that was not JSON.');
  }
  throwIfAborted(opts.signal);

  const content = contentOf(payload);
  if (!content.trim()) {
    throw new Error(
      `${model} returned an empty response. This usually means the request was too ` +
        'large or the provider refused it — try again with fewer symbol images.',
    );
  }

  report('Applying labels', 92);

  // knownKeys is OURS, never the model's: a hallucinated block name cannot
  // enter the document
  const result = parseAnalysis(content, digestKeys(digest));
  if (result.labels.length === 0) {
    throw new Error(
      `${model} did not name any of this drawing's blocks or layers. Re-run, or ` +
        'switch models — nothing was changed.',
    );
  }

  report('Applying labels', 100);

  return { result, digest, crops, model, payloadBytes: payloadBytes(crops) };
}
