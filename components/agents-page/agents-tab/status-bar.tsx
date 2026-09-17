"use client";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentStatus } from "@/lib/agents/agent-status";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import { useAllAgentStatus } from "@/lib/queries/agent-status";
import { cn } from "@/lib/utils";
import {
  TONE_DOT,
  WIZARD_AGENTS,
  firstIncompleteStep,
  installedLabel,
  installedTone,
  signedInLabel,
  signedInTone,
  type StatusTone,
  type WizardStep,
} from "./wizard-state";

export interface StatusBarProps {
  onOpenWizard: (agent: SetupAgentId, step: WizardStep) => void;
}

/**
 * One row per agent: Installed · Signed in · Ready. Clicking a row
 * opens the setup wizard at that agent's first incomplete step; Set up again
 * opens it at step 1. The two are SIBLING buttons — a control nested inside a
 * button is unreachable by keyboard and invalid markup.
 *
 * A status that could not be read never renders as "not found": nothing about
 * the agent is known then, so the row says so and offers Retry.
 */
export function StatusBar({ onOpenWizard }: StatusBarProps) {
  const { data, isLoading, isFetching, refetch } = useAllAgentStatus();
  const retry = () => void refetch();
  // A refetch of a failed read keeps the error state (and `isLoading` stays
  // false), so without this Retry would look like it did nothing.
  const retryButton = (
    <Button variant="outline" size="sm" className="cursor-pointer" disabled={isFetching} onClick={retry}>
      {isFetching ? "Retrying…" : "Retry"}
    </Button>
  );

  if (isLoading) return <StatusBarSkeleton />;

  if (!data) {
    return (
      <div
        data-testid="agent-status-error"
        className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-foreground"
      >
        <span>{"Couldn't read your agents' status."}</span>
        {retryButton}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="agent-status-bar">
      {WIZARD_AGENTS.map(({ id, name }) => {
        const status = data[id];
        return (
          <div
            key={id}
            data-testid={`agent-status-row-${id}`}
            className="flex min-h-14 items-center gap-2 rounded-lg border border-border p-1.5"
          >
            {status ? (
              <StatusRowButton id={id} name={name} status={status} onOpen={() => onOpenWizard(id, firstIncompleteStep(status))} />
            ) : (
              <div className="flex min-w-0 flex-1 items-center justify-between gap-3 px-2">
                <div className="min-w-0">
                  <div className="text-sm text-foreground">{name}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT.bad)} />
                    <span>{`Couldn't read ${name}'s status`}</span>
                  </div>
                </div>
                {retryButton}
              </div>
            )}
            <Button variant="ghost" size="sm" className="shrink-0 cursor-pointer" onClick={() => onOpenWizard(id, 1)}>
              Set up again
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** The rows' loading layout. The Agents tab shows it too, under its own test id, while it can't yet tell whether rows belong on it at all. */
export function StatusBarSkeleton({ testId = "agent-status-bar" }: { testId?: string }) {
  return (
    <div className="space-y-2" data-testid={testId}>
      {WIZARD_AGENTS.map(({ id }) => (
        <div
          key={id}
          data-testid="agent-status-row-skeleton"
          className="flex min-h-14 items-center gap-2 rounded-lg border border-border p-1.5"
        >
          <div className="flex flex-1 items-center gap-6 px-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-4 w-16" />
          </div>
          <Skeleton className="h-7 w-24" />
        </div>
      ))}
    </div>
  );
}

function StatusRowButton({
  id,
  name,
  status,
  onOpen,
}: {
  id: SetupAgentId;
  name: string;
  status: AgentStatus;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`agent-status-open-${id}`}
      onClick={onOpen}
      className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-6 gap-y-1 rounded-md px-2 py-1 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span className="w-24 shrink-0 text-sm font-medium text-foreground">{name}</span>
      <Cell label="Installed" testId="cell-installed" tone={installedTone(status.cli)} value={installedLabel(status.cli)} />
      <Cell label="Signed in" testId="cell-signed-in" tone={signedInTone(status.signIn)} value={signedInLabel(status.signIn)} />
      <span data-testid="cell-ready" className="flex items-center gap-1.5 text-xs text-foreground">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT[status.ready ? "good" : "neutral"])} />
        {status.ready ? "Ready" : "Not ready"}
      </span>
    </button>
  );
}

function Cell({ label, testId, tone, value }: { label: string; testId: string; tone: StatusTone; value: string }) {
  return (
    <span className="flex flex-col">
      <span className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span data-testid={testId} className="flex items-center gap-1.5 text-xs text-foreground">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone])} />
        {value}
      </span>
    </span>
  );
}
