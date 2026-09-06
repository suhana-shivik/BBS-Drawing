// ============================================================
// Who is asking, and what to say when the database says no.
//
// EVERY WRITE STAMPS `user_id` FROM THE SESSION, never from an argument. The
// row-level-security policies check `auth.uid() = user_id` on the server, so a
// forged id is refused there too — but sending one at all would be a bug
// waiting to become a leak, so the id is only ever read from the live session.
// ============================================================
import type { PostgrestError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

/** The signed-in user's id, or null when there is no session. */
export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase().auth.getUser();
  return data.user?.id ?? null;
}

/**
 * The signed-in user's id, or a throw. Callers are all inside the
 * authenticated tree, so "no session" here means the session expired
 * mid-action — which the UI reports rather than writing an orphan row.
 */
export async function requireUserId(): Promise<string> {
  const id = await currentUserId();
  if (!id) throw new Error('Your session has ended. Sign in again to continue.');
  return id;
}

/**
 * A Postgres error as something a person can act on.
 *
 * RLS refusals are the ones worth translating: PostgREST reports them as
 * "new row violates row-level security policy", which is accurate and tells
 * the reader nothing. In this app it means exactly one thing — the row was
 * filed against somebody else's project, or the session is gone.
 */
export function describeDbError(error: PostgrestError | null, doing: string): string {
  if (!error) return `${doing} failed.`;
  const code = error.code ?? '';
  const message = error.message ?? '';

  if (code === '42501' || /row-level security/i.test(message)) {
    return `${doing} was refused: that record belongs to another account, or your session has ended.`;
  }
  if (code === '23505') {
    return `${doing} failed: a record with that identity already exists.`;
  }
  if (code === '23503') {
    return `${doing} failed: it refers to a project or drawing that no longer exists.`;
  }
  if (code === '42P01' || /relation .* does not exist/i.test(message)) {
    return (
      `${doing} failed: the database schema is not installed. Run ` +
      'supabase/migrations/0001_bbs_platform.sql against this Supabase project.'
    );
  }
  if (/Failed to fetch|NetworkError|fetch failed/i.test(message)) {
    return `${doing} failed: could not reach the database.`;
  }
  return `${doing} failed: ${message}`;
}

/**
 * Throws a readable error, or returns the data.
 *
 * `data` is taken as `unknown` and the caller names the row type. Without
 * generated database types the client types `data` loosely, and letting the
 * generic be inferred from it collapses to `null` — so the row type is stated
 * at each call site, where it is checked against the mapper that reads it.
 */
export function unwrap<T>(
  result: { data: unknown; error: PostgrestError | null },
  doing: string,
): T {
  if (result.error) throw new Error(describeDbError(result.error, doing));
  if (result.data === null || result.data === undefined) throw new Error(`${doing} returned nothing.`);
  return result.data as T;
}
