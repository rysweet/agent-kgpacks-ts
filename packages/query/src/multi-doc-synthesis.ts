// @kgpacks/query — multi-document synthesis (ENHANCEMENTS).
//
// A thin adapter from `RetrieverResult[]` to the agent's `SynthesisRequest`. No
// model calls are reimplemented here — answer generation is delegated entirely to
// `@kgpacks/agent`'s `synthesizeAnswer`. Maps each result to a `ContextChunk`,
// passes the full list (multidoc) or only the top result (single-doc grounding),
// renders any few-shot exemplars into a demonstrations preamble on the question
// (WITHOUT adding them to `citedIds`), and returns the agent's result unchanged.

import type { ContextChunk, SynthesisResult } from '@kgpacks/agent';

import type { FewShotExample, RetrieverResult, SynthesisAgent } from './types.js';

/** Renders few-shot exemplars into a short demonstrations preamble. */
function renderExemplars(exemplars: FewShotExample[]): string {
  if (exemplars.length === 0) {
    return '';
  }
  const demonstrations = exemplars.map((exemplar) => exemplar.text).join('\n');
  return ['Here are some examples of good answers:', demonstrations, ''].join('\n') + '\n';
}

/**
 * Synthesizes a single grounded, cited answer from `results` via `agent`.
 *
 * - Maps each `RetrieverResult` to a `ContextChunk` (`{ id, text: content }`).
 * - `multidoc: false` passes only the top result as context; `true` passes all.
 * - `exemplars` are rendered into a demonstrations preamble prepended to
 *   `question`; they are NOT added to the answer's `citedIds`.
 * - Returns the agent's `SynthesisResult` unchanged.
 */
export async function synthesizeFromResults(
  agent: SynthesisAgent,
  question: string,
  results: RetrieverResult[],
  opts: { exemplars?: FewShotExample[]; multidoc?: boolean; timeoutMs?: number } = {},
): Promise<SynthesisResult> {
  const grounding = opts.multidoc ? results : results.slice(0, 1);
  const context: ContextChunk[] = grounding.map((result) => ({
    id: result.id,
    text: result.content,
  }));

  const preamble = renderExemplars(opts.exemplars ?? []);
  const augmentedQuestion = preamble + question;

  return agent.synthesizeAnswer({
    question: augmentedQuestion,
    context,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
}
