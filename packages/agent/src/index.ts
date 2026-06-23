// @kgpacks/agent — public entry point.
//
// The LLM layer of the port: a strict-ESM wrapper around the GitHub Copilot SDK
// (@github/copilot-sdk) exposing answer synthesis, query expansion, multi-query
// generation, and seed-article identification, plus usage accounting. The SDK
// changes transport only — the model is held constant via BYOK.

export { CopilotAgent } from './copilot-agent.js';
export { createCopilotTransport } from './transport.js';
export { DEFAULT_SYNTHESIS_MODEL } from './constants.js';
export {
  AgentError,
  AgentNotStartedError,
  AgentResponseFormatError,
  AgentTransportError,
} from './errors.js';
export { safeParseJson, stripMarkdownFences } from './json.js';
export { UsageTracker } from './usage.js';

export type {
  ContextChunk,
  CopilotAgentOptions,
  CopilotTransportOptions,
  ExpandQueryOptions,
  MultiQueryOptions,
  NamedProviderConfig,
  ProviderConfig,
  SeedArticleRequest,
  SynthesisMetadata,
  SynthesisRequest,
  SynthesisResult,
  Transport,
  TransportOpenConfig,
  TransportResponse,
  TransportSession,
  Usage,
  UsageSnapshot,
} from './types.js';
