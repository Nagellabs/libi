"use client";

import { useAgentStatusRead, useRecheckAgentCli } from "@/lib/queries/agent-status";
import type { AgentStatus } from "@/lib/agents/agent-status";
import type { SetupAgentId } from "@/lib/agents/setup/commands";

export interface WizardAgentStatus {
  status: AgentStatus | undefined;
  isLoading: boolean;
  /** When the read behind `status` STARTED (ms since epoch, 0 before the first
   *  read). A finished install is judged only by a read that began after it. */
  readStartedAt: number;
  /** Check again: re-resolves the CLI on the server instead of serving its memo. */
  recheck: () => Promise<AgentStatus>;
  rechecking: boolean;
}

/**
 * The setup wizard's view of ONE agent. It polls every 3 s only while a step
 * that waits on the machine is open, and reads `?agent=<id>` alone, so polling
 * one agent never runs the other's CLI.
 */
export function useWizardAgentStatus(agent: SetupAgentId | null, opts: { polling: boolean }): WizardAgentStatus {
  const q = useAgentStatusRead(agent, { refetchInterval: opts.polling ? 3000 : false, enabled: agent !== null });
  const recheck = useRecheckAgentCli();
  return {
    status: q.data?.status,
    isLoading: q.isLoading,
    readStartedAt: q.data?.readStartedAt ?? 0,
    recheck: () =>
      agent ? recheck.mutateAsync(agent).then((read) => read.status) : Promise.reject(new Error("no agent chosen")),
    rechecking: recheck.isPending,
  };
}
