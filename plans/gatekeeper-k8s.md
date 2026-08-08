# Gatekeeper K8s — Cluster Ops Gatekeeper (READ-ONLY): Design & API Review

*Status: **DESIGN REVIEW — implementation blocked until operator approval.***
*Scope per operator decision (2026-08-07): **read operations only**. No writes, no approvals, no
simulation. Write support (scale/restart/sync, approval-gated) is a documented future extension —
the platform's approval machinery is untouched, so adding it later is purely additive.*

## 1. Overview

A new gatekeeper package, `packages/gatekeeper-k8s`, that lets Cloudflare OS agents (and gadgets)
**read** the homelab k3s cluster: cluster state, workload health, logs, events, resource usage
(k8s-native — metrics.k8s.io), and ArgoCD application status. **No mutating capability exists
anywhere in the design** — not in the API, not in the service accounts, not in the proxy.

Three resource families in one package (like `gatekeeper-google`'s multiple resource types):

| Family | Covers |
|---|---|
| **Kubernetes** | nodes, namespaces, workloads, pods, logs, events, PVCs, resource usage |
| **ArgoCD** | applications: status, sync state, resources, history (read) |
| **Monitoring** | k8s-native: pod/node metrics, logs, events — no new infra |

## 2. Architecture

### 2.1 Auth — auto-provisioned ambient singleton (no OAuth)

Modeled on `gatekeeper-scheduler` / `gatekeeper-context`:

- `GatekeeperVendor.describe()` sets **`autoProvisionsAccount: true`**; `createAccount()` mints one
  account per user with **no OAuth flow**.
- `AccountDescription.singleton: { tsType: "OpsSession" }` — the Workshop installs the singleton
  gatekeeper into every workspace and folds it into each chat's env as an **ambient binding**
  named **`K8S`** (from `suggestedBindingName`): `let ns = await env.K8S.namespace("default");`
- Observers: **strategy A (private-only)** — `addObserver()` always throws. Cluster state must
  not leak to gadget collaborators via sharing; single-tenant homelab anyway.

### 2.2 Transport (in-cluster, no ingress) — TLS proxy with mandatory hardening

The gatekeeper worker runs inside the cloudflare-os pod (same workerd process) and reaches:

- **k8s API**: `https://kubernetes.default.svc:443` — the API server cert is signed by the
  cluster CA, which workerd's fetch does not trust. A tiny Node TLS-terminating proxy (started by
  the container entrypoint, reading `ca.crt` from the SA dir) exposes
  `http://127.0.0.1:8443` → `https://kubernetes.default.svc`.
- **ArgoCD**: same pattern, `http://127.0.0.1:8444` → `https://argocd-server.argocd.svc:443`
  (proxy trusts ArgoCD's self-signed cert; traffic stays on the pod→service network). Alternative
  if flaky: public ingress `https://argocd.minhnguyenle.net` (LE cert).

**SECURITY (critical, from design review):** the loopback proxy is reachable by EVERY worker in
the same workerd process, including agent-written **gadget** Dynamic Workers (unrestricted
outbound in dev mode). A gadget could fetch the proxy directly and act as the service account,
bypassing the gatekeeper. Hardening (mandatory):

1. **Per-start random proxy token**: entrypoint generates a random bearer token; the proxy
   rejects any request without `Authorization: Bearer <token>`; only the gatekeeper worker
   receives it via env. Never a static default.
2. Proxy binds **127.0.0.1 only**.
3. Proxy forwards **only the API paths the gatekeeper uses** (k8s read-only API groups, ArgoCD
   API prefixes) and **only GET/list/watch** — the proxy is read-only even against a compromised
   gatekeeper.

### 2.3 Credentials — ONE read-only service account

- **`cfos-read` SA**: dedicated, long-lived SA Secret token → env. ClusterRole grants
  **get/list/watch** on: nodes, namespaces, events, pods (incl. `pods/log`),
  deployments/statefulsets/daemonsets/replicasets, PVCs, `metrics.k8s.io`.
- **Explicitly NOT granted** (not just "not used" — absent from RBAC): secrets, serviceaccounts,
  `pods/exec`, `pods/attach`, persistentvolumes, clusterroles/rolebindings, cert-manager CRs,
  any update/patch/delete/create verb, any write on kube-system.
- No write SA exists. The gatekeeper code cannot write even if every internal check failed.
- Per-user identity is not modeled at the k8s layer (single-tenant): reads attribute to the SA;
  per-read attribution lives in the Workshop's observation log.

### 2.4 ArgoCD credential — dedicated scoped account, get-only

Bootstrap (one-time, needs the admin password from `argocd-initial-admin-secret`): create a
dedicated local account `cfos-ops`, then **discard the admin token**. RBAC policies limited to
**`get`** on applications/projects, **read** on logs/events. No `sync`, no `update`, no app
creation/deletion, no project mutation. Token → k8s Secret → env `K8S_ARGOCD_TOKEN`.

### 2.5 Validation & hygiene

- Resource names validated against the k8s DNS-1123 charset before any API call; `kind`
  restricted to the `WorkloadKind` union at runtime; resource URLs parsed strictly (`%2F`,
  `..`, extra segments rejected).
- Observation descriptions are structured (kind, namespace, name) — no raw strings — so the
  audit log is clean and unspoofable.

### 2.6 Actors and use cases

**Agent** (coding agent in any chat) — the primary consumer:

- Ambient `env.K8S` in every chat session. Everything it can do is a **read, logged as an
  observation**.
- Use cases: "why is continue-story down?" (events → pod status → `diagnose()` → logs), "is the
  cluster healthy?" (`cluster().listNodes()` + `nodeUsage()`), "what's the ArgoCD sync state?"
  (`argo().listApps()`, `argoApp("continue-story").status()`), "which pods are crashing?"
  (namespace listPods → CrashLoopBackOff), "how much memory does litellm use?"
  (`podUsage()` / `pod().usage()`).
- The agent cannot propose changes — there are no write methods at all. If it detects a problem,
  it reports it to the user, who acts via kubectl/ArgoCD (or, in a future extension, approves a
  proposed action).

**User** (human owner):

- **Audits the agent**: every read is an observation in the workspace's action log (what was
  read, when, through which binding). Nothing to approve — there are no actions.
