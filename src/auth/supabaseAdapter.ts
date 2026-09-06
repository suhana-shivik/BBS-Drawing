// ============================================================
// The one module that knows authentication is Supabase.
//
// Its whole job is translation: Supabase sessions and AuthErrors in, the
// app's AuthState and readable sentences out. Nothing else imports
// `supabase().auth`.
//
// ON ERROR MESSAGES. A provider error is written for a developer reading a
// log ("Invalid login credentials", "AuthApiError: over_email_send_rate_limit")
// and is shown, unedited, to a person who is simply trying to get in. Each one
// is mapped to a sentence that says what happened and what to do — except
// where saying so would leak whether an account exists, which is the one case
// vagueness is the correct answer.
// ============================================================
import type { AuthError, Session, User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import type {
  ActionResult,
  AuthAdapter,
  AuthState,
  AuthUser,
  RegisterInput,
  RegisterResult,
} from './types';
import { normaliseEmail, normalisePhone } from './validate';

function userOf(user: User | null | undefined): AuthUser | null {
  if (!user) return null;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    id: user.id,
    email: user.email ?? null,
    phone: str(meta.phone) ?? user.phone ?? null,
    fullName: str(meta.full_name),
    emailConfirmed: Boolean(user.email_confirmed_at ?? user.confirmed_at),
  };
}

function stateOf(session: Session | null, recovery = false): AuthState {
  if (!session) return { status: 'signed-out', user: null };
  return { status: recovery ? 'recovery' : 'signed-in', user: userOf(session.user) };
}

/**
 * A provider error as a sentence worth reading.
 *
 * Matched on the stable `code` where Supabase sends one, and on the message
 * only as a fallback — messages are prose and change between releases.
 */
export function describeAuthError(error: AuthError | null, fallback: string): string {
  if (!error) return fallback;
  const code = (error as AuthError & { code?: string }).code ?? '';
  const message = error.message ?? '';
  const says = (re: RegExp): boolean => re.test(code) || re.test(message);

  if (says(/invalid_credentials|Invalid login credentials/i)) {
    return 'That email and password do not match an account. Check both, or use "Forgot password".';
  }
  if (says(/email_not_confirmed|Email not confirmed/i)) {
    return 'This account has not been confirmed yet. Open the link in the confirmation email, then sign in.';
  }
  if (says(/user_already_exists|User already registered/i)) {
    return 'An account already exists for that email. Sign in instead, or reset the password.';
  }
  if (says(/weak_password|Password should be/i)) {
    return 'That password was refused as too weak. Use at least 8 characters with a letter and a number.';
  }
  if (says(/same_password|should be different from the old password/i)) {
    return 'That is the password the account already has. Choose a different one.';
  }
  // The EMAIL limit and the REQUEST limit are different problems with
  // different remedies, and saying "too many attempts" for the first one sends
  // people to retry the thing that cannot succeed. Supabase's built-in mailer
  // allows only a handful of messages an hour, so a project that still
  // requires email confirmation hits this after two or three sign-ups —
  // including sign-ups for an address that already has an unconfirmed account,
  // because each one re-sends the confirmation.
  if (says(/over_email_send_rate_limit/i)) {
    return (
      'The confirmation email could not be sent — this project has reached its hourly email limit. ' +
      'If you already registered, sign in instead (or use "Forgot password"). Otherwise wait an hour, ' +
      'or turn off email confirmation for this project so no email is needed.'
    );
  }
  if (says(/over_request_rate_limit|rate limit/i)) {
    return 'Too many attempts in a short time. Wait a minute and try again.';
  }
  if (says(/session_not_found|Auth session missing|invalid_token|expired/i)) {
    return 'That link has expired or has already been used. Request a new password reset email.';
  }
  if (says(/signup_disabled|Signups not allowed/i)) {
    return 'New sign-ups are disabled on this Supabase project. Enable email sign-ups in Authentication → Providers.';
  }
  if (says(/Failed to fetch|NetworkError|fetch failed/i)) {
    return 'Could not reach the authentication service. Check the network and that SUPABASE_URL is correct.';
  }
  return message || fallback;
}

