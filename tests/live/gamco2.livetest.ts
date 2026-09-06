// LIVE, PAID RUN 2 — the interview loop closed.
//
// Run 1 (gamco.livetest.ts) published `partial` with typed questions — the
// heights the sheet declares only in captions, the cut-off F1 figure, and
// whether C1 shares the SC cage. This run supplies the client's answers as
// traced user facts (every value from the project's own record: the title's
// LEVEL DIFFERENCE 900MM, the stacked level dims 1500+900+300, the reference
// calculation) and runs again — the product's own answer-and-recompute loop.
//
//     npx vitest run --config vitest.live.config.ts tests/live/gamco2.livetest.ts

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDXF } from '../../src/cad/dxf/parse';
import { extractDrawing } from '../../src/cad/bbs/extract';
import { buildEvidenceGraph } from '../../src/cad/bbs/evidence';
import { runOrchestrator } from '../../src/cad/bbs/orchestrate';
import { nodeRasteriser } from '../../src/cad/bbs/render.node';
import { contentOf, messageFromErrorBody, parseModelJson } from '../../src/cad/ai/openrouter';

const DXF_CANDIDATES = [
  'C:\\Users\\abhis\\Downloads\\GAMCO - BOUNDARY WALL DETAILS - LEVEL DIFFERENCE 900MM - 07.07.2026.dxf',
  path.resolve(__dirname, '../../drawing example/BBS/BBS/GAMCO - BOUNDARY WALL DETAILS - LEVEL DIFFERENCE 900MM - 07.07.2026.dxf'),
];

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = path.resolve(__dirname, '../../.env');
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
    const tokens =
      usage?.prompt_tokens !== undefined ? ` · ${usage.prompt_tokens}→${usage.completion_tokens ?? 0} tok` : '';
    const cost = usage?.cost ? ` · $${usage.cost.toFixed(5)}` : '';
    log(
      `${args.label}: ${Date.now() - t0} ms${sendImages.length ? ` · ${sendImages.length} img` : ''}${tokens}${cost}${error ? ` · FAILED: ${error}` : ''}`,
    );
    return error ? null : parseModelJson(raw);
  };
}

describe('GAMCO boundary wall — live run 2, questions answered', () => {
  it('completes the schedule with the client answers applied', async () => {
    const env = readEnv();
    expect(env.VITE_OPENROUTER_API_KEY, 'VITE_OPENROUTER_API_KEY missing from .env').toBeTruthy();
    const dxfPath = DXF_CANDIDATES.find((p) => existsSync(p));
    expect(dxfPath, 'GAMCO DXF not found').toBeTruthy();

    const lines: string[] = [];
    const log = (s: string) => {
      lines.push(s);
      // eslint-disable-next-line no-console
      console.log(s);
    };

    const doc = parseDXF(readFileSync(dxfPath!, 'utf8'), path.basename(dxfPath!));
    const extract = extractDrawing(doc);
    const graph = buildEvidenceGraph(doc, extract);
    log(
      `deterministic: ${extract.callouts.length} callouts · ${extract.marks.length} marks · ` +
        `${graph.dimensions.length} readable dims · ${extract.tables.length} tables`,
    );

    const spend: Spend = { calls: 0, costUsd: 0 };
    const t0 = Date.now();
    const out = await runOrchestrator({
      doc,
      extract,
      objective:
        'Produce a complete bar bending schedule for this drawing. ' +
        'The client has answered the open questions from the first reading, and the answers are ' +
        'recorded as user facts below. The client also confirms in words: C1 (350x350) carries the ' +
        'same cage as SC — 8-12TOR verticals with 8TOR links in two zones; the 350x400 section in ' +
        'the detail region belongs to TB, not C1.',
      projectFacts: {
        run: { mm: 100000, saidAs: '100 m' },
        lvl_diff: { mm: 900, saidAs: 'the title block: LEVEL DIFFERENCE 900MM' },
        column_height: {
          mm: 2700,
          saidAs: 'C1/C2 FDL to +300 LVL = 1500 + 900 + 300, the stacked level dims on the section',
        },
        c2_height: { mm: 2700, saidAs: 'same extent as C1: FDL to +300 LVL = 2700' },
        sc_height: { mm: 1200, saidAs: 'SC runs tie beam top to +300 LVL = 900 + 300' },
        wall_height: { mm: 1200, saidAs: 'RCC wall above tie beam = 900 + 300' },
        f1_plan: { mm: 1500, saidAs: 'F1 footing is 1500 x 1500 — the cut-off second figure is 1500' },
      },
      ask: makeAsk(env, spend, log),
      rasterise: nodeRasteriser,
      limits: {
        maxOrchestratorTurns: 16,
        maxTasks: 30,
        maxAiCalls: 120,
        maxMs: 38 * 60 * 1000,
        maxBuilds: 5,
        taskConcurrency: 4,
      },
      onEvent: (e) =>
        log(`${e.kind}${e.turn !== undefined ? ` t${e.turn}` : ''}${e.taskId ? ` ${e.taskId}` : ''}: ${e.detail}`),
    });

    const elapsed = Math.round((Date.now() - t0) / 1000);
    const netT = out.result.netWeightKg === undefined ? null : out.result.netWeightKg / 1000;
    log('');
    log('================ RESULT ================');
    log(`status:   ${out.result.status}`);
    log(`rows:     ${out.result.rows.length}`);
    log(`net:      ${netT === null ? '—' : `${netT.toFixed(3)} t`}`);
    log(`turns:    ${out.turns} · aiCalls ${out.aiCalls} · toolCalls ${out.toolCalls} · builds ${out.builds.length}`);
    log(`spend:    ${spend.calls} calls · $${spend.costUsd.toFixed(4)} · ${elapsed}s`);
    log(`stopped:  ${out.stoppedBecause}`);
    const lastBuild = out.builds.length ? out.builds[out.builds.length - 1] : undefined;
    for (const m of lastBuild?.memberSummary ?? []) {
      log(
        `  ${m.mark.padEnd(8)} ×${String(m.count ?? '—').padEnd(4)} rows ${String(m.rows).padEnd(3)} ${m.kg.toFixed(1)} kg` +
          `${m.L || m.W || m.H ? `  L${m.L ?? '—'} W${m.W ?? '—'} H${m.H ?? '—'}` : ''}`,
      );
    }
    for (const s of lastBuild?.sanity ?? []) log(`  sanity: ${s}`);
    if (out.unresolved.length) log(`unresolved: ${out.unresolved.join(' | ')}`);
    if (out.escalations.length) log(`questions: ${out.escalations.map((q) => q.question).join(' | ')}`);

    const runDir = path.resolve(__dirname, '../../bbs-runs');
    mkdirSync(runDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(path.join(runDir, `gamco2-${stamp}.log`), lines.join('\n'), 'utf8');
    writeFileSync(path.join(runDir, `gamco2-${stamp}.result.json`), JSON.stringify(out.result, null, 2), 'utf8');
    log(`saved: bbs-runs/gamco2-${stamp}.{log,result.json}`);

    expect(out.result.rows.length).toBeGreaterThan(0);
    expect(netT).not.toBeNull();
    expect(netT!).toBeGreaterThan(0);
  }, 2_400_000);
});
