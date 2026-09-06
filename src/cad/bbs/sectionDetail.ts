// EVERYTHING ONE SECTION SAYS, READ ONCE AND WRITTEN DOWN.
//
// The About Drawing note used to carry five lines per section: its id, its
// label, its bounds, and whatever hints the splitter happened to record. Every
// dimension on the sheet, every bar callout, every line of text inside the
// section — the things a schedule is actually built from — were nowhere in it.
// So each BBS run went back to the drawing and asked the model again for what
// had already been read.
//
// This reads them ONCE, deterministically, straight out of the document:
//
//   · every text string inside the section, verbatim and in reading order
//   · every dimension whose extent falls inside it, with its measurement
//   · what it is made of, by entity type and by layer
//   · every bar callout the grammar can parse, with what it parsed to
//
// NOT ONE MODEL CALL. All of it is in the DXF already; asking a model to
// re-read a number that `entityBoundsMm` can measure is paying for a worse
// answer. What a model is for is what the drawing does not say — and that is a
// much shorter list once this is written down.
//
// VERBATIM, AND NEVER INTERPRETED. The text goes in as it is written, and a
// parsed callout is recorded BESIDE its raw string rather than instead of it.
// A note that has quietly normalised "8 (2L)@100 c/c" into a number is a note
// nobody can check against the sheet.

import { boundsIntersect, entitiesInBounds, entityBoundsMm } from '../understanding/bounds';
import type { SectionBounds } from '../understanding/types';
import type { CadDocument, CadEntity } from '../types';
import { parseCallout, parsedAnything } from './callout';

export interface SectionDimension {
  handle: string;
  /** the CAD app's own measurement, in millimetres */
  measurementMm: number | null;
  /** the two points it spans, in millimetres */
  from: { x: number; y: number } | null;
  to: { x: number; y: number } | null;
  /**
   * The detailer's text override, verbatim, where the drawing carries one.
   *
   * This OUTRANKS the measurement. `annotations.ts` puts it plainly: "a
   * schedule must prefer what is WRITTEN over what is measured — the written
   * value is what the yard cuts to." So both are recorded and the note says
   * which is which, rather than quietly keeping one.
   */
  textOverride?: string;
}

export interface SectionCallout {
  /** exactly as written on the sheet */
  raw: string;
  diaMm?: number;
  spacingMm?: number;
  count?: number;
  legs?: number;
  secondDiaMm?: number;
  zone?: string;
}

export interface SectionDetail {
  /** every text string inside the section, verbatim, top-down then left-right */
  text: string[];
  dimensions: SectionDimension[];
  /** the callouts the bar grammar could read something out of */
  callouts: SectionCallout[];
  byType: { type: string; count: number }[];
  byLayer: { layer: string; count: number }[];
  entityCount: number;
}

/** Text is read the way a person reads a drawing: down the sheet, then across. */
function readingOrder(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return b.y - a.y || a.x - b.x;
}

const tally = (values: readonly string[]): { key: string; count: number }[] => {
  const by = new Map<string, number>();
  for (const v of values) by.set(v, (by.get(v) ?? 0) + 1);
  return [...by].map(([key, count]) => ({ key, count })).sort((x, y) => y.count - x.count);
};

/**
 * Read one section out of the document.
 *
 * `bounds` are the section's own, in millimetres, and everything is measured
 * against them with the same `entityBoundsMm` the splitter used — so what this
 * says is in a section is what the splitter would have put in it.
 */
