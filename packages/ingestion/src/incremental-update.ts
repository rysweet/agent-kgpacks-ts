// Stable public facade for immutable incremental knowledge-pack operations.
// Implementation details remain private so callers depend only on these studs.

export {
  INCREMENTAL_SCHEMA_VERSION,
  UPDATE_TOOL_VERSION,
  assertPackPublicationAvailable,
  buildCvePack,
  publishBuiltCvePack,
  updateKnowledgePack,
  validateKnowledgePack,
} from './incremental-engine.js';

export type {
  BuildCvePackConfig,
  DurablePackMetadata,
  DurableUpdateApplication,
  PackCheckpoint,
  PackValidationResult,
  PublishBuiltCvePackConfig,
  UpdateKnowledgePackConfig,
  UpdateKnowledgePackResult,
} from './incremental-engine.js';
