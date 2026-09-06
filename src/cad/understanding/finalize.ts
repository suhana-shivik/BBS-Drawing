// ONE OWNER PER ENTITY, AND GEOMETRY DECIDES CONNECTIVITY.
//
// Two rules, and everything in this file exists to keep them:
//
//   1. EVERY entity of the drawing has EXACTLY ONE final owner. Sections
//      overlap — the first pass cuts boxes, not a partition — so the same
//      entity is claimed by several of them. Counting each region's claims
//      independently made a 3,063-entity drawing report 4,783: not a rounding
//      error but the same geometry counted up to three times, which makes
//      every coverage figure built on it meaningless.
//
//   2. CONNECTIVITY IS GEOMETRY. Whether a leftover touches a region is
//      arithmetic on entity boxes. The model may say what a residual IS; it
//      may not decide where it sits. A reading calling something "independent"
//      while its entities overlap a region is wrong about a fact it was not
//      asked to judge, and the panel must never repeat it.
//
// The ownership priority is fixed and total, so the answer cannot depend on
// iteration order:
//
//      INITIAL_REGION      the first pass already cut it
//   >  SECOND_PASS_REGION  attached to a region, or its own new one
//   >  EXPLAINED_RESIDUAL  read, and needs no area of its own
//   >  STILL_UNREAD        nobody has accounted for it
//
// Region rectangles may overlap. Entity ownership may not.
//
// Nothing here re-cuts a section, moves a first-pass bound except to GROW it
// around geometry it owns, or calls a model. It is arithmetic on numbers
// already in hand.

import type { CadDocument, CadEntity } from '../types';
import { boundsIntersect, entityBoundsMm, unionBounds } from './bounds';
import { boundsDistance } from './gaps';
import type { ResidualResult } from './residual';
import type { DrawingSection, SectionBounds } from './types';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** The four things an entity can be, and it is exactly one of them. */
export type OwnerState =
  | 'INITIAL_REGION'
  | 'SECOND_PASS_REGION'
  | 'EXPLAINED_RESIDUAL'
  | 'STILL_UNREAD';

export interface EntityOwner {
  state: OwnerState;
  /** REGION-XX, GAP-XX, or `UNPLACED` for an entity with no measurable extent */
  owner: string;
}

/** Where a region's geometry came from. */
export type RegionSource = 'initial' | 'residual-second-pass' | 'initial + residual-second-pass';

export interface FinalRegion {
  sectionId: string;
  label: string;
  kind: string;
  /** the union of the original region and every entity it owns */
  bounds: SectionBounds;
  /**
   * UNIQUE entities this region OWNS — not the entities its box covers.
   *
   * An entity inside three overlapping regions belongs to one of them. This is
   * that one, so these counts sum to the drawing rather than to three times it.
   */
  entityIds: string[];
  source: RegionSource;
  status: 'initial' | 'attached' | 'read';
  /** GAP ids whose content was merged in */
  attached: string[];
  /** section ids that were the SAME AREA and were folded into this one */
  mergedFrom: string[];
  /**
   * Geometry this region OWNS that lies too far from it to grow its box.
   *
   * It gets its own outline, drawn where it actually is. Both alternatives are
   * wrong: stretching the region to reach it washes the sheet blue, and
   * drawing nothing leaves read, owned geometry looking exactly like geometry
   * nobody ever saw — which is how two of four column marks on a layout plan
   * came to be reported as accounted for while sitting unmarked on screen.
   */
  detached: { gapId: string; bounds: SectionBounds }[];
}

/** Purely geometric: what the boxes say, before anybody reads anything. */
export type Relationship = 'CONNECTED' | 'NEAR_CONNECTED' | 'INDEPENDENT';

export interface ResidualOutcome {
  gapId: string;
  /** THE authoritative relationship. Computed from entity geometry, never read. */
  relationship: Relationship;
  /** every region this residual's entities actually touch, or come near */
  connectedRegions: string[];
  action: 'attach' | 'create-region' | 'explained' | 'unresolved';
  /** the region it attached to, or the new one it became */
  regionId: string | null;
  uniqueEntities: number;
  /** whether the second pass got a reading out of it */
  secondPass: 'READ' | 'UNREAD' | 'FAILED';
  why: string;
}

