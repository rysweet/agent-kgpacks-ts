# `@kgpacks/packs`

The knowledge-pack **metadata and filesystem layer** of the agent-kgpacks
TypeScript port. It reads and writes pack **manifests**, validates them against
the (unchanged) on-disk schema, **installs** `.tar.gz` packs into a local install
root with full **security parity**, and exposes a small **registry** (list / info
/ remove) plus **SemVer 2.0** versioning helpers.

This package ports the upstream Python `wikigr/packs` modules — `manifest.py`
(manifest model **and** validation), `installer.py`, `registry.py`, and
`versioning.py` — to strict TypeScript while preserving their external contracts.
Validation is **not** a separate module here: it lives in `manifest.ts` as
`validateManifest`, the single schema gate the rest of the package calls. Two
external contracts are preserved verbatim:

- The **pack on-disk format and manifest schema are unchanged**; existing
  Python-built packs keep working byte-for-byte (see
  [docs/PLAN.md](../PLAN.md) → _External Contracts_).
- The **security checks are ported deliberately and tested adversarially**:
  `PACK_NAME_RE` is carried over exactly, and archive extraction rejects
  zip-slip / path traversal, absolute paths, and symlink escapes — validating
  every entry **before** any write (see [docs/PLAN.md](../PLAN.md) → _Security
  Parity_).

- **Runtime dependencies:** **none.** The installer uses `node:zlib.gunzipSync`
  plus a hand-written `ustar` tar parser; versioning is a hand-rolled SemVer 2.0
  implementation. The package adds nothing to `package.json` and does not depend
  on `@kgpacks/db` — these are pure metadata / filesystem operations.
- **Module system:** native ESM (NodeNext). Import named exports directly; types
  are re-exported with `export type`.
- **Error model:** synchronous, **throw-on-invalid** — every validation failure
  raises a typed error (Python `raise` parity). There are no silent failures and
  no partial writes.

> **Scope (Phase 1):** read / install / validate / list / remove. Pack
> **creation** (building a new `.tar.gz` from a graph) is Phase 2 and is not part
> of this package's surface. Network install-from-URL (and its SSRF/HTTPS-only
> allow-listing) is also out of Phase-1 scope — `installPack` takes a **local
> archive path** only.

