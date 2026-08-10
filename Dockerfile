# syntax=docker/dockerfile:1
# Cloudflare OS — local dev container.
# Runs the full stack (wrangler dev / workerd + built frontend) exactly like
# `pnpm run-local` would, but inside Linux where node scripts can spawn pnpm.
FROM node:22-bookworm-slim

# procps: wrangler dev spawns `ps -o pid --no-headers --ppid <pid>` to supervise
# child processes; without it the uncaught ENOENT kills wrangler at startup.
# ca-certificates: workerd validates outbound TLS (e.g. GitHub Copilot's OAuth endpoints)
# against the OS trust store, not Node's bundled one; the slim base ships neither the
# package nor /etc/ssl/certs/ca-certificates.crt, so every outbound HTTPS call fails with
# "unable to get local issuer certificate" until this is installed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps ca-certificates \
 && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV CI=true \
    WRANGLER_SEND_METRICS=false \
    NODE_ENV=development

# pnpm pinned to the version the repo requires (packageManager: pnpm@11.17.0).
# Installed via npm (not corepack) so `/usr/local/bin/pnpm` is a shebang script
# that node's execFileSync() can spawn — corepack's .cmd shim fails on Windows hosts.
RUN npm install -g pnpm@11.17.0

WORKDIR /app

# Copy manifests first so `pnpm install` is cached unless a manifest changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN mkdir -p /app/packages && \
    for p in $(find packages -name package.json 2>/dev/null); do \
      mkdir -p "/app/$(dirname "$p")" && cp "$p" "/app/$p"; \
    done

# Full source (node_modules/dist are excluded via .dockerignore).
COPY . .

# Build what's required to serve: typed-storage (backend import) + frontend bundle.
# The remaining generated artifacts (gatekeeper UIs, format blueprints) are built
# by run-dev-server.js at startup.
RUN pnpm --filter @gadgets/typed-storage build \
 && pnpm --filter @gadgets/workshop-frontend exec vite build

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "run-dev-server.js", "--serve-frontend-assets"]
