// packages/eval/test/helpers.ts
//
// Shared OFFLINE fakes for the @kgpacks/eval test-suite. Nothing here touches the
// network, a real database, a real model, or the Copilot subprocess: every seam
// the eval package exposes (arms, judge, question loader, judge transport) is
// injectable, so each fake is a tiny deterministic stand-in.
//
// This is NOT a `*.test.ts` file, so Vitest never collects it as a suite; it is
// imported by the suites that need an arm, a judge, a loader, or a transport.

import type {
  Transport,
  TransportOpenConfig,
  TransportResponse,
  TransportSession,
  Usage,
} from '@kgpacks/agent';

import type {
  Arm,
  ArmAnswer,
  EvalQuestion,
  Judge,
  JudgeInput,
  JudgeVerdict,
  QuestionLoader,
} from '../src/index.js';

/** A zero-filled {@link Usage} record for fakes that do not model token spend. */
export function zeroUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

// ── Questions ─────────────────────────────────────────────────────────────────

/** Builds an {@link EvalQuestion}, defaulting every field so tests state only
 *  what the assertion cares about. */
export function makeQuestion(overrides: Partial<EvalQuestion> = {}): EvalQuestion {
  return {
    id: overrides.id ?? 'q1',
    question: overrides.question ?? 'What is HNSW?',
    packId: overrides.packId ?? 'demo',
    ...(overrides.referenceAnswer !== undefined
      ? { referenceAnswer: overrides.referenceAnswer }
      : {}),
    ...(overrides.skill !== undefined ? { skill: overrides.skill } : {}),
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  };
}

// ── Arms ────────────────────────────────────────────────────────────────────

/** An {@link Arm} that maps each question id to a canned answer string and
 *  records every question it was asked. Unknown ids answer ''. */
export function fakeArm(
  name: string,
  answers: Record<string, string>,
): Arm & { calls: EvalQuestion[] } {
  const calls: EvalQuestion[] = [];
  return {
    name,
    calls,
    async answer(question: EvalQuestion): Promise<ArmAnswer> {
      calls.push(question);
      return { answer: answers[question.id] ?? '', usage: zeroUsage() };
    },
  };
}

/** An {@link Arm} that fails the test if it is ever invoked. */
export function neverArm(name: string): Arm {
  return {
    name,
    async answer(): Promise<ArmAnswer> {
      throw new Error(`arm '${name}' should not be called`);
    },
  };
}

// ── Judges ──────────────────────────────────────────────────────────────────

/** A {@link Judge} stand-in. By default it marks any non-empty answer correct;
 *  pass a `verdictFn` to vary the verdict by input. Records every input. */
export function fakeJudge(
  verdictFn: (input: JudgeInput) => JudgeVerdict = (input) => ({
    correct: input.answer.trim().length > 0,
    score: input.answer.trim().length > 0 ? 1 : 0,
    reasoning: 'fake',
  }),
): Judge & { inputs: JudgeInput[] } {
  const inputs: JudgeInput[] = [];
  return {
    inputs,
    async judge(input: JudgeInput): Promise<JudgeVerdict> {
      inputs.push(input);
      return verdictFn(input);
    },
  };
}

/** A {@link Judge} that fails the test if it is ever consulted (used to prove a
 *  skill evaluator fully replaced the judge for a tagged question). */
export function neverJudge(): Judge {
  return {
    async judge(): Promise<JudgeVerdict> {
      throw new Error('judge should not be called');
    },
  };
}

// ── Question loader ───────────────────────────────────────────────────────────

/** An in-memory {@link QuestionLoader} backed by a `packId -> questions` table.
 *  Records the packIds it was asked for; unknown packs load to []. */
export function inMemoryLoader(
  table: Record<string, EvalQuestion[]>,
): QuestionLoader & { loaded: string[] } {
  const loaded: string[] = [];
  return {
    loaded,
    async load(packId: string): Promise<EvalQuestion[]> {
      loaded.push(packId);
      return table[packId] ?? [];
    },
  };
}

// ── Judge transport (for createLlmJudge) ──────────────────────────────────────

/** Records one `transport.open` call. */
export interface OpenCall {
  config: TransportOpenConfig;
}

/**
 * A mock {@link Transport} for the LLM-judge tests. `open()` records its config
 * and hands back a session whose `send()` returns a caller-supplied string as
 * the assistant `content` (the raw judge output the package must parse). Tracks
 * every open, every prompt sent, and session/transport teardown so tests can
 * assert single-session reuse, model pinning, and idempotent `close()`.
 *
 * `respond` receives the rendered prompt and the zero-based call index, so a
 * test can return a different raw verdict per question.
 */
export class MockTransport implements Transport {
  readonly openCalls: OpenCall[] = [];
  readonly prompts: string[] = [];
  sessionCloseCount = 0;
  shutdownCount = 0;
  /** When set, the session's `close()` rejects with this error (after counting). */
  sessionCloseError?: Error;

  constructor(private readonly respond: (prompt: string, index: number) => string) {}

  async open(config: TransportOpenConfig): Promise<TransportSession> {
    this.openCalls.push({ config });
    return {
      send: async (prompt: string): Promise<TransportResponse> => {
        const index = this.prompts.length;
        this.prompts.push(prompt);
        return { content: this.respond(prompt, index), usage: zeroUsage() };
      },
      close: async (): Promise<void> => {
        this.sessionCloseCount += 1;
        if (this.sessionCloseError) throw this.sessionCloseError;
      },
    };
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
  }
}

/** Builds a `MockTransport` that always returns the same raw judge output. */
export function constantTransport(raw: string): MockTransport {
  return new MockTransport(() => raw);
}
