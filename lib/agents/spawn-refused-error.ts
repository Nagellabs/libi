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
