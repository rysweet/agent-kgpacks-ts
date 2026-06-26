// @kgpacks/agent — the CopilotAgent client.
//
// A thin wrapper around the Copilot SDK (via the injectable Transport seam) that
// exposes the four ported operations — answer synthesis, query expansion,
// multi-query generation, and seed-article identification — plus token/usage
// accounting equivalent to the reference agent's `_track_response`.
//
// The agent owns one session for its lifetime (create → use → stop), pins the
// held-constant BYOK model, fails closed (returns shape-checked data or throws),
// and redacts BYOK secrets from any surfaced transport error.

import {
  DEFAULT_LIST_COUNT,
  DEFAULT_SYNTHESIS_MODEL,
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_CHUNKS,
  MAX_CHUNK_CHARS,
  MAX_LIST_COUNT,
  MAX_SEED_LIMIT,
  MIN_LIST_COUNT,
} from './constants.js';
import { AgentNotStartedError, AgentResponseFormatError, AgentTransportError } from './errors.js';
import { safeParseJson, stripMarkdownFences } from './json.js';
import {
  buildExpandQueryPrompt,
  buildMultiQueryPrompt,
  buildSeedArticlePrompt,
  buildSynthesisPrompt,
} from './prompts.js';
import { createCopilotTransport } from './transport.js';
import { UsageTracker } from './usage.js';
import type {
  ContextChunk,
  CopilotAgentOptions,
  ExpandQueryOptions,
  MultiQueryOptions,
  NamedProviderConfig,
  ProviderConfig,
  SeedArticleRequest,
  SynthesisRequest,
  SynthesisResult,
  Transport,
  TransportResponse,
  TransportSession,
  UsageSnapshot,
} from './types.js';

export class CopilotAgent {
  private readonly model: string;
  private readonly transport: Transport;
  private readonly provider?: ProviderConfig;
  private readonly providers?: NamedProviderConfig[];
  private readonly defaultTimeoutMs?: number;
  private readonly usage = new UsageTracker();

  private session: TransportSession | undefined;
  private started = false;

  constructor(options: CopilotAgentOptions = {}) {
    this.model = options.model ?? DEFAULT_SYNTHESIS_MODEL;
    this.transport = options.transport ?? createCopilotTransport();
    this.provider = options.provider;
    this.providers = options.providers;
    this.defaultTimeoutMs = options.timeoutMs;
  }

  /** Opens a session pinned to the held-constant model. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    try {
      this.session = await this.transport.open({
        model: this.model,
        provider: this.provider,
        providers: this.providers,
      });
      this.started = true;
    } catch (err) {
      throw this.wrapTransportError(err, 'start');
    }
  }

  /** Closes the session and shuts the transport down. Idempotent and start()-safe. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    const session = this.session;
    this.session = undefined;
    try {
      try {
        if (session) await session.close();
      } finally {
        // shutdown() kills the SDK subprocess and removes its temp dir — it MUST
        // run even if session.close() (the IPC disconnect) rejects, or the
        // subprocess and mkdtemp dir leak permanently (started is already false,
        // so a retry would no-op).
        await this.transport.shutdown();
      }
    } catch (err) {
      throw this.wrapTransportError(err, 'stop');
    }
  }

  /** Synthesizes a grounded, citation-bearing answer from retrieved context. */
  async synthesizeAnswer(request: SynthesisRequest): Promise<SynthesisResult> {
    const session = this.requireSession();
    const context = this.boundContext(request.context);
    const prompt = buildSynthesisPrompt(request.question, context, request.closedBook ?? false);

    const response = await this.exchange(session, prompt, request.timeoutMs);
    const answer = response.content;
    if (answer.trim().length === 0) {
      throw new AgentResponseFormatError('Model returned an empty synthesis answer.', answer);
    }

    return {
      answer,
      metadata: { citedIds: deriveCitedIds(answer, context), model: this.model },
      usage: response.usage,
    };
  }

  /** Expands one query into related reformulations. Returns a string[]. */
  async expandQuery(query: string, options: ExpandQueryOptions = {}): Promise<string[]> {
    const session = this.requireSession();
    const count = clampCount(options.count);
    const prompt = buildExpandQueryPrompt(query, count);
    const response = await this.exchange(session, prompt, options.timeoutMs);
    return parseStringArray(response.content);
  }

  /** Generates multiple paraphrased retrieval queries. Returns a string[]. */
  async multiQuery(query: string, options: MultiQueryOptions = {}): Promise<string[]> {
    const session = this.requireSession();
    const count = clampCount(options.count);
    const prompt = buildMultiQueryPrompt(query, count);
    const response = await this.exchange(session, prompt, options.timeoutMs);
    return parseStringArray(response.content);
  }

