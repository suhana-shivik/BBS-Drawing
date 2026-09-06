// BIMCAD Studio — boot.
//
// Authentication comes first (§1): nothing private renders until Supabase says
// who this is. Then, per UI_REQUIREMENTS_UPDATE §2.3:
//   no projects         → Projects home, empty state
//   projects, none open → Projects home, cards
//   project open        → the studio shell, Files view first, nothing on canvas
//
// `?demo` in the URL swaps in the in-memory demo data, so the shell stays
// demoable without a project in the browser's store — and, deliberately,
// without an account: the demo carries no real project data.

import React, { useEffect, useMemo } from 'react';
import { StudioShell } from './components/StudioShell';
import { ProjectsHome } from './components/ProjectsHome';
import { AuthScreen } from './components/AuthScreen';
import { toast } from './components/Toasts';
import { demoStudioData } from './studio/demoData';
import { StudioDataContext } from './studio/data';
import { useRealStudioData } from './studio/realData';
import { useStudioProjects, type StudioProject } from './studio/projects';
import { StudioStore, StudioStoreContext, loadBoot, useStudio } from './studio/store';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import type { AuthAdapter } from './auth/types';
import { SUPABASE_SETUP_MESSAGE } from './lib/supabase';
import './components/AuthScreen.css';

function RealStudio({ store, project }: { store: StudioStore; project: StudioProject }) {
  const data = useRealStudioData(store, toast, project);
  return (
    <StudioDataContext.Provider value={data}>
      <StudioShell />
    </StudioDataContext.Provider>
  );
}

function Boot({ store }: { store: StudioStore }) {
  const activeId = useStudio((s) => s.project.activeId);
  const { projects, loaded } = useStudioProjects();

  // §2.3: reopen the last project at the last folder — once, on first load.
  useEffect(() => {
    if (!loaded || store.getState().project.activeId) return;
    const boot = loadBoot();
    if (!boot.lastProjectId) return;
    const last = projects.find((p) => p.id === boot.lastProjectId && !p.archived);
    if (last) store.openProject(last.id, boot.lastFolderPath);
  }, [loaded, projects, store]);

  const active = activeId ? projects.find((p) => p.id === activeId) : undefined;
  if (!active) return <ProjectsHome />;
  return <RealStudio store={store} project={active} />;
}

/** The app as it exists for ONE signed-in account. */
function SignedInApp() {
  // Keyed by user in `AuthGate`, so this store — and the active project it
  // holds — is built fresh per account. Signing out and back in as somebody
  // else can therefore not inherit the previous person's open project.
  const store = useMemo(() => new StudioStore(), []);
  return (
    <StudioStoreContext.Provider value={store}>
      <Boot store={store} />
    </StudioStoreContext.Provider>
  );
}

function SetupNeeded() {
  return (
    <div className="studio auth-screen" data-testid="auth-unconfigured">
      <div className="auth-bar">
        <span className="auth-brand">BIMCAD Studio</span>
      </div>
      <div className="auth-body">
        <div className="auth-setup">
          <h1>Supabase is not configured</h1>
          <p>{SUPABASE_SETUP_MESSAGE}</p>
          <p>
            Set <code>SUPABASE_URL</code> and <code>SUPABASE_PUBLISHABLE_KEY</code> in <code>.env</code>,
            then restart <code>npm run dev</code>.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The gate. A person who is not signed in never renders a component that
 * reads project data — this is the client half of the protection, and Row
 * Level Security in Postgres is the half that actually enforces it.
 */
function AuthGate() {
  const { status, user } = useAuth();

  if (status === 'loading') {
    return (
      <div className="studio auth-screen" data-testid="auth-loading">
        <div className="auth-bar">
          <span className="auth-brand">BIMCAD Studio</span>
        </div>
        <div className="auth-body">
          <p className="auth-booting">Checking your session…</p>
        </div>
      </div>
    );
  }
  if (status === 'unconfigured') return <SetupNeeded />;
  // `recovery` renders the auth screen too: a reset link creates a session,
  // and letting it into the app would skip the password change it was for.
  if (status !== 'signed-in' || !user) return <AuthScreen />;
  return <SignedInApp key={user.id} />;
}

/**
 * `authAdapter` exists so the boot states can be tested without a live
 * Supabase project — tests hand in a signed-in double. Production passes
 * nothing and `AuthProvider` builds the real Supabase adapter.
 */
export default function App({ authAdapter }: { authAdapter?: AuthAdapter } = {}) {
  const demo = useMemo(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo'),
    [],
  );

  if (demo) {
    const store = new StudioStore();
    return (
      <StudioStoreContext.Provider value={store}>
        <StudioDataContext.Provider value={demoStudioData}>
          <StudioShell />
        </StudioDataContext.Provider>
      </StudioStoreContext.Provider>
    );
  }

  return (
    <AuthProvider adapter={authAdapter}>
      <AuthGate />
    </AuthProvider>
  );
}
