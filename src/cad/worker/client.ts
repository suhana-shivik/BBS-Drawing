// ============================================================
// Main-thread client for the DXF parsing worker.
//
// One worker is created lazily and reused across imports. Cancellation is
// two-pronged: a `cancel` message for a parser that is willing to stop, and a
// terminate for one that is stuck inside a synchronous parse loop (a worker
// cannot read its message queue while parsing, so the message alone can never
// be relied on). The caller's promise rejects the instant the signal fires —
// well inside the 250 ms budget — and the worker is destroyed shortly after if
// it has not gone quiet on its own.
// ============================================================
import type { CadDocument } from '../types';
import type { WorkerRequest, WorkerResponse } from './dxfWorker';

export interface ParseInWorkerOptions {
  onProgress?: (phase: string, pct: number) => void;
  signal?: AbortSignal;
}

/** grace period between the cancel message and terminating the worker */
export const CANCEL_GRACE_MS = 150;

interface Job {
  resolve: (doc: CadDocument) => void;
  reject: (err: Error) => void;
  onProgress?: (phase: string, pct: number) => void;
  detach: () => void;
}

let worker: Worker | null = null;
let nextId = 1;
const jobs = new Map<number, Job>();
/** cancelled ids still being watched for a terminate */
const cancelWatch = new Map<number, ReturnType<typeof setTimeout>>();

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('Parse cancelled', 'AbortError');
  const err = new Error('Parse cancelled');
  err.name = 'AbortError';
  return err;
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./dxfWorker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent<WorkerResponse>) => handleMessage(ev.data);
  w.onerror = (ev: ErrorEvent) =>
    failAll(new Error(ev.message || 'The DXF worker failed to start.'));
  w.onmessageerror = () => failAll(new Error('The DXF worker sent an unreadable message.'));
  worker = w;
  return w;
}

function handleMessage(msg: WorkerResponse): void {
  if (!msg || typeof msg.id !== 'number') return;

  if (msg.kind === 'progress') {
    jobs.get(msg.id)?.onProgress?.(msg.phase, msg.pct);
    return;
  }

  // A terminal message for a cancelled id proves the worker is responsive
  // again, so it does not need killing.
  const watch = cancelWatch.get(msg.id);
  if (watch !== undefined) {
    clearTimeout(watch);
    cancelWatch.delete(msg.id);
  }

  const job = jobs.get(msg.id);
  if (!job) return; // already settled (cancelled) — drop the late result
  jobs.delete(msg.id);
  job.detach();
  if (msg.kind === 'done') job.resolve(msg.doc);
  else job.reject(new Error(msg.message));
}

/** Kill the worker and reject everything still in flight. */
function failAll(err: Error): void {
  for (const timer of cancelWatch.values()) clearTimeout(timer);
  cancelWatch.clear();
  const pending = [...jobs.values()];
  jobs.clear();
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const job of pending) {
    job.detach();
    job.reject(err);
  }
}

/** Terminate the worker and reject any in-flight parse (teardown / tests). */
export function disposeDXFWorker(): void {
  if (!worker && jobs.size === 0) return;
  failAll(new Error('The DXF worker was shut down.'));
}

export function parseDXFInWorker(
  text: string,
  fileName: string,
  options: ParseInWorkerOptions = {},
): Promise<CadDocument> {
  const { onProgress, signal } = options;
  if (signal?.aborted) return Promise.reject(abortError());

  const id = nextId++;
  return new Promise<CadDocument>((resolve, reject) => {
    let w: Worker;
    try {
      w = getWorker();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const onAbort = () => {
      const job = jobs.get(id);
      if (!job) return;
      jobs.delete(id);
      job.detach();

      // best effort: a parser that drains its queue stops itself
      post(w, { id, kind: 'cancel' });

      // hard backstop: a parser mid-loop never sees that message
      const killer = setTimeout(() => {
        cancelWatch.delete(id);
        if (w === worker) failAll(new Error('The DXF worker was cancelled.'));
        else w.terminate();
      }, CANCEL_GRACE_MS);
      cancelWatch.set(id, killer);

      reject(abortError()); // the caller hears about it immediately
    };

    const detach = () => signal?.removeEventListener('abort', onAbort);
    jobs.set(id, { resolve, reject, onProgress, detach });
    signal?.addEventListener('abort', onAbort, { once: true });

    post(w, { id, kind: 'parse', text, fileName });
  });
}

function post(w: Worker, msg: WorkerRequest): void {
  try {
    w.postMessage(msg);
  } catch (err) {
    failAll(err instanceof Error ? err : new Error(String(err)));
  }
}
