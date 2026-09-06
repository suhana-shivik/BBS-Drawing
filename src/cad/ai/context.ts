// ============================================================
// What is written NEXT TO a symbol.
//
// WHY THIS EXISTS
//
// The naming pass was shown a block's name and a picture of it, and asked what
// it is. On a real drawing the name is often meaningless — AutoCAD generates
// `A$C01413627` when a block is copied between files — and the picture is a
// few strokes that could be several devices.
//
// A human does not identify that symbol by looking at the glyph. They read the
// text beside it:
//
//     20A,DP          ← rating and poles
//     MCB             ← the device
//     10kA            ← breaking capacity
//     CCTV RACK-6     ← what it feeds
//
// That text was never being sent. So the model was being asked a question no
// person could answer either, and the "unnamed" rows were the honest result.
//
// This module gathers that neighbouring text, and — more importantly — runs
// the Indian-construction decoder over it FIRST. `20A,DP MCB 10kA` beside a
// symbol names it with no request at all: a rule, not a guess, with the
// matched evidence recorded. Only what the rules cannot decode goes to the
// model, and it goes with its context attached.
// ============================================================
import type { CadDocument, CadEntity, Vec2 } from '../types';
import { decodeElectrical, parseCable } from '../../domain/india/electrical';

/** how far from a symbol counts as "beside it", in drawing units */
const NEAR_RADIUS_FACTOR = 2.2;
/** never search further than this, however large the symbol */
const MAX_RADIUS = 4000;
/** text strings kept per symbol; beyond this the extras add noise, not signal */
const MAX_TEXTS = 8;
/** ignore text longer than this — a note is not a label */
const MAX_TEXT_CHARS = 60;

export interface SymbolContext {
  /** verbatim text found beside instances of this block, nearest first */
  nearby: string[];
  /**
   * What the domain rules make of that text — a HINT, never applied as a name.
   *
   * Tested on a real SLD, the text beside `A$C01413627` was "63A,4P",
   * "125A,4P" and "MCB". The rule fired on "MCB" and read it as a miniature
   * circuit breaker; at 63 A and 125 A four-pole it is plainly an MCCB, and a
   * neighbouring label belonged to a different symbol. PROXIMITY IS NOT
   * IDENTITY — so the rule reading is offered as evidence the model may
   * reject, alongside the raw text that produced it. Applying it directly
   * would have replaced a correct model answer with a confident wrong one.
   */
  ruleHint?: string;
  /** which rule matched, so the hint can be judged rather than trusted */
  ruleEvidence?: string;
  ruleConfidence?: number;
}

interface Placed {
  text: string;
  at: Vec2;
}

function textEntities(doc: CadDocument): Placed[] {
  const out: Placed[] = [];
  for (const e of doc.entities) {
    if (e.type !== 'text') continue;
    const t = e.text.replace(/\s+/g, ' ').trim();
    if (!t || t.length > MAX_TEXT_CHARS) continue;
    out.push({ text: t, at: e.position });
  }
  return out;
}

/** every top-level placement of each block, with an approximate size */
function blockPlacements(doc: CadDocument): Map<string, { at: Vec2; size: number }[]> {
  const out = new Map<string, { at: Vec2; size: number }[]>();
  for (const e of doc.entities) {
    if (e.type !== 'insert') continue;
    const block = doc.blocks.get(e.blockName);
    // a rough extent is enough to scale the search radius; the exact bounds
    // would mean building a display list per block for no extra accuracy here
    const size = block ? approximateSize(block.entities) : 0;
    const list = out.get(e.blockName) ?? [];
    list.push({ at: e.position, size: Math.max(size * Math.abs(e.scale.x || 1), 1) });
    out.set(e.blockName, list);
  }
  return out;
}

