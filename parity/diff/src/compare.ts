// Stage-localizing parity comparator.
//
// `compareStages` evaluates ALL four pipeline stages against the golden fixture
// (no short-circuit) so the returned report tells you exactly which stage(s)
// diverged. Each stage has its own equality semantics per docs/PLAN.md:
//   - query-embedding : dimensions must match AND cosine >= threshold (default
//                       from the fixture's case.config.cosineThreshold, overridable).
//   - retrieved-ids   : exact ORDERED equality.
//   - reranked-ids    : exact ORDERED equality.
//   - final-answer    : structural — citations as an unordered SET, topK ordered,
//                       seed exact; the free-form `text` is intentionally ignored
//                       because the answer provider differs in the TS port.

import { cosineSimilarity } from './cosine.js';
import { STAGE_ORDER } from './types.js';
import type {
  CompareOptions,
  GoldenFixture,
  ParityReport,
  PipelineOutput,
  StageName,
  StageResult,
} from './types.js';

const DEFAULT_COSINE_THRESHOLD = 0.999;

function orderedEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function setEqual(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function fmtList(ids: readonly string[]): string {
  return `[${ids.join(', ')}]`;
}

function compareQueryEmbedding(
  actual: PipelineOutput,
  golden: GoldenFixture,
  threshold: number,
): StageResult {
  const expected = golden.stages.queryEmbedding.vector;
  if (actual.queryEmbedding.length !== expected.length) {
    return {
      status: 'diverged',
      detail: `dimension mismatch: actual ${actual.queryEmbedding.length} vs golden ${expected.length}`,
    };
  }
  const cosine = cosineSimilarity(actual.queryEmbedding, expected);
  const status = cosine >= threshold ? 'match' : 'diverged';
  return {
    status,
    detail: `cosine ${cosine.toFixed(6)} ${status === 'match' ? '>=' : '<'} ${threshold}`,
  };
}

function compareOrderedIds(actual: readonly string[], expected: readonly string[]): StageResult {
  if (orderedEqual(actual, expected)) {
    return { status: 'match' };
  }
  return {
    status: 'diverged',
    detail: `ordered ids differ: expected ${fmtList(expected)}, got ${fmtList(actual)}`,
  };
}

function compareFinalAnswer(actual: PipelineOutput, golden: GoldenFixture): StageResult {
  const a = actual.finalAnswer;
  const g = golden.stages.finalAnswer;
  const problems: string[] = [];

  if (!setEqual(a.citations, g.citations)) {
    problems.push(
      `citations set differs: expected ${fmtList(g.citations)}, got ${fmtList(a.citations)}`,
    );
  }
  if (!orderedEqual(a.topK, g.topK)) {
    problems.push(`topK order differs: expected ${fmtList(g.topK)}, got ${fmtList(a.topK)}`);
  }
  if (a.seed !== g.seed) {
    problems.push(`seed differs: expected ${g.seed}, got ${a.seed}`);
  }

  return problems.length === 0
    ? { status: 'match' }
    : { status: 'diverged', detail: problems.join('; ') };
}

export function compareStages(
  actual: PipelineOutput,
  golden: GoldenFixture,
  opts: CompareOptions = {},
): ParityReport {
  const threshold =
    opts.cosineThreshold ?? golden.case.config.cosineThreshold ?? DEFAULT_COSINE_THRESHOLD;

  const stages: Record<StageName, StageResult> = {
    'query-embedding': compareQueryEmbedding(actual, golden, threshold),
    'retrieved-ids': compareOrderedIds(actual.retrievedIds, golden.stages.retrievedIds),
    'reranked-ids': compareOrderedIds(actual.rerankedIds, golden.stages.rerankedIds),
    'final-answer': compareFinalAnswer(actual, golden),
  };

  const firstDivergedStage =
    STAGE_ORDER.find((stage) => stages[stage].status === 'diverged') ?? null;

  return {
    pass: firstDivergedStage === null,
    firstDivergedStage,
    stages,
  };
}
