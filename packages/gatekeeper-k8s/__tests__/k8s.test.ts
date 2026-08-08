import { describe, expect, it } from "vitest";
import {
  assertValidName,
  assertWorkloadKind,
  containerInfo,
  humanizeAge,
  mapEvent,
  mapNamespaceSummary,
  mapNodeSummary,
  mapPodSummary,
  mapWorkloadSummary,
} from "../src/k8s-api";
import { mapArgoAppHistory, mapArgoAppStatus, mapArgoAppSummary } from "../src/argo-api";

// Pure mapping/validation tests — no workerd needed.

describe("validation", () => {
  it("accepts valid DNS-1123 labels and rejects invalid ones", () => {
    expect(assertValidName("namespace", "default")).toBe("default");
    expect(assertValidName("namespace", "my-ns2")).toBe("my-ns2");
    expect(() => assertValidName("namespace", "Default")).toThrow(/Invalid/);
    expect(() => assertValidName("namespace", "-bad")).toThrow(/Invalid/);
    expect(() => assertValidName("namespace", "bad-")).toThrow(/Invalid/);
    expect(() => assertValidName("namespace", "a/b")).toThrow(/Invalid/);
  });

  it("accepts pod subdomain names with dots", () => {
    expect(assertValidName("pod", "nginx-abc123", true)).toBe("nginx-abc123");
    expect(assertValidName("pod", "my.pod.name", true)).toBe("my.pod.name");
    expect(() => assertValidName("pod", "UPPER", true)).toThrow(/Invalid/);
  });

  it("restricts workload kinds to the union", () => {
    expect(assertWorkloadKind("deployments")).toBe("deployments");
    expect(assertWorkloadKind("statefulsets")).toBe("statefulsets");
    expect(assertWorkloadKind("daemonsets")).toBe("daemonsets");
    expect(assertWorkloadKind("replicasets")).toBe("replicasets");
    expect(() => assertWorkloadKind("jobs")).toThrow(/Unsupported workload kind/);
    expect(() => assertWorkloadKind("pods")).toThrow(/Unsupported workload kind/);
  });
});

