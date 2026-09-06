// ============================================================
// The session, as the rest of the app sees it.
//
// One subscription for the whole application. Supabase refreshes the access
// token on a timer and broadcasts sign-in and sign-out across browser tabs;
// every component that cared independently would mean N listeners racing to
// set N copies of the same state. This owns it once and hands it down.
//
// `adapter` is injectable so the auth screens can be tested against a fake —
// see tests/frontend/auth-screen.test.tsx. Production passes nothing and gets
// the Supabase adapter.
// ============================================================
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createSupabaseAuthAdapter } from './supabaseAdapter';
import { clearAccountLocalState } from './localState';
import { clearCache } from '../cad/store';
import { resetDrawingIdMap } from '../data/drawings';
import { resetSectionIdMap } from '../data/sections';
import { resetFolderHydration } from '../register/folders';
import type { ActionResult, AuthAdapter, AuthState, RegisterInput, RegisterResult } from './types';

export interface AuthContextValue extends AuthState {
  register(input: RegisterInput): Promise<RegisterResult>;
  signIn(email: string, password: string): Promise<ActionResult>;
  signOut(): Promise<ActionResult>;
  requestPasswordReset(email: string): Promise<ActionResult>;
  updatePassword(password: string): Promise<ActionResult>;
  resendConfirmation(email: string): Promise<ActionResult>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Where a reset or confirmation link comes back to.
 *
 * The live origin, not a configured URL: the app runs on 5174 in dev, on
 * whatever host it is deployed to in production, and a hardcoded address
 * sends people to the wrong one of those. The origin must also be listed in
 * the Supabase project's redirect allowlist, or the link will refuse it.
 */
function appOrigin(): string {
  return typeof window !== 'undefined' ? window.location.origin : '';
}

export function AuthProvider({
  adapter,
  children,
}: {
  adapter?: AuthAdapter;
  children: React.ReactNode;
}) {
  const auth = useMemo(() => adapter ?? createSupabaseAuthAdapter(), [adapter]);
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null });
  // React 18 StrictMode mounts effects twice in development. Without this the
  // second mount's `current()` can resolve after the first mount's unsubscribe
  // has already run, writing a stale state over a fresh one.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void auth.current().then((s) => {
      if (alive.current) setState(s);
    });
    const off = auth.subscribe((s) => {
      if (alive.current) setState(s);
    });
    return () => {
      alive.current = false;
      off();
    };
  }, [auth]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      register: (input) => auth.register(input),
      signIn: (email, password) => auth.signIn(email, password),
      signOut: async () => {
        const result = await auth.signOut();
        if (result.ok) {
          // The local caches go with the session. Several of them are keyed by
          // drawing file name rather than by account, so leaving them would
          // hand one person's working notes to the next person who signs in on
          // this browser. See auth/localState.ts.
          clearAccountLocalState();
          // and the session's documentId → database-row correspondences, which
          // are one account's and would otherwise point the next account's
          // writes at rows it cannot touch.
          resetDrawingIdMap();
          resetSectionIdMap();
          // AND THE INDEXEDDB CACHE. Its stores are keyed by project, not by
          // user, so the next person to sign in on this browser would open the
          // last person's drawings straight out of it. Everything in there is
          // a copy of something in Postgres and is refetched on the next open.
          // Not awaited: sign-out must not wait on a local database, and the
          // session is already gone by the time this settles.
          void clearCache();
          // and the "this project's folders are already reconciled" marks, so
          // the next account reads its OWN folders rather than trusting the
          // snapshot the last one left in this browser.
          resetFolderHydration();
          // Do not wait for the broadcast: a slow network would leave the app
          // showing private data behind a button already pressed.
          setState({ status: 'signed-out', user: null });
        }
        return result;
      },
      requestPasswordReset: (email) => auth.requestPasswordReset(email, appOrigin()),
      updatePassword: async (password) => {
        const result = await auth.updatePassword(password);
        // The recovery session becomes an ordinary one the moment the new
        // password is set — otherwise the reset screen would never close.
        if (result.ok) setState((prev) => (prev.status === 'recovery' ? { ...prev, status: 'signed-in' } : prev));
        return result;
      },
      resendConfirmation: (email) => auth.resendConfirmation(email, appOrigin()),
    }),
    [auth, state],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * For anything whose behaviour DEPENDS on who is signed in. Throws outside a
 * provider on purpose: a missing gate is a privacy bug, and it should surface
 * as a loud failure rather than as a component quietly rendering as though
 * nobody were signed in.
 */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth was called outside an <AuthProvider>.');
  return value;
}

/**
 * For CHROME that merely displays the account — the badge in a title bar.
 * Returns null outside a provider so those surfaces can still be rendered on
 * their own (the shell's own tests do exactly that) without every one of them
 * having to stand up a session first. Never use this to decide what data to
 * show; use `useAuth`.
 */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}
