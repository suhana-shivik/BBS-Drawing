// ============================================================
// The transcript trace — STUDIO_DESIGN §7.1, and it is the important one.
//
// "A value enters only as a transcript-traced user fact. Every fact the model
// records is checked back against what was actually said. A value that never
// appeared in the conversation is DISCARDED, not applied."
//
// WHY A CHECK AND NOT A CONVENTION
//
// The model relays what the user told it. Relaying is cheap and inventing is
// cheaper: a run that needs a footing depth and has been told nothing will
// write a plausible one into `userFacts` and the schedule will carry it with
// "from you" beside it — a number the user never gave, attributed to them.
// That is the single worst artefact this product can produce, because it is
// indistinguishable from a correct one AND it carries their name.
//
// So the transcript is the authority. A relayed value stands only when the
// value itself is visible in something the user actually typed.
//
// THE SECOND RULE: A USER VALUE MAY NOT RIDE INSIDE A DRAWING REFERENCE
//
// refs.ts keeps `{kind:'user-fact', factId}` deliberately apart from
// `entity-number`, `table-number`, `difference` and `dimension-path`. Those
// four say "this number is printed on the sheet, here". A user's answer
// smuggled into one of them makes the schedule claim the drawing states
// something it does not, and there is then no way to answer "which of these
// numbers came from the drawing and which came from a person?".
//
// Facts the user gives and facts the sheet states are different kinds of
// evidence, and this module keeps them apart at the door.
// ============================================================

/** One line of the conversation, exactly as it was said. */
export interface TranscriptLine {
  role: 'user' | 'assistant';
  text: string;
  at?: number;
}

/**
 * A fact the model wants applied, as it arrives — before anything is believed.
 * `value` is what it claims; `ref` is how it wants it recorded, when it says.
 */
export interface CandidateFact {
  /** ledger id or engine key the value would land under */
  factId: string;
  value: unknown;
  /** the user's words, as the model reports them (checked, never trusted) */
  saidAs?: string;
  writesTo?: { memberMark?: string; field: string };
  unit?: string;
  /** the reference the model proposes for it — only a user-fact ref is legal here */
  ref?: unknown;
}

export interface AppliedFact {
  fact: CandidateFact;
  /** the numeric value in the unit it was claimed in, when it is numeric */
  value: number | string;
  /** the transcript line the value was found in — provenance that survives */
  saidAs: string;
  /** index into the transcript of the line that carries it */
  lineIndex: number;
}

export interface DiscardedFact {
  fact: CandidateFact;
  /** why, in the words the model is told — never a silent drop */
  reason: string;
}

export interface TraceResult {
  applied: AppliedFact[];
  discarded: DiscardedFact[];
}

export interface TraceOptions {
  /**
   * Whose words count as "said". The default is the user's alone: a number the
   * assistant volunteered and the user never repeated is the assistant's
   * number, however reasonable it looked on screen.
   */
  count?: 'user' | 'either';
  /** how many candidates are looked at at all — a relay of 200 is not a conversation */
  max?: number;
}

/**
 * The four reference kinds that point AT THE DRAWING. A user's value may never
 * be carried by one of these; `user-fact` is the only ref a person's answer
 * travels in.
 */
export const DRAWING_REF_KINDS: readonly string[] = [
  'entity-number',
  'table-number',
  'difference',
  'dimension-path',
];

/**
 * A ref that would make a user's answer look like something read off the sheet.
 * Returns the reason it is refused, or null when the ref is legitimate.
 *
 * Checked recursively, because `difference` carries two scalar sides and a
 * user value hidden in `b` is exactly as false as one in `a`.
 */
export function userValueInDrawingRef(ref: unknown): string | null {
  if (ref === undefined || ref === null) return null;
  if (typeof ref !== 'object') {
    return 'a reference must be an object naming its kind — a bare value is not provenance';
  }
  const kind = (ref as { kind?: unknown }).kind;
  if (typeof kind !== 'string') {
    return 'a reference with no "kind" cannot say where its number came from';
  }
  if (DRAWING_REF_KINDS.includes(kind)) {
    return (
      `a user's answer cannot be recorded as {kind:"${kind}"} — that ref says the number is ` +
      'printed on the drawing. A value a person gave travels as {kind:"user-fact",factId:"…"} ' +
      'and nothing else, so the schedule can always say which numbers came from the sheet.'
    );
  }
  if (kind !== 'user-fact') {
    return `"${kind}" is not a reference kind this contract knows`;
  }
  const factId = (ref as { factId?: unknown }).factId;
  if (typeof factId !== 'string' || !factId.trim()) {
    return 'a user-fact reference must name the factId it reads';
  }
  return null;
}

