// Release-index signature verification + pull-time signature policy.
//
// Signing adds AUTHENTICITY on top of the existing SHA-256 integrity: a proof the
// `<name>.pack-release.json` index was produced by the project's release key. The
// signature covers the RAW index bytes and is verified BEFORE the JSON is parsed
// (verify-before-parse), so a tampered index can never influence the client before
// its signature is checked. Because the index pins every part's SHA-256 and the
// overall archive checksum, a valid signature transitively authenticates the whole
// multi-part download. Ed25519 is pinned in code — there is no algorithm
// negotiation and no `alg: none` path. See docs/pack-signing.md.

import { createPublicKey, verify as edVerify } from 'node:crypto';

import { TRUSTED_SIGNING_KEYS } from './signing-key.js';

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/**
 * Verifies an Ed25519 detached signature over `indexBytes` against a raw 32-byte
 * public key. Fails closed (returns `false`) on any malformed input — a wrong key
 * or signature length, an unparseable key, or a bad signature — never throwing.
 */
export function verifyPackIndexSignature(
  indexBytes: Buffer,
  signature: Buffer,
  rawPublicKey: Buffer,
): boolean {
  try {
    if (rawPublicKey.length !== ED25519_PUBLIC_KEY_BYTES) return false;
    if (signature.length !== ED25519_SIGNATURE_BYTES) return false;
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(rawPublicKey).toString('base64url') },
      format: 'jwk',
    });
    return edVerify(null, indexBytes, key, signature);
  } catch {
    return false;
  }
}

/**
 * Verifies a signature against the whole SET of trusted keys (any match wins, to
 * support key rotation). Returns the matching key id, or `null` if no trusted key
 * verifies the signature.
 */
export function verifyAgainstTrustedKeys(
  indexBytes: Buffer,
  signature: Buffer,
  keys: readonly { id: string; publicKey: string }[] = TRUSTED_SIGNING_KEYS,
): string | null {
  for (const { id, publicKey } of keys) {
    const raw = Buffer.from(publicKey, 'base64');
    if (verifyPackIndexSignature(indexBytes, signature, raw)) return id;
  }
  return null;
}

/** Inputs to {@link signaturePlan}. */
export interface SignaturePlanInput {
  /** Whether a detached signature was found alongside the index. */
  present: boolean;
  /** Whether that signature verified against a trusted key. */
  valid: boolean;
  /** `--require-signature`: hard-fail unless a valid signature is present. */
  requireSignature: boolean;
  /** `--no-verify`: skip signature checking entirely (integrity still enforced). */
  noVerify: boolean;
}

/** The action the puller takes given the signature state and flags. */
export type SignatureAction = 'verify' | 'fail' | 'warn' | 'skip';

/**
 * Decides how `pack pull` should treat the signature:
 * - present + valid → `verify` (proceed);
 * - present + invalid → `fail` (fail closed — tamper/wrong key);
 * - absent → `warn` (integrity-only), or `fail` under `--require-signature`;
 * - `--no-verify` → `skip`.
 *
 * `--require-signature` together with `--no-verify` is a usage error (they are
 * mutually exclusive).
 */
export function signaturePlan(input: SignaturePlanInput): SignatureAction {
  if (input.requireSignature && input.noVerify) {
    throw new Error('--require-signature and --no-verify are mutually exclusive');
  }
  if (input.noVerify) return 'skip';
  if (input.present) return input.valid ? 'verify' : 'fail';
  return input.requireSignature ? 'fail' : 'warn';
}
