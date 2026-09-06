// ============================================================
// DXF parsing worker.
//
// Parsing a 5–13 MB drawing takes seconds of straight-line CPU. Doing that on
// the main thread freezes the whole editor, so it happens here and the parsed
// CadDocument comes back over structured clone (which round-trips the
// document's Maps natively — see src/cad/store.ts).
//
// Cancellation: the worker checks shouldCancel() between phases and every N
// entities. That flag can only flip if the worker gets to drain its message
// queue, so a fully synchronous parse will not see it — client.ts therefore
// terminates the worker as the hard backstop. Both halves exist on purpose:
// the message keeps a cooperative parser tidy, the terminate keeps the 250 ms
// promise regardless.
// ============================================================
import { parseDXF } from '../dxf/parse';
import type { CadDocument } from '../types';

// ---------------- protocol ----------------

export interface ParseRequest {
  id: number;
  kind: 'parse';
  text: string;
  fileName: string;
}

export interface CancelRequest {
  id: number;
  kind: 'cancel';
}

export type WorkerRequest = ParseRequest | CancelRequest;

export interface ProgressResponse {
  id: number;
  kind: 'progress';
  phase: string;
  pct: number;
}

export interface DoneResponse {
  id: number;
  kind: 'done';
  doc: CadDocument;
}

export interface ErrorResponse {
  id: number;
  kind: 'error';
  message: string;
}

export type WorkerResponse = ProgressResponse | DoneResponse | ErrorResponse;

// ---------------- worker body ----------------

// The DOM lib is what this project compiles against, so `self` is typed as a
// Window here. Narrow it to the two members a dedicated worker actually uses
// rather than pulling in the webworker lib, which collides with the DOM one.
interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<WorkerRequest>) => void): void;
}

const ctx = self as unknown as WorkerScope;

/** ids cancelled by the main thread */
const cancelled = new Set<number>();

ctx.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg.id !== 'number') return;
  if (msg.kind === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  if (msg.kind === 'parse') run(msg);
});

function run(msg: ParseRequest): void {
  const { id, text, fileName } = msg;
  const isCancelled = () => cancelled.has(id);

  let lastPhase = '';
  let lastPct = -1;
  const onProgress = (phase: string, pct: number): void => {
    if (isCancelled()) return;
    const whole = Math.max(0, Math.min(100, Math.round(pct)));
    // one message per whole percent per phase — progress must not become the
    // bottleneck on a document with a million entities
    if (phase === lastPhase && whole === lastPct) return;
    lastPhase = phase;
    lastPct = whole;
    ctx.postMessage({ id, kind: 'progress', phase, pct: whole });
  };

  try {
    const doc = parseDXF(text, fileName, onProgress, isCancelled);
    if (isCancelled()) return;
    ctx.postMessage({ id, kind: 'done', doc });
  } catch (err) {
    if (isCancelled()) return; // a cancelling parser is allowed to throw its way out
    ctx.postMessage({
      id,
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    cancelled.delete(id);
  }
}
