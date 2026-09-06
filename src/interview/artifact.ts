// ============================================================
// §7.2 — ask for a schedule, get the schedule, never a retyped one.
//
// THE HARD RULE, quoted because the reason is not obvious:
//
//   "A schedule reproduced in Markdown by a language model is a schedule that
//    has been retyped, and a retyped number is a number that can differ from
//    the one the engine computed. It looks identical to a correct answer and
//    there is no way to tell from the message which it is."
//
// So an assistant message carries a REFERENCE — {type, resultId} — into this
// store, and the interface renders the stored engine result. What the yard
// cuts to and what the user reads in the chat are the same bytes, by
// construction rather than by care.
//
// THERE IS NO TABLE RENDERER IN THIS MODULE, and there must never be one. The
// only text it produces is the sentence beside the artifact, and that sentence
// is given no figures to print. `retypedTableIn` exists to REFUSE a message
// that carries one, not to make one.
//
// IMMUTABLE AND VERSIONED
//
// Answering a question and asking again yields v8 ALONGSIDE v7 in the thread,
// never a silently edited v7. What the user saw when they made a decision
// stays visible and stays addressable by its own id — that is the whole
// difference between a conversation you can audit and a document that changed
// under you.
// ============================================================
import {
  artifactMessage,
  getChatResult,
  putChatResult,
  type BbsChatResult,
} from '../cad/bbs/chatResult';
import type { AskableQuestion } from '../cad/bbs/askFrom';

export type ArtifactType = 'bbs-result';

/** what a message carries INSTEAD of a table */
export interface ArtifactRef {
  type: ArtifactType;
  resultId: string;
}

export interface ChatArtifact {
  ref: ArtifactRef;
  /**
   * The thread lineage — every re-ask of the same schedule adds a version to
   * it. Versions of one lineage stand side by side; they never replace.
   */
  lineage: string;
  version: number;
  result: BbsChatResult;
  at: number;
  /** what the user asked for, in their own words */
  askedAs?: string;
}

/** one turn of the thread, as the Ask tab renders it */
export interface AssistantMessage {
  role: 'assistant';
  /** words only — never a figure, never a table */
  content: string;
  /** the schedule, by reference */
  artifact?: ArtifactRef;
  /** the typed questions rendered inline, when the run is asking (§7.4) */
  questions?: AskableQuestion[];
}

/** "ask-bbs-3#v7" — a version's own permanent id */
export function versionId(lineage: string, version: number): string {
  return `${lineage}#v${version}`;
}

/**
 * The versioned store the chat message points into.
 *
 * An instance per session keeps tests honest (no shared global state between
 * them); `putChatResult` is called alongside so the engine's own lookup path
 * — the one BbsSheet already uses — resolves the same id.
 */
export class ChatArtifactStore {
  private readonly byId = new Map<string, ChatArtifact>();
  private readonly byLineage = new Map<string, ChatArtifact[]>();

  /**
   * File a new version of a lineage. The stored result is a frozen object
   * carrying its version id; every figure in it is the engine's, copied by
   * reference and never recomputed on the way through.
   */
  publish(
    lineage: string,
    result: BbsChatResult,
    opts: { at?: number; askedAs?: string } = {},
  ): ChatArtifact {
    const existing = this.byLineage.get(lineage) ?? [];
    const version = existing.length + 1;
    const id = versionId(lineage, version);
    const stored = Object.freeze({ ...result, id }) as BbsChatResult;
    const artifact: ChatArtifact = Object.freeze({
      ref: Object.freeze({ type: 'bbs-result' as const, resultId: id }),
      lineage,
      version,
      result: stored,
      at: opts.at ?? Date.now(),
      askedAs: opts.askedAs,
    });
    this.byId.set(id, artifact);
    this.byLineage.set(lineage, [...existing, artifact]);
    // the engine's own store, so an id from the chat resolves anywhere a
    // result id resolves
    putChatResult(stored);
    return artifact;
  }

  get(resultId: string): ChatArtifact | undefined {
    return this.byId.get(resultId);
  }

  /** the stored result behind a reference — what the UI renders */
  resolve(ref: ArtifactRef): BbsChatResult | undefined {
    return this.byId.get(ref.resultId)?.result ?? getChatResult(ref.resultId);
  }

  /** every version of a lineage, oldest first — v7 is still here after v8 */
  versions(lineage: string): readonly ChatArtifact[] {
    return this.byLineage.get(lineage) ?? [];
  }

  latest(lineage: string): ChatArtifact | undefined {
    const all = this.byLineage.get(lineage);
    return all?.length ? all[all.length - 1] : undefined;
  }

  lineages(): string[] {
    return [...this.byLineage.keys()];
  }
}

/**
 * The message that accompanies an artifact.
 *
 * The words come from chatResult.ts's `artifactMessage`, which was written to
 * say nothing numeric on purpose; the reference is what the interface renders.
 */
export function artifactMessageFor(artifact: ChatArtifact): AssistantMessage {
  const { content } = artifactMessage(artifact.result);
  const versionNote =
    artifact.version > 1
      ? ` This is v${artifact.version}; v${artifact.version - 1} stays above it, unchanged.`
      : '';
  return {
    role: 'assistant',
    content: `${content}${versionNote}`,
    artifact: artifact.ref,
  };
}

/** the message that carries a batch of questions and no artifact (§7.4) */
export function questionMessage(
  questions: readonly AskableQuestion[],
  lead = 'The drawing is exhausted on these. Answering the first buys the most:',
): AssistantMessage {
  return {
    role: 'assistant',
    content: questions.length ? lead : 'Nothing is outstanding.',
    questions: [...questions],
  };
}

/**
 * Does this text retype a schedule?
 *
 * The guard, not a renderer: a message that carries a markdown table of
 * figures is refused rather than published, because there is no way to tell
 * from the message whether its numbers match the engine's. Two consecutive
 * pipe-delimited rows, or a pipe row over a dashed rule, is a table.
 */
export function retypedTableIn(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const isRow = (l: string): boolean => (l.match(/\|/g)?.length ?? 0) >= 2;
  const isRule = (l: string): boolean => /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/.test(l);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!isRow(lines[i])) continue;
    if (isRow(lines[i + 1]) || isRule(lines[i + 1])) return true;
  }
  return false;
}

export type PublishVerdict =
  | { ok: true; message: AssistantMessage }
  | { ok: false; reason: string };

/**
 * Publish one assistant turn. A message that retyped a table is REFUSED with
 * the reason — never repaired, because repairing it would leave the numbers
 * that prompted it half-visible and the failure invisible.
 */
export function assistantTurn(
  content: string,
  artifact?: ChatArtifact,
  questions?: readonly AskableQuestion[],
): PublishVerdict {
  if (retypedTableIn(content)) {
    return {
      ok: false,
      reason:
        'this message retypes the schedule as a table. The model never writes the table — ' +
        'send the words and carry the schedule as artifact {type, resultId}; a retyped number ' +
        'can differ from the computed one and looks identical.',
    };
  }
  return {
    ok: true,
    message: {
      role: 'assistant',
      content,
      ...(artifact ? { artifact: artifact.ref } : {}),
      ...(questions?.length ? { questions: [...questions] } : {}),
    },
  };
}
