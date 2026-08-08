// Gatekeeper K8s — read-only cluster-ops gatekeeper (k3s + ArgoCD + k8s-native monitoring).
//
// Auto-provisioned ambient singleton (no OAuth): every user gets one account backed by
// deployment-level credentials — the read-only service-account token for the k8s API and a
// scoped read-only ArgoCD account token. The agent reaches it as the ambient `K8S` chat
// binding. Every read is an observation; there are no mutating methods.
//
// See plans/gatekeeper-k8s.md for the design and security model.

import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  AgentCatalogRequest,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ObservationAuthorizer,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  ArgoAppSession,
  ArgoSession,
  ClusterSession,
  ContainerInfo,
  K8sEvent,
  NamespaceSession,
  NamespaceSummary,
  NodeSummary,
  OpsSession,
  PodSession,
  PodSummary,
  Usage,
  WorkloadKind,
  WorkloadSession,
  WorkloadSummary,
} from "./types";
import { ArgoApiClient, type ArgoApiConfig } from "./argo-api";
import { K8sApiClient, type K8sApiConfig } from "./k8s-api";
import {
  assertValidName,
  assertWorkloadKind,
  containerInfo,
  humanizeAge,
} from "./k8s-api";
import TYPES_CODE from "./types.txt";
import K8S_CONFIGURATOR_HTML from "./generated/k8s-configurator-ui.txt";

// ---------------------------------------------------------------------------
// Icon.

const K8S_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24Zm0 192a88 88 0 1 1 88-88 88.1 88.1 0 0 1-88 88Zm14.43-104.68 34.13-25.87a8 8 0 0 1 9.6 12.8l-34.14 25.88a8 8 0 0 1-9.59-12.81ZM128 120a8 8 0 0 1 8 8 8.22 8.22 0 0 1-1.28 4.39l-17.24 28.69a8 8 0 1 1-13.6-8.4l17.25-28.7A8.23 8.23 0 0 1 120 120a8 8 0 0 1 8-8Zm-32.71 2.16a8 8 0 0 1-2.17 11.05l-32.85 21.63a8 8 0 0 1-8.86-13.33l32.84-21.62a8 8 0 0 1 11.04 2.27ZM96 168h32a8 8 0 0 1 8 8 8 8 0 0 1-8 8H96a8 8 0 0 1 0-16Z'/></svg>",
    ),
};

// ---------------------------------------------------------------------------
// Resource URL grammar.

const RESOURCES: SupportedResource[] = [
  {
    urlPattern: "k8s://cluster",
    title: "Kubernetes Cluster",
    description: "Read cluster-wide state: nodes, namespaces, events, node usage.",
  },
  {
    urlPattern: "k8s://cluster/ns/:namespace",
    title: "Kubernetes Namespace",
    description: "Read one namespace: pods, workloads, PVCs, events, usage.",
  },
  {
    urlPattern: "k8s://cluster/ns/:namespace/pods/:pod",
    title: "Kubernetes Pod",
    description: "Read one pod: describe, logs, usage, diagnostics.",
  },
  {
    urlPattern: "k8s://cluster/ns/:namespace/workloads/:kind/:name",
    title: "Kubernetes Workload",
    description: "Read one workload (deployment/statefulset/daemonset/replicaset) and its pods.",
  },
  {
    urlPattern: "argocd://apps",
    title: "ArgoCD Applications",
    description: "Read ArgoCD applications and projects.",
  },
  {
    urlPattern: "argocd://apps/:name",
    title: "ArgoCD Application",
    description: "Read one ArgoCD application: status, sync state, history.",
  },
];

// ---------------------------------------------------------------------------
// Scope: what a session may touch. The ambient singleton is `full`; URL-addressed
// bindings are scoped to their resource.

type Scope =
  | { kind: "full" }
  | { kind: "cluster" }
  | { kind: "namespace"; namespace: string }
  | { kind: "pod"; namespace: string; name: string }
  | { kind: "workload"; namespace: string; workloadKind: WorkloadKind; name: string }
  | { kind: "argo" }
  | { kind: "argoApp"; name: string };

