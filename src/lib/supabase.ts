// ============================================================
// The one Supabase client.
//
// ONE CLIENT, LAZILY BUILT. Two clients means two auth sessions and two
// token-refresh timers racing over the same storage key, which shows up as a
// user being logged out at random. Everything that talks to Supabase imports
// `supabase()` from here.
//
// LAZY, because this module is imported by code that unit tests exercise with
// no credentials at all. Building the client at import time would throw in
// every such test and in any checkout whose `.env` is not filled in yet.
// Instead `isSupabaseConfigured()` answers the question honestly and the app
// renders a "not configured" screen rather than a white page.
//
// PUBLISHABLE KEY ONLY. The credentials arrive through
// `vite-plugins/publicEnv.ts`, whose allowlist is exactly two names. The
// secret key is not reachable from here and must never be: it bypasses Row
// Level Security, so a copy of it in a browser bundle is a copy of the whole
// database for anyone who opens devtools.
//
// The session lives in localStorage under Supabase's own key. That is the
// library's managed auth storage — a short-lived JWT plus a refresh token —
// and it is NOT where application data belongs; projects, drawings, facts and
// schedules are rows in Postgres, protected by RLS.
// ============================================================
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Reads a build-time-injected variable without assuming the shape of import.meta. */
function envValue(name: 'SUPABASE_URL' | 'SUPABASE_PUBLISHABLE_KEY'): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const raw = env?.[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

export function supabaseUrl(): string {
  return envValue('SUPABASE_URL');
}

/** True when both public credentials reached the bundle. */
export function isSupabaseConfigured(): boolean {
  return supabaseUrl().length > 0 && envValue('SUPABASE_PUBLISHABLE_KEY').length > 0;
}

/** What to tell a person when it is not configured — names the file and the two keys. */
export const SUPABASE_SETUP_MESSAGE =
  'Supabase is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in the .env file at ' +
  'the project root, then restart the dev server. (SUPABASE_SECRET_KEY is server-only and is never ' +
  'sent to the browser.)';

let client: SupabaseClient | null = null;

/**
 * The client. Throws a message a person can act on when the credentials are
 * missing — callers that can render a friendlier state should check
 * `isSupabaseConfigured()` first.
 */
export function supabase(): SupabaseClient {
  if (client) return client;
  if (!isSupabaseConfigured()) throw new Error(SUPABASE_SETUP_MESSAGE);
  client = createClient(supabaseUrl(), envValue('SUPABASE_PUBLISHABLE_KEY'), {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // The password-reset and email-confirmation links land back on the app
      // with their token in the URL; this is what turns that into a session.
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  });
  return client;
}

/** Tests only: drop the memoised client so the next call rebuilds it. */
export function resetSupabaseClientForTests(): void {
  client = null;
}
