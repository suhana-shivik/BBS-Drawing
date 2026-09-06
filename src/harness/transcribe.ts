// ============================================================
// The transcription stage — split package sections → DECLARED fact inputs.
//
// HOW_TO_BUILD_IT.md §3: stage 2 hands the model the sections and asks for a
// TRANSCRIPTION, not a schedule. The model assigns meaning and points — it
// names what a statement resolves to (a dotted ledger id), quotes the drawing
// verbatim (rawText) and cites section ids and entity handles. Every value
// that reaches the ledger carries its own quote, which is what makes a
// DECLARED fact quotable and checkable against the sheet.
//
// The output contract is `DeclaredFactInput` (src/facts/writers.ts) — this
// module produces exactly that shape, validated with the same schema gate the
// BBS loop uses. An unparseable or ill-shaped reply is REFUSED
// (TranscriptionRefused), never guessed at or partially salvaged into
// facts that would look finished.
//
// The model transport is injected the way tasks.ts / judge.ts take theirs —
// an `ask` that returns a parsed JSON object or null — so the whole stage is
// provable with a scripted fake, unpaid.
// ============================================================

import {
  arrayOf,
  explain,
  object,
  optional,
  passthrough,
  required,
  str,
  validate,
  type Validator,
} from '../cad/bbs/schema';
import type { DeclaredFactInput } from '../facts/writers';
import type { TranscribeRequest, Transcriber } from '../skills/run';

/** Same injected-transport shape as SpecialistContext.ask (tasks.ts). */
export type TranscribeAsk = (args: {
  system: string;
  prompt: string;
  images: { dataUrl: string; caption: string }[];
  label: string;
}) => Promise<Record<string, unknown> | null>;

/** A reply that could not be read as the transcription contract. Refused, not guessed. */
export class TranscriptionRefused extends Error {
  constructor(reason: string) {
    super(`transcription refused: ${reason}`);
    this.name = 'TranscriptionRefused';
  }
}

export const TRANSCRIBE_SYSTEM = `You are transcribing statements written on a construction drawing.

THIS IS A TRANSCRIPTION ONLY — no schedule, no quantities, no arithmetic.
You read what the drawing states and report it verbatim. You never compute,
estimate, round, or fill in a value the drawing does not state.

For each statement you can ground, report:
- "id": the dotted fact id it resolves to (e.g. "wall.total_run", "TB.section")
- "value": the reading, exactly as the drawing gives it (number or text)
- "unit": the unit if the drawing states or implies one (e.g. "mm")
- "sectionId": which section you read it in
- "rawText": the text VERBATIM, exactly as drawn — this is mandatory; a value
  you cannot quote is a value you do not report
- "handles": entity handles behind the text, when you have them

If a wanted fact is not written anywhere in these sections, OMIT it entirely.
Reporting an invented value is worse than reporting nothing.

Reply with JSON only: {"facts":[...]}`;

interface TranscribedEntry {
  id: string;
  value: unknown;
  unit?: string;
  sectionId?: string;
  rawText: string;
  handles?: string[];
}

const TRANSCRIBE_REPLY: Validator<{ facts: TranscribedEntry[] }> = object(
  {
    facts: required(
      arrayOf(
        object<TranscribedEntry>({
          id: required(str({ min: 1 })),
          value: required(passthrough('the reading, as drawn')),
          unit: optional(str()),
          sectionId: optional(str()),
          rawText: required(str({ min: 1 })),
          handles: optional(arrayOf(str({ min: 1 }))),
        }),
      ),
    ),
  },
  { name: 'transcription reply' },
);

/** The user prompt: the sections on offer and the facts being hunted. */
export function buildTranscriptionPrompt(req: TranscribeRequest): string {
  const lines: string[] = [];
  lines.push(`DRAWING: ${req.drawingNumber} rev ${req.revision}`);
  lines.push('');
  lines.push(`SECTIONS (${req.sections.length}) — images attached where available:`);
  for (const s of req.sections) {
    lines.push(`  ${s.sectionId} "${s.label}"${s.kind ? ` [${s.kind}]` : ''}`);
  }
  lines.push('');
  lines.push('FACTS BEING HUNTED — transcribe them if (and only if) the drawing states them,');
  lines.push('and transcribe anything else measurable you can quote verbatim:');
  for (const w of req.wanted) {
    lines.push(`  ${w.key} — ${w.ask}`);
  }
  return lines.join('\n');
}

/**
 * Run the transcription stage over a split package's sections.
 *
 * Returns validated `DeclaredFactInput[]`; throws `TranscriptionRefused` when
 * the reply is absent, unparseable, ill-shaped, or carries a value the ledger
 * cannot hold. It never returns a partially-trusted reading.
 */
export async function transcribeSections(
  req: TranscribeRequest,
  ask: TranscribeAsk,
): Promise<DeclaredFactInput[]> {
  const raw = await ask({
    system: TRANSCRIBE_SYSTEM,
    prompt: buildTranscriptionPrompt(req),
    images: req.sections
      .filter((s) => !!s.png)
      .map((s) => ({ dataUrl: s.png!, caption: `${s.sectionId} — ${s.label}` })),
    label: 'transcribe',
  });
  if (raw === null) {
    throw new TranscriptionRefused('no reply arrived, or it could not be read as JSON');
  }

  const checked = validate(raw, TRANSCRIBE_REPLY);
  if (!checked.ok) {
    throw new TranscriptionRefused(
      `reply does not match the transcription contract — ${explain(checked.problems)}`,
    );
  }

  const out: DeclaredFactInput[] = [];
  for (const entry of checked.value.facts) {
    const t = typeof entry.value;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') {
      // a structured value here means the model computed instead of quoting
      throw new TranscriptionRefused(
        `"${entry.id}" carries a ${t} value — a transcription quotes scalars off the drawing`,
      );
    }
    out.push({
      id: entry.id,
      value: entry.value as DeclaredFactInput['value'],
      ...(entry.unit !== undefined ? { unit: entry.unit } : {}),
      ...(entry.sectionId !== undefined ? { sectionId: entry.sectionId } : {}),
      rawText: entry.rawText,
      ...(entry.handles !== undefined ? { handles: entry.handles } : {}),
    });
  }
  return out;
}

/** Bind a transport, yielding the Transcriber the resolution loop injects. */
export function transcriberFrom(ask: TranscribeAsk): Transcriber {
  return (req) => transcribeSections(req, ask);
}
