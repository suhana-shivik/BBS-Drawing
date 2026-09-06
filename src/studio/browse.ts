// What the Files view knows ABOUT a register node — its type, its drawing
// number, where it sits, how big it is. One module, because the list and the
// properties pane must never disagree about the same file: the row that says
// "DXF file · 3,063" and the panel that says "Type: DXF file · Entities: 3,063"
// are the same two sentences, read from here.

import {
  folderPath,
  pathToFile,
  type RegisterFileNode,
  type RegisterFolderNode,
  type RegisterNode,
  type StudioData,
} from './data';
import type { BrowseSort } from './store';

export function extOf(n: RegisterFileNode): string {
  const m = /\.([a-z0-9]+)$/i.exec(n.name);
  return (n.ext ?? (m ? m[1] : 'dxf')).toLowerCase();
}

/** Explorer's own phrasing: "Folder", "DXF file". */
export function typeLabel(n: RegisterNode): string {
  return n.kind === 'folder' ? 'Folder' : `${extOf(n).toUpperCase()} file`;
}

/** The sheet's drawing number — the register node itself never carries one. */
export function drawingNumber(data: StudioData, n: RegisterNode): string | null {
  if (n.kind !== 'file') return null;
  // A filed output states the number it was built from; an openable sheet
  // states its own.
  if (n.number) return n.number;
  if (!n.sheetId) return null;
  return data.sheets[n.sheetId]?.number || null;
}

export function revisionOf(n: RegisterNode): string | null {
  if (n.kind !== 'file') return null;
  return n.rev ?? n.tag ?? null;
}

export function disciplineOf(data: StudioData, n: RegisterNode): string | null {
  if (n.kind !== 'file') return null;
  return n.discipline ?? (n.sheetId ? data.sheets[n.sheetId]?.discipline : null) ?? null;
}

/** Entity count: a file's own, a folder's summed over everything beneath it. */
export function entitiesOf(data: StudioData, n: RegisterNode): number | null {
  if (n.kind === 'file') {
    const sheet = n.sheetId ? data.sheets[n.sheetId] : null;
    return sheet ? sheet.entities : null;
  }
  let total = 0;
  let any = false;
  const walk = (nodes: RegisterNode[]) => {
    for (const c of nodes) {
      if (c.kind === 'folder') walk(c.children);
      else {
        const e = entitiesOf(data, c);
        if (e !== null) {
          total += e;
          any = true;
        }
      }
    }
  };
  walk(n.children);
  return any ? total : null;
}

