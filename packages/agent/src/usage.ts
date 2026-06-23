// @kgpacks/agent — token/usage accountant.
//
// The TS analogue of the reference agent's `_track_response`: accumulates
// prompt/completion/reasoning/total tokens plus a request count across every
// call in a session. `CopilotAgent.getUsage()` returns a snapshot of it.

import type { Usage, UsageSnapshot } from './types.js';

export class UsageTracker {
  private promptTokens = 0;
  private completionTokens = 0;
  private reasoningTokens = 0;
  private totalTokens = 0;
  private requestCount = 0;

  /** Folds one call's usage into the running totals and counts the request. */
  record(usage: Usage): void {
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.reasoningTokens += usage.reasoningTokens;
    this.totalTokens += usage.totalTokens;
    this.requestCount += 1;
  }

  /** Returns an independent copy of the cumulative totals (never the internals). */
  snapshot(): UsageSnapshot {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      reasoningTokens: this.reasoningTokens,
      totalTokens: this.totalTokens,
      requestCount: this.requestCount,
    };
  }
}