export interface EntityAccounting {
  totalEntities: number;
  initialRegionUnique: number;
  secondPassUnique: number;
  explainedResidualUnique: number;
  stillUnreadUnique: number;
  duplicateEntityOwnerships: number;
  /** the four states sum to the total, and nothing is owned twice */
  pass: boolean;
}

export interface Finalization {
  regions: FinalRegion[];
  /** only what is still unaccounted for — the orange ones */
  unresolved: ResidualResult[];
  outcomes: ResidualOutcome[];
  ownership: Map<string, EntityOwner>;
  accounting: EntityAccounting;
  /** entity ids assigned more than once. MUST be empty. */
  conflicts: string[];
}

// ---------------------------------------------------------------------------
// thresholds — shared with gaps.ts so "touching" means one thing
// ---------------------------------------------------------------------------

const JOIN_FRACTION = 0.015;
const NEAR_FRACTION = 0.09;

const diagonal = (b: SectionBounds): number => Math.hypot(b.xMax - b.xMin, b.yMax - b.yMin);
const grow = (b: SectionBounds, by: number): SectionBounds => ({
  xMin: b.xMin - by,
  yMin: b.yMin - by,
  xMax: b.xMax + by,
  yMax: b.yMax + by,
});

/**
 * A STABLE ID FOR EVERY ENTITY.
 *
 * The DXF handle where there is one, its index otherwise. Ownership is a map
 * keyed by this, so handle-less entities would otherwise all collide on the
 * empty string and the accounting would lose every one of them but the first.
 */
export const entityIdOf = (e: CadEntity, index: number): string =>
  e.style?.handle && e.style.handle.trim() ? e.style.handle : `#${index}`;

// ---------------------------------------------------------------------------
// half one: connectivity, from entity geometry
// ---------------------------------------------------------------------------

/**
 * Where one residual sits, measured from its ENTITIES rather than its box.
 *
 * The cluster's bounding box is not the cluster. A scattered leftover has a
 * box that overlaps regions none of its entities go near — which is how one
 * residual came to report itself as joining all seven regions of a sheet. Each
 * entity is tested on its own, so `connectedRegions` names the regions the
 * geometry actually reaches and nothing else.
 */
export function connectivityOf(
  entityBoxes: readonly SectionBounds[],
  regions: readonly { sectionId: string; bounds: SectionBounds }[],
  sheet: SectionBounds | null,
): { relationship: Relationship; connectedRegions: string[] } {
  if (!entityBoxes.length || !regions.length) {
    return { relationship: 'INDEPENDENT', connectedRegions: [] };
  }
  const span = diagonal(sheet ?? entityBoxes[0]) || 1;
  const join = Math.max(span * JOIN_FRACTION, 1e-6);
  const nearMm = Math.max(span * NEAR_FRACTION, join);

  const touching: string[] = [];
  const near: string[] = [];
  for (const r of regions) {
    let best = Infinity;
    let touches = false;
    for (const b of entityBoxes) {
      if (boundsIntersect(grow(b, join), r.bounds)) {
        touches = true;
        break;
      }
      best = Math.min(best, boundsDistance(b, r.bounds));
    }
    if (touches) touching.push(r.sectionId);
    else if (best <= nearMm) near.push(r.sectionId);
  }
  if (touching.length) return { relationship: 'CONNECTED', connectedRegions: touching };
  if (near.length) return { relationship: 'NEAR_CONNECTED', connectedRegions: near };
  return { relationship: 'INDEPENDENT', connectedRegions: [] };
}

// ---------------------------------------------------------------------------
// half two: what to DO about it
// ---------------------------------------------------------------------------

const ATTACHING_RELATIONS = new Set(['part-of', 'continuation', 'annotation', 'reference']);

/** Enough to stand as an area of its own — text says something, a stray line does not. */
const meaningful = (r: ResidualResult): boolean =>
  (r.text?.length ?? 0) > 0 || (r.entityCount ?? 0) >= 2;

