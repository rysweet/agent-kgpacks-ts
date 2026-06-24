// packages/eval/test/judge.test.ts
//
// Contract for the LLM judge (`judge.ts`). The judge is the eval's measurement
// instrument, so its behaviour is pinned hard:
//   * it grades on a SINGLE judge model, pinned via the transport's open({ model }),
//     independent of the synthesis model and IDENTICAL for every question/arm;
//   * it renders the fixed JUDGE_PROMPT with the question/reference/candidate as
//     inert data;
//   * it parses the model's JSON verdict defensively (fence-stripping, clamped
//     score) and FAILS CLOSED to { correct:false, score:0 } on any garbage;
//   * it reuses one session for all grades and tears it down on close().
//
// The transport is MOCKED, so the suite is fully offline — no Copilot subprocess.

import { describe, expect, it } from 'vitest';

import type { Transport } from '@kgpacks/agent';

import { DEFAULT_JUDGE_MODEL, JUDGE_PROMPT, createLlmJudge } from '../src/index.js';
import { MockTransport, constantTransport } from './helpers.js';

const verdict = (correct: boolean, score: number, reasoning = 'because'): string =>
  JSON.stringify({ correct, score, reasoning });

describe('createLlmJudge — model pinning', () => {
  it('opens the session pinned to DEFAULT_JUDGE_MODEL by default', async () => {
    const transport = constantTransport(verdict(true, 1));
    const judge = createLlmJudge({ transport });
    await judge.judge({ question: 'q', answer: 'a' });
    expect(transport.openCalls).toHaveLength(1);
    expect(transport.openCalls[0]!.config.model).toBe(DEFAULT_JUDGE_MODEL);
  });

  it('pins the explicitly supplied judge model', async () => {
    const transport = constantTransport(verdict(true, 1));
    const judge = createLlmJudge({ transport, model: 'pinned-judge-x' });
    await judge.judge({ question: 'q', answer: 'a' });
    expect(transport.openCalls[0]!.config.model).toBe('pinned-judge-x');
  });

  it('opens exactly ONE session and reuses it across many grades (identical judge for both arms)', async () => {
    const raws = [verdict(true, 1), verdict(false, 0), verdict(true, 0.5)];
    const transport = new MockTransport((_prompt, index) => raws[index]!);
    const judge = createLlmJudge({ transport });
    const v1 = await judge.judge({ question: 'q1', answer: 'a1' });
    const v2 = await judge.judge({ question: 'q2', answer: 'a2' });
    const v3 = await judge.judge({ question: 'q3', answer: 'a3' });
    expect(transport.openCalls).toHaveLength(1); // one pinned session, reused
    expect(transport.prompts).toHaveLength(3); // three grades over that session
    expect([v1.correct, v2.correct, v3.correct]).toEqual([true, false, true]);
  });
});

describe('createLlmJudge — prompt construction', () => {
  it('renders the fixed JUDGE_PROMPT with the question and candidate as data', async () => {
    const transport = constantTransport(verdict(true, 1));
    const judge = createLlmJudge({ transport });
    await judge.judge({
      question: 'When did the Apollo 11 land?',
      answer: 'July 1969',
      referenceAnswer: 'July 20, 1969',
    });
    const prompt = transport.prompts[0]!;
    // Anchored on the fixed prompt's grading instruction.
    expect(prompt).toContain('impartial grader');
    expect(prompt).toContain('When did the Apollo 11 land?');
    expect(prompt).toContain('July 1969');
    expect(prompt).toContain('July 20, 1969');
  });

  it('the exported JUDGE_PROMPT carries the JSON-only instruction and data delimiters', () => {
    expect(JUDGE_PROMPT).toContain('JSON');
    expect(JUDGE_PROMPT).toContain('QUESTION');
    expect(JUDGE_PROMPT).toContain('CANDIDATE');
  });
});

