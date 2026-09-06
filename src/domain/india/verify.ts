// The harness: geometry checks a claim.
//
// A model (or a domain rule) may claim "this is a 230 mm brick wall". Only the
// geometry knows whether the thing actually measures 230 mm. These checks turn
// a plausible-sounding label into a confirmed, refuted or unverifiable one, so
// nothing reaches a bill of quantities on the strength of assertion alone.
import type { CadDocument, CadEntity } from '../../cad/types';
import { entityFacts } from '../../cad/metrics';
import { decodeElectrical, phaseBalance } from './electrical';

export type Verdict = 'confirmed' | 'refuted' | 'unverifiable';

export interface Check {
  verdict: Verdict;
  claim: string;
  /** what the geometry actually says */
  measured?: string;
  detail: string;
}

/** wall thicknesses that correspond to real Indian construction, in mm */
const STANDARD_WALL_MM = [75, 100, 115, 150, 200, 230, 300, 350];

/**
 * Check a dimension claimed in a label against a measured value.
 * e.g. label "230 mm brick wall" vs a wall measuring 232 mm → confirmed.
 */
export function checkClaimedDimension(
  label: string,
  measuredMm: number,
  tolerance = 0.05,
): Check | null {
  const m = /(\d+(?:\.\d+)?)\s*(mm|m\b)/i.exec(label);
  if (!m) return null;
  const claimed = m[2].toLowerCase() === 'm' ? Number(m[1]) * 1000 : Number(m[1]);
  if (!Number.isFinite(claimed) || claimed <= 0) return null;
  const diff = Math.abs(claimed - measuredMm) / claimed;
  return {
    verdict: diff <= tolerance ? 'confirmed' : 'refuted',
    claim: `${claimed} mm`,
    measured: `${measuredMm.toFixed(0)} mm`,
    detail:
      diff <= tolerance
        ? 'Measured geometry agrees with the stated dimension.'
        : `Stated ${claimed} mm but the geometry measures ${measuredMm.toFixed(0)} mm.`,
  };
}

/** does a measured thickness correspond to a real Indian wall build-up? */
export function checkWallThickness(measuredMm: number): Check {
  const nearest = STANDARD_WALL_MM.reduce((a, b) =>
    Math.abs(b - measuredMm) < Math.abs(a - measuredMm) ? b : a,
  );
  const off = Math.abs(nearest - measuredMm);
  const ok = off <= Math.max(10, nearest * 0.05);
  return {
    verdict: ok ? 'confirmed' : 'unverifiable',
    claim: 'standard wall thickness',
    measured: `${measuredMm.toFixed(0)} mm`,
    detail: ok
      ? `Matches a standard ${nearest} mm wall` +
        (nearest === 230 ? ' (9″ brick).' : nearest === 115 ? ' (4½″ partition).' : '.')
      : `${measuredMm.toFixed(0)} mm is not a standard section — check the source drawing.`,
  };
}

// ------------------------------------------------------------
// drawing-level findings
// ------------------------------------------------------------

export interface Finding {
  severity: 'info' | 'warning';
  title: string;
  detail: string;
  /** entity handles the finding refers to, so the UI can highlight them */
  handles: string[];
}

/**
 * Audit an electrical drawing for things a human would only catch by
 * counting. Everything here is derived from geometry and names — no model
 * involved, so the findings are reproducible.
 */
export function auditElectrical(doc: CadDocument): Finding[] {
  const findings: Finding[] = [];

  // gather phase-tagged names from blocks and from annotation text
  const named: { name: string; handle: string }[] = [];
  for (const e of doc.entities) {
    if (e.type === 'insert') named.push({ name: e.blockName, handle: e.style.handle });
    else if (e.type === 'text') named.push({ name: e.text, handle: e.style.handle });
  }

  const balance = phaseBalance(named.map((n) => n.name));
  const live = balance.counts.R + balance.counts.Y + balance.counts.B;
  if (live > 0) {
    findings.push({
      severity: balance.balanced ? 'info' : 'warning',
      title: balance.balanced ? 'Phase distribution' : 'Uneven phase distribution',
      detail: balance.note,
      handles: named
        .filter((n) => decodeElectrical(n.name)?.phase)
        .map((n) => n.handle),
    });
  }

  // boards referenced in text but with no symbol placed, and vice versa
  const boardsInText = new Set<string>();
  const boardsAsBlocks = new Set<string>();
  for (const e of doc.entities) {
    const raw = e.type === 'text' ? e.text : e.type === 'insert' ? e.blockName : '';
    const d = raw ? decodeElectrical(raw) : null;
    if (!d?.boardType) continue;
    const key = `${d.boardType}${d.phase ?? ''}${d.circuit ?? ''}`;
    if (e.type === 'text') boardsInText.add(key);
    else boardsAsBlocks.add(key);
  }
  const orphanLabels = [...boardsInText].filter((k) => !boardsAsBlocks.has(k));
  if (orphanLabels.length > 3) {
    findings.push({
      severity: 'info',
      title: 'Board labels without a placed symbol',
      detail:
        `${orphanLabels.length} board designations appear as text with no matching ` +
        'block instance. Common on single-line diagrams, where boards are drawn ' +
        'as line work rather than symbols — worth confirming before counting.',
      handles: [],
    });
  }

  return findings;
}

/** verify a set of labels against what the geometry measures */
export function verifyLabels(
  doc: CadDocument,
  entities: CadEntity[],
  labelFor: (e: CadEntity) => string | undefined,
): Check[] {
  const out: Check[] = [];
  for (const e of entities) {
    const label = labelFor(e);
    if (!label) continue;
    const facts = entityFacts(doc, e);
    // the only dimension we can check generically is length
    const check = checkClaimedDimension(label, facts.length);
    if (check) out.push(check);
  }
  return out;
}
