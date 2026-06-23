// packages/agent/test/usage.test.ts
//
// Offline unit tests for the token/usage accountant in src/usage.ts.
//
// `UsageTracker` is the TS analogue of the Python agent's `_track_response`: it
// accumulates prompt/completion/reasoning/total tokens plus a request count
// across every call in a session. `CopilotAgent.getUsage()` returns a snapshot
// of it. These tests pin the accumulation + immutability contract.
//
// TDD (RED): src/usage.ts does not exist yet. Fails at import resolution today;
// passes once UsageTracker is implemented to spec.

import { describe, expect, it } from 'vitest';

import type { Usage } from '../src/types.js';
import { UsageTracker } from '../src/usage.js';

/** Build a per-call Usage with a self-consistent total. */
function usage(promptTokens: number, completionTokens: number, reasoningTokens = 0): Usage {
  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    totalTokens: promptTokens + completionTokens + reasoningTokens,
  };
}

describe('UsageTracker', () => {
  it('starts at zero with no requests', () => {
    const tracker = new UsageTracker();
    expect(tracker.snapshot()).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    });
  });

  it('records a single call and reflects it in the snapshot', () => {
    const tracker = new UsageTracker();
    tracker.record(usage(10, 20, 5));
    expect(tracker.snapshot()).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      reasoningTokens: 5,
      totalTokens: 35,
      requestCount: 1,
    });
  });

  it('accumulates across multiple calls and counts each request', () => {
    const tracker = new UsageTracker();
    tracker.record(usage(10, 20, 0));
    tracker.record(usage(3, 4, 1));
    tracker.record(usage(100, 200, 0));
    expect(tracker.snapshot()).toEqual({
      promptTokens: 113,
      completionTokens: 224,
      reasoningTokens: 1,
      totalTokens: 338,
      requestCount: 3,
    });
  });

  it('returns a COPY — mutating a snapshot does not affect the tracker', () => {
    const tracker = new UsageTracker();
    tracker.record(usage(1, 1, 0));

    const snap = tracker.snapshot();
    snap.promptTokens = 9999;
    snap.requestCount = 9999;

    expect(tracker.snapshot()).toEqual({
      promptTokens: 1,
      completionTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2,
      requestCount: 1,
    });
  });

  it('successive snapshots are independent objects', () => {
    const tracker = new UsageTracker();
    tracker.record(usage(2, 2, 0));
    const a = tracker.snapshot();
    const b = tracker.snapshot();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
