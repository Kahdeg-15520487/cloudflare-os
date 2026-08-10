// GitHub Copilot access tokens are short-lived (~30 min). Mint them from the long-lived
// device-flow token (stored as the model config's apiToken) via pi-ai's OAuth refresh, and
// cache per isolate. Multiple isolates may each mint once; the Copilot endpoint tolerates
// it, and the 5-minute safety margin prevents expiry mid-request.

import { githubCopilotOAuth } from "./copilot-oauth.js";

export type CopilotAuth = {
  apiKey: string;
  baseUrl?: string;
};

const cache = new Map<string, { auth: CopilotAuth; expires: number }>();
const inflight = new Map<string, Promise<CopilotAuth>>();

export function getCopilotAuth(refreshToken: string, signal?: AbortSignal): Promise<CopilotAuth> {
  const cached = cache.get(refreshToken);
  if (cached && cached.expires > Date.now() + 5 * 60_000) {
    return Promise.resolve(cached.auth);
  }
  const inflightPromise = inflight.get(refreshToken);
  if (inflightPromise) return inflightPromise;
  const pending = (async () => {
    try {
      const credential = await githubCopilotOAuth.refresh(
          { type: "oauth", refresh: refreshToken, access: "", expires: 0 },
          signal);
      const auth = await githubCopilotOAuth.toAuth(credential);
      if (!auth.apiKey) throw new Error("GitHub Copilot returned no access token.");
      const resolved: CopilotAuth = { apiKey: auth.apiKey, baseUrl: auth.baseUrl };
      cache.set(refreshToken, { auth: resolved, expires: credential.expires });
      return resolved;
    } finally {
      inflight.delete(refreshToken);
    }
  })();
  inflight.set(refreshToken, pending);
  return pending;
}
