// Read-only Kubernetes REST client for the K8S gatekeeper.
//
// Talks to the k8s API server through the loopback TLS proxy (K8S_API_PROXY) with the
// read-only service-account token (K8S_READ_TOKEN). All methods are GET-only; the proxy
// enforces the same. Mapping functions are pure and unit-tested.

import type {
  ContainerInfo,
  K8sEvent,
  NamespaceSummary,
  NodeSummary,
  PodSummary,
  Usage,
  WorkloadKind,
  WorkloadSummary,
} from "./types";

// ---------------------------------------------------------------------------
// Minimal raw shapes from the Kubernetes API (only fields we consume).

type RawMeta = {
  name?: string;
  namespace?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
};

type RawCondition = { type?: string; status?: string; reason?: string; message?: string };

type RawContainerStatus = {
  name?: string;
  image?: string;
  ready?: boolean;
  restartCount?: number;
  state?: {
    running?: Record<string, unknown>;
    waiting?: { reason?: string; message?: string };
    terminated?: { reason?: string; message?: string; exitCode?: number };
  };
  lastState?: {
    running?: Record<string, unknown>;
    waiting?: { reason?: string; message?: string };
    terminated?: { reason?: string; message?: string; exitCode?: number };
  };
};

type RawPod = {
  metadata?: RawMeta;
  spec?: {
    nodeName?: string;
    containers?: { name?: string; image?: string }[];
    initContainers?: { name?: string; image?: string }[];
  };
  status?: {
    phase?: string;
    qosClass?: string;
    startTime?: string;
    podIP?: string;
    hostIP?: string;
    conditions?: RawCondition[];
    containerStatuses?: RawContainerStatus[];
    initContainerStatuses?: RawContainerStatus[];
    readyContainers?: number;
    containers?: number;
  };
};

type RawWorkload = {
  metadata?: RawMeta;
  spec?: {
    replicas?: number;
    selector?: { matchLabels?: Record<string, string> };
    strategy?: { type?: string };
    template?: { spec?: { containers?: { name?: string; image?: string }[] } };
  };
  status?: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
    conditions?: RawCondition[];
  };
};

type RawNode = {
  metadata?: RawMeta;
  spec?: { taints?: { key?: string; value?: string; effect?: string }[] };
  status?: {
    conditions?: RawCondition[];
    nodeInfo?: { kubeletVersion?: string };
    allocatable?: { cpu?: string; memory?: string };
    addresses?: { type?: string; address?: string }[];
  };
};

type RawNamespace = { metadata?: RawMeta; status?: { phase?: string } };

type RawEvent = {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
  involvedObject?: { kind?: string; name?: string };
};

type RawMetricsList = {
  items?: {
    metadata?: RawMeta;
    usage?: { cpu?: string; memory?: string };
  }[];
};

type RawPodList = { items?: RawPod[] };
type RawWorkloadList = { items?: RawWorkload[] };
type RawNodeList = { items?: RawNode[] };
type RawNamespaceList = { items?: RawNamespace[] };
type RawEventList = { items?: RawEvent[] };

// ---------------------------------------------------------------------------
// Small accessors for optional fields.

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

// ---------------------------------------------------------------------------
// Mapping functions (pure; unit-tested).

export function humanizeAge(iso: string | undefined): string {
  if (!iso) return "?";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "0m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function podStatus(pod: RawPod): string {
  const statuses = pod.status?.containerStatuses ?? [];
  for (const cs of statuses) {
    const reason = cs.state?.waiting?.reason ?? cs.state?.terminated?.reason;
    if (reason === "CrashLoopBackOff" || reason === "ImagePullBackOff" || reason === "ErrImagePull") {
      return reason;
    }
  }
  return str(pod.status?.phase) || "Unknown";
}

export function containerInfo(cs: RawContainerStatus): ContainerInfo {
  const state = cs.state ?? {};
  const stateName = state.running ? "Running" : state.waiting ? "Waiting" : state.terminated ? "Terminated" : "Unknown";
  let lastState: string | undefined;
  const last = cs.lastState ?? {};
  if (last.terminated) {
    lastState = `Terminated (${str(last.terminated.reason) ?? "exit " + num(last.terminated.exitCode)})`;
  } else if (last.waiting) {
    lastState = `Waiting (${str(last.waiting.reason)})`;
  }
  return {
    name: str(cs.name),
    image: str(cs.image),
    ready: cs.ready === true,
    restarts: num(cs.restartCount),
    state: stateName,
    ...(lastState ? { lastState } : {}),
  };
}

export function mapPodSummary(pod: RawPod): PodSummary {
  const cs = pod.status?.containerStatuses ?? [];
  const readyContainers = pod.status?.readyContainers ?? cs.filter(c => c.ready).length;
  const totalContainers = pod.status?.containers ?? cs.length;
  return {
    name: str(pod.metadata?.name),
    namespace: str(pod.metadata?.namespace),
    node: str(pod.spec?.nodeName),
    status: podStatus(pod),
    ready: `${readyContainers}/${totalContainers}`,
    restarts: cs.reduce((sum, c) => sum + num(c.restartCount), 0),
    age: humanizeAge(pod.metadata?.creationTimestamp),
    containers: (pod.spec?.containers ?? []).map(c => str(c.name)),
  };
}

