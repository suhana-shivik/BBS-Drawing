#!/usr/bin/env node
// What the AI has cost, and what is left.
//
//   node scripts/tokens.mjs              ask OpenRouter
//   node scripts/tokens.mjs --days 7     only the last 7 days of the table
//   node scripts/tokens.mjs --models     break each day down by model
//   node scripts/tokens.mjs --offline    just say which key would be used
//
// ONE THING TO BE CLEAR ABOUT UP FRONT: OpenRouter does not meter a token
// allowance. It meters CREDITS, in US dollars. So "how many are left" has a
// real answer — money — and "tokens left" does not, because no such budget
// exists.
//
// Tokens are counted PER REQUEST. OpenRouter adds those up per day and keeps
// 30 days of it, so "how many today, how many yesterday, how many across every
// day" does have an answer — the table this prints. Two things to know about
// those numbers: the days are UTC days, not IST ones, and the totals are for
// the whole ACCOUNT, not just this key or just this app.
//
// Plain .mjs on purpose: no dependency, no build step, no tsx. `node` is all
// it needs, and a diagnostic that itself needs a toolchain is a bad diagnostic.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OFFLINE = process.argv.includes('--offline');
const BY_MODEL = process.argv.includes('--models');

/** `--days 7`. OpenRouter keeps 30 days, so that is both the default and the cap. */
const DAYS = (() => {
  const n = Number(process.argv[process.argv.indexOf('--days') + 1]);
  return Number.isFinite(n) && n > 0 ? Math.min(30, Math.floor(n)) : 30;
})();

// ---------------------------------------------------------------- .env

/** Read .env without a dependency. Real env vars win — same as Vite. */
function readEnv() {
  const out = {};
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const at = t.indexOf('=');
      out[t.slice(0, at).trim()] = t
        .slice(at + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .env is a normal state for a fresh clone; the message below says so.
  }
  return { ...out, ...process.env };
}

const env = readEnv();

/**
 * The server-side key first. `VITE_OPENROUTER_API_KEY` is the one Vite bakes
 * into the browser bundle, so if that is the only one present it is worth
 * saying so — it means the key is still shipping to the client.
 */
const KEYS = ['OPENROUTER_API_KEY', 'VITE_OPENROUTER_API_KEY'];
const from = KEYS.find((k) => (env[k] ?? '').trim().length > 0);
const key = from ? env[from].trim() : '';

/**
 * A SECOND key, for the day-by-day table only.
 *
 * `/activity` is account analytics, not inference, and OpenRouter guards it
 * with a provisioning key — an ordinary sk-or-v1 inference key is refused. If
 * one is not set we still try the normal key, because being told plainly that
 * it was refused is more use than not asking.
 */
const PROV_KEYS = ['OPENROUTER_PROVISIONING_KEY', 'OPENROUTER_PROVISIONING_API_KEY'];
const provFrom = PROV_KEYS.find((k) => (env[k] ?? '').trim().length > 0);
const provKey = provFrom ? env[provFrom].trim() : '';

// ---------------------------------------------------------------- output

const usd = (n) =>
  typeof n === 'number' && Number.isFinite(n)
    ? `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
    : '—';

/** Thousands separators — 412300 raw is unreadable, 412,300 is not. */
const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—');

const bar = (used, total, width = 34) => {
  if (!(total > 0)) return '';
  const filled = Math.max(0, Math.min(width, Math.round((used / total) * width)));
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}]`;
};

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);

console.log('\nOpenRouter — spend and balance');
console.log('─'.repeat(52));

if (!key) {
  console.log('  No API key found.\n');
  console.log('  Set OPENROUTER_API_KEY in .env (server-side, no VITE_ prefix).');
  console.log('  Get one at https://openrouter.ai/keys');
  console.log('  For the day-by-day table, also set OPENROUTER_PROVISIONING_KEY');
  console.log('  from https://openrouter.ai/settings/provisioning-keys\n');
  process.exit(1);
}

line('key from', from);
line('key', `${key.slice(0, 12)}…${key.slice(-4)}  (${key.length} chars)`);
line('activity key from', provFrom ?? `${KEYS[0]} (no provisioning key set)`);
if (from === 'VITE_OPENROUTER_API_KEY') {
  console.log('\n  ! This is the VITE_ key, which Vite inlines into the browser');
  console.log('    bundle. Move it to OPENROUTER_API_KEY so it stays server-side.');
}

