// packages/eval/test/loader.test.ts
//
// Coverage for createDirQuestionLoader: the path-traversal guard, the read / JSON /
// shape error paths (all surfaced as EvalError), and question normalisation.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDirQuestionLoader, EVAL_QUESTIONS_FILENAME, EvalError } from '../src/index.js';

let base: string;

function writePack(packId: string, contents: unknown): void {
  const dir = join(base, packId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, EVAL_QUESTIONS_FILENAME),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
    'utf8',
  );
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'kgpacks-eval-loader-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('createDirQuestionLoader', () => {
  it('loads and normalises a valid question array', async () => {
    writePack('alpha-pack', [
      {
        id: 'q1',
        question: 'What is X?',
        ground_truth: 'ignored',
        referenceAnswer: 'X is X.',
        skill: 's',
        metadata: { a: 1 },
      },
      { id: 'q2', question: 'What is Y?' },
    ]);
    const loader = createDirQuestionLoader(base);
    const out = await loader.load('alpha-pack');

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 'q1',
      question: 'What is X?',
      packId: 'alpha-pack',
      referenceAnswer: 'X is X.',
      skill: 's',
      metadata: { a: 1 },
    });
    expect(out[1]).toMatchObject({ id: 'q2', question: 'What is Y?', packId: 'alpha-pack' });
    expect(out[1].referenceAnswer).toBeUndefined();
  });

  it('rejects a packId that escapes the base directory (path traversal)', async () => {
    const loader = createDirQuestionLoader(base);
    await expect(loader.load('../evil')).rejects.toBeInstanceOf(EvalError);
    await expect(loader.load('a/b')).rejects.toBeInstanceOf(EvalError);
  });

  it('raises EvalError when the questions file is missing', async () => {
    const loader = createDirQuestionLoader(base);
    await expect(loader.load('absent-pack')).rejects.toBeInstanceOf(EvalError);
  });

  it('raises EvalError on malformed JSON', async () => {
    writePack('bad-json', '{ not valid');
    const loader = createDirQuestionLoader(base);
    await expect(loader.load('bad-json')).rejects.toBeInstanceOf(EvalError);
  });

  it('raises EvalError when the JSON is not an array', async () => {
    writePack('not-array', { questions: [] });
    const loader = createDirQuestionLoader(base);
    await expect(loader.load('not-array')).rejects.toBeInstanceOf(EvalError);
  });

  it('raises EvalError for a question missing id or question', async () => {
    writePack('missing-id', [{ question: 'no id here' }]);
    writePack('missing-q', [{ id: 'q1' }]);
    const loader = createDirQuestionLoader(base);
    await expect(loader.load('missing-id')).rejects.toBeInstanceOf(EvalError);
    await expect(loader.load('missing-q')).rejects.toBeInstanceOf(EvalError);
  });
});
