#!/usr/bin/env bash
# Build the cloudflare-os:local image on Windows hosts.
#
# Why this exists: the Windows docker CLI (Rancher Desktop / Docker Desktop) packs
# build contexts with file modes that the Linux BuildKit rejects
# ("archive/tar: unknown file mode ?rwxr-xr-x"), and buildx contexts can't be
# resolved from Git Bash. Workaround: send the repo as a tar via stdin
# (`docker import`), then build with a stdin Dockerfile against an empty context.
#
# Usage: bash docker-build-windows.sh   (run from the repo root)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

TARBALL=/tmp/cloudflare-os-src.tar

echo "==> Packing repo source (no .git/node_modules/dist)…"
tar -cf "$TARBALL" \
  --transform='s,^\./,app/,' \
  --exclude=./.git --exclude=./node_modules --exclude=./dist \
  --exclude=./.wrangler --exclude=./.run-local-stamp \
  --exclude='./*.log' --exclude=./buildctx --exclude=./ctx.tar \
  .

echo "==> Importing source as cloudflare-os-src:0…"
docker import - cloudflare-os-src:0 < "$TARBALL"

echo "==> Building cloudflare-os:local (install + frontend build inside container)…"
mkdir -p buildctx
docker build -f - -t cloudflare-os:local ./buildctx <<'EOF'
FROM node:22-bookworm-slim

# procps: wrangler dev spawns `ps -o pid --no-headers --ppid <pid>` to supervise
# child processes; without it the uncaught ENOENT kills wrangler at startup.
# ca-certificates: workerd validates outbound TLS against the OS trust store, not Node's
# bundled one; without this, every outbound HTTPS call (e.g. GitHub Copilot OAuth) fails
# with "unable to get local issuer certificate".
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps ca-certificates \
 && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=cloudflare-os-src:0 /app /app
RUN npm install -g pnpm@11.17.0
WORKDIR /app
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @gadgets/typed-storage build \
 && pnpm --filter @gadgets/workshop-frontend exec vite build
ENV CI=true WRANGLER_SEND_METRICS=false NODE_ENV=development
EXPOSE 8787
CMD ["node", "run-dev-server.js", "--serve-frontend-assets"]
EOF
rmdir buildctx 2>/dev/null || true

echo "==> Done. Start with: docker compose up -d   →   http://localhost:8787"
