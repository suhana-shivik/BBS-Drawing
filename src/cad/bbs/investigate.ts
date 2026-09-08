// ============================================================
// The investigating orchestrator.
//
// WHAT RUN 004 SHOWED
//
// The fixed-pass orchestrator refused ninety claims. Its candidate lists were
// decided in advance, proximity-only, and TB's nearest offer sat 12,068 mm away
// in another detail. The model, reading the evidence block, kept naming
// callouts that plainly belonged to TB — and every one was rejected as
// "unprompted". Both halves behaved correctly and the result was zero rows.
//
// The missing capability is not another pass. It is the ability to ask WHY:
//
//     "the model says CALL-020 is TB's. Was it offered? No.
//      So — what does CALL-020's leader terminate on?
//      What sits within 500 mm of it?
//      Does that support TB, or another member, or neither?"
//
// That is an investigation, and it needs a controller that can request
// evidence, read it, change its mind, and stop.
//
// WHAT THIS DOES NOT CHANGE
//
// The orchestrator PROPOSES. Deterministic code disposes. Every proposal is
// validated against the same rules that already hold — canonical identity,
// exclusive ownership, pointer-only dimensions — and a proposal that fails is
// returned to the loop as an objection, not written anyway. The controller has
// no path to the ledger, to a draft, or to a number.
//
// BOUNDED. A fixed number of investigations, then the objective is recorded
// unresolved. An agent that cannot terminate is worse than one that admits it
// did not get there.
// ============================================================
import { renderToolMenu, runTool, type ToolContext, type ToolRequest, type ToolResult } from './tools';
import { isBarType } from './contract';
import type { OwnershipClaim, OwnershipBasis } from './ownership';
import type { MemberRegistry } from './members';

// ------------------------------------------------------------
// what the controller may propose
// ------------------------------------------------------------

export type Decision =
  | {
      kind: 'ownership';
      calloutId: string;
      memberId: string;
      basis: OwnershipBasis;
      barType?: string;
      distributionAxis?: 'L' | 'W' | 'H';
    }
  | { kind: 'shared'; calloutId: string; memberIds: string[] }
  | { kind: 'exclude'; calloutId: string }
  | { kind: 'unresolved'; about: string }
  | { kind: 'escalate'; question: string; whyNeeded: string; blocks: string[] };

export interface Proposal {
  objective: string;
  /** the controller's own account of how it got here — read by people, not machines */
  reasoning: string;
  evidenceIds: string[];
  decision: Decision;
  confidence: 'high' | 'medium' | 'low';
  unresolvedQuestions?: string[];
}

export type ControllerReply =
  | { requestTools: ToolRequest[]; question?: string; missing?: string }
  | { proposal: Proposal };

export interface InvestigationStep {
  n: number;
  objective: string;
  /** what it said it was trying to find out */
  question?: string;
  /** what it said was missing */
  missing?: string;
  toolCalls: { tool: string; args: unknown; ok: boolean; result: string; evidenceIds: string[] }[];
  proposal?: Proposal;
  verdict?: 'accepted' | 'rejected';
  objection?: string;
}

export interface InvestigationOutcome {
  objective: string;
  steps: InvestigationStep[];
  /** the accepted decision, if one survived validation */
  decision?: Decision;
  accepted: boolean;
  /** why it ended without a decision */
  reason?: string;
  /** every tool it asked for, in order — the evidence that it investigated */
  toolsRequested: string[];
  evidenceIds: string[];
}

// ------------------------------------------------------------
// deterministic validation — the orchestrator cannot bypass this
// ------------------------------------------------------------

export interface ValidationContext {
  registry: MemberRegistry;
  /** callout ids the extractor actually read */
  calloutIds: ReadonlySet<string>;
  /** evidence the answer cited must exist */
  hasEvidence(id: string): boolean;
}

export interface Validation {
  ok: boolean;
  objection?: string;
  /** the claim to hand to resolveOwnership, when the decision is an ownership one */
  claim?: OwnershipClaim;
}

const LEGAL_BASES: ReadonlySet<string> = new Set([
  'in-detail',
  'leader-terminates',
  'strong-geometry',
  'proximity',
]);

/**
 * Is this proposal structurally legal?
 *
 * Every existing invariant is checked here, because this is the one door a
 * reasoning loop can push a decision through. A proposal that cites evidence
 * the sheet does not carry, names a member the registry never established, or
 * claims a callout the extractor never read is refused by name — and the name
 * is what lets the next investigation do better.
 */
