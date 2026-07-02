// Trusted release-signing public keys.
//
// The project signs the raw bytes of every `<name>.pack-release.json` index with
// an Ed25519 private key (a GitHub Actions secret, never committed). These are the
// matching PUBLIC keys, committed so `wikigr pack pull` needs no network trust
// root to verify authenticity. Verification trusts the whole SET (not a single
// key) so a key rotation can overlap: publish releases under a new key while
// in-flight installs of older, still-valid releases keep verifying. Drop a retired
// key after its overlap window. See docs/pack-signing.md.

/** A trusted signing key: a stable id + the raw 32-byte Ed25519 public key (base64). */
export interface TrustedSigningKey {
  /** Human-readable key id, printed on verify and embedded in rotations. */
  id: string;
  /** Raw 32-byte Ed25519 public key, standard-base64 encoded. */
  publicKey: string;
}

/** The set of currently-trusted release-signing public keys. */
export const TRUSTED_SIGNING_KEYS: readonly TrustedSigningKey[] = [
  { id: 'cve-2025', publicKey: 'bk2eh321zm67ayzSQz9akmt2876BPfxsIHzyTLUnvD8=' },
];
