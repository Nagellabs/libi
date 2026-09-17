"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import type { ProviderId } from "@/lib/providers/catalog";
import type { ChipState } from "@/lib/providers/chip-state";
import type { SetupStep, SetupStepId, SetupSteps as ProviderSetupSteps } from "@/lib/providers/setup-steps";
import { cn } from "@/lib/utils";
import { SetupSteps, StepButton, type CombinedActionView, type SetupStepView } from "./setup-steps";

export type { ChipState };

export interface AgentChipProps {
  providerId: ProviderId;
  providerName: string;
  agentId: SetupAgentId;
  agentName: string;
  state: ChipState;
  /** Claude only: the config scope the entry was read from. */
  scope?: "user" | "local" | "project";
  /**
   * A Claude entry that arrived without its scope. `claude mcp remove` has to
   * name the scope, so there is no correct Remove or Replace — only Retry.
   */
  scopeUnreadable?: boolean;
  /** False while the shell flavor is unknown: a command built for the wrong shell must not be typed. */
  actionsEnabled: boolean;
  /** A line about this agent's add: under the chip, or under the Add while a stepped setup's add is still to do. */
  note?: string;
  /** This agent's add asks for a key (`takesKey` in providers-tab.tsx): a connected chip says how to change it. */
  keyed?: boolean;
  /** `sign-in-unknown` only: the line saying why libi can't tell whether it is ready. */
  signInHint?: string;
  /** Codex only: `state` is from codex's last good listing, not a fresh one. The tab says why. */
  stale?: boolean;
  /**
   * A setup of more than one step (`providerSetupSteps`): the chip lists the
   * steps, each with its own action, instead of one action beside its name.
   */
  steps?: ProviderSetupSteps;
  onAdd?: () => void;
  onReplace?: () => void;
  onRemove?: () => void;
  onSignIn?: () => void;
  onRetry?: () => void;
}

const LABEL: Record<ChipState, string> = {
  connected: "Connected",
  "needs-key": "Needs key",
  "needs-sign-in": "Sign in needed",
  "sign-in-unknown": "Added · sign in to use",
  disabled: "Disabled",
  "not-added": "Not added",
  "agent-not-ready": "Not set up",
  unknown: "Unknown",
};

const DOT: Record<ChipState, string> = {
  connected: "bg-emerald-500",
  "needs-key": "bg-amber-400",
  "needs-sign-in": "bg-amber-400",
  "sign-in-unknown": "bg-amber-400",
  disabled: "bg-muted-foreground",
  "not-added": "bg-muted-foreground/40",
  "agent-not-ready": "bg-muted-foreground/40",
  unknown: "bg-destructive",
};

const noteClass = "text-[11px] leading-relaxed text-muted-foreground";

/**
 * Every action here only asks the tab to type a command into its setup
 * terminal; the user reads it and decides whether to press Enter.
 */
export function AgentChip(props: AgentChipProps) {
  const { providerId, agentId, agentName, state, scope, scopeUnreadable, note, keyed, signInHint, stale, steps, onRemove } = props;
  return (
    <div
      data-testid={`chip-${providerId}-${agentId}`}
      className="space-y-1.5 rounded-md border border-border px-3 py-2"
    >
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {/* The switch above the rows already names the agent, so the chip starts with its state. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-foreground">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[state])} />
          <span>{LABEL[state]}</span>
          {scope ? <span className="text-muted-foreground">· {scope} scope</span> : null}
          {stale ? (
            <span data-testid={`chip-${providerId}-${agentId}-stale`} className="text-muted-foreground">
              · last known
            </span>
          ) : null}
        </div>
        {steps ? null : (
          // Two actions (Sign in, Remove) wrap under the label on a narrow chip; DOM order is tab order.
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <ChipAction {...props} />
          </div>
        )}
      </div>
      {steps ? (
        <SteppedSetup {...props} steps={steps} />
      ) : (
        <>
          {scopeUnreadable ? (
            <p className={noteClass}>Couldn&apos;t read its scope, so there is no safe command to remove it yet.</p>
          ) : null}
          {state === "disabled" ? <p className={noteClass}>Enable it in your Codex config.</p> : null}
          {state === "sign-in-unknown" && signInHint && !scopeUnreadable ? <p className={noteClass}>{signInHint}</p> : null}
          {/* Nothing reads whether a saved key still works, and there is no key field: a new key is a new add. */}
          {state === "connected" && keyed && onRemove ? (
            <p data-testid={`chip-${providerId}-${agentId}-change-key`} className={noteClass}>
              Need a new key, or this one stopped working? Remove it from {agentName}, then add it again — Add asks for
              your key.
            </p>
          ) : null}
          {note ? <p className={noteClass}>{note}</p> : null}
        </>
      )}
    </div>
  );
}

/**
 * The steps, then Remove once the add is done. An add that performs several
 * steps (`steps.combined`) is one action drawn with the steps it performs;
 * after it, each step left has its own action.
 */
function SteppedSetup(props: AgentChipProps & { steps: ProviderSetupSteps }) {
  const { providerId, agentId, agentName, actionsEnabled, steps, onRemove } = props;
  const addDone = steps.steps.some((s) => s.id === "add" && s.status === "done");
  return (
    <>
      <SetupSteps
        testIdPrefix={`setup-step-${providerId}-${agentId}`}
        steps={steps.steps.map((step) => stepView(step, props))}
        combined={steps.combined ? combinedView(steps.combined, props) : undefined}
      />
      {addDone && onRemove ? (
        <div className="flex justify-end pt-1">
          <StepButton variant="outline" disabled={!actionsEnabled} onClick={() => onRemove()}>
            Remove from {agentName}
          </StepButton>
        </div>
      ) : null}
    </>
  );
}

