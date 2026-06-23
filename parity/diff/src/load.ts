// Fixture loading + validation.
//
// Fixtures are committed JSON artifacts produced by the dev-time Python oracle
// (parity/oracle/export_fixtures.py). `loadFixture` reads one from disk;
// `assertGoldenFixture` validates an already-parsed value. Validation is
// intentionally shallow — it pins the schema version and the presence/types of
// the fields the comparator actually reads, so a malformed or stale fixture
// fails loudly at load time instead of producing a misleading parity report.

import { readFileSync } from 'node:fs';

import type { GoldenFixture } from './types.js';

const SCHEMA_VERSION = 1;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'string');
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'number');
}

export function assertGoldenFixture(value: unknown): GoldenFixture {
  if (!isObject(value)) {
    throw new Error('invalid golden fixture: expected a JSON object');
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported golden fixture schemaVersion: ${JSON.stringify(value.schemaVersion)} ` +
        `(expected ${SCHEMA_VERSION})`,
    );
  }

  const stages = value.stages;
  if (!isObject(stages)) {
    throw new Error('invalid golden fixture: missing "stages" object');
  }

  const embedding = stages.queryEmbedding;
  if (!isObject(embedding) || !isNumberArray(embedding.vector)) {
    throw new Error('invalid golden fixture: stages.queryEmbedding.vector must be a number[]');
  }
  if (!isStringArray(stages.retrievedIds)) {
    throw new Error('invalid golden fixture: stages.retrievedIds must be a string[]');
  }
  if (!isStringArray(stages.rerankedIds)) {
    throw new Error('invalid golden fixture: stages.rerankedIds must be a string[]');
  }

  const finalAnswer = stages.finalAnswer;
  if (
    !isObject(finalAnswer) ||
    !isStringArray(finalAnswer.citations) ||
    !isStringArray(finalAnswer.topK) ||
    typeof finalAnswer.seed !== 'number'
  ) {
    throw new Error(
      'invalid golden fixture: stages.finalAnswer must have citations[], topK[] and a numeric seed',
    );
  }

  const fixtureCase = value.case;
  if (!isObject(fixtureCase) || !isObject(fixtureCase.config)) {
    throw new Error('invalid golden fixture: missing "case.config"');
  }
  if (typeof fixtureCase.config.cosineThreshold !== 'number') {
    throw new Error('invalid golden fixture: case.config.cosineThreshold must be a number');
  }

  return value as unknown as GoldenFixture;
}

export function loadFixture(path: string | URL): GoldenFixture {
  const raw = readFileSync(path, 'utf8');
  return assertGoldenFixture(JSON.parse(raw));
}
