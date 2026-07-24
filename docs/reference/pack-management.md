---
title: Pack pull and validation contract
description: Source resolution, release discovery, integrity, schema dispatch, and API behavior for pack management
last_updated: 2026-07-24
review_schedule: as-needed
owner: kgpacks-maintainers
doc_type: reference
---

# Pack pull and validation

`wikigr pack pull` verifies and installs release artifacts. `wikigr pack
validate` selects the validation contract declared by an installed manifest.
Pull fails closed on authenticity or integrity errors; validation fails
closed when schema identity is ambiguous.

## Contents

- [Pull a pack](#pull-a-pack)
- [Stable release discovery](#stable-release-discovery)
- [Release-index integrity](#release-index-integrity)
- [Manifest schema dispatch](#manifest-schema-dispatch)
- [Programmatic API](#programmatic-api)
- [Related documentation](#related-documentation)

## Pull a pack

```bash
# Discover and install the latest eligible stable release.
wikigr pack pull cve

# Pin an immutable release.
wikigr pack pull cve --tag cve-v2026.7.0

# Use a mirror instead of GitHub release discovery.
wikigr pack pull cve --base-url https://packs.example.net/cve/2026.7.0
```

| Option                | Default                           | Behavior                                                                |
| --------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `--repo <owner/repo>` | `rysweet/agent-kgpacks-ts`        | Repository used for discovery or an explicit tag                        |
| `--tag <tag>`         | omitted                           | Selects one static GitHub release and disables discovery                |
| `--base-url <url>`    | omitted                           | Selects a static index/parts directory and overrides repository and tag |
| `--require-signature` | automatic discovery only          | Also requires a trusted signature for an explicitly selected source     |
| `--no-verify`         | off                               | Skips signature verification; SHA-256 integrity checks remain mandatory |
| `--packs-dir <dir>`   | resolved packs-directory location | Global option selecting the installation root                           |

`--require-signature` and `--no-verify` are mutually exclusive. Supplying
both is a usage error with exit code `2`.

`--base-url` takes precedence over `--repo` and `--tag`. An explicit `--tag`
or `--base-url` bypasses discovery. Static selection does not query GitHub
release metadata or apply the draft, prerelease, tag-shape, or asset-presence
filters described below; the selected index and extracted pack still undergo
signature, integrity, identity, and schema validation. When neither is supplied, `pullPack`
exhaustively fetches and parses every release-discovery page before choosing
the highest eligible immutable version. It falls back to the legacy
`packs` tag only after that complete discovery succeeds and produces no
eligible immutable releases. A network, HTTP, pagination, or response-parsing
error fails the operation rather than triggering fallback.

Automatic fallback retains the automatic source's signature policy. Its
release index requires a trusted signature unless the caller explicitly
uses `--no-verify`; selecting `packs` as a fallback will not weaken
authenticity. Download or signature errors from the fallback are reported
and do not trigger another source.

The global packs-directory option works in either Commander form:

```bash
wikigr --packs-dir /srv/kgpacks pack pull cve
wikigr --packs-dir=/srv/kgpacks pack validate cve
```

See [packs directory resolution](../packs-directory.md) for the environment
variable and default location.

## Stable release discovery

An automatically discovered release is eligible only when all of these
conditions hold:

| Condition                | Required value                                                     |
| ------------------------ | ------------------------------------------------------------------ |
| GitHub draft marker      | `draft !== true`                                                   |
| GitHub prerelease marker | `prerelease !== true`                                              |
| Tag                      | Supported immutable tag for the requested pack                     |
| Derived version          | Valid stable SemVer with no prerelease component                   |
| Assets                   | `<name>.pack-release.json` exists                                  |
| Signature                | `<name>.pack-release.json.sig` exists when signatures are required |

A stable-looking tag does not make a GitHub release with `prerelease: true`
eligible. A missing `prerelease` property is treated as not marked
prerelease for compatibility with older API fixtures.

Supported immutable tags are `<name>-v<semver>` and the dated forms
documented in [pack release versioning](../pack-versioning.md). The mutable
`packs` tag is never an automatic discovery candidate; it is considered
only by the fallback rule above.

Discovery requests 100 releases per page and continues until GitHub returns
fewer than 100. API order never determines the winner. Eligible candidates are
ordered by:

1. SemVer precedence, descending;
2. the complete parsed version string, bytewise descending;
3. the complete tag string, bytewise descending.

The second and third keys make equal-precedence forms, including build metadata
variants, deterministic.

## Release-index integrity

The release index lists the archive parts in assembly order:

```json
{
  "name": "cve",
  "version": "2026.7.0",
  "format": "tar.gz-multipart-v1",
  "sha256": "f3a1c7f596f8d43d0a47d5fd75af765849ccca1f957d303bc29f50b70f70f44b",
  "totalBytes": 4084862976,
  "parts": [
    {
      "file": "cve.tar.gz.000",
      "bytes": 1992294400,
      "sha256": "4b38a4ca33ec18e3a10e003f93fa9f1dd5f58a26a3e21b1dc4ed2abf9844ca01"
    },
    {
      "file": "cve.tar.gz.001",
      "bytes": 2092568576,
      "sha256": "caa5dd5f9928a9eb29e63af3b7d4baf6bd8e874b02670261fdc5b97f20da9316"
    }
  ]
}
```

The index format, SemVer version, SHA-256 values, byte counts, optional fixed
part size, and aggregate `totalBytes` accounting must all be valid. Part names
must pass the release-index filename syntax check, must not be `.` or `..`, and
must be unique. The complete index is validated before the first part request,
so no duplicate can overwrite or reuse a scratch path.
Duplicate identity is the exact, case-sensitive ASCII `part.file` value after
that syntax check. Names are not case-folded or URL-decoded.

Resource limits reject release indexes above 1 MiB, detached signatures above
4 KiB, and declared compressed archives above 32 GiB. The streaming installer
also rejects more than 32 GiB of extracted file data. Each part download is
stopped as soon as its received bytes exceed the index declaration.

Installation uses this sequence:

1. Validate the index, including duplicate part names, before downloading or
   installing anything.
2. Download each part to scratch storage and close the output file.
3. Re-read the finalized scratch files in declared order and stream those exact
   bytes toward an isolated staging directory while calculating every part's
   byte size and SHA-256 and the concatenated archive SHA-256.
4. Withhold the archive's final chunk until every declared size and checksum
   passes. A mismatch terminates installation and removes staging, so no
   unverified archive can be committed.
5. Before atomic rename, require the extracted manifest identity to match the
   release index. For schema-v2 packs, verify every payload in `manifest.files`
   against its declared size and SHA-256.
6. Atomically rename staging into the installed destination only after every
   check succeeds.

The schema-v2 directory contract lists exactly `pack.db` in
`manifest.files`. `manifest.json` is excluded to avoid a self-referential
checksum; its bytes are protected by the verified archive. Legacy manifests
without `files` remain installable and rely on the release-index part and
archive checksums. The declared `pack.db` must be a regular file whose exact
byte count and SHA-256 match its manifest entry.

Any index, size, part checksum, archive checksum, manifest identity, or payload
mismatch raises `PackInstallError`. The CLI exits with code `5`, returns no
success object, removes scratch and staging output, and leaves no newly or
partially installed destination. A destination that existed before the pull is
not replaced or removed.

Failure diagnostics identify the rejected part or contract where applicable,
including duplicate filenames, declared/actual byte counts, part or aggregate
checksum failures, unsupported manifest schemas, release-discovery failures,
and schema-v2 payload failures. The CLI writes signature status to stderr and
reserves stdout for its JSON result.

## Manifest schema dispatch

`wikigr pack validate <pack>` first performs generic structural manifest
validation, then dispatches on the manifest's own `schemaVersion` property
without coercion:

| Own `schemaVersion` value                                    | Validation                                              |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| Property absent                                              | Supported legacy; structural manifest validation        |
| Exact string `"1"`                                           | Supported legacy; structural manifest validation        |
| Exact string `"2"`                                           | Current schema; comprehensive knowledge-pack validation |
| `null`, number, boolean, array, or object                    | Failure, exit code `4`                                  |
| Empty, whitespace-padded, whitespace-only, or unknown string | Failure, exit code `4`                                  |

Generic manifest parsing continues to tolerate unknown fields. That
forward-compatible field behavior does not make unknown schema versions valid.
Unsupported values never invoke schema-v2 validation.

Comprehensive schema-v2 validation reopens `pack.db` read-only and verifies
manifest payloads, durable metadata, graph provenance, counts, relationships,
and indexes. See the
[incremental update validation contract](incremental-update.md#validation-boundaries).

## Programmatic API

The static URL resolver and the discovery/install operation are separate:

```ts
import { pullPack, resolvePackBaseUrl } from '@kgpacks/cli';

// Omitted tags resolve to the legacy static default.
resolvePackBaseUrl({});
// https://github.com/rysweet/agent-kgpacks-ts/releases/download/packs

resolvePackBaseUrl({
  repo: 'rysweet/agent-kgpacks-ts',
  tag: 'cve-v2026.7.0',
});
// https://github.com/rysweet/agent-kgpacks-ts/releases/download/cve-v2026.7.0

resolvePackBaseUrl({ baseUrl: 'http://127.0.0.1:8799///' });
// http://127.0.0.1:8799

const installed = await pullPack({
  name: 'cve',
  packsDir: '/srv/kgpacks',
  repo: 'rysweet/agent-kgpacks-ts',
});
// {
//   name: 'cve',
//   version: '2026.7.0',
//   path: '/srv/kgpacks/cve',
//   parts: 3,
//   bytes: 4084862976,
//   signedBy: 'cve-2025'
// }
```

`resolvePackBaseUrl()` is synchronous and never performs discovery. A supplied
`baseUrl` wins and has trailing slashes removed. Otherwise the resolver uses
`repo ?? DEFAULT_PACK_REPO` and `tag ?? DEFAULT_PACK_TAG`; omitting `tag` does
not throw.

`pullPack()` performs discovery only when both `baseUrl` and `tag` are omitted.
Explicit sources are resolved statically.

### `pullPack(options)`

| Property           | Type                           | Required | Description                                                                  |
| ------------------ | ------------------------------ | -------- | ---------------------------------------------------------------------------- |
| `name`             | `string`                       | Yes      | Pack name and release-index asset prefix                                     |
| `packsDir`         | `string`                       | Yes      | Installation root                                                            |
| `repo`             | `string`                       | No       | `owner/repo`; ignored when `baseUrl` is present                              |
| `tag`              | `string`                       | No       | Static release tag; ignored when `baseUrl` is present                        |
| `baseUrl`          | `string`                       | No       | Static directory containing the index, signature, and parts                  |
| `tmpRoot`          | `string`                       | No       | Scratch-directory root; defaults to the operating-system temporary directory |
| `requireSignature` | `boolean`                      | No       | Require a trusted signature for an explicit source; discovery already does   |
| `noVerify`         | `boolean`                      | No       | Disable signature verification, but not size or SHA-256 validation           |
| `trustedKeys`      | `readonly TrustedSigningKey[]` | No       | Verification-key override                                                    |
| `log`              | `(message: string) => void`    | No       | Signature-status sink; defaults to stderr                                    |

The promise resolves to `PulledPack` with `name`, `version`, installed `path`,
part count, total compressed bytes, and the trusted signing-key ID or `null`.
Every download, discovery, signature, integrity, or installation failure rejects
with `PackInstallError`; it never resolves a partial result.

## Related documentation

- [Pack release versioning and provenance](../pack-versioning.md)
- [Pack signing](../pack-signing.md)
- [Schema-v2 incremental update contract](incremental-update.md)
