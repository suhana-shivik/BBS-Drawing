// ============================================================
// Run the ACTUAL BBS pipeline on one DXF from the command line.
//
//   npx vite-node scripts/bbs-run.ts -- --dxf "C:\path\to\drawing.dxf" \
//       [--facts facts.json] [--answers answers.json] [--out bbs-runs] \
//       [--number PCD-IND-B300-S-803-R0] [--rev R0] [--title "FOUNDATION LAYOUT PLAN"] \
//       [--turns 10] [--recalc]
//
// Exactly the product's path, nothing parallel: the drawing reader
// (parseDXF → extractDrawing), the orchestrator (runOrchestrator, which
// grounds every member from the sheet's schedule tables and the project
// facts, asks for what is missing, and builds every row through
// calculations/schedule.ts), the steel summary and the reconciliation — then
// the same workbook writer the studio downloads from.
//
//   --facts     {"f8_count": {"mm": 8, "saidAs": "8 (plan tags)"}, ...} — the
//               latest USER_INPUT DataFacts, as engine keys (bbsFacts.ts).
//   --answers   {"clear cover": "50", "F9 length": "3300"} — answers put to
//               questions whose text contains the key (case-insensitive).
//               A question with no matching answer stays OPEN and is listed.
//   --recalc    replay only — no model turn; needs --about <about.json>.
//
// Prints the schedule snapshot before writing anything, and writes
//   <out>/<stem>-<stamp>.result.json   the BbsChatResult (rows with traces)
//   <out>/<stem>-<stamp>.log           the run log and every question asked
//   <out>/<stem>-<stamp>.xlsx          Schedule · Steel summary · Calculation trace
// ============================================================
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { EngineFact } from '../src/cad/bbs/refs';
import path from 'node:path';
import { parseDXF } from '../src/cad/dxf/parse';
import { extractDrawing } from '../src/cad/bbs/extract';
import { buildEvidenceGraph } from '../src/cad/bbs/evidence';
import { runOrchestrator } from '../src/cad/bbs/orchestrate';
// run with vite-node (npx vite-node scripts/bbs-run.ts -- …): the engine imports SKILL.md?raw
import { nodeRasteriser } from '../src/cad/bbs/render.node';
import { contentOf, messageFromErrorBody, parseModelJson } from '../src/cad/ai/openrouter';
import { memberFactsFromTables } from '../src/cad/bbs/tableFacts';
import { bbsFileName, buildBbsWorkbook, writeBbsXlsx, statusText } from '../src/io/bbsWorkbook';
import type { AskableQuestion } from '../src/cad/bbs/askFrom';
import { drawingHash } from '../src/cad/understanding/hash';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? 'true' : v;
}

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = path.resolve(__dirname, '../.env');
  if (!existsSync(envPath)) return out;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

interface Spend {
  calls: number;
  costUsd: number;
}

