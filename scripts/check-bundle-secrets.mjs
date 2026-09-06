// ============================================================
// Does the built bundle contain anything from .env that it should not?
//
//   npm run build && node scripts/check-bundle-secrets.mjs
//
// The allowlist in vite-plugins/publicEnv.ts decides what Vite injects, and a
// unit test guards that list. This is the check downstream of both: it reads
// the ACTUAL bytes in dist/ and looks for the ACTUAL values in .env. A leak
// through some other route — a value pasted into source, a VITE_-prefixed
// variable nobody thought about, a dependency echoing config — is invisible to
// the unit test and obvious here.
//
// Exit code 1 on a leak, so it can gate a deploy.
// ============================================================
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

if (!existsSync(dist)) {
  console.error('dist/ does not exist. Run `npm run build` first.');
  process.exit(2);
}

/** Names whose value is MEANT to reach the browser. Everything else must not. */
const PUBLISHABLE = new Set([
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'APP_URL',
  'ENVIRONMENT',
  'VITE_OPENROUTER_APP_NAME',
  'VITE_OPENROUTER_TEXT_MODEL',
  'VITE_OPENROUTER_VISION_MODEL',
  'VITE_OPENROUTER_JUDGE_MODEL',
  // The app calls OpenRouter straight from the browser, so this key is in the
  // bundle BY DESIGN — and that design is itself the finding this script
  // reports below rather than hides.
  'VITE_OPENROUTER_API_KEY',
]);

/** Too short or too common to search for without drowning in false positives. */
const MIN_LENGTH = 12;

function readEnv() {
  const out = {};
  const file = path.join(root, '.env');
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const env = readEnv();
const files = walk(dist);
const contents = files.map((f) => ({ file: path.relative(root, f), text: readFileSync(f, 'latin1') }));

const leaks = [];
const expected = [];
const skipped = [];

for (const [name, value] of Object.entries(env)) {
  if (value.length < MIN_LENGTH) {
    skipped.push(name);
    continue;
  }
  const hits = contents.filter((c) => c.text.includes(value)).map((c) => c.file);
  if (!hits.length) continue;
  // Report under EVERY name that holds this value: two variables sharing one
  // secret is exactly how a key gets published under a name nobody audited.
  const alsoKnownAs = Object.entries(env)
    .filter(([other, v]) => other !== name && v === value)
    .map(([other]) => other);
  const entry = { name, files: hits, alsoKnownAs };
  if (PUBLISHABLE.has(name)) expected.push(entry);
  else leaks.push(entry);
}

console.log(`checked ${files.length} file(s) in dist/ against ${Object.keys(env).length} variable(s) in .env\n`);

if (expected.length) {
  console.log('present, and meant to be:');
  for (const e of expected) console.log(`  · ${e.name}${e.alsoKnownAs.length ? `  (same value as ${e.alsoKnownAs.join(', ')})` : ''}`);
  console.log('');
}

if (skipped.length) {
  console.log(`not searched (shorter than ${MIN_LENGTH} characters): ${skipped.join(', ')}\n`);
}

if (!leaks.length) {
  console.log('NO LEAKS — no server-only value from .env appears in the bundle.');
  process.exit(0);
}

console.log('LEAKED — these are in the bundle and should not be:');
for (const leak of leaks) {
  console.log(`  · ${leak.name}`);
  if (leak.alsoKnownAs.length) {
    console.log(`      shares its value with: ${leak.alsoKnownAs.join(', ')}`);
    console.log('      (a publishable name and a server-only name holding ONE value means the');
    console.log('       server-only one is published too — give them different values, or stop');
    console.log('       publishing the value at all)');
  }
  console.log(`      in: ${leak.files.join(', ')}`);
}
process.exit(1);
