#!/bin/sh
# Container entrypoint for the self-hosted Cloudflare OS stack image.
#
# Responsibilities beyond launching the dev server:
#   1. Generate a per-container random K8S_PROXY_TOKEN (shared with the gatekeeper worker
#      via the run-dev-server.js env passthrough) and start the read-only TLS proxy that
#      the gatekeeper-k8s worker uses to reach the k8s API / ArgoCD API.
#   2. The proxy and token only start when the gatekeeper's credentials are present
#      (K8S_READ_TOKEN / K8S_ARGOCD_TOKEN are injected by the k8s Deployment as env).
#
# The proxy is a background child; it dies with the container.

set -e

if [ -n "$K8S_READ_TOKEN" ] || [ -n "$K8S_ARGOCD_TOKEN" ]; then
  if [ -z "$K8S_PROXY_TOKEN" ]; then
    K8S_PROXY_TOKEN=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
    export K8S_PROXY_TOKEN
    echo "entrypoint: generated K8S_PROXY_TOKEN"
  fi
  node /app/scripts/k8s-proxy.mjs &
  echo "entrypoint: k8s proxy started (pid $!)"
fi

exec node run-dev-server.js --serve-frontend-assets
