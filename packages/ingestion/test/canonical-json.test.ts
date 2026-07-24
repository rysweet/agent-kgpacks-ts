import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/canonical-json.js';

describe('canonicalJson', () => {
  it('orders object keys by Unicode scalar value rather than UTF-16 code units', () => {
    const privateUse = '\ue000';
    const supplementary = '\u{10000}';

    expect(canonicalJson({ [supplementary]: 2, [privateUse]: 1 })).toBe(
      `{"${privateUse}":1,"${supplementary}":2}`,
    );
  });

  it('canonicalizes nested objects without reordering arrays', () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
  });
});
