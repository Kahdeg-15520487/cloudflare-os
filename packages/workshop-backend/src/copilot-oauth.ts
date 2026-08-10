// pi-ai does not export its OAuth flows as package subpaths, so the GitHub Copilot flow is
// reached through a tsconfig paths alias to the dist file (`pi-ai-copilot-oauth`). All auth
// logic — device flow, token minting, refresh, proxy-endpoint derivation — stays in pi-ai.
// The flow module is fetch-only (no Node builtins), so it bundles cleanly into the worker.
export { githubCopilotOAuth } from "pi-ai-copilot-oauth";
