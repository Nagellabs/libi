"use client";

import { useState } from "react";
import { useSetupTerminalHost } from "@/components/agents-page/setup-terminal-host";
import { SetupTerminal } from "@/components/terminal/setup-terminal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useWizardAgentStatus, type WizardAgentStatus } from "@/hooks/agents/use-agent-status";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import { cn } from "@/lib/utils";
import { ChooseStep } from "./steps/choose";
import { InstallStep } from "./steps/install";
import { OpenChatStep } from "./steps/open-chat";
import { SignInStep } from "./steps/sign-in";
import {
  TONE_DOT,
  WIZARD_STEP_TITLES,
  installedLabel,
  installedTone,
  signedInLabel,
  signedInTone,
  wizardAgentName,
  type WizardStep,
} from "./wizard-state";

export interface WizardProps {
  /** `null` only on step 1, before an agent is chosen. */
  agent: SetupAgentId | null;
  step: WizardStep;
  onStep: (step: WizardStep) => void;
  /** Choosing an agent on step 1 moves the wizard to step 2 for it. */
  onAgent: (agent: SetupAgentId) => void;
  /** Absent during a first onboarding, when the wizard is all the tab shows: no Close then. */
  onClose?: () => void;
  /** Called once Open chat has opened the chat — the wizard has reached its end. */
  onFinish?: () => void;
}

/**
 * The setup wizard: which step this is, the live status of the chosen agent,
 * the step itself and, under it, the page's one setup terminal for this tab.
 * libi runs no installer and writes no agent config — every such command is
 * typed into that terminal and the user decides whether to press Enter.
 *
 * That terminal is shown only for the agent whose step opened it. The host
 * keeps one terminal per surface, so without the check a Codex sign-in left
 * open would reappear under Claude Code's wizard, still asking for Enter.
 */
export function Wizard({ agent, step, onStep, onAgent, onClose, onFinish }: WizardProps) {
  // Polls only while a step waits on the machine: an install, or the optional `mcp add` under Open chat.
  const wizardStatus = useWizardAgentStatus(agent, { polling: step === 2 || step === 4 });
  const terminal = useSetupTerminalHost().terminals.agents;
  return (
    <section
      data-testid="agent-wizard"
      aria-labelledby="agent-wizard-title"
      className="space-y-4 rounded-lg border border-border p-4"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {agent ? <p className="text-xs text-muted-foreground">{wizardAgentName(agent)}</p> : null}
          <h2 id="agent-wizard-title" data-testid="agent-wizard-title" className="text-sm font-medium text-foreground">
            Step {step} of 4 — {WIZARD_STEP_TITLES[step]}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {step !== 1 ? (
            <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => onStep(1)}>
              Set up again
            </Button>
          ) : null}
          {onClose ? (
            <Button variant="outline" size="sm" className="cursor-pointer" onClick={onClose}>
              Close
            </Button>
          ) : null}
        </div>
      </header>
      {agent ? <LiveStatus agent={agent} result={wizardStatus} /> : null}
      <div data-testid="agent-wizard-body" className="space-y-4">
        <StepBody
          key={agent ?? "none"}
          agent={agent}
          step={step}
          result={wizardStatus}
          onStep={onStep}
          onAgent={onAgent}
          onFinish={onFinish}
        />
        {agent !== null && terminal?.anchor === agent ? <SetupTerminal surface="agents" /> : null}
      </div>
    </section>
  );
}

function StepBody({
  agent,
  step,
  result,
  onStep,
  onAgent,
  onFinish,
}: {
  agent: SetupAgentId | null;
  step: WizardStep;
  result: WizardAgentStatus;
  onStep: (step: WizardStep) => void;
  onAgent: (agent: SetupAgentId) => void;
  onFinish?: () => void;
}) {
  if (step === 1) return <ChooseStep selected={agent} onAgent={onAgent} />;
  if (!agent) return null;
  const { status, isLoading, recheck, rechecking, readStartedAt } = result;
  // An unreadable status is reported (with Check again) by the live status line above.
  if (!status) return isLoading ? <Skeleton className="h-24 w-full" /> : null;
  switch (step) {
    case 2:
      return (
        <InstallStep
          agent={agent}
          status={status}
          recheck={recheck}
          rechecking={rechecking}
          statusReadStartedAt={readStartedAt}
          onStep={onStep}
        />
      );
    case 3:
      return <SignInStep agent={agent} status={status} onStep={onStep} />;
    case 4:
      return <OpenChatStep agent={agent} status={status} onFinish={onFinish} />;
  }
}

function LiveStatus({ agent, result }: { agent: SetupAgentId; result: WizardAgentStatus }) {
  const { status, isLoading, recheck, rechecking } = result;
  const [recheckFailed, setRecheckFailed] = useState(false);

  if (isLoading) return <Skeleton className="h-5 w-80" />;

  if (!status) {
    const name = wizardAgentName(agent);
    return (
      <div
        data-testid="agent-wizard-status-error"
        className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-foreground"
      >
        <span>{recheckFailed ? `Still couldn't read ${name}'s status.` : `Couldn't read ${name}'s status.`}</span>
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer"
          disabled={rechecking}
          onClick={() => {
            recheck().then(
              () => setRecheckFailed(false),
              () => setRecheckFailed(true),
            );
          }}
        >
          Check again
        </Button>
      </div>
    );
  }

  const items = [
    { label: "Installed", value: installedLabel(status.cli), tone: installedTone(status.cli) },
    { label: "Signed in", value: signedInLabel(status.signIn), tone: signedInTone(status.signIn) },
  ];
  return (
    <ul data-testid="agent-wizard-live-status" className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT[item.tone])} />
          <span className="text-muted-foreground">{item.label}</span>
          <span className="text-foreground">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}
