"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSetupTerminalHost } from "@/components/agents-page/setup-terminal-host";
import { Button } from "@/components/ui/button";
import { useShellFlavor } from "@/hooks/terminal/use-shell-flavor";
import { adapterDownloadCopy } from "@/lib/agents/adapter-copy";
import type { AgentStatus } from "@/lib/agents/agent-status";
import { CLAUDE_UPDATE_SUBCOMMAND_EXISTS } from "@/lib/agents/cli/min-versions";
import { installCommand, updateCommand, type SetupAgentId } from "@/lib/agents/setup/commands";
import { explainSetupCommand } from "@/lib/agents/setup/explain";
import { isAgentInstallInFlight, useAgentInstall, useStartAgentInstall } from "@/lib/queries/agent-status";
import { cn } from "@/lib/utils";
import { wizardAgentName, type WizardStep } from "../wizard-state";
import { AdapterDownload, type AdapterDownloadPhase } from "./adapter-download";
import { BUSY_BUTTON_CLASS, BusyLabel } from "./busy-label";
import { cliMeetsMinimum, reportStepCompleted } from "./shared";

/** How long the download may sit on "Starting" before its button becomes Retry
 *  download. A little over one install poll (2 s) plus one status poll (3 s):
 *  a normal hand-off from the start click to the job to the refreshed status
 *  lands well inside it, so Retry only appears when nothing is going to. */
const STALLED_WAIT_MS = 5_000;

export interface InstallStepProps {
  agent: SetupAgentId;
  status: AgentStatus;
  recheck: () => Promise<AgentStatus>;
  rechecking: boolean;
  /** When the read behind `status` STARTED — a finished install is judged only by a read that began after it. */
  statusReadStartedAt: number;
  onStep: (step: WizardStep) => void;
}

/**
 * Find the user's CLI, offer its official installer or updater in the setup
 * terminal, and download libi's support for it (its ACP adapter). Next waits for
 * both: a chat cannot start without the adapter. The CLI line and the download
 * line are worded apart on purpose — a CLI that is already installed must never
 * read as being installed again.
 */