export function mapWorkloadSummary(kind: WorkloadKind, wl: RawWorkload): WorkloadSummary {
  return {
    name: str(wl.metadata?.name),
    namespace: str(wl.metadata?.namespace),
    kind,
    desired: num(wl.spec?.replicas),
    ready: num(wl.status?.readyReplicas),
    available: num(wl.status?.availableReplicas),
    image: str(wl.spec?.template?.spec?.containers?.[0]?.image),
    age: humanizeAge(wl.metadata?.creationTimestamp),
  };
}

export function mapNodeSummary(node: RawNode): NodeSummary {
  const roles: string[] = [];
  for (const [key] of Object.entries(node.metadata?.labels ?? {})) {
    const match = key.match(/^node-role\.kubernetes\.io\/(.+)$/);
    if (match) roles.push(match[1]);
  }
  const readyCondition = (node.status?.conditions ?? []).find(c => c.type === "Ready");
  return {
    name: str(node.metadata?.name),
    status: readyCondition?.status === "True" ? "Ready" : str(readyCondition?.status) || "Unknown",
    roles,
    version: str(node.status?.nodeInfo?.kubeletVersion),
    cpu: str(node.status?.allocatable?.cpu),
    memory: str(node.status?.allocatable?.memory),
    addresses: (node.status?.addresses ?? []).map(a => `${a.type}=${a.address}`),
    taints: (node.spec?.taints ?? []).map(t => str(t.key)),
  };
}

export function mapNamespaceSummary(ns: RawNamespace): NamespaceSummary {
  return {
    name: str(ns.metadata?.name),
    status: str(ns.status?.phase) || "Unknown",
    labels: ns.metadata?.labels ?? {},
  };
}

export function mapEvent(ev: RawEvent): K8sEvent {
  return {
    type: str(ev.type),
    reason: str(ev.reason),
    message: str(ev.message),
    object: `${str(ev.involvedObject?.kind)}/${str(ev.involvedObject?.name)}`,
    count: num(ev.count),
    lastSeen: str(ev.lastTimestamp),
  };
}

export function mapUsage(metrics: RawMetricsList): { name: string; usage: Usage }[] {
  return (metrics.items ?? []).map(item => ({
    name: str(item.metadata?.name),
    usage: {
      cpuUsage: str(item.usage?.cpu),
      memoryUsage: str(item.usage?.memory),
    },
  }));
}

// ---------------------------------------------------------------------------
// Validation (DNS-1123 label / subdomain).

export function isDns1123Label(value: string): boolean {
  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value);
}

export function isDns1123Subdomain(value: string): boolean {
  return /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(value) && value.length <= 253;
}

export function assertValidName(kind: string, value: string, subdomain = false): string {
  const ok = subdomain ? isDns1123Subdomain(value) : isDns1123Label(value);
  if (!ok) {
    throw new Error(`Invalid Kubernetes ${kind} name "${value}".`);
  }
  return value;
}

export const WORKLOAD_KINDS: readonly WorkloadKind[] = [
  "deployments",
  "statefulsets",
  "daemonsets",
  "replicasets",
];

