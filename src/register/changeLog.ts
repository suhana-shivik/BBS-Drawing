// ============================================================
// The change log — what happened, when, and to which drawing.
//
// Nothing here is a new store. Every event is derived from timestamps the
// register and the artifact list already hold, which is why the log cannot
// drift from the register: there is only one set of facts.
//
// The one thing worth being careful about is WHEN a supersession happened.
// The obvious answer — the superseded sheet's own importedAt — is wrong: that
// is the day R0 *arrived*, months before anyone replaced it. A supersession
// becomes true at the moment the practice holds both sheets, so it is dated by
// the later of the pair.
//
// Hand corrections are shown as a mark on the drawing, not as their own dated
// event. `evidence.source === 'user'` records THAT a person typed the value but
// not when, and inventing a time for the log would make it untrustworthy.
// ============================================================
import type { DrawingRegisterEntry } from './types';
import { compareRevision } from './register';

export type ChangeKind = 'registered' | 'superseded' | 'issued';

export interface ChangeEvent {
  at: number;
  kind: ChangeKind;
  projectId: string;
  project: string;
  /** the drawing or output this concerns */
  what: string;
  /** the sentence under it — for a supersession, both revisions */
  detail: string;
  /** part of this drawing's identity was typed by a person, not read */
  corrected: boolean;
}

export interface ChangeLogArtifact {
  kind: string;
  createdAt: number;
  fileName?: string;
  drawingName?: string;
}

export interface ChangeLogProject {
  id: string;
  name: string;
  entries: DrawingRegisterEntry[];
  artifacts: ChangeLogArtifact[];
}

const rev = (e: DrawingRegisterEntry): string => e.revision || 'no revision';

const label = (e: DrawingRegisterEntry): string =>
  e.drawingNumber || e.title || e.originalFileName;

function handCorrected(entry: DrawingRegisterEntry): boolean {
  return Object.values(entry.evidence).some((ev) => ev?.source === 'user');
}

/**
 * Supersessions within one project, dated by the moment both sheets were held.
 *
 * Only chains the register is confident about produce events: an entry still
 * marked `review` has an identity nobody has confirmed, so claiming it replaced
 * something would be asserting a chain that may not exist.
 */
function supersessions(project: ChangeLogProject): ChangeEvent[] {
  const chains = new Map<string, DrawingRegisterEntry[]>();
  for (const entry of project.entries) {
    const list = chains.get(entry.identityKey) ?? [];
    list.push(entry);
    chains.set(entry.identityKey, list);
  }

  const out: ChangeEvent[] = [];
  for (const chain of chains.values()) {
    if (chain.length < 2) continue;
    const ordered = [...chain].sort(compareRevision);
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const older = ordered[i];
      const newer = ordered[i + 1];
      if (older.revisionState !== 'superseded') continue;
      out.push({
        // dated by the later arrival: that is when the practice knew
        at: Math.max(older.importedAt, newer.importedAt),
        kind: 'superseded',
        projectId: project.id,
        project: project.name,
        what: label(older),
        detail: `${rev(older)} replaced by ${rev(newer)}`,
        corrected: handCorrected(older) || handCorrected(newer),
      });
    }
  }
  return out;
}

export function buildChangeLog(projects: ChangeLogProject[]): ChangeEvent[] {
  const events: ChangeEvent[] = [];

  for (const project of projects) {
    for (const entry of project.entries) {
      events.push({
        at: entry.importedAt,
        kind: 'registered',
        projectId: project.id,
        project: project.name,
        what: entry.originalFileName,
        detail: [entry.drawingNumber, entry.revision, entry.discipline]
          .filter(Boolean)
          .join(' · '),
        corrected: handCorrected(entry),
      });
    }

    events.push(...supersessions(project));

    for (const artifact of project.artifacts) {
      events.push({
        at: artifact.createdAt,
        kind: 'issued',
        projectId: project.id,
        project: project.name,
        what: artifact.fileName ?? artifact.drawingName ?? 'output',
        detail:
          artifact.kind === 'quantity' ? 'quantities' :
            artifact.kind === 'bbs' ? 'bar bending schedule' :
              artifact.kind === 'about' ? 'About Drawing memory' : 'drawing sections',
        corrected: false,
      });
    }
  }

  return events.sort((a, b) => b.at - a.at);
}

/** Free text across everything a person can see on the row. */
export function matchesQuery(event: ChangeEvent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${event.what} ${event.detail} ${event.project} ${event.kind}`.toLowerCase().includes(q);
}
