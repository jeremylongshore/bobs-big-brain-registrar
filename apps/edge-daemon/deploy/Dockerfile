# Multi-stage Dockerfile for apps/edge-daemon.
#
# Build context: repo root  (docker build -f apps/edge-daemon/deploy/Dockerfile .)
#
# Stage 1 (builder) — installs the full monorepo dev tree, builds every
#   workspace package that edge-daemon depends on, then prunes to the minimal
#   production dependency set.
#
# Stage 2 (runtime) — copies only what node needs to run.  Runs as a
#   dedicated non-root user.  No build toolchain present in the final image.

# ---- Stage 1: builder -------------------------------------------------------
FROM node:20-alpine AS builder

# pnpm is pinned to match the packageManager field in the root package.json.
ENV PNPM_VERSION=9.15.4

# Install pnpm via corepack (ships with Node 20; no extra network calls).
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Native build toolchain for better-sqlite3 (node-gyp): the alpine base ships
# neither Python nor a C++ compiler, so `pnpm install` fails to compile the
# better-sqlite3 addon ("Could not find any Python installation to use"). Only
# needed in the builder stage; the runtime stage copies the compiled output.
RUN apk add --no-cache python3 make g++

WORKDIR /build

# Copy workspace manifests first so Docker can cache the install layer
# independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./

# Copy all package.json / tsconfig files before source so the dependency
# install layer is cached even when source changes.
COPY apps/api/package.json             apps/api/
COPY apps/curator/package.json         apps/curator/
COPY apps/edge-daemon/package.json     apps/edge-daemon/
COPY apps/git-exporter/package.json    apps/git-exporter/
COPY apps/reporting/package.json       apps/reporting/
COPY packages/schema/package.json      packages/schema/
COPY packages/common/package.json      packages/common/
COPY packages/store/package.json       packages/store/
COPY packages/policy-engine/package.json  packages/policy-engine/
COPY packages/claude-runtime/package.json packages/claude-runtime/
COPY packages/qmd-adapter/package.json    packages/qmd-adapter/
COPY packages/repo-resolver/package.json  packages/repo-resolver/
COPY packages/test-fixtures/package.json  packages/test-fixtures/

# Install all workspace deps (frozen; fails if lockfile is stale).
RUN pnpm install --frozen-lockfile

# Copy full source.
COPY . .

# Build the edge-daemon and all packages it depends on via workspace references.
# tsc -b resolves project references in the right order automatically.
RUN pnpm --filter @qmd-team-intent-kb/edge-daemon... build

# Prune the install tree to production-only deps so we only copy what the
# runtime image needs.
# `deploy` bundles exactly one project plus its (workspace + external) prod
# deps — so the filter must name the single target WITHOUT the `...`
# dependency-expansion suffix, which selects many projects and trips
# ERR_PNPM_CANNOT_DEPLOY_MANY on pnpm 9.x.
RUN pnpm --filter @qmd-team-intent-kb/edge-daemon --prod deploy /app/deploy


# ---- Stage 2: runtime -------------------------------------------------------
FROM node:20-alpine AS runtime

# Create a non-root user that matches the systemd unit expectation.
RUN addgroup -S edge-daemon && adduser -S -G edge-daemon edge-daemon

WORKDIR /app

# Copy the pruned deployment tree from the builder stage.
COPY --from=builder /app/deploy/node_modules ./node_modules
COPY --from=builder /build/apps/edge-daemon/dist ./apps/edge-daemon/dist
# Workspace packages are bundled into node_modules by pnpm deploy; no extra
# copy needed.

# Default environment — all of these can be overridden at runtime via
# --env / --env-file / Kubernetes configmap+secret.
ENV NODE_ENV=production
ENV DAEMON_TENANT_ID=""
ENV DAEMON_POLL_INTERVAL=10000
ENV DAEMON_MAX_CANDIDATES=100
ENV DAEMON_MAX_SPOOL_SIZE=10485760
ENV DAEMON_ENABLE_EXPORT=true
ENV DAEMON_ENABLE_INDEX=true
ENV DAEMON_ENABLE_STALENESS=true
ENV DAEMON_STALE_DAYS=90
ENV DAEMON_SPOOL_DIR=/var/lib/edge-daemon/spool
ENV DAEMON_EXPORT_DIR=/var/lib/edge-daemon/kb-export
ENV DAEMON_PID_FILE=/var/lib/edge-daemon/daemon.pid
# Inside a container the health server must bind to 0.0.0.0 so external
# liveness/readiness probes can reach it.  The default outside Docker is
# 127.0.0.1 (loopback-only).  Override at runtime if you need a different
# interface (e.g. a specific non-loopback IP).
ENV DAEMON_HEALTH_HOST=0.0.0.0
# Operators should also set DAEMON_HEALTH_PORT to a non-zero value to enable
# the HTTP health endpoint.  Default (0) leaves it disabled.
# EXPOSE documents the conventional port; set DAEMON_HEALTH_PORT to match.
EXPOSE 9100

RUN mkdir -p /var/lib/edge-daemon/spool /var/lib/edge-daemon/kb-export \
    && chown -R edge-daemon:edge-daemon /var/lib/edge-daemon

USER edge-daemon

# DAEMON_TENANT_ID must be supplied by the caller — the daemon will exit(1)
# immediately if it is missing.
CMD ["node", "apps/edge-daemon/dist/main.js", "start"]
