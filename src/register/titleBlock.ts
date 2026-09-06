// Deterministic title-block extraction. AI can later propose token pointers for
// unusual layouts, but values entering the register always come from source
// text (or an explicit filename fallback) and retain their evidence.
import type { CadDocument, CadEntity, CadText, Vec2 } from '../cad/types';
import type { DrawingDiscipline, RegisterEvidence } from './types';

interface TextToken {
  text: string;
  flat: string;
  handle: string;
  position: Vec2;
}

export interface TitleBlockResult {
  drawingNumber: RegisterEvidence;
  title: RegisterEvidence;
  revision: RegisterEvidence;
  issueDate: RegisterEvidence;
  discipline: RegisterEvidence;
  identityKey: string;
  displayName: string;
  needsReview: boolean;
}

const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();
const baseName = (file: string): string => file.replace(/\.[^.]+$/, '').trim();
const valueAfter = (text: string, re: RegExp): string => clean(text.replace(re, ''));

function textEntities(entities: CadEntity[]): CadText[] {
  return entities.filter((e): e is CadText => e.type === 'text' && clean(e.text) !== '');
}

function tokensOf(doc: CadDocument): TextToken[] {
  const all: CadText[] = [...textEntities(doc.entities)];
  for (const layout of doc.layouts) all.push(...textEntities(layout.entities));
  for (const block of doc.blocks.values()) all.push(...textEntities(block.entities));
  return all.map((t) => ({
    text: clean(t.text),
    flat: clean(t.text).toUpperCase(),
    handle: t.style.handle,
    position: t.position,
  }));
}

function evidence(value: string, token: TextToken | null, confidence: number): RegisterEvidence {
  return {
    value: clean(value),
    ...(token?.handle ? { handle: token.handle } : {}),
    source: token ? 'title-block' : 'filename',
    confidence,
  };
}

/**
 * Any title-block caption, not just the one being searched for.
 *
 * `nearestValue` used to reject only its OWN label, so the token nearest to
 * "TITLE" could be the caption "REVISION :" sitting beside it — and a drawing
 * entered the register named `REVISION : · 00`. A field's value is never
 * another field's name.
 */
