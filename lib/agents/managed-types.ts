import type { ChildProcess } from "child_process";
import type { ClientSideConnection, AgentCapabilities } from "@agentclientprotocol/sdk";

export interface ManagedProcess {
  agentId: string;
  childProcess: ChildProcess;
  connection: ClientSideConnection;
  agentCapabilities: AgentCapabilities | null;
  /** ACP sessionIds known to this process (for routing ACP events) */
  knownSessionIds: Set<string>;
}

export const ACP_INIT_TIMEOUT_MS = 30 * 1000;
