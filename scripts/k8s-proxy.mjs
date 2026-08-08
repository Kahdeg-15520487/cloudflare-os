#!/usr/bin/env node
// Read-only TLS-terminating proxy for the K8S gatekeeper (runs in the container, in plain
// Node — NOT inside workerd).
//
// workerd's fetch does not trust the cluster CA, so the gatekeeper worker cannot talk to
// https://kubernetes.default.svc / https://argocd-server.argocd.svc directly. This proxy
// terminates TLS (k8s CA from the service-account dir) and exposes two loopback HTTP
// endpoints the gatekeeper fetches instead.
//
// Security (see plans/gatekeeper-k8s.md §2.2 — mandatory):
//   1. Every request must carry `Authorization: Bearer <K8S_PROXY_TOKEN>` — a per-container
//      random token shared only with the gatekeeper worker via env. Gadget Dynamic Workers
//      in the same workerd process do not know it, so they cannot bypass the gatekeeper.
//   2. Listens on 127.0.0.1 only.
//   3. GET only, and only the API path prefixes the gatekeeper actually uses.
//   4. No request/response bodies are inspected beyond forwarding.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import crypto from "node:crypto";

const TOKEN = process.env.K8S_PROXY_TOKEN;
if (!TOKEN) {
  console.error("k8s-proxy: K8S_PROXY_TOKEN is required.");
  process.exit(1);
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function checkAuth(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  return match !== null && timingSafeEqual(match[1], TOKEN);
}

const K8S_ALLOWED_PREFIXES = ["/api/v1/", "/apis/apps/v1/", "/apis/metrics.k8s.io/"];
const ARGO_ALLOWED_PREFIXES = ["/api/v1/"];

function makeProxy({ port, upstream, ca, insecure, allowedPrefixes, label }) {
  const agent = new https.Agent({
    ...(ca ? { ca } : {}),
    rejectUnauthorized: !insecure,
  });
  http
    .createServer((req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "text/plain" });
        res.end("GET only");
        return;
      }
      if (!checkAuth(req)) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      if (!allowedPrefixes.some(p => req.url.startsWith(p))) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end(`path not allowed: ${req.url}`);
        return;
      }
      const target = new URL(req.url, upstream);
      const upstreamReq = https.request(
          target,
          {
            method: "GET",
            agent,
            headers: {
              // Forward the caller's Authorization (the read SA token) upstream.
              Authorization: req.headers.authorization,
              Accept: req.headers.accept,
            },
          },
          upRes => {
            res.writeHead(upRes.statusCode ?? 502, {
              "content-type": upRes.headers["content-type"],
            });
            upRes.pipe(res);
          },
      );
      upstreamReq.on("error", err => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`upstream error: ${err.message}`);
      });
      upstreamReq.end();
    })
    .listen(port, "127.0.0.1", () => {
      console.log(`k8s-proxy: ${label} on http://127.0.0.1:${port} -> ${upstream}`);
    });
}

const k8sCaFile =
    process.env.K8S_CA_FILE ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
let k8sCa;
try {
  k8sCa = fs.readFileSync(k8sCaFile);
} catch (err) {
  console.error(`k8s-proxy: cannot read k8s CA from ${k8sCaFile}: ${err.message}`);
  process.exit(1);
}

const k8sUpstream = process.env.K8S_API_SERVER ?? "https://kubernetes.default.svc";
const argoUpstream = process.env.ARGOCD_API_SERVER ?? "https://argocd-server.argocd.svc";

// ArgoCD's TLS cert is self-signed by its own CA; the proxy trusts it (traffic stays on
// the pod->service network). Documented tradeoff in plans/gatekeeper-k8s.md §2.2.
makeProxy({
  port: Number(process.env.K8S_API_PROXY_PORT ?? 8443),
  upstream: k8sUpstream,
  ca: k8sCa,
  insecure: false,
  allowedPrefixes: K8S_ALLOWED_PREFIXES,
  label: "k8s api",
});
makeProxy({
  port: Number(process.env.ARGOCD_API_PROXY_PORT ?? 8444),
  upstream: argoUpstream,
  insecure: true,
  allowedPrefixes: ARGO_ALLOWED_PREFIXES,
  label: "argocd api",
});
