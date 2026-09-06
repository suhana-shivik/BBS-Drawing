// Every model call this app makes, recorded.
//
// WHY THIS EXISTS
//
// A failed request used to surface as a toast and then vanish. The user was
// left knowing only that "the analysis failed" — not which task, which model,
// what it cost, or what the provider actually said. On a tool whose whole
// premise is that you can audit what the AI did, an unlogged failure is the
// worst kind of gap: it is precisely the moment you most need the detail.
//
// So every call writes a row here, success or failure, with the provider's own
// words kept verbatim on error. This is the harness's flight recorder.
//
// It holds no quantities and no interpretations — only what was asked, of
// whom, how long it took, what it cost and whether it worked. Nothing here
// feeds back into a prompt; it exists to be READ by a person.
const LS_KEY = 'bimcad.ai.log';
const MAX_RUNS = 80;

export type AiTask = 'read' | 'chat' | 'quantities' | 'bbs' | 'system-graph';

export interface AiRun {
  at: number;
  task: AiTask;
  drawing: string;
  model?: string;
  ok: boolean;
  /** a one-line outcome on success; the provider's verbatim words on failure */
  message: string;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  /** 'length' here is the signature of a response cut off mid-write */
  finishReason?: string;
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeAiLog(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function read(): AiRun[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v as AiRun[];
    }
  } catch {
    /* corrupt — a lost log must never break a request */
  }
  return [];
}

/** Newest first — the run you want is almost always the last one. */
export function recentRuns(limit = MAX_RUNS): AiRun[] {
  return read().slice(-limit).reverse();
}

export function logRun(run: Omit<AiRun, 'at'>): void {
  try {
    const all = read();
    all.push({ ...run, at: Date.now() });
    localStorage.setItem(LS_KEY, JSON.stringify(all.slice(-MAX_RUNS)));
  } catch {
    /* best-effort: never let logging fail a request */
  }
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* one broken listener must not stop the rest */
    }
  }
}

export function clearAiLog(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* best-effort */
  }
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Pull usage out of an OpenRouter payload.
 *
 * Tolerant by design: usage is advisory, differs between providers, and a
 * missing field must never turn a successful request into a logged failure.
 */
export function usageOf(payload: unknown): Partial<AiRun> {
  const p = payload as
    | {
        model?: string;
        choices?: { finish_reason?: string }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          cost?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      }
    | undefined;
  const u = p?.usage;
  return {
    model: typeof p?.model === 'string' ? p.model : undefined,
    finishReason: p?.choices?.[0]?.finish_reason,
    promptTokens: u?.prompt_tokens,
    completionTokens: u?.completion_tokens,
    reasoningTokens: u?.completion_tokens_details?.reasoning_tokens,
    costUsd: typeof u?.cost === 'number' ? u.cost : undefined,
  };
}