/** Normalised text for a substring search: no commas, single spaces, lower case. */
function flatten(text: string): string {
  return text.replace(/,/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The value, as given or unit-shifted by a thousand, stands somewhere in the
 * text. The shift is deliberate: "100 m" typed by the user is the same fact as
 * 100000 mm relayed by the model, and refusing that would discard every honest
 * metre answer in the product.
 *
 * The lookaround stops 300 matching inside 3000 — a near miss here would be a
 * fact the user never gave, waved through because a longer number contained it.
 */
export function numberAppears(text: string, value: number): boolean {
  const flat = flatten(text);
  for (const candidate of [value, value / 1000, value * 1000]) {
    if (!Number.isFinite(candidate) || candidate === 0) continue;
    const printed = String(Math.round(candidate * 1000) / 1000);
    const re = new RegExp(`(?<![\\d.])${printed.replace('.', '\\.')}(?![\\d])`);
    if (re.test(flat)) return true;
  }
  return false;
}

/** A short string answer stands when the user's own words contain it. */
export function textAppears(text: string, value: string): boolean {
  const needle = flatten(value);
  if (!needle) return false;
  return flatten(text).includes(needle);
}

function linesFor(transcript: readonly TranscriptLine[], count: 'user' | 'either'): number[] {
  const idx: number[] = [];
  for (let i = 0; i < transcript.length; i++) {
    if (count === 'either' || transcript[i].role === 'user') idx.push(i);
  }
  return idx;
}

/**
 * Check every candidate fact back against the conversation.
 *
 * Applied facts carry the line they were found in; discarded ones carry the
 * reason, phrased for the model to read — the refusal is how it learns to ask
 * rather than to fill in.
 */
export function traceFacts(
  candidates: readonly CandidateFact[],
  transcript: readonly TranscriptLine[],
  opts: TraceOptions = {},
): TraceResult {
  const count = opts.count ?? 'user';
  const max = opts.max ?? 24;
  const applied: AppliedFact[] = [];
  const discarded: DiscardedFact[] = [];

  const eligible = linesFor(transcript, count);
  const anyLine = linesFor(transcript, 'either');

  for (const fact of candidates.slice(0, max)) {
    const label = fact.factId || fact.writesTo?.field || '(unnamed fact)';

    if (!fact.factId || typeof fact.factId !== 'string') {
      discarded.push({ fact, reason: `${label}: a fact with no id lands nowhere` });
      continue;
    }

    const refProblem = userValueInDrawingRef(fact.ref);
    if (refProblem) {
      discarded.push({ fact, reason: `${label}: ${refProblem}` });
      continue;
    }
    const refFactId = (fact.ref as { factId?: string } | undefined)?.factId;
    if (refFactId !== undefined && refFactId !== fact.factId) {
      discarded.push({
        fact,
        reason: `${label}: the reference reads "${refFactId}" but the value is recorded under "${fact.factId}" — one of them is wrong`,
      });
      continue;
    }

    if (typeof fact.value !== 'number' && typeof fact.value !== 'string') {
      discarded.push({ fact, reason: `${label}: a value must be a number or a short string` });
      continue;
    }
    if (typeof fact.value === 'number' && !Number.isFinite(fact.value)) {
      discarded.push({ fact, reason: `${label}: ${String(fact.value)} is not a number` });
      continue;
    }

    const hit = eligible.find((i) =>
      typeof fact.value === 'number'
        ? numberAppears(transcript[i].text, fact.value)
        : textAppears(transcript[i].text, fact.value as string),
    );

    if (hit === undefined) {
      // Say WHERE it came from when it came from the assistant. "You said it,
      // they did not" is a correction the model can act on; "it is not in the
      // transcript" is one it will argue with.
      const echoed = anyLine.find((i) =>
        typeof fact.value === 'number'
          ? numberAppears(transcript[i].text, fact.value)
          : textAppears(transcript[i].text, fact.value as string),
      );
      discarded.push({
        fact,
        reason:
          echoed !== undefined
            ? `${label}: ${String(fact.value)} appeared only in your own message, not in anything the user said — ask them to confirm it before it is applied`
            : `${label}: ${String(fact.value)} never appeared in the conversation and was DISCARDED`,
      });
      continue;
    }

    applied.push({
      fact,
      value: fact.value,
      saidAs: transcript[hit].text.trim(),
      lineIndex: hit,
    });
  }

  return { applied, discarded };
}

/**
 * The sentence that goes back to the model. Deliberately names every dropped
 * fact: a silent discard teaches nothing, and the next turn relays the same
 * invention again.
 */
export function discardReport(discarded: readonly DiscardedFact[]): string {
  if (!discarded.length) return '';
  return (
    'These userFacts do not trace to the conversation and were DISCARDED: ' +
    discarded.map((d) => d.reason).join('; ') +
    '. Only relay values the user typed or confirmed in chat — if you need one, ask for it.'
  );
}
