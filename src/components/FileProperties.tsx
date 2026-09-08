// The dock while the Files view is up: an Explorer properties pane over the
// browser's selection (§4.3). It answers the question the list leaves open —
// "what IS this thing, and what is inside it" — for whatever is selected, or
// for the folder itself when nothing is.

import React from 'react';
import {
  contentsLine,
  dateLine,
  disciplineOf,
  drawingNumber,
  entitiesOf,
  extOf,
  filingOf,
  locationOf,
  revisionOf,
  statusLabel,
  typeLabel,
  versionLine,
} from '../studio/browse';
import { findFolder, type NodeState, type RegisterNode, useStudioData } from '../studio/data';
import { useStudio, useStudioStore } from '../studio/store';
import { Icon } from './icons';
import { toast } from './Toasts';

/** Past this a list stops summarising. Everything is one click away in the list. */
const CONTENTS_SHOWN = 12;

const count = (n: number): string => n.toLocaleString('en-US');

/** The state dot's colour, said in words on the status chip. */
const STATE_TONE: Record<NodeState, string> = {
  ok: 'ok',
  warn: 'warn',
  busy: 'info',
  idle: '',
};

/**
 * One property row. `mono` is for values that are codes or figures — a drawing
 * number, an entity count. Prose like "Folder" or "Structural" used to be set
 * in the mono face too, which made the whole pane read like machine output.
 */
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined} title={value}>
        {value}
      </dd>
    </>
  );
}

