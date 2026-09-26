/**
 * "The agent has no history for this chat" — recognised at `session/load`.
 *
 * A chat in libi's sidebar is only a pointer at the AGENT's own transcript
 * (`~/.claude/projects/…/<id>.jsonl` for Claude Code, a rollout under
 * `~/.codex/sessions` for Codex). When that transcript is gone — the user
 * deleted or cleaned it, or it holds only metadata lines — `session/load`
 * rejects, and the rejection used to reach the chat as raw text ("Resource
 * not found: <id>") through both the `agent-status: error` note and the
 * messages route's 500. Nothing can bring the history back, so it is an
 * answer, not a failure: the chat says so plainly and offers a new one.
 *
 * The two adapters answer differently (both checked against the shipped code):
 *
 *   - claude-agent-acp throws `RequestError.resourceNotFound(sessionId)` —
 *     code `-32002`, message `Resource not found: <id>` — when the CLI's
 *     resume finds no conversation.
 *   - codex-acp 1.10.0 passes the app-server's `thread/resume` error through
 *     its generic `errorToResult`, so it arrives as `-32603 Internal error`
 *     with `data.details` = `no rollout found for thread id <id>` (older
 *     app-servers: `… for conversation id <id>`). The code is useless there,
 *     so only the text can classify it.
 */

/** ACP `RequestError.resourceNotFound()` — see @agentclientprotocol/sdk. */
export const ACP_RESOURCE_NOT_FOUND_CODE = -32002;

/** The Codex app-server's answer to `thread/resume` for a thread it has no rollout for. */
const CODEX_NO_ROLLOUT = /no rollout found for (?:thread|conversation) id/i;

/** The sentence the user sees. Also the typed error's message, so any path that
 *  surfaces the message (a restart's failure note) reads plainly too. */
export const HISTORY_MISSING_MESSAGE =
  "This chat's history isn't on this computer any more, so it can't be continued.";

/**
 * True when a `session/load` rejection means the agent has no transcript for
 * the session. Matches the ACP code first (the contract); Codex's text is the
 * fallback because its adapter drops the code.
 */
export function isAgentHistoryMissingError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, message, data } = err as { code?: unknown; message?: unknown; data?: unknown };
  if (code === ACP_RESOURCE_NOT_FOUND_CODE) return true;
  const details =
    typeof data === "object" && data !== null ? (data as { details?: unknown }).details : data;
  return [message, details].some((v) => typeof v === "string" && CODEX_NO_ROLLOUT.test(v));
}

/** Thrown by `SessionManager#activateSession` in place of the adapter's raw rejection. */
export class AgentHistoryMissingError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, options?: { cause?: unknown }) {
    super(HISTORY_MISSING_MESSAGE, options);
    this.name = "AgentHistoryMissingError";
    this.sessionId = sessionId;
  }
}

/**
 * Whether `err` is an `AgentHistoryMissingError`, judged by its name. Not `instanceof`: the session
 * manager is a process-wide singleton built from whichever route bundle loaded it first, and in
 * Next each route bundle gets its own copy of this module, so a route's class is not the one the
 * manager threw with (seen live: the error reached the messages route and missed `instanceof`).
 */
export function isAgentHistoryMissing(err: unknown): err is AgentHistoryMissingError {
  return err instanceof Error && err.name === "AgentHistoryMissingError";
}
