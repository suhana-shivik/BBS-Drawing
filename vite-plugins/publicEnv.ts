// ============================================================
// WHAT THE BROWSER BUNDLE IS ALLOWED TO KNOW.
//
// `.env` holds both halves of the Supabase credentials: the PUBLISHABLE key,
// which is designed to ship to browsers and is protected by Row Level
// Security, and the SECRET key, which bypasses RLS entirely and must never
// leave a server. Vite's own rule — "only VITE_-prefixed vars reach the
// client" — does not apply here, because these vars are not VITE_-prefixed
// and the app still needs two of them. So the rule is enforced HERE instead,
// as an allowlist of exactly two names.
//
// An allowlist rather than a denylist on purpose: a denylist has to predict
// every dangerous name a future `.env` might carry, and the first one it
// fails to predict is shipped to every browser. This way, a variable that
// nobody has explicitly published simply is not published.
//
// `assertPublishable` is the second lock. It refuses a build outright if the
// allowlist ever grows a name that looks like a secret — so the mistake is a
// failed build and a red test, not a quiet leak in production.
// ============================================================

/** The only environment variables the client bundle may contain. */
export const PUBLIC_ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY'] as const;

export type PublicEnvKey = (typeof PUBLIC_ENV_KEYS)[number];

/**
 * Names that may never be published, however they are spelled. PUBLISHABLE is
 * carved out explicitly: it contains "KEY" and is nonetheless the one key
 * meant for browsers.
 */
const SECRET_SHAPED = /SECRET|SERVICE[_-]?ROLE|PASSWORD|PRIVATE|TOKEN|CREDENTIAL/i;

/** Throws when a name is not safe to put in a browser bundle. */
export function assertPublishable(name: string): void {
  if (name === 'SUPABASE_PUBLISHABLE_KEY') return;
  if (SECRET_SHAPED.test(name)) {
    throw new Error(
      `refusing to expose "${name}" to the browser bundle — it is named like a secret. ` +
        'Server-only credentials must stay out of PUBLIC_ENV_KEYS.',
    );
  }
}

/**
 * The `define` map Vite injects into the client bundle: exactly the allowlist,
 * as `import.meta.env.<NAME>`. A variable that is absent from `.env` becomes
 * an empty string rather than `undefined`, so the app can say "Supabase is not
 * configured" instead of throwing on a property of undefined.
 */
export function publicEnvDefine(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PUBLIC_ENV_KEYS) {
    assertPublishable(name);
    out[`import.meta.env.${name}`] = JSON.stringify(env[name] ?? '');
  }
  return out;
}