export function assertWorkloadKind(kind: string): WorkloadKind {
  if (!(WORKLOAD_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unsupported workload kind "${kind}".`);
  }
  return kind as WorkloadKind;
}

// ---------------------------------------------------------------------------
// Client.

export type K8sApiConfig = {
  // Read-only service-account token (K8S_READ_TOKEN).
  token: string;
  // Loopback TLS proxy base URL (K8S_API_PROXY), e.g. http://127.0.0.1:8443.
  baseUrl: string;
};

export class K8sApiClient {
  constructor(private readonly config: K8sApiConfig) {}

  private async get<T>(path: string, label: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.config.baseUrl + path, {
        headers: { Authorization: `Bearer ${this.config.token}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new Error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${label} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return res.json() as Promise<T>;
  }

  private async getText(path: string, label: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(this.config.baseUrl + path, {
        headers: { Authorization: `Bearer ${this.config.token}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new Error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${label} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return res.text();
  }

  private static pathEscape(value: string): string {
    return encodeURIComponent(value);
  }

  // --- Cluster scope ------------------------------------------------------

  async listNodes(): Promise<NodeSummary[]> {
    const raw = await this.get<RawNodeList>("/api/v1/nodes", "Listing nodes");
    return (raw.items ?? []).map(mapNodeSummary);
  }

  async listNamespaces(): Promise<NamespaceSummary[]> {
    const raw = await this.get<RawNamespaceList>("/api/v1/namespaces", "Listing namespaces");
    return (raw.items ?? []).map(mapNamespaceSummary);
  }

  async nodeUsage(): Promise<{ node: string; usage: Usage }[]> {
    const raw = await this.get<RawMetricsList>(
        "/apis/metrics.k8s.io/v1beta1/nodes", "Reading node metrics");
    return mapUsage(raw).map(row => ({ node: row.name, usage: row.usage }));
  }

  // --- Namespace scope ----------------------------------------------------

  async listPods(namespace: string): Promise<PodSummary[]> {
    const raw = await this.get<RawPodList>(
        `/api/v1/namespaces/${K8sApiClient.pathEscape(namespace)}/pods`,
        `Listing pods in ${namespace}`);
    return (raw.items ?? []).map(mapPodSummary);
  }

  async listWorkloads(namespace: string, kind: WorkloadKind): Promise<WorkloadSummary[]> {
    const raw = await this.get<RawWorkloadList>(
        `/apis/apps/v1/namespaces/${K8sApiClient.pathEscape(namespace)}/${kind}`,
        `Listing ${kind} in ${namespace}`);
    return (raw.items ?? []).map(item => mapWorkloadSummary(kind, item));
  }

  async listPvc(namespace: string): Promise<{ name: string; status: string; capacity: string; claimClass: string }[]> {
    const raw = await this.get<{ items?: {
      metadata?: RawMeta;
      status?: { phase?: string; capacity?: { storage?: string } };
      spec?: { storageClassName?: string };
    }[] }>(
        `/api/v1/namespaces/${K8sApiClient.pathEscape(namespace)}/persistentvolumeclaims`,
        `Listing PVCs in ${namespace}`);
    return (raw.items ?? []).map(item => ({
      name: str(item.metadata?.name),
      status: str(item.status?.phase),
      capacity: str(item.status?.capacity?.storage),
      claimClass: str(item.spec?.storageClassName),
    }));
  }

  async podUsage(namespace: string): Promise<{ pod: string; usage: Usage }[]> {
    const raw = await this.get<RawMetricsList>(
        `/apis/metrics.k8s.io/v1beta1/namespaces/${K8sApiClient.pathEscape(namespace)}/pods`,
        `Reading pod metrics in ${namespace}`);
    return mapUsage(raw).map(row => ({ pod: row.name, usage: row.usage }));
  }

  // --- Events -------------------------------------------------------------

  async listEvents(
      namespace: string | undefined,
      options: { warningsOnly?: boolean; limit?: number } = {},
  ): Promise<K8sEvent[]> {
    const nsPath = namespace === undefined
        ? "/api/v1/events"
        : `/api/v1/namespaces/${K8sApiClient.pathEscape(namespace)}/events`;
    const raw = await this.get<RawEventList>(nsPath, `Listing events${namespace ? " in " + namespace : ""}`);
    let events = (raw.items ?? []).map(mapEvent);
    if (options.warningsOnly) events = events.filter(e => e.type === "Warning");
    events.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
    if (options.limit !== undefined && options.limit > 0) events = events.slice(0, options.limit);
    return events;
  }

  // --- Pod -----------------------------------------------------------------

  async getPod(namespace: string, name: string): Promise<RawPod> {
    return this.get<RawPod>(
        `/api/v1/namespaces/${K8sApiClient.pathEscape(namespace)}/pods/${K8sApiClient.pathEscape(name)}`,
        `Reading pod ${namespace}/${name}`);
  }

  async getPodLogs(
      namespace: string,
      name: string,
      options: { container?: string; tail?: number; previous?: boolean } = {},
  ): Promise<string> {
    const params = new URLSearchParams();
    if (options.container) params.set("container", options.container);
    if (options.tail !== undefined) params.set("tailLines", String(Math.max(1, Math.min(5000, options.tail))));
    if (options.previous) params.set("previous", "true");
    const query = params.toString();
    return this.getText(
        `/api/v1/namespaces/${K8sApiClient.pathEscape(namespace)}/pods/${K8sApiClient.pathEscape(name)}/log${query ? "?" + query : ""}`,
        `Reading logs of ${namespace}/${name}`);
  }

  // --- Workload -------------------------------------------------------------

  async getWorkload(namespace: string, kind: WorkloadKind, name: string): Promise<RawWorkload> {
    return this.get<RawWorkload>(
        `/apis/apps/v1/namespaces/${K8sApiClient.pathEscape(namespace)}/${kind}/${K8sApiClient.pathEscape(name)}`,
        `Reading ${kind}/${name} in ${namespace}`);
  }

  async getWorkloadPods(namespace: string, selector: Record<string, string>): Promise<PodSummary[]> {
    const labels = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(",");
    const raw = await this.get<RawPodList>(
        `/api/v1/namespaces/${K8sApiClient.pathEscape(namespace)}/pods?labelSelector=${encodeURIComponent(labels)}`,
        `Listing pods selected by workload in ${namespace}`);
    return (raw.items ?? []).map(mapPodSummary);
  }
}
