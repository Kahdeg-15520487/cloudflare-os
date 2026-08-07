# Cloudflare OS — self-hosted stack image.
#
# Built by .github/workflows/build-stack-image.yml and published to
# ghcr.io/kahdeg-15520487/cloudflare-os. The k8s manifests that consume it live in the
# k3s_lab repo (cloudflare-os/), see REPORT.md there for the full hosting analysis.
#
# Runtime: `node run-dev-server.js --serve-frontend-assets` boots ALL workers (router +
# workshop-backend + 16 gatekeepers) as real workerd isolates via `wrangler dev`, serving
# the pre-built frontend as static assets — the supported self-host path until workerd
# stand-alone tooling lands upstream. Data lives under /app/.wrangler (DO SQLite, KV, R2
# emulation): mount a PVC there.

FROM node:24-bookworm-slim

# Shared libraries for the Chrome that miniflare's Browser Run emulation launches (gadget
# PDF export, blueprint screenshots). The browser itself is downloaded at build time below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# The repo pins pnpm via `packageManager`; corepack is deprecated in Node 24, so install it.
RUN npm install -g pnpm@11.17.0

WORKDIR /app
COPY . .

# Frozen install from the committed lockfile. All heavy deps ship prebuilt binaries
# (workerd-linux-64, esbuild, sharp), so no toolchain is needed.
RUN pnpm install --frozen-lockfile

# Pre-build everything the stack needs so pod startup is fast:
#  - @gadgets/typed-storage (the backend imports its built dist)
#  - the frontend bundle (served as static assets in run-local mode)
#  - capnweb-validate outputs for the backend and every gatekeeper
#    (wrangler dev's custom build would otherwise run these at every pod start)
RUN pnpm --filter @gadgets/typed-storage build \
 && pnpm --filter @gadgets/workshop-frontend exec vite build \
 && pnpm --filter @gadgets/workshop-backend run build:worker \
 && for d in packages/gatekeeper-*; do (cd "$d" && pnpm exec capnweb-validate build --out .wrangler/validate); done

# Pre-warm the Chrome used by the Browser Run emulation. Miniflare installs it into
# wrangler's global cache dir (xdg cache for ".wrangler": $XDG_CACHE_HOME/.wrangler),
# NOT PUPPETEER_CACHE_DIR. Resolve @puppeteer/browsers through the installed dependency
# graph (it is miniflare's dep, not hoisted to the root).
ENV XDG_CACHE_HOME=/opt/cfos-cache
RUN node -e '\
    const path = require("path");\
    const os = require("os");\
    // pnpm does not hoist transitive deps: resolve miniflare through wrangler (a root\
    // devDependency), then @puppeteer/browsers through miniflare. Its package.json is\
    // not exported, so resolve the main entry instead.\
    const wr = require.resolve("wrangler/package.json", { paths: ["."] });\
    const mf = require.resolve("miniflare/package.json", { paths: [path.dirname(wr)] });\
    const { install } = require(require.resolve("@puppeteer/browsers", { paths: [path.dirname(mf)] }));\
    const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), ".wrangler");\
    install({ browser: "chrome", buildId: "126.0.6478.182", cacheDir, platform: process.platform })\
      .then(() => console.log("Chrome pre-warmed at", cacheDir))\
      .catch((e) => { console.error(e); process.exit(1); });\
    '

EXPOSE 8787

# WRANGLER_DEV_IP makes the dev router listen on 0.0.0.0 so the cluster Service can reach
# it (wrangler defaults to loopback). Patch carried on the feat/selfhost-k3s branch.
ENV WRANGLER_DEV_IP=0.0.0.0 \
    WRANGLER_SEND_METRICS=false \
    XDG_CACHE_HOME=/opt/cfos-cache

CMD ["node", "run-dev-server.js", "--serve-frontend-assets"]
