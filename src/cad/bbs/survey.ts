// ============================================================
// STAGE 1 — the Drawing Orchestrator.
//
// WHY THE JOB SPLIT IN TWO
//
// Run 007 investigated well and finished nothing. Its trail shows why: of
// twenty-one steps, the first sixteen went on discovering how the sheet is
// arranged — which region is the SC detail, where C1's layout sits, whether the
// notes carry a repetition instruction. That work is necessary and it is not
// engineering. By the time the orchestrator knew the drawing well enough to
// schedule steel, its output budget was going entirely on reasoning and its
// replies were being truncated mid-decision.
//
// So the discovery becomes its own stage with its own budget. This file's AI
// answers ONE question:
//
//     "How is this drawing organised, and what should the next AI be shown?"
//
// It does not own callouts. It does not count anything. It does not resolve a
// dimension. It looks at the sheet, decides which areas matter, asks for the
// crops it wants, and hands on a package that makes the drawing legible.
//
// WHAT IT MAY AND MAY NOT DO
//
// The same guardrails hold as everywhere else: a member must be one the
// drawing established, an evidence id must exist, and no number may be typed.
// The one addition specific to this stage is that it MAY NOT assign ownership.
// A callout it believes belongs to C1 is recorded as a HINT with its basis, and
// stage 2 is free to disagree — because stage 1 looked at the sheet briefly and
// stage 2 will look at it properly.
//
// AMBIGUITY IS AN OUTPUT, NOT A FAILURE. An area stage 1 cannot read is
// packaged with its picture and its reason. Run 005 died asking the same
// unanswerable question nine times; the cure is to hand the question forward
// with the evidence needed to answer it, not to keep asking.
// ============================================================
import type { CadDocument } from '../types';
import type { DrawingExtract } from './types';
import { buildEvidenceGraph, type EvidenceGraph, type EvidenceNode } from './evidence';
import { buildPlacementBands, bandViewBox, type PlacementBand } from './bands';
import { buildMemberRegistry, type MemberRegistry } from './members';
import { detectRegions, renderRegions, type DrawingRegion } from './regions';
import { isImageResult, runToolAsync, type Bounds, type ToolContext, type ToolRequest } from './tools';
import { validImage, type Rasteriser } from './render';

// ------------------------------------------------------------
// the package — what stage 2 receives
// ------------------------------------------------------------

/** a picture, with enough metadata that a reader knows what it is looking at */
export interface PackagedImage {
  imageId: string;
  source: 'DXF-render';
  bounds: Bounds;
  /** the area this was taken for, when it was taken for one */
  areaId?: string;
  evidenceIds: string[];
  description: string;
  confidence: number;
  /** '' when the run had no rasteriser — the metadata still travels */
  dataUrl: string;
}

export type AreaKind =
  | 'layout'
  | 'section'
  | 'detail'
  | 'schedule'
  | 'notes'
  | 'table'
  | 'title'
  | 'unknown';

/** one meaningful part of the sheet, as stage 1 understands it */
export interface PackagedArea {
  id: string;
  label: string;
  kind: AreaKind;
  bounds: Bounds;
  imageIds: string[];
  evidenceIds: string[];
  /** canonical member ids this area is about */
  relatedMembers: string[];
  relatedCallouts: string[];
  confidence: number;
  basis: string;
}

/** the layout evidence for one member, organised but NOT concluded */
export interface PackagedPlacementEvidence {
  bandId: string;
  axis: 'x' | 'y';
  drawnExtentMm: number;
  bounds: Bounds;
  occurrenceIds: string[];
  tally: Record<string, number>;
}

export interface PackagedMember {
  memberId: string;
  mark: string;
  declaredAs?: string;
  /** areas that DRAW this member — its typical detail or section */
  detailAreaIds: string[];
  /** areas that PLACE this member — a layout or elevation */
  layoutAreaIds: string[];
  markEvidenceIds: string[];
  placementEvidence: PackagedPlacementEvidence[];
  imageIds: string[];
  unresolved: string[];
  confidence: number;
}

/**
 * A callout, located but NOT owned.
 *
 * `hintMemberId` is a pointer for stage 2 to check, never a claim. Ownership is
 * resolved once, by the ownership engine, from stage 2's evidence — and putting
 * a second path to it here is how two subsystems end up disagreeing about who
 * owns a bar.
 */
export interface PackagedCallout {
  calloutId: string;
  rawText: string;
  position?: { x: number; y: number };
  areaId?: string;
  hintMemberId?: string;
  hintBasis?: string;
  hintConfidence?: number;
  leaderIds: string[];
  imageIds: string[];
  evidenceIds: string[];
  ownership: 'unresolved';
}

/**
 * A leader and what became of the attempt to follow it.
 *
 * The distinction this type exists to preserve: "the sheet draws no arrowhead"
 * and "extraction could not resolve the arrowhead" are different facts, and
 * Run 005 spent its whole budget because the tools reported the second as the
 * first. When the target is unresolved, the visual context that would settle it
 * travels with the leader.
 */
export interface PackagedLeader {
  leaderId: string;
  carries: string[];
  /** null means extraction could not resolve it — NOT that none is drawn */
  structuredTarget: string[] | null;
  note: string;
  imageIds: string[];
}

export interface PackagedUnresolved {
  about: string;
  why: string;
  imageIds: string[];
  evidenceIds: string[];
}

export interface PackagedRelationship {
  from: string;
  to: string;
  kind: 'details' | 'places' | 'sections' | 'refers-to' | 'part-of';
  basis: string;
  confidence: number;
}

