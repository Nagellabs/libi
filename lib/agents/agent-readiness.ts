/**
 * Is an agent actually usable RIGHT NOW — as distinct from "is it installed".
 *
 * libi already answers "installed" honestly (`detectClaudeCode` / `detectCodex`
 * in lib/agents/acp/agent-registry.ts: bundled adapter + native engine on disk,
 * never a PATH probe). The reported bug was that this single flag was made to
 * answer two more questions it cannot:
 *
 *   1. "is it SIGNED IN?"  — codex ships its engine inside libi, so it is
 *      installed on every machine; an unauthenticated user still reaches
 *      ACP `session/new` and gets `-32000 Authentication required`.
 *   2. "does the USER have their own CLI?" — a different question again, and
 *      the only one that matters for writing MCP config into ~/.codex.
 *
 * THIS MODULE DELIBERATELY DOES NOT PROBE CREDENTIALS. CLAUDE.md is explicit
 * that no cheap boot-time probe can honestly answer "is Claude signed in" —
 * credentials live in the macOS Keychain, ~/.claude/.credentials.json,
 * ANTHROPIC_API_KEY, or Bedrock/Vertex env. Guessing produces exactly the class
 * of lie this module exists to remove. `needs-auth` is therefore only ever set
 * from an OBSERVED auth rejection returned by the agent itself — the handshake
 * is the oracle, and it is free because we were making the call anyway.
 *
 * Dependency-free by design: imported by the SessionManager (Node), the API
 * routes, and the browser bundle.
 */
import type { TerminalRemedy } from "./terminal-remedy";

export type AgentReadiness =
  /** A session has been created since the last failure. */
  | { state: "ready" }
  /**
   * The agent answered an auth challenge negatively. Observed, never inferred.
   * `remedy` is how the user fixes it — see lib/agents/terminal-remedy.ts.
   */
  | { state: "needs-auth"; agentId: string; message: string; remedy: TerminalRemedy | null }
  /** Not on disk. Mirrors the existing detect* `unavailableReason`. */
  | { state: "not-installed"; reason: string }
  /** Nothing has been attempted yet this process. NOT a claim of health. */
  | { state: "unknown" };

export const ACP_AUTH_REQUIRED_CODE = -32000;

/**
 * Does this rejection mean "sign in first"?
 *
 * Duplicated in spirit by `lib/sessions/prompt-error-note.ts#isAuthRequiredError`,
 * which predates this module and is wired only into the PROMPT path. Both match
 * the ACP code and the message text; keep them in agreement.
 */
export function isAuthRequiredError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === ACP_AUTH_REQUIRED_CODE) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /authentication required/i.test(message);
}

/** Whether this readiness permits starting a chat. */
export function readinessAllowsChat(r: AgentReadiness): boolean {
  return r.state === "ready" || r.state === "unknown";
}

/**
 * One-line, user-facing statement of the problem. Returns null when there is
 * nothing to say — callers MUST treat null as "render nothing", never as "".
 */
export function readinessMessage(r: AgentReadiness): string | null {
  switch (r.state) {
    case "needs-auth":
      return r.message;
    case "not-installed":
      return r.reason;
    default:
      return null;
  }
}
