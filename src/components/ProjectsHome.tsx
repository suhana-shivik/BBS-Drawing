// R1 — the Projects home (§1.3): the landing surface when no project is open.
//
// A card is a SUMMARY OF MEMORY: drawing count off the stored register, steel
// tonnage off the latest filed BBS artifact, open questions off the fact
// ledger. Nothing is recomputed for a card; a figure that is not cheaply on
// file is omitted rather than estimated.

import React, { useEffect, useState } from 'react';
import {
  createStudioProject,
  openProjectInStore,
  projectCardSummary,
  setProjectArchived,
  useStudioProjects,
  type ProjectCardSummary,
  type StudioProject,
} from '../studio/projects';
import { useStudio, useStudioStore } from '../studio/store';
import { Icon } from './icons';
import { Menu, useMenuAnchor } from './Menu';
import { AccountMenu } from './AccountMenu';
import './ProjectsHome.css';

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function ProjectCard({ project, onOpen }: { project: StudioProject; onOpen: () => void }) {
  const [summary, setSummary] = useState<ProjectCardSummary | null>(null);
  const menu = useMenuAnchor();

  useEffect(() => {
    let alive = true;
    void projectCardSummary(project.id).then((s) => {
      if (alive) setSummary(s);
    });
    return () => {
      alive = false;
    };
  }, [project.id]);

  const subtitle = [project.client, project.projectNumber].filter(Boolean).join(' · ');

  return (
    <div
      className={`ph-card${project.archived ? ' archived' : ''}`}
      data-testid={`project-card-${project.id}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
    >
      <span className="name">{project.name}</span>
      {subtitle && <span className="client">{subtitle}</span>}
      <span className="stats">
        {summary?.drawings !== null && summary?.drawings !== undefined && (
          <span>
            {summary.drawings} drawing{summary.drawings === 1 ? '' : 's'}
            {summary.tonnageT !== null &&
              ` · ${summary.tonnageT.toLocaleString('en-IN', { maximumFractionDigits: 2 })} t steel`}
          </span>
        )}
        {summary?.openQuestions !== null && summary?.openQuestions !== undefined && summary.openQuestions > 0 && (
          <span className="warned">
            {summary.openQuestions} open question{summary.openQuestions === 1 ? '' : 's'}
          </span>
        )}
      </span>
      <span className="opened">
        {project.archived ? 'archived · ' : ''}opened {relativeTime(project.modifiedAt)}
      </span>
      <span className="card-menu" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="ibtn" aria-label={`Actions for ${project.name}`} onClick={menu.toggle}>
          <Icon name="dots" size={13} />
        </button>
        {menu.open && menu.anchor && (
          <Menu
            anchor={menu.anchor}
            onClose={menu.close}
            align="right"
            items={[
              { label: 'Open', icon: 'folder', onSelect: onOpen },
              {
                label: 'Duplicate structure',
                disabled: true,
                title:
                  'Would copy folders and the format profile, no drawings — it arrives with the format profile, and nothing is copied yet.',
              },
              { kind: 'divider' },
              {
                label: project.archived ? 'Unarchive' : 'Archive',
                icon: 'layers',
                onSelect: () => void setProjectArchived(project.id, !project.archived),
              },
            ]}
          />
        )}
      </span>
    </div>
  );
}

function NewProjectForm({ onDone, onCancel }: { onDone: (p: StudioProject) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const project = await createStudioProject({ name, client, projectNumber: number });
    onDone(project);
  };

  return (
    // The backdrop is the cancel affordance as well as the dimmer: a click on
    // it — and only on it, never on a click that started inside the card —
    // closes the form, the same as Escape.
    <div
      className="ph-modal"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="ph-new"
        role="dialog"
        aria-modal="true"
        aria-labelledby="np-heading"
        data-testid="new-project-form"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      >
        <h2 id="np-heading">New project</h2>
        <p className="ph-new-sub">A project holds one drawing set, its register and its schedules.</p>
        <label htmlFor="np-name">Name</label>
        <input
          id="np-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
            if (e.key === 'Escape') onCancel();
          }}
          placeholder="GAMCO Boundary Wall"
        />
        <label htmlFor="np-client">Client (optional)</label>
        <input id="np-client" value={client} onChange={(e) => setClient(e.target.value)} placeholder="GAMCO Infratech" />
        <label htmlFor="np-number">Project number (optional)</label>
        <input id="np-number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="2026-014" />
        <div className="row">
          <button type="button" className="btn primary" disabled={!name.trim() || busy} onClick={() => void create()}>
            Create project
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * §2.3 states 1 and 2: no projects → empty state whose one action is New
 * project; projects but none open → the card grid. Opening a project is the
 * only way off this screen. No wizard: a new project lands straight in its
 * empty Files view, whose empty state is the import affordance.
 */
export function ProjectsHome() {
  const store = useStudioStore();
  const wantNew = useStudio((s) => s.project.wantNew);
  const theme = useStudio((s) => s.ui.theme);
  const { projects, loaded, error } = useStudioProjects();
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // R1 — no project open, so the window is just the app.
  useEffect(() => {
    document.title = 'BIMCAD Studio';
  }, []);

  useEffect(() => {
    if (wantNew) {
      setCreating(true);
      store.clearWantNew();
    }
  }, [wantNew, store]);

  const open = (p: StudioProject) => openProjectInStore(store, p.id);
  const visible = projects.filter((p) => showArchived || !p.archived);
  const archivedCount = projects.filter((p) => p.archived).length;

  return (
    <div className="studio projects-home" data-testid="projects-home">
      <div className="ph-bar">
        <span className="ph-logo" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1.5 14 5v6l-6 3.5L2 11V5Z" />
            <path d="M2 5l6 3.5L14 5M8 8.5V14.5" />
          </svg>
        </span>
        <span className="ph-title">BIMCAD Studio</span>
        <span className="spacer" />
        <AccountMenu />
      </div>

      <div className="ph-body">
        {/* A backing-store failure is NOT an empty account. Saying so here is
            what stops someone with a schema that was never installed from
            concluding their projects are gone and starting again. */}
        {error && (
          <p className="ph-error" role="alert" data-testid="projects-error">
            {error}
          </p>
        )}
        <div className="ph-head">
          <h1>Projects</h1>
          {loaded && projects.length > 0 && (
            <span className="sub">
              {projects.length} project{projects.length === 1 ? '' : 's'}
            </span>
          )}
          <span className="spacer" />
          {archivedCount > 0 && (
            <button type="button" className="btn" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? 'Hide archived' : `Archived (${archivedCount})`}
            </button>
          )}
          {loaded && projects.length > 0 && (
            <button type="button" className="btn primary" onClick={() => setCreating(true)}>
              New project
            </button>
          )}
        </div>

        {creating && (
          <NewProjectForm
            onDone={(p) => {
              setCreating(false);
              open(p);
            }}
            onCancel={() => setCreating(false)}
          />
        )}

        {!loaded ? null : projects.length === 0 ? (
          <div className="ph-empty" data-testid="projects-empty">
            <span className="vt">No projects yet</span>
            <span className="vs">
              A project holds a drawing set, its register, its sections and everything the
              drawings have answered. Make one, then import the first drawing.
            </span>
            <button type="button" className="btn primary" onClick={() => setCreating(true)}>
              New project
            </button>
          </div>
        ) : (
          <div className="ph-grid" data-testid="projects-grid">
            {visible.map((p) => (
              <ProjectCard key={p.id} project={p} onOpen={() => open(p)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