/** "3 folders · 3 files" — what a folder holds, counted one level down. */
export function contentsLine(folder: RegisterFolderNode): string {
  const folders = folder.children.filter((c) => c.kind === 'folder').length;
  const files = folder.children.length - folders;
  const parts: string[] = [];
  if (folders) parts.push(`${folders} folder${folders === 1 ? '' : 's'}`);
  if (files) parts.push(`${files} file${files === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'Empty';
}

/**
 * The size column. A node that states its own meta wins — a Sections/ folder
 * carries its coverage ("8 items · 96.9%", §3.2) and that is more use here
 * than a re-counted item total.
 */
export function sizeLine(data: StudioData, n: RegisterNode): string {
  if (n.meta) return n.meta;
  if (n.kind === 'folder') {
    return `${n.children.length} item${n.children.length === 1 ? '' : 's'}`;
  }
  const entities = entitiesOf(data, n);
  if (entities !== null) return entities.toLocaleString('en-US');
  return n.tag ? n.tag.toUpperCase() : '—';
}

/**
 * "v2 of 3" — which version of its drawing this file is. Null when the
 * register holds only one, because a version number is only information when
 * there is another version it could have been.
 */
export function versionLine(n: RegisterNode): string | null {
  if (n.kind !== 'file' || !n.version || !n.versionCount || n.versionCount < 2) return null;
  return `v${n.version} of ${n.versionCount}`;
}

export function statusLabel(n: RegisterNode): string {
  if (n.kind === 'folder') return '—';
  const version = versionLine(n);
  const suffix = version ? ` · ${version}` : '';
  // A replaced revision says so first: it is still on file and still opens,
  // but "Current" would be a lie and it is the one thing this column may not
  // say about it.
  if (n.superseded) return `Superseded${suffix}`;
  if (n.state === 'warn') return `Needs review${suffix}`;
  if (n.state === 'busy') return 'Working';
  if (n.state === 'ok') return `Current${suffix}`;
  return `On file${suffix}`;
}

/**
 * WHERE THIS IS FILED, as distinct from what it is.
 *
 * A drawing has two folders and they are two different statements. Its
 * DISCIPLINE folder is derived: "Structural" is a consequence of what the
 * sheet is, re-computed from the drawings every render, and nothing is ever
 * filed there. A folder someone MADE is filing: it is where a person put this
 * drawing, and it is the answer to "where does this live".
 *
 * Reported separately from `locationOf` because merging them is what made the
 * discipline view look like a destination. Null when nobody has filed it —
 * which is a real answer, not a missing one: the drawing is filed by its
 * discipline alone.
 */
export function filingOf(data: StudioData, n: RegisterNode): string | null {
  const key = n.kind === 'file' ? (n.documentId ?? n.id) : n.id;
  const folders = data.groups.find((g) => g.id === 'g-folders')?.folders ?? [];
  const holding = folders.filter((f) =>
    f.children.some((c) => c.id === n.id || c.id === key),
  );
  if (!holding.length) return null;
  return holding.map((f) => f.name).join(' · ');
}

/** The folder holding this node — "Files" when it sits at the root. */
export function locationOf(data: StudioData, n: RegisterNode): string {
  const chain =
    n.kind === 'folder' ? folderPath(data, n.id).slice(0, -1) : pathToFile(data, n.id)?.path ?? [];
  if (!chain.length) return 'Files';
  return folderNameById(data, chain[chain.length - 1]);
}

function folderNameById(data: StudioData, id: string): string {
  const stack: RegisterFolderNode[] = data.groups.flatMap((g) => g.folders);
  while (stack.length) {
    const f = stack.pop()!;
    if (f.id === id) return f.name;
    f.children.forEach((c) => {
      if (c.kind === 'folder') stack.push(c);
    });
  }
  return 'Files';
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Sort key per column, as text — folders always lead, as in a file manager. */
/**
 * The most recent `at` in this node or anything under it — a folder has no
 * moment of its own (a discipline folder groups drawings imported over
 * months), but the newest thing inside it is a real, useful answer to "when
 * did this last change", the same way `entitiesOf` sums a folder's entities
 * from its children rather than printing nothing.
 */
function latestAt(n: RegisterNode): number | null {
  const own = typeof n.at === 'number' && Number.isFinite(n.at) ? n.at : null;
  if (n.kind === 'file') return own;
  let latest = own;
  for (const c of n.children) {
    const t = latestAt(c);
    if (t !== null && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

/**
 * When this node arrived, as a person reads a clock: "01 Sep 2026, 14:32".
 *
 * A drawing carries its import, an output its filing, a Sections/ folder the
 * moment its package was built — three different events, one honest column,
 * because "when did this land in the project" is the same question about all
 * three. A folder with no time of its own reports its newest child's; a node
 * that holds no time anywhere under it prints an em dash.
 */
export function dateLine(n: RegisterNode): string {
  const at = latestAt(n);
  if (at === null) return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '—';
  return `${DATE_FMT.format(d)}, ${TIME_FMT.format(d)}`;
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
// 24-hour, because a schedule log is read next to a site diary, not a phone.
const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function keyFor(data: StudioData, n: RegisterNode, sort: BrowseSort): string {
  switch (sort) {
    case 'rev':
      return revisionOf(n) ?? '';
    case 'number':
      return drawingNumber(data, n) ?? '';
    case 'type':
      return typeLabel(n);
    case 'discipline':
      return disciplineOf(data, n) ?? '';
    case 'size':
      // Entity counts compare as numbers, not as the strings they print as.
      return String(entitiesOf(data, n) ?? -1).padStart(12, '0');
    case 'status':
      return statusLabel(n);
    case 'date': {
      // Times compare as numbers, and by the SAME time the column prints —
      // sorting on `n.at` while `dateLine` fell back to the newest child had a
      // folder showing a date and sorting as though it had none. A node with
      // no time anywhere under it still sorts to the end of an ascending list
      // rather than pretending to be the oldest thing here.
      const at = latestAt(n);
      return at === null ? '9'.repeat(16) : String(at).padStart(16, '0');
    }
    default:
      return n.name;
  }
}

export function compareNodes(
  data: StudioData,
  a: RegisterNode,
  b: RegisterNode,
  sort: BrowseSort,
  desc: boolean,
): number {
  if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
  const primary = collator.compare(keyFor(data, a, sort), keyFor(data, b, sort));
  const ordered = desc ? -primary : primary;
  // Name is the tiebreak and it does not flip — two files with the same
  // revision stay in a stable, readable order whichever way the column points.
  return ordered || collator.compare(a.name, b.name);
}
