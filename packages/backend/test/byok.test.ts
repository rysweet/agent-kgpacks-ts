// packages/backend/test/byok.test.ts
//
// hasByokCredentials must treat empty strings as unset and detect ANY non-empty
// key. Regression: the previous `??` chain short-circuited on an empty earlier key
// (docker-compose forwards each key as `${VAR:-}` = ''), so an OPENAI/ANTHROPIC-only
// deploy never started the agent.

import { describe, expect, it } from 'vitest';

import { hasByokCredentials } from '../src/index.js';

describe('hasByokCredentials', () => {
  it('is false when all keys are absent or empty', () => {
    expect(hasByokCredentials({})).toBe(false);
    expect(
      hasByokCredentials({ COPILOT_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }),
    ).toBe(false);
    expect(hasByokCredentials({ OPENAI_API_KEY: '   ' })).toBe(false); // whitespace = unset
  });

  it('is true for ANY non-empty key, even when an EARLIER key is empty', () => {
    // The bug: '' ?? next short-circuits; only OPENAI/ANTHROPIC provided must still pass.
    expect(
      hasByokCredentials({
        COPILOT_API_KEY: '',
        OPENAI_API_KEY: 'sk-openai',
        ANTHROPIC_API_KEY: '',
      }),
    ).toBe(true);
    expect(hasByokCredentials({ ANTHROPIC_API_KEY: 'sk-anthropic' })).toBe(true);
    expect(hasByokCredentials({ COPILOT_API_KEY: 'tok' })).toBe(true);
  });
});
