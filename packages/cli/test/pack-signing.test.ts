// packages/cli/test/pack-signing.test.ts
//
// TDD (RED): packages/cli/src/pack-signing.ts does not exist yet, so this suite
// fails at import today. It encodes docs/pack-signing.md — Ed25519 verification of
// the release index over its RAW bytes against a committed public key
// (verify-before-parse), and the pull-time signature POLICY (present+valid →
// verify, present+invalid → fail-closed, absent → integrity-only warning unless
// `--require-signature`, `--no-verify` → skip; the two flags are mutually exclusive).

import { generateKeyPairSync, sign as edSign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyPackIndexSignature, signaturePlan } from '../src/pack-signing.js';

/** Builds an Ed25519 keypair exposing the raw 32-byte public key + a raw-signer. */
function ed25519Keypair(): { rawPublicKey: Buffer; sign: (m: Buffer) => Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const rawPublicKey = Buffer.from(jwk.x, 'base64url');
  return { rawPublicKey, sign: (m: Buffer) => edSign(null, m, privateKey) };
}

const INDEX_BYTES = Buffer.from('{"name":"cve","version":"2025.6.0","sha256":"deadbeef"}\n');

describe('verifyPackIndexSignature (Ed25519 over the raw index bytes)', () => {
  it('accepts a valid signature made by the trusted key', () => {
    const key = ed25519Keypair();
    const sig = key.sign(INDEX_BYTES);
    expect(verifyPackIndexSignature(INDEX_BYTES, sig, key.rawPublicKey)).toBe(true);
  });

  it('rejects a signature over tampered index bytes', () => {
    const key = ed25519Keypair();
    const sig = key.sign(INDEX_BYTES);
    const tampered = Buffer.from(INDEX_BYTES);
    tampered[0] ^= 0xff;
    expect(verifyPackIndexSignature(tampered, sig, key.rawPublicKey)).toBe(false);
  });

  it('rejects a valid signature made by a different (untrusted) key', () => {
    const signer = ed25519Keypair();
    const other = ed25519Keypair();
    const sig = signer.sign(INDEX_BYTES);
    expect(verifyPackIndexSignature(INDEX_BYTES, sig, other.rawPublicKey)).toBe(false);
  });
});

describe('signaturePlan (pull-time policy)', () => {
  it('verifies when a signature is present and valid', () => {
    expect(
      signaturePlan({ present: true, valid: true, requireSignature: false, noVerify: false }),
    ).toBe('verify');
  });

  it('fails closed when a present signature is invalid', () => {
    expect(
      signaturePlan({ present: true, valid: false, requireSignature: false, noVerify: false }),
    ).toBe('fail');
  });

  it('warns (integrity-only) when no signature is present, by default', () => {
    expect(
      signaturePlan({ present: false, valid: false, requireSignature: false, noVerify: false }),
    ).toBe('warn');
  });

  it('fails when a signature is required but absent', () => {
    expect(
      signaturePlan({ present: false, valid: false, requireSignature: true, noVerify: false }),
    ).toBe('fail');
  });

  it('skips verification entirely under --no-verify', () => {
    expect(
      signaturePlan({ present: true, valid: false, requireSignature: false, noVerify: true }),
    ).toBe('skip');
  });

  it('treats --require-signature together with --no-verify as a usage error', () => {
    expect(() =>
      signaturePlan({ present: true, valid: true, requireSignature: true, noVerify: true }),
    ).toThrow();
  });
});