> **Status — intended Phase-1 surface.** This document is the design spec for the
> package: it describes the **target** API and behavior, pinned down by the test
> suite ([Testing](#testing)) as the modules land. Treat the signatures, error
> types, and messages below as the contract to implement against, not yet a record
> of shipped code.

## Installation

`@kgpacks/packs` is an internal workspace package. Consume it from other
`@kgpacks/*` packages via a workspace dependency:

```jsonc
// packages/<consumer>/package.json
{
  "dependencies": {
    "@kgpacks/packs": "workspace:*",
  },
}
```

From the repo root:

```bash
pnpm install
pnpm --filter @kgpacks/packs build
pnpm --filter @kgpacks/packs test
```

## Quick start

```ts
import { installPack, listPacks, packInfo, removePack, loadManifestFromDir } from '@kgpacks/packs';

const installRoot = './packs';

// 1. Install a .tar.gz pack. The archive is validated entry-by-entry before any
//    bytes are written, then atomically moved into place.
const installed = installPack('./downloads/world-history-1.2.0.tar.gz', installRoot);
console.log(installed.name, installed.version); // 'world-history' '1.2.0'
console.log(installed.path); // './packs/world-history'

// 2. List everything currently installed.
for (const pack of listPacks(installRoot)) {
  console.log(`${pack.name}@${pack.version} — ${pack.manifest.description ?? ''}`);
}

// 3. Inspect one pack by name.
const info = packInfo(installRoot, 'world-history');
console.log(info.manifest.graph_stats); // { node_count: 12000, edge_count: 48000 }

// 4. Read a manifest directly off disk.
const manifest = loadManifestFromDir('./packs/world-history');
console.log(manifest.eval_scores); // { recall_at_5: 0.81, faithfulness: 0.92 }

// 5. Remove a pack (the name is re-validated before any filesystem op).
removePack(installRoot, 'world-history');
```

## Concepts

### Pack layout on disk

An installed pack is a **directory** under the install root, named after the
validated `name` field in its manifest:

```
packs/
└── world-history/            # <installRoot>/<manifest.name>
    ├── manifest.json         # MANIFEST_FILENAME — the canonical metadata file
    ├── graph.lbug/           # the LadybugDB pack database (opaque to this package)
    └── ...                   # any additional pack files (skills, assets, etc.)
```

This package treats everything except `manifest.json` as **opaque pack payload**:
it copies/extracts those files faithfully but never parses them. Reading the
graph database itself is the job of [`@kgpacks/db`](./db.md).

### The manifest file

`MANIFEST_FILENAME` is the constant `'manifest.json'`. It lives at the pack root.
Keys are **snake_case**, mirroring the upstream Python dataclass fields verbatim,
so packs written by the Python tooling load unchanged. `load → save` is
**lossless**: unknown keys are preserved across a round-trip, so this package
never strips fields it does not model.

## Manifest API

### Types

```ts
interface GraphStats {
  node_count: number; // non-negative integer
  edge_count: number; // non-negative integer
  [extra: string]: number; // additional numeric graph metrics are preserved
}

interface EvalScores {
  [metric: string]: number; // finite numbers, e.g. recall_at_5, faithfulness
}

interface PackManifest {
  name: string; // required — must match PACK_NAME_RE
  version: string; // required — must be valid SemVer 2.0
  description?: string;
  graph_stats?: GraphStats;
  eval_scores?: EvalScores;
  [extra: string]: unknown; // unknown keys are preserved on load → save
}
```

| Field          | Required | Validated when present                                                   |
| -------------- | -------- | ------------------------------------------------------------------------ |
| `name`         | yes      | matches [`PACK_NAME_RE`](#pack_name_re)                                  |
| `version`      | yes      | valid SemVer 2.0 (see [`isValidSemver`](#isvalidsemverv-string-boolean)) |
| `description`  | no       | string                                                                   |
| `graph_stats`  | no       | `node_count` / `edge_count` are non-negative integers; extras numeric    |
| `eval_scores`  | no       | every value is a finite number                                           |
| _(other keys)_ | no       | passed through untouched (lossless round-trip)                           |

### `PACK_NAME_RE`

```ts
const PACK_NAME_RE: RegExp = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
```

The pack-name pattern, **ported verbatim** from the Python source. A valid name
starts with an alphanumeric character and contains only ASCII letters, digits,
underscores, and hyphens, with a total length of **1–64** characters. The regex
is anchored, linear, and length-bounded, so it is not vulnerable to ReDoS. It is
the single source of truth for name safety and is re-checked by the registry
before any path is constructed.

```ts
PACK_NAME_RE.test('world-history'); // true
PACK_NAME_RE.test('../etc'); // false — '.' is not allowed, no leading separator
PACK_NAME_RE.test(''); // false — must be at least 1 char
PACK_NAME_RE.test('a'.repeat(65)); // false — max 64 chars
```

### `validateManifest(value: unknown): PackManifest`

Validates an arbitrary value against the manifest schema and returns it as a
typed `PackManifest`. **Throws** [`ManifestValidationError`](#class-manifestvalidationerror)
with a descriptive message on any violation:

- missing or non-string `name`, or `name` not matching `PACK_NAME_RE`;
- missing or non-string `version`, or `version` not valid SemVer;
- `graph_stats` present but malformed (`node_count` / `edge_count` missing,
  non-integer, or negative);
- `eval_scores` present but containing a non-finite or non-numeric value.

Dangerous JSON keys (`__proto__`, `constructor`, `prototype`) are never copied
onto the result, guarding against prototype pollution from untrusted manifests.

```ts
import { validateManifest } from '@kgpacks/packs';

const m = validateManifest({
  name: 'world-history',
  version: '1.2.0',
  graph_stats: { node_count: 12000, edge_count: 48000 },
});
// m is typed PackManifest

validateManifest({ name: '../evil', version: '1.0.0' });
// throws ManifestValidationError: invalid pack name "../evil" (must match PACK_NAME_RE)
```

### `loadManifest(manifestPath: string): PackManifest`

Reads a manifest file, `JSON.parse`s it, and runs `validateManifest`. `manifestPath`
points directly at the `manifest.json` file. Throws `ManifestValidationError` if
the file is missing, is not valid JSON, or fails validation.

### `loadManifestFromDir(packDir: string): PackManifest`

Convenience wrapper that loads `join(packDir, MANIFEST_FILENAME)`. Use this when
you have a pack directory rather than a manifest path.

```ts
const manifest = loadManifestFromDir('./packs/world-history');
```

### `saveManifest(manifestPath: string, manifest: PackManifest): void`

**Validates first, then writes.** Serializes the manifest with 2-space
indentation and a trailing newline. If validation fails, the function throws and
**no file is written** (no partial/corrupt manifest is left behind). Unknown keys
present on the manifest object are serialized as-is, preserving the lossless
round-trip.

```ts
import { loadManifestFromDir, saveManifest } from '@kgpacks/packs';

const m = loadManifestFromDir('./packs/world-history');
m.description = 'World history knowledge pack';
saveManifest('./packs/world-history/manifest.json', m);
```

### `MANIFEST_FILENAME`

```ts
const MANIFEST_FILENAME = 'manifest.json';
```

The canonical manifest filename, exported for callers that build pack paths.

## Versioning API

A self-contained SemVer 2.0 implementation (no `semver` dependency). Build
metadata is parsed and preserved but **ignored for precedence**, per the spec.
Range matching / `maxSatisfying` is intentionally **out of scope** for Phase 1.

```ts
interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[]; // dot-separated identifiers, e.g. ['rc', '1']
  build: string[]; // dot-separated build metadata (ignored for ordering)
}
```

### `parseVersion(v: string): ParsedVersion`

Parses a SemVer 2.0 string into its components. **Throws** `ManifestValidationError`
on an invalid version.

```ts
parseVersion('1.4.2-rc.1+build.9');
// { major: 1, minor: 4, patch: 2, prerelease: ['rc', '1'], build: ['build', '9'] }
```

### `isValidSemver(v: string): boolean`

Returns `true` if `v` is a valid SemVer 2.0 string, `false` otherwise. This is the
predicate used by `validateManifest` for the `version` field.

```ts
isValidSemver('1.0.0'); // true
isValidSemver('1.0'); // false
isValidSemver('1.0.0-rc.1'); // true
isValidSemver('v1.0.0'); // false — no leading 'v'
```

### `compareVersions(a: string, b: string): -1 | 0 | 1`

Compares two versions by full SemVer precedence:

1. numeric compare of `major`, then `minor`, then `patch`;
2. a version **with** a prerelease is **lower** than the same version without one;
3. prerelease identifiers are compared left-to-right — numeric identifiers
   numerically, alphanumeric identifiers lexically, numeric < alphanumeric, and a
   longer set of identifiers wins when all preceding ones are equal;
4. **build metadata is ignored.**

Returns `-1` if `a < b`, `0` if equal in precedence, `1` if `a > b`.

```ts
compareVersions('1.0.0', '2.0.0'); // -1
compareVersions('1.0.0-rc.1', '1.0.0'); // -1  (prerelease < release)
compareVersions('1.0.0-alpha', '1.0.0-beta'); // -1
compareVersions('1.0.0+build.1', '1.0.0+build.2'); // 0  (build ignored)
```

### `sortVersions(versions: string[]): string[]`

Returns a new array sorted **ascending** by `compareVersions`. The input is not
mutated. Throws if any element is not a valid version.

```ts
sortVersions(['1.2.0', '1.0.0', '1.1.0-rc.1', '1.1.0']);
// ['1.0.0', '1.1.0-rc.1', '1.1.0', '1.2.0']
```

### `latestVersion(versions: string[]): string | undefined`

Returns the highest-precedence version, or `undefined` for an empty array. Throws
if any element is invalid.

```ts
latestVersion(['1.0.0', '1.2.0', '1.1.0']); // '1.2.0'
latestVersion([]); // undefined
```

## Installer API

### `installPack(archivePath: string, installRoot: string): InstalledPack`

Installs a local `.tar.gz` pack into `installRoot`. Returns an
[`InstalledPack`](#installedpack) describing the result.

```ts
interface InstalledPack {
  name: string; // validated pack name (== install directory name)
  version: string; // pack version from the manifest
  path: string; // the pack directory == join(installRoot, name) (relative iff installRoot is)
  manifest: PackManifest; // the validated manifest
}
```

| Parameter     | Type     | Description                                           |
| ------------- | -------- | ----------------------------------------------------- |
| `archivePath` | `string` | Path to a local `.tar.gz` archive (no network fetch). |
| `installRoot` | `string` | Directory under which the pack directory is created.  |

#### Extraction algorithm (validate-before-write)

1. **Gunzip** the archive in memory with `zlib.gunzipSync`.
2. **Parse** all `ustar` 512-byte blocks into typed entries — bytes only, nothing
   is written yet.
3. **Validate every entry** against the [security rules](#security-model) below.
   If any entry is rejected, the whole install **aborts** and nothing persists.
4. **Stage**: extract the validated regular files and directories into a fresh
   staging directory **inside** `installRoot` (`.staging-<random hex>`).
5. **Validate the contained manifest** — `manifest.json` must exist and pass
   `validateManifest`. A missing or invalid embedded manifest raises
   [`ManifestValidationError`](#class-manifestvalidationerror); the staging
   directory is still removed (step 7), so nothing persists.
6. **Commit**: atomically `rename` the staging directory to
   `installRoot/<validated manifest.name>`.
7. On **any** error in steps 1–6, the staging directory is removed
   (`rm -rf`) so the filesystem is left exactly as it was — **no partial pack**.

> **Atomicity & containment.** Because staging happens inside `installRoot` and
> the final move is a single `rename`, a failed install never leaves a
> half-written pack, and a successful one appears all-at-once. Nothing is ever
> written outside `installRoot`.

```ts
const result = installPack('./downloads/world-history-1.2.0.tar.gz', './packs');
// result.path === './packs/world-history'
```

If a pack with the same name is already installed, `installPack` throws a
[`PackInstallError`](#class-packinstallerror) rather than silently overwriting —
remove the existing pack first with [`removePack`](#removepackinstallroot-string-name-string-void).

**Errors.** `installPack` raises [`PackInstallError`](#class-packinstallerror) when
the archive cannot be gunzipped/parsed, when any entry fails a
[security check](#security-model), or when a pack with the same name already
exists; it raises [`ManifestValidationError`](#class-manifestvalidationerror) when
the archive's embedded `manifest.json` is missing or fails validation. A bad
manifest is reported as a **manifest fault** (its own error type), not wrapped in
`PackInstallError`. In every failure mode the staging directory is removed and no
pack is installed.

### `installPackFromStream(source: Readable, installRoot: string, options?): Promise<InstalledPack>`

A **streaming** installer with the same security model and result as
`installPack`, for packs too large to buffer whole. It reads a gzipped-tar byte
stream (e.g. a file read stream, or the concatenation of downloaded multi-part
release assets) and never holds more than one decoded chunk plus a partial
512-byte block in memory, so multi-GB packs (the full CVE pack is ~6–7 GiB)
install with bounded memory.

```ts
import { createReadStream } from 'node:fs';
import { installPackFromStream } from '@kgpacks/packs';

const result = await installPackFromStream(createReadStream('./cve.tar.gz'), './packs');
```

Each tar entry's header is validated **before** any of its bytes are written
(same traversal / absolute-path / symlink / device rejections as the buffer
path), and a containment check guarantees nothing is written outside the staging
directory; the pack is committed with a single atomic rename once its manifest is
read. `options.maxTotalBytes` caps the total uncompressed size (default 32 GiB).
The size field decoder accepts both classic octal and GNU base-256 encodings, so
individual files larger than 8 GiB round-trip correctly. Gzip/tar stream faults
surface as [`PackInstallError`](#class-packinstallerror); a missing or invalid
embedded manifest surfaces as
[`ManifestValidationError`](#class-manifestvalidationerror). This is the path
`wikigr pack pull` uses to install multi-part release artifacts.

## Registry API

Operations over an install root containing zero or more installed packs.

### `listPacks(installRoot: string): InstalledPack[]`

Scans the immediate subdirectories of `installRoot`, loads and validates each
`manifest.json`, and returns one [`InstalledPack`](#installedpack) per valid pack.
Directories without a valid manifest are **skipped** (not thrown on), so an
install root containing unrelated files lists cleanly. Returns `[]` if the root
does not exist or contains no packs.

```ts
const packs = listPacks('./packs');
// [{ name: 'world-history', version: '1.2.0', path: './packs/world-history', manifest: {…} }, …]
```

### `packInfo(installRoot: string, name: string): InstalledPack`

Returns the [`InstalledPack`](#installedpack) for a single pack. The `name` is
**re-validated against `PACK_NAME_RE` before any path is built**, so a malicious
name can never be used to traverse out of `installRoot`. Throws
[`PackNotFoundError`](#class-packnotfounderror) if no such pack is installed, and
`ManifestValidationError` if `name` is not a valid pack name.

```ts
const info = packInfo('./packs', 'world-history');
console.log(info.version, info.manifest.graph_stats);
```

### `removePack(installRoot: string, name: string): void`

Validates `name` against `PACK_NAME_RE` **before any filesystem operation**
(preventing `../`-style path injection), confirms the pack directory exists, then
removes it with `rmSync(join(installRoot, name), { recursive: true, force: true })`.
The existence check is explicit: `force: true` would otherwise silently ignore a
missing path, so a non-existent pack must raise `PackNotFoundError` rather than
no-op. Throws `ManifestValidationError` if `name` is invalid.

```ts
removePack('./packs', 'world-history');
removePack('./packs', '../../etc'); // throws ManifestValidationError — never touches the path
```

## Security model

Archive extraction is the highest-risk surface in this package, so the rules are
**ported deliberately and covered by adversarial negative tests** (see
[Testing](#testing)). Every rule is enforced **before any byte is written**.

| Threat                                  | Control                                                                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zip-slip / tar path traversal**       | Reject any entry whose path contains a `..` segment, **and** verify that `resolve(target, entry)` stays inside `target` (containment check).       |
| **Absolute-path overwrite**             | Reject entry names beginning with `/`, or with a Windows drive (`C:\`) / UNC (`\\`) prefix.                                                        |
| **Symlink / hardlink / device escape**  | Allow **only** regular-file and directory tar typeflags (`'0'` / `'\0'` and `'5'`). Reject symlink, hardlink, char/block-device, and FIFO entries. |
| **Decompression bomb**                  | Cap total uncompressed bytes and entry count; reject an entry whose declared size exceeds the remaining budget.                                    |
| **Prototype pollution (manifest JSON)** | After `JSON.parse`, never copy `__proto__` / `constructor` / `prototype` onto the validated manifest.                                              |
| **Registry path injection**             | Re-validate `name` against `PACK_NAME_RE` **before** any `join` / `rmSync` in `packInfo` / `removePack`.                                           |
| **Non-atomic / partial writes**         | Stage inside `installRoot`, commit with a single `rename`, `rm -rf` staging on any error — nothing escapes the target, no partial pack remains.    |
| **ReDoS on pack names**                 | `PACK_NAME_RE` is anchored, linear, and bounded to 64 characters.                                                                                  |

Because the installer never creates links of any kind, there is no code path that
could materialize a symlink escape — rejected link entries simply abort the
install. Extracted files are written with conservative modes (`0o644` for files,
`0o755` for directories); the installer never escalates privileges and writes only
under `installRoot`.

> **Out of Phase-1 scope (documented).** Install-from-URL with HTTPS-only /
> host allow-listing (SSRF defense) and pack signature / provenance verification
> are not implemented here — `installPack` accepts a **local path** only. These
> land with the network and publishing surfaces in a later phase.

## Errors

All errors extend a common base so callers can catch the whole family or
discriminate by type. Every error carries a descriptive message.

```ts
class PacksError extends Error {} // base for all errors from this package
class ManifestValidationError extends PacksError {} // bad manifest / name / version
class PackInstallError extends PacksError {} // archive parse/validate/extract failure
class PackNotFoundError extends PacksError {} // info/remove on a non-existent pack
```

### `class PacksError`

Base class for every error thrown by `@kgpacks/packs`. Catch this to handle any
failure from the package.

### `class ManifestValidationError`

Thrown by manifest and versioning validation (`validateManifest`, `loadManifest`,
`saveManifest`, `parseVersion`, `sortVersions`, `latestVersion`), by `installPack`
when an archive's embedded `manifest.json` is missing or invalid, and by registry
name re-validation. Indicates the input did not satisfy the schema, the name
pattern, or SemVer.

### `class PackInstallError`

Thrown by `installPack` when the archive cannot be decompressed/parsed, an entry
fails a security check, or a pack with the same name already exists. A malformed
**embedded manifest** surfaces as
[`ManifestValidationError`](#class-manifestvalidationerror) instead — it is a
manifest fault, not an archive fault.

### `class PackNotFoundError`

Thrown by `packInfo` and `removePack` when the named pack is not present under the
install root.

```ts
import { installPack, PackInstallError, ManifestValidationError } from '@kgpacks/packs';

try {
  installPack('./downloads/suspicious.tar.gz', './packs');
} catch (err) {
  if (err instanceof PackInstallError) {
    console.error('Refused to install pack:', err.message);
  } else if (err instanceof ManifestValidationError) {
    console.error('Pack manifest is invalid:', err.message);
  } else {
    throw err;
  }
}
```

## Tutorial: install, inspect, upgrade, remove

A complete lifecycle using the public API. This is the flow the
`pack {install,list,info,remove}` CLI subcommands build on (see
[docs/PLAN.md](../PLAN.md)).

```ts
import {
  installPack,
  listPacks,
  packInfo,
  removePack,
  latestVersion,
  compareVersions,
} from '@kgpacks/packs';

const root = './packs';

// 1. Install two versions of the same pack family from local archives.
installPack('./downloads/world-history-1.1.0.tar.gz', root);

// 2. List what's installed.
console.log(listPacks(root).map((p) => `${p.name}@${p.version}`));
// ['world-history@1.1.0']

// 3. Decide whether an available archive is newer than what's installed.
const installed = packInfo(root, 'world-history').version; // '1.1.0'
const available = '1.2.0';
if (compareVersions(available, installed) === 1) {
  // 4. Upgrade: remove the old pack, then install the newer archive.
  removePack(root, 'world-history');
  installPack('./downloads/world-history-1.2.0.tar.gz', root);
}

// 5. Confirm the upgrade.
console.log(packInfo(root, 'world-history').version); // '1.2.0'

// 6. Pick the newest of a set of candidate versions.
console.log(latestVersion(['1.0.0', '1.2.0', '1.1.0-rc.1'])); // '1.2.0'
```

## Configuration

There is nothing to configure: the package has **no environment variables, no
config files, and no runtime dependencies**. Behavior is determined entirely by
the arguments you pass (`archivePath`, `installRoot`, `name`, manifest objects).

The `package.json` and `tsconfig.json` are the workspace-standard skeleton — no
dependencies, `outDir: dist`, `rootDir: src`, extending the shared base — and the
package exposes the usual scripts:

```bash
pnpm --filter @kgpacks/packs build      # tsc -p tsconfig.json
pnpm --filter @kgpacks/packs typecheck  # tsc --noEmit
pnpm --filter @kgpacks/packs test       # vitest run --passWithNoTests
```

## Testing

Tests live under `packages/packs/test/` and run with vitest, importing the public
surface from `../src/index.js`. They are part of `pnpm -r test` and CI.

| Suite                | Covers                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.test.ts`   | valid manifest accepted; rejects bad name, invalid semver, malformed `graph_stats` / `eval_scores`; lossless round-trip; `saveManifest` output is byte-exact (2-space indent + trailing newline). |
| `versioning.test.ts` | `parseVersion` / `compareVersions` / `sortVersions` / `latestVersion`, including prerelease precedence and invalid input.                                                                         |
| `installer.test.ts`  | benign `.tar.gz` extracts with correct layout; **negatives** for `../` traversal, absolute `/etc/...`, and symlink escape.                                                                        |
| `registry.test.ts`   | `listPacks` / `packInfo` / `removePack` on a populated root; remove/info reject malicious names.                                                                                                  |

Archive fixtures — both benign and malicious — are **built programmatically
in-test** by a tiny `ustar` writer, so there are no committed binaries to audit
and the malicious cases are fully reviewable in source. Each security negative
asserts **both** that the call throws **and** that no escaping/sibling path was
created on disk. Tests use `mkdtempSync` + `rmSync(..., { recursive: true, force:
true })` for isolated, self-cleaning temp directories.

## Troubleshooting

| Symptom                                                         | Likely cause                                                           | Fix                                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `installPack` throws `PackInstallError: rejected unsafe entry…` | The archive contains a traversal, absolute, symlink, or device entry.  | Expected — the pack is malformed or malicious; do not install it.                      |
| `installPack` throws `PackInstallError: pack already installed` | A pack with the same `name` already exists under `installRoot`.        | `removePack(installRoot, name)` first, or install into a different root.               |
| `installPack` throws `ManifestValidationError`                  | The archive's embedded `manifest.json` is missing or fails validation. | Rebuild the pack with a valid manifest; the discarded staging dir left nothing behind. |
| `ManifestValidationError: invalid pack name`                    | `name` violates `PACK_NAME_RE` (bad char, empty, or > 64 chars).       | Use a name matching `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`.                                |
| `ManifestValidationError: invalid version`                      | `version` is not valid SemVer 2.0.                                     | Use `MAJOR.MINOR.PATCH` (with optional `-prerelease` / `+build`).                      |
| `PackNotFoundError`                                             | `packInfo` / `removePack` was called for a pack that isn't installed.  | Check `listPacks(installRoot)` for the available names first.                          |
| `ERR_MODULE_NOT_FOUND` for a local import                       | Missing `.js` extension on a relative import under NodeNext.           | Import compiled paths, e.g. `'../src/index.js'`.                                       |

## See also

- [docs/packages/db.md](./db.md) — reading the pack's graph database once it's
  installed.
- [docs/monorepo.md](../monorepo.md) — workspace layout, scripts, configuration,
  and CI.
- [docs/PLAN.md](../PLAN.md) — the port plan, External Contracts (unchanged
  manifest schema), and the Security Parity requirements this package satisfies.
