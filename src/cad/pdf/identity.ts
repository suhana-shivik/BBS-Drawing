// Drawing identity read off a PDF sheet's text runs. Mirrors the heuristics of
// src/register/titleBlock.ts (inline "LABEL: value" beats everything; a
// label's nearest right/below neighbour is a guess; a filename value in the
// conventional shape beats a guess) with one PDF-specific rule: title blocks
// live at the sheet's bottom-right, so among equally shaped candidates the one
// clustered nearest that corner wins.
//
// Deliberately standalone — no imports from src/register — so PDF import has
// no dependency on the register module; the register agent may unify later.
import type { PdfTextRun } from './types';

export interface PdfIdentity {
  drawingNumber?: string;
  title?: string;
  revision?: string;
  date?: string;
  /** 0..1 blend of the found fields' individual confidences. */
  confidence: number;
  /** Human-readable trail: where each value came from, what was not found. */
  evidence: string[];
}

interface Token {
  text: string;
  flat: string;
  x: number;
  y: number;
  /** 1 at the sheet's bottom-right corner, 0 at the far corner. */
  corner: number;
}

interface Found {
  value: string;
  confidence: number;
  how: string;
}

const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();
const baseName = (file: string): string => file.replace(/\.[^.]+$/, '').trim();
const valueAfter = (text: string, re: RegExp): string => clean(text.replace(re, ''));

/**
 * Any title-block caption, not just the one being searched for. A field's
 * value is never another field's name (titleBlock.ts learned this when a
 * drawing entered the register named "REVISION : · 00").
 */
