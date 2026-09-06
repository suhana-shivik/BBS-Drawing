// ============================================================
// Apply supabase/migrations/*.sql to the project's Postgres.
//
//   node scripts/db-migrate.mjs            apply every migration, in order
//   node scripts/db-migrate.mjs --check    report what is installed, change nothing
//
// WHY THIS NEEDS A CREDENTIAL THE APP DOES NOT HAVE. The publishable and
// secret API keys both talk to PostgREST, which executes queries — it does not
// execute DDL. Creating tables and policies is a database connection, so this
// wants either:
//
//   SUPABASE_DB_URL       postgresql://…  (copy it from the Supabase dashboard:
//                         Project Settings → Database → Connection string)
//   SUPABASE_DB_PASSWORD  the database password, and the URL is derived
//
// Prefer the SESSION POOLER connection string on a home or office network:
// direct `db.<ref>.supabase.co` connections are IPv6-only on current projects,
// and most Windows/consumer networks are IPv4, so a direct connection simply
// times out with no useful error.
//
// If neither is available, paste supabase/migrations/0001_bbs_platform.sql
// into the dashboard's SQL editor — the file is plain, idempotent SQL and does
// exactly the same thing.
// ============================================================
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/** The project ref out of https://<ref>.supabase.co */
function projectRef(url) {
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url ?? '');
  return m ? m[1] : null;
}

function connectionString() {
  if (env.SUPABASE_DB_URL) return env.SUPABASE_DB_URL;
  const ref = projectRef(env.SUPABASE_URL);
  const password = env.SUPABASE_DB_PASSWORD;
  if (!ref || !password) return null;
  const host = env.SUPABASE_DB_HOST || `db.${ref}.supabase.co`;
  const port = env.SUPABASE_DB_PORT || '5432';
  const user = host.includes('pooler') ? `postgres.${ref}` : 'postgres';
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/postgres`;
}

/** psql is not on PATH in a default Windows install. */
function findPsql() {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['psql'], { encoding: 'utf8' });
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  }
  if (process.platform === 'win32') {
    for (const version of ['17', '16', '15', '14']) {
      const guess = `C:\\Program Files\\PostgreSQL\\${version}\\bin\\psql.exe`;
      if (existsSync(guess)) return guess;
    }
  }
  return null;
}

const migrationsDir = path.join(root, 'supabase', 'migrations');
const files = existsSync(migrationsDir)
  ? readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  : [];

if (!files.length) {
  console.error('No migrations found under supabase/migrations.');
  process.exit(1);
}

const conn = connectionString();
if (!conn) {
  console.error(
    [
      'No database connection is configured.',
      '',
      'Add ONE of these to .env:',
      '  SUPABASE_DB_URL=postgresql://…      (Dashboard → Project Settings → Database → Connection string)',
      '  SUPABASE_DB_PASSWORD=…              (the database password; the URL is derived from SUPABASE_URL)',
      '',
      'On an IPv4-only network use the SESSION POOLER string, not the direct one.',
      '',
      'Or, with no credential at all: open the Supabase dashboard → SQL editor and paste',
      `  ${path.relative(root, path.join(migrationsDir, files[0]))}`,
      'It is idempotent, so running it twice is harmless.',
    ].join('\n'),
  );
  process.exit(2);
}

const psql = findPsql();
if (!psql) {
  console.error('psql was not found. Install the PostgreSQL client tools, or paste the SQL into the dashboard editor.');
  process.exit(3);
}

const check = process.argv.includes('--check');

if (check) {
  const sql = `select table_name from information_schema.tables where table_schema='public' order by table_name;`;
  const result = spawnSync(psql, [conn, '-At', '-c', sql], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr || 'Could not connect.');
    process.exit(4);
  }
  const tables = result.stdout.split(/\r?\n/).filter(Boolean);
  console.log(tables.length ? `public schema holds ${tables.length} table(s):\n  ${tables.join('\n  ')}` : 'public schema is empty.');
  process.exit(0);
}

for (const file of files) {
  const full = path.join(migrationsDir, file);
  process.stdout.write(`applying ${file} … `);
  // ON_ERROR_STOP so a failure halts here rather than leaving the schema half
  // built and reporting success.
  const result = spawnSync(psql, [conn, '-v', 'ON_ERROR_STOP=1', '-q', '-f', full], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    console.log('FAILED');
    console.error(result.stderr || result.stdout);
    process.exit(5);
  }
  console.log('ok');
}

console.log('\nSchema installed. Run `node scripts/db-verify.mjs` to check it end to end.');
