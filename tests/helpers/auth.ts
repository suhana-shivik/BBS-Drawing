// A controllable stand-in for the identity provider.
//
// The auth screens are worth testing — a form that swallows an error or fails
// to say "check your email" is a support ticket — and none of that needs a
// live Supabase project. This double records what it was asked to do, returns
// whatever the test tells it to, and can push a new session state at any time
// (which is how the password-recovery path is exercised).

import type {
  ActionResult,
  AuthAdapter,
  AuthState,
  AuthUser,
  RegisterInput,
  RegisterResult,
} from '../../src/auth/types';

export const TEST_USER: AuthUser = {
  id: 'user-1',
  email: 'someone@example.com',
  phone: '+919876543210',
  fullName: null,
  emailConfirmed: true,
};

export interface FakeAuthAdapter extends AuthAdapter {
  /** Push a new session state to every subscriber, as the provider would. */
  emit(state: AuthState): void;
  /** What the screens asked for, in order. */
  calls: {
    register: RegisterInput[];
    signIn: { email: string; password: string }[];
    signOut: number;
    reset: { email: string; redirectTo: string }[];
    updatePassword: string[];
    resend: string[];
  };
  /** What to answer next. Set before the action under test. */
  results: {
    register: RegisterResult;
    signIn: ActionResult;
    signOut: ActionResult;
    reset: ActionResult;
    updatePassword: ActionResult;
    resend: ActionResult;
  };
}

export function fakeAuthAdapter(initial: AuthState = { status: 'signed-out', user: null }): FakeAuthAdapter {
  let state = initial;
  const listeners = new Set<(s: AuthState) => void>();

  const adapter: FakeAuthAdapter = {
    calls: { register: [], signIn: [], signOut: 0, reset: [], updatePassword: [], resend: [] },
    results: {
      register: { ok: true, needsEmailConfirmation: true },
      signIn: { ok: true },
      signOut: { ok: true },
      reset: { ok: true },
      updatePassword: { ok: true },
      resend: { ok: true },
    },
    emit(next) {
      state = next;
      for (const l of [...listeners]) l(next);
    },
    async current() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async register(input) {
      adapter.calls.register.push(input);
      return adapter.results.register;
    },
    async signIn(email, password) {
      adapter.calls.signIn.push({ email, password });
      if (adapter.results.signIn.ok) {
        adapter.emit({ status: 'signed-in', user: { ...TEST_USER, email } });
      }
      return adapter.results.signIn;
    },
    async signOut() {
      adapter.calls.signOut += 1;
      return adapter.results.signOut;
    },
    async requestPasswordReset(email, redirectTo) {
      adapter.calls.reset.push({ email, redirectTo });
      return adapter.results.reset;
    },
    async updatePassword(password) {
      adapter.calls.updatePassword.push(password);
      return adapter.results.updatePassword;
    },
    async resendConfirmation(email) {
      adapter.calls.resend.push(email);
      return adapter.results.resend;
    },
  };
  return adapter;
}

/** The common case: an account already signed in. */
export function signedInAdapter(user: AuthUser = TEST_USER): FakeAuthAdapter {
  return fakeAuthAdapter({ status: 'signed-in', user });
}
