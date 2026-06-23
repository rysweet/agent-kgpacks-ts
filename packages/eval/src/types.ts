// @kgpacks/eval — public type contracts.
//
// The package's stability surface: the question/verdict schemas, the injectable
// seams (Arm, Judge, SkillEvaluator, QuestionLoader, Transport-backed judge), and
// the in-memory report shapes. Kept free of implementation imports so consumers
// can depend on the shapes without pulling in the agent, query, or model runtime.

import type { Transport, Usage } from '@kgpacks/agent';

// Re-exported for caller convenience (ArmAnswer / the BYOK transport seam).
export type { Transport, Usage } from '@kgpacks/agent';

// ── Questions ─────────────────────────────────────────────────────────────────

/** One evaluation question fed to both arms and graded by the judge. */
export interface EvalQuestion {
  /** Stable question id (used for traceability and deterministic sampling). */
  id: string;
  /** The question prompt fed to both arms. */
  question: string;
  /** Optional gold answer, passed to the judge/evaluator when present. */
  referenceAnswer?: string;
  /** Owning pack id — the stratification key for sampling. */
  packId: string;
  /** Optional skill tag selecting a {@link SkillEvaluator}. */
  skill?: string;
  /** Optional opaque metadata carried through to the report. */
  metadata?: Record<string, unknown>;
}

// ── Judging ───────────────────────────────────────────────────────────────────

/** The input handed to a {@link Judge} or {@link SkillEvaluator}. */
export interface JudgeInput {
  /** The question being answered. */
  question: string;
  /** The candidate answer to grade. */
  answer: string;
  /** Optional gold/reference answer, included in the prompt when present. */
  referenceAnswer?: string;
}

/** A single grade. `correct` drives accuracy; `score` supports finer aggregation. */
export interface JudgeVerdict {
  /** The pass/fail decision; accuracy is the mean of this across an arm. */
  correct: boolean;
  /** Graded quality in [0, 1] (clamped); supports finer aggregation. */
  score: number;
  /** The judge's free-text rationale (untrusted model output — do not execute). */
  reasoning: string;
}

/** The pinned LLM grader. The same model + prompt grade both arms. */
export interface Judge {
  /** Scores one answer against its question (and optional reference). */
  judge(input: JudgeInput): Promise<JudgeVerdict>;
  /**
   * Releases the pinned judge session + transport. Idempotent. Present on the LLM
   * judge; optional for hand-rolled judges such as test fakes.
   */
  close?(): Promise<void>;
}

/** Options for {@link createLlmJudge}. */
export interface LlmJudgeOptions {
  /**
   * Tool-less completion transport from `@kgpacks/agent` (`createCopilotTransport()`).
   * The judge opens ONE session pinned to `model`, reuses it for every question and
   * BOTH arms, and closes it on `judge.close()`. Tests inject a mock `Transport` so
   * the suite runs fully offline.
   */
  transport: Transport;
  /**
   * Judge model id, pinned via `transport.open({ model })` — independent of the
   * synthesis model. Defaults to `DEFAULT_JUDGE_MODEL`. Overriding it re-baselines.
   */
  model?: string;
  /** Judge prompt template. Defaults to `JUDGE_PROMPT`. Identical across both arms. */
  prompt?: string;
  /** Per-grade send timeout (ms), forwarded to the session. */
  timeoutMs?: number;
}

// ── Skill evaluators ──────────────────────────────────────────────────────────

/** A per-skill scorer that can replace the generic judge for tagged questions. */
export interface SkillEvaluator {
  /** Skill name this evaluator handles. */
  name: string;
  /** Scores one answer for its skill, returning the same {@link JudgeVerdict} shape. */
  evaluate(question: EvalQuestion, answer: string): Promise<JudgeVerdict>;
}

/** Resolves a question's `skill` to the evaluator that should grade it. */
export interface SkillEvaluatorRegistry {
  /** Returns the evaluator for `skill`, or the judge-backed default when unmatched. */
  resolve(skill: string | undefined): SkillEvaluator;
}