  /** Selects the most relevant seed-article titles for a topic. Returns a string[]. */
  async identifySeedArticles(request: SeedArticleRequest): Promise<string[]> {
    const session = this.requireSession();
    const prompt = buildSeedArticlePrompt(request.topic, request.candidates, request.limit);
    const response = await this.exchange(session, prompt);
    const titles = parseStringArray(response.content);
    if (typeof request.limit === 'number') {
      return titles.slice(0, clampLimit(request.limit));
    }
    return titles;
  }

  /** Returns a copy of the cumulative token/usage totals since construction. */
  getUsage(): UsageSnapshot {
    return this.usage.snapshot();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireSession(): TransportSession {
    if (!this.started || !this.session) {
      throw new AgentNotStartedError();
    }
    return this.session;
  }

  /**
   * Single send path: forwards the resolved timeout, records usage (so totals
   * stay accurate even when downstream shape-validation fails), and wraps any
   * transport failure as a redacted AgentTransportError.
   */
  private async exchange(
    session: TransportSession,
    prompt: string,
    perCallTimeoutMs?: number,
  ): Promise<TransportResponse> {
    const timeoutMs = perCallTimeoutMs ?? this.defaultTimeoutMs;
    let response: TransportResponse;
    try {
      response = await session.send(prompt, timeoutMs);
    } catch (err) {
      throw this.wrapTransportError(err, 'send');
    }
    this.usage.record(response.usage);
    return response;
  }

  /** Deterministically bounds context to contain cost / DoS surface. */
  private boundContext(context: ContextChunk[]): ContextChunk[] {
    const bounded: ContextChunk[] = [];
    let totalChars = 0;
    for (const chunk of context.slice(0, MAX_CONTEXT_CHUNKS)) {
      const text = chunk.text.slice(0, MAX_CHUNK_CHARS);
      if (totalChars + text.length > MAX_CONTEXT_CHARS) break;
      totalChars += text.length;
      bounded.push({ ...chunk, text });
    }
    return bounded;
  }

  /** Builds an AgentTransportError whose message + cause are scrubbed of secrets. */
  private wrapTransportError(err: unknown, op: 'start' | 'stop' | 'send'): AgentTransportError {
    const secrets = this.collectSecrets();
    const message = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    return new AgentTransportError(`Copilot transport failed during ${op}(): ${message}`, {
      cause: message,
    });
  }

  /** Gathers every BYOK secret value the agent holds, for redaction. */
  private collectSecrets(): string[] {
    const out: string[] = [];
    const add = (provider?: ProviderConfig): void => {
      if (!provider) return;
      if (provider.apiKey) out.push(provider.apiKey);
      if (provider.bearerToken) out.push(provider.bearerToken);
      for (const value of Object.values(provider.headers ?? {})) {
        if (value) out.push(value);
      }
    };
    add(this.provider);
    for (const named of this.providers ?? []) add(named.provider);
    return out;
  }
}

/** Replaces every known secret substring with a redaction marker. */
function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

/** Parses fenced/bare model output into a validated string[] (fails closed). */
function parseStringArray(content: string): string[] {
  const stripped = stripMarkdownFences(content);
  const parsed = safeParseJson(stripped);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new AgentResponseFormatError(
      'Expected a JSON array of strings from the model.',
      stripped,
    );
  }
  return parsed as string[];
}

/** Ids appearing in the answer, in first-appearance order, deduplicated. */
function deriveCitedIds(answer: string, context: ContextChunk[]): string[] {
  const found = context
    .map((chunk) => ({ id: chunk.id, index: indexOfId(answer, chunk.id) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.id);
  return [...new Set(found)];
}

/**
 * First index of `id` in `answer` on an id boundary, so that `"Topic#1"` does NOT
 * match inside `"Topic#10"`. Section ids are `"<title>#<n>"`; a real citation is
 * bounded by a non `[A-Za-z0-9_#]` character (or string edge) on the right (a
 * trailing digit/word char would mean a longer id).
 */
function indexOfId(answer: string, id: string): number {
  let from = 0;
  for (;;) {
    const at = answer.indexOf(id, from);
    if (at < 0) return -1;
    const after = answer[at + id.length];
    if (after === undefined || !/[A-Za-z0-9_#]/.test(after)) return at;
    from = at + 1;
  }
}

/** Clamps a caller-supplied list count into the supported range. */
function clampCount(count?: number): number {
  if (typeof count !== 'number' || !Number.isFinite(count)) return DEFAULT_LIST_COUNT;
  return Math.min(MAX_LIST_COUNT, Math.max(MIN_LIST_COUNT, Math.floor(count)));
}

/** Clamps a caller-supplied seed limit into a non-negative supported range. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return MAX_SEED_LIMIT;
  return Math.min(MAX_SEED_LIMIT, Math.max(0, Math.floor(limit)));
}
