// Title bar (34px) — three things only: the product name on the left, the open
// document named once in the centre, layout controls on the right
// (STUDIO_DESIGN §4.1). No cube glyph, no second "BIMCAD Studio" in the centre,
// no window buttons — the browser frame owns minimise and maximise.
// There is no text menu bar. Everything it held is reachable where it applies:
// undo/redo on Ctrl+Z / Ctrl+Y (StudioShell), Delete and Esc straight to the
// editor, panels and theme on the buttons right, import in the register, the
// schedules on the detail-panel tabs, drafting tools under the drawing.

import React from 'react';
import { useStudioData } from '../studio/data';
import { openProjectInStore, recentProjectIds, useStudioProjects } from '../studio/projects';
import { useStudio, useStudioStore } from '../studio/store';
import { Icon } from './icons';
import { Menu, type MenuEntry } from './Menu';
import { AccountMenu } from './AccountMenu';
import { REGISTER_SEARCH_ID } from './RegisterPanel';

export function TitleBar() {
  const data = useStudioData();
  const store = useStudioStore();
  const { ui, sheets, activeProjectId } = useStudio((s) => ({
    ui: s.ui,
    sheets: s.sheets,
    activeProjectId: s.project.activeId,
  }));
  const sheet = sheets.active ? data.sheets[sheets.active] : null;

  // R1 §1.3 — the project name in the title bar is a menu: recent projects,
  // All projects…, New project…. Ctrl+P (ui.switcherOpen) opens it too.
  const { projects } = useStudioProjects();
  const switcherRef = React.useRef<HTMLButtonElement>(null);
  const [switcherAnchor, setSwitcherAnchor] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    if (ui.switcherOpen && switcherRef.current) setSwitcherAnchor(switcherRef.current);
    else if (!ui.switcherOpen) setSwitcherAnchor(null);
  }, [ui.switcherOpen]);
  const closeSwitcher = React.useCallback(() => store.setSwitcherOpen(false), [store]);

  const recents = React.useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p] as const));
    const ordered = recentProjectIds()
      .map((id) => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => !!p && !p.archived);
    for (const p of projects) {
      if (!p.archived && !ordered.some((o) => o.id === p.id)) ordered.push(p);
    }
    return ordered.filter((p) => p.id !== activeProjectId).slice(0, 6);
  }, [projects, activeProjectId, ui.switcherOpen]);

  const switcherItems: MenuEntry[] = [
    { kind: 'title', label: 'Switch project' },
    ...(recents.length
      ? recents.map(
          (p): MenuEntry => ({
            label: p.name,
            icon: 'folder',
            onSelect: () => openProjectInStore(store, p.id),
          }),
        )
      : [{ kind: 'note', label: 'No other projects yet.' } as MenuEntry]),
    { kind: 'divider' },
    { label: 'All projects…', onSelect: () => store.closeProject() },
    { label: 'New project…', onSelect: () => store.closeProject(true) },
  ];

  return (
    <header className="titlebar">
      <span className="tb-brand">BIMCAD Studio</span>

      <span className="tb-title" data-testid="tb-title">
        {sheet ? (
          <>
            <b>{sheet.tab}</b>
            {' — '}
          </>
        ) : null}
        <button
          ref={switcherRef}
          type="button"
          className="tb-project"
          data-testid="project-switcher"
          title="Switch project — Ctrl+P"
          aria-haspopup="menu"
          aria-expanded={switcherAnchor !== null}
          onClick={() => store.setSwitcherOpen(!ui.switcherOpen)}
        >
          {data.projectName}
          <Icon name="chevronDown" size={11} />
        </button>
      </span>
      {switcherAnchor && <Menu anchor={switcherAnchor} onClose={closeSwitcher} items={switcherItems} />}

      <div className="tb-right">
        <button
          type="button"
          className={`tb-btn${ui.treeOpen ? ' on' : ''}`}
          aria-pressed={ui.treeOpen}
          title="Register panel"
          data-testid="toggle-tree"
          onClick={() => store.toggleTree()}
        >
          <Icon name="panelLeft" />
        </button>
        <button
          type="button"
          className={`tb-btn${ui.toolsOpen ? ' on' : ''}`}
          aria-pressed={ui.toolsOpen}
          title="Tool strip"
          data-testid="toggle-tools"
          onClick={() => store.toggleTools()}
        >
          <Icon name="panelBottom" />
        </button>
        {/* With a drawing open the right column is the assistant, and it is
            not on screen until it is asked for — so the button that asks says
            so, in words, and only here. Browsing, the same column is the
            properties pane and keeps its panel toggle. */}
        {ui.stageMode === 'sheet' ? (
          <button
            type="button"
            className={`tb-btn tb-wide${ui.assistantOpen ? ' on' : ''}`}
            aria-pressed={ui.assistantOpen}
            title={
              ui.assistantOpen
                ? 'Hide the assistant'
                : 'Show the assistant — drawing detail and Ask'
            }
            data-testid="toggle-assistant"
            onClick={() => store.toggleDock()}
          >
            Assistant
          </button>
        ) : (
          <button
            type="button"
            className={`tb-btn${ui.dockOpen ? ' on' : ''}`}
            aria-pressed={ui.dockOpen}
            title="Detail panel"
            data-testid="toggle-dock"
            onClick={() => store.toggleDock()}
          >
            <Icon name="panelRight" />
          </button>
        )}
        <button
          type="button"
          className="tb-btn"
          title="Search the project"
          onClick={() => {
            if (!ui.treeOpen) store.toggleTree();
            document.getElementById(REGISTER_SEARCH_ID)?.focus();
          }}
        >
          <Icon name="search" />
        </button>
        <span className="tb-sep" />
        <button
          type="button"
          className="tb-btn"
          title={ui.theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
          onClick={() => store.setTheme(ui.theme === 'dark' ? 'light' : 'dark')}
        >
          <Icon name={ui.theme === 'dark' ? 'moon' : 'sun'} />
        </button>
        {/* Who this is, and the way out. Compact here — the title bar is 34px
            and already carries the project switcher. */}
        <AccountMenu compact />
      </div>
    </header>
  );
}