/** How a step reads inside one action that performs several: its part of the label, and what it does. */
function combinedPart(id: SetupStepId, providerName: string, agentName: string): { label: string; does: string } {
  switch (id) {
    case "add":
      return { label: `Add to ${agentName}`, does: `adds ${providerName}` };
    case "sign-in":
      return { label: "sign in", does: "opens your browser to sign in, and waits until you finish" };
  }
}

/**
 * The one action for the steps an add performs at once (which always starts with the add), labelled and
 * captioned from those steps, so any provider and agent whose add does more than add reads the same way.
 * The agent's note about its add is not repeated beside it: this line says what the add does.
 */
function combinedView(stepIds: SetupStepId[], props: AgentChipProps): CombinedActionView {
  const { providerName, agentName, actionsEnabled, onAdd } = props;
  const parts = stepIds.map((id) => combinedPart(id, providerName, agentName));
  const count = stepIds.length === 2 ? "both steps" : `all ${stepIds.length} steps`;
  return {
    stepIds,
    label: parts.map((p) => p.label).join(" and "),
    enabled: actionsEnabled && Boolean(onAdd),
    onClick: () => onAdd?.(),
    caption: `One command does ${count}: it ${parts.map((p) => p.does).join(", then ")}.`,
  };
}

/** While a step's command is live in the terminal: what is left to do there, or in the browser. */
const RUNNING_TEXT: Record<SetupStepId, string> = {
  add: "Press Enter in the terminal below to run it.",
  "sign-in": "Finish signing in in your browser. If it didn't open, or you stopped it, sign in again:",
};

function stepView(step: SetupStep, props: AgentChipProps): SetupStepView {
  const { providerName, agentName, state, actionsEnabled, note, signInHint, steps, onAdd, onSignIn } = props;
  const done = step.status === "done";
  const runningText = RUNNING_TEXT[step.id];
  if (step.id === "add") {
    return {
      id: step.id,
      status: step.status,
      title: `Add ${providerName} to ${agentName}`,
      description: done
        ? `${providerName}'s MCP server is in ${agentName}'s config.`
        : `Puts ${providerName}'s MCP server in ${agentName}'s config.`,
      runningText,
      action: {
        label: `Add to ${agentName}`,
        doneLabel: `Added to ${agentName}`,
        enabled: actionsEnabled && Boolean(onAdd),
        onClick: () => onAdd?.(),
        // A combined add has its own line under its one action instead.
        caption: done || steps?.combined ? undefined : note,
      },
    };
  }
  const title = `Sign in with your ${providerName} account`;
  // Switched off in the agent's config: nothing to sign in to until it is on again.
  if (state === "disabled") {
    return { id: step.id, status: step.status, title, description: `Enable it in your ${agentName} config.` };
  }
  return {
    id: step.id,
    status: step.status,
    title,
    description: done ? `${agentName} keeps the sign-in.` : "Your browser opens to sign in. Then start a new chat.",
    details: !done && state === "sign-in-unknown" && signInHint ? [signInHint] : undefined,
    runningText,
    action: {
      label: `Sign in on ${agentName}`,
      doneLabel: `Signed in on ${agentName}`,
      enabled: actionsEnabled && Boolean(onSignIn),
      onClick: () => onSignIn?.(),
    },
  };
}

function ChipAction({
  state,
  agentId,
  agentName,
  scopeUnreadable,
  actionsEnabled,
  onAdd,
  onReplace,
  onRemove,
  onSignIn,
  onRetry,
}: AgentChipProps) {
  if (state === "agent-not-ready") {
    return (
      <Link
        href={`/agents?tab=agents&agent=${agentId}`}
        className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline"
      >
        Set up {agentName} first
      </Link>
    );
  }
  if ((state === "connected" || state === "needs-key" || state === "sign-in-unknown") && scopeUnreadable) {
    return onRetry ? (
      <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => onRetry()}>
        Retry
      </Button>
    ) : null;
  }
  if (state === "connected" && onRemove) {
    return (
      <Button variant="outline" size="sm" className="cursor-pointer" disabled={!actionsEnabled} onClick={() => onRemove()}>
        Remove from {agentName}
      </Button>
    );
  }
  if (state === "needs-key" && onReplace) {
    return (
      <Button size="sm" className="cursor-pointer" disabled={!actionsEnabled} onClick={() => onReplace()}>
        Replace on {agentName}
      </Button>
    );
  }
  // Not signed in, or libi can't tell: Sign in, and Remove beside it, so a sign-in the user interrupted or
  // abandoned (Codex writes the entry before its browser sign-in) is never a dead end.
  if (state === "needs-sign-in" || state === "sign-in-unknown") {
    return (
      <>
        {onSignIn ? (
          <Button size="sm" className="cursor-pointer" disabled={!actionsEnabled} onClick={() => onSignIn()}>
            Sign in on {agentName}
          </Button>
        ) : null}
        {onRemove ? (
          <Button variant="outline" size="sm" className="cursor-pointer" disabled={!actionsEnabled} onClick={() => onRemove()}>
            Remove from {agentName}
          </Button>
        ) : null}
      </>
    );
  }
  if (state === "not-added" && onAdd) {
    return (
      <Button size="sm" className="cursor-pointer" disabled={!actionsEnabled} onClick={() => onAdd()}>
        Add to {agentName}
      </Button>
    );
  }
  return null;
}
