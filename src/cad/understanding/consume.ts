// ============================================================
// Reading a section package — for whoever wants one.
//
// §20: a consumer receives the package as its STARTING CONTEXT, not as a
// prison. It gets the sheet, every saved section as a legible image, and the
// map of what those sections are — so it does not spend turns rediscovering a
// layout somebody already worked out. It keeps every investigation tool it
// had, because a package is a head start, not a substitute for looking.
//
// §15: nothing here runs the splitter. A consumer that finds no package says
// so and carries on with whatever fallback it already had. Silently splitting
// on someone else's behalf is how a "split once, use many times" promise
// turns back into "split on every run".
// ============================================================
import type { DrawingSection, DrawingUnderstandingPackage } from './types';

/** One section, ready to be served as an image with its caption. */
export interface SectionPanel {
  sectionId: string;
  caption: string;
  png: string;
  bounds: DrawingSection['bounds'];
}

/**
 * The saved sections that can actually be shown, in reading order.
 *
 * A section whose PNG never rendered is skipped here and still described in
 * the briefing — its DXF and its bounds are intact, and a consumer can
 * `look_at` its box. Serving an empty image would waste a turn on nothing.
 */
export function packagePanels(pkg: DrawingUnderstandingPackage): SectionPanel[] {
  return pkg.sections
    .filter((s) => s.png)
    .map((s) => ({
      sectionId: s.sectionId,
      caption: s.label === s.kind ? s.label : `${s.label} — ${s.kind}`,
      png: s.png,
      bounds: s.bounds,
    }));
}

/**
 * The package as text: what this sheet is made of, and where each piece is.
 *
 * Hints are labelled as hints and carry their basis, so a consumer cannot
 * mistake "the label C1 is printed in this region" for "these bars belong to
 * C1" — §11 draws that line and this is where it has to survive the handover.
 */
export function packageBriefing(pkg: DrawingUnderstandingPackage): string {
  const lines: string[] = [];
  lines.push('## THIS DRAWING HAS ALREADY BEEN SPLIT INTO SECTIONS');
  lines.push('');
  if (pkg.summary) {
    lines.push(pkg.summary);
    lines.push('');
  }
  lines.push(
    `${pkg.sections.length} section${pkg.sections.length === 1 ? '' : 's'} were saved from this sheet. ` +
      'Each one below is a real region of the drawing with its own CAD geometry. ' +
      'Use them as your starting point — you do not need to work out the layout again. ' +
      'You still have every tool you had: if something is unclear, or a region looks ' +
      'incomplete, look at it yourself.',
  );
  lines.push('');

  for (const s of pkg.sections) {
    const b = s.bounds;
    const parts = [
      `${s.sectionId}  ${JSON.stringify(s.label)}  [${s.kind}]`,
      `  bounds (mm): x ${b.xMin.toFixed(0)}..${b.xMax.toFixed(0)}, y ${b.yMin.toFixed(0)}..${b.yMax.toFixed(0)}`,
      `  ${s.entityCount} CAD entities${s.png ? ', image served below' : ', NO IMAGE — use look_at on its bounds'}`,
    ];
    if (s.memberHints.length) {
      parts.push(
        `  member HINTS (not assignments): ${s.memberHints
          .map((h) => `${h.mark} (${h.basis})`)
          .join(', ')}`,
      );
    }
    if (s.calloutHints.length) {
      parts.push(`  callouts seen here: ${s.calloutHints.slice(0, 12).join(' · ')}`);
    }
    if (s.confidence > 0 && s.confidence < 0.6) {
      parts.push(`  the splitter was only ${(s.confidence * 100).toFixed(0)}% confident about this one`);
    }
    for (const l of s.limitations) parts.push(`  note: ${l.message}`);
    lines.push(parts.join('\n'));
  }

  if (pkg.relationships.length) {
    lines.push('');
    lines.push('HOW THE SECTIONS RELATE (the splitter\'s reading, not a verdict):');
    for (const r of pkg.relationships) {
      lines.push(`  ${r.from} ${r.kind} ${r.to}${r.basis ? ` — ${r.basis}` : ''}`);
    }
  }

  if (pkg.unresolved.length) {
    lines.push('');
    lines.push('THE SPLITTER COULD NOT ACCOUNT FOR:');
    for (const u of pkg.unresolved) lines.push(`  · ${u}`);
  }

  lines.push('');
  lines.push(
    'These sections describe the drawing. They do not decide anything about ' +
      'quantities, ownership or scheduling — that is yours.',
  );
  return lines.join('\n');
}

/** Every section's DXF, for a consumer that wants geometry rather than pixels. */
export function packageDxfs(pkg: DrawingUnderstandingPackage): { sectionId: string; dxf: string }[] {
  return pkg.sections.map((s) => ({ sectionId: s.sectionId, dxf: s.dxf }));
}

/**
 * One saved section, in the plain shape a reading consumer takes as evidence.
 *
 * Deliberately structural rather than an imported type: the consumer (today,
 * the BBS orchestrator) declares its own section shape so it never depends on
 * the splitter's module, and a hand-written section, a fixture and a live
 * package all arrive at it identically. This is the handover, and it is the
 * only place that knows both vocabularies.
 */
export interface SectionEvidenceOut {
  sectionId: string;
  label: string;
  kind: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  entityCount?: number;
  confidence?: number;
  memberHints?: { mark: string; basis: string }[];
  png?: string;
}

/**
 * A saved split, as evidence for whoever reads the sheet next.
 *
 * §11 and §20 both survive the crossing: a member hint carries its BASIS, so
 * "the label C1 is printed in this region" cannot be mistaken for "these bars
 * belong to C1", and `confidence` stays the splitter's own. Nothing here
 * decides anything about quantities — it says what was cut and where.
 *
 * A section whose PNG never rendered keeps its bounds and its hints; the
 * consumer can still crop that box itself. An empty `png` is omitted rather
 * than served, for the reason `packagePanels` skips it.
 */
export function packageSectionEvidence(pkg: DrawingUnderstandingPackage): SectionEvidenceOut[] {
  return pkg.sections.map((s) => ({
    sectionId: s.sectionId,
    label: s.label,
    kind: s.kind,
    // The two sides name a box differently — xMin/yMin/xMax/yMax here,
    // x1/y1/x2/y2 there — and both are millimetres in sheet space. Absorbing
    // that here is the entire reason this function exists: a silent swap at
    // the call site would crop the wrong rectangle and look like a bad read.
    bounds: { x1: s.bounds.xMin, y1: s.bounds.yMin, x2: s.bounds.xMax, y2: s.bounds.yMax },
    entityCount: s.entityCount,
    confidence: s.confidence,
    memberHints: s.memberHints.map((h) => ({ mark: h.mark, basis: h.basis })),
    ...(s.png ? { png: s.png } : {}),
  }));
}

/**
 * How the splitter read the sections as relating — its reading, never a verdict.
 * Handed over verbatim so the consumer can weigh it rather than inherit it.
 */
export function packageRelationships(
  pkg: DrawingUnderstandingPackage,
): { from: string; to: string; kind: string; basis?: string }[] {
  return (pkg.relationships ?? []).map((r) => ({
    from: r.from,
    to: r.to,
    kind: String(r.kind),
    ...(r.basis ? { basis: r.basis } : {}),
  }));
}