function makeAsk(env: Record<string, string>, spend: Spend, log: (s: string) => void) {
  const apiKey = env.VITE_OPENROUTER_API_KEY;
  const model = env.VITE_OPENROUTER_TEXT_MODEL || env.VITE_OPENROUTER_VISION_MODEL;
  const judgeModel = env.VITE_OPENROUTER_JUDGE_MODEL || model;
  let lastAt = 0;
  return async (args: {
    system: string;
    prompt: string;
    images: { dataUrl: string; caption: string }[];
    label: string;
  }): Promise<Record<string, unknown> | null> => {
    const wait = lastAt + 120 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const t0 = Date.now();
    const timeoutMs = args.label === 'orchestrator' || args.label === 'judge' ? 240_000 : 90_000;
    let raw = '';
    let error: string | undefined;
    let usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined;
    let sendImages = args.images ?? [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      error = undefined;
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'X-Title': env.VITE_OPENROUTER_APP_NAME || 'BIMCAD Studio',
          },
          body: JSON.stringify({
            model: args.label === 'judge' ? judgeModel : model,
            temperature: 0.1,
            max_tokens: 16000,
            reasoning: { effort: 'low' },
            response_format: { type: 'json_object' },
            usage: { include: true },
            messages: [
              { role: 'system', content: args.system },
              {
                role: 'user',
                content: sendImages.length
                  ? [
                      { type: 'text', text: args.prompt },
                      ...sendImages.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } })),
                    ]
                  : args.prompt,
              },
            ],
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          error = messageFromErrorBody(res.status, body);
          if (attempt === 1 && sendImages.length && /image input|image_url|does not support image/i.test(body + error)) {
            sendImages = [];
            continue;
          }
          break;
        }
        const payload = (await res.json()) as Record<string, unknown>;
        raw = contentOf(payload);
        usage = payload.usage as typeof usage;
        if (attempt === 1 && !parseModelJson(raw)) {
          error = 'the reply came back empty or unreadable';
          continue;
        }
        error = undefined;
        break;
      } catch (e) {
        error = `request failed — ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    lastAt = Date.now();
    spend.calls += 1;
    spend.costUsd += usage?.cost ?? 0;
    const tokens = usage?.prompt_tokens !== undefined ? ` · ${usage.prompt_tokens}→${usage.completion_tokens ?? 0} tok` : '';
    const cost = usage?.cost ? ` · $${usage.cost.toFixed(5)}` : '';
    log(`${args.label}: ${Date.now() - t0} ms${sendImages.length ? ` · ${sendImages.length} img` : ''}${tokens}${cost}${error ? ` · FAILED: ${error}` : ''}`);
    return error ? null : parseModelJson(raw);
  };
}

async function main(): Promise<void> {
  const dxfPath = arg('dxf');
  if (!dxfPath || !existsSync(dxfPath)) throw new Error('--dxf <path> is required and must exist');
  const outDir = arg('out', 'bbs-runs')!;
  mkdirSync(outDir, { recursive: true });
  const stem = path.basename(dxfPath).replace(/\.dxf$/i, '').replace(/[^a-z0-9_-]+/gi, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(outDir, `${stem}-${stamp}`);
  const lines: string[] = [];
  const log = (s: string): void => {
    lines.push(s);
    // eslint-disable-next-line no-console
    console.log(s);
  };

  const env = readEnv();
  const recalc = arg('recalc') === 'true';
  if (!recalc && !env.VITE_OPENROUTER_API_KEY) throw new Error('VITE_OPENROUTER_API_KEY missing from .env');

  const facts = arg('facts') ? (JSON.parse(readFileSync(arg('facts')!, 'utf8')) as Record<string, EngineFact>) : {};
  const answers = arg('answers') ? (JSON.parse(readFileSync(arg('answers')!, 'utf8')) as Record<string, string>) : {};
  const about = arg('about') ? (JSON.parse(readFileSync(arg('about')!, 'utf8')) as { conclusions?: Record<string, unknown>[] }) : null;

  const text = readFileSync(dxfPath, 'utf8');
  const doc = parseDXF(text, path.basename(dxfPath));
  const extract = extractDrawing(doc);
  const hash = await drawingHash(doc, null).catch(() => 'not computed');
  extract.hash = hash;
  const graph = buildEvidenceGraph(doc, extract);
  log(`drawing: ${path.basename(dxfPath)} · hash ${hash}`);
  log(`deterministic: ${extract.callouts.length} callouts · ${extract.marks.length} marks · ${graph.dimensions.length} readable dims · ${extract.tables.length} tables`);
  const table = memberFactsFromTables(extract);
  log(`schedule tables state ${table.dims.length} member dimension(s): ${table.dims.map((d) => `${d.factId}=${d.mm}`).join(', ') || 'none'}`);
  for (const n of table.notes) log(`  table note: ${n}`);
  log(`project facts (USER_INPUT, latest): ${Object.entries(facts).map(([k, v]) => `${k}=${v.mm}`).join(', ') || 'none'}`);

  const asked: { question: AskableQuestion; answer: string | null }[] = [];
  const askUser = async (q: AskableQuestion): Promise<string | null> => {
    const key = Object.keys(answers).find((k) => q.question.toLowerCase().includes(k.toLowerCase()));
    const answer = key ? answers[key] : null;
    asked.push({ question: q, answer });
    log(`ASK [${q.id}] ${q.question}`);
    log(`    → ${answer === null ? '(no answer on file — stays OPEN)' : `"${answer}"`}`);
    return answer;
  };

  const spend: Spend = { calls: 0, costUsd: 0 };
  const turns = Number(arg('turns', '10'));
  const t0 = Date.now();
  const out = await runOrchestrator({
    doc,
    extract,
    objective:
      'Produce a complete bar bending schedule for this drawing. The sheet carries a schedule table; ' +
      'its member dimensions and bar cells are read deterministically and govern. Establish ownership, ' +
      'placement (how many of each member the layout shows) and shape for every callout. For any axis or ' +
      'count the sheet does not state, point at the matching project fact with a {kind:"user-fact", factId} ' +
      'reference; ask the client only for what neither the sheet nor the record states.',
    projectFacts: facts,
    ...(about?.conclusions ? { priorConclusions: about.conclusions } : {}),
    ask: makeAsk(env, spend, log),
    askUser,
    rasterise: nodeRasteriser,
    // Nobody is at the keyboard: a cover neither the sheet nor the record
    // states is spent as the project default, every row says ASSUMED, and
    // the cover question is listed open. `--strict-cover` holds rows open instead.
    computeOnAssumedCover: arg('strict-cover') !== 'true',
    independentJudge: !recalc,
    limits: recalc
      ? { maxOrchestratorTurns: 0, maxTasks: 0, maxAiCalls: 0, maxMs: 2 * 60 * 1000, maxBuilds: 6, taskConcurrency: 1 }
      : { maxOrchestratorTurns: turns, maxTasks: 30, maxAiCalls: 80, maxMs: 30 * 60 * 1000, maxBuilds: 4, taskConcurrency: 3 },
    onEvent: (e) => log(`${e.kind}${e.turn !== undefined ? ` t${e.turn}` : ''}${e.taskId ? ` ${e.taskId}` : ''}: ${e.detail}`),
  });

  log('');
  log('— schedule snapshot —');
  for (const l of out.snapshot) log(`  ${l}`);
  for (const u of out.unresolved.filter((x) => /^(dimension|axis) override:/.test(x))) log(`  ${u}`);
  log('');
  log(`status ${out.result.status} · ${out.result.rows.length} rows · net ${((out.result.netWeightKg ?? 0) / 1000).toFixed(3)} t · ${out.turns} turns · ${spend.calls} calls · $${spend.costUsd.toFixed(4)} · ${Math.round((Date.now() - t0) / 1000)}s · stopped: ${out.stoppedBecause}`);
  log('');
  log('— rows —');
  for (const r of out.result.rows) {
    const t = r.trace;
    log(
      `${r.barMark.padEnd(8)} ${r.memberMark.padEnd(4)} T${String(r.diameterMm).padEnd(3)} ` +
        `CL ${r.cuttingLengthMm ?? '—'} · ${r.barsPerMember ?? '—'} × ${r.memberCount ?? '—'} = ${r.totalBars ?? '—'} · ` +
        `${r.totalLengthM?.toFixed(2) ?? '—'} m · ${r.totalWeightKg?.toFixed(2) ?? '—'} kg · cover ${r.coverMm ?? '—'} ${r.coverStatus ?? ''} · ` +
        `${t?.failedStage ? `FAILED ${t.failedStage} on ${t.missingFact ?? '?'}` : 'VALIDATED'}`,
    );
    if (r.status !== 'verified') log(`         ${statusText(r)}`);
  }
  log('');
  log('— steel summary —');
  for (const s of out.result.diameterSummary) {
    log(`T${s.diaMm}: ${s.barCount} bars · ${s.totalLengthM.toFixed(2)} m · ${s.totalWeightKg.toFixed(2)} kg (+wastage ${s.totalWeightWithWastageKg.toFixed(2)} kg)`);
  }
  const open = asked.filter((a) => a.answer === null);
  if (open.length) {
    log('');
    log(`— ${open.length} question(s) still open — answer these and recalculate —`);
    for (const a of open) log(`  ${a.question.id}: ${a.question.question}`);
  }
  if (out.unresolved.length) {
    log('');
    log('— unresolved, as the run recorded them —');
    for (const u of out.unresolved) log(`  ${u}`);
  }

  const provenance = {
    drawingName: arg('title', extract.drawingName),
    drawingFile: path.basename(dxfPath),
    drawingNumber: arg('number'),
    revision: arg('rev'),
    preparedBy: 'BIMCAD Studio (CLI)',
    exportedAt: Date.now(),
    conventions: [
      'Bend deductions per IS 2502 Table 1; development length and laps per IS 456.',
      'Unit mass per IS 1786 nominal mass (d² ÷ 162 kg/m).',
      'Open rows carry no quantity — a blocked cell is EMPTY, never zero, and is in no total.',
      'Every cutting length shows the cover it was cut to and whether that cover was read, supplied or ASSUMED.',
      'The Calculation trace sheet names, per row, the stage reached and what would complete it.',
    ],
  };
  writeFileSync(`${base}.result.json`, JSON.stringify({ result: out.result, snapshot: out.snapshot, asked, unresolved: out.unresolved, tableFacts: out.tableFacts, escalations: out.escalations }, null, 2));
  const xlsxName = bbsFileName(provenance, { version: Number(arg('version', '0')) || undefined });
  const xlsxPath = path.join(outDir, `${stem}-${stamp}-${xlsxName}`);
  writeFileSync(xlsxPath, writeBbsXlsx({ result: out.result, provenance }));
  void buildBbsWorkbook;
  writeFileSync(`${base}.log`, lines.join('\n'));
  log('');
  log(`written: ${base}.result.json`);
  log(`written: ${xlsxPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
