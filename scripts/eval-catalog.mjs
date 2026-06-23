#!/usr/bin/env node
// Real eval over a built catalog pack: the with-pack arm (retrieve + synthesize
// over the pack) vs the training-only arm (the model answering alone), both
// graded by the held-constant LLM judge — exactly the parity comparison the
// reference repo reports. Uses the live GitHub Copilot SDK.
//
//   node scripts/eval-catalog.mjs --pack go-expert --sample 3
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Database } from '../packages/db/dist/index.js';
import { createRetriever } from '../packages/query/dist/index.js';
import { CopilotAgent, createCopilotTransport } from '../packages/agent/dist/index.js';
import {
  runEval,
  withPackArm,
  trainingOnlyArm,
  createLlmJudge,
} from '../packages/eval/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const pack = opt('--pack');
const sample = Number(opt('--sample', '3'));
if (!pack) {
  console.error('usage: eval-catalog.mjs --pack <name> [--sample N]');
  process.exit(2);
}

const dbPath = join(root, 'data', 'packs', pack, 'pack.db');
if (!existsSync(dbPath)) {
  console.error(`pack not built: ${dbPath} (run build-catalog first)`);
  process.exit(1);
}

const lines = (await readFile(join(root, 'catalog', pack, 'eval.jsonl'), 'utf8'))
  .split('\n')
  .filter(Boolean);
const questions = lines
  .map((l) => JSON.parse(l))
  .slice(0, sample)
  .map((q) => ({ id: q.id, question: q.question, referenceAnswer: q.ground_truth, packId: pack }));

const agent = new CopilotAgent();
await agent.start();
const judge = createLlmJudge({ transport: createCopilotTransport() });
const db = new Database(dbPath);
const conn = db.connect();
try {
  const retriever = createRetriever(conn, { agent });
  const report = await runEval({
    questions,
    withPack: withPackArm(retriever),
    trainingOnly: trainingOnlyArm(agent),
    judge,
  });
  console.log(
    JSON.stringify(
      { pack, sampled: report.sampled, arms: report.arms, comparison: report.comparison },
      null,
      2,
    ),
  );
} finally {
  conn.close();
  db.close();
  await agent.stop();
  await judge.close?.();
}