export function FileProperties() {
  const data = useStudioData();
  const store = useStudioStore();
  const browse = useStudio((s) => s.browse);

  const folder = browse.path.length
    ? findFolder(data, browse.path[browse.path.length - 1])
    : null;
  const siblings: RegisterNode[] = folder
    ? folder.children
    : data.groups.flatMap((g) => g.folders);
  const picked = siblings.filter((n) => browse.selection.includes(n.id));

  // Nothing selected reads as the folder you are standing in — the same thing
  // the breadcrumb and the status bar are already talking about.
  const node: RegisterNode | null = picked.length === 1 ? picked[0] : picked.length ? null : folder;
  const sheet = node?.kind === 'file' && node.sheetId ? data.sheets[node.sheetId] : null;

  if (picked.length > 1) {
    const folders = picked.filter((p) => p.kind === 'folder').length;
    const entities = picked.reduce((n, p) => n + (entitiesOf(data, p) ?? 0), 0);
    return (
      <section className="dock-panel prop-pane" role="tabpanel" data-testid="file-properties">
        <div className="prop-ident">
          <span className="prop-mark multi" aria-hidden="true">
            <Icon name="layers" size={19} />
          </span>
          <div className="doc-head">
            <h2 className="doc-title">{picked.length} items selected</h2>
            <span className="doc-sub">{folder?.name ?? 'Files'}</span>
          </div>
        </div>
        <div className="section">
          <h3>
            Selection <span className="rule" />
          </h3>
          <dl className="kv">
            <Row label="Items" value={count(picked.length)} mono />
            <Row label="Folders" value={count(folders)} mono />
            <Row label="Files" value={count(picked.length - folders)} mono />
            <Row label="Entities" value={entities ? count(entities) : '—'} mono />
          </dl>
        </div>
      </section>
    );
  }

  if (!node) {
    return (
      <section className="dock-panel prop-pane" role="tabpanel" data-testid="file-properties">
        <div className="dock-void">
          <span className="prop-mark void" aria-hidden="true">
            <Icon name="file" size={18} />
          </span>
          <span className="vt">Nothing selected</span>
          <span className="vs">Pick a folder or a drawing in the list to see what is on file against it.</span>
        </div>
      </section>
    );
  }

  const entities = entitiesOf(data, node);
  const number = drawingNumber(data, node);
  const rev = revisionOf(node);
  const version = versionLine(node);
  const discipline = disciplineOf(data, node);
  const filing = filingOf(data, node);
  const children = node.kind === 'folder' ? node.children : [];
  const shown = children.slice(0, CONTENTS_SHOWN);
  const hidden = children.length - shown.length;

  const open = (n: RegisterNode) => {
    if (n.kind === 'folder') {
      store.browseTo([...browse.path, n.id]);
      return;
    }
    if (n.sheetId) {
      store.openSheet(n.sheetId);
      return;
    }
    // A filed output opens as the version it is, on the tab that renders it —
    // the same route the list takes, so the pane and the row agree.
    if (n.artifactId) {
      store.setStageMode('sheet');
      store.openArtifact(n.artifactId);
      return;
    }
    if (n.dockTab) {
      store.setStageMode('sheet');
      store.setDockTab(n.dockTab);
      return;
    }
    toast(`${n.name} opens outside the studio.`);
  };

  /** Hand over a filed schedule; say what landed, or why nothing did. */
  const download = (artifactId: string, format: 'xlsx' | 'csv') => {
    if (!data.actions) {
      toast('Downloads land with the real register.', 'warn');
      return;
    }
    const name = data.actions.downloadArtifact(artifactId, format);
    toast(name ? `Downloaded ${name}` : 'That schedule could not be read back.', name ? 'ok' : 'warn');
  };

  return (
    <section className="dock-panel prop-pane" role="tabpanel" data-testid="file-properties">
      {/* Only a parsed drawing has something worth showing big. A folder used to
          get the same 132px box with a cartoon folder floating in it — dead
          space above the one line anybody reads, the name. */}
      {sheet ? (
        <div className="prop-preview file">
          <span
            className="prop-sheet"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: sheet.svg }}
          />
        </div>
      ) : null}

      <div className="prop-ident">
        {sheet ? null : (
          <span className={`prop-mark ${node.kind}`} aria-hidden="true">
            {node.kind === 'folder' ? (
              <Icon name="folder" size={20} />
            ) : (
              <span className="ext">{extOf(node).toUpperCase()}</span>
            )}
          </span>
        )}
        <div className="doc-head">
          <h2 className="doc-title" title={node.name}>
            {node.name}
          </h2>
          <span className="doc-sub">
            {typeLabel(node)} · {filing ?? locationOf(data, node)}
          </span>
        </div>
      </div>

      {/* Revision, state and trade, read at a glance instead of hunted for in
          the grid — they are the three things a register is asked about. */}
      {node.kind === 'file' ? (
        <div className="prop-chips" style={{marginTop:"10px"}}>
          {rev ? <span className={`chip-s${node.current ? ' info' : ''}`}>REV {rev}</span> : null}
          {version ? <span className="chip-s">{version}</span> : null}
          <span className={`chip-s ${STATE_TONE[node.state]}`}>{statusLabel(node)}</span>
          {discipline ? <span className="chip-s">{discipline}</span> : null}
        </div>
      ) : null}

      <div className="section">
        <h3>
          Properties <span className="rule" />
        </h3>
        <dl className="kv">
          <Row label="Name" value={node.name} />
          <Row label="Type" value={typeLabel(node)} />
          {/* TWO ROWS, NOT ONE, and never merged again.
              Filing is where a person put this drawing. Discipline is what the
              sheet is, read off its title block. Showing only the folder the
              tree happened to list it under first said "Structural" to both
              questions and made a derived view look like a destination. */}
          <Row label="Filing" value={filing ?? 'Not filed — by discipline only'} />
          {node.kind === 'file' ? (
            <Row label="Discipline" value={discipline ?? '—'} />
          ) : (
            <Row label="Location" value={locationOf(data, node)} />
          )}
          {node.kind === 'folder' ? (
            <Row label="Contains" value={contentsLine(node)} />
          ) : (
            <Row label="Drawing no." value={number ?? '—'} mono />
          )}
          <Row label="Entities" value={entities === null ? '—' : count(entities)} mono />
          <Row label="Added" value={dateLine(node)} mono />
          {version ? <Row label="Version" value={version} mono /> : null}
          {/* A file dropped in twice makes no new version — but the action was
              real, and a register that showed no trace of it would look as
              though the upload had failed. */}
          {node.kind === 'file' && node.reuploadedAt ? (
            <Row label="Re-uploaded" value={dateLine({ ...node, at: node.reuploadedAt })} mono />
          ) : null}
        </dl>
        {node.kind === 'file' && sheet?.extractLine ? (
          <div className="extract-line">{sheet.extractLine}</div>
        ) : null}
      </div>

      {children.length ? (
        <div className="section">
          <h3>
            Contents <span className="tally">{children.length}</span> <span className="rule" />
          </h3>
          <ul className="prop-contents">
            {shown.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => open(c)} onDoubleClick={() => open(c)}>
                  <span className={`row-ic ${c.kind}`}>
                    <Icon name={c.kind === 'folder' ? 'folder' : 'file'} size={13} />
                  </span>
                  <span className="nm">{c.name}</span>
                  <span className="go" aria-hidden="true">
                    <Icon name="chevronRight" size={11} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {hidden > 0 ? <p className="prop-more">+{count(hidden)} more in the list</p> : null}
        </div>
      ) : null}

      {node.kind === 'file' ? (
        <div className="section">
          {/* A filed schedule is a deliverable: the folder names it .xlsx, so
              the pane hands over that exact file rather than sending the
              reader off to find a download somewhere else (§6.2). */}
          {node.artifactId ? (
            <div className="prop-actions">
              {node.dockTab === 'bbs' ? (
                <button
                  type="button"
                  className="prop-open"
                  data-testid="expand-bbs-prop"
                  title="Complete the rows that are still blocked, mismatched or assumed"
                  onClick={() => store.openBbsEditor(node.artifactId!)}
                >
                  <Icon name="expand" size={13} />
                  <span className="nm">Expand / Edit</span>
                </button>
              ) : null}
              <button
                type="button"
                className="prop-open ghost"
                onClick={() => download(node.artifactId!, 'xlsx')}
              >
                <Icon name="download" size={13} />
                <span className="nm">Download Excel</span>
              </button>
              <button
                type="button"
                className="prop-open ghost"
                title="The same grid as CSV"
                onClick={() => download(node.artifactId!, 'csv')}
              >
                CSV
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className={node.artifactId ? 'prop-open ghost wide' : 'prop-open'}
            onClick={() => open(node)}
          >
            <Icon name="expand" size={13} />
            <span className="nm">Open {node.name}</span>
          </button>
        </div>
      ) : null}
    </section>
  );
}