export function sectionDetail(doc: CadDocument, bounds: SectionBounds): SectionDetail {
  const unitScale = doc.unitScale || 1;
  const inside = entitiesInBounds(doc, bounds, 'intersect').entities;

  const texts = inside
    .filter((e): e is CadEntity & { type: 'text' } => e.type === 'text' && !!e.text?.trim())
    .map((e) => ({
      text: e.text.trim(),
      at: { x: e.position.x * unitScale, y: e.position.y * unitScale },
    }))
    .sort((a, b) => readingOrder(a.at, b.at));

  const callouts: SectionCallout[] = [];
  for (const { text } of texts) {
    const p = parseCallout(text);
    // Only what the grammar actually read something out of. A note recording
    // "PLAN" as a callout with no bar in it is noise in the one list a reader
    // scans for steel.
    if (!parsedAnything(p)) continue;
    callouts.push({
      raw: text,
      ...(p.diaMm !== undefined ? { diaMm: p.diaMm } : {}),
      ...(p.spacingMm !== undefined ? { spacingMm: p.spacingMm } : {}),
      ...(p.count !== undefined ? { count: p.count } : {}),
      ...(p.legs !== undefined ? { legs: p.legs } : {}),
      ...(p.secondDiaMm !== undefined ? { secondDiaMm: p.secondDiaMm } : {}),
      ...(p.zone ? { zone: p.zone } : {}),
    });
  }

  const dimensions: SectionDimension[] = [];
  for (const d of doc.annotations?.dimensions ?? []) {
    const pts = [d.from, d.to, d.textPoint].filter(
      (p): p is { x: number; y: number } => !!p,
    );
    if (!pts.length) continue;
    const xs = pts.map((p) => p.x * unitScale);
    const ys = pts.map((p) => p.y * unitScale);
    const box: SectionBounds = {
      xMin: Math.min(...xs),
      yMin: Math.min(...ys),
      xMax: Math.max(...xs),
      yMax: Math.max(...ys),
    };
    if (!boundsIntersect(box, bounds)) continue;
    dimensions.push({
      handle: d.handle,
      measurementMm: typeof d.measurement === 'number' ? d.measurement * unitScale : null,
      from: d.from ? { x: d.from.x * unitScale, y: d.from.y * unitScale } : null,
      to: d.to ? { x: d.to.x * unitScale, y: d.to.y * unitScale } : null,
      ...(d.textOverride?.trim() ? { textOverride: d.textOverride.trim() } : {}),
    });
  }

  return {
    text: texts.map((t) => t.text),
    dimensions,
    callouts,
    byType: tally(inside.map((e) => e.type)).map((t) => ({ type: t.key, count: t.count })),
    byLayer: tally(inside.map((e) => e.style.layer || '0')).map((l) => ({
      layer: l.key,
      count: l.count,
    })),
    entityCount: inside.length,
  };
}

/** Caps, so one note stays readable and one prompt stays affordable. */
const MAX_TEXT = 60;
const MAX_DIMENSIONS = 40;
const MAX_CALLOUTS = 30;

/**
 * The detail as the lines that go into the note.
 *
 * Where a list is capped it SAYS it was capped and by how much. A note that
 * silently shows the first forty of ninety dimensions is a note that will be
 * trusted for the fifty it did not mention.
 */
export function sectionDetailLines(detail: SectionDetail): string[] {
  const more = (shown: number, total: number): string =>
    total > shown ? `  … and ${total - shown} more` : '';
  const lines: string[] = [
    `made of: ${detail.entityCount} entities — ${
      detail.byType.map((t) => `${t.type}×${t.count}`).join(', ') || 'nothing measurable'
    }`,
    `layers: ${detail.byLayer.map((l) => `${l.layer}×${l.count}`).join(', ') || 'none'}`,
  ];

  if (detail.callouts.length) {
    lines.push(`bar callouts (${detail.callouts.length}):`);
    for (const c of detail.callouts.slice(0, MAX_CALLOUTS)) {
      const read = [
        c.count !== undefined ? `${c.count} no.` : '',
        c.diaMm !== undefined ? `Ø${c.diaMm}` : '',
        c.spacingMm !== undefined ? `@${c.spacingMm} c/c` : '',
        c.legs !== undefined ? `${c.legs}L` : '',
        c.secondDiaMm !== undefined ? `+ Ø${c.secondDiaMm}` : '',
        c.zone ? `[${c.zone}]` : '',
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(`  "${c.raw}" → ${read}`);
    }
    const rest = more(MAX_CALLOUTS, detail.callouts.length);
    if (rest) lines.push(rest);
  } else {
    lines.push('bar callouts: none the grammar could read');
  }

  if (detail.dimensions.length) {
    lines.push(`dimensions (${detail.dimensions.length}):`);
    for (const d of detail.dimensions.slice(0, MAX_DIMENSIONS)) {
      const span =
        d.from && d.to
          ? ` (${Math.round(d.from.x)},${Math.round(d.from.y)} → ${Math.round(d.to.x)},${Math.round(d.to.y)})`
          : '';
      lines.push(
        `  ${d.handle}: ${d.measurementMm === null ? 'no measurement' : `${Math.round(d.measurementMm)} mm`}` +
          `${d.textOverride ? ` — WRITTEN "${d.textOverride}", which is what the yard cuts to` : ''}${span}`,
      );
    }
    const rest = more(MAX_DIMENSIONS, detail.dimensions.length);
    if (rest) lines.push(rest);
  } else {
    lines.push('dimensions: none inside this section');
  }

  if (detail.text.length) {
    lines.push(`text, verbatim (${detail.text.length}):`);
    for (const t of detail.text.slice(0, MAX_TEXT)) lines.push(`  "${t}"`);
    const rest = more(MAX_TEXT, detail.text.length);
    if (rest) lines.push(rest);
  } else {
    lines.push('text: none inside this section');
  }

  return lines;
}
