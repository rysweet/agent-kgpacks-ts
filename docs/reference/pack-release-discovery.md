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
- [Transport safety and limits](#transport-safety-and-limits)

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
- have a raw ASCII tag in a supported immutable form for the requested pack;
- resolve to a supported, strict, stable SemVer version with no prerelease
  component;
- provide a valid publication time and non-negative GitHub release ID;
- advertise exactly one `<name>.pack-release.json`; and
- advertise no more than one `<name>.pack-release.json.sig`, with exactly one
  required unless `--no-verify` is set.

Supported tags are:

- `<name>-v<semver>`, such as `cve-v2026.7.0`;
- `<name>-YYYY.MM[.N]`, such as `cve-2026.07` or `cve-2026.07.1`.

Dated tags are normalized to SemVer for comparison. For example,
`cve-2026.07` becomes `2026.7.0`. Drafts, releases marked `prerelease` by
GitHub, unsupported or malformed versions, version strings with a SemVer
prerelease component, non-ASCII tags, and releases missing a required index or
signature asset are filtered out before ranking. They cannot win selection and
then cause fallback behavior.

### Selection order

Candidates are compared in descending order by:

1. SemVer precedence;
2. publication time;
3. the original complete tag, using unsigned ordinal ASCII-byte ordering; and
4. numeric GitHub release ID.

The tag comparison reads each raw tag byte from left to right and then compares
length when one tag is a prefix. It does not compare normalized versions and
does not use `localeCompare`, host collation, locale settings, or Unicode
normalization. Because non-ASCII tags are excluded before ranking, character
code and UTF-8 byte order are identical. Release IDs are compared as unsigned
decimal integers without converting them to JavaScript numbers. Candidates
identical on all four fields are rejected as ambiguous.

This order makes equal-precedence choices, including versions that differ only
by SemVer build metadata or dated-versus-v tag spelling, deterministic across
hosts and GitHub response order.

The selected release is the only candidate attempted. A retryable request may be
repeated within the limits below, but an invalid signature or content fails the
command; it does not try an older release.

These filtering and ranking rules apply only when neither `--tag` nor
`--base-url` is supplied. An explicit source remains pinned exactly as requested,
bypasses discovery filtering and ranking, and never falls back to another
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
- format `tar.gz-multipart-v1` and a strict SemVer `version`;
- lowercase 64-character hexadecimal part and overall SHA-256 values;
- a positive, safe-integer `totalBytes` no larger than 32 GiB;
- between 1 and 10,000 parts;
- exact, unique, sequential filenames such as `cve.tar.gz.000`,
  `cve.tar.gz.001`, and `cve.tar.gz.002`;
- a positive, safe-integer byte count for every part; and
- a `totalBytes` value exactly equal to the sum of the declared part sizes.

For an automatically discovered release, the signed index version must equal
the version derived from the selected tag. `totalBytes` limits the compressed
download and is copied to the success output.

Parts are downloaded sequentially to a temporary directory. Each download is
streamed to a distinct file while its byte count and SHA-256 are calculated.
After all parts match, the CLI rereads the ordered files and calculates the
assembled archive SHA-256. Installation starts only after every part and the
assembled archive match the signed index.

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

`PullPackOptions` adds test and transport seams beyond the CLI flags:

| Option             | Default               | Purpose                                                |
| ------------------ | --------------------- | ------------------------------------------------------ |
| `name`             | required              | Requested pack name                                    |
| `packsDir`         | required              | Installation root                                      |
| `repo`             | project repository    | Discovery repository                                   |
| `tag`              | omitted               | Explicit release tag                                   |
| `baseUrl`          | omitted               | Explicit asset-directory URL                           |
| `tmpRoot`          | operating-system temp | Scratch-download root                                  |
| `requireSignature` | `false`               | Require a trusted signature for an explicit source     |
| `noVerify`         | `false`               | Skip signature verification                            |
| `trustedKeys`      | committed key set     | Override trusted Ed25519 keys                          |
| `log`              | stderr                | Receive human-readable signature status                |
| `signal`           | omitted               | Cancel discovery, retries, downloads, and verification |
| `externalLimits`   | bounded defaults      | Override transport limits for constrained environments |
| `fetch`            | global `fetch`        | Inject a fetch implementation                          |

The CLI uses the bounded defaults below. Programmatic callers can lower or
otherwise override individual limits with `externalLimits`; invalid limits fail
before a request is made.

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

Transport and trust failures are `PackInstallError` instances with a stable
`code`, such as `cancelled`, `timeout`, `http`, `redirect`, `origin`,
`response-too-large`, `ambiguous`, `trust`, or `integrity`. The CLI maps them to
exit code `5`.

## Transport safety and limits

Every request uses manual redirect handling. The CLI rejects credentials in
URLs, validates the initial URL and every redirect target, and permits at most
five redirects.

| Source                   | Allowed origins                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| GitHub release discovery | `https://api.github.com`                                                                                          |
| GitHub release assets    | `https://github.com`, `https://objects.githubusercontent.com`, and `https://release-assets.githubusercontent.com` |
| Explicit `--base-url`    | The exact supplied origin; same-origin redirects only                                                             |

`--base-url` intentionally accepts HTTP for local mirrors. It does not permit a
redirect to a different origin. GitHub discovery also verifies that every
advertised asset URL belongs to the requested repository, tag, and asset name.

The default bounds are:

| Limit                          | Default             |
| ------------------------------ | ------------------- |
| Per-request timeout            | 30 seconds          |
| Complete discovery deadline    | 2 minutes           |
| Pull transport deadline        | 2 hours             |
| Discovery pages                | 10 (1,000 releases) |
| One discovery response page    | 8 MiB               |
| Release index                  | 8 MiB               |
| Detached signature             | 64 KiB              |
| Compressed multipart archive   | 32 GiB              |
| Parts                          | 10,000              |
| Redirects per request          | 5                   |
| Attempts per retryable request | 3                   |

The extraction-time 32 GiB archive limit is enforced separately by the pack
installer.

Transport failures and HTTP `408`, `429`, `500`, `502`, `503`, and `504`
responses are retryable. A GitHub `403` with `X-RateLimit-Remaining: 0` is also
retryable. Other HTTP responses, timeouts, caller cancellation, trust failures,
and integrity failures are not retried. Retry delays use bounded exponential
backoff or `Retry-After`, capped at 30 seconds and by the operation deadline.

Discovery entries with missing candidate metadata are skipped. Invalid
top-level JSON, a non-array response, untrusted asset URLs, duplicate required
assets, or a full final page at the pagination limit fail closed.

External-service errors omit requested URLs, redirect targets, and nested
network-error text so signed query parameters and other URL details are not
copied into logs.

## Related documentation

- [Install and use the CVE knowledge pack](../using-the-cve-pack.md)
- [Signing and verifying pack releases](../pack-signing.md)
- [Pack versioning and provenance](../pack-versioning.md)
- [`@kgpacks/packs` package reference](../packages/packs.md)
