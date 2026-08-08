# Gatekeeper K8s — Cluster Ops Gatekeeper: Design & API Review

*Status: **DESIGN REVIEW — implementation blocked until operator approval.***
*Per the `write-gatekeeper` skill, the Session API is the most delicate part; review before building.*

## 1. Overview

A new gatekeeper package, `packages/gatekeeper-k8s`, that lets Cloudflare OS agents (and gadgets)
interact with the homelab k3s cluster: read cluster state, monitor workloads (k8s-native:
metrics.k8s.io, logs, events), manage ArgoCD applications, and perform write operations (scale,
restart, sync) — every write gated by the Workshop's human approval queue.

Three resource families in one package (like `gatekeeper-google`'s multiple resource types), one
`.d.ts` per family where disjoint:

| Family | Vendor id | Covers |
|---|---|---|
| **Kubernetes** | `k8s` | nodes, namespaces, workloads, pods, logs, events, PVCs, resource usage |
| **ArgoCD** | `k8s` (same vendor) | applications: status, sync state, resources, sync/rollback |
| **Monitoring** | `k8s` (same vendor) | k8s-native: pod/node metrics (`metrics.k8s.io`), logs, events — no new infra |

## 2. Architecture

### 2.1 Auth — auto-provisioned ambient singleton (no OAuth)

Modeled on `gatekeeper-scheduler` / `gatekeeper-context`:

- `GatekeeperVendor.describe()` sets **`autoProvisionsAccount: true`**; `createAccount()` mints one
  account per user with **no OAuth flow**.
- `AccountDescription.singleton: { tsType: "OpsSession" }` — the Workshop installs the singleton
  gatekeeper into every workspace and folds it into each chat's env as an **ambient binding**
  named **`K8S`** (from `suggestedBindingName`). The agent calls it directly in `executeCode`:
  `let ns = await env.K8S.namespace("default"); await ns.listDeployments();`
- Deployment-level credentials (homelab single-tenant):
  - **Kubernetes**: the pod's own service-account token (auto-rotated, mounted at
    `/var/run/secrets/kubernetes.io/serviceaccount/token`) + a dedicated RBAC `ClusterRole`
    bound to the cloudflare-os SA (scoped in `k8s/cloudflare-os/rbac.yaml`).
  - **ArgoCD**: an API token (`argocd account generate-token` style) stored in a k8s Secret →
    env `K8S_ARGOCD_TOKEN`. One-time bootstrap script (admin password → session → token), the
    token itself is long-lived.
- Observers: **strategy A (private-only)** — `addObserver()` always throws. Cluster access must
  not leak to gadget collaborators; single-tenant homelab anyway.

### 2.2 Transport (in-cluster, no ingress)

The gatekeeper worker runs inside the cloudflare-os pod (same workerd process) and reaches:

- **k8s API**: `https://kubernetes.default.svc:443` — **TLS risk**: the API server cert is signed
  by the cluster CA, which workerd's fetch does not trust. **Chosen solution: a tiny Node
  TLS-terminating proxy** started by the container entrypoint (reads `ca.crt` from the SA dir),
  exposing `http://127.0.0.1:8443` → `https://kubernetes.default.svc`. The gatekeeper fetches
  plain HTTP on loopback — no CA trust problem, ~30 lines, verified in the pod at implementation
  time. (Fallback if the proxy proves awkward: `NODE_EXTRA_CA_CERTS` path — decided by a spike.)
- **ArgoCD**: same proxy pattern, `http://127.0.0.1:8444` → `https://argocd-server.argocd.svc:443`
  (proxy trusts ArgoCD's self-signed cert via `rejectUnauthorized: false` — traffic stays on the
  pod→service network; documented tradeoff). Alternative (no custom CA): public ingress
  `https://argocd.minhnguyenle.net` (LE cert) — picked if in-cluster proves flaky.

**SECURITY (critical — from design review):** the loopback proxy is reachable by EVERY worker in
 the same workerd process, including agent-written **gadget** Dynamic Workers, which in dev mode
 have unrestricted outbound fetch. A gadget could fetch `http://127.0.0.1:8443` directly and act
 as the SA token — bypassing the gatekeeper entirely. Hardening, all mandatory:

1. **Per-start random proxy token**: the entrypoint generates a random bearer token, the proxy
   rejects any request without `Authorization: Bearer <token>`, and only the gatekeeper worker
   receives it via env. Gadgets never see it. (Never a static default token.)
