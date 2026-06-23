# Production Deployment (Docker)

This guide describes how to build and run the `@kgpacks/backend` server as a
production container. It covers the multi-stage `Dockerfile`, the
`docker-compose.yml` one-command run, the GLIBC (no-Alpine) base-image
requirement, the environment-variable contract, persistence, the VECTOR/FTS
extension behavior, version pinning, and the CI image-build job.

> Status: **Phase 3 — Infrastructure.** The container packages only the HTTP API
> server (`packages/backend`, exposed as `node dist/index.js`). It is a strict-ESM,
> **Python-free** image: the parity oracle under `parity/oracle` is a
> development-time tool and is never part of the build context or the shipped
> image. See [docs/packages/backend.md](./packages/backend.md) for the API
> surface and [docs/PLAN.md](./PLAN.md) for the full port plan.

## Contents

- [Artifacts](#artifacts)
- [Prerequisites](#prerequisites)
- [Quick start (docker compose)](#quick-start-docker-compose)
- [Building the image directly](#building-the-image-directly)
- [Running the image directly](#running-the-image-directly)
- [Why GLIBC and not Alpine](#why-glibc-and-not-alpine)
- [VECTOR / FTS extensions: first-load behavior](#vector--fts-extensions-first-load-behavior)
- [Configuration (environment variables)](#configuration-environment-variables)
- [Bring-your-own-key (chat)](#bring-your-own-key-chat)
- [Persistence](#persistence)
- [Health check](#health-check)
- [Security posture](#security-posture)
- [Version pinning](#version-pinning)
- [Continuous integration](#continuous-integration)
- [Troubleshooting](#troubleshooting)

## Artifacts

| File                       | Purpose                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`               | Multi-stage (`base` → `build` → `runtime`) build that prunes the workspace to the `@kgpacks/backend` runtime closure. |
| `.dockerignore`            | Keeps the build context minimal, deterministic, and secret-free.                                                      |
| `docker-compose.yml`       | One-command run: builds the image, publishes the port, mounts a persistent pack-database volume, wires env vars.      |
| `.github/workflows/ci.yml` | The `docker-image` job builds the image on every push/PR and asserts the final image is non-root and Python-free.     |

## Prerequisites

| Tool            | Version           | Notes                                                                                               |
| --------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| Docker Engine   | 24+ with BuildKit | BuildKit is the default in modern Docker; `docker compose` v2 is assumed.                           |
| Target platform | `linux/amd64`     | The image links the `@ladybugdb/core-linux-x64` prebuilt binding (see [pinning](#version-pinning)). |
| A pack database | LadybugDB file    | A built knowledge pack (e.g. `kgpacks.db`) placed in the mounted volume. Required to start.         |

> **Architecture.** `@ladybugdb/core` 0.17.1 ships **GLIBC** prebuilt bindings for
> both `linux-x64` and `linux-arm64`, so a native arm64 image is also possible. This
> deployment **pins `linux/amd64`** for a single, reproducible target; the
> `docker-compose.yml` sets `platform: linux/amd64` so compose users get it for free.
> On Apple Silicon, Docker Desktop emulates amd64 via Rosetta/QEMU — or rebuild for
> `linux/arm64` to run natively. There is **no musl/Alpine** prebuilt (see
> [Why GLIBC and not Alpine](#why-glibc-and-not-alpine)).

## Quick start (docker compose)

```bash
# 1. Put a built pack database where the volume expects it (see Persistence).
# 2. Build and start the backend.
docker compose up --build -d

# 3. Verify it is healthy.
curl -fsS http://127.0.0.1:8000/health | jq .
# => { "status": "healthy", "version": "1.0.0", "database": "connected", ... }

# 4. Query the API (read endpoints need no credentials).
curl 'http://127.0.0.1:8000/api/v1/search?query=quantum%20entanglement&limit=5'

# 5. Tear down (the named volume — and your pack DB — persist).
docker compose down
```

By default the service publishes on the **loopback interface only**
(`127.0.0.1:8000`). Front it with a reverse proxy to expose it beyond localhost
— see [Security posture](#security-posture).

## Building the image directly

```bash
docker build --platform=linux/amd64 -t kgpacks-backend:local .
```

The multi-stage build:

1. **`base`** — `FROM node:22-bookworm-slim`, then
   `corepack enable && corepack prepare pnpm@9.15.0 --activate`. Debian
   _bookworm-slim_ is a **GLIBC** base (see
   [Why GLIBC and not Alpine](#why-glibc-and-not-alpine)). No Python, no C/C++
   toolchain is added.
2. **`build`** — copies the workspace, runs `pnpm install --frozen-lockfile`,
   `pnpm -r build`, then prunes to a self-contained runtime closure with
   `pnpm deploy --filter=@kgpacks/backend --prod /app/deploy`. A build-stage smoke
   check (`node -e "require('@ladybugdb/core')"`) **fails the build early** if the
   prebuilt native binding did not survive the prune.
3. **`runtime`** — a fresh slim stage that copies only `/app/deploy`, sets
   `USER node` (non-root), `WORKDIR` at the backend package, `ENV NODE_ENV=production`,
   `EXPOSE 8000`, and `CMD ["node", "dist/index.js"]`. The final stage contains the
   `@ladybugdb/core` binding and its `@ladybugdb/core-linux-x64` prebuilt, and **no
   Python**.

## Running the image directly

The server requires a pack-database path; it **exits non-zero** if
`WIKIGR_DATABASE_PATH` is unset or empty.

```bash
docker run --rm \
  --platform=linux/amd64 \
  -p 127.0.0.1:8000:8000 \
  -v kgpacks-data:/data \
  -e WIKIGR_HOST=0.0.0.0 \
  -e WIKIGR_PORT=8000 \
  -e WIKIGR_DATABASE_PATH=/data/kgpacks.db \
  kgpacks-backend:local
```

> The image sets `WIKIGR_HOST=0.0.0.0` by default so the server is reachable
> _inside_ the container network; host-side exposure is still governed by the
> `-p 127.0.0.1:8000:8000` publish mapping. Binding `0.0.0.0` in the container is
> safe precisely because the published port is loopback-scoped on the host.

## Why GLIBC and not Alpine

The image is built on `node:22-bookworm-slim` (Debian, **GLIBC**) — **not**
`node:22-alpine` (musl).

`@ladybugdb/core` ships its native binding as platform-specific prebuilt
`optionalDependencies` (`@ladybugdb/core-linux-x64`, …). **There is no musl
(Alpine) prebuilt.** On Alpine the install step would find no compatible binary
and the only fallback is a from-source compile — which pulls a C/C++ toolchain
**and Python**, violating the project's Python-free guarantee (and bloating the
image). A GLIBC base lets the install step _select and link_ the existing
`linux-x64` prebuilt with **nothing compiled and no Python introduced**.

> **Do not switch the base image to Alpine.** Doing so silently breaks the native
> binding (or reintroduces Python via a source build). The CI `docker-image` job
> asserts the absence of Python and the presence of a loadable binding to catch
> exactly this regression.

## VECTOR / FTS extensions: first-load behavior

Knowledge packs use LadybugDB's **VECTOR** and **FTS** extensions, loaded via
`INSTALL <name>` / `LOAD EXTENSION <name>`
([`connection.loadExtension`](./packages/db.md#connectionloadextensionname-string-promisevoid)).
In `@ladybugdb/core` 0.17.1 the `vector`/`fts` extensions are **statically bundled**,
so the load **works offline** — nothing is downloaded during `docker build`, and the
common case needs **no runtime egress**. This makes the default deployment
air-gap-friendly out of the box.

> **Verification status (R3).** Whether `INSTALL` is required at all for the bundled
> VECTOR/FTS extensions — and whether the first `INSTALL` of a _non-bundled_ extension
> fetches its binary over HTTPS — is still being confirmed by Spike A (see
> [docs/packages/db.md](./packages/db.md#connectionloadextensionname-string-promisevoid)).
> Treat the egress note below as a contingency for non-bundled extensions, not a
> guaranteed requirement for the bundled VECTOR/FTS path.

Operational implications:

- **Common case (bundled VECTOR/FTS): no egress needed.** Packs open and query
  offline; this is the air-gap-friendly default.
- **If you later adopt a _non-bundled_ extension**, its first `INSTALL` may fetch the
  binary **over HTTPS (443)** and cache it — a one-time, runtime-only cost. Allow
  outbound 443 for that first load, or pre-warm the cache by opening a pack once on a
  host with egress and baking the populated cache into the image or `/data` volume.
- Extension loading **fails closed** (the request rejects with a clear error, and
  `/health` may report `503`) if an extension cannot be obtained, rather than serving
  degraded results.

## Configuration (environment variables)

All settings use the **`WIKIGR_`** prefix and are read from the process
environment by [`loadConfig`](./packages/backend.md#configuration). The
container-relevant variables:

| Variable                    | Type           | Image default / note                           | Description                                                                         |
| --------------------------- | -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `WIKIGR_DATABASE_PATH`      | path           | **required** — compose sets `/data/kgpacks.db` | Path to the LadybugDB pack inside the container. Empty/unset → the server exits.    |
| `WIKIGR_HOST`               | string         | `0.0.0.0` (set in the image)                   | In-container bind address. Host exposure is controlled by the port publish mapping. |
| `WIKIGR_PORT`               | number         | `8000` (set in the image; `EXPOSE 8000`)       | In-container bind port.                                                             |
| `WIKIGR_CORS_ORIGINS`       | CSV            | code default (localhost dev origins)           | Allowed CORS origins. **Set explicitly in production; never `*`.**                  |
| `WIKIGR_RATE_LIMIT_ENABLED` | bool           | `true`                                         | Master switch for per-route rate limiting. Keep enabled when internet-facing.       |
| `WIKIGR_TRUSTED_PROXIES`    | CSV of IP/CIDR | _(empty)_                                      | Reverse-proxy peers from which `X-Forwarded-For` is honored for rate-limit keying.  |
| `WIKIGR_STREAM_TIMEOUT_S`   | number         | `60`                                           | Max seconds the SSE chat route waits for synthesis before emitting a timeout.       |
| `WIKIGR_API_TITLE`          | string         | `WikiGR Visualization API`                     | Reported in `/health` / OpenAPI metadata.                                           |
| `WIKIGR_API_VERSION`        | string         | `1.0.0`                                        | Reported `version`.                                                                 |

Per-route rate limits (`WIKIGR_RATE_LIMIT_CHAT`, `WIKIGR_RATE_LIMIT_SEARCH`, …)
and cache TTLs (`WIKIGR_CACHE_TTL_*`) carry the reference defaults and are
individually overridable; see the full table in
[docs/packages/backend.md](./packages/backend.md#configuration).

## Bring-your-own-key (chat)

The read endpoints (`/api/v1/search`, `/graph`, `/articles/*`, …) work with no
credentials. The **chat** endpoints (`POST /api/v1/chat`,
`GET /api/v1/chat/stream`) require a Copilot/LLM credential. The server starts a
Copilot agent **only** when one of these is present; otherwise chat endpoints
return `503` while every other endpoint serves normally:

| Variable            | Description                       |
| ------------------- | --------------------------------- |
| `COPILOT_API_KEY`   | GitHub Copilot SDK key (primary). |
| `OPENAI_API_KEY`    | Alternative provider key.         |
| `ANTHROPIC_API_KEY` | Alternative provider key.         |

> **Never bake keys into the image.** Do not pass them via `ARG`, `ENV` layers, or
> commit them. Supply them at run time only — through the runtime environment, a
> secrets manager, or a git-ignored `.env` file. `.dockerignore` excludes `.env*`,
> `*.key`, and `*.pem` so credentials never enter a build layer. `docker-compose.yml`
> forwards them with safe `${VAR:-}` pass-through (empty when unset).

## Persistence

The pack database lives on a named Docker volume mounted at **`/data`**:

```yaml
# docker-compose.yml (excerpt)
volumes:
  kgpacks-data:
services:
  backend:
    volumes:
      - kgpacks-data:/data
    environment:
      WIKIGR_DATABASE_PATH: /data/kgpacks.db
```

- Place (or generate) your pack at `/data/kgpacks.db` in the volume. To seed it
  from the host, copy into the volume before first start, e.g.
  `docker run --rm -v kgpacks-data:/data -v "$PWD":/src busybox cp /src/kgpacks.db /data/`.
- The runtime stage pre-creates and `chown`s `/data` to the non-root `node` user so
  the server can open/lock the database file.
- The volume is **unencrypted at rest** — use host-level disk encryption for
  sensitive packs.

## Health check

`GET /health` (unprefixed, never rate-limited, `no-store`) probes database
reachability with a trivial `RETURN 1` query and returns `200` when healthy /
`503` when the database is unreachable. `docker-compose.yml` wires a healthcheck
that uses **Node's built-in `fetch`** (no `curl`/`wget` is installed, keeping the
image minimal):

```yaml
healthcheck:
  test:
    [
      'CMD',
      'node',
      '-e',
      "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    ]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 20s
```

## Security posture

The API is **unauthenticated** (open read API plus BYOK chat). Harden the
deployment accordingly:

- **Loopback by default.** The published port is `127.0.0.1:8000:8000`. To expose
  the service, front it with a reverse proxy (TLS termination, auth) and set
  `WIKIGR_TRUSTED_PROXIES` to the proxy's IP/CIDR so client-IP rate-limit keying
  uses `X-Forwarded-For` correctly.
- **Explicit CORS.** Set `WIKIGR_CORS_ORIGINS` to your real origins; never `*`.
- **Rate limiting on.** Keep `WIKIGR_RATE_LIMIT_ENABLED=true` when internet-facing.
- **Container hardening** (applied in `docker-compose.yml`): non-root `USER node`,
  `read_only: true` root filesystem with a `tmpfs` for `/tmp`, `cap_drop: [ALL]`,
  `security_opt: ["no-new-privileges:true"]`, and conservative CPU/memory limits.
  The `/data` volume remains writable for the database.
- **No secrets in layers.** `.dockerignore` excludes `.git`, `.env*`, `*.pem`,
  `*.key`, and `.claude/`; keys are supplied only at run time.

## Version pinning

| Component         | Pinned value                  | Where                                                             |
| ----------------- | ----------------------------- | ----------------------------------------------------------------- |
| Node.js           | `22` (bookworm-slim, GLIBC)   | `Dockerfile` base image; matches root `engines.node` (`>=22`).    |
| pnpm              | `9.15.0` (exact)              | `corepack prepare pnpm@9.15.0`; matches `packageManager`.         |
| `@ladybugdb/core` | `0.17.1` (exact, storage v41) | `pnpm-lock.yaml`; reads existing Python-built v40 packs directly. |
| Native binding    | `@ladybugdb/core-linux-x64`   | Selected by the `linux/amd64` build; no source compile.           |

Installs use `pnpm install --frozen-lockfile`, so a stale `pnpm-lock.yaml` fails
the build instead of silently drifting. If you rebase this branch onto `main` and
the lockfile diverges, reconcile `pnpm-lock.yaml` (re-run `pnpm install` and
commit the result) so the frozen install passes.

## Continuous integration

`.github/workflows/ci.yml` gains a `docker-image` job (alongside the existing
`build` and `python-free guard` jobs) that runs on every push and pull request to
`main`:

1. **Build** the image with the **runner-bundled `docker build`** (BuildKit, the
   default on `ubuntu-latest`) targeting `linux/amd64` — this catches Dockerfile
   breakage and any prune that drops the native binding. No `docker/setup-buildx-action`
   (or other unpinned action) is added; the only GitHub Action used is the same
   SHA-pinned `actions/checkout` as the other jobs, so the supply-chain pinning that
   the rest of `ci.yml` enforces is preserved.
2. **Assert the binding loads** — runs `node -e "require('@ladybugdb/core')"`
   inside the built image.
3. **Assert no Python** — runs
   `! command -v python && ! command -v python3` inside the image (the
   image-level complement to `scripts/check-no-python.mjs`, which guards the source
   tree). The entrypoint is overridden so the server is not started (which would
   need a database).
4. **Assert non-root** — verifies the runtime user is `node` (non-zero UID).

The existing `build`, typecheck, lint, format, test, and `python-free guard`
checks are unchanged.

## Troubleshooting

| Symptom                                                                                     | Cause / fix                                                                                                    |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Container exits immediately, log: _`WIKIGR_DATABASE_PATH is required to start the server.`_ | No pack path set. Provide `WIKIGR_DATABASE_PATH` pointing at a pack in the mounted volume.                     |
| `/health` returns `503` (`database: disconnected`)                                          | The pack file is missing/unreadable at the configured path, or an extension failed to load.                    |
| Chat endpoints return `503`                                                                 | No BYOK credential present. Set `COPILOT_API_KEY` (or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) at run time.     |
| `Error: ... could not load ... @ladybugdb/core` at startup                                  | Image built for the wrong platform. Rebuild with `--platform=linux/amd64`; do **not** use an Alpine/musl base. |
| First chat/search hangs then errors on a fresh pack                                         | Bundled VECTOR/FTS load offline; only a _non-bundled_ extension's first `INSTALL` needs outbound HTTPS (443).  |
| `ERR_PNPM_OUTDATED_LOCKFILE` during build                                                   | `pnpm-lock.yaml` is stale. Run `pnpm install` locally and commit the updated lockfile.                         |
