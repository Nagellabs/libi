/**
 * The outcome types of the user's "Restart session" (`SessionManager.restartSession`). A module of
 * their own so the route can tell a restart's failure apart without importing the session manager
 * itself (which a route test mocks wholesale).
 */

/** Why a restart did not finish. */
export type SessionRestartFailureCode =
  /** libi does not know the chat (a stale page). */
  | "not_found"
  /** The adapter answered, and refused to load the chat. */
  | "load_failed"
  /** The adapter answers nothing, and replacing its process did not help (or was impossible). */
  | "agent_unresponsive"
  /** The adapter answers nothing, and another chat is working on the same process, so it was not
   *  replaced. */
  | "agent_busy"
  /** The whole restart ran past its deadline (`RESTART_DEADLINE_MS`) and was given up. */
  | "timed_out";

/** A restart that did not finish. `message` is for the user: plain words, what to do next. */
export class SessionRestartError extends Error {
  constructor(
    readonly code: SessionRestartFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionRestartError";
  }
}

/**
 * Whether `err` is a `SessionRestartError`, judged by its name (and a string `code`). Not
 * `instanceof`: the session manager is a process-wide singleton built from whichever route bundle
 * loaded it first, and each Next route bundle has its own copy of this module.
 */
export function isSessionRestartError(err: unknown): err is SessionRestartError {
  return (
    err instanceof Error &&
    err.name === "SessionRestartError" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

export interface SessionRestartResult {
  agentId: string;
  /** True when the adapter did not answer and its process was replaced to load the chat. */
  processRestarted: boolean;
}

/** The HTTP status `POST /api/sessions/:id/restart` answers a failed restart with. */
export function restartFailureStatus(code: SessionRestartFailureCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "agent_busy":
      return 409;
    case "agent_unresponsive":
    case "timed_out":
      return 504;
    case "load_failed":
      return 502;
  }
}