// ── Arms ──────────────────────────────────────────────────────────────────────

/** An injectable answer producer. Two arms are compared per run. */
export interface Arm {
  /** Stable arm label, surfaced in `EvalReport` ('with-pack' | 'training-only'). */
  name: string;
  /** Produces this arm's answer for one question. */
  answer(question: EvalQuestion): Promise<ArmAnswer>;
}

/** One arm's answer for a question, plus optional token usage. */
export interface ArmAnswer {
  /** The arm's answer text, handed to the judge. */
  answer: string;
  /** Optional token usage for this answer (feeds cost/quota accounting). */
  usage?: Usage;
}

// ── Question loading ──────────────────────────────────────────────────────────

/** Loads a pack's eval questions. Injectable so tests use in-memory fixtures. */
export interface QuestionLoader {
  /** Loads the eval questions for one pack. */
  load(packId: string): Promise<EvalQuestion[]>;
}

// ── Sampling ──────────────────────────────────────────────────────────────────

/** How many questions a run scores. */
export interface SampleOptions {
  /** 'full' evaluates everything; 'stratified' takes a few questions per pack. */
  mode: 'full' | 'stratified';
  /** Questions per pack in stratified mode. Default `DEFAULT_PER_PACK` (3). */
  perPack?: number;
}

// ── Reports ───────────────────────────────────────────────────────────────────

/** Per-arm aggregate metrics. */
export interface ArmReport {
  /** The arm's name ('with-pack' | 'training-only'). */
  name: string;
  /** Mean of `verdict.correct` over the arm's questions (the headline accuracy). */
  accuracy: number;
  /** Mean of `verdict.score` (0–1) — a finer-grained aggregate. */
  meanScore: number;
  /** Number of questions scored for this arm. */
  count: number;
}

/** with-pack vs training-only head-to-head comparison. */
export interface ComparisonReport {
  /** withPack.accuracy − trainingOnly.accuracy — the pack's lift (can be negative). */
  deltaAccuracy: number;
  /** with-pack correct ∧ training-only incorrect. */
  wins: number;
  /** with-pack incorrect ∧ training-only correct (a regression). */
  losses: number;
  /** both correct or both incorrect. */
  ties: number;
  /** wins / (wins + losses); `0` when there are no decisive questions. */
  winRate: number;
}

/** One question's per-arm answers and verdicts. */
export interface QuestionResult {
  /** The question that was evaluated. */
  question: EvalQuestion;
  /** Keyed by arm name (e.g. 'with-pack' and 'training-only'). */
  arms: Record<string, { answer: string; verdict: JudgeVerdict }>;
}

/** The full, in-memory result of a run. Never persisted by the runner. */
export interface EvalReport {
  /** Per-question, per-arm answers and verdicts (in sampled order). */
  results: QuestionResult[];
  /** Per-arm aggregates. */
  arms: { withPack: ArmReport; trainingOnly: ArmReport };
  /** with-pack vs training-only comparison. */
  comparison: ComparisonReport;
  /** Questions evaluated after sampling. */
  sampled: number;
  /** Questions available before sampling. */
  total: number;
}

// ── Runner ────────────────────────────────────────────────────────────────────

/** Options for {@link runEval}. */
export interface RunEvalOptions {
  /** In-memory questions. Provide this OR `loader` (+ `packIds`). */
  questions?: EvalQuestion[];
  /** Injectable loader; used with `packIds` when `questions` is absent. */
  loader?: QuestionLoader;
  /** Pack ids to load via `loader`. Required when `loader` is used. */
  packIds?: string[];

  /** The full retrieve + synthesize arm. */
  withPack: Arm;
  /** The empty-context (no pack) baseline arm. */
  trainingOnly: Arm;

  /** The pinned LLM judge — used for any question without a registered skill. */
  judge: Judge;
  /** Optional per-skill evaluators; unregistered skills fall back to `judge`. */
  skillEvaluators?: SkillEvaluatorRegistry;

  /** Sampling mode. Default `{ mode: 'full' }`. */
  sample?: SampleOptions;
}