describe("humanizeAge", () => {
  it("formats ages", () => {
    expect(humanizeAge(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m");
    expect(humanizeAge(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe("3h");
    expect(humanizeAge(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe("2d");
    expect(humanizeAge(undefined)).toBe("?");
  });
});

describe("mapPodSummary", () => {
  const pod = {
    metadata: { name: "nginx-abc", namespace: "default", creationTimestamp: "2026-08-01T00:00:00Z" },
    spec: { nodeName: "k3sagent03", containers: [{ name: "nginx" }] },
    status: {
      phase: "Running",
      readyContainers: 1,
      containers: 1,
      containerStatuses: [
        {
          name: "nginx",
          ready: true,
          restartCount: 2,
          state: { running: {} },
        },
      ],
    },
  };

  it("maps a healthy pod", () => {
    const s = mapPodSummary(pod as never);
    expect(s.name).toBe("nginx-abc");
    expect(s.namespace).toBe("default");
    expect(s.node).toBe("k3sagent03");
    expect(s.status).toBe("Running");
    expect(s.ready).toBe("1/1");
    expect(s.restarts).toBe(2);
    expect(s.containers).toEqual(["nginx"]);
  });

  it("detects CrashLoopBackOff", () => {
    const crashy = {
      ...pod,
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "nginx", ready: false, restartCount: 42,
            state: { waiting: { reason: "CrashLoopBackOff" } } },
        ],
      },
    };
    expect(mapPodSummary(crashy as never).status).toBe("CrashLoopBackOff");
    expect(mapPodSummary(crashy as never).ready).toBe("0/1");
  });
});

describe("mapWorkloadSummary", () => {
  it("maps a deployment", () => {
    const wl = {
      metadata: { name: "api", namespace: "default", creationTimestamp: "2026-07-01T00:00:00Z" },
      spec: { replicas: 3, template: { spec: { containers: [{ image: "ghcr.io/x/api:latest" }] } } },
      status: { readyReplicas: 3, availableReplicas: 2 },
    };
    const s = mapWorkloadSummary("deployments", wl as never);
    expect(s.kind).toBe("deployments");
    expect(s.desired).toBe(3);
    expect(s.ready).toBe(3);
    expect(s.available).toBe(2);
    expect(s.image).toBe("ghcr.io/x/api:latest");
  });
});

describe("mapNodeSummary", () => {
  it("maps node role labels and readiness", () => {
    const node = {
      metadata: {
        name: "k3sagent01",
        labels: { "node-role.kubernetes.io/agent": "", "kubernetes.io/hostname": "k3sagent01" },
      },
      spec: { taints: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }] },
      status: {
        conditions: [{ type: "Ready", status: "True" }],
        nodeInfo: { kubeletVersion: "v1.35.5+k3s1" },
        allocatable: { cpu: "3", memory: "3941944Ki" },
        addresses: [{ type: "InternalIP", address: "172.16.2.1" }],
      },
    };
    const s = mapNodeSummary(node as never);
    expect(s.name).toBe("k3sagent01");
    expect(s.status).toBe("Ready");
    expect(s.roles).toEqual(["agent"]);
    expect(s.taints).toEqual(["node-role.kubernetes.io/control-plane"]);
    expect(s.addresses).toEqual(["InternalIP=172.16.2.1"]);
  });
});

describe("mapNamespaceSummary / mapEvent", () => {
  it("maps namespace phase", () => {
    expect(mapNamespaceSummary({ metadata: { name: "default" }, status: { phase: "Active" } } as never))
        .toEqual({ name: "default", status: "Active", labels: {} });
  });

  it("maps events", () => {
    const ev = mapEvent({
      type: "Warning",
      reason: "BackOff",
      message: "Back-off pulling image",
      count: 5,
      lastTimestamp: "2026-08-07T10:00:00Z",
      involvedObject: { kind: "Pod", name: "nginx-abc" },
    } as never);
    expect(ev.object).toBe("Pod/nginx-abc");
    expect(ev.count).toBe(5);
  });
});

describe("containerInfo", () => {
  it("maps running and terminated states", () => {
    expect(containerInfo({ name: "web", ready: true, restartCount: 1, state: { running: {} } } as never))
        .toEqual({ name: "web", image: "", ready: true, restarts: 1, state: "Running" });
    const term = containerInfo({
      name: "web",
      ready: false,
      state: { terminated: { reason: "OOMKilled", exitCode: 137 } },
      lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } },
    } as never);
    expect(term.state).toBe("Terminated");
    expect(term.lastState).toContain("OOMKilled");
  });
});

describe("ArgoCD mappers", () => {
  const app = {
    metadata: { name: "continue-story" },
    spec: {
      project: "default",
      destination: { namespace: "continue-story", server: "https://kubernetes.default.svc" },
      source: {
        repoURL: "https://github.com/Kahdeg-15520487/continue_story",
        path: "k8s",
        targetRevision: "main",
      },
    },
    status: {
      sync: { status: "Synced", revision: "abc123" },
      health: { status: "Healthy" },
      operationState: { phase: "Succeeded" },
      resources: [{ kind: "Deployment", name: "api", namespace: "continue-story", health: { status: "Healthy" } }],
      conditions: [{ type: "DeploymentError", message: "something" }],
      history: [{ id: 5, revision: "abc123", deployedAt: "2026-08-01T00:00:00Z", initiatedBy: { username: "admin" } }],
    },
  };

  it("maps app summary", () => {
    const s = mapArgoAppSummary(app as never);
    expect(s.name).toBe("continue-story");
    expect(s.syncStatus).toBe("Synced");
    expect(s.status).toBe("Healthy");
    expect(s.path).toBe("k8s");
  });

  it("maps detailed status", () => {
    const s = mapArgoAppStatus(app as never);
    expect(s.operationState).toBe("Succeeded");
    expect(s.resources[0].kind).toBe("Deployment");
    expect(s.conditions[0]).toBe("DeploymentError=something");
  });

  it("maps history", () => {
    const h = mapArgoAppHistory(app as never);
    expect(h[0]).toEqual({ id: 5, revision: "abc123", deployedAt: "2026-08-01T00:00:00Z", initiatedBy: "admin" });
  });
});
