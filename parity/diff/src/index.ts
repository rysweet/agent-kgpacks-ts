// @kgpacks/parity — dev-only, stage-localizing parity diff harness.
//
// Public surface:
//   - loadFixture / assertGoldenFixture : read & validate a golden fixture
//   - cosineSimilarity                  : query-embedding similarity metric
//   - compareStages                     : per-stage diff -> localized ParityReport
//   - STAGE_ORDER                       : canonical stage order
//   - types                             : fixture & report shapes

export { cosineSimilarity } from './cosine.js';
export { assertGoldenFixture, loadFixture } from './load.js';
export { compareStages } from './compare.js';
export { STAGE_ORDER } from './types.js';
export type {
  CompareOptions,
  FinalAnswer,
  FixtureCase,
  FixtureCaseConfig,
  FixtureStages,
  GoldenFixture,
  ParityReport,
  PipelineOutput,
  Provenance,
  QueryEmbeddingStage,
  StageName,
  StageResult,
  StageStatus,
} from './types.js';
