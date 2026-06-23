# @kgpacks/packs

Knowledge-pack **manifest model & validation, installer, registry, and versioning**
for the agent-kgpacks TypeScript port. Reads, validates, installs, and manages
the on-disk `.tar.gz` knowledge packs produced by the upstream Python pipeline —
with **byte-compatible** manifests and **security parity** for archive
extraction (zip-slip, absolute-path, and symlink-escape rejection).

- **Zero runtime dependencies.** Implemented entirely with Node built-ins
  (`node:zlib` for gunzip, a hand-written `ustar` tar parser, and a hand-rolled
  SemVer 2.0 implementation). No `tar`, no `semver` — keeping the package in line
  with the workspace's "no third-party runtime deps outside `@kgpacks/db`"
  invariant.
- **Strict ESM (NodeNext).** Native ES modules; relative imports use `.js`
  extensions; types are exported with `export type`.
- **Synchronous, throw-on-invalid API** mirroring the Python `raise` semantics it
  ports (`manifest.py` — including its validation — plus `installer.py`,
  `registry.py`, and `versioning.py`). There is no separate `validator` module:
  validation lives in `manifest.ts` as `validateManifest`.

See [docs/packages/packs.md](../../docs/packages/packs.md) for the full API
reference, security model, and tutorials, [docs/monorepo.md](../../docs/monorepo.md)
for the workspace layout and conventions, and [docs/PLAN.md](../../docs/PLAN.md)
for the port plan.
