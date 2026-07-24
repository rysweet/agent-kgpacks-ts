import { describe, expect, it } from 'vitest';

import { VECTOR_INDEX_DDL } from '../src/schema.js';

describe('vector index schema', () => {
  it('uses the complete-build sampling value for every generated vector index', () => {
    expect(VECTOR_INDEX_DDL).toHaveLength(2);
    for (const ddl of VECTOR_INDEX_DDL) {
      expect(ddl).toContain('pu := 0.9999999999999999');
    }
  });
});