export function validateProposal(p: Proposal, ctx: ValidationContext): Validation {
  const d = p.decision;

  // every cited evidence id must exist. A proposal resting on invented
  // provenance is worse than one resting on none, because it looks checked.
  const bogus = (p.evidenceIds ?? []).filter((id) => !id.startsWith('FACT-') && !ctx.hasEvidence(id));
  if (bogus.length) {
    return {
      ok: false,
      objection:
        `the proposal cites ${bogus.join(', ')}, which ${bogus.length === 1 ? 'is' : 'are'} not ` +
        'evidence on this sheet. Cite only ids a tool returned to you.',
    };
  }

  if (d.kind === 'unresolved' || d.kind === 'escalate') return { ok: true };

  if (!ctx.calloutIds.has(d.calloutId)) {
    return {
      ok: false,
      objection: `"${d.calloutId}" is not a reinforcement callout the extractor read from this sheet.`,
    };
  }

  if (d.kind === 'exclude') return { ok: true };

  if (d.kind === 'shared') {
    if (!d.memberIds?.length) {
      return { ok: false, objection: 'a shared callout must name the members it governs' };
    }
    const unknown = d.memberIds.filter((id) => !ctx.registry.byId.get(id) && !ctx.registry.resolve(id));
    if (unknown.length) {
      return { ok: false, objection: `${unknown.join(', ')} — no such member on this drawing` };
    }
    return { ok: true };
  }

  // ownership
  const member = ctx.registry.byId.get(d.memberId) ?? ctx.registry.resolve(d.memberId);
  if (!member) {
    return {
      ok: false,
      objection:
        `"${d.memberId}" is not a member of this drawing. Members are established from the sheet ` +
        'before any reasoning begins and cannot be created by a proposal.',
    };
  }
  if (!LEGAL_BASES.has(d.basis)) {
    return { ok: false, objection: `"${d.basis}" is not an ownership basis. Use one of: ${[...LEGAL_BASES].join(', ')}` };
  }
  if (!p.evidenceIds?.length) {
    return {
      ok: false,
      objection:
        'an ownership decision must cite the evidence it rests on. Name the ids that show this ' +
        'callout belongs to this member.',
    };
  }

  return {
    ok: true,
    claim: {
      calloutId: d.calloutId,
      memberId: member.id,
      basis: d.basis,
      reason: p.reasoning.slice(0, 300),
      // the investigation's own reply is model output too — it is narrowed
      // here, at the point it becomes a claim, rather than trusted downstream
      barType: isBarType(d.barType) ? d.barType : undefined,
      distributionAxis: d.distributionAxis,
    },
  };
}

// ------------------------------------------------------------
// the loop
// ------------------------------------------------------------

export const CONTROLLER_SYSTEM = `You are a senior structural engineer investigating one question about one reinforcement drawing, in order to produce a defensible bar bending schedule.

You cannot see the drawing. You investigate it by REQUESTING EVIDENCE, and deterministic tools answer from what was extracted. Everything you learn comes from those answers.

## HOW YOU WORK

Each turn you do exactly one of two things:

1. REQUEST EVIDENCE — when you do not yet know enough:
   {"requestTools":[{"tool":"getLeaderTarget","args":{"leaderId":"LEADER-004"}}],
    "question":"what does the leader carrying CALL-020 terminate on?",
    "missing":"whether CALL-020 is tied to TB or to the section beside it"}

2. PROPOSE A DECISION — when the evidence supports one:
   {"proposal":{"objective":"...","reasoning":"...","evidenceIds":["LEADER-004","CALL-020"],
    "decision":{"kind":"ownership","calloutId":"CALL-020","memberId":"MEM-02",
    "basis":"leader-terminates","barType":"STIRRUP","distributionAxis":"L"},
    "confidence":"high"}}

## THE TOOLS

${renderToolMenu()}

## WHAT MAKES A DECISION DEFENSIBLE

A callout belongs to a member because something SHOWS it does — a leader that terminates on it, containment in the detail that draws it, a geometric relationship. Proximity alone is the weakest evidence there is: on this kind of sheet two details can sit a metre apart and a callout between them belongs to exactly one.

So: investigate before you decide. If you find a leader, follow it. If a callout sits between two members, ask what is near it. Distance is a last resort, and when you use it, say so by proposing basis "proximity" rather than dressing it as something stronger.

## WHEN YOU CANNOT DECIDE

Two honest endings, and both are better than a guess:

  {"proposal":{...,"decision":{"kind":"unresolved","about":"CALL-020"},...}}
      the evidence is genuinely ambiguous — say what you looked at

  {"proposal":{...,"decision":{"kind":"escalate","question":"...","whyNeeded":"...","blocks":["MEM-02"]},...}}
      the drawing does not contain the answer and a person must supply it

Do NOT escalate something a tool could have told you. Ask the tools first.

## WHAT YOU MAY NOT DO

You never state a dimension, a count, a spacing or a weight. You never name a member the tools have not shown you. You never cite an evidence id a tool did not return. Every one of those is checked, and a proposal that breaks one comes back to you as an objection with the reason.

Answer with a single json object, matching one of the two shapes above.`;

export interface InvestigateOptions {
  objective: string;
  /** opening context — what is already known about this objective */
  brief: string;
  tools: ToolContext;
  validation: ValidationContext;
  /** the model seam; returns a parsed reply or null */
  ask(args: { system: string; prompt: string; step: number }): Promise<Record<string, unknown> | null>;
  maxSteps?: number;
  onStep?: (s: InvestigationStep) => void;
}

