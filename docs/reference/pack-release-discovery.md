---
title: Pack Release Discovery and Download Reference
description: Reference for how wikigr selects, verifies, downloads, and installs pack releases
last_updated: 2026-07-24
review_schedule: as-needed
owner: rysweet
doc_type: reference
---

# Pack release discovery and download reference

`wikigr pack pull` installs a multi-part knowledge pack from a GitHub release or
an explicitly selected asset directory. This reference describes the implemented
selection, signature, and integrity rules.

## Contents

- [Command](#command)
- [Source resolution](#source-resolution)
- [Automatic discovery](#automatic-discovery)
- [Signature policy](#signature-policy)
- [Index and download validation](#index-and-download-validation)
- [Success output](#success-output)
- [Programmatic API](#programmatic-api)
- [Failure behavior](#failure-behavior)
- [Current transport boundaries](#current-transport-boundaries)

## Command

```text
wikigr [--packs-dir <dir>] pack pull <name>
       [--repo <owner/repo>] [--tag <tag>] [--base-url <url>]
       [--require-signature | --no-verify]
```

| Option                | Default                    | Behavior                                                                 |
| --------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `<name>`              | required                   | Matches `<name>.pack-release.json` and the name declared by that index.  |
| `--repo <owner/repo>` | `rysweet/agent-kgpacks-ts` | Repository queried during discovery or combined with `--tag`.            |
| `--tag <tag>`         | omitted                    | Selects one release tag and bypasses automatic discovery.                |
| `--base-url <url>`    | omitted                    | Reads the index and parts from this URL; overrides `--repo` and `--tag`. |
| `--require-signature` | false                      | Requires a trusted signature for an explicitly selected source.          |
| `--no-verify`         | false                      | Skips signature verification; SHA-256 integrity checks remain mandatory. |

`--require-signature` and `--no-verify` are mutually exclusive.

## Source resolution

The source is resolved in this order:

1. `--base-url` is used after trailing slashes are removed.
2. `--tag` resolves to
   `https://github.com/<repo>/releases/download/<tag>`.
3. With neither option, the CLI discovers a release from `--repo`.

An explicit `--tag` or `--base-url` never falls back to automatic discovery.

```bash
# Discover the latest matching CVE release.
wikigr pack pull cve

# Pin one immutable release.
wikigr pack pull cve \
  --repo rysweet/agent-kgpacks-ts \
  --tag cve-v2026.7.0

# Use a local mirror. Explicit URLs may use HTTP.
wikigr pack pull cve --base-url http://127.0.0.1:8080
```

## Automatic discovery

Discovery requests GitHub's public releases API in pages of 100:

```text
GET https://api.github.com/repos/<owner>/<repo>/releases?per_page=100&page=<n>
```

It continues until GitHub returns fewer than 100 releases. A candidate must:

- be a non-draft, non-prerelease GitHub release;
- use a supported immutable tag for the requested pack;
- resolve to a stable SemVer version;
- advertise `<name>.pack-release.json`; and
- advertise `<name>.pack-release.json.sig`, unless `--no-verify` is set.

Supported tags are:

- `<name>-v<semver>`, such as `cve-v2026.7.0`;
- `<name>-YYYY.MM[.N]`, such as `cve-2026.07` or `cve-2026.07.1`.

Dated tags are normalized to SemVer for comparison. For example,
`cve-2026.07` becomes `2026.7.0`. Tags whose normalized version contains a
prerelease component are excluded.

### Selection order

Candidates are compared in descending order by:

1. SemVer precedence;
2. the complete normalized version, using bytewise ordering; and
3. the complete tag, using bytewise ordering.

The second comparison makes build metadata deterministic even though SemVer
precedence ignores it. The result does not depend on GitHub response order.
Publication time and GitHub release ID are not selection inputs.

The selected release is verified and downloaded once. If its advertised
signature or content is invalid, the command fails; it does not try an older
release.

## Signature policy

The signature is a base64-encoded, detached Ed25519 signature over the raw
bytes of `<name>.pack-release.json`. When verification is enabled, the CLI
verifies those bytes against the public keys committed in
`packages/cli/src/signing-key.ts` before parsing the index.

| Source                                     | Default signature behavior                                    |
| ------------------------------------------ | ------------------------------------------------------------- |
| Automatic discovery                        | A trusted signature is required.                              |
| Automatic discovery with `--no-verify`     | Signature verification is skipped.                            |
| Explicit `--tag` or `--base-url`           | A valid signature is verified; a missing one emits a warning. |
| Explicit source with `--require-signature` | A trusted signature is required.                              |
| Any source with an invalid signature       | The pull fails unless `--no-verify` was supplied.             |

For an explicit source, an unavailable or unreadable signature is treated as
missing. Automatic discovery still fails because its signature is required.

See [Signing and verifying pack releases](../pack-signing.md) for the key
format, publishing workflow, and manual verification example.

## Index and download validation

After signature policy succeeds, the CLI parses the release index and requires:

- an object whose `name` exactly matches `<name>`;
- an overall checksum string;
- at least one part;
- a filename containing only letters, digits, `.`, `_`, or `-`, plus a checksum
  string and numeric byte count for every part.

The declared checksums and byte counts are compared with the downloaded bytes.
The index's `version`, `format`, and `totalBytes` fields are not used to select
the release or limit the download. `totalBytes` is copied to the success output.

Parts are downloaded sequentially to a temporary directory. Each download is
streamed to disk while its byte count, part SHA-256, and the assembled archive
SHA-256 are calculated. Installation starts only after every declared part and
the overall archive match the signed index.

The verified part files are concatenated as a stream into the pack installer.
The installer validates the archive and commits the completed pack atomically.
On failure, the temporary download directory is removed and no partial pack is
installed.

The streaming installer also rejects an archive whose extracted content exceeds
32 GiB. This archive-extraction limit is separate from the downloader limits
described below.

## Success output

The CLI writes JSON to stdout:

```json
{
  "name": "cve",
  "version": "2026.7.0",
  "path": "/home/alice/.local/share/kgpacks/cve",
  "parts": 3,
  "bytes": 4080218931,
  "signedBy": "cve-2025"
}
```

| Field      | Source                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| `name`     | Installed pack manifest                                                   |
| `version`  | Installed pack manifest                                                   |
| `path`     | Final installation path                                                   |
| `parts`    | Number of entries in the release index                                    |
| `bytes`    | `totalBytes` declared by the release index                                |
| `signedBy` | Matching trusted key ID, or `null` for an unsigned or unverified download |

## Programmatic API

`@kgpacks/cli` exports `pullPack`, `resolvePackBaseUrl`, and their public types:

```ts
import { pullPack } from '@kgpacks/cli';

const result = await pullPack({
  name: 'cve',
  packsDir: '/srv/kgpacks',
  repo: 'rysweet/agent-kgpacks-ts',
});

console.log(result.path);
```

`PullPackOptions` adds test and embedding seams beyond the CLI flags:

| Option             | Default               | Purpose                                            |
| ------------------ | --------------------- | -------------------------------------------------- |
| `name`             | required              | Requested pack name                                |
| `packsDir`         | required              | Installation root                                  |
| `repo`             | project repository    | Discovery repository                               |
| `tag`              | omitted               | Explicit release tag                               |
| `baseUrl`          | omitted               | Explicit asset-directory URL                       |
| `tmpRoot`          | operating-system temp | Scratch-download root                              |
| `requireSignature` | `false`               | Require a trusted signature for an explicit source |
| `noVerify`         | `false`               | Skip signature verification                        |
| `trustedKeys`      | committed key set     | Override trusted Ed25519 keys                      |
| `log`              | stderr                | Receive human-readable signature status            |

The programmatic API does not accept an `AbortSignal`.

## Failure behavior

Release discovery, signature, index, download, size, checksum, and installation
failures are reported as pack-install failures (CLI exit code `5`). Common
causes include:

- an invalid repository name;
- a GitHub API error or a non-array release response;
- no matching immutable release;
- a missing, malformed, or untrusted required signature;
- a missing or malformed release index;
- a failed part request; or
- a size or checksum mismatch.

The implementation exposes `PackInstallError`, not separate external-service
error codes. The CLI maps that error to exit code `5`.

## Current transport boundaries

The current implementation relies on the Node.js `fetch` redirect behavior and
does not add an origin allowlist, per-redirect validation, retries, request
timeouts, or cancellation. Discovery has no page or total-release limit. The
puller has no limits on index size, signature size, part count, or compressed
download bytes; the 32 GiB installer limit applies only while extracting the
assembled archive.

`--base-url` intentionally accepts HTTP URLs for local mirrors. Release entries
with missing or unexpected fields are skipped rather than causing the entire
discovery response to fail. Invalid top-level JSON or a non-array response does
fail discovery.

Errors may include the requested URL and the underlying network error. Do not
put credentials or other secrets in `--base-url`.

Callers that require HTTPS-only sources, restricted-address rejection,
per-redirect origin checks, bounded retries, or total transfer limits must
enforce those controls outside this command.

## Related documentation

- [Install and use the CVE knowledge pack](../using-the-cve-pack.md)
- [Signing and verifying pack releases](../pack-signing.md)
- [Pack versioning and provenance](../pack-versioning.md)
- [`@kgpacks/packs` package reference](../packages/packs.md)
