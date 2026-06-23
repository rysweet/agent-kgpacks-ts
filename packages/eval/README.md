# @kgpacks/eval

The strict-ESM **evaluation layer** of the port: it measures how well the
retrieval + synthesis pipeline answers a pack's eval questions, scoring each
answer with an **LLM judge** (GitHub Copilot SDK, BYOK) that is **pinned to a
single model held constant across both arms**. Ported from the upstream Python
`wikigr/packs/eval` modules — `runner.py`, `baselines.py`, and
`skill_evaluators.py` — onto `@kgpacks/query`, `@kgpacks/agent`, and
`@kgpacks/db`.

> **Status:** **implemented (Phase 1, read-side).** This README and
> [docs/packages/eval.md](../../docs/packages/eval.md) describe the shipped API:
> the `runEval` runner, the `withPackArm` / `trainingOnlyArm` baselines, the
> `createLlmJudge` factory, the skill-evaluator registry, the question loader, the
> deterministic stratified sampler, and the pure metric aggregators. Every seam is
> injectable, so unit tests run **fully offline** with the judge and agent mocked —
> no live LLM, no credentials.

It adds **no third-party runtime dependency** — it depends only on sibling
workspace packages (`@kgpacks/query`, `@kgpacks/agent`, `@kgpacks/packs` as
`workspace:*`), so the `test/scaffold.test.ts` allowlist is left untouched.

```ts
import { CopilotAgent, createCopilotTransport } from '@kgpacks/agent';
import { createRetriever } from '@kgpacks/query';
import {
  runEval,
  withPackArm,
  trainingOnlyArm,
  createLlmJudge,
  createDirQuestionLoader,
  DEFAULT_JUDGE_MODEL,
} from '@kgpacks/eval';

const agent = new CopilotAgent();
await agent.start();

// The judge runs on its own model via a dedicated tool-less completion session,
// pinned independently of the synthesis model and identical for both arms.
const judge = createLlmJudge({
  transport: createCopilotTransport(),
  model: DEFAULT_JUDGE_MODEL,
});

try {
  const retriever = createRetriever(conn, { agent });

  const report = await runEval({
    loader: createDirQuestionLoader('./packs'),
    packIds: ['world-history'],
    withPack: withPackArm(retriever), // full retrieve + synthesize
    trainingOnly: trainingOnlyArm(agent), // synthesize with empty context
    judge, // pinned judge model + fixed prompt, identical for both arms
    sample: { mode: 'stratified', perPack: 3 }, // bound cost during dev
  });

  console.log(report.comparison.deltaAccuracy); // the pack's lift
  console.log(report.comparison.winRate); // wins / (wins + losses)
} finally {
  await judge.close();
  await agent.stop();
}
```

See [docs/packages/eval.md](../../docs/packages/eval.md) for the full API
reference (runner, arms, judge, skill evaluators, loader, sampler, metrics, and
constants), the data shapes, the metric definitions, and the security, versioning,
and testing strategy, and [docs/PLAN.md](../../docs/PLAN.md) for the Acceptance
Criteria this package implements (held-constant judge, stratified sampling, the
2pp eval bar).