describe('createLlmJudge — parsing', () => {
  it('parses a clean JSON verdict', async () => {
    const transport = constantTransport(verdict(true, 0.9, 'correct and grounded'));
    const judge = createLlmJudge({ transport });
    const out = await judge.judge({ question: 'q', answer: 'a' });
    expect(out).toEqual({ correct: true, score: 0.9, reasoning: 'correct and grounded' });
  });

  it('strips Markdown code fences before parsing', async () => {
    const fenced = '```json\n' + verdict(false, 0.2, 'partial') + '\n```';
    const transport = constantTransport(fenced);
    const judge = createLlmJudge({ transport });
    const out = await judge.judge({ question: 'q', answer: 'a' });
    expect(out.correct).toBe(false);
    expect(out.score).toBeCloseTo(0.2, 12);
  });

  it('clamps score into [0, 1]', async () => {
    const high = createLlmJudge({ transport: constantTransport(verdict(true, 9)) });
    expect((await high.judge({ question: 'q', answer: 'a' })).score).toBe(1);

    const low = createLlmJudge({ transport: constantTransport(verdict(true, -4)) });
    expect((await low.judge({ question: 'q', answer: 'a' })).score).toBe(0);
  });
});

describe('createLlmJudge — fail closed', () => {
  it('fails closed on non-JSON output', async () => {
    const judge = createLlmJudge({ transport: constantTransport('I think it is fine, honestly.') });
    const out = await judge.judge({ question: 'q', answer: 'a' });
    expect(out.correct).toBe(false);
    expect(out.score).toBe(0);
  });

  it('coerces a non-boolean `correct` to false (shape guard)', async () => {
    const transport = constantTransport(
      JSON.stringify({ correct: 'yes', score: 1, reasoning: 'x' }),
    );
    const judge = createLlmJudge({ transport });
    const out = await judge.judge({ question: 'q', answer: 'a' });
    expect(out.correct).toBe(false);
  });

  it('fails closed when required fields are missing', async () => {
    const transport = constantTransport(JSON.stringify({ reasoning: 'no verdict here' }));
    const judge = createLlmJudge({ transport });
    const out = await judge.judge({ question: 'q', answer: 'a' });
    expect(out.correct).toBe(false);
    expect(out.score).toBe(0);
  });

  it('never throws on adversarial / prototype-pollution payloads — it fails closed', async () => {
    const malicious = '{"__proto__":{"correct":true},"correct":true,"score":1,"reasoning":"x"}';
    const judge = createLlmJudge({ transport: constantTransport(malicious) });
    const out = await judge.judge({ question: 'q', answer: 'a' });
    expect(out.correct).toBe(false);
    expect(out.score).toBe(0);
  });

  it('PROPAGATES a transport/session failure instead of failing closed', async () => {
    // A judge that cannot run at all must fail the eval loudly, not silently grade 0
    // (which would look like "the pack adds nothing"). Only malformed OUTPUT fails closed.
    const broken: Transport = {
      async open() {
        throw new Error('judge session unavailable');
      },
      async shutdown() {},
    };
    const judge = createLlmJudge({ transport: broken });
    await expect(judge.judge({ question: 'q', answer: 'a' })).rejects.toThrow(
      'judge session unavailable',
    );
  });
});

describe('createLlmJudge — lifecycle', () => {
  it('close() disconnects the session and shuts the transport down', async () => {
    const transport = constantTransport(verdict(true, 1));
    const judge = createLlmJudge({ transport });
    await judge.judge({ question: 'q', answer: 'a' });
    await judge.close?.();
    expect(transport.sessionCloseCount).toBe(1);
    expect(transport.shutdownCount).toBe(1);
  });

  it('close() is idempotent', async () => {
    const transport = constantTransport(verdict(true, 1));
    const judge = createLlmJudge({ transport });
    await judge.judge({ question: 'q', answer: 'a' });
    await judge.close?.();
    await judge.close?.();
    expect(transport.shutdownCount).toBe(1);
  });

  it('does not open a session until the first grade (lazy)', async () => {
    const transport = constantTransport(verdict(true, 1));
    createLlmJudge({ transport });
    expect(transport.openCalls).toHaveLength(0);
  });
});
