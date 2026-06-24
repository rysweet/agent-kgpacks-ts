// @kgpacks/eval — the LLM judge.
//
// The eval's measurement instrument. The judge grades on a SINGLE model pinned via
// the transport's `open({ model })` — independent of the synthesis model and
// IDENTICAL for every question and BOTH arms (docs/PLAN.md Acceptance Criteria).
// It does NOT route through `synthesizeAnswer` (which binds the synthesis model and
// frames the prompt as grounded answering); it drives `@kgpacks/agent`'s tool-less
// completion transport directly so the judge model pins independently and the model
// sees only the grading instruction.
//
// It opens ONE session lazily (on first grade), reuses it for every grade, and
// tears it down on close(). Grading fails CLOSED on PARSE/SHAPE failures: malformed
// model output scores `{ correct: false, score: 0 }` rather than throwing, so a bad
// grade can only hurt an arm, never inflate it. A transport/session failure (the
// judge cannot run at all) is NOT swallowed — it propagates so a broken/unavailable
// judge fails the eval loudly instead of silently reporting both arms as zero.

import { safeParseJson, stripMarkdownFences } from '@kgpacks/agent';
import type { TransportSession } from '@kgpacks/agent';

import { DEFAULT_JUDGE_MODEL, JUDGE_PROMPT, NO_REFERENCE } from './constants.js';
import type { Judge, JudgeInput, JudgeVerdict, LlmJudgeOptions } from './types.js';

/**
 * Builds a {@link Judge} that scores an answer with the fixed {@link JUDGE_PROMPT}
 * on a judge model held constant across both arms. The session is opened lazily on
 * the first grade and reused thereafter; `close()` releases it and is idempotent.
 */
export function createLlmJudge(options: LlmJudgeOptions): Judge {
  const { transport } = options;
  const model = options.model ?? DEFAULT_JUDGE_MODEL;
  const prompt = options.prompt ?? JUDGE_PROMPT;
  const timeoutMs = options.timeoutMs;

  let session: TransportSession | undefined;
  let closed = false;

  async function getSession(): Promise<TransportSession> {
    if (!session) {
      session = await transport.open({ model });
    }
    return session;
  }

  return {
    async judge(input: JudgeInput): Promise<JudgeVerdict> {
      const rendered = renderPrompt(prompt, input);
      // Transport/session/send failures propagate (the judge could not run at all);
      // only malformed model OUTPUT fails closed, inside parseVerdict.
      const active = await getSession();
      const response = await active.send(rendered, timeoutMs);
      return parseVerdict(response.content);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const active = session;
      session = undefined;
      if (active) await active.close();
      await transport.shutdown();
    },
  };
}

/** Renders the fixed prompt, injecting the question/reference/candidate as data. */
function renderPrompt(template: string, input: JudgeInput): string {
  const reference =
    input.referenceAnswer !== undefined && input.referenceAnswer.length > 0
      ? input.referenceAnswer
      : NO_REFERENCE;
  // split/join (not String.replace) so `$`-sequences in the data are inert and
  // every placeholder occurrence is substituted literally.
  return template
    .split('{{question}}')
    .join(input.question)
    .split('{{reference}}')
    .join(reference)
    .split('{{candidate}}')
    .join(input.answer);
}

/**
 * Parses a raw judge response into a {@link JudgeVerdict}, failing closed:
 *   1. strip Markdown fences;
 *   2. parse with the prototype-pollution-guarded `safeParseJson` (never `eval`);
 *   3. shape-guard — non-boolean `correct` coerces to false, `score` clamps to
 *      [0, 1], non-string `reasoning` empties;
 *   4. any parse/shape failure yields `{ correct: false, score: 0 }`.
 */
function parseVerdict(raw: string): JudgeVerdict {
  let parsed: unknown;
  try {
    parsed = safeParseJson(stripMarkdownFences(raw));
  } catch {
    return failClosed('unparseable judge output');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return failClosed('judge output was not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  return {
    correct: obj.correct === true,
    score: clampScore(obj.score),
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
  };
}

/** Clamps an unknown score into [0, 1]; non-finite/non-number → 0. */
function clampScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** The fail-closed verdict: never throws, never marks an answer correct. */
function failClosed(reasoning: string): JudgeVerdict {
  return { correct: false, score: 0, reasoning };
}
