"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { AgentStatus } from "@/lib/agents/agent-status";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import { useEditorState } from "@/lib/editor-state-context";
import { cn } from "@/lib/utils";
import { wizardAgentName } from "../wizard-state";
import { BUSY_BUTTON_CLASS, BusyLabel } from "./busy-label";
import { ConnectLibiOptional } from "./connect";
import { reportStepCompleted } from "./shared";

/**
 * The last step: switches libi to the agent, opens a new chat with it and goes
 * to the editor. Under it, the optional global registration for using libi from
 * the agent's own app or terminal.
 */
export function OpenChatStep({
  agent,
  status,
  onFinish,
}: {
  agent: SetupAgentId;
  status: AgentStatus;
  /** Called on the success path only, right before going to the editor. */
  onFinish?: () => void;
}) {
  const name = wizardAgentName(agent);
  const { selectAgent, sessionList, setLastSessionId } = useEditorState();
  const router = useRouter();
  // Starting the agent's process can take several seconds, and opening the chat a few more; each is named on the button.
  const [opening, setOpening] = useState<"starting" | "creating" | null>(null);

  const openChat = async () => {
    setOpening("starting");
    try {
      try {
        await selectAgent(agent);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't start the agent.");
        return;
      }
      setOpening("creating");
      const r = await sessionList.createSessionWithResult();
      if (r.error) {
        toast.error(r.error);
        return;
      }
      if (!r.sessionId) return;
      setLastSessionId(r.sessionId);
      reportStepCompleted(agent, "open-chat");
      onFinish?.();
      router.push("/editor");
    } finally {
      setOpening(null);
    }
  };

  return (
    <div data-testid="wizard-step-open-chat" className="space-y-3">
      <p className="text-sm text-foreground">{`${name} is set up. Open a chat to start working with it.`}</p>
      <Button
        size="sm"
        className={cn("cursor-pointer", BUSY_BUTTON_CLASS)}
        focusableWhenDisabled
        disabled={opening !== null}
        onClick={() => void openChat()}
      >
        {opening === "starting" ? (
          <BusyLabel>{`Starting ${name}…`}</BusyLabel>
        ) : opening === "creating" ? (
          <BusyLabel>Opening chat…</BusyLabel>
        ) : (
          "Open chat"
        )}
      </Button>
      <div className="border-t border-border pt-4">
        <ConnectLibiOptional agent={agent} status={status} />
      </div>
    </div>
  );
}
