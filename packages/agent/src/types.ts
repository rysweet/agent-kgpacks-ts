// @kgpacks/agent — public type contracts.
//
// These are the package's stability surface: the four operations' request/result
// shapes, the usage records, and the injectable `Transport` seam that lets unit
// tests run fully offline against a mock (never spawning the Copilot subprocess).

/** A retrieved context passage made available to synthesis. */
export interface ContextChunk {
  /** Stable node/document id used for citation (e.g. 'doc:42'). */
  id: string;
  /** The passage text. */
  text: string;
  /** Optional human-facing title/source. */
  title?: string;
}

export interface SynthesisRequest {
  /** The user question to answer. */
  question: string;
  /** Retrieved context, in retrieval order. Empty ⇒ the model is told it lacks grounding. */
  context: ContextChunk[];
  /** Optional per-call timeout override (ms). */
  timeoutMs?: number;
  /**
   * Closed-book mode (default `false`). When `true` AND `context` is empty, the
   * model is asked to answer from its OWN training knowledge instead of refusing —
   * used by the eval's no-pack baseline to measure parametric knowledge. Production
   * RAG leaves this `false` so an empty retrieval refuses rather than hallucinates.
   */
  closedBook?: boolean;
}

export interface SynthesisMetadata {
  /** Context ids the answer cited, in first-appearance order within the answer. */
  citedIds: string[];
  /** Model id that produced the answer (the held-constant BYOK model). */
  model: string;
}

export interface SynthesisResult {
  /** The synthesized answer text. */
  answer: string;
  /** Structured metadata about the synthesis. */
  metadata: SynthesisMetadata;
  /** Tokens attributable to THIS call (not cumulative). */
  usage: Usage;
}

export interface ExpandQueryOptions {
  /** Target number of reformulations (default 3, clamped to a sane range). */
  count?: number;
  /** Per-call timeout override (ms). */
  timeoutMs?: number;
}

export interface MultiQueryOptions {
  /** Number of paraphrased query variants to emit (default 3, clamped). */
  count?: number;
  /** Per-call timeout override (ms). */
  timeoutMs?: number;
}

export interface SeedArticleRequest {
  /** The domain/topic to find seeds for. */
  topic: string;
  /** Candidate article titles to choose from. */
  candidates: string[];
  /** Optional cap on the number of titles returned. */
  limit?: number;
}

/** Token counts for a single call. Mirrors the reference agent's `_track_response` fields. */
export interface Usage {
  /** Prompt/input tokens (SDK assistant.usage.inputTokens). */
  promptTokens: number;
  /** Completion/output tokens (assistant.usage.outputTokens / message.outputTokens). */
  completionTokens: number;
  /** Reasoning tokens (assistant.usage.reasoningTokens; 0 when absent). */
  reasoningTokens: number;
  /** prompt + completion (+ reasoning). */
  totalTokens: number;
}

/** Cumulative usage + request count since the agent was constructed. */
export interface UsageSnapshot extends Usage {
  requestCount: number;
}

/**
 * BYOK provider config for the held-constant model. Sourced only from env/secret
 * store; never logged, never placed in `Usage`, and redacted from errors.
 */
export interface ProviderConfig {
  type?: 'openai' | 'azure' | 'anthropic';
  baseUrl?: string;
  apiKey?: string;
  bearerToken?: string;
  headers?: Record<string, string>;
}

/** Experimental SDK multi-provider BYOK entry. */
export interface NamedProviderConfig {
  name: string;
  provider: ProviderConfig;
}

/** One in-flight model exchange. Maps 1:1 onto a CopilotSession. */
export interface TransportSession {
  /** Sends a prompt and resolves with the assistant text + token usage. */
  send(prompt: string, timeoutMs?: number): Promise<TransportResponse>;
  /** Tears the session down (CopilotSession.disconnect). */
  close(): Promise<void>;
}

export interface TransportResponse {
  content: string;
  usage: Usage;
}

/** Config used to open a tool-less, model-pinned session. */
export interface TransportOpenConfig {
  model: string;
  provider?: ProviderConfig;
  providers?: NamedProviderConfig[];
}

/** The injectable boundary. The real adapter wraps CopilotClient. */
export interface Transport {
  /** Opens a tool-less session pinned to a model/provider. */
  open(config: TransportOpenConfig): Promise<TransportSession>;
  /** Stops the underlying client (CopilotClient.stop). */
  shutdown(): Promise<void>;
}

/** Options for the real Copilot SDK transport adapter. */
export interface CopilotTransportOptions {
  /** Override the hardened system message applied to the tool-less session. */
  systemMessage?: string;
}

/** Construction options for {@link CopilotAgent}. */
export interface CopilotAgentOptions {
  /** BYOK model id used for all operations, held constant per run. */
  model?: string;
  /** Injectable transport seam. Tests pass a mock for offline runs. */
  transport?: Transport;
  /** BYOK provider (endpoint + key/token) for the held-constant model. */
  provider?: ProviderConfig;
  /** Experimental SDK multi-provider BYOK; mutually exclusive with `provider`. */
  providers?: NamedProviderConfig[];
  /** Default per-request timeout (ms) forwarded to the transport; overridable per call. */
  timeoutMs?: number;
}
