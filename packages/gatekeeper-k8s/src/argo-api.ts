// Read-only ArgoCD REST client for the K8S gatekeeper.
//
// Talks to the ArgoCD API server through the loopback TLS proxy (ARGOCD_API_PROXY) with
// the scoped read-only account token (K8S_ARGOCD_TOKEN). GET-only; the proxy enforces the
// same. Mapping functions are pure and unit-tested.

import type { ArgoAppSummary } from "./types";

// ---------------------------------------------------------------------------
// Minimal raw shapes from the ArgoCD API (only fields we consume).

type RawApplication = {
  metadata?: { name?: string };
  spec?: {
    project?: string;
    destination?: { namespace?: string; server?: string };
    source?: {
      repoURL?: string;
      path?: string;
      targetRevision?: string;
      helm?: { parameters?: { name?: string; value?: string }[] };
    };
  };
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string };
    operationState?: { phase?: string };
    resources?: {
      kind?: string;
      name?: string;
      namespace?: string;
      health?: { status?: string };
    }[];
    conditions?: { type?: string; message?: string }[];
    history?: {
      id?: number;
      revision?: string;
      deployedAt?: string;
      initiatedBy?: { username?: string };
    }[];
  };
};

type RawApplicationList = { items?: RawApplication[] };

type RawProject = {
  metadata?: { name?: string };
  spec?: { sourceRepos?: string[]; clusters?: string[] };
};

type RawProjectList = { items?: RawProject[] };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

// ---------------------------------------------------------------------------
// Mapping functions (pure; unit-tested).

export function mapArgoAppSummary(app: RawApplication): ArgoAppSummary {
  return {
    name: str(app.metadata?.name),
    project: str(app.spec?.project),
    status: str(app.status?.health?.status),
    syncStatus: str(app.status?.sync?.status),
    syncRevision: str(app.status?.sync?.revision),
    targetRevision: str(app.spec?.source?.targetRevision),
    namespace: str(app.spec?.destination?.namespace),
    repoUrl: str(app.spec?.source?.repoURL),
    path: str(app.spec?.source?.path),
    server: str(app.spec?.destination?.server),
  };
}

export function mapArgoAppStatus(app: RawApplication) {
  return {
    name: str(app.metadata?.name),
    health: str(app.status?.health?.status),
    sync: str(app.status?.sync?.status),
    revision: str(app.status?.sync?.revision),
    operationState: app.status?.operationState?.phase
        ? str(app.status?.operationState?.phase)
        : undefined,
    resources: (app.status?.resources ?? []).map(r => ({
      kind: str(r.kind),
      name: str(r.name),
      namespace: str(r.namespace),
      status: str(r.health?.status),
    })),
    conditions: (app.status?.conditions ?? []).map(
        c => `${str(c.type)}=${str(c.message)}`),
    parameters: Object.fromEntries(
        (app.spec?.source?.helm?.parameters ?? []).map(p => [str(p.name), str(p.value)])),
  };
}

export function mapArgoAppHistory(app: RawApplication) {
  return (app.status?.history ?? []).map(h => ({
    id: num(h.id),
    revision: str(h.revision),
    deployedAt: str(h.deployedAt),
    initiatedBy: str(h.initiatedBy?.username) || "unknown",
  }));
}

// ---------------------------------------------------------------------------
// Client.

export type ArgoApiConfig = {
  // Scoped read-only ArgoCD account token (K8S_ARGOCD_TOKEN).
  token: string;
  // Loopback TLS proxy base URL (ARGOCD_API_PROXY), e.g. http://127.0.0.1:8444.
  baseUrl: string;
};

export class ArgoApiClient {
  constructor(private readonly config: ArgoApiConfig) {}

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

  async listApps(): Promise<ArgoAppSummary[]> {
    const raw = await this.get<RawApplicationList>("/api/v1/applications", "Listing ArgoCD applications");
    return (raw.items ?? []).map(mapArgoAppSummary);
  }

  async getApp(name: string) {
    const raw = await this.get<RawApplication>(
        `/api/v1/applications/${encodeURIComponent(name)}`, `Reading ArgoCD application ${name}`);
    return {
      status: mapArgoAppStatus(raw),
      history: mapArgoAppHistory(raw),
    };
  }

  async listProjects(): Promise<{ name: string; sourceRepos: string[]; clusters: string[] }[]> {
    const raw = await this.get<RawProjectList>("/api/v1/projects", "Listing ArgoCD projects");
    return (raw.items ?? []).map(p => ({
      name: str(p.metadata?.name),
      sourceRepos: p.spec?.sourceRepos ?? [],
      clusters: p.spec?.clusters ?? [],
    }));
  }
}
