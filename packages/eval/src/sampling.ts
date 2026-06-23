// @kgpacks/eval — deterministic stratified sampler.
//
// Bounds LLM cost during development by taking a few questions per pack. The
// selection is REPRODUCIBLE — group by pack (sub-stratify by skill when present),
// preserve input order, take the first-N (no RNG) — so two runs over the same
// input evaluate the same questions and test assertions never flake (decision D7).

import { DEFAULT_PER_PACK } from './constants.js';
import { EvalError } from './errors.js';
import type { EvalQuestion, SampleOptions } from './types.js';

/** Sentinel skill bucket for questions without a `skill` tag. */
const NO_SKILL = '\u0000__no_skill__';

/**
 * Deterministically reduces a question set. In `'stratified'` mode it groups by
 * `packId` (sub-stratifying by `skill` when present), preserves input order, and
 * takes the first `perPack` of each pack — so the result is reproducible and
 * bounded by `perPack × packCount`. In `'full'` mode it returns the input
 * unchanged.
 *
 * @throws {EvalError} when `perPack` is not a positive integer.
 */
export function selectSample(questions: EvalQuestion[], options: SampleOptions): EvalQuestion[] {
  if (options.mode === 'full') return questions;

  const perPack = options.perPack ?? DEFAULT_PER_PACK;
  if (!Number.isInteger(perPack) || perPack <= 0) {
    throw new EvalError(`sample.perPack must be a positive integer, got ${String(perPack)}.`);
  }

  // Group by pack in first-appearance order, keeping each pack's questions in
  // input order — this is what makes "first-N" deterministic.
  const packs = new Map<string, EvalQuestion[]>();
  for (const question of questions) {
    let bucket = packs.get(question.packId);
    if (!bucket) {
      bucket = [];
      packs.set(question.packId, bucket);
    }
    bucket.push(question);
  }

  const selected: EvalQuestion[] = [];
  for (const bucket of packs.values()) {
    selected.push(...takeStratifiedBySkill(bucket, perPack));
  }
  return selected;
}

/**
 * Takes up to `perPack` questions from one pack. When the pack carries skills,
 * it round-robins across the skill buckets (in first-appearance order) so a
 * small `perPack` samples ACROSS skills rather than collapsing onto one. With no
 * skills there is a single bucket, so this degrades to a stable first-N.
 */
function takeStratifiedBySkill(pack: EvalQuestion[], perPack: number): EvalQuestion[] {
  const bySkill = new Map<string, EvalQuestion[]>();
  for (const question of pack) {
    const key = question.skill ?? NO_SKILL;
    let bucket = bySkill.get(key);
    if (!bucket) {
      bucket = [];
      bySkill.set(key, bucket);
    }
    bucket.push(question);
  }

  const buckets = [...bySkill.values()];
  const taken: EvalQuestion[] = [];
  for (let round = 0; taken.length < perPack; round++) {
    let progressed = false;
    for (const bucket of buckets) {
      if (round < bucket.length) {
        taken.push(bucket[round]!);
        progressed = true;
        if (taken.length >= perPack) break;
      }
    }
    if (!progressed) break; // every bucket exhausted
  }
  return taken;
}