const MAX_STEPS_DEFAULT = 6;
/** tools one step may ask for — enough to follow a thread, not enough to trawl */
const MAX_TOOLS_PER_STEP = 4;

/**
 * Investigate one objective until it can be decided, or until the budget ends.
 *
 * The transcript grows with every answer, so later reasoning sees what earlier
 * reasoning found — including the objections its own rejected proposals earned.
 */
export async function investigate(opts: InvestigateOptions): Promise<InvestigationOutcome> {
  const maxSteps = opts.maxSteps ?? MAX_STEPS_DEFAULT;
  const steps: InvestigationStep[] = [];
  const toolsRequested: string[] = [];
  const evidenceIds = new Set<string>();
  const transcript: string[] = [`OBJECTIVE: ${opts.objective}`, '', opts.brief];

  for (let n = 1; n <= maxSteps; n++) {
    const step: InvestigationStep = { n, objective: opts.objective, toolCalls: [] };

    const reply = (await opts.ask({
      system: CONTROLLER_SYSTEM,
      prompt: `${transcript.join('\n')}\n\nYou have ${maxSteps - n + 1} step(s) left. Request evidence, or propose a decision.`,
      step: n,
    })) as ControllerReply | null;

    if (!reply) {
      step.objection = 'the controller returned nothing';
      steps.push(step);
      opts.onStep?.(step);
      continue;
    }

    // ---- it asked for evidence ----
    if ('requestTools' in reply && Array.isArray(reply.requestTools)) {
      step.question = reply.question;
      step.missing = reply.missing;
      const requests = reply.requestTools.slice(0, MAX_TOOLS_PER_STEP);
      transcript.push('', `--- investigation ${n} ---`);
      if (reply.question) transcript.push(`asking: ${reply.question}`);
      for (const req of requests) {
        const res: ToolResult = runTool(opts.tools, req);
        toolsRequested.push(req.tool);
        for (const id of res.evidenceIds) evidenceIds.add(id);
        step.toolCalls.push({
          tool: req.tool,
          args: req.args,
          ok: res.ok,
          result: res.text,
          evidenceIds: res.evidenceIds,
        });
        transcript.push(`${req.tool}(${JSON.stringify(req.args ?? {})}):`, res.text);
      }
      if (!requests.length) transcript.push('(you requested no tools; ask for evidence or propose a decision)');
      steps.push(step);
      opts.onStep?.(step);
      continue;
    }

    // ---- it proposed ----
    if ('proposal' in reply && reply.proposal) {
      const p = reply.proposal;
      step.proposal = p;
      for (const id of p.evidenceIds ?? []) evidenceIds.add(id);
      const v = validateProposal(p, opts.validation);
      step.verdict = v.ok ? 'accepted' : 'rejected';
      step.objection = v.objection;
      steps.push(step);
      opts.onStep?.(step);

      if (v.ok) {
        return {
          objective: opts.objective,
          steps,
          decision: p.decision,
          accepted: true,
          toolsRequested,
          evidenceIds: [...evidenceIds],
        };
      }
      transcript.push('', `--- investigation ${n} ---`, `your proposal was REFUSED: ${v.objection}`);
      continue;
    }

    step.objection = 'the reply was neither a tool request nor a proposal';
    steps.push(step);
    opts.onStep?.(step);
    transcript.push('', `(your last reply was neither a tool request nor a proposal)`);
  }

  return {
    objective: opts.objective,
    steps,
    accepted: false,
    reason: `${maxSteps} investigations produced no decision the evidence supports`,
    toolsRequested,
    evidenceIds: [...evidenceIds],
  };
}

/** the investigation, as a person reads it */
export function formatInvestigation(o: InvestigationOutcome): string {
  const L = [`### ${o.objective}`, ''];
  for (const s of o.steps) {
    L.push(`**Investigation ${s.n}**`);
    if (s.question) L.push(`- question: ${s.question}`);
    if (s.missing) L.push(`- missing: ${s.missing}`);
    for (const t of s.toolCalls) {
      L.push(`- ${t.tool}(${JSON.stringify(t.args ?? {})}) → ${t.ok ? `${t.evidenceIds.length} node(s)` : 'nothing'}`);
    }
    if (s.proposal) {
      L.push(`- proposed: ${JSON.stringify(s.proposal.decision)}  [${s.proposal.confidence}]`);
      L.push(`- reasoning: ${s.proposal.reasoning.slice(0, 200)}`);
    }
    if (s.verdict) L.push(`- **${s.verdict}**${s.objection ? ` — ${s.objection}` : ''}`);
    L.push('');
  }
  L.push(o.accepted ? `**Decision:** ${JSON.stringify(o.decision)}` : `**No decision** — ${o.reason}`);
  L.push(`tools used: ${o.toolsRequested.join(', ') || 'none'}`);
  return L.join('\n');
}
