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
  /** `cant-start` only: the launcher that can't be found, as its bare name (`uvx`). */
  missingCommand?: string;
  /**
   * libi's server runs on Windows (the shell flavor is PowerShell exactly then). There libi and the agents it
   * starts keep the PATH they started with, so a `cant-start` chip adds that a launcher just installed needs a
   * restart of libi.
   */
  windowsHost?: boolean;
  /** `sign-in-unknown` only: the line saying why libi can't tell whether it is ready. */
  signInHint?: string;
  /**
   * `connected` only: its launcher was installed after this agent's process in libi started, which can't run it
   * (detection's `launcherAfterStart`). The chip says to restart libi instead of Connected. Only while a chat is using
   * that process: an idle one is restarted by `GET /api/providers`, which then drops the flag.
   */
  launcherAfterStart?: boolean;
  /** Test mode only: why this agent's add is not offered, or why its entry has to go. Shown in every layout. */
  testModeNote?: string;
  /** Codex only: `state` is from codex's last good listing, not a fresh one. The tab says why. */
  stale?: boolean;
  /**
   * A setup of more than one step (`providerSetupSteps`): the chip lists the
   * steps, each with its own action, instead of one action beside its name.
   */
  steps?: ProviderSetupSteps;
  /**
   * This chip's command is in the tab's terminal AND the user pressed Enter there. Until then a running step says to
   * press Enter; only after it does it say what the command is doing (a browser sign-in).
   */
  terminalSubmitted?: boolean;
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
  "cant-start": "Can't start",
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
  "cant-start": "bg-destructive",
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
  const { providerId, providerName, agentId, agentName, state, scope, scopeUnreadable, note, keyed, signInHint, stale, steps, missingCommand, windowsHost = false, launcherAfterStart = false, testModeNote, onReplace, onRemove } =
    props;
  const restartToUse = state === "connected" && launcherAfterStart;
  return (
    <div
      data-testid={`chip-${providerId}-${agentId}`}
      className="space-y-1.5 rounded-md border border-border px-3 py-2"
    >
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {/* The switch above the rows already names the agent, so the chip starts with its state. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-foreground">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", restartToUse ? "bg-amber-400" : DOT[state])} />
          {restartToUse ? (
            <span>Added · restart libi to use</span>
          ) : state === "cant-start" && missingCommand ? (
            <span>
              {LABEL[state]}: <code className="font-mono text-[0.9em]">{missingCommand}</code> can&apos;t be found
            </span>
          ) : (
            <span>{LABEL[state]}</span>
          )}
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
      {testModeNote ? (
        <p data-testid={`chip-${providerId}-${agentId}-test-mode`} className={noteClass}>
          {testModeNote}
        </p>
      ) : null}
      {steps ? (
        <SteppedSetup {...props} steps={steps} />
      ) : (
        <>
          {scopeUnreadable ? (
            <p className={noteClass}>Couldn&apos;t read its scope, so there is no safe command to remove it yet.</p>
          ) : null}
          {state === "disabled" ? <p className={noteClass}>Enable it in your Codex config.</p> : null}
          {state === "cant-start" && !scopeUnreadable ? (
            <p data-testid={`chip-${providerId}-${agentId}-cant-start`} className={noteClass}>
              {cantStartText(providerName, agentName, missingCommand, Boolean(onReplace), Boolean(onRemove), windowsHost)}
            </p>
          ) : null}
          {state === "sign-in-unknown" && signInHint && !scopeUnreadable ? <p className={noteClass}>{signInHint}</p> : null}
          {restartToUse ? (
            <p data-testid={`chip-${providerId}-${agentId}-restart-to-use`} className={noteClass}>
              libi&apos;s {agentName} was started before the program that runs {providerName}&apos;s MCP server was on its
              PATH, so its chats here can&apos;t start it yet. Restart libi to use it.
            </p>
          ) : null}
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

/** Why a `cant-start` chip's agent has none of the provider's tools, and the way out the chip offers. */
function cantStartText(
  providerName: string,
  agentName: string,
  command: string | undefined,
  canAddAgain: boolean,
  canRemove: boolean,
  windowsHost: boolean,
): string {
  const why = command
    ? `${agentName} can't run ${providerName}'s MCP server without ${command}, and libi can't find ${command} on this computer, so its tools won't show up in your chats.`
    : `${agentName} can't start ${providerName}'s MCP server, so its tools won't show up in your chats.`;
  // Windows: libi and the agents it starts keep the PATH they started with, so a launcher installed since needs a restart.
  const restart = command && windowsHost ? ` If you just installed ${command}, restart libi.` : "";
  const way = canAddAgain
    ? ` Add it again to use libi's current setup for ${providerName}, or remove it.`
    : canRemove
      ? ` Remove it from ${agentName}.`
      : "";
  return `${why}${restart}${way}`;
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

/**
 * While a step's command is live in the terminal: what is left to do there, or in the browser. Before the user has
 * pressed Enter nothing has run, so the line says to press it; a browser sign-in is only claimed after.
 */
const RUNNING_TEXT: Record<SetupStepId, { waiting: string; submitted: string }> = {
  add: { waiting: "Press Enter in the terminal below to run it.", submitted: "Running in the terminal below." },
  "sign-in": {
    waiting: "Press Enter in the terminal below to run it; your browser then opens to sign in.",
    submitted: "Finish signing in in your browser. If it didn't open, or you stopped it, sign in again:",
  },
};

function stepView(step: SetupStep, props: AgentChipProps): SetupStepView {
  const { providerName, agentName, state, actionsEnabled, note, signInHint, steps, terminalSubmitted, onAdd, onSignIn } = props;
  const done = step.status === "done";
  const runningText = RUNNING_TEXT[step.id][terminalSubmitted ? "submitted" : "waiting"];
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
    // While the sign-in runs, the step says what to do in the browser; "didn't say" would contradict it.
    details: !done && step.status !== "running" && state === "sign-in-unknown" && signInHint ? [signInHint] : undefined,
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
  if ((state === "connected" || state === "needs-key" || state === "sign-in-unknown" || state === "cant-start") && scopeUnreadable) {
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
  // Its launcher is missing: add it again with the catalog's current command (the replace flow), or remove it.
  if (state === "cant-start") {
    return (
      <>
        {onReplace ? (
          <Button size="sm" className="cursor-pointer" disabled={!actionsEnabled} onClick={() => onReplace()}>
            Add again on {agentName}
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
