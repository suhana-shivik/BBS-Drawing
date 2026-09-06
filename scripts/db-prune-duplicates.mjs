// ============================================================
// Remove schedules and outputs that a rebuild loop filed on top of each other.
//
//   node scripts/db-prune-duplicates.mjs           report only, change nothing
//   node scripts/db-prune-duplicates.mjs --apply   delete the superseded rows
//
// WHAT IT KEEPS: the newest calculation run per drawing, and the newest
// artifact per (drawing, kind). Everything older than that with IDENTICAL
// content is a repeat of the same computation, not a version of the document —
// see the header of tests/domain/stale-loop.test.ts for how they came to
// exist.
//
// WHAT IT WILL NOT DO: touch anything whose content differs. A genuine version
// history (v1 read the sheet, v2 had the cover, v3 had the run) is the record
// this product exists to keep, and pruning it would be worse than the mess.
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
const BASE = (env.SUPABASE_URL ?? '').replace(/\/$/, '');
const KEY = env.SUPABASE_SECRET_KEY;
const apply = process.argv.includes('--apply');

if (!BASE || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env.');
  process.exit(2);
}

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

/**
 * The same rule as `artifactFingerprint` in src/register/artifacts.ts: two
 * outputs are the same document when they differ only in the result's own id
 * and its timestamps. Comparing raw bytes calls every rebuild distinct, which
 * is why 326 identical schedules looked like 326 versions.
 */
const VOLATILE_ANYWHERE = new Set(['buildId', 'builtAt', 'updatedAt', 'exportedAt']);
const VOLATILE_AT_ROOT = new Set(['id']);
function stripVolatile(value, depth = 0) {
  if (Array.isArray(value)) return value.map((item) => stripVolatile(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (VOLATILE_ANYWHERE.has(key)) continue;
    if (depth === 0 && VOLATILE_AT_ROOT.has(key)) continue;
    out[key] = stripVolatile(inner, depth + 1);
  }
  return out;
}
function artifactFingerprint(content) {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return content;
    return JSON.stringify(stripVolatile(parsed));
  } catch {
    return content;
  }
}

async function all(table, select) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const res = await fetch(`${BASE}/rest/v1/${table}?select=${select}&order=created_at.desc`, {
      headers: { ...headers, Range: `${from}-${from + pageSize - 1}` },
    });
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function removeIn(table, ids) {
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const res = await fetch(`${BASE}/rest/v1/${table}?id=in.(${batch.join(',')})`, {
      method: 'DELETE',
      headers,
    });
    if (!res.ok) throw new Error(`deleting from ${table}: ${res.status} ${await res.text()}`);
  }
}

// ---- calculation runs -------------------------------------------------
const runs = await all('bbs_calculation_runs', 'id,drawing_id,created_at,is_current,total_rows,status');
const runsByDrawing = new Map();
for (const run of runs) {
  const key = run.drawing_id ?? 'no-drawing';
  if (!runsByDrawing.has(key)) runsByDrawing.set(key, []);
  runsByDrawing.get(key).push(run);
}

const doomedRuns = [];
for (const [, list] of runsByDrawing) {
  // newest first (the query ordered by created_at desc); prefer the one the
  // database already calls current, so "the schedule" does not change identity
  const keep = list.find((r) => r.is_current) ?? list[0];
  for (const run of list) if (run.id !== keep.id) doomedRuns.push(run.id);
}

// ---- artifacts --------------------------------------------------------
const artifacts = await all('project_artifacts', 'id,document_id,kind,version,content,created_at');
const byDocKind = new Map();
for (const a of artifacts) {
  const key = `${a.document_id ?? '-'}|${a.kind}`;
  if (!byDocKind.has(key)) byDocKind.set(key, []);
  byDocKind.get(key).push(a);
}

const doomedArtifacts = [];
let keptDistinct = 0;
for (const [, list] of byDocKind) {
  // Group by CONTENT. One survivor per distinct payload — the newest — so a
  // real version history survives and only the repeats go.
  const seen = new Map();
  for (const a of list) {
    const fingerprint = artifactFingerprint(a.content ?? '');
    if (seen.has(fingerprint)) doomedArtifacts.push(a.id);
    else seen.set(fingerprint, a.id);
  }
  keptDistinct += seen.size;
}

console.log(`calculation runs : ${runs.length} total, keeping ${runsByDrawing.size}, removing ${doomedRuns.length}`);
console.log(`artifacts        : ${artifacts.length} total, keeping ${keptDistinct} distinct, removing ${doomedArtifacts.length}`);
console.log(`                   (schedule rows cascade with their run)`);

if (!apply) {
  console.log('\nReport only. Re-run with --apply to delete.');
  process.exit(0);
}

if (doomedRuns.length) await removeIn('bbs_calculation_runs', doomedRuns);
if (doomedArtifacts.length) await removeIn('project_artifacts', doomedArtifacts);

const after = {};
for (const t of ['bbs_calculation_runs', 'bbs_rows', 'project_artifacts']) {
  const res = await fetch(`${BASE}/rest/v1/${t}?select=id&limit=1`, {
    headers: { ...headers, Prefer: 'count=exact' },
  });
  after[t] = res.headers.get('content-range');
}
console.log('\nafter:');
for (const [t, range] of Object.entries(after)) console.log(`  ${t.padEnd(22)} ${range}`);
