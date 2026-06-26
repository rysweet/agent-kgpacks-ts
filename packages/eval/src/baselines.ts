// @kgpacks/eval — the two baseline arms.
//
// Ports the reference baselines module. Both arms share the single judged
// pipeline; they differ
// ONLY in the context supplied to synthesis, which is what isolates the pack's
// contribution (decision D5):
//   * with-pack    — full retrieve + synthesize over the pack;
//   * training-only — synthesize with an EMPTY context in CLOSED-BOOK mode, so the
//                     model answers from its own training knowledge alone (rather
//                     than refusing for lack of grounding). This is the no-corpus
//                     baseline the pack must beat.
// Each arm reads the prompt from `question.question`, awaits its synthesis call,
// and maps the result onto `ArmAnswer` (answer text + token usage).

import type { Retriever, RetrieveOptions, SynthesisAgent } from '@kgpacks/query';

import type { Arm } from './types.js';

/**
 * The **with-pack** arm: the full retrieve-then-synthesize pipeline from
 * `@kgpacks/query`. `opts` are forwarded verbatim so the eval exercises whatever
 * retrieval configuration (mode, `k`, enhancement flags) is being measured.
 *
 * `retrieveAndSynthesize` always synthesizes, so the retriever must be built with
 * an agent (`createRetriever(conn, { agent })`); otherwise it throws `QueryError`
 * on the first call.
 */
export function withPackArm(retriever: Retriever, opts?: RetrieveOptions): Arm {
  return {
    name: 'with-pack',
    async answer(question) {
      const result = await retriever.retrieveAndSynthesize(question.question, opts);
      return { answer: result.synthesis.answer, usage: result.synthesis.usage };
    },
  };
}

/**
 * The **training-only** arm: synthesis with an EMPTY context list — no pack
 * retrieval — in CLOSED-BOOK mode, so the model answers the question from its OWN
 * training knowledge rather than refusing for lack of grounding. This is the
 * no-corpus baseline the pack must beat: it measures what the model already knows,
 * isolating the pack's incremental contribution. (`SynthesisAgent` is the
 * `@kgpacks/query` interface — `synthesizeAnswer` only — that `CopilotAgent`
 * satisfies.)
 */
export function trainingOnlyArm(agent: SynthesisAgent): Arm {
  return {
    name: 'training-only',
    async answer(question) {
      const result = await agent.synthesizeAnswer({
        question: question.question,
        context: [],
        closedBook: true,
      });
      return { answer: result.answer, usage: result.usage };
    },
  };
}
