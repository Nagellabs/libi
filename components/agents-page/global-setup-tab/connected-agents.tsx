"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SetupTerminal } from "@/components/terminal/setup-terminal";
import { AgentSwitch, AgentSwitchPanel, OtherAgentTerminalNotice, setupTerminalState } from "@/components/agents-page/agent-switch";
import { AgentSkillInstalls } from "@/components/agents-page/skills/agent-skill-installs";
import { useSetupTerminalHost, type SetupAction } from "@/components/agents-page/setup-terminal-host";
import { useSetupAgent } from "@/components/agents-page/use-agents-page-params";
import { useShellFlavor } from "@/hooks/terminal/use-shell-flavor";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import type { AgentStatus } from "@/lib/agents/agent-status";
import type { LibiRegistration } from "@/lib/agents/libi-registration";
import {
  connectLibiCommand,
  disconnectLibiCommand,
  reconnectLibiCommand,
  type LibiScope,
  type SetupAgentId,
  type SetupCli,
} from "@/lib/agents/setup/commands";
import { explainSetupCommand } from "@/lib/agents/setup/explain";
import { isSetupAgentId, SETUP_AGENTS, setupAgentName } from "@/lib/agents/setup/registry";
import { useAllAgentStatus } from "@/lib/queries/agent-status";
import { useLibiRegistration, useRefreshLibiRegistration } from "@/lib/queries/libi-registration";
import { useMcpHealth } from "@/lib/queries/mcp-health";
import { cn } from "@/lib/utils";

type Row =
  | { kind: "no-status" }
  | { kind: "no-cli" }
  | { kind: "below-minimum" }
  | { kind: "broken-cli" }
  | { kind: "unknown" }
  | { kind: "not-connected"; cli: SetupCli; stale?: boolean }
  | { kind: "stale-port" | "connected"; cli: SetupCli; scope: LibiScope; claudeScope?: LibiScope; stale?: boolean };

/**
 * What one agent's row shows. The agent status comes first: when it could not
 * be read, nothing below it is known either. Then a usable CLI: without one
 * there is no command to build. A Claude entry has to be removed from the scope it was
 * found in, so a Claude registration that arrives without a scope has no
 * correct Disconnect or Reconnect — it reads as unreadable and offers Retry.
 */
function rowFor(
  agentId: SetupAgentId,
  statuses: Partial<Record<SetupAgentId, AgentStatus>> | undefined,
  reg: LibiRegistration | undefined,
): Row {
  if (!statuses) return { kind: "no-status" };
  const cli = statuses[agentId]?.cli;
  if (cli && "foundButBroken" in cli) return { kind: "broken-cli" };
  if (!cli) return { kind: "no-cli" };
  if (!cli.meetsMinimum) return { kind: "below-minimum" };
  if (!reg || reg.state === "unknown") return { kind: "unknown" };
  const setupCli: SetupCli = { agentId, realPath: cli.realPath };
  const stale = reg.stale === true;
  if (reg.state === "not-connected") return { kind: "not-connected", cli: setupCli, stale };
  if (agentId === "claude-code") {
    if (!reg.scope) return { kind: "unknown" };
    return { kind: reg.state, cli: setupCli, scope: reg.scope, claudeScope: reg.scope, stale };
  }
  // Codex has no scopes — the command builder ignores this value.
  return { kind: reg.state, cli: setupCli, scope: "user", stale };
}

const LABEL: Record<Row["kind"], (name: string) => string> = {
  "no-status": (name) => `Couldn't read ${name}'s status`,
  "no-cli": () => "CLI not installed",
  "below-minimum": () => "CLI needs an update",
  "broken-cli": (name) => `${name} CLI found but won't run`,
  unknown: (name) => `Couldn't read ${name}'s config`,
  "not-connected": () => "Not connected",
  "stale-port": () => "Connected to an old port",
  connected: () => "Connected",
};

const DOT: Record<Row["kind"], string> = {
  "no-status": "bg-destructive",
  "no-cli": "bg-muted-foreground/40",
  "below-minimum": "bg-amber-400",
  "broken-cli": "bg-destructive",
  unknown: "bg-destructive",
  "not-connected": "bg-muted-foreground/40",
  "stale-port": "bg-amber-400",
  connected: "bg-emerald-500",
};

