// ============================================================
// Canonical members — decided by the drawing, never by a reply.
//
// WHAT WENT WRONG WITHOUT THIS
//
// The inventory pass was asked "classify this member" and its schema let it
// answer with a `name`. Run 002 shows what that permits:
//
//   the C2 task returned      "C2 (525x350)"
//   the SC task returned      "TYPICAL DETAIL OF SC-350x350" and "S.C"
//   the TB task returned      "C2"
//   the F1 task returned      five members
//   the RCC-WALL task returned "wall", "H-POLE", "PRECACT PANEL"
//
// Eight real elements became fifteen members, most of them caption text. Every
// downstream stage then worked on identities the sheet does not have: placements
// were sought for them, repairs were spent on them, and coverage objected that
// they had no bars.
//
// The defect is not that the code trusted the reply. It is that the QUESTION
// allowed a member-classification call to invent a member. So identity is
// established here, deterministically, before any request is made — and a pass
// is given a `targetMemberId` it can only classify, never rename.
//
// ALIASES ARE KEPT, NOT DISCARDED. "TYPICAL DETAIL OF C1-350x350" is how the
// sheet refers to C1, and a later pass pointing at that text must resolve to C1
// rather than be rejected. Absorbing an alias is correct; creating a member
// from it is not.
// ============================================================
import type { DrawingExtract } from './types';
import type { EvidenceGraph, EvidenceNode } from './evidence';

export interface CanonicalMember {
  /** stable within a run: MEM-01 */
  id: string;
  /** the mark as the schedule will show it */
  mark: string;
  /** every other way this sheet names it */
  aliases: string[];
  declarationIds: string[];
  markEvidenceIds: string[];
  /** how the sheet described it, verbatim — the classifier's evidence */
  declaredAs?: string;
}

export interface MemberRegistry {
  members: CanonicalMember[];
  byId: ReadonlyMap<string, CanonicalMember>;
  /** any name, alias or caption → the canonical member, or undefined */
  resolve(name: string): CanonicalMember | undefined;
  /** names that reached no canonical member, with why — never silent */
  unmatched: { name: string; reason: string }[];
}

const norm = (s: string): string =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .trim();

/** words that describe a drawing, not a member */
const CAPTION_WORDS = /\b(TYPICAL|DETAIL|SECTION|LAYOUT|PLAN|ELEVATION|C\/S|AT|OF|FOR|FROM|THK|TOP)\b/g;

/**
 * The mark hiding inside a caption.
 *
 * "TYPICAL DETAIL OF C1-350x350" is C1. "C2- (350x525)" is C2. "S.C" is SC.
 * Matching is by NORMALISED CONTAINMENT against marks the extractor already
 * found, longest first — so "C2" is not stolen by "C1" and a two-character mark
 * cannot swallow a longer one.
 */
function markInside(text: string, marks: readonly string[]): string | undefined {
  const cleaned = norm(text.replace(CAPTION_WORDS, ' '));
  if (!cleaned) return undefined;
  const ordered = [...marks].sort((a, b) => norm(b).length - norm(a).length);
  for (const m of ordered) {
    const nm = norm(m);
    if (!nm) continue;
    if (cleaned === nm) return m;
    // a mark followed by a size or a bracket — "C1350X350", "C2350X525"
    if (cleaned.startsWith(nm) && /^\d/.test(cleaned.slice(nm.length))) return m;
  }
  return undefined;
}

/**
 * Every member this drawing actually has.
 *
 * Marks come first because a mark is what a schedule is keyed by. Declarations
 * that name a mark are folded into it as aliases; declarations that name
 * nothing else — RCC WALL, H-POLE — are members in their own right, because a
 * wall carries steel whether or not anyone tagged it.
 */
export function buildMemberRegistry(extract: DrawingExtract, graph: EvidenceGraph): MemberRegistry {
  const marks = extract.marks ?? [];
  const members: CanonicalMember[] = [];
  const unmatched: { name: string; reason: string }[] = [];
  const byNorm = new Map<string, CanonicalMember>();

  const add = (mark: string): CanonicalMember => {
    const existing = byNorm.get(norm(mark));
    if (existing) return existing;
    const m: CanonicalMember = {
      id: `MEM-${String(members.length + 1).padStart(2, '0')}`,
      mark,
      aliases: [],
      declarationIds: [],
      markEvidenceIds: [],
    };
    members.push(m);
    byNorm.set(norm(mark), m);
    return m;
  };

  for (const mark of marks) add(mark);

  // declarations: fold into a mark where they name one, otherwise a member
  for (const d of extract.declared ?? []) {
    const owner = markInside(d.name, marks);
    const target = owner ? add(owner) : add(d.name);
    if (owner && norm(d.name) !== norm(owner) && !target.aliases.includes(d.name)) {
      target.aliases.push(d.name);
    }
    if (!target.declaredAs) target.declaredAs = d.raw ?? `${d.name} ${d.sizeText ?? ''}`.trim();
  }

  // evidence: attach declaration and mark nodes to their canonical member
  for (const node of graph.nodes) {
    const name = String(node.metadata.mark ?? node.metadata.name ?? '');
    if (!name) continue;
    const owner = byNorm.get(norm(name)) ?? (markInside(name, marks) ? add(markInside(name, marks)!) : undefined);
    if (!owner) {
      if (node.kind === 'declaration') {
        unmatched.push({ name, reason: 'declared on the sheet but names no member the extractor found' });
      }
      continue;
    }
    if (node.kind === 'mark') owner.markEvidenceIds.push(node.id);
    if (node.kind === 'declaration') {
      owner.declarationIds.push(node.id);
      if (norm(name) !== norm(owner.mark) && !owner.aliases.includes(name)) owner.aliases.push(name);
    }
  }

  const byId = new Map(members.map((m) => [m.id, m]));

  return {
    members,
    byId,
    unmatched,
    resolve(name: string) {
      const direct = byNorm.get(norm(name));
      if (direct) return direct;
      for (const m of members) {
        if (m.aliases.some((a) => norm(a) === norm(name))) return m;
      }
      // Prefix-match against EVERY canonical mark, not just the tagged ones.
      // A member can enter the registry from a declaration alone — a wall or a
      // pole is never tagged — and matching only `extract.marks` then failed to
      // fold "H-POLE (150X150X2400)" into the H-POLE it plainly names.
      const inside = markInside(
        name,
        members.map((m) => m.mark),
      );
      return inside ? byNorm.get(norm(inside)) : undefined;
    },
  };
}

/**
 * How a member is described to the pass that classifies it.
 *
 * The id is what comes back; the aliases are there so the model can see the
 * sheet's own wording without being able to answer with it.
 */
export function describeMember(m: CanonicalMember): string {
  const lines = [`MEMBER ${m.id} — the sheet calls this "${m.mark}"`];
  if (m.aliases.length) lines.push(`  also written: ${m.aliases.map((a) => `"${a}"`).join(', ')}`);
  if (m.declaredAs) lines.push(`  declared as: "${m.declaredAs}"`);
  lines.push(`  tagged ${m.markEvidenceIds.length}× on the layouts`);
  return lines.join('\n');
}

/** The mark nodes belonging to one member, as evidence. */
export function memberEvidence(m: CanonicalMember, graph: EvidenceGraph): EvidenceNode[] {
  return [...m.declarationIds, ...m.markEvidenceIds]
    .map((id) => graph.byId.get(id))
    .filter((n): n is EvidenceNode => !!n);
}
