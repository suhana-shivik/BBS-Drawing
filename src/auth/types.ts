// ============================================================
// The authentication seam.
//
// Everything the UI needs from an identity provider, expressed WITHOUT naming
// Supabase. Two reasons that matters:
//
//   · the auth screens can be tested with a fake adapter, so a form's
//     behaviour is provable without a network or a live project; and
//   · the one place that knows about Supabase is supabaseAdapter.ts, so the
//     rest of the app cannot accidentally grow a second client or a second
//     idea of what "signed in" means.
//
// Note what is NOT here: no password, hash, salt or token ever crosses this
// interface outward. The provider owns credentials; the app owns a session.
// ============================================================

export interface AuthUser {
  id: string;
  email: string | null;
  phone: string | null;
  fullName: string | null;
  /** false while a sign-up is waiting on the confirmation email */
  emailConfirmed: boolean;
}

/**
 * `recovery` is its own state on purpose. A password-reset link DOES create a
 * live session — that is how the new password can be set at all — so treating
 * it as a normal sign-in would drop someone into the app with their old
 * password still in force and the reset silently skipped.
 */
export type AuthStatus = 'loading' | 'signed-out' | 'signed-in' | 'recovery' | 'unconfigured';

export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
}

/** Every failure a person can be shown, already turned into a sentence. */
export interface AuthFailure {
  ok: false;
  message: string;
  /** set when the failure belongs against one field rather than the form */
  field?: 'email' | 'phone' | 'password' | 'confirmPassword';
}

export interface RegisterSuccess {
  ok: true;
  /**
   * True when the project requires email confirmation — there is no session
   * yet and the person must open the link before they can sign in. The screen
   * must say so; silently showing a sign-in form looks like the sign-up failed.
   */
  needsEmailConfirmation: boolean;
}

export type RegisterResult = RegisterSuccess | AuthFailure;
export type ActionResult = { ok: true } | AuthFailure;

export interface RegisterInput {
  email: string;
  phone: string;
  password: string;
  fullName?: string;
}

export interface AuthAdapter {
  /** The session as it stands right now, after any URL token has been consumed. */
  current(): Promise<AuthState>;
  /** Fires on sign-in, sign-out, token refresh and password recovery. Returns an unsubscribe. */
  subscribe(listener: (state: AuthState) => void): () => void;
  register(input: RegisterInput): Promise<RegisterResult>;
  signIn(email: string, password: string): Promise<ActionResult>;
  signOut(): Promise<ActionResult>;
  /** Sends the reset email. Resolves ok even when the address is unknown — see the note in the adapter. */
  requestPasswordReset(email: string, redirectTo: string): Promise<ActionResult>;
  /** Sets a new password for the session established by a recovery link. */
  updatePassword(password: string): Promise<ActionResult>;
  /** Re-sends the sign-up confirmation email. */
  resendConfirmation(email: string, redirectTo: string): Promise<ActionResult>;
}