/**
 * The action, from the GEOMETRY and the reading together — geometry first.
 *
 * A residual whose entities touch a region is inside that region's area
 * whatever the reading says; the reading only chooses WHICH of the regions it
 * touches, and only when it names one of them. A model's "independent" cannot
 * overturn an overlap, because an overlap is not a matter of opinion.
 */
export function outcomeFor(
  r: ResidualResult,
  relationship: Relationship,
  connectedRegions: readonly string[],
  uniqueEntities: number,
): ResidualOutcome {
  const base = {
    gapId: r.gapId,
    relationship,
    connectedRegions: [...connectedRegions],
    uniqueEntities,
  };
  const secondPass: ResidualOutcome['secondPass'] =
    r.status === 'read' && r.reading ? 'READ' : r.status === 'unread' ? 'UNREAD' : 'FAILED';

  if (secondPass !== 'READ') {
    return {
      ...base,
      action: 'unresolved',
      regionId: null,
      secondPass,
      why: r.note ?? (r.status === 'unread' ? 'not read yet' : 'the reading failed'),
    };
  }
  const rel = r.reading!.relation;
  if (relationship !== 'INDEPENDENT' && connectedRegions.length && ATTACHING_RELATIONS.has(rel)) {
    const named =
      r.linkedTo && connectedRegions.includes(r.linkedTo) ? r.linkedTo : connectedRegions[0];
    return { ...base, action: 'attach', regionId: named, secondPass, why: `${rel} of ${named}` };
  }
  if (!meaningful(r)) {
    return {
      ...base,
      action: 'explained',
      regionId: null,
      secondPass,
      why: r.reading!.summary || 'read — too small to need an area of its own',
    };
  }
  return {
    ...base,
    action: 'create-region',
    regionId: null,
    secondPass,
    why: r.reading!.summary || 'read as its own drawing content',
  };
}

// ---------------------------------------------------------------------------
// dedupe: one box per area
// ---------------------------------------------------------------------------

function areaKey(b: SectionBounds): string {
  const r = (v: number) => Math.round(v * 10) / 10;
  return `${r(b.xMin)},${r(b.yMin)},${r(b.xMax)},${r(b.yMax)}`;
}

