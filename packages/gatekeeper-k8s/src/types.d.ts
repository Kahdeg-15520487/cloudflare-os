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