export interface DrawingUnderstandingPackage {
  drawingId: string;
  projectFacts: Record<string, { mm: number; saidAs?: string }>;
  fullDrawingImageId?: string;
  images: PackagedImage[];
  areas: PackagedArea[];
  members: PackagedMember[];
  callouts: PackagedCallout[];
  leaders: PackagedLeader[];
  relationships: PackagedRelationship[];
  unresolvedAreas: PackagedUnresolved[];
  confidence: number;
  /** how the package was produced — provenance travels with it */
  steps: number;
  toolCalls: number;
  aiCalls: number;
  notes: string[];
}

// ------------------------------------------------------------
// what stage 1 may decide
// ------------------------------------------------------------

export type SurveyDecision =
  /** this part of the sheet is a meaningful area; give it a name and a kind */
  | {
      kind: 'area';
      label: string;
      areaKind: AreaKind;
      regionId?: string;
      bounds?: Bounds;
      relatedMembers?: string[];
      relatedCallouts?: string[];
      basis: string;
    }
  /** this member is drawn here and placed there */
  | {
      kind: 'member-location';
      memberId: string;
      detailAreaIds?: string[];
      layoutAreaIds?: string[];
      unresolved?: string[];
    }
  /** a pointer for stage 2 to verify — never an assignment */
  | { kind: 'callout-hint'; calloutId: string; memberId: string; basis: string }
  | { kind: 'relationship'; from: string; to: string; relation: PackagedRelationship['kind']; basis: string }
  /** something stage 1 could not read; it travels forward with its picture */
  | { kind: 'unresolved'; about: string; why: string; areaIds?: string[]; evidenceIds?: string[] }
  | { kind: 'note'; text: string }
  | { kind: 'done'; why: string };

export interface SurveyReply {
  objective?: string;
  thinking?: string;
  requestTools?: ToolRequest[];
  decisions?: {
    decision: SurveyDecision;
    evidenceIds?: string[];
    reasoning?: string;
    confidence?: number;
  }[];
}

export interface SurveyStep {
  n: number;
  objective?: string;
  thinking?: string;
  toolCalls: { tool: string; args: unknown; ok: boolean; nodes: number; summary: string }[];
  decisions: { decision: SurveyDecision; accepted: boolean; objection?: string }[];
}

export interface SurveyOutcome {
  pkg: DrawingUnderstandingPackage;
  steps: SurveyStep[];
  aiCalls: number;
  toolCalls: number;
  toolsRequested: string[];
  imagesRendered: number;
  repeatsBlocked: number;
}

// ------------------------------------------------------------

export const SURVEY_SYSTEM = `You are a senior structural engineer doing a FIRST READ of one reinforcement drawing.

You are not producing a bar bending schedule. Another engineer will do that, working only from what you hand them. Your job is to make this drawing legible to them.

The question you are answering is:

    "How is this sheet organised, and what should the next engineer be shown?"

## WHAT A GOOD PACKAGE CONTAINS

  every meaningful area of the sheet, named and classified
  which area DRAWS each member (its typical detail or section)
  which area PLACES each member (its layout, elevation or plan)
  crops worth looking at, and what each one shows
  how areas relate to one another
  what you could not read, with the picture that would settle it

## WHAT YOU DO NOT DO

You do NOT assign a callout to a member. You may record a HINT with its basis, and the next engineer will check it — but ownership is decided once, later, from better evidence than a first read.

You do NOT count anything. You do NOT state a dimension, a spacing, a quantity or a weight. You do NOT decide how a member repeats.

If you see a layout measuring some length while the job runs longer, that is EVIDENCE worth packaging — the bounds, the marks, the picture. It is not a conclusion. Whether a drawn layout is the whole job, one template of it, or a representative segment is exactly the kind of question the next engineer must settle, and pre-empting it with arithmetic would mislead them.

## AMBIGUITY IS AN ANSWER

If a structured tool returns nothing, that means EXTRACTION could not resolve the relationship — not that the drawing lacks it. The line is almost certainly drawn. Do not ask the same failed question twice. Ask for a picture of that area instead, and package it as unresolved with the crop attached.

An area you cannot read, handed on with its picture and your reason, is worth more than a guess.

## HOW TO WORK

Start by looking at the whole sheet, then at how it divides. Decide which parts matter. Ask for the crops you want — several at once, since they are independent. If a crop is too tight to show what connects to what, ask for a wider one. If it is too busy, ask for a tighter one.

You have few turns. Spend them on structure, not on detail.

## THE TOOLS

{{TOOLS}}

## HOW YOU ANSWER

One json object each turn. Request evidence, record decisions, or both:

{"objective":"learn how the sheet divides",
 "thinking":"the full view first, then the region list",
 "requestTools":[{"tool":"getFullDrawingImage","args":{"reason":"orient"}},{"tool":"getDrawingRegions","args":{}}],
 "decisions":[]}

{"objective":"name the details I can see",
 "decisions":[
   {"decision":{"kind":"area","label":"SC typical detail","areaKind":"detail","regionId":"REGION-07",
     "relatedMembers":["MEM-01"],"basis":"its caption declares it and the section is drawn inside it"},
    "evidenceIds":["REGION-07"],"reasoning":"captioned detail","confidence":0.9},
   {"decision":{"kind":"member-location","memberId":"MEM-01","detailAreaIds":["AREA-01"],"layoutAreaIds":["AREA-05"]},
    "evidenceIds":[],"reasoning":"drawn in the detail, tagged along the layout","confidence":0.85}]}

Decision kinds:
  area             — a meaningful part of the sheet. Give it by regionId OR by bounds {x1,y1,x2,y2}.
                     areaKind: layout · section · detail · schedule · notes · table · title · unknown
  member-location  — where a member is DRAWN (detailAreaIds) and where it is PLACED (layoutAreaIds)
  callout-hint     — a pointer for the next engineer to CHECK. Not an assignment.
  relationship     — details · places · sections · refers-to · part-of
  unresolved       — you looked and could not read it; name the areas that show it
  note             — something the next engineer should know
  done             — the sheet is mapped

Areas are numbered AREA-01, AREA-02 … in the order you declare them. Refer to them by those ids afterwards.

## THE RULES THAT ARE CHECKED

Members come from the sheet; getMembers() lists them and you cannot create one. Every evidence id you cite must be one a tool returned to you. An area must resolve to a real region or real bounds. A decision breaking one of these comes back as an objection naming the reason — fix it and continue.

Say how sure you are. A caption you read is strong. A detail you inferred from position alone is not. Never raise confidence because no better evidence exists.`;