const nextRegionId = (taken: ReadonlySet<string>): (() => string) => {
  let n = 0;
  for (const id of taken) {
    const m = /^REGION-(\d+)$/.exec(id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return () => `REGION-${String(++n).padStart(2, '0')}`;
};

/** Packages outlive the code that wrote them — fill the holes once, here. */
const normalise = (r: ResidualResult): ResidualResult => ({
  ...r,
  entityIds: Array.isArray(r.entityIds) ? r.entityIds : [],
  text: Array.isArray(r.text) ? r.text : [],
  entityCount: Number.isFinite(r.entityCount) ? r.entityCount : 0,
});

// ---------------------------------------------------------------------------
// the finalisation
// ---------------------------------------------------------------------------

export function finalizeSecondPass(
  doc: CadDocument | null,
  sections: readonly DrawingSection[],
  stored: readonly ResidualResult[],
): Finalization {
  const residuals = stored.map(normalise);

  // --- every entity, once, with a stable id and its box --------------------
  const entities = (doc?.entities ?? []).map((e, i) => ({
    id: entityIdOf(e, i),
    box: doc ? entityBoundsMm(e, doc) : null,
  }));
  const boxById = new Map(entities.filter((e) => e.box).map((e) => [e.id, e.box!]));

  // --- one box per area ----------------------------------------------------
  const regions: FinalRegion[] = [];
  const byArea = new Map<string, FinalRegion>();
  const alias = new Map<string, string>();
  for (const s of sections) {
    const key = areaKey(s.bounds);
    const first = byArea.get(key);
    if (first) {
      first.mergedFrom.push(s.sectionId);
      alias.set(s.sectionId, first.sectionId);
      continue;
    }
    const region: FinalRegion = {
      sectionId: s.sectionId,
      label: s.label,
      kind: s.kind,
      bounds: { ...s.bounds },
      entityIds: [],
      source: 'initial',
      status: 'initial',
      attached: [],
      mergedFrom: [],
      detached: [],
    };
    byArea.set(key, region);
    regions.push(region);
  }
  /** The ORIGINAL first-pass boxes — the top of the ownership priority. */
  const initialBoxes = regions.map((r) => ({ sectionId: r.sectionId, bounds: { ...r.bounds } }));
  const resolve = (id: string | null): string | null => (id ? (alias.get(id) ?? id) : null);

  // --- connectivity, per residual, from its entities ------------------------
  const sheet = doc?.extents
    ? {
        xMin: doc.extents.min.x,
        yMin: doc.extents.min.y,
        xMax: doc.extents.max.x,
        yMax: doc.extents.max.y,
      }
    : null;
  const boxesOf = (r: ResidualResult): SectionBounds[] => {
    const own = r.entityIds.map((id) => boxById.get(id)).filter((b): b is SectionBounds => !!b);
    // A package written before entity ids were stored falls back to its own
    // box: degraded, but it still gets an answer rather than none.
    return own.length ? own : [r.bounds];
  };

  const outcomes: ResidualOutcome[] = residuals.map((r) => {
    const { relationship, connectedRegions } = connectivityOf(boxesOf(r), initialBoxes, sheet);
    const o = outcomeFor(
      r,
      relationship,
      connectedRegions.map((id) => resolve(id)!),
      new Set(r.entityIds).size || r.entityCount,
    );
    return { ...o, regionId: resolve(o.regionId) };
  });
  const byGap = new Map(residuals.map((r) => [r.gapId, r]));
  const byId = new Map(regions.map((r) => [r.sectionId, r]));

  // --- promote what stands on its own --------------------------------------
  const idFor = nextRegionId(new Set(sections.map((s) => s.sectionId)));
  for (const o of outcomes) {
    if (o.action !== 'create-region') continue;
    const r = byGap.get(o.gapId)!;
    const same = regions.find((x) => areaKey(x.bounds) === areaKey(r.bounds));
    if (same) {
      // The same duplication arriving by a different door.
      o.action = 'attach';
      o.regionId = same.sectionId;
      o.why = `same area as ${same.sectionId}`;
      continue;
    }
    const sectionId = idFor();
    o.regionId = sectionId;
    const fresh: FinalRegion = {
      sectionId,
      label: r.reading?.kind ? `${r.reading.kind} · ${r.gapId}` : `read from ${r.gapId}`,
      kind: r.reading?.kind ?? 'unknown',
      bounds: { ...r.bounds },
      entityIds: [],
      source: 'residual-second-pass',
      status: 'read',
      attached: [r.gapId],
      mergedFrom: [],
      detached: [],
    };
    regions.push(fresh);
    byId.set(sectionId, fresh);
  }
  for (const o of outcomes) {
    if (o.action !== 'attach' || !o.regionId) continue;
    const region = byId.get(o.regionId);
    if (!region) {
      o.action = 'unresolved';
      o.regionId = null;
      o.why = 'the region it was attached to is not in this package';
      continue;
    }
    if (!region.attached.includes(o.gapId)) region.attached.push(o.gapId);
    if (region.source === 'initial') {
      region.source = 'initial + residual-second-pass';
      region.status = 'attached';
    }
  }

  // --- OWNERSHIP: every entity, exactly once, in priority order ------------
  //
  // Built from the entity list rather than from the regions' own claims,
  // because the claims overlap and the truth must not. An entity is offered to
  // the first-pass regions first and only then to whatever the second pass
  // made of the leftover it belongs to.
  const owningGap = new Map<string, ResidualOutcome>();
  for (const o of outcomes) {
    for (const id of byGap.get(o.gapId)!.entityIds) if (!owningGap.has(id)) owningGap.set(id, o);
  }

  const ownership = new Map<string, EntityOwner>();
  const conflicts: string[] = [];
  for (const { id, box } of entities) {
    if (ownership.has(id)) {
      // Two entities sharing one id. Reported, never silently overwritten: it
      // means the id is not stable, and every count built on it is suspect.
      conflicts.push(id);
      continue;
    }
    const cut = box ? initialBoxes.find((r) => boundsIntersect(r.bounds, box)) : undefined;
    if (cut) {
      ownership.set(id, { state: 'INITIAL_REGION', owner: cut.sectionId });
      continue;
    }
    const o = owningGap.get(id);
    if ((o?.action === 'attach' || o?.action === 'create-region') && o.regionId) {
      ownership.set(id, { state: 'SECOND_PASS_REGION', owner: o.regionId });
    } else if (o?.action === 'explained') {
      ownership.set(id, { state: 'EXPLAINED_RESIDUAL', owner: o.gapId });
    } else {
      ownership.set(id, {
        state: 'STILL_UNREAD',
        owner: o?.gapId ?? (box ? 'UNASSIGNED' : 'UNPLACED'),
      });
    }
  }

  // --- the regions own exactly what the map says they own ------------------
  //
  // A HIGHLIGHT IS NOT AN OWNERSHIP LIST. A region can own an entity without
  // its blue box having to reach that entity, and keeping the two separate is
  // what stops one from wrecking the other.
  //
  // The bound it must obey: a residual can be SCATTERED. GAP-01 on the
  // foundations sheet is 82 entities spread across the whole drawing; attach
  // them to a region and union every one of them in, and that region's box
  // becomes the sheet — a translucent blue wash over the entire drawing, with
  // the actual read areas invisible underneath it. Unioning the residual's
  // bounding box did it, and so does unioning its entities one at a time: the
  // entities ARE the sheet.
  //
  // So growth is measured against the ORIGINAL box, not the running one — a
  // chain of adjacent entities must not walk a region across the drawing —
  // and only entities that genuinely abut it move it at all. Everything else
  // is still owned, still counted, still blue where it lies if it earned a
  // region of its own; it simply does not stretch somebody else's outline.
  const originalBounds = new Map(regions.map((r) => [r.sectionId, { ...r.bounds }]));
  const sheetSpan = sheet ? diagonal(sheet) : 0;
  const reach = sheetSpan > 0 ? sheetSpan * JOIN_FRACTION : 0;
  const detached = new Map<string, Map<string, SectionBounds>>();
  for (const [id, own] of ownership) {
    const r = byId.get(own.owner);
    if (!r) continue;
    r.entityIds.push(id);
    if (own.state !== 'SECOND_PASS_REGION') continue;
    const box = boxById.get(id);
    if (!box) continue;
    const origin = originalBounds.get(r.sectionId);
    // A region created FROM this residual has no original box to abut — it is
    // the residual — so it takes everything it owns. It is re-tightened below.
    if (!origin || boundsIntersect(grow(origin, reach), box)) {
      r.bounds = unionBounds(r.bounds, box);
      continue;
    }
    // OWNED, BUT TOO FAR TO GROW THE BOX — SO IT GETS A BOX OF ITS OWN.
    //
    // This used to `continue`, and that was a hole: the entity was owned and
    // counted, and nothing drew it. On the columns sheet two of the four C1
    // marks in the layout plan were attached to REGION-03 and REGION-07 and
    // sat eight hundred millimetres from either, so both were read, both were
    // owned, and both were invisible — indistinguishable on screen from
    // geometry the pipeline had never seen.
    //
    // Stretching the region to reach them is what put a sheet-wide blue wash
    // over a whole drawing, so that is not the answer either. A detached piece
    // is drawn WHERE IT IS, as its own outline, still belonging to its region.
    // One box per residual, not per entity: the four lines and the label of a
    // column mark are one thing on the drawing.
    const gapId = owningGap.get(id)?.gapId ?? 'attached';
    const perRegion = detached.get(r.sectionId) ?? new Map<string, SectionBounds>();
    const grown = perRegion.get(gapId);
    perRegion.set(gapId, grown ? unionBounds(grown, box) : { ...box });
    detached.set(r.sectionId, perRegion);
  }
  for (const r of regions) {
    const mine = detached.get(r.sectionId);
    r.detached = mine ? [...mine].map(([gapId, bounds]) => ({ gapId, bounds })) : [];
  }

  // --- a NEW region is framed by what it owns, not by its cluster ----------
  //
  // The same wash arriving by a different door. A region promoted from a
  // residual started life with the residual's CLUSTER box, and a cluster's box
  // is not the cluster: a scattered leftover's box is the sheet. Some of those
  // entities went to first-pass regions anyway (they had priority), so the
  // cluster box was never the right frame even before the scattering — it is
  // the extent of a group this region does not entirely own.
  //
  // Framing it by the entities it actually owns is both tighter and truer. A
  // residual whose own geometry genuinely spans the sheet still produces a
  // large box, and that is honest: the debug line flags anything over 60% so
  // it is visible rather than mistaken for a bug in the mapping.
  for (const r of regions) {
    if (r.source !== 'residual-second-pass') continue;
    let framed: SectionBounds | null = null;
    for (const id of r.entityIds) {
      const box = boxById.get(id);
      if (box) framed = framed ? unionBounds(framed, box) : { ...box };
    }
    if (framed) r.bounds = framed;
  }

  // --- what is left is what is still orange --------------------------------
  const stillOrange = new Set(outcomes.filter((o) => o.action === 'unresolved').map((o) => o.gapId));
  const unresolved = residuals.filter((r) => stillOrange.has(r.gapId));

  const count = (s: OwnerState): number => {
    let n = 0;
    for (const o of ownership.values()) if (o.state === s) n += 1;
    return n;
  };
  const totalEntities = entities.length;
  const initialRegionUnique = count('INITIAL_REGION');
  const secondPassUnique = count('SECOND_PASS_REGION');
  const explainedResidualUnique = count('EXPLAINED_RESIDUAL');
  const stillUnreadUnique = count('STILL_UNREAD');
  const sum = initialRegionUnique + secondPassUnique + explainedResidualUnique + stillUnreadUnique;

  return {
    regions,
    unresolved,
    outcomes,
    ownership,
    conflicts,
    accounting: {
      totalEntities,
      initialRegionUnique,
      secondPassUnique,
      explainedResidualUnique,
      stillUnreadUnique,
      duplicateEntityOwnerships: conflicts.length,
      pass: conflicts.length === 0 && sum === totalEntities,
    },
  };
}

// ---------------------------------------------------------------------------
// the acceptance report
// ---------------------------------------------------------------------------

export function finalizationReport(f: Finalization): string[] {
  const a = f.accounting;
  const merged = f.regions.reduce((n, r) => n + r.mergedFrom.length, 0);
  const lines = [
    'SECOND-PASS FINALISATION',
    `TOTAL ENTITIES: ${a.totalEntities}`,
    `INITIAL REGION UNIQUE: ${a.initialRegionUnique}`,
    `SECOND PASS UNIQUE: ${a.secondPassUnique}`,
    `EXPLAINED RESIDUAL UNIQUE: ${a.explainedResidualUnique}`,
    `STILL UNREAD UNIQUE: ${a.stillUnreadUnique}`,
    `DUPLICATE ENTITY OWNERSHIPS: ${a.duplicateEntityOwnerships}`,
    `ACCOUNTING CHECK: ${a.pass ? 'PASS' : 'FAIL'}`,
    `DUPLICATE AREAS MERGED: ${merged}`,
  ];
  for (const o of f.outcomes) {
    lines.push(
      '',
      o.gapId,
      `  relationship: ${o.relationship}`,
      `  connectedRegions: ${o.connectedRegions.join(', ') || '—'}`,
      `  uniqueEntities: ${o.uniqueEntities}`,
      `  secondPass: ${o.secondPass}`,
      `  finalStatus: ${
        o.action === 'attach'
          ? `ATTACHED → ${o.regionId}`
          : o.action === 'create-region'
            ? `NEW REGION → ${o.regionId}`
            : o.action === 'explained'
              ? 'EXPLAINED'
              : 'UNRESOLVED'
      }`,
    );
  }
  return lines;
}
