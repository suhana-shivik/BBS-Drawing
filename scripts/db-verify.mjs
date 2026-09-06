// ============================================================
// Prove the platform works, against the real Supabase project.
//
//   node scripts/db-verify.mjs           run every check, then clean up
//   node scripts/db-verify.mjs --keep    leave the test accounts and data behind
//
// This is the acceptance test that cannot be faked with a mock: it creates two
// real accounts, signs both in, and then tries — as user B, with B's own
// access token — to read A's project, drawings, facts and schedule. If Row
// Level Security is wrong, B sees rows and this fails.
//
// It talks to the REST and Auth APIs directly rather than through the app, so
// it needs no browser. The secret key is used ONLY to create and delete the
// test accounts (an admin operation); every data check runs as one of the two
// users, exactly as the app does.
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
const SECRET = env.SUPABASE_SECRET_KEY;
const keep = process.argv.includes('--keep');

if (!URL_BASE || !PUBLISHABLE || !SECRET) {
  console.error('SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY must all be set in .env.');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(pathname, { method = 'GET', token, body, headers = {}, key = PUBLISHABLE } = {}) {
  const res = await fetch(`${URL_BASE}${pathname}`, {
    method,
    headers: {
      apikey: key,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, body: json };
}

const stamp = Date.now();
// Supabase's validator rejects example.com outright on the public sign-up
// path, so the self-registration check needs a domain it will accept. No
// message is ever sent to it: that check only runs once confirmation is off.
const SELF_DOMAIN = env.VERIFY_EMAIL_DOMAIN || 'bbs-verify.dev';
const NEWLINE = String.fromCharCode(10);
const accounts = [
  { label: 'A', email: `bbs-verify-a-${stamp}@example.com`, password: 'Concrete-A1', phone: '+919876500001' },
  { label: 'B', email: `bbs-verify-b-${stamp}@example.com`, password: 'Concrete-B1', phone: '+919876500002' },
];

async function createConfirmedUser(account) {
  // Admin creation with email_confirm so the script does not need a mailbox.
  // The app's own sign-up path goes through /auth/v1/signup and DOES require
  // the confirmation link — that difference is deliberate and is why the
  // registration screen says "check your inbox".
  const res = await api('/auth/v1/admin/users', {
    method: 'POST',
    key: SECRET,
    token: SECRET,
    body: {
      email: account.email,
      password: account.password,
      email_confirm: true,
      user_metadata: { phone: account.phone, full_name: `Verify ${account.label}` },
    },
  });
  if (!res.ok) throw new Error(`could not create user ${account.label}: ${JSON.stringify(res.body)}`);
  return res.body.id;
}

async function signIn(account) {
  const res = await api('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: account.email, password: account.password },
  });
  if (!res.ok) throw new Error(`could not sign in ${account.label}: ${JSON.stringify(res.body)}`);
  return res.body.access_token;
}

async function deleteUser(id) {
  await api(`/auth/v1/admin/users/${id}`, { method: 'DELETE', key: SECRET, token: SECRET });
}

const created = [];

try {
  console.log(`Supabase project: ${URL_BASE}\n`);

  // ---- schema present? -------------------------------------------------
  console.log('schema');
  const REQUIRED = [
    'profiles',
    'projects',
    'drawings',
    'drawing_sections',
    'drawing_readings',
    'data_facts',
    'bbs_calculation_runs',
    'bbs_rows',
    'project_artifacts',
    'interview_logs',
    'project_folders',
  ];
  const spec = await api('/rest/v1/', { key: SECRET, token: SECRET });
  const defined = Object.keys(spec.body?.definitions ?? spec.body?.components?.schemas ?? {});
  const missing = REQUIRED.filter((t) => !defined.includes(t));
  check('every table exists', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');
  if (missing.length) {
    console.error('\nRun `node scripts/db-migrate.mjs` (or paste the migration into the SQL editor) first.');
    process.exit(1);
  }

  // ---- accounts --------------------------------------------------------
  console.log('\naccounts');
  for (const account of accounts) {
    account.id = await createConfirmedUser(account);
    created.push(account.id);
    account.token = await signIn(account);
  }
  check('two accounts created and signed in', accounts.every((a) => a.id && a.token));

  // the profile row is made by a database trigger, not by the client
  const profile = await api(`/rest/v1/profiles?id=eq.${accounts[0].id}&select=id,email,phone`, {
    token: accounts[0].token,
  });
  check('a profile row was created automatically', Array.isArray(profile.body) && profile.body.length === 1,
    JSON.stringify(profile.body));
  check('the phone from registration reached the profile',
    profile.body?.[0]?.phone === accounts[0].phone,
    `got ${JSON.stringify(profile.body?.[0]?.phone)}`);

  const foreignProfile = await api(`/rest/v1/profiles?id=eq.${accounts[0].id}&select=id`, {
    token: accounts[1].token,
  });
  check("B cannot read A's profile", Array.isArray(foreignProfile.body) && foreignProfile.body.length === 0);

  // ---- registration exactly as the app does it -------------------------
  //
  // The accounts above were made with the ADMIN endpoint, which can confirm an
  // address itself. This is the public /auth/v1/signup path the registration
  // screen actually calls, so it is the only check that says whether a real
  // new user gets in without opening an email.
  //
  // It is SKIPPED while confirmation is required, deliberately: in that
  // configuration signing up sends a real message to a made-up address, which
  // bounces and burns the project's email rate limit. The answer is already
  // known from the setting, so the check reports it instead of proving it the
  // expensive way.
  console.log(NEWLINE + "registration through the app's own path");
  const authSettings = await api('/auth/v1/settings');
  const confirmationRequired = authSettings.body?.mailer_autoconfirm !== true;

  if (confirmationRequired) {
    check(
      'a new account is signed in immediately — no email confirmation',
      false,
      'email confirmation is ON for this project. Turn it off with ' +
        '`node scripts/auth-config.mjs --no-confirmation`, or in the dashboard: ' +
        'Authentication -> Providers -> Email -> Confirm email OFF.',
    );
  } else {
    // No confirmation means no message is sent, so this address is never
    // written to. It is deleted again at the end regardless.
    const selfEmail = `bbs-verify-self-${stamp}@${SELF_DOMAIN}`;
    const signup = await api('/auth/v1/signup', {
      method: 'POST',
      body: {
        email: selfEmail,
        password: 'Concrete-S1',
        data: { phone: '+919876500003', full_name: 'Verify Self' },
      },
    });
    check('sign-up accepted', signup.ok, `status ${signup.status} ${JSON.stringify(signup.body)}`);
    const selfId = signup.body?.user?.id ?? signup.body?.id;
    if (selfId) created.push(selfId);

    check(
      'a new account is signed in immediately — no email confirmation',
      Boolean(signup.body?.access_token),
      JSON.stringify(signup.body).slice(0, 200),
    );

    // The profile trigger must fire for a self-registered account too, not
    // only for one an administrator created.
    if (selfId) {
      const selfProfile = await api(`/rest/v1/profiles?id=eq.${selfId}&select=id,email,phone`, {
        key: SECRET,
        token: SECRET,
      });
      check(
        'the self-registered account got a profile with its phone',
        Array.isArray(selfProfile.body) && selfProfile.body[0]?.phone === '+919876500003',
        JSON.stringify(selfProfile.body),
      );
    }
  }

  // ---- A does some work ------------------------------------------------
  console.log('\nuser A creates a project, a drawing, facts and a schedule');
  const projectRes = await api('/rest/v1/projects?select=*', {
    method: 'POST',
    token: accounts[0].token,
    headers: { Prefer: 'return=representation' },
    body: { user_id: accounts[0].id, name: 'Verify Project', client: 'Verify Client' },
  });
  check('project created', projectRes.ok && projectRes.body?.[0]?.id, JSON.stringify(projectRes.body));
  const projectId = projectRes.body?.[0]?.id;

  const drawingRes = await api('/rest/v1/drawings?select=*', {
    method: 'POST',
    token: accounts[0].token,
    headers: { Prefer: 'return=representation' },
    body: {
      project_id: projectId,
      user_id: accounts[0].id,
      document_id: 'doc-verify-1',
      original_file_name: 'verify.dxf',
      drawing_number: 'V-001',
      revision: 'A',
      drawing_hash: 'doc:verifyhash',
      status: 'READ',
    },
  });
  check('drawing filed', drawingRes.ok && drawingRes.body?.[0]?.id, JSON.stringify(drawingRes.body));
  const drawingId = drawingRes.body?.[0]?.id;

  // Two facts with DIFFERENT member marks and shapes — the point being that
  // the schema does not care what they are called.
  //
  // Every object in one PostgREST insert must carry the SAME KEYS ("All object
  // keys must match"), so both are built from one template. The app's own
  // writer (src/data/facts.ts factToRow) returns a fixed-shape object for the
  // same reason.
  const factTemplate = {
    project_id: projectId,
    drawing_id: drawingId,
    user_id: accounts[0].id,
    fact_key: null,
    member_id: null,
    parameter: null,
    value: null,
    unit: 'mm',
    semantic_type: null,
    source_type: null,
    source_text: null,
    status: 'VALID',
    ask: null,
    entry_seq: 0,
    version: 1,
    state: null,
  };
  const factsRes = await api('/rest/v1/data_facts?select=*', {
    method: 'POST',
    token: accounts[0].token,
    headers: { Prefer: 'return=representation' },
    body: [
      {
        ...factTemplate,
        fact_key: 'PB03.span',
        member_id: 'PB03',
        parameter: 'span',
        value: 4500,
        semantic_type: 'member_dimension',
        source_type: 'DRAWING_READ',
        source_text: 'BEAM SCHEDULE row PB03, column SPAN = 4500',
        entry_seq: 0,
        version: 1,
        state: 'DECLARED',
      },
      {
        ...factTemplate,
        fact_key: 'settings.cover',
        member_id: 'settings',
        parameter: 'cover',
        value: null,
        semantic_type: 'cover',
        source_type: 'MISSING',
        status: 'MISSING',
        ask: 'What is the clear cover, in mm?',
        entry_seq: 1,
        version: 2,
        state: 'MISSING',
      },
    ],
  });
  check('facts recorded, including an open question', factsRes.ok && factsRes.body?.length === 2,
    JSON.stringify(factsRes.body));

  const runRes = await api('/rest/v1/bbs_calculation_runs?select=*', {
    method: 'POST',
    token: accounts[0].token,
    headers: { Prefer: 'return=representation' },
    body: {
      project_id: projectId,
      drawing_id: drawingId,
      user_id: accounts[0].id,
      drawing_hash: 'doc:verifyhash',
      status: 'CALCULATED',
      row_deps: [{ rowId: 'PB03:PB03-M1', factIds: ['PB03.span', 'settings.cover'], drawingHash: 'doc:verifyhash' }],
      total_rows: 1,
      calculated_rows: 1,
      blocked_rows: 0,
    },
  });
  check('schedule run filed', runRes.ok && runRes.body?.[0]?.id, JSON.stringify(runRes.body));
  const runId = runRes.body?.[0]?.id;

  const rowRes = await api('/rest/v1/bbs_rows?select=*', {
    method: 'POST',
    token: accounts[0].token,
    headers: { Prefer: 'return=representation' },
    body: {
      run_id: runId,
      project_id: projectId,
      drawing_id: drawingId,
      user_id: accounts[0].id,
      row_index: 0,
      member_id: 'PB03',
      bar_mark: 'PB03-M1',
      dia_mm: 16,
      cutting_length_mm: 4420,
      total_bars: 12,
      fact_ids: ['PB03.span', 'settings.cover'],
      stage: 'VALIDATED',
      status: 'CALCULATED',
    },
  });
  check('schedule row filed with its fact dependencies', rowRes.ok && rowRes.body?.[0]?.id,
    JSON.stringify(rowRes.body));

  // ---- A can read it back ---------------------------------------------
  console.log('\nuser A reads their own work back');
  for (const [name, url] of [
    ['projects', `/rest/v1/projects?id=eq.${projectId}&select=id`],
    ['drawings', `/rest/v1/drawings?id=eq.${drawingId}&select=id`],
    ['data_facts', `/rest/v1/data_facts?project_id=eq.${projectId}&select=fact_key`],
    ['bbs_calculation_runs', `/rest/v1/bbs_calculation_runs?id=eq.${runId}&select=id`],
    ['bbs_rows', `/rest/v1/bbs_rows?run_id=eq.${runId}&select=bar_mark`],
  ]) {
    const res = await api(url, { token: accounts[0].token });
    check(`A reads ${name}`, Array.isArray(res.body) && res.body.length > 0, JSON.stringify(res.body));
  }

  // ---- B cannot ---------------------------------------------------------
  console.log('\nuser B is refused every one of them');
  for (const [name, url] of [
    ['projects', `/rest/v1/projects?id=eq.${projectId}&select=id`],
    ['drawings', `/rest/v1/drawings?id=eq.${drawingId}&select=id`],
    ['data_facts', `/rest/v1/data_facts?project_id=eq.${projectId}&select=fact_key`],
    ['bbs_calculation_runs', `/rest/v1/bbs_calculation_runs?id=eq.${runId}&select=id`],
    ['bbs_rows', `/rest/v1/bbs_rows?run_id=eq.${runId}&select=bar_mark`],
  ]) {
    const res = await api(url, { token: accounts[1].token });
    check(`B sees no ${name}`, Array.isArray(res.body) && res.body.length === 0, JSON.stringify(res.body));
  }

  const bList = await api('/rest/v1/projects?select=id', { token: accounts[1].token });
  check("B's own project list is empty", Array.isArray(bList.body) && bList.body.length === 0,
    JSON.stringify(bList.body));

  // B tries to WRITE into A's project — the insert policy's parent check
  const steal = await api('/rest/v1/drawings', {
    method: 'POST',
    token: accounts[1].token,
    body: {
      project_id: projectId,
      user_id: accounts[1].id,
      original_file_name: 'stolen.dxf',
    },
  });
  check("B cannot file a drawing into A's project", steal.status === 403 || steal.status === 401,
    `status ${steal.status} ${JSON.stringify(steal.body)}`);

  // B tries to write a row claiming to be A
  const impersonate = await api('/rest/v1/projects', {
    method: 'POST',
    token: accounts[1].token,
    body: { user_id: accounts[0].id, name: 'Impersonated' },
  });
  check('B cannot create a row owned by A', impersonate.status === 403 || impersonate.status === 401,
    `status ${impersonate.status} ${JSON.stringify(impersonate.body)}`);

  // ---- anonymous --------------------------------------------------------
  console.log('\nno session at all');
  const anon = await api('/rest/v1/projects?select=id');
  // Either refused outright (no table privilege for `anon`) or allowed through
  // to RLS and given nothing. Both are correct; seeing a ROW is not.
  check('an unauthenticated request reads nothing',
    (Array.isArray(anon.body) && anon.body.length === 0) || [401, 403, 404].includes(anon.status),
    `status ${anon.status} ${JSON.stringify(anon.body)}`);

  // ---- storage ----------------------------------------------------------
  console.log('\nstorage');
  const objectPath = `${accounts[0].id}/${projectId}/${drawingId}/verify.dxf`;
  const upload = await fetch(`${URL_BASE}/storage/v1/object/drawings/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: PUBLISHABLE,
      Authorization: `Bearer ${accounts[0].token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: '0\nSECTION\n',
  });
  check('A uploads a drawing file', upload.ok, `status ${upload.status} ${await upload.text().catch(() => '')}`);

  const bRead = await fetch(`${URL_BASE}/storage/v1/object/drawings/${objectPath}`, {
    headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${accounts[1].token}` },
  });
  check("B cannot download A's file even knowing the exact path", !bRead.ok, `status ${bRead.status}`);

  const anonRead = await fetch(`${URL_BASE}/storage/v1/object/public/drawings/${objectPath}`);
  check('the bucket is not public', !anonRead.ok, `status ${anonRead.status}`);

  // ---- cascade ----------------------------------------------------------
  if (!keep) {
    console.log('\ndeleting the project cascades to everything under it');
    await api(`/rest/v1/projects?id=eq.${projectId}`, { method: 'DELETE', token: accounts[0].token });
    const leftovers = await api(`/rest/v1/bbs_rows?project_id=eq.${projectId}&select=id`, {
      token: accounts[0].token,
    });
    check('no orphan schedule rows survive', Array.isArray(leftovers.body) && leftovers.body.length === 0,
      JSON.stringify(leftovers.body));
    const leftFacts = await api(`/rest/v1/data_facts?project_id=eq.${projectId}&select=id`, {
      token: accounts[0].token,
    });
    check('no orphan facts survive', Array.isArray(leftFacts.body) && leftFacts.body.length === 0,
      JSON.stringify(leftFacts.body));
  }
} catch (err) {
  failed += 1;
  failures.push(err instanceof Error ? err.message : String(err));
  console.error(`\nERROR ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (!keep) {
    for (const id of created) await deleteUser(id);
    if (created.length) console.log(`\ncleaned up ${created.length} test account(s).`);
  } else {
    console.log(`\n--keep: left ${created.length} test account(s) in place.`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failed ? 1 : 0);
