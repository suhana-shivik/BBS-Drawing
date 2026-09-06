// ============================================================
// The orchestrator's tool surface.
//
// WHY THIS EXISTS
//
// Until now a programmer decided what evidence each pass received. Run 004
// shows the cost: every member was offered fourteen proximity candidates and
// nothing else, TB's nearest being 12,068 mm away in another detail. The model
// could see, in the evidence block, callouts that plainly belonged to TB — and
// claimed them — but the deterministic candidate list had never offered them,
// so ninety claims were refused and no bar reached the schedule.
//
// Neither side was wrong. The restriction was doing its job, the model was
// reading the drawing, and they disagreed because the restriction was decided
// in advance by someone who could not see the sheet.
//
// So the choice moves: the orchestrator asks for what it needs, and these
// functions answer from the evidence graph. Nothing here computes a schedule,
// invents a fact, or writes anything. They are windows onto what was extracted,
// and every answer carries the evidence ids it came from so a later claim can
// be traced back.
//
// WHAT A TOOL MAY NOT DO
//
// No tool mutates state. No tool returns a value the drawing does not contain.
// A tool that finds nothing says so — it never widens its own search to be
// helpful, because a helpful widening is how a footing's bars reach a column.
// ============================================================
import type { EvidenceGraph, EvidenceNode } from './evidence';
import type { MemberRegistry, CanonicalMember } from './members';
import { bandViewBox, type PlacementBand } from './bands';
import { memberEvidence } from './members';
import { regionOf, renderRegions, resolveHint, type DrawingRegion } from './regions';
import { fullSheetSvg, regionSvg, validImage, type Rasteriser } from './render';
import type { CadDocument } from '../types';

export interface ToolContext {
  graph: EvidenceGraph;
  registry: MemberRegistry;
  bands: readonly PlacementBand[];
  userFacts: Readonly<Record<string, { mm: number; saidAs?: string }>>;
  /** needed only by the vision tools; absent means text-only, and it says so */
  doc?: CadDocument;
  regions?: readonly DrawingRegion[];
  rasterise?: Rasteriser;
}

/**
 * A tool answer carrying a picture.
 *
 * The envelope matters as much as the image: without knowing WHICH part of the
 * sheet it is looking at, and which evidence sits inside it, a crop is a pretty
 * rectangle the orchestrator cannot reason about.
 */
export interface ImageResult extends ToolResult {
  image: string;
  region: { x1: number; y1: number; x2: number; y2: number };
  source: 'DXF-render';
}

export function isImageResult(r: ToolResult): r is ImageResult {
  return typeof (r as ImageResult).image === 'string' && validImage((r as ImageResult).image);
}

export interface ToolResult {
  ok: boolean;
  /** what a reader needs, already rendered — the model reads this */
  text: string;
  /** every evidence id the answer touched, for provenance */
  evidenceIds: string[];
  /** why nothing came back, when nothing did */
  reason?: string;
}

const nothing = (reason: string): ToolResult => ({ ok: false, text: `(nothing) ${reason}`, evidenceIds: [], reason });

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** one evidence node, rendered — ids and text, never handles or raw coordinates */
function render(n: EvidenceNode, extra?: string): string {
  const value =
    n.kind === 'dimension'
      ? `= ${(n as unknown as { valueMm?: number }).valueMm ?? '?'} mm`
      : n.rawText
        ? JSON.stringify(n.rawText.slice(0, 70))
        : '';
  const unusable = n.metadata.unusable ? `  [UNUSABLE: ${n.metadata.unusable}]` : '';
  return `${n.id}  ${n.kind}  ${value}${extra ? `  ${extra}` : ''}${unusable}`;
}

function anchorOf(ctx: ToolContext, m: CanonicalMember): { x: number; y: number } | undefined {
  return memberEvidence(m, ctx.graph).find((n) => n.position)?.position;
}

// ------------------------------------------------------------
// the tools
// ------------------------------------------------------------

export interface Bounds { x1: number; y1: number; x2: number; y2: number }

const inBounds = (p: { x: number; y: number }, b: Bounds): boolean =>
  p.x >= Math.min(b.x1, b.x2) && p.x <= Math.max(b.x1, b.x2) &&
  p.y >= Math.min(b.y1, b.y2) && p.y <= Math.max(b.y1, b.y2);

/** everything of a kind inside a box, paged rather than truncated */
function inRegion(ctx: ToolContext, b: Bounds, kinds: string[] | null, page = 0, per = 120): ToolResult {
  if (!b || [b.x1, b.y1, b.x2, b.y2].some((v) => typeof v !== 'number')) {
    return nothing('a region needs {x1,y1,x2,y2} in drawing units');
  }
  const all = ctx.graph.nodes.filter(
    (n) => n.position && inBounds(n.position, b) && (!kinds || kinds.includes(n.kind)),
  );
  if (!all.length) return nothing(`nothing of that kind inside (${b.x1},${b.y1})-(${b.x2},${b.y2})`);
  const start = page * per;
  const slice = all.slice(start, start + per);
  const more = all.length - (start + slice.length);
  return {
    ok: true,
    text:
      `${all.length} node(s) in this region; showing ${start + 1}-${start + slice.length}` +
      (more > 0 ? `, ${more} more — ask again with page:${page + 1}` : '') +
      String.fromCharCode(10) +
      slice.map((n) => render(n, n.position ? `(${n.position.x.toFixed(0)},${n.position.y.toFixed(0)})` : '')).join(String.fromCharCode(10)),
    evidenceIds: slice.map((n) => n.id),
  };
}