/**
 * Whether libi's endpoint is registered with each of the user's own agents,
 * and libi's skills for them: one agent at a time, picked with the Claude Code
 * | Codex switch the setup tabs share (`useSetupAgent`), as one list — Tools,
 * then Skills. The switch names the agent, so the list has no header of its own.
 * libi never writes that config itself: every action types the agent's own
 * `mcp add` / `mcp remove` into this tab's setup terminal, and the user decides
 * whether to press Enter. The registration is polled only while that terminal
 * is live, i.e. while a command may be running.
 *
 * The poll alone would leave a row stale once the terminal ends: the server
 * memoizes a registration for 5 s and drops that memo only when a setup
 * terminal goes away. So each ending re-reads the registration and the agent
 * status once. A shell that exited, or a terminal the server no longer has, is
 * handled here; a CLOSE is handled by the close mutation itself
 * (`lib/queries/setup-terminals.ts`), because only it knows when the DELETE —
 * the thing that drops the memo — has landed. Re-reading as soon as the entry
 * disappears could reach the server first and read the old memo back.
 *
 * A Codex registration read from codex's last good listing (`stale`, while a
 * slow listing runs or after one failed) keeps that state and its action,
 * marked "last known", with a notice and Retry — the Providers tab's treatment
 * of the same listing. It never reads "Couldn't read" while a good listing
 * exists.
 */
