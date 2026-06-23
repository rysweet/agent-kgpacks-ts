# Multi-stage production build for the @kgpacks/backend HTTP API server.
#
# The GLIBC base (Debian bookworm-slim) is REQUIRED. @ladybugdb/core ships its
# native binding as platform-specific prebuilt packages for glibc linux-x64 /
# linux-arm64 only. A libc-light base image (e.g. node:22-*) has no matching
# prebuilt, so the install would fall back to a from-source native build that
# drags in a C/C++ toolchain and an interpreter the image must never contain.
# See docs/deployment.md for the full rationale and pinning notes.

# ---- base: pnpm-enabled GLIBC toolbox shared by build and runtime ------------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ---- build: install the workspace, build it, prune to the backend closure ----
FROM base AS build

# Copy the full workspace. The .dockerignore keeps the context lean and free of
# node_modules, build output, tests, secrets, and local tooling state.
COPY . .

# Reproducible install from the committed lockfile. @ladybugdb/core's install
# step (allow-listed in .npmrc) selects and links the prebuilt linux-x64 binding;
# nothing is compiled from source.
RUN pnpm install --frozen-lockfile

# Build every workspace package (tsc -b) so each package's dist/ exists before
# the prune below copies it into the deployment closure.
RUN pnpm -r build

# Prune to a self-contained production closure for the backend only: workspace
# dependencies are inlined and devDependencies are dropped.
RUN pnpm deploy --filter=@kgpacks/backend --prod /app/deploy

# Fail the build early if the prebuilt native binding did not survive the prune.
# @ladybugdb/core is a direct dependency of @kgpacks/db, so resolve it from that
# package's directory (the same chain the backend uses at runtime).
RUN cd /app/deploy/node_modules/@kgpacks/db \
  && node -e "require('@ladybugdb/core'); console.log('LadybugDB native binding loaded OK')"

# ---- runtime: minimal, non-root GLIBC image that serves the backend ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    WIKIGR_HOST=0.0.0.0 \
    WIKIGR_PORT=8000

# Persistent pack-database mount point, owned by the non-root runtime user so the
# server can open and lock the database file under a read-only root filesystem.
RUN mkdir -p /data && chown node:node /data

WORKDIR /app
COPY --from=build --chown=node:node /app/deploy ./

USER node
EXPOSE 8000
VOLUME ["/data"]
CMD ["node", "dist/index.js"]
