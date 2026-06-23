// @kgpacks/parity — fixture + report types and the canonical pipeline stage order.
//
// The four stages mirror the retrieval/agent pipeline described in
// docs/PLAN.md ("Stage-localizing diff tool"): a query is embedded, candidate
// node IDs are retrieved, those candidates are reranked, and a final answer is
// synthesized. The golden fixture freezes the oracle's output at each stage so a
// regression can be pinned to ONE stage instead of guessed from an end-to-end
// score.

export type StageName = 'query-embedding' | 'retrieved-ids' | 'reranked-ids' | 'final-answer';

// Canonical evaluation order. `firstDivergedStage` is the earliest stage in this
// order whose status is 'diverged'.
export const STAGE_ORDER = [
  'query-embedding',
  'retrieved-ids',
  'reranked-ids',
  'final-answer',
] as const satisfies readonly StageName[];

export interface Provenance {
  // `git rev-parse HEAD` of the oracle checkout that produced the fixture.
  gitSha: string;
  // ISO-8601 UTC timestamp of generation.
  generatedAt: string;
  // Human-readable identifier of the oracle that emitted the fixture.
  oracle: string;
  models: {
    queryEmbedding: string;
    reranker: string;
    answer: string;
  };
  // Versions of the native binding / on-disk storage the fixture was built with.
  bindingVersion: string;
  storageVersion: string;
}

export interface FixtureCaseConfig {
  topK: number;
  cosineThreshold: number;
  seed: number;
}

export interface FixtureCase {
  id: string;
  query: string;
  config: FixtureCaseConfig;
}

export interface FinalAnswer {
  // Node IDs cited by the synthesized answer (compared as an unordered set).
  citations: string[];
  // Top-k node IDs backing the answer (compared as an ordered list).
  topK: string[];
  // Decoding seed (compared for exact equality).
  seed: number;
  // Free-form answer text. Provider-dependent, so it is recorded but NOT compared.
  text: string;
}

export interface QueryEmbeddingStage {
  dim: number;
  vector: number[];
}

export interface FixtureStages {
  queryEmbedding: QueryEmbeddingStage;
  retrievedIds: string[];
  rerankedIds: string[];
  finalAnswer: FinalAnswer;
}

export interface GoldenFixture {
  schemaVersion: 1;
  provenance: Provenance;
  case: FixtureCase;
  stages: FixtureStages;
}

// The TS pipeline's actual output for one case, compared against a GoldenFixture.
// Flattened relative to `FixtureStages` (no `dim` wrapper on the embedding) so
// callers can hand the harness raw stage outputs.
export interface PipelineOutput {
  queryEmbedding: number[];
  retrievedIds: string[];
  rerankedIds: string[];
  finalAnswer: FinalAnswer;
}

export type StageStatus = 'match' | 'diverged';

export interface StageResult {
  status: StageStatus;
  // Human-readable explanation; populated whenever it adds signal (always on
  // divergence, and on the embedding stage where the cosine value is useful).
  detail?: string;
}

export interface ParityReport {
  // True iff every stage matched.
  pass: boolean;
  // Earliest diverged stage in STAGE_ORDER, or null when every stage matched.
  firstDivergedStage: StageName | null;
  // Status for EVERY stage (not short-circuited) so the report localizes all
  // divergences, not just the first.
  stages: Record<StageName, StageResult>;
}

export interface CompareOptions {
  // Overrides the fixture's `case.config.cosineThreshold` for the embedding stage.
  cosineThreshold?: number;
}