export function ConnectedAgents() {
  const host = useSetupTerminalHost();
  const entry = host.terminals["global-setup"];
  const terminalLive = Boolean(entry && !entry.exited && !entry.gone);
  const endedTerminalId = entry && (entry.exited || entry.gone) ? entry.id : null;
  const statusQuery = useAllAgentStatus();
  const registrationQuery = useLibiRegistration({ refetchInterval: terminalLive ? 3000 : false });
  const { refetch: refetchStatus } = statusQuery;
  const { refetch: refetchRegistration } = registrationQuery;
  // Retry asks codex again; a plain refetch could be answered from a listing that failed a moment ago.
  const refreshRegistration = useRefreshLibiRegistration();

  useEffect(() => {
    if (!endedTerminalId) return;
    void refetchRegistration();
    void refetchStatus();
  }, [endedTerminalId, refetchRegistration, refetchStatus]);
  const flavor = useShellFlavor().data;
  // The CURRENT endpoint URL. The health route always sets `url` but omits
  // `port` on a 503, so the URL is never rebuilt from the port.
  const endpointUrl = useMcpHealth({ enabled: useDocumentVisible() }).data?.url;

  const loading = statusQuery.isLoading || registrationQuery.isLoading;
  const commandsReady = Boolean(flavor && endpointUrl);
  const [id, selectAgent] = useSetupAgent();
  const name = setupAgentName(id);

  // The terminal opens under the tools row of the agent it acts on, so the
  // command sits next to the button that built it.
  const run = (agentId: SetupAgentId, command: string, action: SetupAction, explanation: string) => {
    void host.open("global-setup", command, action, agentId, explanation).catch(() => undefined);
  };

  // The tab's one terminal belongs to the agent whose button opened it, and
  // shows only while that agent is selected; otherwise one line leads back to it.
  const terminalAgent = entry?.anchor && isSetupAgentId(entry.anchor) ? entry.anchor : undefined;
  const otherAgentTerminal = terminalAgent && terminalAgent !== id ? terminalAgent : undefined;
  // "Connected" beside an agent in the switch, so the side not shown still says
  // so. Nothing while loading, or when the status or config can't be read.
  const hints: Partial<Record<SetupAgentId, string>> = {};
  if (!loading) {
    for (const agent of SETUP_AGENTS) {
      if (rowFor(agent.id, statusQuery.data, registrationQuery.data?.[agent.id]).kind === "connected") hints[agent.id] = "Connected";
    }
  }
  const row = rowFor(id, statusQuery.data, registrationQuery.data?.[id]);

  return (
    <AgentSwitch label="Set up libi for" value={id} onValueChange={selectAgent} hints={hints} testIdPrefix="global-setup">
      <AgentSwitchPanel value={id} className="space-y-3">
        {entry && otherAgentTerminal ? (
          <OtherAgentTerminalNotice
            agentId={otherAgentTerminal}
            state={setupTerminalState(entry)}
            onShow={() => selectAgent(otherAgentTerminal)}
            testId="global-setup-other-agent-terminal"
          />
        ) : null}
        {loading ? (
          <div data-testid="global-setup-list-skeleton">
            <div className="space-y-2 pb-4">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-3 w-80 max-w-full" />
              <Skeleton className="h-12 w-full rounded-lg" />
            </div>
            <div className="space-y-2 border-t border-border pt-4">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-3 w-96 max-w-full" />
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
            </div>
          </div>
        ) : (
          // Keyed by agent, so a half-typed folder or an inline error never carries over to the other agent.
          <div key={id} data-testid={`libi-agent-card-${id}`}>
            <section aria-label={`${name} tools`} className="space-y-2 pb-4">
              <SectionHeading title="Tools" description={`Lets ${name} use libi's tools in its own app and terminal, from any folder.`} />
              <div
                data-testid={`libi-agent-row-${id}`}
                className="flex min-h-12 items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm text-foreground">Libi MCP</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[row.kind])} />
                    <span>{LABEL[row.kind](name)}</span>
                    {"claudeScope" in row && row.claudeScope ? <span>· {row.claudeScope} scope</span> : null}
                    {"stale" in row && row.stale ? <span data-testid={`libi-agent-row-${id}-stale`}>· last known</span> : null}
                  </div>
                </div>
                <div className="shrink-0">
                  <RowAction
                    row={row}
                    agentId={id}
                    flavorAndUrl={commandsReady ? { flavor: flavor!, endpointUrl: endpointUrl! } : null}
                    run={(command, action, explanation) => run(id, command, action, explanation)}
                    retryRegistration={() => refreshRegistration.mutate()}
                    retrying={refreshRegistration.isPending}
                    retryStatus={() => void refetchStatus()}
                  />
                </div>
              </div>
              {"stale" in row && row.stale ? (
                <div
                  data-testid={`libi-agent-stale-${id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-foreground"
                >
                  <span>{`Couldn't re-read ${name}'s config just now, so this shows what it said earlier.`}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="cursor-pointer"
                    disabled={refreshRegistration.isPending}
                    onClick={() => refreshRegistration.mutate()}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
              {entry?.anchor === id ? <SetupTerminal surface="global-setup" /> : null}
            </section>
            <section aria-label={`${name} skills`} className="space-y-2 border-t border-border pt-4">
              <SectionHeading
                title="Skills"
                description={`Teach ${name} how to use libi's tools well. Install them for every folder, or only in the folders you choose.`}
              />
              <AgentSkillInstalls agentId={id} name={name} />
            </section>
          </div>
        )}
        {/* A terminal whose button named no agent, or one opened while the list loads. */}
        {entry && !otherAgentTerminal && (loading || !terminalAgent) ? <SetupTerminal surface="global-setup" /> : null}
      </AgentSwitchPanel>
    </AgentSwitch>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-0.5">
      <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function RowAction({
  row,
  agentId,
  flavorAndUrl,
  run,
  retryRegistration,
  retrying,
  retryStatus,
}: {
  row: Row;
  agentId: SetupAgentId;
  flavorAndUrl: { flavor: "posix" | "powershell"; endpointUrl: string } | null;
  run: (command: string, action: SetupAction, explanation: string) => void;
  retryRegistration: () => void;
  retrying: boolean;
  retryStatus: () => void;
}) {
  switch (row.kind) {
    case "no-status":
      return (
        <Button variant="outline" size="sm" className="cursor-pointer" onClick={retryStatus}>
          Retry
        </Button>
      );
    case "no-cli":
    case "below-minimum":
    case "broken-cli":
      return (
        <Link
          href={`/agents?tab=agents&agent=${agentId}`}
          className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline"
        >
          Set up in Agents
        </Link>
      );
    case "unknown":
      return (
        <Button variant="outline" size="sm" className="cursor-pointer" disabled={retrying} onClick={retryRegistration}>
          Retry
        </Button>
      );
    case "not-connected":
      return (
        <Button
          size="sm"
          className="cursor-pointer"
          disabled={!flavorAndUrl}
          onClick={() =>
            flavorAndUrl &&
            run(
              connectLibiCommand(row.cli, flavorAndUrl.flavor, flavorAndUrl.endpointUrl),
              "connect-libi",
              explainSetupCommand({ action: "connect-libi", agentId, endpointUrl: flavorAndUrl.endpointUrl }),
            )
          }
        >
          Connect
        </Button>
      );
    case "stale-port":
      // Built from the current endpoint, never the stale saved URL (for Codex
      // that URL already carries `?agent=codex`, which the builder appends).
      return (
        <Button
          size="sm"
          className="cursor-pointer"
          disabled={!flavorAndUrl}
          onClick={() =>
            flavorAndUrl &&
            run(
              reconnectLibiCommand(row.cli, flavorAndUrl.flavor, flavorAndUrl.endpointUrl, row.scope),
              "reconnect-libi",
              explainSetupCommand({ action: "reconnect-libi", agentId, endpointUrl: flavorAndUrl.endpointUrl, scope: row.scope }),
            )
          }
        >
          Reconnect
        </Button>
      );
    case "connected":
      return (
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer"
          disabled={!flavorAndUrl}
          onClick={() =>
            flavorAndUrl &&
            run(
              disconnectLibiCommand(row.cli, flavorAndUrl.flavor, row.scope),
              "disconnect-libi",
              explainSetupCommand({ action: "disconnect-libi", agentId, scope: row.scope }),
            )
          }
        >
          Disconnect
        </Button>
      );
  }
}
