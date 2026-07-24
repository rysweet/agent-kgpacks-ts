---
title: Pack pull and validation contract
description: Source resolution, release discovery, integrity, schema dispatch, and API behavior for pack management
last_updated: 2026-07-24
review_schedule: as-needed
owner: kgpacks-maintainers
doc_type: reference
---

# Pack pull and validation

`wikigr pack pull` installs release artifacts and `wikigr pack validate`
selects the validation contract declared by an installed manifest. Both
commands fail closed when integrity or schema identity is ambiguous.

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

`--base-url` takes precedence over `--repo` and `--tag`. An explicit `--tag`
or `--base-url` bypasses discovery. When neither is supplied, `pullPack`
exhaustively fetches and parses every release-discovery page before choosing
the highest eligible immutable version. It falls back to the legacy
`packs` tag only after that complete discovery succeeds and produces zero
eligible immutable releases. A network, HTTP, pagination, or response-parsing
error fails the operation rather than triggering fallback.

Automatic fallback retains the automatic source's signature policy. Its
release index requires a trusted signature unless the caller explicitly
uses `--no-verify`; selecting `packs` as a fallback will not weaken
authentication. Download or signature errors from the fallback are reported
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

Part names must pass the release-index filename syntax check and be unique.
Duplicate identity is the exact, case-sensitive ASCII `part.file` value after
that syntax check. Names are not case-folded or URL-decoded.

Installation uses this sequence:

1. Validate the index, including duplicate part names, before downloading or
   installing anything.
2. Download each part to scratch storage and close the output file.
3. Re-read the finalized scratch files in declared order. Verify every file's
   byte size and SHA-256, and verify the SHA-256 of their concatenation.
4. Install the archive from the same finalized files after those checks pass.
5. For schema-v2 packs, verify every payload in `manifest.files` against its
   declared size and SHA-256 after installation. A mismatch removes the
   destination before returning an error.

The schema-v2 directory contract lists exactly `pack.db` in
`manifest.files`. `manifest.json` is excluded to avoid a self-referential
checksum; its bytes are protected by the verified archive. Legacy manifests
without `files` remain installable and rely on the release-index part and
archive checksums.

Any size, part checksum, archive checksum, or manifest payload mismatch raises
`PackInstallError`. The CLI exits with code `5`, returns no success
object, and leave no installed destination.

## Manifest schema dispatch

`wikigr pack validate <pack>` first performs generic structural manifest
validation, then dispatch by the exact JSON value of `schemaVersion`:

| `schemaVersion` value         | Validation                                              |
| ----------------------------- | ------------------------------------------------------- |
| Property absent               | Supported legacy; structural manifest validation        |
| String `"1"`                  | Supported legacy; structural manifest validation        |
| String `"2"`                  | Current schema; comprehensive knowledge-pack validation |
| `null`                        | Failure, exit code `4`                                  |
| Number `1` or `2`             | Failure, exit code `4`                                  |
| Any other string or JSON type | Failure, exit code `4`                                  |

Generic manifest parsing continues to tolerate unknown fields. That
forward-compatible field behavior does not make unknown schema versions valid.

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
```

`resolvePackBaseUrl()` is synchronous and never performs discovery. A supplied
`baseUrl` wins and has trailing slashes removed. Otherwise the resolver uses
`repo ?? DEFAULT_PACK_REPO` and `tag ?? DEFAULT_PACK_TAG`; omitting `tag` does
not throw.

`pullPack()` performs discovery only when both `baseUrl` and `tag` are omitted.
Explicit sources are resolved statically.

## Related documentation

- [Pack release versioning and provenance](../pack-versioning.md)
- [Pack signing](../pack-signing.md)
- [Schema-v2 incremental update contract](incremental-update.md)
