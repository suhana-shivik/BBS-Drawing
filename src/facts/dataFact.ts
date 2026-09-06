// ============================================================
// DataFact — the generic, drawing-agnostic record every BBS input is.
//
// The ledger (src/facts/ledger.ts) is the store; this is the SHAPE a fact
// takes when it leaves the store for a calculation, an export or a trace:
//
//   fact_id · drawing_id · drawing_hash · section_id · member_id · parameter
//   value · unit · semantic_type · source_type · source_text
//   source_entity_handles · confidence · status · version
//
// Nothing here knows a member name, a diameter or a drawing. `F8.length`,
// `PB03.span`, `C12.tie_spacing` and `settings.cover` all project the same
// way: the subject before the dot is the member (or `settings` / `wall`),
// the name after it is the parameter, and the source type is decided by the
// ledger state — never by what the value looks like.
//
//   MEASURED / DECLARED  → DRAWING_READ   the sheet stated it
//   SUPPLIED             → USER_INPUT     a person answered
//   DERIVED              → DERIVED        computed from other facts
//   (basis/method says "default"/"assumed") → ASSUMED
//   MISSING              → MISSING        asked, unanswered
//   contradicted         → UNREADABLE     two readings disagree; unusable
// ============================================================
import type { Ledger, LedgerEntry } from './ledger';
import { factName, factSubject, isUsable, type Fact, type FactValue } from './types';

export type DataFactSourceType = 'DRAWING_READ' | 'USER_INPUT' | 'DERIVED' | 'ASSUMED' | 'MISSING' | 'UNREADABLE';

export type DataFactStatus = 'VALID' | 'MISSING' | 'UNREADABLE' | 'STALE' | 'SUPERSEDED';

export interface DataFactRecord {
  factId: string;
  drawingId?: string;
  drawingHash?: string;
  sectionId?: string;
  memberId: string;
  parameter: string;
  value: FactValue;
  unit?: string;
  semanticType: string;
  sourceType: DataFactSourceType;
  sourceText?: string;
  sourceEntityHandles: string[];
  confidence: number;
  status: DataFactStatus;
  /** the ledger sequence — the fact's version */
  version: number;
  /** the question that would settle it, when it is not settled */
  ask?: string;
}

/** What kind of quantity a parameter name denotes — generic name patterns, no member names. */
export function semanticTypeOf(parameter: string, unit?: string): string {
  const p = parameter.toLowerCase();
  if (/^(length|width|height|depth|thickness|span|plan_l|plan_w|section_w|section_d|total_run|^l$|^w$|^h$)/.test(p)) return 'member_dimension';
  if (/cover/.test(p)) return 'cover';
  if (/count|nos|quantity|number/.test(p)) return 'count';
  if (/spacing|pitch|c_c/.test(p)) return 'spacing';
  if (/dia|diameter/.test(p)) return 'bar_diameter';
  if (/cutting_length|cut_length/.test(p)) return 'cutting_length';
  if (/lap|anchor|ld|development/.test(p)) return 'development_length';
  if (/grade/.test(p)) return 'material_grade';
  if (/wastage/.test(p)) return 'percentage';
  if (/^x$|^y$|leg|hook|bend/.test(p)) return 'bar_geometry';
  if (unit === 'mm' || unit === 'm') return 'dimension';
  return 'value';
}

/** The DataFact source type for a ledger state and its provenance. */
export function sourceTypeOf(fact: Fact): DataFactSourceType {
  if (fact.contradicted === true) return 'UNREADABLE';
  switch (fact.state) {
    case 'MEASURED':
    case 'DECLARED':
      return 'DRAWING_READ';
    case 'SUPPLIED':
      return 'USER_INPUT';
    case 'DERIVED':
      return /\b(default|assum)/i.test(`${fact.basis ?? ''} ${fact.method ?? ''}`) ? 'ASSUMED' : 'DERIVED';
    case 'MISSING':
    default:
      return /unreadable|illegible|not machine-readable|could not be read/i.test(`${fact.ask ?? ''} ${(fact.lookedIn ?? []).join(' ')}`)
        ? 'UNREADABLE'
        : 'MISSING';
  }
}

function statusOf(fact: Fact): DataFactStatus {
  if (fact.supersededBy !== undefined) return 'SUPERSEDED';
  if (fact.contradicted === true) return 'UNREADABLE';
  if (fact.state === 'MISSING') return 'MISSING';
  if (fact.stale === true) return 'STALE';
  return 'VALID';
}

/**
 * Confidence is what the provenance supports, never a taste judgement:
 * a person's word and a table cell that names the member are 1; a
 * reading with evidence handles is 0.9; a derivation 0.8; a contradicted
 * or missing fact 0.
 */
function confidenceOf(fact: Fact): number {
  if (fact.contradicted === true || fact.state === 'MISSING') return 0;
  if (fact.state === 'SUPPLIED') return 1;
  if (fact.state === 'DECLARED') return 1;
  if (fact.state === 'MEASURED') return (fact.evidence?.length ?? fact.source?.handles?.length ?? 0) > 0 ? 0.9 : 0.75;
  return 0.8;
}

/** One ledger entry as a DataFact. Pure. */
export function toDataFact(entry: LedgerEntry, ctx: { drawingId?: string; drawingHash?: string } = {}): DataFactRecord {
  const fact = entry.fact;
  const parameter = factName(fact.id) || fact.id;
  return {
    factId: fact.id,
    drawingId: fact.source?.documentId ?? ctx.drawingId,
    drawingHash: fact.sourceDrawingHash ?? ctx.drawingHash,
    sectionId: fact.source?.sectionId,
    memberId: factSubject(fact.id),
    parameter,
    value: fact.value,
    unit: fact.unit,
    semanticType: semanticTypeOf(parameter, fact.unit),
    sourceType: sourceTypeOf(fact),
    sourceText: fact.source?.rawText ?? fact.saidAs ?? fact.method ?? fact.basis,
    sourceEntityHandles: [...(fact.source?.handles ?? fact.evidence ?? [])],
    confidence: confidenceOf(fact),
    status: statusOf(fact),
    version: entry.seq + 1,
    ...(fact.ask ? { ask: fact.ask } : {}),
  };
}

/** The current (non-superseded) DataFacts of a ledger, optionally only the ids asked for. */
export function dataFactsOf(
  ledger: Ledger,
  ctx: { drawingId?: string; drawingHash?: string } = {},
  onlyIds?: readonly string[],
): DataFactRecord[] {
  const wanted = onlyIds ? new Set(onlyIds.map((id) => id.toLowerCase())) : null;
  const out: DataFactRecord[] = [];
  for (const entry of ledger.entries) {
    if (entry.fact.supersededBy !== undefined) continue;
    if (wanted && !wanted.has(entry.fact.id.toLowerCase())) continue;
    out.push(toDataFact(entry, ctx));
  }
  return out;
}

/** True when a DataFact may feed a calculation — the same rule the ledger uses. */
export function dataFactUsable(fact: DataFactRecord): boolean {
  return fact.status === 'VALID' && fact.value !== null && fact.sourceType !== 'MISSING' && fact.sourceType !== 'UNREADABLE';
}

export { isUsable };
