// @kgpacks/eval — the default, path-confined question loader.
//
// Reads a pack's eval questions from `<baseDir>/<packId>/eval_questions.json` and
// normalises them into `EvalQuestion[]`. All file access is resolved against
// `baseDir` and asserted to stay within it: `packId` is validated against the
// pack-name grammar (`@kgpacks/packs`' `PACK_NAME_RE`) — which rejects absolute
// paths, `..` traversal, path separators, and NUL bytes — and the resolved path is
// re-checked for containment as defence-in-depth (docs/packages/eval.md "Security
// model"). The loader is an interface, so tests inject in-memory fixtures and
// never touch disk.

import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { safeParseJson } from '@kgpacks/agent';
import { PACK_NAME_RE } from '@kgpacks/packs';

import { EvalError } from './errors.js';
import type { EvalQuestion, QuestionLoader } from './types.js';

/** The per-pack file the loader reads eval questions from. */
export const EVAL_QUESTIONS_FILENAME = 'eval_questions.json';

/**
 * Builds a path-confined {@link QuestionLoader} rooted at `baseDir`. Each
 * `load(packId)` validates the id, resolves `<baseDir>/<packId>/eval_questions.json`,
 * asserts it stays under `baseDir`, reads it, and normalises each entry into an
 * {@link EvalQuestion} (with `packId` forced to the requested pack).
 */
export function createDirQuestionLoader(baseDir: string): QuestionLoader {
  const root = resolve(baseDir);

  return {
    async load(packId: string): Promise<EvalQuestion[]> {
      assertSafePackId(packId);

      const packDir = resolve(root, packId);
      if (packDir !== root && !packDir.startsWith(root + sep)) {
        throw new EvalError(`packId '${packId}' escapes the loader base directory.`);
      }
      const file = resolve(packDir, EVAL_QUESTIONS_FILENAME);

      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        throw new EvalError(
          `Failed to read eval questions for pack '${packId}': ${(err as Error).message}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = safeParseJson(text);
      } catch (err) {
        throw new EvalError(
          `Eval questions for pack '${packId}' are not valid JSON: ${(err as Error).message}`,
        );
      }
      if (!Array.isArray(parsed)) {
        throw new EvalError(
          `Eval questions for pack '${packId}' must be a JSON array of questions.`,
        );
      }

      return parsed.map((entry, index) => normaliseQuestion(entry, packId, index));
    },
  };
}

/** Rejects any packId that is not a bare, safe pack name. */
function assertSafePackId(packId: string): void {
  if (!PACK_NAME_RE.test(packId)) {
    throw new EvalError(
      `Invalid packId: must match ${String(PACK_NAME_RE)} (no path separators, '..', absolute paths, or NUL).`,
    );
  }
}

/** Validates one raw entry and stamps it with the owning pack id. */
function normaliseQuestion(entry: unknown, packId: string, index: number): EvalQuestion {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new EvalError(`Question ${index} in pack '${packId}' is not an object.`);
  }
  const obj = entry as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    throw new EvalError(`Question ${index} in pack '${packId}' is missing a string 'id'.`);
  }
  if (typeof obj.question !== 'string' || obj.question.length === 0) {
    throw new EvalError(`Question '${obj.id}' in pack '${packId}' is missing a string 'question'.`);
  }

  const question: EvalQuestion = { id: obj.id, question: obj.question, packId };
  if (typeof obj.referenceAnswer === 'string') question.referenceAnswer = obj.referenceAnswer;
  if (typeof obj.skill === 'string') question.skill = obj.skill;
  if (typeof obj.metadata === 'object' && obj.metadata !== null && !Array.isArray(obj.metadata)) {
    question.metadata = obj.metadata as Record<string, unknown>;
  }
  return question;
}