function parseScope(resourceUrl: string | undefined): Scope {
  if (resourceUrl === undefined) return { kind: "full" };
  let url: URL;
  try {
    url = new URL(resourceUrl);
  } catch {
    throw new Error(`Invalid resource URL: "${resourceUrl}".`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.protocol === "argocd:") {
    if (url.hostname !== "apps") {
      throw new Error(`Invalid ArgoCD resource URL: "${resourceUrl}".`);
    }
    if (segments.length === 0) return { kind: "argo" };
    if (segments.length === 1) {
      return { kind: "argoApp", name: assertValidName("application", segments[0]) };
    }
    throw new Error(`Invalid ArgoCD resource URL: "${resourceUrl}".`);
  }
  if (url.protocol !== "k8s:" || url.hostname !== "cluster") {
    throw new Error(`Invalid Kubernetes resource URL: "${resourceUrl}".`);
  }
  if (segments.length === 0) return { kind: "cluster" };
  if (segments[0] !== "ns") {
    throw new Error(`Invalid Kubernetes resource URL: "${resourceUrl}".`);
  }
  if (segments.length === 2) {
    return { kind: "namespace", namespace: assertValidName("namespace", segments[1]) };
  }
  if (segments.length === 4 && segments[2] === "pods") {
    return {
      kind: "pod",
      namespace: assertValidName("namespace", segments[1]),
      name: assertValidName("pod", segments[3], true),
    };
  }
  if (segments.length === 5 && segments[2] === "workloads") {
    return {
      kind: "workload",
      namespace: assertValidName("namespace", segments[1]),
      workloadKind: assertWorkloadKind(segments[3]),
      name: assertValidName("workload", segments[4]),
    };
  }
  throw new Error(`Invalid Kubernetes resource URL: "${resourceUrl}".`);
}

class ScopeGuard {
  constructor(private readonly scope: Scope) {}

  private deny(what: string): never {
    throw new Error(`This binding does not cover ${what}.`);
  }

  cluster(): void {
    if (this.scope.kind !== "full" && this.scope.kind !== "cluster") this.deny("cluster-wide reads");
  }

  namespace(namespace: string): void {
    if (this.scope.kind === "full" || this.scope.kind === "cluster") return;
    if (this.scope.kind === "namespace" && this.scope.namespace === namespace) return;
    if (this.scope.kind === "pod" && this.scope.namespace === namespace) return;
    if (this.scope.kind === "workload" && this.scope.namespace === namespace) return;
    this.deny(`namespace ${namespace}`);
  }

  pod(namespace: string, name: string): void {
    if (this.scope.kind === "full" || this.scope.kind === "cluster") return;
    if (this.scope.kind === "namespace" && this.scope.namespace === namespace) return;
    if (this.scope.kind === "pod" && this.scope.namespace === namespace && this.scope.name === name) {
      return;
    }
    if (this.scope.kind === "workload" && this.scope.namespace === namespace) return;
    this.deny(`pod ${namespace}/${name}`);
  }

  workload(namespace: string, kind: WorkloadKind, name: string): void {
    if (this.scope.kind === "full" || this.scope.kind === "cluster") return;
    if (this.scope.kind === "namespace" && this.scope.namespace === namespace) return;
    if (this.scope.kind === "workload" &&
        this.scope.namespace === namespace &&
        this.scope.workloadKind === kind && this.scope.name === name) {
      return;
    }
    this.deny(`workload ${kind}/${name} in ${namespace}`);
  }

  argo(): void {
    if (this.scope.kind !== "full" && this.scope.kind !== "argo") this.deny("ArgoCD reads");
  }

  argoApp(name: string): void {
    if (this.scope.kind === "full" || this.scope.kind === "argo") return;
    if (this.scope.kind === "argoApp" && this.scope.name === name) return;
    this.deny(`ArgoCD application ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Session context: credentials + approval queue + scope.

type SessionContext = {
  approvalQueue: NativeRpcStub<ApprovalQueue>;
  k8s: K8sApiClient;
  argo: ArgoApiClient;
  scope: ScopeGuard;
};

function k8sConfig(env: Cloudflare.Env): K8sApiConfig {
  const token = env.K8S_READ_TOKEN;
  if (!token) {
    throw new Error("K8S_READ_TOKEN is not configured; the Kubernetes gatekeeper cannot reach the cluster.");
  }
  return { token, baseUrl: env.K8S_API_PROXY ?? "http://127.0.0.1:8443" };
}

function argoConfig(env: Cloudflare.Env): ArgoApiConfig {
  const token = env.K8S_ARGOCD_TOKEN;
  if (!token) {
    throw new Error("K8S_ARGOCD_TOKEN is not configured; the ArgoCD reads are unavailable.");
  }
  return { token, baseUrl: env.ARGOCD_API_PROXY ?? "http://127.0.0.1:8444" };
}

function makeContext(env: Cloudflare.Env, approvalQueue: NativeRpcStub<ApprovalQueue>, scope: Scope): SessionContext {
  return {
    approvalQueue: approvalQueue.dup(),
    k8s: new K8sApiClient(k8sConfig(env)),
    argo: new ArgoApiClient(argoConfig(env)),
    scope: new ScopeGuard(scope),
  };
}

async function observe(queue: NativeRpcStub<ApprovalQueue>, title: string, description: string): Promise<void> {
  await queue.authorizeObservation({ title, description });
}

// ---------------------------------------------------------------------------
// Session implementations.

@validateRpc()
class ClusterSessionImpl extends RpcTarget implements ClusterSession {
  constructor(private readonly ctx: SessionContext) {
    super();
  }

  async listNodes(): Promise<NodeSummary[]> {
    await observe(this.ctx.approvalQueue, "List cluster nodes",
        "Reads all Kubernetes nodes (status, roles, allocatable resources, taints).");
    return this.ctx.k8s.listNodes();
  }

  async listNamespaces(): Promise<NamespaceSummary[]> {
    await observe(this.ctx.approvalQueue, "List namespaces",
        "Reads all Kubernetes namespaces (status, labels).");
    return this.ctx.k8s.listNamespaces();
  }

  async nodeUsage(): Promise<{ node: string; usage: Usage }[]> {
    await observe(this.ctx.approvalQueue, "Read node resource usage",
        "Reads live CPU/memory usage of every node (metrics.k8s.io).");
    return this.ctx.k8s.nodeUsage();
  }

  async events(options?: { warningsOnly?: boolean; limit?: number }): Promise<K8sEvent[]> {
    await observe(this.ctx.approvalQueue, "Read cluster events",
        `Reads Kubernetes events cluster-wide${options?.warningsOnly ? " (warnings only)" : ""}.`);
    return this.ctx.k8s.listEvents(undefined, options);
  }
}

@validateRpc()
class NamespaceSessionImpl extends RpcTarget implements NamespaceSession {
  constructor(private readonly ctx: SessionContext, private readonly namespace: string) {
    super();
  }

  async listPods(): Promise<PodSummary[]> {
    await observe(this.ctx.approvalQueue, `List pods in ${this.namespace}`,
        `Reads all pods in namespace ${this.namespace} (status, restarts, readiness).`);
    return this.ctx.k8s.listPods(this.namespace);
  }

  async listDeployments(): Promise<WorkloadSummary[]> {
    return this.listWorkloads("deployments");
  }

  async listWorkloads(kind: WorkloadKind): Promise<WorkloadSummary[]> {
    await observe(this.ctx.approvalQueue, `List ${kind} in ${this.namespace}`,
        `Reads all ${kind} in namespace ${this.namespace} (replicas, images).`);
    return this.ctx.k8s.listWorkloads(this.namespace, kind);
  }

  async listPvc(): Promise<{ name: string; status: string; capacity: string; claimClass: string }[]> {
    await observe(this.ctx.approvalQueue, `List PVCs in ${this.namespace}`,
        `Reads all persistent volume claims in namespace ${this.namespace}.`);
    return this.ctx.k8s.listPvc(this.namespace);
  }

  async podUsage(): Promise<{ pod: string; usage: Usage }[]> {
    await observe(this.ctx.approvalQueue, `Read pod usage in ${this.namespace}`,
        `Reads live CPU/memory usage of every pod in namespace ${this.namespace}.`);
    return this.ctx.k8s.podUsage(this.namespace);
  }

  async events(options?: { warningsOnly?: boolean; limit?: number }): Promise<K8sEvent[]> {
    await observe(this.ctx.approvalQueue, `Read events in ${this.namespace}`,
        `Reads Kubernetes events in namespace ${this.namespace}${options?.warningsOnly ? " (warnings only)" : ""}.`);
    return this.ctx.k8s.listEvents(this.namespace, options);
  }
}

@validateRpc()
class PodSessionImpl extends RpcTarget implements PodSession {
  constructor(
      private readonly ctx: SessionContext,
      private readonly namespace: string,
      private readonly name: string,
  ) {
    super();
  }

  async describe() {
    await observe(this.ctx.approvalQueue, `Describe pod ${this.namespace}/${this.name}`,
        `Reads the full description of pod ${this.namespace}/${this.name} (containers, conditions, labels).`);
    const pod = await this.ctx.k8s.getPod(this.namespace, this.name);
    const cs = pod.status?.containerStatuses ?? [];
    const containers: ContainerInfo[] = cs.map(containerInfo);
    const initContainers: ContainerInfo[] = (pod.status?.initContainerStatuses ?? []).map(containerInfo);
    return {
      name: this.name,
      namespace: this.namespace,
      node: pod.spec?.nodeName ?? "",
      status: pod.status?.phase ?? "Unknown",
      conditions: (pod.status?.conditions ?? []).map(c => `${c.type}=${c.status}`),
      containers,
      initContainers,
      labels: pod.metadata?.labels ?? {},
      annotations: pod.metadata?.annotations ?? {},
      qosClass: pod.status?.qosClass ?? "",
      startTime: pod.status?.startTime ?? "",
      ip: pod.status?.podIP ?? "",
    };
  }

  async usage(): Promise<Usage> {
    await observe(this.ctx.approvalQueue, `Read usage of pod ${this.namespace}/${this.name}`,
        `Reads live CPU/memory usage of pod ${this.namespace}/${this.name}.`);
    const rows = await this.ctx.k8s.podUsage(this.namespace);
    const row = rows.find(r => r.pod === this.name);
    if (!row) throw new Error(`No metrics found for pod ${this.namespace}/${this.name}.`);
    return row.usage;
  }

  async logs(options?: { container?: string; tail?: number; previous?: boolean }): Promise<string> {
    await observe(this.ctx.approvalQueue, `Read logs of pod ${this.namespace}/${this.name}`,
        `Reads up to ${options?.tail ?? 200} log lines of container ` +
        `${options?.container ?? "(first)"} of pod ${this.namespace}/${this.name}` +
        `${options?.previous ? " (previous instance)" : ""}.`);
    return this.ctx.k8s.getPodLogs(this.namespace, this.name, options);
  }

  async diagnose(): Promise<string> {
    await observe(this.ctx.approvalQueue, `Diagnose pod ${this.namespace}/${this.name}`,
        `Checks why pod ${this.namespace}/${this.name} is not ready.`);
    const pod = await this.ctx.k8s.getPod(this.namespace, this.name);
    for (const cs of pod.status?.containerStatuses ?? []) {
      const waiting = cs.state?.waiting;
      if (waiting) {
        return `Container ${cs.name ?? "?"} is waiting: ${waiting.reason ?? "unknown"}${waiting.message ? ` — ${waiting.message}` : ""}.`;
      }
      const terminated = cs.state?.terminated;
      if (terminated) {
        return `Container ${cs.name ?? "?"} terminated (exit ${terminated.exitCode ?? "?"}): ` +
            `${terminated.reason ?? "unknown"}${terminated.message ? ` — ${terminated.message}` : ""}.`;
      }
    }
    const notReady = (pod.status?.conditions ?? []).find(c => c.type === "Ready" && c.status !== "True");
    if (notReady) {
      return `Pod is not Ready: ${notReady.reason ?? "unknown reason"}${notReady.message ? ` — ${notReady.message}` : ""}.`;
    }
    return `Pod ${this.namespace}/${this.name} is Ready.`;
  }
}

@validateRpc()
class WorkloadSessionImpl extends RpcTarget implements WorkloadSession {
  constructor(
      private readonly ctx: SessionContext,
      private readonly namespace: string,
      private readonly kind: WorkloadKind,
      private readonly name: string,
  ) {
    super();
  }

  async describe() {
    await observe(this.ctx.approvalQueue, `Describe ${this.kind}/${this.name} in ${this.namespace}`,
        `Reads the description of ${this.kind}/${this.name} in namespace ${this.namespace}.`);
    const wl = await this.ctx.k8s.getWorkload(this.namespace, this.kind, this.name);
    return {
      name: this.name,
      namespace: this.namespace,
      kind: this.kind,
      replicas: {
        desired: wl.spec?.replicas ?? 0,
        ready: wl.status?.readyReplicas ?? 0,
        available: wl.status?.availableReplicas ?? 0,
        updated: wl.status?.updatedReplicas ?? 0,
      },
      strategy: wl.spec?.strategy?.type ?? "",
      image: wl.spec?.template?.spec?.containers?.[0]?.image ?? "",
      selector: wl.spec?.selector?.matchLabels ?? {},
      conditions: (wl.status?.conditions ?? []).map(c => `${c.type}=${c.status}`),
      age: humanizeAge(wl.metadata?.creationTimestamp),
    };
  }

  async pods(): Promise<PodSummary[]> {
    await observe(this.ctx.approvalQueue, `List pods of ${this.kind}/${this.name}`,
        `Reads pods owned by ${this.kind}/${this.name} in namespace ${this.namespace}.`);
    const wl = await this.ctx.k8s.getWorkload(this.namespace, this.kind, this.name);
    const selector = wl.spec?.selector?.matchLabels ?? {};
    const pods = await this.ctx.k8s.getWorkloadPods(this.namespace, selector);
    return pods.toSorted((a, b) => (a.name < b.name ? -1 : 1));
  }
}

@validateRpc()
class ArgoSessionImpl extends RpcTarget implements ArgoSession {
  constructor(private readonly ctx: SessionContext) {
    super();
  }

  async listApps() {
    await observe(this.ctx.approvalQueue, "List ArgoCD applications",
        "Reads all ArgoCD applications (health, sync state, target revisions).");
    return this.ctx.argo.listApps();
  }

  async listProjects() {
    await observe(this.ctx.approvalQueue, "List ArgoCD projects",
        "Reads all ArgoCD projects (source repos, clusters).");
    return this.ctx.argo.listProjects();
  }
}

@validateRpc()
class ArgoAppSessionImpl extends RpcTarget implements ArgoAppSession {
  constructor(private readonly ctx: SessionContext, private readonly name: string) {
    super();
  }

  async status() {
    await observe(this.ctx.approvalQueue, `Status of ArgoCD application ${this.name}`,
        `Reads health, sync state, resources, and conditions of ArgoCD application ${this.name}.`);
    const { status } = await this.ctx.argo.getApp(this.name);
    return status;
  }

  async history() {
    await observe(this.ctx.approvalQueue, `History of ArgoCD application ${this.name}`,
        `Reads the sync/rollback history of ArgoCD application ${this.name}.`);
    const { history } = await this.ctx.argo.getApp(this.name);
    return history;
  }
}

@validateRpc()
class OpsSessionImpl extends RpcTarget implements OpsSession {
  constructor(private readonly ctx: SessionContext) {
    super();
  }

  cluster(): Promise<ClusterSession> {
    this.ctx.scope.cluster();
    return Promise.resolve(new ClusterSessionImpl(this.ctx));
  }

  namespace(name: string): Promise<NamespaceSession> {
    assertValidName("namespace", name);
    this.ctx.scope.namespace(name);
    return Promise.resolve(new NamespaceSessionImpl(this.ctx, name));
  }

  pod(namespace: string, name: string): Promise<PodSession> {
    assertValidName("namespace", namespace);
    assertValidName("pod", name, true);
    this.ctx.scope.pod(namespace, name);
    return Promise.resolve(new PodSessionImpl(this.ctx, namespace, name));
  }

  workload(namespace: string, kind: WorkloadKind, name: string): Promise<WorkloadSession> {
    assertValidName("namespace", namespace);
    assertWorkloadKind(kind);
    assertValidName("workload", name);
    this.ctx.scope.workload(namespace, kind, name);
    return Promise.resolve(new WorkloadSessionImpl(this.ctx, namespace, kind, name));
  }

  argo(): Promise<ArgoSession> {
    this.ctx.scope.argo();
    return Promise.resolve(new ArgoSessionImpl(this.ctx));
  }

  argoApp(name: string): Promise<ArgoAppSession> {
    assertValidName("application", name);
    this.ctx.scope.argoApp(name);
    return Promise.resolve(new ArgoAppSessionImpl(this.ctx, name));
  }
}

// ---------------------------------------------------------------------------
// Verifier (trivial — observers are refused, strategy A).

@validateRpc()
export class K8sVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Configurator UI RPC (empty — the URL-paste form needs no capability).

@validateRpc()
class K8sConfiguratorUI extends RpcTarget {}

// ---------------------------------------------------------------------------
// Gatekeeper DO facet (one per binding / per singleton install).

@validateRpc()
export class K8sGatekeeper
  extends DurableObject<Cloudflare.Env, { accountId: string; resourceUrl?: string }>
  implements Gatekeeper<OpsSession>
{
  async describe(): Promise<ResourceDescription> {
    return {
      url: "k8s://cluster",
      title: "Kubernetes Cluster",
      snippet: "Read cluster state, workloads, logs, events, and ArgoCD applications.",
      suggestedBindingName: "K8S",
      tsType: "OpsSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<OpsSession> {
    const scope = parseScope(this.ctx.props.resourceUrl);
    return new OpsSessionImpl(makeContext(this.env, approvalQueue, scope));
  }

  async getAgentCatalog(
      _request: AgentCatalogRequest,
      _authorizer: NativeRpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog | null> {
    return null;
  }

  /** Refuses sharing: cluster state is private to the workspace owner. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error("This resource cannot be shared; cluster access is private to the owner.");
  }

  /** No observer state is retained. */
  async removeObserver(_id: string): Promise<void> {}

  /** Rejects action application because the K8S gatekeeper is read-only. */
  applyAction(_action: number): Promise<void> {
    throw new Error("The K8S gatekeeper is read-only and implements no actions.");
  }

  /** Rejects action rejection because the K8S gatekeeper submits no actions. */
  rejectAction(_action: number): Promise<void> {
    throw new Error("The K8S gatekeeper is read-only and implements no actions.");
  }

  /** Rejects action reversion because the K8S gatekeeper submits no actions. */
  revertAction(
      _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("The K8S gatekeeper is read-only and implements no actions.");
  }
}

// ---------------------------------------------------------------------------
// Account (auto-provisioned, deployment-level credentials).

type K8sAccountProps = { accountId: string };

@validateRpc()
export class K8sAccount
  extends WorkerEntrypoint<Cloudflare.Env, K8sAccountProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Kubernetes Cluster",
      avatar: K8S_ICON,
      singleton: { tsType: "OpsSession" },
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return RESOURCES;
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<OpsSession>>> {
    return this.ctx.exports.K8sGatekeeper({ props: this.ctx.props });
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    parseScope(url); // Validate before returning a class.
    const resource = RESOURCES.find(r => {
      try {
        const pattern = new URLPattern(r.urlPattern);
        return pattern.test(url) || pattern.test(url + (url.endsWith("/") ? "" : "/"));
      } catch {
        return false;
      }
    });
    if (!resource) throw new Error(`No supported resource matches "${url}".`);
    return {
      class: this.ctx.exports.K8sGatekeeper({
        props: { accountId: this.ctx.props.accountId, resourceUrl: url },
      }),
      resource,
    };
  }

  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    return {
      iframeHtml: K8S_CONFIGURATOR_HTML,
      ui: new NativeRpcStub(new K8sConfiguratorUI()),
    };
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Nothing to revoke: credentials are deployment-level (env), not per-account. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("The K8S gatekeeper has no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the trivial verifier (never consulted — observers are refused). */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.K8sVerifier({}) as unknown as Fetcher<GatekeeperUserVerifier>;
  }
}

// ---------------------------------------------------------------------------
// Vendor.

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Kubernetes Cluster",
      url: "https://kubernetes.io/",
      logo: K8S_ICON,
      tagline: "Read cluster state, workloads, logs, and ArgoCD",
      description:
        "Read-only access to the Kubernetes cluster: nodes, workloads, pods, logs, events, " +
        "resource usage, and ArgoCD application status. No mutating operations.",
      autoProvisionsAccount: true,
    };
  }

  /** Mints a new opaque K8S account capability (deployment-level credentials). */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.K8sAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  /** Rejects interactive connection because K8S is auto-provisioned. */
  connectAccount(
      _callback: Fetcher<GatekeeperConnectCallback>,
      _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("The K8S gatekeeper is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