2. The proxy binds **127.0.0.1 only** (never 0.0.0.0).
3. The proxy forwards **only the API paths the gatekeeper uses** (k8s API group prefixes and
   ArgoCD API prefixes) and only GET/list for read SAs — belt and suspenders.

### 2.3 Credentials: split read/write service accounts (defense in depth)

The single shared SA was the weakest point of the first draft: one ambient token with write power
meant a bug anywhere in the read path could write. Revised:

- **Read SA** (`cfos-read`): ambient, used by all read sessions. ClusterRole: get/list/watch on
  nodes, namespaces, events, pods (incl. `pods/log`), deployments/statefulsets/daemonsets/
  replicasets, PVCs, metrics.k8s.io. **Explicitly excluded: secrets, serviceaccounts,
  pods/exec, pods/attach, persistentvolumes, clusterroles/rolebindings, cert-manager CRs,
  HorizontalPodAutoscalers (write), kube-system write.**
- **Write SA** (`cfos-write`): used **only inside `applyAction()`** for approved mutations.
  ClusterRole: update/patch on deployments/statefulsets/daemonsets (scale/restart), delete on
  pods; nothing else. Not ambient — the gatekeeper's write path holds it, and only applies it
  after the approval queue says so.
- Both tokens come from dedicated SA Secrets (long-lived, homelab-acceptable) exported to the
  gatekeeper via env, never via the proxy.

Per-user identity is therefore **not** modeled at the k8s layer (single-tenant homelab): the
approval queue is the only per-user gate, and the k8s audit log attributes actions to the SA, not
 the user. Upgrade path if multi-tenant: `createAccount()` mints a per-user SA via a bootstrap
 role — noted, not built.

### 2.4 ArgoCD credential: dedicated scoped account, NOT admin

First draft said "token from the admin account" — that hands the gatekeeper full ArgoCD power
(app create/delete/projects). Revised: bootstrap creates a **dedicated local account**
(`cfos-ops`) via the admin session, then the admin token is discarded. The account's RBAC
policies are limited to: `get` on applications/projects, `sync`/`update` on applications in the
`default` project, `*` on logs/events reads. No app creation, no deletion, no project mutation,
no cluster management. The generated token goes into a k8s Secret → env `K8S_ARGOCD_TOKEN`.

### 2.5 Validation & description hygiene

- Resource names are validated against the k8s DNS-1123 charset before any API call; `kind` is
  restricted to the `WorkloadKind` union at runtime (not just at type level); resource URLs are
  parsed strictly (`%2F`, `..`, extra segments rejected).
- Approval descriptions are **structured** (built from validated fields: kind, namespace, name,
  replicas) — never raw user/agent strings — so the approval UI cannot be socially engineered
  via newline injection or confusing text.

### 2.3 Bindings & resource URLs

| Resource URL | Granularity | Session |
|---|---|---|
| `k8s://cluster` | cluster-wide reads: nodes, namespaces, events, node metrics | `ClusterSession` |
| `k8s://cluster/ns/:ns` | namespace reads: workloads, pods, PVCs, events, metrics, logs-listing | `NamespaceSession` |
| `k8s://cluster/ns/:ns/pods/:name` | single pod: describe, logs, metrics, **restart**, **delete** | `PodSession` |
| `k8s://cluster/ns/:ns/workloads/:kind/:name` | single workload (deploy/sts/ds/rs): describe, **scale**, **restart**, **delete** | `WorkloadSession` |
| `argocd://apps` | list apps + projects (read) | `ArgoSession` |
| `argocd://apps/:name` | app status/sync/resources/history, **sync**, **rollback** | `ArgoAppSession` |

Ambient singleton session (`OpsSession`) is the capability-based root: it returns sub-sessions
per resource. The per-URL resource bindings (for gadgets) share the same session impls.

### 2.6 Actors and use cases

**Agent** (coding agent in any chat) — the primary consumer:

- Gets the ambient `env.K8S` binding in every chat session (auto-provided singleton).
- **Reads are ambient**: diagnosing, monitoring, and investigating are always available and
  logged as observations. Use cases: "why is continue-story down?" (events → pod status →
  `diagnose()` → logs), "is the cluster healthy?" (`cluster().listNodes()` + `nodeUsage()`),
  "what's the ArgoCD sync state?" (`argo().listApps()`), "which pods are crashing?"
  (namespace listPods → CrashLoopBackOff filter).