const ANY_LABEL =
  /^(?:DRAWING|DRG|DWG|SHEET|REVISION|REV|ISSUE|DATE|TITLE|SCALE|DRAWN|CHECKED|APPROVED|CLIENT|PROJECT|JOB|STATUS|NO|NUMBER)\b[\s:.\-#]*$/i;

function nearestValue(tokens: TextToken[], label: TextToken, rejected: RegExp): TextToken | null {
  let best: { token: TextToken; score: number } | null = null;
  for (const token of tokens) {
    if (token === label || rejected.test(token.flat)) continue;
    if (ANY_LABEL.test(token.flat)) continue;
    const dx = token.position.x - label.position.x;
    const dy = token.position.y - label.position.y;
    // Title-block values are normally to the right or immediately below.
    if (dx < -1 || Math.abs(dy) > Math.max(2500, Math.abs(dx) * 1.5)) continue;
    const score = Math.hypot(dx, dy) + (dx < 0 ? 1e9 : 0);
    if (!best || score < best.score) best = { token, score };
  }
  return best?.token ?? null;
}

function field(
  tokens: TextToken[],
  inline: RegExp,
  labelOnly: RegExp,
  plausible: (value: string) => boolean,
): RegisterEvidence | null {
  for (const token of tokens) {
    if (!inline.test(token.flat)) continue;
    const value = valueAfter(token.text, inline);
    if (value && plausible(value)) return evidence(value, token, 0.96);
  }
  for (const label of tokens) {
    if (!labelOnly.test(label.flat)) continue;
    const hit = nearestValue(tokens, label, labelOnly);
    if (hit && plausible(hit.text)) return evidence(hit.text, hit, 0.82);
  }
  return null;
}

/**
 * The drawing number, read off the filename.
 *
 * There was no fallback here at all — title, revision and date each had one
 * and the number did not — so every drawing whose title block could not be
 * read entered the register as "no number", including a whole tender package
 * whose filenames state it plainly:
 *
 *   ORI-NAG-TD-EL-1.0_MASTER SITE LAYOUT PLAN R0   →   ORI-NAG-TD-EL-1.0
 *
 * The shape looked for is the convention: three or more dash-joined codes at
 * the start of the name. A single word is not a drawing number, and matching
 * one would be worse than leaving the field empty.
 */
function filenameNumber(file: string): string {
  const base = baseName(file).trim();
  // One separator, consistently. Mixing them swallowed the title: a pattern
  // accepting both read "ORI-NAG-TD-EL-1.0_MASTER" out of
  // "ORI-NAG-TD-EL-1.0_MASTER SITE LAYOUT PLAN", because the underscore that
  // ENDS the number also looked like part of it. Offices use one or the other.
  const hit =
    /^([A-Z0-9]{1,8}(?:-[A-Z0-9.]{1,10}){2,})/i.exec(base) ??
    /^([A-Z0-9]{1,8}(?:_[A-Z0-9.]{1,10}){2,})/i.exec(base);
  if (!hit) return '';
  // a trailing revision is not part of the number
  return clean(hit[1].replace(/[-_](R(?:EV)?\s*\d+[A-Z]?)$/i, '')).toUpperCase();
}

function filenameRevision(file: string): string {
  const matches = [...baseName(file).matchAll(/(?:^|[\s_\-])(R(?:EV)?\s*\d+[A-Z]?|REV\s*[A-Z0-9]+)(?=$|[\s_\-])/gi)];
  return clean((matches.length ? matches[matches.length - 1][1] : '') ?? '').replace(/\s+/g, '').toUpperCase();
}

function filenameDate(file: string): string {
  const hit = baseName(file).match(/\b(\d{1,2}[.\-/]\d{1,2}[.\-/](?:\d{2}|\d{4}))\b/);
  return hit?.[1] ?? '';
}

function smartTitle(file: string): string {
  return clean(
    baseName(file)
      .replace(/\b(?:R(?:EV)?\s*\d+[A-Z]?|REV\s*[A-Z0-9]+)\b/gi, '')
      .replace(/\b\d{1,2}[.\-/]\d{1,2}[.\-/](?:\d{2}|\d{4})\b/g, '')
      .replace(/^\d+[\s_\-]*/, '')
      .replace(/[_-]+/g, ' '),
  ) || 'Untitled drawing';
}

/**
 * Discipline codes as they appear inside a drawing number.
 *
 * `ORI-NAG-TD-EL-02` says electrical in its own name, and that is far better
 * evidence than any word in the drawing body.
 */
const NUMBER_DISCIPLINE: { re: RegExp; as: DrawingDiscipline }[] = [
  { re: /[-_](EL|ELE|ELEC|E)[-_]/i, as: 'mep' },
  { re: /[-_](ME|MEP|HV|HVAC|PH|PL|PLB|FF|FP)[-_]/i, as: 'mep' },
  { re: /[-_](ST|STR|S)[-_]/i, as: 'structural' },
  { re: /[-_](AR|ARC|ARCH|A)[-_]/i, as: 'architectural' },
  { re: /[-_](CV|CIV|C)[-_]/i, as: 'civil' },
];

/**
 * Which trade this drawing belongs to.
 *
 * The NUMBER decides when it can. Previously the whole drawing body was
 * scanned with structural tested first, so a single "FOUNDATION" anywhere in
 * several thousand tokens filed an electrical site plan under structural —
 * which is what happened to every sheet of a real tender package.
 *
 * Body text is still used, but only as a last resort, and the electrical and
 * services words are tested before the structural ones: an electrical drawing
 * mentions columns far more often than a structural drawing mentions cable.
 */
export function inferDiscipline(numberOrFile: string, body: string): DrawingDiscipline {
  for (const d of NUMBER_DISCIPLINE) {
    if (d.re.test(numberOrFile)) return d.as;
  }
  const s = `${numberOrFile} ${body}`.toUpperCase();
  if (/HVAC|DUCT|DIFFUSER|ELECTR|\bLT\b|\bHT\b|LIGHTING|SOCKET|CABLE|BUSBAR|EARTH|PLUMB|DRAIN|FIRE|\bMEP\b|PANEL|BREAKER|TRANSFORMER/.test(s)) {
    return 'mep';
  }
  if (/REBAR|REINFORC|FOUNDATION|FOOTING|PEDESTAL|\bRCC\b|STRUCTUR|BAR BENDING/.test(s)) {
    return 'structural';
  }
  if (/ARCHITECT|FLOOR PLAN|ROOM|DOOR SCHEDULE|WINDOW SCHEDULE|TOILET|ELEVATION/.test(s)) {
    return 'architectural';
  }
  if (/ROAD|DRAINAGE|SITE PLAN|GRADING|CIVIL|LAYOUT PLAN/.test(s)) return 'civil';
  return 'general';
}

export function revisionRank(value: string): number | null {
  const v = clean(value).toUpperCase().replace(/^REV(?:ISION)?\s*/, '').replace(/^R(?=\d)/, '');
  if (/^\d+[A-Z]?$/.test(v)) {
    const n = Number.parseInt(v, 10);
    const suffix = v.match(/[A-Z]$/)?.[0];
    return n * 100 + (suffix ? suffix.charCodeAt(0) - 64 : 0);
  }
  if (/^[A-Z]$/.test(v)) return v.charCodeAt(0) - 64;
  return null;
}

export function normalizeIdentity(value: string): string {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

export function extractTitleBlock(doc: CadDocument, fileName: string): TitleBlockResult {
  const tokens = tokensOf(doc);
  const joined = `${fileName} ${tokens.map((t) => t.text).join(' ')}`;

  const number = field(
    tokens,
    /^(?:DRAWING|DRG|DWG|SHEET)\s*(?:NO\.?|NUMBER|#)\s*[:.\-]?\s*/i,
    /^(?:DRAWING|DRG|DWG|SHEET)\s*(?:NO\.?|NUMBER|#)\s*[:.\-]?$/i,
    (v) => v.length >= 2 && v.length <= 80,
  );
  const revision = field(
    tokens,
    /^(?:REVISION|REV\.?|REVISION\s*NO\.?)\s*[:.\-]?\s*/i,
    /^(?:REVISION|REV\.?|REVISION\s*NO\.?)\s*[:.\-]?$/i,
    (v) => /^[A-Z0-9][A-Z0-9 ._\-/]{0,12}$/i.test(v),
  );
  const date = field(
    tokens,
    /^(?:ISSUE\s*DATE|DATE)\s*[:.\-]?\s*/i,
    /^(?:ISSUE\s*DATE|DATE)\s*[:.\-]?$/i,
    (v) => /\d/.test(v) && v.length <= 30,
  );
  const title = field(
    tokens,
    /^(?:DRAWING\s*TITLE|TITLE)\s*[:.\-]?\s*/i,
    /^(?:DRAWING\s*TITLE|TITLE)\s*[:.\-]?$/i,
    (v) => v.length >= 3 && v.length <= 160,
  );

  const fallbackTitle = smartTitle(fileName);
  const numFallback = filenameNumber(fileName);
  const revFallback = filenameRevision(fileName);
  const dateFallback = filenameDate(fileName);

  // A title-block read found by proximity is a GUESS about which text belongs
  // to which caption, and on a busy sheet it is often wrong: a stray "S" beside
  // a REV caption was read as the revision of four drawings whose filenames all
  // ended R0. So a filename value in the conventional shape beats a
  // proximity-found one; an inline "REV: R1" read still wins, because that is
  // not a guess.
  const weak = (e: RegisterEvidence | null): boolean =>
    !e || e.confidence < 0.9;
  const preferFilename = (
    found: RegisterEvidence | null,
    fromName: string,
    conf: number,
  ): RegisterEvidence =>
    fromName && weak(found) ? evidence(fromName, null, conf) : (found ?? evidence('', null, 0));

  const drawingNumber = preferFilename(number, numFallback, 0.8);
  const drawingTitle = title ?? evidence(fallbackTitle, null, 0.58);
  const drawingRevision = preferFilename(revision, revFallback, 0.75);
  const issueDate = date ?? evidence(dateFallback, null, dateFallback ? 0.65 : 0);
  // the number names its own trade; the body is only consulted when it cannot
  const disciplineValue = inferDiscipline(`${drawingNumber.value} ${fileName}`, joined);
  const discipline: RegisterEvidence = {
    value: disciplineValue,
    source: 'inferred',
    confidence: disciplineValue === 'general' ? 0.35 : 0.76,
  };
  const identitySeed = drawingNumber.value || drawingTitle.value || baseName(fileName);
  const identityKey = normalizeIdentity(identitySeed);
  const revLabel = drawingRevision.value || 'REV ?';
  const displayName = `${drawingNumber.value || drawingTitle.value} · ${revLabel}`;
  const needsReview = !drawingNumber.value || !drawingRevision.value || disciplineValue === 'general';

  return {
    drawingNumber,
    title: drawingTitle,
    revision: drawingRevision,
    issueDate,
    discipline,
    identityKey,
    displayName,
    needsReview,
  };
}
