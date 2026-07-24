# Signing & verifying pack releases

`wikigr pack pull` already guarantees **integrity** — every part's SHA-256 and the
overall archive checksum are verified before anything is installed (see
[docs/using-the-cve-pack.md](using-the-cve-pack.md)). Signing adds **authenticity**:
a cryptographic proof that the release index was produced by the project's release
key and has not been tampered with in transit or at rest on the release host.

## How it works

The release publisher signs the **raw bytes** of the `<name>.pack-release.json`
index with an **Ed25519** private key and uploads a detached signature alongside
it. On pull, `wikigr` fetches the signature, verifies it against the **committed
public key** over the exact bytes it downloaded, and only then parses the index and
trusts its checksums.

```
release-pack.mjs ──sign(index bytes)──▶  cve.pack-release.json
                                         cve.pack-release.json.sig      ◀── detached Ed25519 sig
                                         cve.pubkey                     ◀── raw public key (base64)
wikigr pack pull ──fetch both──▶ verify(sig, pubkey, raw index bytes)
                              ──▶ parse index ──▶ verify part + overall SHA-256 ──▶ install
```

Because the signature covers the index — and the index pins every part's SHA-256
plus the overall archive checksum — a valid signature transitively authenticates
the **entire** multi-part download. Verifying happens **before** the index JSON is
parsed, so a tampered index can never influence the client before its signature is
checked (verify-before-parse). The bytes that are verified are the same bytes that
are installed (no time-of-check/time-of-use gap).

- **Algorithm:** Ed25519, pinned in code. There is no algorithm-negotiation and no
  `alg: none` path — the verifier only ever accepts Ed25519.
- **Format:** a plain **detached Ed25519 signature** over the **raw index bytes**,
  base64-encoded in `<name>.pack-release.json.sig`. It is produced and verified with
  Node's built-in `crypto` (zero new dependencies, keeping `pnpm audit` green), so
  the signed content is exactly the bytes on disk and the verify-before-parse
  property holds byte-for-byte. (A minisign-compatible envelope is a possible future
  addition; the authenticity and verify-before-parse guarantees are identical.)
- **Public key:** committed to the repo at `packages/cli/src/signing-key.ts` (and
  mirrored as `<name>.pubkey` in the release) so verification needs no network trust
  root. The CLI trusts a **set** of keys (`TRUSTED_SIGNING_KEYS`) to support
  rotation.
- **Private key:** a GitHub **Actions secret** (`KGPACKS_SIGNING_KEY`, a base64
  PKCS8 DER Ed25519 key) scoped to the release job only. Never present in fork-PR
  CI, never passed on `argv`, never logged.

## Verifying on pull (default behavior)

Automatically discovered GitHub releases **must have a trusted signature by
default**:

```bash
wikigr pack pull cve
# ✓ signature verified (Ed25519, key cve-2025)
# ✓ 3/3 parts checksummed · overall archive checksum OK
# installed cve@2025.6.0 → /home/alice/.local/share/kgpacks/cve
```

- If the signature is **present and valid**, the pull proceeds.
- If the signature is **present and invalid** (bad signature, wrong key, or
  tampered index), the pull **fails closed** with a `PackInstallError` (CLI exit
  code 5) and installs nothing.
- Automatic discovery ignores releases without the index's `.sig` asset. A missing
  or invalid signature then fails closed before the index is parsed.
- An explicitly selected source (`--tag` or `--base-url`) may be unsigned for local
  and legacy workflows; the pull proceeds using checksum integrity alone and prints
  a warning unless `--require-signature` is set.

### Flags

| Flag                  | Effect                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--require-signature` | **Hard-fail** if an explicitly selected source lacks a valid signature. Automatic discovery already enforces this policy.                                                 |
| `--no-verify`         | Skip signature verification entirely, including during automatic discovery (checksums are still enforced). Explicit unsafe escape hatch for a trusted, air-gapped mirror. |

```bash
# Fail unless the release is signed by the project key
wikigr pack pull cve --require-signature

# Trusted internal mirror that re-hosts parts but not the signature
wikigr pack pull cve --base-url http://mirror.internal/kgpacks --no-verify
```

`--require-signature` and `--no-verify` are mutually exclusive (passing both is a
usage error, exit 2).

## Verifying manually

The signature is a plain base64 Ed25519 signature over the raw index bytes, so you
can verify a release independently of `wikigr` with a few lines of Node:

```bash
# Fetch the index, its signature, and the public key from the release
gh release download cve-2025.06 --repo rysweet/agent-kgpacks-ts \
  --pattern 'cve.pack-release.json' \
  --pattern 'cve.pack-release.json.sig' \
  --pattern 'cve.pubkey'

node -e '
  const fs = require("node:fs"), { createPublicKey, verify } = require("node:crypto");
  const idx = fs.readFileSync("cve.pack-release.json");
  const sig = Buffer.from(fs.readFileSync("cve.pack-release.json.sig", "utf8").trim(), "base64");
  const raw = Buffer.from(fs.readFileSync("cve.pubkey", "utf8").trim(), "base64");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
  console.log(verify(null, idx, key, sig) ? "OK: signature verified" : "FAIL");
'
```

## Signing when you publish

`scripts/release-pack.mjs` comprehensively validates schema-v2 packs. Legacy
schema-v1 packs fall back to structural manifest and payload packaging so
existing releases remain publishable; unknown schema versions fail closed. A
signing key is required for every real publication. The key is supplied through
`KGPACKS_SIGNING_KEY` (populated from the Actions secret in CI). The script writes
`<name>.pack-release.json.sig` next to the index and uploads both, plus the public
key:

```bash
# In CI (key injected from the Actions secret): signs + uploads the .sig
KGPACKS_SIGNING_KEY="$SIGNING_KEY" node scripts/release-pack.mjs --pack cve --tag cve-2025.06

# Local artifact inspection without a key: unsigned dry run only
node scripts/release-pack.mjs --pack cve --tag cve-2025.06 --dry-run --no-sign
```

| Flag / env             | Default | Meaning                                                               |
| ---------------------- | ------- | --------------------------------------------------------------------- |
| `KGPACKS_SIGNING_KEY`  | (unset) | Ed25519 private key (base64 PKCS8 DER). Required outside `--dry-run`. |
| `--sign` / `--no-sign` | auto    | Force signing, or allow an unsigned artifact only with `--dry-run`.   |

> The signing **private key never appears** in build logs, command lines, or fork
> PRs. Only the release job (running on a trusted ref) has access to the secret.

## Key rotation

The public key is versioned (its key id is embedded in the signature and printed on
verify, e.g. `key cve-2025`). To rotate:

1. Generate a new Ed25519 key pair; store the secret as a new Actions secret.
2. Commit the new public key to `packages/cli/src/signing-key.ts` (the CLI trusts a
   **set** of public keys during the overlap window so in-flight installs of
   older, still-valid releases keep verifying).
3. Publish new releases signed with the new key.
4. After the overlap window, drop the retired public key.

## Related docs

- [docs/pack-versioning.md](pack-versioning.md) — versioned tags & the provenance block the signature protects.
- [docs/using-the-cve-pack.md](using-the-cve-pack.md) — the end-to-end pull/verify UX.
- [docs/packages/packs.md](packages/packs.md) — the release index schema & installer security model.
