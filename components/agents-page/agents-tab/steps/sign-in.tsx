"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useSetupTerminalHost } from "@/components/agents-page/setup-terminal-host";
import { Button } from "@/components/ui/button";
import { useShellFlavor } from "@/hooks/terminal/use-shell-flavor";
import type { AgentStatus } from "@/lib/agents/agent-status";
import { signInCommand, type SetupAgentId } from "@/lib/agents/setup/commands";
import { explainSetupCommand } from "@/lib/agents/setup/explain";
import { useConfirmAgentSignIn } from "@/lib/queries/agent-status";
import { cn } from "@/lib/utils";
import { wizardAgentName, type WizardStep } from "../wizard-state";
import { BUSY_BUTTON_CLASS, BusyLabel } from "./busy-label";
import { reportStepCompleted, setupCliFor } from "./shared";

/**
 * Signing in happens in the agent's own CLI, in the setup terminal. libi reads
 * no credentials and cannot see the result without spending a prompt, so the
 * user's word is what is stored — and it also clears an older observed sign-in
 * rejection.
 */
export function SignInStep({ agent, status, onStep }: { agent: SetupAgentId; status: AgentStatus; onStep: (step: WizardStep) => void }) {
  const name = wizardAgentName(agent);
  const flavor = useShellFlavor().data;
  const host = useSetupTerminalHost();
  const cli = setupCliFor(agent, status.cli);
  const [terminalOpened, setTerminalOpened] = useState(false);
  const confirm = useConfirmAgentSignIn();

  const confirmSignedIn = () =>
    confirm.mutate(agent, {
      onSuccess: () => {
        reportStepCompleted(agent, "sign-in");
        onStep(4);
      },
      onError: () => {
        toast.error(`Couldn't save that you're signed in to ${name}. Try again.`);
      },
    });

  return (
    <div data-testid="wizard-step-sign-in" className="space-y-3">
      <p data-testid="wizard-sign-in-how" className="text-sm text-foreground">
        {agent === "claude-code"
          ? "Click Sign in now to open Claude Code in the terminal below. Type /login there and finish signing in in your browser."
          : "Click Sign in now to run codex login in the terminal below, then finish signing in in your browser."}
      </p>
      <p data-testid="wizard-sign-in-confirm" className="text-xs text-muted-foreground">
        {`libi doesn't read your ${name} credentials, so it can't detect when you've signed in. Confirm it here once you are.`}
      </p>
      {status.signIn.needsAuth ? (
        <p className="text-xs text-amber-400">{`The last time libi used ${name}, it wasn't signed in.`}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="cursor-pointer"
          disabled={!flavor || !cli}
          onClick={() => {
            if (!flavor || !cli) return;
            void host
              .open("agents", signInCommand(cli, flavor), "sign-in", agent, explainSetupCommand({ action: "sign-in", agentId: agent }))
              .then(() => setTerminalOpened(true))
              .catch(() => undefined);
          }}
        >
          Sign in now
        </Button>
        <Button
          size="sm"
          variant="outline"
          className={cn("cursor-pointer", BUSY_BUTTON_CLASS)}
          focusableWhenDisabled
          disabled={confirm.isPending}
          onClick={confirmSignedIn}
        >
          {confirm.isPending ? <BusyLabel>Saving…</BusyLabel> : terminalOpened ? "I've signed in" : "I'm already signed in"}
        </Button>
      </div>
    </div>
  );
}