export function createSupabaseAuthAdapter(): AuthAdapter {
  return {
    async current(): Promise<AuthState> {
      if (!isSupabaseConfigured()) return { status: 'unconfigured', user: null };
      // getSession also finishes consuming a token that arrived in the URL
      // (confirmation or recovery), because the client was built with
      // detectSessionInUrl.
      const { data } = await supabase().auth.getSession();
      return stateOf(data.session ?? null);
    },

    subscribe(listener) {
      if (!isSupabaseConfigured()) {
        listener({ status: 'unconfigured', user: null });
        return () => {};
      }
      const { data } = supabase().auth.onAuthStateChange((event, session) => {
        // PASSWORD_RECOVERY arrives WITH a session. Surfacing it as a normal
        // sign-in is the bug this branch exists to prevent: the person would
        // land in the app, never be asked for a new password, and the reset
        // they asked for would quietly not happen.
        listener(stateOf(session ?? null, event === 'PASSWORD_RECOVERY'));
      });
      return () => data.subscription.unsubscribe();
    },

    async register(input: RegisterInput): Promise<RegisterResult> {
      if (!isSupabaseConfigured()) return { ok: false, message: 'Supabase is not configured.' };
      const email = normaliseEmail(input.email);
      const phone = normalisePhone(input.phone);
      const { data, error } = await supabase().auth.signUp({
        email,
        password: input.password,
        options: {
          // The phone rides in user metadata, and the database trigger copies
          // it into `profiles`. It is NOT a phone sign-in factor: this project
          // has phone auth disabled, and pretending otherwise would send an
          // SMS OTP nobody configured a provider for.
          data: {
            phone,
            ...(input.fullName?.trim() ? { full_name: input.fullName.trim() } : {}),
          },
          emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
        },
      });
      if (error) return { ok: false, message: describeAuthError(error, 'The account could not be created.') };

      // Supabase does not error on a duplicate address — it returns a decoy
      // user with no identities, so that a stranger cannot use the sign-up
      // form to discover who has an account. The decoy has to be recognised
      // here or the screen would claim to have created an account that
      // already belonged to someone else.
      const identities = (data.user as User & { identities?: unknown[] } | null)?.identities;
      if (data.user && Array.isArray(identities) && identities.length === 0) {
        return {
          ok: false,
          field: 'email',
          message: 'An account already exists for that email. Sign in instead, or reset the password.',
        };
      }
      return { ok: true, needsEmailConfirmation: !data.session };
    },

    async signIn(email, password): Promise<ActionResult> {
      if (!isSupabaseConfigured()) return { ok: false, message: 'Supabase is not configured.' };
      const { error } = await supabase().auth.signInWithPassword({
        email: normaliseEmail(email),
        password,
      });
      if (error) return { ok: false, message: describeAuthError(error, 'Could not sign in.') };
      return { ok: true };
    },

    async signOut(): Promise<ActionResult> {
      if (!isSupabaseConfigured()) return { ok: true };
      const { error } = await supabase().auth.signOut();
      if (error) return { ok: false, message: describeAuthError(error, 'Could not sign out.') };
      return { ok: true };
    },

    async requestPasswordReset(email, redirectTo): Promise<ActionResult> {
      if (!isSupabaseConfigured()) return { ok: false, message: 'Supabase is not configured.' };
      const { error } = await supabase().auth.resetPasswordForEmail(normaliseEmail(email), { redirectTo });
      // A rate limit is worth showing; anything else is reported as success on
      // purpose. "No account for that address" would turn this form into a way
      // to test which addresses are registered.
      if (error && /rate limit/i.test(`${(error as AuthError & { code?: string }).code ?? ''} ${error.message}`)) {
        return { ok: false, message: describeAuthError(error, 'Too many attempts.') };
      }
      return { ok: true };
    },

    async updatePassword(password): Promise<ActionResult> {
      if (!isSupabaseConfigured()) return { ok: false, message: 'Supabase is not configured.' };
      const { error } = await supabase().auth.updateUser({ password });
      if (error) return { ok: false, field: 'password', message: describeAuthError(error, 'The password could not be changed.') };
      return { ok: true };
    },

    async resendConfirmation(email, redirectTo): Promise<ActionResult> {
      if (!isSupabaseConfigured()) return { ok: false, message: 'Supabase is not configured.' };
      const { error } = await supabase().auth.resend({
        type: 'signup',
        email: normaliseEmail(email),
        options: { emailRedirectTo: redirectTo },
      });
      if (error) return { ok: false, message: describeAuthError(error, 'The email could not be sent.') };
      return { ok: true };
    },
  };
}
