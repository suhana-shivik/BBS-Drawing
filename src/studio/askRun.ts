// The Ask conversation and the run inside it, kept OUTSIDE the panel.
//
// WHY THIS EXISTS
//
// `AskPanel` held the thread, the interview session and the busy flag in React
// state, and the panel is rendered conditionally — it unmounts the moment you
// open Details, Library, Specification or Log. Worse than losing the view, its
// unmount effect ABANDONED the session and ABORTED the request:
//
//     useEffect(() => () => {
//       sessionRef.current?.abandon('the chat panel was closed');
//       requestRef.current?.abort('the chat panel was closed');
//     }, []);
//
// So a BBS run ten minutes and eight questions deep was destroyed by clicking
// a tab to go and look at the drawing it was asking about — which is the most
// ordinary thing a person does mid-interview.
//
// A run is not view state. It is work in flight, with money and time already
// spent on it, so it lives here — a module store, the same shape `splitJobs`
// uses for the same reason — and the panel becomes a window onto it.
//
// ABANDONING IS NOW AN ACT, NEVER A SIDE EFFECT. Starting a new run abandons
// the old one, and closing the project ends it. Navigating does not, because
// navigating is not a decision about the run.

import { useSyncExternalStore } from 'react';
import type { InterviewSession, SessionSnapshot } from '../interview';

export const EMPTY_SNAPSHOT: SessionSnapshot = {
  state: 'idle',
  pending: [],
  answered: [],
  transcript: [],
  questionsAsked: 0,
  questionsRemaining: 0,
};

export interface AskRunState<Message> {
  /** the conversation, oldest first */
  thread: Message[];
  session: InterviewSession | null;
  snapshot: SessionSnapshot;
  busy: boolean;
  /** when the run began, for the stopwatch — null when nothing is running */
  startedAt: number | null;
  /** aborts the in-flight request; owned here so a remount cannot orphan it */
  controller: AbortController | null;
}

// The message type belongs to the panel, so the store is generic over it and
// stays ignorant of what a turn looks like.
type State = AskRunState<unknown>;

let state: State = {
  thread: [],
  session: null,
  snapshot: EMPTY_SNAPSHOT,
  busy: false,
  startedAt: null,
  controller: null,
};

const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const fn of [...listeners]) fn();
}

export function askRunState<Message>(): AskRunState<Message> {
  return state as AskRunState<Message>;
}

export function patchAskRun(patch: Partial<State>): void {
  state = { ...state, ...patch };
  emit();
}

/** Append one turn. */
export function pushAskMessage<Message>(message: Message): void {
  state = { ...state, thread: [...state.thread, message] };
  emit();
}

/** Replace the thread wholesale — used when a run appends several turns at once. */
export function setAskThread<Message>(next: readonly Message[]): void {
  state = { ...state, thread: [...next] };
  emit();
}

/**
 * End whatever is running and clear the conversation.
 *
 * An ACT: pressed, or forced by the project closing. Never a consequence of a
 * component going away.
 */
export function endAskRun(reason: string, keepThread = false): void {
  state.session?.abandon(reason);
  state.controller?.abort(reason);
  state = {
    thread: keepThread ? state.thread : [],
    session: null,
    snapshot: EMPTY_SNAPSHOT,
    busy: false,
    startedAt: null,
    controller: null,
  };
  emit();
}

/** Subscribe a component to the run. Returns a version counter, not the state. */
export function useAskRun(): number {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
    () => version,
  );
}

/** tests only */
export function resetAskRunForTest(): void {
  state = {
    thread: [],
    session: null,
    snapshot: EMPTY_SNAPSHOT,
    busy: false,
    startedAt: null,
    controller: null,
  };
  emit();
}
