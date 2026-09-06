// What every prompt owes the transport it is sent over.
//
// Run 033 spent its judge call on a provider error that had nothing to do with
// engineering: "Prompt must contain the word 'json' in some form to use
// 'response_format' of type 'json_object'." DeepSeek enforces it; the model the
// lead happens to use does not, so the same latent fault sat unnoticed in the
// orchestrator prompt too and would have surfaced the day anyone repointed it.
//
// Every request this system makes sets response_format json_object, so every
// system prompt must satisfy that rule — and none of them may carry a figure
// the model is supposed to arrive at by reading.
import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_SYSTEM } from '../../src/cad/bbs/orchestrate';
import { SPECIALIST_SYSTEM } from '../../src/cad/bbs/tasks';
import { JUDGE_SYSTEM } from '../../src/cad/bbs/judge';

const PROMPTS: [string, string][] = [
  ['lead', ORCHESTRATOR_SYSTEM],
  ['specialist', SPECIALIST_SYSTEM],
  ['judge', JUDGE_SYSTEM],
];

describe('every system prompt', () => {
  it.each(PROMPTS)('%s says the word "json", as json_object mode requires', (_name, prompt) => {
    expect(prompt.toLowerCase()).toContain('json');
  });

  // the standing rule of this whole experiment: the models are never told what
  // the answer comes to, so an answer near it is evidence of reading and not of
  // being steered
  it.each(PROMPTS)('%s names no expected quantity', (_name, prompt) => {
    const p = prompt.toLowerCase();
    for (const forbidden of ['24948', '6.49', '6.5 t', '6494', '6305', 'tonn', 'expected total', 'reference schedule']) {
      expect(p).not.toContain(forbidden);
    }
  });

  it.each(PROMPTS)('%s is substantial enough to be the real prompt', (_name, prompt) => {
    expect(prompt.length).toBeGreaterThan(1000);
  });
});
