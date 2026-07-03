// packages/eval/test/eval-questions.schema.test.ts
//
// TDD (RED): data/packs/cve/eval_questions.json is not present in this tree yet, so
// the loader rejects and this suite fails today. It encodes docs/cve-eval.md — the
// committed CVE eval set must load through the path-confined `createDirQuestionLoader`
// and be EXTENDED with real, recent (2024/2025) CVEs so the eval exercises knowledge
// the base model is least likely to already hold (maximizing `comparison.deltaAccuracy`).
// Every recent question must reference a real CVE and carry a reference answer.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { createDirQuestionLoader } from '../src/index.js';
import type { EvalQuestion } from '../src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const packsDir = join(repoRoot, 'data', 'packs');
const RECENT_CVE_RE = /CVE-20(24|25)-\d{3,}/;

let questions: EvalQuestion[];

beforeAll(async () => {
  const loader = createDirQuestionLoader(packsDir);
  questions = await loader.load('cve');
});

describe('CVE eval questions', () => {
  it('loads a non-trivial set of well-formed questions', () => {
    expect(questions.length).toBeGreaterThanOrEqual(12);
    for (const q of questions) {
      expect(typeof q.id).toBe('string');
      expect(q.id.length).toBeGreaterThan(0);
      expect(typeof q.question).toBe('string');
      expect(q.question.length).toBeGreaterThan(0);
      expect(q.packId).toBe('cve');
    }
  });

  it('has unique question ids', () => {
    const ids = questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is extended with real, recent (2024/2025) CVEs carrying reference answers', () => {
    const recent = questions.filter((q) => {
      const year = q.metadata?.year;
      const mentionsRecent =
        RECENT_CVE_RE.test(q.question) || RECENT_CVE_RE.test(q.referenceAnswer ?? '');
      return mentionsRecent || year === 2024 || year === 2025;
    });
    expect(recent.length).toBeGreaterThanOrEqual(6);
    for (const q of recent) {
      expect(typeof q.referenceAnswer).toBe('string');
      expect((q.referenceAnswer ?? '').length).toBeGreaterThan(0);
    }
  });
});
