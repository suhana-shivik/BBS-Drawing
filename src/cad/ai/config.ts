// OpenRouter configuration.
//
// The key is read from `.env` (gitignored) at build time. Vite inlines every
// VITE_* variable into the bundle, so this is appropriate for a local,
// single-user tool and NOT for a build handed to untrusted users. A key can
// also be supplied at runtime and kept in localStorage, which keeps it out of
// the bundle entirely.
const LS_KEY = 'bimcad.openrouter.key';

export interface AiConfig {
  apiKey: string;
  visionModel: string;
  textModel: string;
  /**
   * The second reader that checks a finished schedule against the drawing —
   * deliberately a DIFFERENT model from the one that produced it, because a
   * model asked to check its own reading tends to agree with it.
   */
  judgeModel: string;
  appName: string;
}

function env(name: string): string {
  const v = (import.meta.env as Record<string, string | undefined>)[name];
  return typeof v === 'string' ? v.trim() : '';
}

/** runtime key wins over the build-time one, so a user can paste their own */
export function getApiKey(): string {
  try {
    const stored = localStorage.getItem(LS_KEY);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    /* storage unavailable — fall through to the env key */
  }
  return env('VITE_OPENROUTER_API_KEY');
}

export function setApiKey(key: string): void {
  try {
    if (key.trim()) localStorage.setItem(LS_KEY, key.trim());
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

export function getAiConfig(): AiConfig {
  const vision = env('VITE_OPENROUTER_VISION_MODEL') || 'google/gemini-2.5-flash';
  return {
    apiKey: getApiKey(),
    visionModel: vision,
    // a text-only model is fine for the digest pass; fall back to the vision one
    textModel: env('VITE_OPENROUTER_TEXT_MODEL') || vision,
    // A judge that cannot see the sheet is checking a transcription, not a
    // drawing — so the default is the VISION DeepSeek, the one the
    // TEXT_ONLY regex below was written to let through.
    judgeModel: env('VITE_OPENROUTER_JUDGE_MODEL') || 'deepseek/deepseek-v4-flash-vision-exp',
    appName: env('VITE_OPENROUTER_APP_NAME') || 'BIMCAD Studio',
  };
}

export function isAiConfigured(): boolean {
  return getApiKey().length > 0;
}

/**
 * Models that cannot accept images. The symbol/legend pass is inherently
 * visual, so pointing it at one of these produces confident nonsense — worth
 * catching before a request is spent.
 */
// "deepseek" alone is no longer a text-only tell: DeepSeek V4 Flash VISION
// exists and is exactly the model this gate must not block. A vision-suffixed
// DeepSeek passes; the text-only ones still trip the guard.
const TEXT_ONLY = [
  /deepseek(?!.*(vision|vl))/i,
  /^mistralai\/mistral-(7b|small)/i,
  /qwen[\d.]*-?(?!vl)[a-z]*-instruct/i,
];

export function isVisionCapable(model: string): boolean {
  return !TEXT_ONLY.some((re) => re.test(model));
}
