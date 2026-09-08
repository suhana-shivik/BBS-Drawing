// ============================================================
// WHAT KIND OF MEMBER THIS IS — the one question the run depends on.
//
// Lives in the calculation layer because the CALCULATION depends on it: a
// running member's bars are cut and counted along its run, a counted one's
// from its own plan size. It used to live in `cad/bbs/build.ts`, which meant
// the engine imported the drawing-reading layer to answer a question about a
// member it had already been handed — an inversion that made the engine
// impossible to test or reuse without the reader behind it.
//
// `build.ts` re-exports both names, so every existing caller is unchanged.
// ============================================================
import type { BbsMember } from '../src/cad/bbs/types';

/** the words that make a member a thing that RUNS rather than a thing that sits */
const LINEAR_WORDS = /\b(beam|wall|fence|parapet|drain)\b/i;

/**
 * Is a member with this mark (and declared type, when the sheet gives one) a
 * RUNNING structure — one whose extent is a length along which bars repeat?
 *
 * This is the ONE question that decides whether a run is a dimension of the
 * member at all. A beam, a wall, a fence, a parapet, a drain have a run; a
 * footing, a column, a pedestal, a slab panel, a stair flight do not — they
 * are counted, and each one's bars are cut from its own plan size. Every
 * caller that would ask for, apply, or compare against a TOTAL RUN must ask
 * this first, so that the question is only ever put for a member it can
 * answer for. See `isLinearMember` for the same test on a scheduled member.
 */
export function isLinearMark(mark: string, type = ''): boolean {
  if (type && LINEAR_WORDS.test(type)) return true;
  if (LINEAR_WORDS.test(mark)) return true;
  return /^(TB|PB|GB|LB|RB|BW|RW)\d{0,3}$/i.test(mark.trim());
}

export function isLinearMember(member: BbsMember): boolean {
  if (LINEAR_WORDS.test(member.type)) return true;
  // THE MARK IS THE ONLY PLACE THE WORD APPEARS ON THE ORCHESTRATED PATH.
  //
  // `type` was the only thing tested, and the orchestrated build names every
  // member `type: 'member'` — it has no type to give. So "RCC WALL" was not a
  // wall: its bars took the counted-object path, and a bar the drawing spaces
  // along the wall's run was measured across its 200 mm THICKNESS instead of
  // its height. That printed a 100 mm "wall bar", 501 of them, and the row
  // computed cleanly all the way to a weight.
  //
  // A declared member's mark IS its name on this kind of sheet — "RCC WALL",
  // "TIE BEAM", "BOUNDARY WALL" — so the same words are read from it.
  if (LINEAR_WORDS.test(member.mark)) return true;
  return /^(TB|PB|GB|LB|RB|BW|RW)\d{0,3}$/i.test(member.mark.trim());
}