- **Writes are proposal-only**: scale/restart/delete/sync/rollback always land in the workspace
  owner's approval queue with a structured description; the agent may continue working
  (simulation in Phase 2) but the change happens only on approval. Use cases: "scale the API
  to 3 replicas", "restart that stuck deployment", "sync continue-story in ArgoCD".
- The agent's JSDoc-driven discovery means the API surface IS the capability surface: methods
  the type file doesn't declare do not exist for the agent.

**User** (human, homelab single tenant = the owner):

- **Approves/rejects every cluster mutation**, one-by-one or batched, from the Workshop UI;
  nothing is ever auto-approved (`getAutoApprovableActions() = []`).
- **Audits the agent**: every read the agent made is an observation in the workspace's action
  log (what was read, when, through which binding).
- **Grants scope**: the K8S account is auto-provisioned (Connections panel, admin can set the
  vendor to disabled/optional/enabled); per-gadget bindings are created by pasting a resource
  URL (`k8s://cluster/ns/:ns`, `argocd://apps/:name`, …) — the user decides how broad each
  gadget's access is.
- **Admin surface**: can disable the whole vendor in the Gatekeepers admin panel.

**Workspace** (gadget's persistent code):

- **No ambient access** — the singleton is chat-only. A gadget gets cluster access only when the
  agent or user wires a binding (`setGadgetBinding`) to a specific resource URL.
- Gadget code calls the same session methods; reads are observations, writes queue to the
  **workspace owner's** approval queue (approvals are per-workspace, not per-actor).
- **Sharing**: observer strategy A — a gadget bound to K8S cannot be shared; collaborators get
  denied at open. Cluster data never leaks across users.
- Use cases: an ops dashboard gadget rendering namespace health; a watchdog gadget that alerts
  on ArgoCD drift; a "scale my game server" button gadget.

Actor capability summary:

| Actor | Read (observation, logged) | Write (approval-gated) | Ambient? |
|---|---|---|---|
| Agent | full cluster/argo/monitoring surface | yes — always queued | yes (`env.K8S` in every chat) |
| User | via UI/agent, plus full audit log | approves/rejects everything | own account |
| Workspace | only what its bindings' URLs scope | yes — owner's queue | no — binding required |

---

## 3. Draft `types.d.ts` — THE REVIEW ARTIFACT

```ts
// Agent-facing API for the K8S gatekeeper. All reads are observations (logged);
// mutating methods are marked "(requires approval)" and wait for the user.
// Errors are thrown as Error with a message; HTTP-ish statuses are surfaced in the message.

/** Root capability: the ambient cluster-ops session (chat env binding `K8S`). */
export interface OpsSession {
  /** Cluster-wide operations (nodes, namespaces, events, node usage). */
  cluster(): Promise<ClusterSession>;
  /** Operations scoped to one namespace. */
  namespace(name: string): Promise<NamespaceSession>;
  /** Single pod operations (describe, logs, metrics, restart, delete). */
  pod(namespace: string, name: string): Promise<PodSession>;
  /** Single workload operations (deployments, statefulsets, daemonsets, replicasets). */
  workload(namespace: string, kind: WorkloadKind, name: string): Promise<WorkloadSession>;
  /** ArgoCD operations (list applications, projects). */
  argo(): Promise<ArgoSession>;
  /** Single ArgoCD application operations (status, sync state, sync, rollback). */
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

/** Single pod operations. Logs/metrics are reads; restart/delete require approval. */
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
  /** Crash loop / terminated state details if the pod is unhealthy. */
  diagnose(): Promise<string>;   // one-liner: why is this pod not Ready
  /** Delete the pod (Kubernetes reschedules it per its owner). (requires approval) */
  delete(): Promise<void>;
  /** Force-restart by deleting the pod. (requires approval) */
  restart(): Promise<void>;
}

/** Single workload operations. Writes require approval. */
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
  /** Scale to a replica count. (requires approval) */
  scale(replicas: number): Promise<void>;
  /** Rolling restart (new ReplicaSet with same image). (requires approval) */
  restart(): Promise<void>;
  /** Delete the workload. (requires approval) */
  delete(): Promise<void>;
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

/** Single ArgoCD application operations. Sync/rollback require approval. */
export interface ArgoAppSession {
  /** Application status: health, sync state, operation state. */
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
  /** Trigger a sync to the target revision. (requires approval) */
  sync(options?: { revision?: string }): Promise<void>;
  /** Roll back to a previous deployment id (from history()). (requires approval) */
  rollback(deploymentId: number): Promise<void>;
  /** Hard refresh of the app cache. (requires approval) */
  refresh(): Promise<void>;
}
```

## 4. Observation / action mapping

| Operation | Classification |
|---|---|
| All `list*`, `describe`, `logs`, `usage`, `events`, `diagnose`, `status`, `history`, `listProjects` | **Observation** — `authorizeObservation()` before returning; logged for audit |
| `scale`, `restart`, `delete` (k8s), `sync`, `rollback`, `refresh` (argo) | **Action** — `submitAction()`; applied only after human approval (`applyAction`). Description text names resource + change (`"Scale deployment/nginx in ns default to 3 replicas"`) |
| `getAutoApprovableActions()` | `[]` — never auto-approve cluster mutations |

Phase 2 simulation: reads overlay pending actions (scale → `describe().replicas.desired` shows the
pending value until approved/rejected). No other caching in Phase 1 beyond per-request freshness.

## 5. Config & integration changes

| Change | Where |
|---|---|
| New package `packages/gatekeeper-k8s/` (wrangler.jsonc, migrations for the Gatekeeper DO + account) | fork repo |
| `GATEKEEPERS` env: `context,homeassistant,mcp,scheduler,k8s` | `k8s/cloudflare-os/deployment.yaml` |
| Passthrough vars in `run-dev-server.js` (`K8S_SA_TOKEN`, `K8S_ARGOCD_TOKEN`, `K8S_API_PROXY`, `ARGOCD_BASE`) | fork (small patch) |
| Entrypoint wrapper exports SA token + starts TLS proxy (node, reads SA dir) | image (`Dockerfile`/entrypoint) |
| `rbac.yaml`: ClusterRole (read most, write pods/deployments/statefulsets/daemonsets) + RoleBinding to cloudflare-os SA | `k8s/cloudflare-os/` |
| Secret `cfos-argocd-token` (ArgoCD API token) + bootstrap script | k8s repo + one-time run |
| Deploy loop: CI rebuild → manual tag bump → ArgoCD sync | established |

## 6. Phase plan

1. **This design review** (you are here) — approve or request changes to §3.
2. **Phase 1**: package skeleton; vendor/account/singleton (auto-provision); k8s + argo + monitoring
   read sessions via the proxy; observations + approval queue for writes; minimal URL-paste
   configurator (resource bindings for gadgets); `types:check` + unit tests (mocked k8s/argo HTTP).
3. **Spike first**: TLS proxy + SA token plumbing verified in the pod *before* session impls.
4. **Phase 2** (after review): action simulation, observer strategy A hardening, resource-picker
   UI, hook support (e.g. watch ArgoCD sync failures → notify gadget) if wanted.

## 7. Risks

- **TLS to k8s API / argocd-server** — mitigated by the loopback proxy (no CA trust needed); the
  proxy is itself a bypass surface, closed by the per-start bearer token + loopback-only bind +
  path allowlist (§2.2). Spike verifies in-cluster before building on it.
- **Shared identity at the k8s layer** — all actions run as the read/write SAs; per-user
  attribution comes from the Workshop's approval/observation logs, not the k8s audit log.
  Accepted for single-tenant; per-user SA minting is the documented upgrade path (§2.3).
- **Write blast radius** — write SA is limited to scale/restart/delete on workload kinds and
  pods, used only inside `applyAction()`; read SA explicitly excludes secrets/exec/attach;
  ArgoCD uses a scoped account, not admin (§2.3, §2.4).
- **SA token rotation** — dedicated SA Secrets are long-lived (homelab-acceptable); rotating
  them = recreate Secret + env + restart. The pod-projected token option was dropped in favor
  of split SAs.
- **Abuse/rate limits** — an agent could hammer read APIs; observations are logged but not
  rate-limited. Phase 2 hardening: per-workspace rate limiting in the gatekeeper DO.
- **ArgoCD token bootstrap** needs the admin password once (`argocd-initial-admin-secret`); the
  admin token is discarded after the scoped `cfos-ops` account is created.