export interface SurveyOptions {
  doc: CadDocument;
  extract: DrawingExtract;
  projectFacts?: Record<string, { mm: number; saidAs?: string }>;
  ask(args: {
    system: string;
    prompt: string;
    images: { dataUrl: string; caption: string }[];
    step: number;
  }): Promise<Record<string, unknown> | null>;
  rasterise?: Rasteriser;
  /** small on purpose — this stage decomposes, it does not solve */
  maxSteps?: number;
  maxToolCalls?: number;
  maxMs?: number;
  now?: () => number;
  onStep?: (s: SurveyStep) => void;
  /** prebuilt graph/registry, when the caller already has them */
  graph?: EvidenceGraph;
  registry?: MemberRegistry;
  bands?: readonly PlacementBand[];
  regions?: readonly DrawingRegion[];
}

const MAX_STEPS = 8;
const MAX_TOOL_CALLS = 48;
/** generous, because independent crops SHOULD be asked for together */
const MAX_TOOLS_PER_STEP = 10;

export async function runSurvey(opts: SurveyOptions): Promise<SurveyOutcome> {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const maxToolCalls = opts.maxToolCalls ?? MAX_TOOL_CALLS;
  const maxMs = opts.maxMs ?? 15 * 60 * 1000;

  const graph = opts.graph ?? buildEvidenceGraph(opts.doc, opts.extract);
  const bands = opts.bands ?? buildPlacementBands(graph).bands;
  const registry = opts.registry ?? buildMemberRegistry(opts.extract, graph);
  const regions = opts.regions ?? detectRegions(graph).regions;
  const projectFacts = { ...(opts.projectFacts ?? {}) };

  const toolCtx: ToolContext = {
    graph,
    registry,
    bands,
    userFacts: projectFacts,
    doc: opts.doc,
    regions,
    rasterise: opts.rasterise,
  };

  const calloutNodes = graph.nodes.filter((n) => n.kind === 'callout');
  const leaderNodes = graph.nodes.filter((n) => n.kind === 'leader');

  // ---- what stage 1 accumulates ----
  const images: PackagedImage[] = [];
  const areas: PackagedArea[] = [];
  const relationships: PackagedRelationship[] = [];
  const unresolvedAreas: PackagedUnresolved[] = [];
  const notes: string[] = [];
  const memberDetail = new Map<string, Set<string>>();
  const memberLayout = new Map<string, Set<string>>();
  const memberUnresolved = new Map<string, string[]>();
  const memberConfidence = new Map<string, number>();
  const calloutHints = new Map<string, { memberId: string; basis: string; confidence: number }>();
  const confidences: number[] = [];

  const steps: SurveyStep[] = [];
  const toolsRequested: string[] = [];
  let toolCalls = 0;
  let aiCalls = 0;
  let repeatsBlocked = 0;
  let finished = false;
  let fullDrawingImageId: string | undefined;
  let pendingImages: { dataUrl: string; caption: string }[] = [];

  const tried = new Map<string, { ok: boolean }>();
  const signature = (req: ToolRequest): string =>
    `${req.tool}(${JSON.stringify(req.args ?? {}, Object.keys(req.args ?? {}).sort())})`;

  const transcript: string[] = [
    'FIRST READ of a reinforcement drawing.',
    `DRAWING: ${opts.extract.drawingName}`,
    projectFacts.run
      ? `PROJECT RUN: ${projectFacts.run.mm} mm${projectFacts.run.saidAs ? ` (${projectFacts.run.saidAs})` : ''} — a project fact, not a drawn length`
      : 'PROJECT RUN: not supplied',
    '',
    `The sheet establishes ${registry.members.length} member(s): ${registry.members
      .map((m) => `${m.id} "${m.mark}"`)
      .join(', ')}`,
    `It carries ${calloutNodes.length} reinforcement callout(s), ${leaderNodes.length} leader(s) and ${graph.dimensions.length} readable dimension(s).`,
    `${regions.length} region(s) separated by whitespace, and ${bands.length} layout band(s) of repeated marks.`,
    '',
    'Map it.',
  ];

  const nextAreaId = (): string => `AREA-${String(areas.length + 1).padStart(2, '0')}`;
  const nextImageId = (): string => `IMG-${String(images.length + 1).padStart(2, '0')}`;

  for (let n = 1; n <= maxSteps && !finished; n++) {
    if (now() - startedAt > maxMs) break;

    const mapped = areas.length
      ? areas
          .map(
            (a) =>
              `  ${a.id} ${a.kind} "${a.label}"` +
              (a.relatedMembers.length ? ` → ${a.relatedMembers.join(', ')}` : '') +
              ` [${a.imageIds.join(', ') || 'no image'}]`,
          )
          .join('\n')
      : '  (nothing mapped yet)';

    const unmapped = registry.members.filter(
      (m) => !(memberDetail.get(m.id)?.size || memberLayout.get(m.id)?.size),
    );

    const stateBlock = [
      '',
      'AREAS YOU HAVE MAPPED',
      mapped,
      unmapped.length
        ? `\nMEMBERS NOT YET PLACED IN ANY AREA\n  ${unmapped.map((m) => `${m.id} "${m.mark}"`).join(', ')}`
        : '',
      tried.size
        ? '\nalready requested — do not repeat one that returned nothing, change source:\n' +
          [...tried.entries()].map(([sig, v]) => `  ${v.ok ? 'ok  ' : 'NONE'} ${sig}`).join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const stepImages = pendingImages;
    pendingImages = [];
    aiCalls++;
    const reply = (await opts.ask({
      system: SURVEY_SYSTEM.replace('{{TOOLS}}', surveyToolMenu()),
      prompt:
        `${transcript.join('\n')}\n${stateBlock}\n\n` +
        `Step ${n} of ${maxSteps}. ${toolCalls}/${maxToolCalls} tool calls used.` +
        (stepImages.length ? `\n${stepImages.length} image(s) from your last request are attached.` : ''),
      images: stepImages,
      step: n,
    })) as SurveyReply | null;

    const step: SurveyStep = { n, toolCalls: [], decisions: [] };
    if (!reply) {
      steps.push(step);
      opts.onStep?.(step);
      transcript.push('', `--- step ${n}: no reply ---`);
      continue;
    }
    step.objective = reply.objective;
    step.thinking = reply.thinking;
    transcript.push('', `--- step ${n} ---`);
    if (reply.objective) transcript.push(`objective: ${reply.objective}`);

    // ---- evidence ----
    for (const req of (reply.requestTools ?? []).slice(0, MAX_TOOLS_PER_STEP)) {
      if (toolCalls >= maxToolCalls) {
        transcript.push('(tool budget exhausted — map with what you have)');
        break;
      }
      const sig = signature(req);
      const prior = tried.get(sig);
      if (prior && !prior.ok) {
        repeatsBlocked++;
        transcript.push(
          `${sig}: REFUSED — you already asked this and it returned nothing. Extraction cannot ` +
            'resolve it. Ask for a picture of that area instead.',
        );
        step.toolCalls.push({ tool: req.tool, args: req.args, ok: false, nodes: 0, summary: 'refused — already tried' });
        continue;
      }

      toolCalls++;
      toolsRequested.push(req.tool);
      const res = await runToolAsync(toolCtx, req);
      tried.set(sig, { ok: res.ok });

      if (isImageResult(res) && validImage(res.image)) {
        const id = nextImageId();
        images.push({
          imageId: id,
          source: 'DXF-render',
          bounds: res.region,
          evidenceIds: res.evidenceIds,
          description: String(req.args?.reason ?? res.text.split('\n')[0] ?? 'a crop'),
          confidence: 1,
          dataUrl: res.image,
        });
        if (req.tool === 'getFullDrawingImage' && !fullDrawingImageId) fullDrawingImageId = id;
        pendingImages.push({ dataUrl: res.image, caption: `${id} — ${res.text.split('\n')[0]}` });
        transcript.push(`${req.tool}(${JSON.stringify(req.args ?? {})}) → ${id}:`, res.text.slice(0, 3000));
      } else {
        transcript.push(`${req.tool}(${JSON.stringify(req.args ?? {})}):`, res.text.slice(0, 3000));
      }
      step.toolCalls.push({
        tool: req.tool,
        args: req.args,
        ok: res.ok,
        nodes: res.evidenceIds.length,
        summary: res.text.slice(0, 120),
      });
    }

    // ---- decisions ----
    for (const item of reply.decisions ?? []) {
      let v: { ok: boolean; objection?: string };
      try {
        v = applyDecision(item?.decision as SurveyDecision, item?.evidenceIds ?? [], item?.confidence) ??
          { ok: false, objection: 'that decision could not be read at all — send one of the documented kinds' };
      } catch (err) {
        v = { ok: false, objection: `that decision could not be applied — ${(err as Error).message}` };
      }
      step.decisions.push({ decision: item?.decision, accepted: v.ok, objection: v.objection });
      if (v.ok) {
        if (typeof item.confidence === 'number') confidences.push(item.confidence);
        transcript.push(`accepted: ${JSON.stringify(item.decision).slice(0, 140)}`);
        if (item.decision?.kind === 'done') finished = true;
      } else {
        transcript.push(`REFUSED ${JSON.stringify(item.decision).slice(0, 120)} — ${v.objection}`);
      }
    }

    steps.push(step);
    opts.onStep?.(step);
  }

  // ------------------------------------------------------------
  // assemble the package
  // ------------------------------------------------------------

  /** an image whose box contains a point, so evidence inherits the crop showing it */
  const imagesCovering = (p?: { x: number; y: number }): string[] => {
    if (!p) return [];
    return images
      .filter(
        (im) =>
          p.x >= Math.min(im.bounds.x1, im.bounds.x2) &&
          p.x <= Math.max(im.bounds.x1, im.bounds.x2) &&
          p.y >= Math.min(im.bounds.y1, im.bounds.y2) &&
          p.y <= Math.max(im.bounds.y1, im.bounds.y2),
      )
      .map((im) => im.imageId);
  };

  const areaOfPoint = (p?: { x: number; y: number }): string | undefined => {
    if (!p) return undefined;
    // the smallest area containing it — a detail inside a layout wins
    let best: PackagedArea | undefined;
    let bestSize = Infinity;
    for (const a of areas) {
      const w = Math.abs(a.bounds.x2 - a.bounds.x1);
      const h = Math.abs(a.bounds.y2 - a.bounds.y1);
      if (
        p.x >= Math.min(a.bounds.x1, a.bounds.x2) &&
        p.x <= Math.max(a.bounds.x1, a.bounds.x2) &&
        p.y >= Math.min(a.bounds.y1, a.bounds.y2) &&
        p.y <= Math.max(a.bounds.y1, a.bounds.y2) &&
        w * h < bestSize
      ) {
        best = a;
        bestSize = w * h;
      }
    }
    return best?.id;
  };

  const members: PackagedMember[] = registry.members.map((m) => {
    const placement: PackagedPlacementEvidence[] = bands
      .map((b) => {
        const mine = b.occurrenceIds.filter((id) => m.markEvidenceIds.includes(id));
        if (!mine.length) return null;
        const box: Bounds = bandViewBox(b, graph);
        return {
          bandId: b.id,
          axis: b.axis,
          drawnExtentMm: Math.round(b.longitudinalRange[1] - b.longitudinalRange[0]),
          bounds: box,
          occurrenceIds: mine,
          tally: b.tally,
        };
      })
      .filter((x): x is PackagedPlacementEvidence => !!x);

    const detailIds = [...(memberDetail.get(m.id) ?? [])];
    const layoutIds = [...(memberLayout.get(m.id) ?? [])];
    const imgs = new Set<string>();
    for (const aid of [...detailIds, ...layoutIds]) {
      const a = areas.find((x) => x.id === aid);
      for (const i of a?.imageIds ?? []) imgs.add(i);
    }
    for (const id of m.markEvidenceIds.slice(0, 4)) {
      for (const i of imagesCovering(graph.byId.get(id)?.position)) imgs.add(i);
    }

    return {
      memberId: m.id,
      mark: m.mark,
      declaredAs: m.declaredAs,
      detailAreaIds: detailIds,
      layoutAreaIds: layoutIds,
      markEvidenceIds: m.markEvidenceIds,
      placementEvidence: placement,
      imageIds: [...imgs],
      unresolved: memberUnresolved.get(m.id) ?? [],
      confidence: memberConfidence.get(m.id) ?? (detailIds.length || layoutIds.length ? 0.6 : 0),
    };
  });

  const callouts: PackagedCallout[] = calloutNodes.map((n) => {
    const carriers = leaderNodes
      .filter((l) => graph.related(l.id, 'carries').some((c) => c.id === n.id))
      .map((l) => l.id);
    const hint = calloutHints.get(n.id);
    return {
      calloutId: n.id,
      rawText: n.rawText ?? '',
      position: n.position,
      areaId: areaOfPoint(n.position),
      hintMemberId: hint?.memberId,
      hintBasis: hint?.basis,
      hintConfidence: hint?.confidence,
      leaderIds: carriers,
      imageIds: imagesCovering(n.position),
      evidenceIds: [n.id, ...carriers],
      ownership: 'unresolved',
    };
  });

  const leaders: PackagedLeader[] = leaderNodes.map((l) => {
    const targets = graph.related(l.id, 'points-at').map((t) => t.id);
    const carries = graph.related(l.id, 'carries').map((c) => c.id);
    return {
      leaderId: l.id,
      carries,
      structuredTarget: targets.length ? targets : null,
      note: targets.length
        ? 'extraction resolved this leader'
        : 'structured extraction did not resolve the target — the arrowhead is almost certainly drawn; read it from a crop',
      imageIds: imagesCovering(l.position),
    };
  });

  const pkg: DrawingUnderstandingPackage = {
    drawingId: opts.extract.drawingName,
    projectFacts,
    fullDrawingImageId,
    images,
    areas,
    members,
    callouts,
    leaders,
    relationships,
    unresolvedAreas,
    confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0,
    steps: steps.length,
    toolCalls,
    aiCalls,
    notes,
  };

  return {
    pkg,
    steps,
    aiCalls,
    toolCalls,
    toolsRequested,
    imagesRendered: images.length,
    repeatsBlocked,
  };

  // ----------------------------------------------------------

  function applyDecision(
    d: SurveyDecision,
    evidenceIds: string[],
    confidence?: number,
  ): { ok: boolean; objection?: string } {
    const bogus = evidenceIds.filter(
      (id) =>
        !graph.byId.has(id) &&
        !regions.some((r) => r.id === id) &&
        !bands.some((b) => b.id === id) &&
        !areas.some((a) => a.id === id) &&
        !images.some((im) => im.imageId === id) &&
        !id.startsWith('FACT-'),
    );
    if (bogus.length) {
      return { ok: false, objection: `${bogus.join(', ')} — not evidence on this sheet. Cite only ids a tool returned.` };
    }

    // EVERY AREA-xx MENTIONED ANYWHERE MUST BE ONE THAT EXISTS.
    //
    // Run 008 sent `{"kind":"unresolved","areas":["AREA-10"],…}` — the ids were
    // never checked, because the contract's field is `areaIds` and nothing
    // looked at `areas`. AREA-10 and AREA-11 had never been declared. A
    // reference to an area that does not exist is not a small thing: stage 2 is
    // told to crop it, finds nothing, and spends turns on a place that is not
    // there. So the whole decision is swept, whatever key the id arrived under.
    const declared = new Set(areas.map((a) => a.id));
    const mentioned = new Set<string>();
    const sweep = (v: unknown): void => {
      if (typeof v === 'string') {
        if (/^AREA-\d+$/.test(v)) mentioned.add(v);
      } else if (Array.isArray(v)) v.forEach(sweep);
      else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(sweep);
    };
    sweep(d);
    const ghosts = [...mentioned].filter((id) => !declared.has(id));
    if (ghosts.length) {
      return {
        ok: false,
        objection:
          `${ghosts.join(', ')} ${ghosts.length === 1 ? 'is not an area' : 'are not areas'} you have declared. ` +
          `Declared so far: ${declared.size ? [...declared].join(', ') : 'none'}. Declare it with an "area" ` +
          'decision first (giving a regionId or bounds), or refer to one of the above.',
      };
    }

    switch (d.kind) {
      case 'done':
        return { ok: true };

      // A NOTE WITH NO TEXT IS NOT A NOTE.
      //
      // Run 008 sent `{"kind":"note","note":"Sheet is a long multi-band strip…"}`
      // — the text was under `note`, the contract reads `text`, and the briefing
      // handed to stage 2 therefore contained the literal word "undefined". A
      // field that is absent is refused by name rather than stringified.
      case 'note': {
        if (typeof d.text !== 'string' || !d.text.trim()) {
          return { ok: false, objection: 'a note needs its wording in "text" — {"kind":"note","text":"…"}' };
        }
        notes.push(d.text.trim());
        return { ok: true };
      }

      case 'area': {
        let bounds: Bounds | null = null;
        let evidence: string[] = [];
        if (d.regionId) {
          const r = regions.find((x) => x.id === d.regionId);
          if (!r) return { ok: false, objection: `no region "${d.regionId}"; call getDrawingRegions first` };
          bounds = r.bounds;
          evidence = r.evidenceIds;
        } else if (d.bounds && [d.bounds.x1, d.bounds.y1, d.bounds.x2, d.bounds.y2].every((v) => typeof v === 'number')) {
          bounds = d.bounds;
          const lo = { x: Math.min(bounds.x1, bounds.x2), y: Math.min(bounds.y1, bounds.y2) };
          const hi = { x: Math.max(bounds.x1, bounds.x2), y: Math.max(bounds.y1, bounds.y2) };
          evidence = graph.nodes
            .filter((nd) => nd.position && nd.position.x >= lo.x && nd.position.x <= hi.x && nd.position.y >= lo.y && nd.position.y <= hi.y)
            .map((nd) => nd.id);
        } else {
          return { ok: false, objection: 'an area needs a regionId or bounds {x1,y1,x2,y2}' };
        }
        if (Math.abs(bounds.x2 - bounds.x1) <= 0 || Math.abs(bounds.y2 - bounds.y1) <= 0) {
          return { ok: false, objection: 'that area has no extent — a zero-width or zero-height box shows nothing' };
        }

        const relatedMembers: string[] = [];
        for (const raw of d.relatedMembers ?? []) {
          const m = registry.byId.get(raw) ?? registry.resolve(raw);
          if (!m) {
            return {
              ok: false,
              objection: `"${raw}" is not a member of this drawing — members come from the sheet. Use getMembers().`,
            };
          }
          relatedMembers.push(m.id);
        }
        const relatedCallouts = (d.relatedCallouts ?? []).filter((c) => graph.byId.get(c)?.kind === 'callout');

        const id = nextAreaId();
        const covering = images.filter((im) => overlaps(im.bounds, bounds!)).map((im) => im.imageId);
        areas.push({
          id,
          label: d.label || id,
          kind: d.areaKind,
          bounds,
          imageIds: covering,
          evidenceIds: evidence,
          relatedMembers,
          relatedCallouts,
          confidence: confidence ?? 0.5,
          basis: d.basis || 'not stated',
        });
        for (const im of images) if (overlaps(im.bounds, bounds)) im.areaId = im.areaId ?? id;
        return { ok: true };
      }

      case 'member-location': {
        const m = registry.byId.get(d.memberId) ?? registry.resolve(d.memberId);
        if (!m) return { ok: false, objection: `"${d.memberId}" is not a member of this drawing` };
        const check = (ids: string[] | undefined, into: Map<string, Set<string>>): string | null => {
          for (const aid of ids ?? []) {
            if (!areas.some((a) => a.id === aid)) return `"${aid}" is not an area you have declared`;
            const s = into.get(m.id) ?? new Set<string>();
            s.add(aid);
            into.set(m.id, s);
          }
          return null;
        };
        const e1 = check(d.detailAreaIds, memberDetail);
        if (e1) return { ok: false, objection: e1 };
        const e2 = check(d.layoutAreaIds, memberLayout);
        if (e2) return { ok: false, objection: e2 };
        if (d.unresolved?.length) {
          memberUnresolved.set(m.id, [...(memberUnresolved.get(m.id) ?? []), ...d.unresolved]);
        }
        if (typeof confidence === 'number') memberConfidence.set(m.id, confidence);
        return { ok: true };
      }

      case 'callout-hint': {
        if (graph.byId.get(d.calloutId)?.kind !== 'callout') {
          return { ok: false, objection: `${d.calloutId} is not a callout on this sheet` };
        }
        const m = registry.byId.get(d.memberId) ?? registry.resolve(d.memberId);
        if (!m) return { ok: false, objection: `"${d.memberId}" is not a member of this drawing` };
        calloutHints.set(d.calloutId, { memberId: m.id, basis: d.basis || 'not stated', confidence: confidence ?? 0.5 });
        return { ok: true };
      }

      case 'relationship': {
        const known = (id: string): boolean =>
          areas.some((a) => a.id === id) ||
          !!registry.byId.get(id) ||
          graph.byId.has(id) ||
          bands.some((b) => b.id === id);
        if (!known(d.from) || !known(d.to)) {
          return { ok: false, objection: 'a relationship must join two things that exist — an area, a member, a band or an evidence id' };
        }
        relationships.push({
          from: d.from,
          to: d.to,
          kind: d.relation,
          basis: d.basis || 'not stated',
          confidence: confidence ?? 0.5,
        });
        return { ok: true };
      }

      // AN UNRESOLVED ITEM IS THE MOST VALUABLE THING THIS STAGE PRODUCES —
      // it is the question stage 2 must answer — so it may not arrive empty.
      // Run 008 recorded four of these and every one reached the briefing as
      // "undefined — undefined", which told the next stage nothing at all.
      case 'unresolved': {
        const about = typeof d.about === 'string' ? d.about.trim() : '';
        const why = typeof d.why === 'string' ? d.why.trim() : '';
        if (!about || !why) {
          return {
            ok: false,
            objection:
              'an unresolved item needs "about" (what is unsettled) and "why" (what you looked at and ' +
              'why it did not settle it) — {"kind":"unresolved","about":"…","why":"…","areaIds":["AREA-01"]}',
          };
        }
        // the sweep above already proved every AREA-xx here exists
        const imgIds = new Set<string>();
        for (const aid of d.areaIds ?? []) {
          for (const i of areas.find((x) => x.id === aid)?.imageIds ?? []) imgIds.add(i);
        }
        unresolvedAreas.push({
          about,
          why,
          imageIds: [...imgIds],
          evidenceIds: [...(d.evidenceIds ?? []), ...evidenceIds],
        });
        return { ok: true };
      }

      // as in stage 2: an unrecognised kind is refused, never dropped and never
      // allowed to return undefined into a caller that will read `.ok` on it
      default: {
        const bad = d as { kind?: unknown };
        const kind = typeof bad.kind === 'string' ? bad.kind : JSON.stringify(bad.kind);
        return {
          ok: false,
          objection:
            `"${kind}" is not a decision kind for a first read. Use one of: area, member-location, ` +
            'callout-hint, relationship, unresolved, note, done.',
        };
      }
    }
  }
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return (
    Math.min(a.x1, a.x2) <= Math.max(b.x1, b.x2) &&
    Math.max(a.x1, a.x2) >= Math.min(b.x1, b.x2) &&
    Math.min(a.y1, a.y2) <= Math.max(b.y1, b.y2) &&
    Math.max(a.y1, a.y2) >= Math.min(b.y1, b.y2)
  );
}

/** the subset of tools a first read needs — structure, not reinforcement detail */
function surveyToolMenu(): string {
  return [
    '  getFullDrawingImage({reason}) — SEE the whole sheet; start here',
    '  getDrawingRegions({}) — how the sheet separates, and what each part holds',
    '  getDrawingRegionImage({regionId | regionHint | x1,y1,x2,y2, reason}) — SEE one area',
    '  getRegionOf({evidenceId}) — which region something sits in',
    '  getMembers({}) — every member the sheet establishes',
    '  getMemberMarks({memberId}) — where a member is tagged, and in which band',
    '  getMemberDeclaration({memberId}) — the text naming and sizing it',
    '  getPlacementEvidence({memberId}) — the layout bands it occupies, with bounds you can crop',
    '  getText({x1,y1,x2,y2}) — text, callouts, marks and captions in a box',
    '  getCallouts({x1,y1,x2,y2}) — callouts in a box',
    '  getLeaders({x1,y1,x2,y2}) — leaders in a box',
    '  getNearbyEvidence({x,y,radiusMm}) — everything near a point',
    '  getFullDrawing({}) — the whole inventory, if you want it at once',
  ].join('\n');
}

// ------------------------------------------------------------
// rendering the package for stage 2
// ------------------------------------------------------------

/**
 * The package as stage 2 reads it.
 *
 * Deliberately a MAP rather than a dump. Handing the next stage 286 evidence
 * nodes reproduces the problem this architecture exists to solve — it would
 * have to rediscover the structure to use them. What travels is the shape of
 * the sheet and the ids needed to ask for more.
 */
export function renderPackage(pkg: DrawingUnderstandingPackage): string {
  const L: string[] = [];
  L.push('A FIRST READ OF THIS DRAWING HAS ALREADY BEEN DONE. Its findings follow.');
  L.push('Use them as your starting point — you need not rediscover where things are.');
  L.push('You may disagree with any of it; it was a first read, and you can look again.');
  L.push('');

  if (pkg.projectFacts.run) {
    L.push(
      `PROJECT RUN: ${pkg.projectFacts.run.mm} mm` +
        (pkg.projectFacts.run.saidAs ? ` (${pkg.projectFacts.run.saidAs})` : '') +
        ' — a project fact. It is NOT a length measured on the sheet.',
    );
    L.push('');
  }

  L.push(`AREAS OF THE SHEET (${pkg.areas.length})`);
  if (!pkg.areas.length) L.push('  (the first read mapped none — you are starting cold)');
  for (const a of pkg.areas) {
    L.push(
      `  ${a.id}  ${a.kind}  "${a.label}"  {x1:${Math.round(a.bounds.x1)},y1:${Math.round(a.bounds.y1)},` +
        `x2:${Math.round(a.bounds.x2)},y2:${Math.round(a.bounds.y2)}}`,
    );
    L.push(
      `      ${a.relatedMembers.length ? `about ${a.relatedMembers.join(', ')}; ` : ''}` +
        `${a.evidenceIds.length} node(s)${a.imageIds.length ? `; images ${a.imageIds.join(', ')}` : ''}` +
        `  (confidence ${a.confidence})`,
    );
    if (a.basis) L.push(`      basis: ${a.basis}`);
  }
  L.push('');

  L.push(`MEMBERS (${pkg.members.length})`);
  for (const m of pkg.members) {
    L.push(`  ${m.memberId} "${m.mark}"${m.declaredAs ? ` — declared "${m.declaredAs}"` : ''}`);
    if (m.detailAreaIds.length) L.push(`      drawn in: ${m.detailAreaIds.join(', ')}`);
    if (m.layoutAreaIds.length) L.push(`      placed in: ${m.layoutAreaIds.join(', ')}`);
    L.push(`      tagged ${m.markEvidenceIds.length}×`);
    for (const p of m.placementEvidence) {
      L.push(
        `      ${p.bandId} axis ${p.axis} drawn extent ${p.drawnExtentMm} mm carries ${JSON.stringify(p.tally)}` +
          ` — ${m.mark} at ${p.occurrenceIds.length} node(s): ${p.occurrenceIds.join(', ')}`,
      );
      L.push(
        `          bounds {x1:${Math.round(p.bounds.x1)},y1:${Math.round(p.bounds.y1)},` +
          `x2:${Math.round(p.bounds.x2)},y2:${Math.round(p.bounds.y2)}} — crop this to see the layout`,
      );
    }
    if (!m.placementEvidence.length) L.push('      no layout band carries this member');
    for (const u of m.unresolved) L.push(`      UNRESOLVED: ${u}`);
  }
  L.push('');

  const hinted = pkg.callouts.filter((c) => c.hintMemberId);
  L.push(`CALLOUTS (${pkg.callouts.length}) — NONE are owned; ownership is yours to decide`);
  if (hinted.length) {
    L.push(`  the first read suggested ${hinted.length} pointer(s) worth CHECKING, not accepting:`);
    for (const c of hinted) {
      L.push(`    ${c.calloutId} "${c.rawText.slice(0, 40)}" → maybe ${c.hintMemberId} (${c.hintBasis}, ${c.hintConfidence})`);
    }
  }
  const byArea = new Map<string, string[]>();
  for (const c of pkg.callouts) {
    const k = c.areaId ?? '(no mapped area)';
    byArea.set(k, [...(byArea.get(k) ?? []), c.calloutId]);
  }
  for (const [k, ids] of byArea) L.push(`  ${k}: ${ids.join(', ')}`);
  L.push('');

  const unresolvedLeaders = pkg.leaders.filter((l) => l.structuredTarget === null);
  if (unresolvedLeaders.length) {
    L.push(
      `LEADERS: ${pkg.leaders.length} on the sheet, and extraction resolved the target of ` +
        `${pkg.leaders.length - unresolvedLeaders.length}. For the other ${unresolvedLeaders.length} the arrowhead ` +
        'is drawn but did not survive parsing — asking a tool for those targets will keep returning nothing. Read them from a crop.',
    );
    L.push('');
  }

  if (pkg.unresolvedAreas.length) {
    L.push(`LEFT UNRESOLVED BY THE FIRST READ (${pkg.unresolvedAreas.length})`);
    for (const u of pkg.unresolvedAreas) {
      L.push(`  ${u.about} — ${u.why}${u.imageIds.length ? ` [see ${u.imageIds.join(', ')}]` : ''}`);
    }
    L.push('');
  }

  if (pkg.notes.length) {
    L.push('NOTES FROM THE FIRST READ');
    for (const t of pkg.notes) L.push(`  ${t}`);
    L.push('');
  }

  L.push(
    `The first read used ${pkg.steps} step(s) and ${pkg.toolCalls} tool call(s); its average confidence was ` +
      `${pkg.confidence.toFixed(2)}. Treat it as a briefing, not as evidence: cite the drawing's own ids.`,
  );
  return L.join('\n');
}

/** the pictures worth putting in front of stage 2 on its first turn */
export function packageImages(
  pkg: DrawingUnderstandingPackage,
  limit = 6,
): { dataUrl: string; caption: string }[] {
  const out: { dataUrl: string; caption: string }[] = [];
  const full = pkg.images.find((i) => i.imageId === pkg.fullDrawingImageId);
  if (full && validImage(full.dataUrl)) out.push({ dataUrl: full.dataUrl, caption: `${full.imageId} — the whole sheet` });
  for (const im of pkg.images) {
    if (out.length >= limit) break;
    if (im.imageId === pkg.fullDrawingImageId || !validImage(im.dataUrl)) continue;
    const area = pkg.areas.find((a) => a.id === im.areaId);
    out.push({
      dataUrl: im.dataUrl,
      caption: `${im.imageId}${area ? ` — ${area.id} "${area.label}"` : ''} — ${im.description}`.slice(0, 160),
    });
  }
  return out;
}

/** a node's position, for callers assembling their own crops */
export function nodePosition(graph: EvidenceGraph, id: string): EvidenceNode['position'] {
  return graph.byId.get(id)?.position;
}
