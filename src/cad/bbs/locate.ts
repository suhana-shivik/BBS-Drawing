// Finding a member on the drawing.
//
// A schedule row says "F1". The drawing says "F1" in two very different
// places: once as a row of the FOOTING SCHEDULE table, and once per physical
// footing as a tag on the general-arrangement plan. Only the second kind is a
// member instance.
//
// Separating them buys two things at once:
//
//   1. Clicking a schedule row can highlight every F1 in the structure, which
//      is what "where is this?" actually means to someone reading a plan.
//   2. COUNTING them gives `Nos` — the number of that member in the structure.
//      That figure is on no schedule table, it was defaulting to 1, and being
//      wrong by a factor of forty is the largest error this module can make.
//      Counting tags is how a QS gets it by hand, and it is derivable here.
//
// The count is offered, never applied silently. A tag inside a detail bubble
// or a revision cloud would inflate it, and a wrong Nos is exactly the kind of
// invisible poison the engine refuses elsewhere — so it is surfaced with its
// evidence and the user decides.
import type { CadDocument, CadEntity } from '../types';
import type { DrawingExtract } from './types';

export interface MemberInstances {
  mark: string;
  /** handles of the plan tags — what to select when locating the member */
  handles: string[];
  /** how many tags were found outside any schedule table */
  count: number;
  /** handles that sit inside a schedule table — excluded from the count */
  inTable: string[];
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function tableBoxes(extract: DrawingExtract): Box[] {
  return extract.tables.map((t) => ({
    // a little slack: a mark can sit just outside the reconstructed bounds
    minX: t.min.x - 50,
    minY: t.min.y - 50,
    maxX: t.max.x + 50,
    maxY: t.max.y + 50,
  }));
}

function inside(boxes: Box[], x: number, y: number): boolean {
  return boxes.some((b) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY);
}

/**
 * Is this text the bare mark, rather than a sentence that mentions it?
 *
 * A plan tag reads exactly "F1". A note reading "F1 TO F9 TYPICAL" is not an
 * instance of anything, and counting it would inflate `Nos`. Trailing
 * punctuation and surrounding whitespace are tolerated because CAD text
 * routinely carries them; anything else is rejected.
 */
function isBareMark(text: string, mark: string): boolean {
  // Dots INSIDE the token are typography, not identity: the GAMCO layout tags
  // its stub columns "S.C" while every other layer of the system knows the
  // mark as SC. The mismatch made count read 0, 1 was assumed, and the panel
  // asked "how many?" while the tags sat in plain sight on the layout.
  const clean = (s: string): string =>
    s.replace(/\s+/g, '').replace(/[.:;,()-]+$/g, '').replace(/\./g, '').toUpperCase();
  return clean(text) === clean(mark);
}

/**
 * Every place this member is tagged on the drawing.
 *
 * Only modelspace text is considered. Block-definition children are reached
 * through their INSERT's handle by the display list, so a mark inside a block
 * still selects the instance a user can see and click.
 */
export function locateMember(
  doc: CadDocument,
  extract: DrawingExtract,
  mark: string,
): MemberInstances {
  const boxes = tableBoxes(extract);
  const handles: string[] = [];
  const inTable: string[] = [];

  const visit = (entities: readonly CadEntity[]): void => {
    for (const e of entities) {
      if (e.type !== 'text') continue;
      if (!isBareMark(e.text, mark)) continue;
      const h = e.style.handle;
      if (!h) continue;
      if (inside(boxes, e.position.x, e.position.y)) inTable.push(h);
      else handles.push(h);
    }
  };
  visit(doc.entities);

  return { mark, handles, count: handles.length, inTable };
}

/** Locate every member at once — one pass over the drawing rather than N. */
export function locateMembers(
  doc: CadDocument,
  extract: DrawingExtract,
  marks: readonly string[],
): Map<string, MemberInstances> {
  const boxes = tableBoxes(extract);
  const out = new Map<string, MemberInstances>();
  for (const m of marks) out.set(m, { mark: m, handles: [], count: 0, inTable: [] });

  for (const e of doc.entities) {
    if (e.type !== 'text') continue;
    const h = e.style.handle;
    if (!h) continue;
    for (const m of marks) {
      if (!isBareMark(e.text, m)) continue;
      const rec = out.get(m);
      if (!rec) break;
      if (inside(boxes, e.position.x, e.position.y)) rec.inTable.push(h);
      else {
        rec.handles.push(h);
        rec.count = rec.handles.length;
      }
      break;
    }
  }
  return out;
}