const ANY_LABEL =
  /^(?:DRAWING|DRG|DWG|SHEET|REVISION|REV|ISSUE|DATE|TITLE|SCALE|DRAWN|CHECKED|APPROVED|CLIENT|PROJECT|JOB|STATUS|NO|NUMBER)\b[\s:.\-#]*$/i;

const NUMBER_INLINE = /^(?:DRAWING|DRG|DWG|SHEET)\s*(?:NO\.?|NUMBER|#)\s*[:.\-]?\s*/i;
const NUMBER_LABEL = /^(?:DRAWING|DRG|DWG|SHEET)\s*(?:NO\.?|NUMBER|#)\s*[:.\-]?$/i;
const REV_INLINE = /^(?:REVISION|REV\.?|REVISION\s*NO\.?)\s*[:.\-]?\s*/i;
const REV_LABEL = /^(?:REVISION|REV\.?|REVISION\s*NO\.?)\s*[:.\-]?$/i;
const DATE_INLINE = /^(?:ISSUE\s*DATE|DATE)\s*[:.\-]?\s*/i;
const DATE_LABEL = /^(?:ISSUE\s*DATE|DATE)\s*[:.\-]?$/i;
const TITLE_INLINE = /^(?:DRAWING\s*TITLE|TITLE)\s*[:.\-]?\s*/i;
const TITLE_LABEL = /^(?:DRAWING\s*TITLE|TITLE)\s*[:.\-]?$/i;

/** Three-or-more dash-joined codes: the drawing-number convention. */
const NUMBER_SHAPE = /^[A-Z0-9]{1,8}(?:-[A-Z0-9.]{1,10}){2,}$|^[A-Z0-9]{1,8}(?:_[A-Z0-9.]{1,10}){2,}$/i;
const REV_SHAPE = /^R\d{1,2}[A-Z]?$|^REV\.?\s*[A-Z0-9]{1,3}$/i;
const DATE_SHAPE = /^\d{1,2}[.\-/]\d{1,2}[.\-/](?:\d{2}|\d{4})$/;

function tokensOf(texts: PdfTextRun[]): Token[] {
  const runs = texts.filter((t) => clean(t.text) !== '');
  if (runs.length === 0) return [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of runs) {
    minX = Math.min(minX, r.x);
    maxX = Math.max(maxX, r.x);
    minY = Math.min(minY, r.y);
    maxY = Math.max(maxY, r.y);
  }
  // y-up page points: the bottom-right corner is (maxX, minY).
  const diag = Math.max(1, Math.hypot(maxX - minX, maxY - minY));
  return runs.map((r) => ({
    text: clean(r.text),
    flat: clean(r.text).toUpperCase(),
    x: r.x,
    y: r.y,
    corner: 1 - Math.hypot(maxX - r.x, r.y - minY) / diag,
  }));
}

const at = (t: Token): string => `(${Math.round(t.x)},${Math.round(t.y)})pt`;

/**
 * The value belonging to a label token: nearest non-caption token to the right
 * or immediately below. 72pt (one inch) of vertical slack — title-block cells
 * are small.
 */
function nearestValue(tokens: Token[], label: Token, rejected: RegExp): Token | null {
  let best: { token: Token; score: number } | null = null;
  for (const token of tokens) {
    if (token === label || rejected.test(token.flat)) continue;
    if (ANY_LABEL.test(token.flat)) continue;
    const dx = token.x - label.x;
    const dy = token.y - label.y;
    if (dx < -1 || Math.abs(dy) > Math.max(72, Math.abs(dx) * 1.5)) continue;
    const score = Math.hypot(dx, dy);
    if (!best || score < best.score) best = { token, score };
  }
  return best?.token ?? null;
}

function field(
  tokens: Token[],
  name: string,
  inline: RegExp,
  labelOnly: RegExp,
  plausible: (value: string) => boolean,
): Found | null {
  // Inline "LABEL: value" reads are not guesses. When a sheet holds several
  // (schedules quote other sheets), the one nearest the bottom-right wins.
  let inlineBest: { token: Token; value: string } | null = null;
  for (const token of tokens) {
    if (!inline.test(token.flat)) continue;
    const value = valueAfter(token.text, inline);
    if (!value || !plausible(value)) continue;
    if (!inlineBest || token.corner > inlineBest.token.corner) inlineBest = { token, value };
  }
  if (inlineBest) {
    return {
      value: inlineBest.value,
      confidence: 0.96,
      how: `inline "${inlineBest.token.text}" at ${at(inlineBest.token)}`,
    };
  }
  // A bare label's nearest neighbour is a guess; prefer the label closest to
  // the bottom-right corner.
  let labelBest: { label: Token; hit: Token } | null = null;
  for (const label of tokens) {
    if (!labelOnly.test(label.flat)) continue;
    const hit = nearestValue(tokens, label, labelOnly);
    if (!hit || !plausible(hit.text)) continue;
    if (!labelBest || label.corner > labelBest.label.corner) labelBest = { label, hit };
  }
  if (labelBest) {
    return {
      value: labelBest.hit.text,
      confidence: 0.82,
      how: `near label "${labelBest.label.text}" at ${at(labelBest.hit)} (${name})`,
    };
  }
  return null;
}

/** Unlabelled token in a conventional shape; bottom-right clustering decides. */
function shapeField(tokens: Token[], shape: RegExp, mapValue: (flat: string) => string): Found | null {
  let best: Token | null = null;
  for (const token of tokens) {
    if (!shape.test(token.flat) || ANY_LABEL.test(token.flat)) continue;
    if (!best || token.corner > best.corner) best = token;
  }
  if (!best) return null;
  return {
    value: mapValue(best.flat),
    confidence: 0.55 + 0.2 * best.corner,
    how: `shape match "${best.text}" at ${at(best)}, corner ${best.corner.toFixed(2)}`,
  };
}

// ---- filename fallbacks (same shapes as titleBlock.ts) ----

function filenameNumber(file: string): string {
  const base = baseName(file);
  // One separator, consistently — mixing them swallows the title.
  const hit =
    /^([A-Z0-9]{1,8}(?:-[A-Z0-9.]{1,10}){2,})/i.exec(base) ??
    /^([A-Z0-9]{1,8}(?:_[A-Z0-9.]{1,10}){2,})/i.exec(base);
  if (!hit) return '';
  return clean(hit[1].replace(/[-_](R(?:EV)?\s*\d+[A-Z]?)$/i, '')).toUpperCase();
}

function filenameRevision(file: string): string {
  const matches = [
    ...baseName(file).matchAll(/(?:^|[\s_\-])(R(?:EV)?\s*\d+[A-Z]?|REV\s*[A-Z0-9]+)(?=$|[\s_\-])/gi),
  ];
  return clean((matches.length ? matches[matches.length - 1][1] : '') ?? '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

function filenameDate(file: string): string {
  const hit = baseName(file).match(/\b(\d{1,2}[.\-/]\d{1,2}[.\-/](?:\d{2}|\d{4}))\b/);
  return hit?.[1] ?? '';
}

function smartTitle(file: string): string {
  return (
    clean(
      baseName(file)
        .replace(/\b(?:R(?:EV)?\s*\d+[A-Z]?|REV\s*[A-Z0-9]+)\b/gi, '')
        .replace(/\b\d{1,2}[.\-/]\d{1,2}[.\-/](?:\d{2}|\d{4})\b/g, '')
        .replace(/^\d+[\s_\-]*/, '')
        .replace(/[_-]+/g, ' '),
    ) || ''
  );
}

/**
 * A read found by proximity or shape is a GUESS about which text belongs to
 * which caption; a filename value in the conventional shape beats it. An
 * inline read still wins, because that is not a guess.
 */
function preferFilename(
  found: Found | null,
  fromName: string,
  conf: number,
): Found | null {
  const weak = !found || found.confidence < 0.9;
  if (fromName && weak) return { value: fromName, confidence: conf, how: 'filename' };
  return found;
}

export function identityFromPdfTexts(texts: PdfTextRun[], fileName: string): PdfIdentity {
  const tokens = tokensOf(texts);

  const number =
    field(tokens, 'number', NUMBER_INLINE, NUMBER_LABEL, (v) => v.length >= 2 && v.length <= 80) ??
    shapeField(tokens, NUMBER_SHAPE, (flat) => flat);
  const revision =
    field(tokens, 'revision', REV_INLINE, REV_LABEL, (v) => /^[A-Z0-9][A-Z0-9 ._\-/]{0,12}$/i.test(v)) ??
    shapeField(tokens, REV_SHAPE, (flat) => flat.replace(/^REV\.?\s*/, '').replace(/\s+/g, ''));
  const date =
    field(tokens, 'date', DATE_INLINE, DATE_LABEL, (v) => /\d/.test(v) && v.length <= 30) ??
    shapeField(tokens, DATE_SHAPE, (flat) => flat);
  const title = field(tokens, 'title', TITLE_INLINE, TITLE_LABEL, (v) => v.length >= 3 && v.length <= 160);

  const chosenNumber = preferFilename(number, filenameNumber(fileName), 0.8);
  const chosenRevision = preferFilename(revision, filenameRevision(fileName), 0.75);
  const chosenDate = date ?? (filenameDate(fileName) ? { value: filenameDate(fileName), confidence: 0.65, how: 'filename' } : null);
  const fallbackTitle = smartTitle(fileName);
  const chosenTitle = title ?? (fallbackTitle ? { value: fallbackTitle, confidence: 0.58, how: 'filename' } : null);

  const evidence: string[] = [];
  const report = (name: string, f: Found | null): void => {
    evidence.push(f ? `${name} "${f.value}" ← ${f.how}` : `${name}: not found`);
  };
  report('drawingNumber', chosenNumber);
  report('title', chosenTitle);
  report('revision', chosenRevision);
  report('date', chosenDate);

  // The number carries most of the identity; the rest refine it.
  const confidence =
    (chosenNumber ? 0.45 * chosenNumber.confidence : 0) +
    (chosenTitle ? 0.25 * chosenTitle.confidence : 0) +
    (chosenRevision ? 0.2 * chosenRevision.confidence : 0) +
    (chosenDate ? 0.1 * chosenDate.confidence : 0);

  return {
    ...(chosenNumber ? { drawingNumber: chosenNumber.value } : {}),
    ...(chosenTitle ? { title: chosenTitle.value } : {}),
    ...(chosenRevision ? { revision: chosenRevision.value } : {}),
    ...(chosenDate ? { date: chosenDate.value } : {}),
    confidence: Math.round(confidence * 100) / 100,
    evidence,
  };
}
