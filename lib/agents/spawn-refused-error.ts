import type { AgentUnavailableReason } from "@/lib/agents/types";

/**
 * The process manager declined to spawn an agent: its adapter is not on disk, or
 * the user's own CLI for it is missing, broken or older than libi needs. The
 * refusal is itself an observed readiness answer (`not-installed`), so callers
 * branch on the TYPE — never on the message text, which any other error could
 * happen to contain.
 *
 * A LEAF on purpose (types only): the process manager throws it and the session
 * manager catches it, and the process manager must never import the session
 * manager.
 */
export class AgentSpawnRefusedError extends Error {
  readonly agentId: string;
  readonly reason: AgentUnavailableReason;

  constructor(agentId: string, reason: AgentUnavailableReason) {
    // Message format kept for logs and for surfaces that show the error text.
    super(`Agent ${agentId} is not installed: ${reason.message}${reason.detail ? ` (${reason.detail})` : ""}`);
    this.name = "AgentSpawnRefusedError";
    this.agentId = agentId;
    this.reason = reason;
  }
}

/**
 * Whether `err` is an `AgentSpawnRefusedError`, judged by its name (and a `reason` object). Not
 * `instanceof`: the process manager and the session manager are two separate globalThis
 * singletons, each built from whichever route bundle first asked for it, and each Next route
 * bundle has its own copy of this module — so the class the session manager holds need not be
 * the one the process manager threw with.
 */
export function isAgentSpawnRefused(err: unknown): err is AgentSpawnRefusedError {
  if (!(err instanceof Error) || err.name !== "AgentSpawnRefusedError") return false;
  const reason = (err as { reason?: unknown }).reason;
  return typeof reason === "object" && reason !== null;
}