- **Grants scope**: the K8S account auto-provisions (Connections panel; admin can set the vendor
  to disabled/optional/enabled); per-gadget bindings are created by pasting a resource URL — the
  user decides how broad each gadget's access is.
- **Admin surface**: can disable the whole vendor in the Gatekeepers admin panel.

**Workspace** (gadget's persistent code):

- **No ambient access** — bindings only (agent or user wires `setGadgetBinding` to a resource
  URL).
- Gadget code calls the same read-only session methods; each read is an observation in the
  **workspace owner's** log.
- **Sharing**: strategy A — a gadget bound to K8S cannot be shared.
- Use cases: ops dashboard gadget rendering namespace health; ArgoCD drift watch gadget;
  "cluster status" widget.

Actor capability summary:

| Actor | Reads (observation, logged) | Writes | Ambient? |
|---|---|---|---|
| Agent | full cluster/argo/monitoring surface | **none — by design** | yes (`env.K8S` in every chat) |
| User | via UI/agent, plus full audit log | none via this gatekeeper (kubectl/ArgoCD directly) | own account |
| Workspace | only what its bindings' URLs scope | none | no — binding required |

## 3. Draft `types.d.ts` — THE REVIEW ARTIFACT

```ts
// Agent-facing API for the K8S gatekeeper (READ-ONLY).
// Every method is an observation: the read is logged to the workspace audit trail.
// There are no mutating methods. Errors are thrown as Error with a descriptive message.

/** Root capability: the ambient cluster-ops session (chat env binding `K8S`). */
export interface OpsSession {
  /** Cluster-wide operations (nodes, namespaces, events, node usage). */
  cluster(): Promise<ClusterSession>;
  /** Operations scoped to one namespace. */
  namespace(name: string): Promise<NamespaceSession>;
  /** Single pod operations (describe, logs, metrics, diagnose). */
  pod(namespace: string, name: string): Promise<PodSession>;
  /** Single workload operations (deployments, statefulsets, daemonsets, replicasets). */
  workload(namespace: string, kind: WorkloadKind, name: string): Promise<WorkloadSession>;
  /** ArgoCD operations (list applications, projects). */
  argo(): Promise<ArgoSession>;
  /** Single ArgoCD application operations (status, sync state, history). */
  argoApp(name: string): Promise<ArgoAppSession>;
}

/** Workload kinds addressable as single resources. */
export type WorkloadKind = "deployments" | "statefulsets" | "daemonsets" | "replicasets";

/** A single Kubernetes node (summary). */
export interface NodeSummary {
  name: string;
  status: string;            // Ready / NotReady / ...
  roles: string[];
  version: string;
  cpu: string;               // allocatable, e.g. "3"
  memory: string;            // allocatable, e.g. "3.7Gi"
  addresses: string[];       // InternalIP, ExternalIP, ...
  taints: string[];
}

/** A Kubernetes namespace (summary). */
export interface NamespaceSummary {
  name: string;
  status: string;            // Active / Terminating
  labels: Record<string, string>;
}

/** Resource usage for a node or pod (metrics.k8s.io). */
export interface Usage {
  cpuUsage: string;          // e.g. "137m"
  memoryUsage: string;       // e.g. "1851Mi"
}

/** A Kubernetes event. */
export interface K8sEvent {
  type: string;              // Normal / Warning
  reason: string;
  message: string;
  object: string;            // e.g. "Pod/nginx-abc123"
  count: number;
  lastSeen: string;          // ISO timestamp
}

/** Cluster-wide operations (read-only). */
export interface ClusterSession {
  /** All nodes with status/roles/allocatable resources. */
  listNodes(): Promise<NodeSummary[]>;
  /** All namespaces. */
  listNamespaces(): Promise<NamespaceSummary[]>;
  /** Resource usage of every node. */
  nodeUsage(): Promise<{ node: string; usage: Usage }[]>;
  /** Cluster events, optionally filtered to warnings only. */
  events(options?: { warningsOnly?: boolean; limit?: number }): Promise<K8sEvent[]>;
}

/** A pod (summary). */
export interface PodSummary {
  name: string;
  namespace: string;
  node: string;
  status: string;            // Running / CrashLoopBackOff / Pending / ...
  ready: string;             // "1/1"
  restarts: number;
  age: string;               // humanized, e.g. "3d"
  containers: string[];
}

/** A workload (deployment/statefulset/...) summary. */
export interface WorkloadSummary {
  name: string;
  namespace: string;
  kind: string;
  desired: number;
  ready: number;
  available: number;
  image: string;             // first container image
  age: string;
}

/** A container within a pod. */
export interface ContainerInfo {
  name: string;
  image: string;
  ready: boolean;
  restarts: number;
  state: string;             // Running / Waiting / Terminated
  lastState?: string;
}

/** Operations scoped to one namespace (read-only). */
export interface NamespaceSession {
  /** All pods in the namespace. */
  listPods(): Promise<PodSummary[]>;
  /** All deployments in the namespace. */
  listDeployments(): Promise<WorkloadSummary[]>;
  /** All statefulsets / daemonsets / replicasets in the namespace. */
  listWorkloads(kind: WorkloadKind): Promise<WorkloadSummary[]>;
  /** All PVCs with status and capacity. */
  listPvc(): Promise<{ name: string; status: string; capacity: string; claimClass: string }[]>;
  /** Resource usage of every pod in the namespace. */
  podUsage(): Promise<{ pod: string; usage: Usage }[]>;
  /** Namespace events, optionally warnings only. */
  events(options?: { warningsOnly?: boolean; limit?: number }): Promise<K8sEvent[]>;
}

/** Single pod operations (read-only). */
export interface PodSession {
  /** Full pod description: containers, conditions, node, QoS, labels. */
  describe(): Promise<{
    name: string;
    namespace: string;
    node: string;
    status: string;
    conditions: string[];    // e.g. "Ready=True", "ContainersReady=True"
    containers: ContainerInfo[];
    initContainers: ContainerInfo[];
    labels: Record<string, string>;
    annotations: Record<string, string>;
    qosClass: string;
    startTime: string;
    ip: string;
  }>;
  /** Live resource usage of this pod. */
  usage(): Promise<Usage>;
  /** Recent log lines of a container (default: first container, last 200 lines). */
  logs(options?: { container?: string; tail?: number; previous?: boolean }): Promise<string>;
  /** One-liner explaining why this pod is not Ready, if it isn't. */
  diagnose(): Promise<string>;
}

/** Single workload operations (read-only). */
export interface WorkloadSession {
  /** Workload description: spec + status, images, selector, strategy. */
  describe(): Promise<{
    name: string;
    namespace: string;
    kind: string;
    replicas: { desired: number; ready: number; available: number; updated: number };
    strategy: string;        // e.g. "RollingUpdate"
    image: string;
    selector: Record<string, string>;
    conditions: string[];
    age: string;
  }>;
  /** Pods owned by this workload. */
  pods(): Promise<PodSummary[]>;
}

/** ArgoCD application (summary). */
export interface ArgoAppSummary {
  name: string;
  project: string;
  status: string;            // Healthy / Degraded / Progressing / Missing
  syncStatus: string;        // Synced / OutOfSync / Unknown
  syncRevision: string;
  targetRevision: string;
  namespace: string;
  repoUrl: string;
  path: string;
  server: string;            // cluster URL
}

/** ArgoCD operations (read-only). */
export interface ArgoSession {
  /** All applications across projects. */
  listApps(): Promise<ArgoAppSummary[]>;
  /** All projects. */
  listProjects(): Promise<{ name: string; sourceRepos: string[]; clusters: string[] }[]>;
}

/** Single ArgoCD application operations (read-only). */
export interface ArgoAppSession {
  /** Application status: health, sync state, operation state, resources. */
  status(): Promise<{
    name: string;
    health: string;
    sync: string;
    revision: string;
    operationState?: string;
    resources: { kind: string; name: string; namespace: string; status: string }[];
    conditions: string[];
    parameters: Record<string, string>;
  }>;
  /** Sync/rollback history. */
  history(): Promise<{ id: number; revision: string; deployedAt: string; initiatedBy: string }[]>;
}
```

## 4. Observation model

- **Every method is an observation**: `authorizeObservation()` is awaited before any data is
  returned; the read is recorded in the workspace's action log with a structured description.
- **No actions exist**: `applyAction()` / `rejectAction()` / `revertAction()` throw (the
  `gatekeeper-scheduler` read-only pattern). `getAutoApprovableActions()` returns `[]`.
- Future write extension: add mutating methods + `submitAction()`; nothing else in the platform
  needs to change (approval machinery is gatekeeper-agnostic).

## 5. Config & integration changes

| Change | Where |
|---|---|
| New package `packages/gatekeeper-k8s/` (wrangler.jsonc, migrations for the Gatekeeper DO + account) | fork repo |
| `GATEKEEPERS` env: `context,homeassistant,mcp,scheduler,k8s` | `k8s/cloudflare-os/deployment.yaml` |
| Passthrough vars in `run-dev-server.js` (`K8S_READ_TOKEN`, `K8S_ARGOCD_TOKEN`, `K8S_PROXY_TOKEN`, `K8S_API_PROXY`, `ARGOCD_BASE`) | fork (small patch) |
| Entrypoint wrapper: exports SA tokens + starts read-only TLS proxy (node, reads SA dir) | image (`Dockerfile`/entrypoint) |
| `rbac.yaml`: `cfos-read` SA + ClusterRole (get/list/watch as §2.3, explicit exclusions) | `k8s/cloudflare-os/` |
| Secret `cfos-argocd-token` + one-time bootstrap (scoped `cfos-ops` account) | k8s repo + one-time run |
| Deploy loop: CI rebuild → manual tag bump → ArgoCD sync | established |

## 6. Phase plan

1. **This design review** (you are here) — approve or request changes to §3.
2. **Spike**: TLS proxy + token plumbing verified in the pod (proxy rejects requests without the
   bearer token; read-only path allowlist confirmed) — before any session code.
3. **Phase 1**: package skeleton; vendor/account/singleton (auto-provision); k8s + argo +
   monitoring read sessions via the proxy; observations; minimal URL-paste configurator;
   `types:check` + unit tests (mocked k8s/argo HTTP).
4. **Phase 2** (separate review): resource-picker UI; per-workspace read rate limiting; optional
   hooks (e.g. ArgoCD sync-failure watch). Read-only remains the contract.

## 7. Risks

- **TLS to k8s API / argocd-server** — mitigated by the loopback proxy (no CA trust needed); the
  proxy is a bypass surface, closed by the per-start bearer token + loopback-only bind + read-only
  path allowlist (§2.2). Spike verifies in-cluster before building on it.
- **Proxy bypass** — without the bearer-token fix, gadget code could read cluster state directly
  as the SA (bypassing observation logging). Mitigated as §2.2; the read-only SA limits even a
  full bypass to reads.
- **Shared identity** — reads attribute to the SA at the k8s layer; per-read attribution is in the
  Workshop observation log. Accepted for single-tenant.
- **Data exposure surface** — the read SA deliberately excludes secrets/exec/PVs/kube-system
  writes; logs can still contain sensitive strings (the agent reading logs is the feature);
  observation logging records what was read.
- **Rate limits** — an agent could hammer read APIs; observations are logged but not rate-limited.
  Phase 2 hardening.
- **ArgoCD bootstrap** needs the admin password once; admin token discarded after the scoped
  account is created.
- **No write capability is the primary control** — even a fully compromised gatekeeper or gadget
  cannot mutate the cluster through this path (kubectl/ArgoCD CLI access is out of band).