function approximateSize(entities: readonly CadEntity[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const see = (p: Vec2 | undefined): void => {
    if (!p) return;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  };
  for (const e of entities) {
    switch (e.type) {
      case 'line':
        see(e.a);
        see(e.b);
        break;
      case 'circle':
      case 'arc':
        see(e.center);
        break;
      case 'polyline':
        for (const v of e.vertices) see(v);
        break;
      case 'insert':
      case 'text':
      case 'point':
        see(e.position);
        break;
      default:
        break;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return 0;
  return Math.max(maxX - minX, maxY - minY);
}

/**
 * Collect the text beside each of the given block keys, and decode what the
 * domain rules can.
 *
 * Rule decoding runs on the NEIGHBOURING TEXT, not just the block name. That
 * is the whole point: `A$C01413627` decodes to nothing, while the `20A,DP MCB
 * 10kA` printed next to it decodes to a miniature circuit breaker with its
 * rating — deterministically, for free, with the matched rule as evidence.
 */
export function symbolContexts(
  doc: CadDocument,
  keys: Iterable<string>,
): Map<string, SymbolContext> {
  const wanted = new Set(keys);
  const out = new Map<string, SymbolContext>();
  if (wanted.size === 0) return out;

  const texts = textEntities(doc);
  const placements = blockPlacements(doc);

  for (const key of wanted) {
    const spots = placements.get(key);
    if (!spots || spots.length === 0) continue;

    // sample a handful of placements: a symbol used 98 times has 98 labels,
    // and the first few are as informative as all of them
    const sample = spots.slice(0, 6);
    const seen = new Set<string>();
    const scored: { text: string; d: number }[] = [];

    for (const spot of sample) {
      const radius = Math.min(Math.max(spot.size * NEAR_RADIUS_FACTOR, 200), MAX_RADIUS);
      for (const t of texts) {
        const d = Math.hypot(t.at.x - spot.at.x, t.at.y - spot.at.y);
        if (d > radius) continue;
        const norm = t.text.toUpperCase();
        if (seen.has(norm)) continue;
        seen.add(norm);
        scored.push({ text: t.text, d });
      }
    }

    scored.sort((a, b) => a.d - b.d);
    const nearby = scored.slice(0, MAX_TEXTS).map((s) => s.text);
    if (nearby.length === 0) continue;

    const ctx: SymbolContext = { nearby };

    // ---- domain rules, on the neighbouring text ----
    // Nearest first: the label closest to the symbol is the one describing it.
    for (const line of nearby) {
      const decoded = decodeElectrical(line);
      if (decoded && decoded.confidence >= 0.6) {
        ctx.ruleHint = decoded.label;
        ctx.ruleEvidence = `${decoded.evidence} — read from "${line}" beside this symbol`;
        ctx.ruleConfidence = decoded.confidence;
        break;
      }
      const cable = parseCable(line);
      if (cable) {
        ctx.ruleHint = cable.label;
        ctx.ruleEvidence = `cable specification "${line}" beside this symbol`;
        ctx.ruleConfidence = 0.75;
        break;
      }
    }

    out.set(key, ctx);
  }

  return out;
}

/** one placement of a block, with the text printed around that instance */
export interface InstanceContext {
  handle: string;
  at: Vec2;
  nearby: string[];
}

/**
 * Text beside EACH placement, not pooled per block.
 *
 * The pooled version answers "what kind of thing is this block?". Billing needs
 * a different question: "what is THIS one rated?". One block on a real SLD
 * carried "63A,4P", "40A,4P", "125A,4P" and "32A,4P" — four different bill
 * lines wearing one block name. Pooling them produces a single line of 98
 * that no vendor can price; keeping them apart produces four that they can.
 */
export function instanceContexts(
  doc: CadDocument,
  keys: Iterable<string>,
  maxPerKey = 400,
): Map<string, InstanceContext[]> {
  const wanted = new Set(keys);
  const out = new Map<string, InstanceContext[]>();
  if (wanted.size === 0) return out;

  const texts = textEntities(doc);

  for (const e of doc.entities) {
    if (e.type !== 'insert' || !wanted.has(e.blockName)) continue;
    const handle = e.style.handle;
    if (!handle) continue;
    const list = out.get(e.blockName) ?? [];
    if (list.length >= maxPerKey) continue;

    const block = doc.blocks.get(e.blockName);
    const size = block ? approximateSize(block.entities) : 0;
    const radius = Math.min(
      Math.max(size * Math.abs(e.scale.x || 1) * NEAR_RADIUS_FACTOR, 200),
      MAX_RADIUS,
    );

    const scored: { text: string; d: number }[] = [];
    for (const t of texts) {
      const d = Math.hypot(t.at.x - e.position.x, t.at.y - e.position.y);
      if (d <= radius) scored.push({ text: t.text, d });
    }
    scored.sort((a, b) => a.d - b.d);

    list.push({
      handle,
      at: e.position,
      nearby: scored.slice(0, MAX_TEXTS).map((s) => s.text),
    });
    out.set(e.blockName, list);
  }

  return out;
}

/**
 * Render a symbol's context for the prompt.
 *
 * Kept verbatim and attributed. The model is being handed evidence, not a
 * conclusion — it should be able to disagree with a rule when the surrounding
 * text says otherwise, and it can only do that if it sees the text.
 */
export function describeContext(ctx: SymbolContext | undefined): string {
  if (!ctx || ctx.nearby.length === 0) return '';
  const parts = [`printed beside it: ${ctx.nearby.map((t) => JSON.stringify(t)).join(', ')}`];
    if (ctx.ruleHint) {
    parts.push(
      `a naming rule suggests "${ctx.ruleHint}" (${ctx.ruleEvidence}) — treat as a HINT, ` +
        `the nearby label may belong to a different symbol`,
    );
  }
  return parts.join('; ');
}