function allBounds(ctx: ToolContext): { x1: number; y1: number; x2: number; y2: number } {
  const p = ctx.graph.nodes.filter((n) => n.position).map((n) => n.position!);
  if (!p.length) return { x1: 0, y1: 0, x2: 0, y2: 0 };
  return {
    x1: Math.min(...p.map((q) => q.x)),
    y1: Math.min(...p.map((q) => q.y)),
    x2: Math.max(...p.map((q) => q.x)),
    y2: Math.max(...p.map((q) => q.y)),
  };
}

export const TOOLS = {
  /**
   * The whole sheet, as a structured inventory.
   *
   * Deliberately available. Run 004 restricted every pass to fourteen
   * proximity candidates and produced nothing; the point of this surface is
   * that the orchestrator decides how much it wants to see.
   */
  getFullDrawing(ctx: ToolContext): ToolResult {
    const byKind: Record<string, number> = {};
    for (const n of ctx.graph.nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    const xs = ctx.graph.nodes.filter((n) => n.position).map((n) => n.position!.x);
    const ys = ctx.graph.nodes.filter((n) => n.position).map((n) => n.position!.y);
    const extent =
      xs.length
        ? `(${Math.min(...xs).toFixed(0)},${Math.min(...ys).toFixed(0)}) to (${Math.max(...xs).toFixed(0)},${Math.max(...ys).toFixed(0)})`
        : 'unknown';
    const lines = [
      `evidence nodes: ${JSON.stringify(byKind)}`,
      `drawn extent: ${extent}`,
      `layout bands: ${ctx.bands.length}`,
      ...ctx.bands.map(
        (b) => `  ${b.id} axis ${b.axis} extent ${Math.round(b.longitudinalRange[1] - b.longitudinalRange[0])} mm carries ${JSON.stringify(b.tally)}`,
      ),
      '',
      `members (${ctx.registry.members.length}):`,
      ...ctx.registry.members.map(
        (m) => `  ${m.id} "${m.mark}"${m.declaredAs ? ` — declared "${m.declaredAs}"` : ''} tagged ${m.markEvidenceIds.length}×`,
      ),
      '',
      'every reinforcement callout:',
      ...ctx.graph.nodes
        .filter((n) => n.kind === 'callout')
        .map((n) => `  ${render(n, n.position ? `(${n.position.x.toFixed(0)},${n.position.y.toFixed(0)})` : '')}`),
    ];
    return { ok: true, text: lines.join(String.fromCharCode(10)), evidenceIds: ctx.graph.nodes.map((n) => n.id) };
  },

  // ------------------------------------------------------------
  // VISION — for the questions structured extraction could not answer
  //
  // Run 005 asked getLeaderTarget nine times and got nothing nine times,
  // because the graph holds 56 leaders and no `points-at` edges at all. The
  // arrowheads are drawn on the sheet; they did not survive parsing. These
  // tools exist so "extraction could not resolve it" stops being the end of
  // the enquiry.
  // ------------------------------------------------------------

  /** the regions this sheet separates into — orientation before zoom */
  getDrawingRegions(ctx: ToolContext): ToolResult {
    const regions = ctx.regions ?? [];
    if (!regions.length) return nothing('no regions could be separated on this sheet');
    return {
      ok: true,
      text: renderRegions(regions),
      evidenceIds: regions.flatMap((r) => r.evidenceIds).slice(0, 200),
    };
  },

  async getFullDrawingImage(ctx: ToolContext, a: { reason?: string } = {}): Promise<ToolResult> {
    if (!ctx.doc || !ctx.rasterise) return nothing('this run has no renderer — structured evidence only');
    const image = await ctx.rasterise(fullSheetSvg(ctx.doc, { px: 1500 }), 1500);
    if (!validImage(image)) return nothing('the sheet could not be rendered');
    return {
      ok: true,
      image,
      region: allBounds(ctx),
      source: 'DXF-render',
      text: `the whole sheet${a.reason ? ` — ${a.reason}` : ''}. ${(ctx.regions ?? []).length} region(s) were separated on it.`,
      evidenceIds: [],
    } as ImageResult;
  },

  /**
   * A crop, by region id, semantic hint, or bounds.
   *
   * The hint form is the point: an orchestrator should be able to ask for
   * "the TB detail" without inventing CAD coordinates, and resolution happens
   * against the sheet's own captions — never a name the model supplied.
   */
  async getDrawingRegionImage(
    ctx: ToolContext,
    a: {
      regionId?: string;
      regionHint?: string;
      x1?: number;
      y1?: number;
      x2?: number;
      y2?: number;
      reason?: string;
      padFraction?: number;
    },
  ): Promise<ToolResult> {
    if (!ctx.doc || !ctx.rasterise) return nothing('this run has no renderer — structured evidence only');
    const regions = ctx.regions ?? [];
    let bounds: { x1: number; y1: number; x2: number; y2: number } | null = null;
    let inside: string[] = [];
    let named = '';

    if (a.regionId) {
      const r = regions.find((x) => x.id === a.regionId);
      if (!r) return nothing(`no region "${a.regionId}"; call getDrawingRegions first`);
      bounds = r.bounds;
      inside = r.evidenceIds;
      named = `${r.id}${r.label ? ` "${r.label}"` : ''}`;
    } else if (a.regionHint) {
      const hit = resolveHint(regions, a.regionHint, ctx.graph);
      if (!hit.region) return nothing(hit.reason ?? `"${a.regionHint}" matched nothing`);
      bounds = hit.region.bounds;
      inside = hit.region.evidenceIds;
      named = `${hit.region.id}${hit.region.label ? ` "${hit.region.label}"` : ''} (matched "${a.regionHint}")`;
    } else if ([a.x1, a.y1, a.x2, a.y2].every((v) => typeof v === 'number')) {
      bounds = { x1: a.x1!, y1: a.y1!, x2: a.x2!, y2: a.y2! };
      const lo = { x: Math.min(bounds.x1, bounds.x2), y: Math.min(bounds.y1, bounds.y2) };
      const hi = { x: Math.max(bounds.x1, bounds.x2), y: Math.max(bounds.y1, bounds.y2) };
      inside = ctx.graph.nodes
        .filter(
          (n) => n.position && n.position.x >= lo.x && n.position.x <= hi.x && n.position.y >= lo.y && n.position.y <= hi.y,
        )
        .map((n) => n.id);
      named = 'the bounds you gave';
    } else {
      return nothing('give a regionId, a regionHint, or bounds {x1,y1,x2,y2}');
    }

    const image = await ctx.rasterise(
      regionSvg(ctx.doc, bounds, { px: 1200, padFraction: a.padFraction ?? 0.08 }),
      1200,
    );
    if (!validImage(image)) return nothing(`${named} could not be rendered — it may contain nothing drawn`);
    const listed = inside
      .map((id) => ctx.graph.byId.get(id))
      .filter((n): n is EvidenceNode => !!n)
      .slice(0, 40);
    const NL = String.fromCharCode(10);
    return {
      ok: true,
      image,
      region: bounds,
      source: 'DXF-render',
      text:
        `${named}${a.reason ? ` — ${a.reason}` : ''}${NL}` +
        `${Math.round(bounds.x2 - bounds.x1)}×${Math.round(bounds.y2 - bounds.y1)} mm, containing:${NL}` +
        (listed.length ? listed.map((n) => `  ${render(n)}`).join(NL) : '  (nothing the extractor indexed)'),
      evidenceIds: listed.map((n) => n.id),
    } as ImageResult;
  },

  /** which region a piece of evidence sits in — the containment the graph lacks */
  getRegionOf(ctx: ToolContext, a: { evidenceId: string }): ToolResult {
    const r = regionOf(ctx.regions ?? [], a.evidenceId);
    if (!r) return nothing(`${a.evidenceId} is in no separated region`);
    return {
      ok: true,
      text: `${a.evidenceId} sits in ${r.id} (${r.kind})${r.label ? ` "${r.label}"` : ''} — ${r.basis}`,
      evidenceIds: r.evidenceIds.slice(0, 40),
    };
  },

  getMembers(ctx: ToolContext): ToolResult {
    return {
      ok: true,
      text: ctx.registry.members
        .map((m) => `${m.id}  "${m.mark}"  aliases=[${m.aliases.join(' | ')}]  tags=${m.markEvidenceIds.length}  ${m.declaredAs ?? ''}`)
        .join(String.fromCharCode(10)),
      evidenceIds: ctx.registry.members.flatMap((m) => [...m.declarationIds, ...m.markEvidenceIds]),
    };
  },

  getDrawingRegion(ctx: ToolContext, a: Bounds & { page?: number }): ToolResult {
    return inRegion(ctx, a, null, a.page ?? 0);
  },
  getEntities(ctx: ToolContext, a: Bounds & { page?: number }): ToolResult {
    return inRegion(ctx, a, null, a.page ?? 0);
  },
  getText(ctx: ToolContext, a: Bounds & { page?: number }): ToolResult {
    return inRegion(ctx, a, ['text', 'callout', 'mark', 'declaration'], a.page ?? 0);
  },
  getGeometry(ctx: ToolContext, a: Bounds & { page?: number }): ToolResult {
    return inRegion(ctx, a, ['geometry', 'dimension', 'leader'], a.page ?? 0);
  },
  getCallouts(ctx: ToolContext, a: Bounds & { page?: number }): ToolResult {
    return inRegion(ctx, a, ['callout'], a.page ?? 0);
  },
  getLeaders(ctx: ToolContext, a: Bounds & { page?: number }): ToolResult {
    return inRegion(ctx, a, ['leader'], a.page ?? 0);
  },
  getDimensions(ctx: ToolContext, a: Bounds & { page?: number }): ToolResult {
    return inRegion(ctx, a, ['dimension'], a.page ?? 0);
  },

  getNearbyEvidence(ctx: ToolContext, a: { x: number; y: number; radiusMm?: number }): ToolResult {
    if (typeof a?.x !== 'number' || typeof a?.y !== 'number') return nothing('need {x, y, radiusMm}');
    const r = a.radiusMm ?? 2000;
    const near = ctx.graph.nodes
      .filter((n) => n.position && dist(n.position, a) <= r)
      .map((n) => ({ n, d: dist(n.position!, a) }))
      .sort((p, q) => p.d - q.d)
      .slice(0, 80);
    if (!near.length) return nothing(`nothing within ${r} mm of (${a.x}, ${a.y})`);
    return {
      ok: true,
      text: near.map(({ n, d }) => render(n, `${Math.round(d)} mm`)).join(String.fromCharCode(10)),
      evidenceIds: near.map(({ n }) => n.id),
    };
  },

  getRawEvidence(ctx: ToolContext, a: { ids: string[] }): ToolResult {
    return TOOLS.getEvidence(ctx, a);
  },

  getMember(ctx: ToolContext, args: { memberId: string }): ToolResult {
    const m = ctx.registry.byId.get(args.memberId) ?? ctx.registry.resolve(args.memberId);
    if (!m) return nothing(`no member "${args.memberId}" on this drawing`);
    const lines = [
      `${m.id} — the sheet calls this "${m.mark}"`,
      m.aliases.length ? `  also written: ${m.aliases.map((a) => `"${a}"`).join(', ')}` : '',
      m.declaredAs ? `  declared as: "${m.declaredAs}"` : '',
      `  tagged ${m.markEvidenceIds.length}× on the layouts`,
      `  declarations: ${m.declarationIds.join(', ') || 'none'}`,
    ].filter(Boolean);
    return { ok: true, text: lines.join('\n'), evidenceIds: [...m.declarationIds, ...m.markEvidenceIds] };
  },

  getMemberMarks(ctx: ToolContext, args: { memberId: string }): ToolResult {
    const m = ctx.registry.byId.get(args.memberId) ?? ctx.registry.resolve(args.memberId);
    if (!m) return nothing(`no member "${args.memberId}"`);
    const nodes = m.markEvidenceIds.map((id) => ctx.graph.byId.get(id)).filter((n): n is EvidenceNode => !!n);
    if (!nodes.length) return nothing(`${m.mark} carries no mark tags — it is declared, not tagged`);
    const band = (n: EvidenceNode): string => {
      const b = ctx.bands.find((x) => x.occurrenceIds.includes(n.id));
      return b ? `in ${b.id}` : 'in no layout band';
    };
    return {
      ok: true,
      text: nodes.map((n) => render(n, `${band(n)}${n.position ? ` at (${n.position.x.toFixed(0)}, ${n.position.y.toFixed(0)})` : ''}`)).join('\n'),
      evidenceIds: nodes.map((n) => n.id),
    };
  },

  getMemberDeclaration(ctx: ToolContext, args: { memberId: string }): ToolResult {
    const m = ctx.registry.byId.get(args.memberId) ?? ctx.registry.resolve(args.memberId);
    if (!m) return nothing(`no member "${args.memberId}"`);
    const nodes = m.declarationIds.map((id) => ctx.graph.byId.get(id)).filter((n): n is EvidenceNode => !!n);
    if (!nodes.length) return nothing(`${m.mark} is not declared by name and size anywhere`);
    return { ok: true, text: nodes.map((n) => render(n)).join('\n'), evidenceIds: nodes.map((n) => n.id) };
  },

  getCallout(ctx: ToolContext, args: { calloutId: string }): ToolResult {
    const n = ctx.graph.byId.get(args.calloutId);
    if (!n) return nothing(`no evidence "${args.calloutId}"`);
    if (n.kind !== 'callout') return nothing(`${args.calloutId} is a ${n.kind}, not a callout`);
    const meta = n.metadata as Record<string, unknown>;
    const facts = [
      meta.diaMm !== undefined ? `diameter ${meta.diaMm}` : 'no diameter read',
      meta.spacingMm !== undefined ? `spacing ${meta.spacingMm}` : '',
      meta.count !== undefined ? `count ${meta.count}` : '',
      meta.legs !== undefined ? `${meta.legs} legs` : '',
    ].filter(Boolean);
    const carriers = ctx.graph.nodes.filter(
      (l) => l.kind === 'leader' && ctx.graph.related(l.id, 'carries').some((c) => c.id === n.id),
    );
    return {
      ok: true,
      text:
        `${render(n)}\n  parsed: ${facts.join(', ')}\n` +
        `  position: ${n.position ? `(${n.position.x.toFixed(0)}, ${n.position.y.toFixed(0)})` : 'unknown'}\n` +
        `  detail region: ${n.panelId ?? 'none — this sheet has no detail regions'}\n` +
        `  carried by leader(s): ${carriers.map((l) => l.id).join(', ') || 'none'}`,
      evidenceIds: [n.id, ...carriers.map((l) => l.id)],
    };
  },

  getCalloutsNear(ctx: ToolContext, args: { memberId: string; radiusMm?: number }): ToolResult {
    const m = ctx.registry.byId.get(args.memberId) ?? ctx.registry.resolve(args.memberId);
    if (!m) return nothing(`no member "${args.memberId}"`);
    const anchor = anchorOf(ctx, m);
    if (!anchor) return nothing(`${m.mark} has no positioned evidence to measure from`);
    const radius = args.radiusMm ?? 5000;
    const near = ctx.graph.nodes
      .filter((n) => n.kind === 'callout' && n.position && dist(n.position, anchor) <= radius)
      .map((n) => ({ n, d: dist(n.position!, anchor) }))
      .sort((a, b) => a.d - b.d);
    if (!near.length) return nothing(`no callout within ${radius} mm of ${m.mark}`);
    return {
      ok: true,
      text: near.map(({ n, d }) => render(n, `${Math.round(d)} mm away`)).join('\n'),
      evidenceIds: near.map(({ n }) => n.id),
    };
  },

  getCalloutsInDetail(ctx: ToolContext, args: { detailId: string }): ToolResult {
    const inside = ctx.graph.inPanel(args.detailId).filter((n) => n.kind === 'callout');
    if (!inside.length) {
      return nothing(
        `no callout belongs to "${args.detailId}". This sheet has no detail regions at all — ` +
          'every callout is unassigned, so containment cannot be used here.',
      );
    }
    return { ok: true, text: inside.map((n) => render(n)).join('\n'), evidenceIds: inside.map((n) => n.id) };
  },

  getLeadersNear(ctx: ToolContext, args: { memberId: string; radiusMm?: number }): ToolResult {
    const m = ctx.registry.byId.get(args.memberId) ?? ctx.registry.resolve(args.memberId);
    if (!m) return nothing(`no member "${args.memberId}"`);
    const anchor = anchorOf(ctx, m);
    if (!anchor) return nothing(`${m.mark} has no positioned evidence`);
    const radius = args.radiusMm ?? 5000;
    const near = ctx.graph.nodes
      .filter((n) => n.kind === 'leader' && n.position && dist(n.position, anchor) <= radius)
      .map((n) => ({ n, d: dist(n.position!, anchor) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 20);
    if (!near.length) return nothing(`no leader within ${radius} mm of ${m.mark}`);
    return {
      ok: true,
      text: near
        .map(({ n, d }) => {
          const carries = ctx.graph.related(n.id, 'carries').map((c) => c.id).join(', ') || 'nothing';
          const points = ctx.graph.related(n.id, 'points-at').map((c) => c.id).join(', ') || 'nothing';
          return `${n.id}  leader  ${Math.round(d)} mm away  carries: ${carries}  points at: ${points}`;
        })
        .join('\n'),
      evidenceIds: near.map(({ n }) => n.id),
    };
  },

  getLeaderTarget(ctx: ToolContext, args: { leaderId: string }): ToolResult {
    const n = ctx.graph.byId.get(args.leaderId);
    if (!n) return nothing(`no evidence "${args.leaderId}"`);
    if (n.kind !== 'leader') return nothing(`${args.leaderId} is a ${n.kind}, not a leader`);
    const targets = ctx.graph.related(n.id, 'points-at');
    const carries = ctx.graph.related(n.id, 'carries');
    if (!targets.length) return nothing(`${args.leaderId} points at nothing the extractor could identify`);
    return {
      ok: true,
      text:
        `${args.leaderId} carries ${carries.map((c) => c.id).join(', ') || 'nothing'}\n` +
        `  and terminates on:\n${targets.map((t) => `    ${render(t)}`).join('\n')}`,
      evidenceIds: [n.id, ...targets.map((t) => t.id), ...carries.map((c) => c.id)],
    };
  },

  getDimensionsNear(ctx: ToolContext, args: { memberId: string; radiusMm?: number }): ToolResult {
    const m = ctx.registry.byId.get(args.memberId) ?? ctx.registry.resolve(args.memberId);
    if (!m) return nothing(`no member "${args.memberId}"`);
    const anchor = anchorOf(ctx, m);
    if (!anchor) return nothing(`${m.mark} has no positioned evidence`);
    const radius = args.radiusMm ?? 4000;
    const near = ctx.graph.dimensions
      .filter((d) => d.position && dist(d.position, anchor) <= radius)
      .map((d) => ({ d, dd: dist(d.position!, anchor) }))
      .sort((a, b) => a.dd - b.dd)
      .slice(0, 30);
    if (!near.length) return nothing(`no readable dimension within ${radius} mm of ${m.mark}`);
    return {
      ok: true,
      text: near.map(({ d, dd }) => `${d.id}  = ${d.valueMm} mm  axis ${d.axis ?? '?'}  ${Math.round(dd)} mm away`).join('\n'),
      evidenceIds: near.map(({ d }) => d.id),
    };
  },

  /**
   * The dimensions that CONTINUE a given one, end to end.
   *
   * A section height is often not printed anywhere: it is a stack — 1500, then
   * 900, then 300 — and summing a stack is what `dimension-path` is for. But
   * finding the stack was left to guesswork off a proximity list, and three
   * live runs failed to assemble one that was sitting right there: the chain
   * DIM-098 + DIM-100 + DIM-097 joins to the millimetre and none of them
   * managed it.
   *
   * So the contiguity the resolver already computes when it JUDGES a chain is
   * exposed for READING one. It reports which dimensions touch, on which axis,
   * and their running total — geometry, measured. It does not say what the
   * span means, which member it belongs to, or where a chain ought to stop:
   * choosing the segments that answer the question remains the reader's.
   */
  getDimensionChain(ctx: ToolContext, args: { fromEvidenceId: string; maxSteps?: number }): ToolResult {
    const start = ctx.graph.dimensions.find((d) => d.id === args.fromEvidenceId);
    if (!start) return nothing(`"${args.fromEvidenceId}" is not a readable dimension on this sheet`);
    const axis = start.axis;
    if (axis !== 'x' && axis !== 'y') return nothing(`${start.id} has no clear axis, so nothing can continue it`);

    const key = axis;
    const lo = (d: typeof start): number => Math.min(d.from[key], d.to[key]);
    const hi = (d: typeof start): number => Math.max(d.from[key], d.to[key]);
    const TOL = 2;   // the same join tolerance the resolver walks with
    const sameAxis = ctx.graph.dimensions.filter((d) => d.axis === axis && d.id !== start.id);

    // walk both ways from the starting segment, taking the nearest join each step
    const walk = (dir: 'up' | 'down'): typeof start[] => {
      const chain: typeof start[] = [];
      const used = new Set<string>([start.id]);
      let edge = dir === 'up' ? hi(start) : lo(start);
      for (let step = 0; step < (args.maxSteps ?? 6); step++) {
        const next = sameAxis
          .filter((d) => !used.has(d.id))
          .filter((d) => Math.abs((dir === 'up' ? lo(d) : hi(d)) - edge) <= TOL)
          // prefer the shortest continuation, so a long dimension spanning the
          // whole stack does not swallow the segments inside it
          .sort((a, b) => (hi(a) - lo(a)) - (hi(b) - lo(b)))[0];
        if (!next) break;
        used.add(next.id);
        chain.push(next);
        edge = dir === 'up' ? hi(next) : lo(next);
      }
      return chain;
    };

    const below = walk('down').reverse();
    const above = walk('up');
    const full = [...below, start, ...above];
    if (full.length < 2) {
      return {
        ok: true,
        text: `${start.id} = ${start.valueMm} mm on axis ${axis} — nothing on this axis joins either end of it.`,
        evidenceIds: [start.id],
      };
    }
    const total = full.reduce((n, d) => n + d.valueMm, 0);
    return {
      ok: true,
      text:
        `${full.length} dimensions join end to end on axis ${axis}, starting from ${start.id}:\n` +
        full.map((d) => `  ${d.id} = ${String(d.valueMm).padStart(6)} mm` + (d.id === start.id ? '   (the one you asked about)' : '')).join('\n') +
        `\n  running total of all ${full.length}: ${total} mm\n` +
        'These touch; that is all this says. Which of them span the thing you are measuring is your reading — ' +
        'pass the ones you choose to a dimension-path, and it will verify the join again before summing.',
      evidenceIds: full.map((d) => d.id),
    };
  },

  getGeometryNear(ctx: ToolContext, args: { memberId: string; radiusMm?: number }): ToolResult {
    const m = ctx.registry.byId.get(args.memberId) ?? ctx.registry.resolve(args.memberId);
    if (!m) return nothing(`no member "${args.memberId}"`);
    const anchor = anchorOf(ctx, m);
    if (!anchor) return nothing(`${m.mark} has no positioned evidence`);
    const radius = args.radiusMm ?? 3000;
    const near = ctx.graph.nodes
      .filter((n) => n.position && n.kind !== 'panel' && dist(n.position, anchor) <= radius)
      .map((n) => ({ n, d: dist(n.position!, anchor) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 40);
    if (!near.length) return nothing(`nothing within ${radius} mm of ${m.mark}`);
    const byKind: Record<string, number> = {};
    for (const { n } of near) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    return {
      ok: true,
      text:
        `within ${radius} mm of ${m.mark}: ${JSON.stringify(byKind)}\n` +
        near.map(({ n, d }) => render(n, `${Math.round(d)} mm`)).join('\n'),
      evidenceIds: near.map(({ n }) => n.id),
    };
  },

  getRelatedEvidence(ctx: ToolContext, args: { evidenceId: string }): ToolResult {
    const n = ctx.graph.byId.get(args.evidenceId);
    if (!n) return nothing(`no evidence "${args.evidenceId}"`);
    const rels = (['carries', 'points-at', 'in-panel', 'next-in-order', 'connects-to'] as const)
      .map((rel) => ({ rel, nodes: ctx.graph.related(n.id, rel) }))
      .filter((r) => r.nodes.length);
    if (!rels.length) return nothing(`${args.evidenceId} has no recorded relationships`);
    return {
      ok: true,
      text: rels.map((r) => `${r.rel}: ${r.nodes.map((x) => x.id).join(', ')}`).join('\n'),
      evidenceIds: [n.id, ...rels.flatMap((r) => r.nodes.map((x) => x.id))],
    };
  },

  /**
   * What is known about how a member is laid out.
   *
   * RUN 006 CALLED THIS TWICE AND USED NEITHER ANSWER. The reason is visible in
   * what it used to return: a tally and a run. To turn that into a placement
   * the orchestrator still had to discover, by another route, the occurrence
   * ids a template-repeat must name, and where on the sheet the band actually
   * sits so it could LOOK at it. Neither was here. The tool stated two numbers
   * and left the whole question implicit.
   *
   * So it now returns what a placement decision actually needs: the ids, the
   * box, and the comparison stated as an open question.
   *
   * It does NOT answer that question. Whether a 24.9 m band is the whole job or
   * one template of it is a fact about the drawing, and the drawing is what
   * must settle it — by a note, a match line, a grid, a break symbol, or what
   * the layout plainly shows when looked at. Stating the arithmetic here would
   * be this file deciding engineering meaning, which is the one thing it must
   * never do.
   */
  getPlacementEvidence(ctx: ToolContext, args: { memberId: string }): ToolResult {
    const m = ctx.registry.byId.get(args.memberId) ?? ctx.registry.resolve(args.memberId);
    if (!m) return nothing(`no member "${args.memberId}"`);
    const lines: string[] = [];
    const ids: string[] = [];
    const run = ctx.userFacts.run;

    for (const b of ctx.bands) {
      const mine = b.occurrenceIds.filter((id) => m.markEvidenceIds.includes(id));
      const extent = Math.round(b.longitudinalRange[1] - b.longitudinalRange[0]);

      // The band as a box that renders — see bandViewBox for why a row of tags
      // on one line needs its view opened before it can be looked at.
      const box = bandViewBox(b, ctx.graph);
      lines.push(
        `${b.id}  axis ${b.axis}  drawn extent ${extent} mm  carries ${JSON.stringify(b.tally)}` +
          `\n    bounds {x1:${Math.round(box.x1)},y1:${Math.round(box.y1)},x2:${Math.round(box.x2)},y2:${Math.round(box.y2)}}` +
          ` — pass these to getDrawingRegionImage to SEE this layout` +
          (mine.length
            ? `\n    ${m.mark} occupies ${mine.length} node(s) here: ${mine.join(', ')}`
            : `\n    ${m.mark} does not appear in this band`),
      );
      ids.push(...mine);
    }

    if (!ctx.bands.length) return nothing('no layout bands were recovered from this sheet');

    if (!m.markEvidenceIds.length) {
      lines.push(
        `\n${m.mark} carries NO mark occurrences anywhere on this sheet. That is not the same fact` +
          ` as "it occurs once". A member drawn only in section — a wall, a coping, a panel — often` +
          ` has no repeated tag because it does not repeat: it runs. Look at how it is drawn before` +
          ` deciding between continuous, once, dependent on another member, or unknown.`,
      );
    }

    lines.push(
      run
        ? `\nthe user gave the total run as ${run.saidAs ?? `${run.mm} mm`} (${run.mm} mm).` +
          `\n\nA BAND'S DRAWN EXTENT IS NOT THE JOB. A drawn layout may be the whole job, or one` +
          ` template of a longer one, or a representative segment, or a single bay. Those produce` +
          ` very different counts from the same tags, and nothing in the geometry distinguishes` +
          ` them — only the drawing does: a match line, a break symbol, a "TYPICAL" note, a grid,` +
          ` a stated spacing, or what the layout shows when you look at it. Establish which it is,` +
          ` then choose the placement kind that says so. Do not divide one number by the other and` +
          ` call the result a count.`
        : '\nno run has been given, so any placement measured along the run cannot be resolved yet',
    );
    return { ok: true, text: lines.join('\n'), evidenceIds: ids };
  },

  getRun(ctx: ToolContext): ToolResult {
    const run = ctx.userFacts.run;
    if (!run) return nothing('no run has been supplied for this job');
    return { ok: true, text: `${run.mm} mm${run.saidAs ? ` — given as "${run.saidAs}"` : ''}`, evidenceIds: ['FACT-run'] };
  },

  getEvidence(ctx: ToolContext, args: { ids: string[] }): ToolResult {
    const found = (args.ids ?? []).map((id) => ctx.graph.byId.get(id)).filter((n): n is EvidenceNode => !!n);
    const missing = (args.ids ?? []).filter((id) => !ctx.graph.byId.get(id));
    if (!found.length) return nothing(`none of ${(args.ids ?? []).join(', ')} is evidence on this sheet`);
    return {
      ok: true,
      text:
        found.map((n) => render(n)).join('\n') +
        (missing.length ? `\n(not on this sheet: ${missing.join(', ')})` : ''),
      evidenceIds: found.map((n) => n.id),
    };
  },
} as const;

export type ToolName = keyof typeof TOOLS;

/** what the orchestrator is told it can ask for */
export const TOOL_MENU: { name: ToolName; args: string; use: string }[] = [
  { name: 'getFullDrawingImage', args: '{reason}', use: 'SEE the whole sheet — start here to orient yourself' },
  { name: 'getDrawingRegions', args: '{}', use: 'the regions the sheet separates into, and what each contains' },
  { name: 'getDrawingRegionImage', args: '{regionId | regionHint | x1,y1,x2,y2, reason}', use: 'SEE one region — by id, by hint like "the TB detail", or by bounds' },
  { name: 'getRegionOf', args: '{evidenceId}', use: 'which region a callout, mark or leader sits in' },
  { name: 'getFullDrawing', args: '{}', use: 'the whole sheet: every member, every callout, the bands and the extent' },
  { name: 'getMembers', args: '{}', use: 'every member the drawing establishes, with aliases' },
  { name: 'getDrawingRegion', args: '{x1,y1,x2,y2,page}', use: 'everything inside a box — paged, never truncated' },
  { name: 'getText', args: '{x1,y1,x2,y2}', use: 'text, callouts, marks and declarations in a box' },
  { name: 'getGeometry', args: '{x1,y1,x2,y2}', use: 'dimensions, leaders and geometry in a box' },
  { name: 'getCallouts', args: '{x1,y1,x2,y2}', use: 'callouts in a box' },
  { name: 'getLeaders', args: '{x1,y1,x2,y2}', use: 'leaders in a box' },
  { name: 'getDimensions', args: '{x1,y1,x2,y2}', use: 'dimensions in a box' },
  { name: 'getNearbyEvidence', args: '{x,y,radiusMm}', use: 'everything within a radius of a point' },
  { name: 'getRawEvidence', args: '{ids}', use: 'named nodes, verbatim' },
  { name: 'getMember', args: '{memberId}', use: 'what the sheet calls this member, its aliases and how often it is tagged' },
  { name: 'getMemberMarks', args: '{memberId}', use: 'where its tags sit, and which layout band each is in' },
  { name: 'getMemberDeclaration', args: '{memberId}', use: 'the text declaring its name and size' },
  { name: 'getCallout', args: '{calloutId}', use: 'one callout: what it parsed to, where it sits, which leader carries it' },
  { name: 'getCalloutsNear', args: '{memberId, radiusMm}', use: 'callouts within a radius, nearest first' },
  { name: 'getCalloutsInDetail', args: '{detailId}', use: 'callouts inside a named detail region' },
  { name: 'getLeadersNear', args: '{memberId, radiusMm}', use: 'leaders near a member, with what they carry and point at' },
  { name: 'getLeaderTarget', args: '{leaderId}', use: 'what one leader terminates on — the strongest ownership evidence there is' },
  { name: 'getDimensionsNear', args: '{memberId, radiusMm}', use: 'readable dimensions near a member' },
  { name: 'getDimensionChain', args: '{fromEvidenceId, maxSteps}', use: 'the dimensions that CONTINUE one, end to end — how a stacked height is found before summing it with dimension-path' },
  { name: 'getGeometryNear', args: '{memberId, radiusMm}', use: 'everything near a member, by kind' },
  { name: 'getRelatedEvidence', args: '{evidenceId}', use: 'the recorded relationships of one node' },
  { name: 'getPlacementEvidence', args: '{memberId}', use: 'how this member is laid out: the bands it occupies, its occurrence ids in each, each band\'s bounds so you can SEE it, and the run' },
  { name: 'getRun', args: '{}', use: 'the total run the user gave' },
  { name: 'getEvidence', args: '{ids}', use: 'several nodes at once' },
];

export function renderToolMenu(): string {
  return TOOL_MENU.map((t) => `  ${t.name}(${t.args}) — ${t.use}`).join('\n');
}

export interface ToolRequest {
  tool: string;
  args?: Record<string, unknown>;
}

/**
 * Run one requested tool.
 *
 * An unknown tool is refused by name rather than ignored: an orchestrator that
 * silently receives nothing for a tool it believes it called will reason from
 * an absence it cannot see.
 */
export function runTool(ctx: ToolContext, req: ToolRequest): ToolResult {
  const fn = (TOOLS as Record<string, unknown>)[req.tool];
  if (typeof fn !== 'function') {
    return nothing(`there is no tool called "${req.tool}". Available: ${TOOL_MENU.map((t) => t.name).join(', ')}`);
  }
  try {
    return (fn as (c: ToolContext, a: unknown) => ToolResult)(ctx, req.args ?? {});
  } catch (err) {
    return nothing(`${req.tool} failed: ${(err as Error).message}`);
  }
}

/** the async form — vision tools render, so a caller wanting pictures awaits */
export async function runToolAsync(ctx: ToolContext, req: ToolRequest): Promise<ToolResult> {
  const fn = (TOOLS as Record<string, unknown>)[req.tool];
  if (typeof fn !== 'function') {
    return nothing(`there is no tool called "${req.tool}". Available: ${TOOL_MENU.map((t) => t.name).join(', ')}`);
  }
  try {
    return await (fn as (c: ToolContext, a: unknown) => ToolResult | Promise<ToolResult>)(ctx, req.args ?? {});
  } catch (err) {
    return nothing(`${req.tool} failed: ${(err as Error).message}`);
  }
}