export function InstallStep({ agent, status, recheck, rechecking, statusReadStartedAt, onStep }: InstallStepProps) {
  const name = wizardAgentName(agent);
  const download = adapterDownloadCopy(agent);
  const flavor = useShellFlavor().data;
  const host = useSetupTerminalHost();
  const { cli, adapter } = status;
  const usable = cliMeetsMinimum(cli);
  const belowMinimum = cli !== null && "meetsMinimum" in cli && !cli.meetsMinimum ? cli : null;

  const install = useAgentInstall(agent);
  const startInstall = useStartAgentInstall();
  const { mutate: start } = startInstall;
  const job = install.data?.job ?? null;
  const jobKnown = install.data !== undefined || install.isError;
  const inFlight = isAgentInstallInFlight(job);
  const jobEnded = job?.status === "failed" || job?.status === "cancelled";

  // The adapter install starts on its own at most once per visit to this step.
  // `adapter` only changes when an install SUCCEEDS, so after a failed or
  // cancelled job it still reads "missing" — the job is what says it ended,
  // and only Retry starts it again.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !usable || adapter !== "missing" || !jobKnown || inFlight || jobEnded) return;
    autoStarted.current = true;
    start(agent);
  }, [agent, usable, adapter, jobKnown, inFlight, jobEnded, start]);

  const openCommand = (command: string, explanation: string) => {
    void host.open("agents", command, "install", agent, explanation).catch(() => undefined);
  };

  // A job that finished while the adapter still reads missing: the install left
  // nothing behind, or the server replayed an old success. Without this the step
  // sits on "Starting to download" with no way forward. It counts only once
  // this visit's own start has settled on that very job — a start that queued a
  // fresh job is still on its way — and only against a status read that STARTED
  // after the job completed: a read that began before completion can land after
  // it still saying missing, and must not flash a failure.
  // Typed as a Date, but it arrives over JSON as an ISO string; `new Date` reads either.
  const completedAt = job?.completedAt ? new Date(job.completedAt).getTime() : 0;
  const completedWithoutAdapter =
    job?.status === "completed" &&
    adapter === "missing" &&
    startInstall.data?.jobId === job.id &&
    statusReadStartedAt >= completedAt;

  const installing = inFlight || adapter === "installing" || startInstall.isPending === true;
  // A start that reached the server names a job the install query hasn't caught up
  // with yet. Until it does, the ended job and the adapter state in hand describe the
  // attempt before this one: after Retry they must not flash its failure back.
  const awaitingStartedJob = startInstall.data !== undefined && startInstall.data.jobId !== job?.id;
  const failed =
    !installing &&
    (startInstall.isError === true ||
      (!awaitingStartedJob && (jobEnded || adapter === "failed")) ||
      completedWithoutAdapter);
  const cancelled = job?.status === "cancelled" && startInstall.isError !== true;
  const failureDetail = startInstall.error?.message ?? (cancelled ? null : job?.error ?? null);
  // "Starting" must never be a dead end. It is normally a moment between the
  // start click, the job and the refreshed status, but some waits resolve to
  // nothing: two wizards on one agent, where the other window forced a newer job
  // that also left no adapter, so this window's own start never matches the job
  // it sees. Once a wait has not moved for a few seconds, the primary button becomes
  // Retry download. The wait is identified by what would end it, so any change starts
  // the clock again.
  const waiting = usable && adapter !== "ready" && !installing && !failed;
  const waitKey = `${job?.id ?? ""}|${job?.status ?? ""}|${adapter}|${startInstall.data?.jobId ?? ""}`;
  const [stalledWaitKey, setStalledWaitKey] = useState<string | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setStalledWaitKey(waitKey), STALLED_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting, waitKey]);
  const stalled = waiting && stalledWaitKey === waitKey;

  const measured = inFlight && job && job.progressUnit === "MB" && job.progressTotal > 0 ? job : null;
  const phase: AdapterDownloadPhase | null = !usable
    ? null
    : adapter === "ready"
      ? { kind: "ready" }
      : failed
        ? { kind: "failed", cancelled, detail: failureDetail }
        : installing
          ? {
              kind: "downloading",
              doneMb: measured?.progressDone ?? null,
              totalMb: measured?.progressTotal ?? null,
              etaMs: measured?.etaMs ?? null,
            }
          : {
              kind: "starting",
              requested: startInstall.data !== undefined,
              stalled,
              // A stall after a retry whose job never showed up would otherwise hide what the last attempt reported.
              lastError: stalled && job?.status === "failed" ? job.error : null,
            };
  const retry = phase?.kind === "failed" || (phase?.kind === "starting" && phase.stalled);
  const busyLabel =
    phase?.kind === "downloading" || (phase?.kind === "starting" && !phase.stalled && phase.requested)
      ? "Downloading…"
      : phase?.kind === "starting" && !phase.stalled
        ? "Starting download…"
        : null;

  return (
    <div data-testid="wizard-step-install" className="space-y-3">
      <CliFinding name={name} cli={cli} />

      {phase ? <AdapterDownload copy={download} phase={phase} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        {/* A CLI that won't run has no other way forward from here than its official installer. */}
        {cli === null || "foundButBroken" in cli ? (
          <Button
            size="sm"
            className="cursor-pointer"
            disabled={!flavor}
            onClick={() => flavor && openCommand(installCommand(agent, flavor), explainSetupCommand({ action: "install", agentId: agent, via: "installer" }))}
          >
            {cli === null ? "Install" : "Reinstall"}
          </Button>
        ) : null}
        {belowMinimum ? (
          <Button
            size="sm"
            className="cursor-pointer"
            disabled={!flavor}
            onClick={() =>
              flavor &&
              openCommand(
                updateCommand({ agentId: agent, realPath: belowMinimum.realPath }, flavor, {
                  claudeUpdateExists: CLAUDE_UPDATE_SUBCOMMAND_EXISTS,
                }),
                explainSetupCommand({
                  action: "install",
                  agentId: agent,
                  update: true,
                  via: agent === "claude-code" && CLAUDE_UPDATE_SUBCOMMAND_EXISTS ? "updater" : "installer",
                }),
              )
            }
          >
            Update
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer"
          disabled={rechecking}
          onClick={() => {
            recheck().catch(() => toast.error(`Couldn't check for ${name} again.`));
          }}
        >
          Check again
        </Button>
        {/* One primary button that always says what the step waits on — the download while it runs,
            Retry download when it can't finish on its own, Next once nothing is left. It is one element
            through every state, and aria-disabled (never natively disabled) while busy, so keyboard
            focus on Retry download stays put while it turns into Downloading…. */}
        <Button
          size="sm"
          className={cn("cursor-pointer", BUSY_BUTTON_CLASS)}
          focusableWhenDisabled={busyLabel !== null}
          disabled={busyLabel !== null || (!retry && phase?.kind !== "ready")}
          onClick={() => {
            if (retry) {
              start(agent);
              return;
            }
            reportStepCompleted(agent, "install");
            onStep(3);
          }}
        >
          {busyLabel !== null ? <BusyLabel>{busyLabel}</BusyLabel> : retry ? "Retry download" : "Next"}
        </Button>
      </div>
    </div>
  );
}

function CliFinding({ name, cli }: { name: string; cli: AgentStatus["cli"] }) {
  if (cli === null) {
    return <p className="text-sm text-foreground">{`Couldn't find ${name} on your PATH. Install it?`}</p>;
  }
  if ("foundButBroken" in cli) {
    return (
      <div className="space-y-0.5">
        {/* Not "on your PATH": the resolver also looks in known install folders. */}
        <p className="text-sm font-medium text-foreground">{`${name} is installed but won't run. Reinstall it?`}</p>
        <code className="block break-all font-mono text-xs text-muted-foreground">{cli.path}</code>
        {/* The installer puts a fresh copy in its own folder; a broken copy earlier on PATH still wins. */}
        <p data-testid="wizard-cli-broken-hint" className="text-xs text-muted-foreground">
          If Check again still shows this path after reinstalling, this copy comes first on your PATH — remove or repair it.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <p className={cli.meetsMinimum ? "text-sm text-foreground" : "text-sm font-medium text-foreground"}>
        {cli.meetsMinimum ? `${name} ${cli.version} is installed.` : `${name} ${cli.version} is older than libi needs.`}
      </p>
      <code className="block break-all font-mono text-xs text-muted-foreground">{cli.path}</code>
    </div>
  );
}
