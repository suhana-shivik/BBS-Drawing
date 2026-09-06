// ============================================================
// Read — and, with a token, change — the project's authentication settings.
//
//   node scripts/auth-config.mjs                     show the settings that matter
//   node scripts/auth-config.mjs --no-confirmation   let a new account sign in immediately
//   node scripts/auth-config.mjs --confirmation      require the emailed link again
//
// SHOWING needs nothing but the publishable key. CHANGING is a project-level
// setting, not a database row and not something an API key can touch, so it
// needs a Personal Access Token:
//
//   https://supabase.com/dashboard/account/tokens  →  Generate new token
//   then put it in .env as  SUPABASE_ACCESS_TOKEN=sbp_…
//
// Without a token this prints the two clicks that do the same thing in the
// dashboard. The token is server-only: it is not on the browser allowlist in
// vite-plugins/publicEnv.ts and must never be.
// ============================================================
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnv() {
  const out = {};
  const file = path.join(root, '.env');
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const env = { ...readEnv(), ...process.env };
const URL_BASE = (env.SUPABASE_URL ?? '').replace(/\/$/, '');
const PUBLISHABLE = env.SUPABASE_PUBLISHABLE_KEY;
const TOKEN = env.SUPABASE_ACCESS_TOKEN;
const ref = /^https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(URL_BASE)?.[1];

if (!URL_BASE || !PUBLISHABLE || !ref) {
  console.error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set in .env.');
  process.exit(2);
}

async function currentSettings() {
  const res = await fetch(`${URL_BASE}/auth/v1/settings`, { headers: { apikey: PUBLISHABLE } });
  if (!res.ok) throw new Error(`could not read auth settings (${res.status})`);
  return res.json();
}

function report(settings) {
  const confirm = settings.mailer_autoconfirm === true ? 'NOT required' : 'REQUIRED';
  console.log(`project:              ${ref}`);
  console.log(`email sign-in:        ${settings.external?.email ? 'enabled' : 'DISABLED'}`);
  console.log(`new sign-ups:         ${settings.disable_signup ? 'DISABLED' : 'allowed'}`);
  console.log(`email confirmation:   ${confirm}`);
  console.log('');
  console.log(
    settings.mailer_autoconfirm === true
      ? 'A new account is signed in the moment it registers.'
      : 'A new account has NO session until the emailed link is opened.',
  );
}

const wantOff = process.argv.includes('--no-confirmation');
const wantOn = process.argv.includes('--confirmation');

const before = await currentSettings();

if (!wantOff && !wantOn) {
  report(before);
  process.exit(0);
}

const target = wantOff; // true = autoconfirm on = no confirmation needed
if (before.mailer_autoconfirm === target) {
  console.log('Already set that way.\n');
  report(before);
  process.exit(0);
}

if (!TOKEN) {
  console.error(
    [
      'Changing this needs a Personal Access Token, which is not in .env.',
      '',
      'Either add one:',
      '  1. https://supabase.com/dashboard/account/tokens → Generate new token',
      '  2. put it in .env as  SUPABASE_ACCESS_TOKEN=sbp_…',
      '  3. run this again',
      '',
      'Or do it in the dashboard, which is two clicks:',
      `  https://supabase.com/dashboard/project/${ref}/auth/providers`,
      '  → Email → turn "Confirm email" ' + (target ? 'OFF' : 'ON') + ' → Save',
    ].join('\n'),
  );
  process.exit(3);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ mailer_autoconfirm: target }),
});
if (!res.ok) {
  console.error(`The change was refused (${res.status}): ${await res.text().catch(() => '')}`);
  process.exit(4);
}

// Read it back rather than trusting the response — the setting is what the
// auth server serves, not what the management API echoed.
const after = await currentSettings();
console.log(after.mailer_autoconfirm === target ? 'Changed.\n' : 'The change did not take effect.\n');
report(after);
process.exit(after.mailer_autoconfirm === target ? 0 : 5);
