// Bridges pi-ai's interactive GitHub Copilot login to the client over RPC. The device code
// pi-ai produces mid-flow is delivered through waitForDeviceCode(); the completed credential
// resolves wait(). The enterprise-domain prompt is answered with the default (github.com);
// Copilot-for-enterprise is not supported by this flow yet.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  CopilotDeviceCode, CopilotLoginAttempt, CopilotLoginResult,
} from "@gadgets/workshop-shared/api";
import { githubCopilotOAuth } from "./copilot-oauth.js";

// The interaction shape pi-ai's login callbacks expect (derived so we never reach into
// pi-ai internals for types).
type AuthInteraction = Parameters<typeof githubCopilotOAuth.login>[0];
// The credential pi-ai produces on a completed login.
type CopilotCredential = Awaited<ReturnType<typeof githubCopilotOAuth.login>>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Returned by AuthenticatedApi.startCopilotLogin(). Holds the login in the user's Durable
// Object; the client awaits the device code and the result through this capability.
@validateRpc()
export class CopilotLoginAttemptImpl extends RpcTarget implements CopilotLoginAttempt {
  readonly #deviceCode = deferred<CopilotDeviceCode>();
  readonly #credential = deferred<CopilotCredential>();
  readonly #result = deferred<CopilotLoginResult>();
  readonly #abort = new AbortController();
  #started = false;

  // The completed credential, for the owning user DO to persist. Never exposed over RPC.
  waitForCredential(): Promise<CopilotCredential> {
    return this.#credential.promise;
  }

  // Runs the pi-ai device flow. Idempotent; called once by the user DO. The flow polls
  // GitHub until the user authorizes (or the code expires), so this lives as long as the
  // client keeps the stub.
  run(): void {
    if (this.#started) return;
    this.#started = true;
    const interaction: AuthInteraction = {
      signal: this.#abort.signal,
      // Individual accounts: no enterprise domain prompt.
      prompt: async () => "",
      notify: (event) => {
        if (event.type === "device_code") {
          this.#deviceCode.resolve({
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            expiresInSeconds: event.expiresInSeconds,
          });
        }
      },
    };
    githubCopilotOAuth.login(interaction).then(
      (credential) => {
        this.#credential.resolve(credential);
        this.#result.resolve({
          availableModelIds: credential.availableModelIds as string[] | undefined,
        });
      },
      (error) => {
        // If the flow failed before any device code arrived, fail that wait too.
        this.#deviceCode.reject(error);
        this.#credential.reject(error);
        this.#result.reject(error);
      },
    );
  }

  async waitForDeviceCode(): Promise<CopilotDeviceCode> {
    return this.#deviceCode.promise;
  }

  async wait(): Promise<CopilotLoginResult> {
    return this.#result.promise;
  }

  async cancel(): Promise<void> {
    this.#abort.abort();
  }
}
