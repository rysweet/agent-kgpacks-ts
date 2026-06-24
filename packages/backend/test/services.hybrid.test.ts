// Service-level guard: hybridSearch must self-protect against an out-of-range
// maxHops (interpolated into the Cypher variable-length-path bound) even when
// called directly, not only behind the route's JSON-schema validation.

import { describe, expect, it } from 'vitest';

import type { Connection } from '@kgpacks/db';

import { ApiError } from '../src/errors.js';
import { hybridSearch } from '../src/services/hybrid.js';

describe('hybridSearch — maxHops guard', () => {
  it('rejects out-of-range maxHops before any DB query', async () => {
    const conn = {
      run: async () => {
        throw new Error('hybridSearch queried the DB despite an invalid maxHops');
      },
    } as unknown as Connection;

    await expect(
      hybridSearch(conn, { query: 'Article', category: null, maxHops: 5, limit: 10 }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