if (OFFLINE) {
  console.log('\n  --offline: nothing was sent.\n');
  process.exit(0);
}

// ---------------------------------------------------------------- fetch

const authFor = (bearer) => ({
  Authorization: `Bearer ${bearer}`,
  'Content-Type': 'application/json',
});

async function get(path, bearer = key) {
  const res = await fetch(`https://openrouter.ai/api/v1${path}`, { headers: authFor(bearer) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

/** `/key` is current; `/auth/key` is the older path. Try both before giving up. */
async function keyInfo() {
  const first = await get('/key');
  if (first.ok || first.status !== 404) return first;
  return get('/auth/key');
}

/** 30 days of usage, one row per (day, model). Provisioning key if we have one. */
const activity = () => get('/activity', provKey || key);

// ---------------------------------------------------------------- by day

const UTC_TODAY = new Date().toISOString().slice(0, 10);

/** "today" / "yesterday" / "6d ago", counted in UTC days like the data itself. */
function whenLabel(date) {
  const days = Math.round((Date.parse(`${UTC_TODAY}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

const W = { date: 10, when: 9, req: 6, prompt: 11, completion: 11, total: 12, cost: 9 };
const row = (c) =>
  `  ${c.date.padEnd(W.date)}  ${c.when.padEnd(W.when)}  ${c.req.padStart(W.req)}  ` +
  `${c.prompt.padStart(W.prompt)}  ${c.completion.padStart(W.completion)}  ` +
  `${c.total.padStart(W.total)}  ${c.cost.padStart(W.cost)}`;

/** Collapse the per-model rows OpenRouter returns into one entry per day. */
function byDay(rows) {
  const days = new Map();
  for (const r of rows) {
    const date = typeof r?.date === 'string' ? r.date.slice(0, 10) : '';
    if (!date) continue;
    const d =
      days.get(date) ??
      { date, requests: 0, prompt: 0, completion: 0, reasoning: 0, cost: 0, models: new Map() };
    const prompt = r.prompt_tokens || 0;
    const completion = r.completion_tokens || 0;
    const reasoning = r.reasoning_tokens || 0;
    const requests = r.requests || 0;
    // `usage` is the dollars OpenRouter billed; BYOK inference is billed elsewhere.
    const cost = (r.usage || 0) + (r.byok_usage_inference || 0);
    d.requests += requests;
    d.prompt += prompt;
    d.completion += completion;
    d.reasoning += reasoning;
    d.cost += cost;
    const name = r.model || r.model_permaslug || '(unnamed model)';
    const m = d.models.get(name) ?? { name, requests: 0, tokens: 0, cost: 0 };
    m.requests += requests;
    m.tokens += prompt + completion;
    m.cost += cost;
    d.models.set(name, m);
    days.set(date, d);
  }
  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function printActivity(res) {
  console.log(`\n${'─'.repeat(52)}`);
  console.log('  Tokens by day  (UTC days, whole account)\n');

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      console.log('  OpenRouter would not show activity to this key.');
      console.log('  /activity needs a PROVISIONING key, not an inference key.');
      console.log('  Make one at https://openrouter.ai/settings/provisioning-keys');
      console.log('  and add it to .env as OPENROUTER_PROVISIONING_KEY.');
    } else if (res.status === 404) {
      console.log('  This account has no /activity endpoint (HTTP 404).');
    } else {
      console.log(`  Activity unavailable (HTTP ${res.status}).`);
      console.log(`  ${JSON.stringify(res.body).slice(0, 200)}`);
    }
    return false;
  }

  const rows = Array.isArray(res.body?.data) ? res.body.data : [];
  const all = byDay(rows);
  if (all.length === 0) {
    console.log('  No recorded activity in the last 30 days.');
    return true;
  }

  const shown = all.slice(0, DAYS);
  console.log(
    row({
      date: 'date',
      when: '',
      req: 'runs',
      prompt: 'prompt',
      completion: 'completion',
      total: 'total tok',
      cost: 'cost',
    }),
  );
  console.log(`  ${'─'.repeat(76)}`);

  for (const d of shown) {
    const total = d.prompt + d.completion;
    console.log(
      row({
        date: d.date,
        when: whenLabel(d.date),
        req: num(d.requests),
        prompt: num(d.prompt),
        completion: num(d.completion),
        total: num(total),
        cost: usd(d.cost),
      }),
    );
    if (d.reasoning > 0) {
      console.log(`  ${' '.repeat(W.date + W.when + 2)}  (of which ${num(d.reasoning)} reasoning tokens)`);
    }
    if (BY_MODEL) {
      for (const m of [...d.models.values()].sort((a, b) => b.tokens - a.tokens)) {
        console.log(`      ${m.name.padEnd(42)} ${num(m.tokens).padStart(12)} tok  ${usd(m.cost).padStart(9)}`);
      }
    }
  }

  // The all-days line answers "sab milakar kitna" — every day OpenRouter still has.
  const sum = (f) => all.reduce((a, d) => a + f(d), 0);
  console.log(`  ${'─'.repeat(76)}`);
  console.log(
    row({
      date: `${all.length} days`,
      when: 'ALL',
      req: num(sum((d) => d.requests)),
      prompt: num(sum((d) => d.prompt)),
      completion: num(sum((d) => d.completion)),
      total: num(sum((d) => d.prompt + d.completion)),
      cost: usd(sum((d) => d.cost)),
    }),
  );
  if (shown.length < all.length) {
    console.log(`\n  (showing ${shown.length} of ${all.length} days — drop --days to see them all)`);
  }
  return true;
}

try {
  const [credits, info, acts] = await Promise.all([get('/credits'), keyInfo(), activity()]);

  if (!credits.ok && !info.ok) {
    const status = credits.status || info.status;
    console.log(`\n  OpenRouter refused the key (HTTP ${status}).`);
    console.log(
      status === 401
        ? '  The key is wrong, revoked, or from a different account.\n'
        : `  ${JSON.stringify(credits.body ?? info.body).slice(0, 200)}\n`,
    );
    process.exit(1);
  }

  console.log('');
  const c = credits.body?.data ?? {};
  const purchased = c.total_credits;
  const used = c.total_usage;

  if (typeof purchased === 'number' && typeof used === 'number') {
    const left = purchased - used;
    line('credits purchased', usd(purchased));
    line('credits used', usd(used));
    line('credits LEFT', `${usd(left)}   ${bar(used, purchased)}`);
    if (purchased > 0) {
      line('', `${((used / purchased) * 100).toFixed(1)}% spent`);
    }
    if (left <= 0) console.log('\n  ! Out of credit — model calls will fail until you top up.');
  } else {
    console.log('  (this account reports no purchased-credit total)');
  }

  const d = info.body?.data ?? {};
  if (info.ok) {
    console.log('');
    if (d.label) line('this key', d.label);
    if (typeof d.usage === 'number') line('spent by THIS key', usd(d.usage));
    if (d.limit === null || d.limit === undefined) line('this key’s cap', 'none');
    else line('this key’s cap', usd(d.limit));
    if (d.is_free_tier) line('tier', 'free');
    if (d.rate_limit?.requests) {
      line('rate limit', `${d.rate_limit.requests} / ${d.rate_limit.interval}`);
    }
  }

  const gotActivity = printActivity(acts);

  console.log(`\n${'─'.repeat(52)}`);
  for (const l of gotActivity
    ? ['  Those days are the whole account, bucketed in UTC. For this app', '  alone, in local time, it keeps its own log — in DevTools:']
    : ['  Without a provisioning key, the app’s own log is the record you', '  have. It is per run and in local time — in DevTools:']) {
    console.log(l);
  }
  console.log('');
  console.log("    Object.entries(JSON.parse(localStorage['bimcad.ai.log'] || '[]')");
  console.log('      .reduce((a, r) => {');
  console.log("        const d = new Date(r.at).toLocaleDateString('en-CA');");
  console.log('        a[d] ??= { n: 0, p: 0, c: 0, $: 0 };');
  console.log('        a[d].n++; a[d].p += r.promptTokens || 0;');
  console.log('        a[d].c += r.completionTokens || 0; a[d].$ += r.costUsd || 0;');
  console.log('        return a;');
  console.log('      }, {})).sort((x, y) => y[0].localeCompare(x[0]))');
  console.log('');
  console.log('  One row per local day, newest first. n = runs, p = prompt');
  console.log('  tokens, c = completion tokens, $ = cost. That log keeps only');
  console.log('  the last 80 runs, so the table above is the fuller record.\n');
} catch (err) {
  console.log(`\n  Could not reach OpenRouter: ${err?.message ?? err}`);
  console.log('  Check the network and try again.\n');
  process.exit(1);
}
