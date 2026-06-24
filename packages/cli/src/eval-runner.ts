// The eval execution seam.
//
// `pack eval` delegates the run to an injectable {@link EvalSeam}, mirroring the
// `query` / ingestion runners. This keeps the heavy eval stack (`@kgpacks/eval`
// plus the `@kgpacks/query` retriever, the `@kgpacks/agent` synthesis/judge
// transport, and the embedding/model runtime) OUT of the always-loaded module
// graph: the production seam `import()`s it lazily, only when `pack eval` runs.
// Only the `EvalReport` TYPE is imported eagerly (erased at compile time).

import { join } from 'node:path';

import type { EvalReport } from '@kgpacks/eval';

import { DB_FILENAME } from './constants.js';

/** Inputs handed to an {@link EvalSeam} for one `pack eval` invocation. */
export interface EvalPackInput {
  /** Absolute path to the pack directory (already resolved + existence-checked). */
  packDir: string;
  /** Pack id (directory name), used as the question-loader key. */
  packId: string;
  /** Base directory the per-pack `eval_questions.json` is loaded from. */
  questionsDir: string;
  /** Sampling mode: `full` scores everything, `stratified` a few per pack. */
  sample: 'full' | 'stratified';
  /** Questions per pack in `stratified` mode. */
  perPack: number;
  /** Judge model id, pinned + held constant across both arms. */
  judgeModel: string;
}

/**
 * Runs `@kgpacks/eval` over one pack and resolves to its {@link EvalReport}, which
 * `pack eval` serializes verbatim to stdout. Tests inject a double returning a
 * canned report so the suite runs fully offline.
 */
export type EvalSeam = (input: EvalPackInput) => Promise<EvalReport>;

/**
 * Builds the default production eval seam.
 *
 * The eval/retrieval/agent stack is imported lazily on first call. It wires the
 * full `runEval`: a `with-pack` arm (retrieve + synthesize over the pack) and a
 * `training-only` arm (synthesis with empty context), graded by a single LLM judge
 * pinned to `judgeModel` and held constant across both arms.
 */
export function defaultEvalPack(): EvalSeam {
  return async (input: EvalPackInput): Promise<EvalReport> => {
    const { Database } = await import('@kgpacks/db');
    const { createRetriever } = await import('@kgpacks/query');
    const { CopilotAgent, createCopilotTransport } = await import('@kgpacks/agent');
    const { runEval, withPackArm, trainingOnlyArm, createLlmJudge, createDirQuestionLoader } =
      await import('@kgpacks/eval');

    const db = new Database(join(input.packDir, DB_FILENAME));
    const conn = db.connect();
    const agent = new CopilotAgent();
    const judge = createLlmJudge({ transport: createCopilotTransport(), model: input.judgeModel });

    let report: Awaited<ReturnType<typeof runEval>> | undefined;
    let mainError: unknown;
    try {
      await agent.start();
      const retriever = createRetriever(conn, { agent });
      report = await runEval({
        loader: createDirQuestionLoader(input.questionsDir),
        packIds: [input.packId],
        withPack: withPackArm(retriever),
        trainingOnly: trainingOnlyArm(agent),
        judge,
        sample: { mode: input.sample, perPack: input.perPack },
      });
    } catch (err) {
      mainError = err;
    }

    // Release every resource even if an earlier close throws: each step is guarded
    // and the native DB handles always close. A cleanup failure is surfaced only
    // when the eval itself succeeded, so it can never mask the original error.
    const cleanupErrors: unknown[] = [];
    const guarded = async (label: string, close: () => unknown): Promise<void> => {
      try {
        await close();
      } catch (err) {
        cleanupErrors.push(new Error(`eval cleanup (${label}) failed: ${String(err)}`));
      }
    };
    await guarded('judge', () => judge.close?.());
    await guarded('agent', () => agent.stop());
    await guarded('connection', () => conn.close());
    await guarded('database', () => db.close());

    if (mainError !== undefined) throw mainError;
    if (cleanupErrors.length > 0) throw cleanupErrors[0];
    return report as Awaited<ReturnType<typeof runEval>>;
  };
}
