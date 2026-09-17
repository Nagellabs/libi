"use client";

import { useEffect, useRef } from "react";
import { useSetupTerminalHost } from "@/components/agents-page/setup-terminal-host";
import { InstallSkillsStep } from "@/components/agents-page/skills/install-skills-step";
import { Button } from "@/components/ui/button";
import { useShellFlavor } from "@/hooks/terminal/use-shell-flavor";
import type { AgentStatus } from "@/lib/agents/agent-status";
import { connectLibiCommand, reconnectLibiCommand, type LibiScope, type SetupAgentId } from "@/lib/agents/setup/commands";
import { explainSetupCommand } from "@/lib/agents/setup/explain";
import { useMcpHealth } from "@/lib/queries/mcp-health";
import { useRefreshLibiRegistration } from "@/lib/queries/libi-registration";
import { wizardAgentName } from "../wizard-state";
import { reportStepCompleted, setupCliFor } from "./shared";

/**
 * Optional, under Open chat: registers libi's MCP endpoint in the agent's own
 * global config through its `mcp add`, typed into the setup terminal, so the
 * user's Claude Code or Codex app and terminal can use libi's tools. Chats in
 * libi get the tools without it. The wizard polls the agent's status on this
 * step, so "Connected" appears once the user has run the command.
 */
export function ConnectLibiOptional({ agent, status }: { agent: SetupAgentId; status: AgentStatus }) {
  const name = wizardAgentName(agent);
  const flavor = useShellFlavor().data;
  const endpointUrl = useMcpHealth().data?.url;
  const host = useSetupTerminalHost();
  const cli = setupCliFor(agent, status.cli);
  const { state, scope, stale } = status.libiTools;
  const ready = cli && flavor && endpointUrl ? { cli, flavor, endpointUrl } : null;
  const connected = state === "connected";
  // Same Retry as the Global setup card and the Providers tab: forces a fresh codex
  // listing (joining one already running) rather than a plain refetch that could be
  // answered from a listing that just failed.
  const refreshRegistration = useRefreshLibiRegistration();
  // Claude's `mcp remove` has to name the config the entry was found in — a
  // guessed scope can miss the old entry or remove a different one, so with no
  // detected scope Reconnect waits. Codex has no scopes and ignores the value.
  const reconnectScope: LibiScope | null = agent === "claude-code" ? (scope ?? null) : "user";

  // Counted once the entry is observed after the user opened the command here,
  // never on the click alone.
  const requested = useRef(false);
  useEffect(() => {
    if (!connected || !requested.current) return;
    requested.current = false;
    reportStepCompleted(agent, "connect");
  }, [agent, connected]);

  const run = (command: string, action: "connect-libi" | "reconnect-libi", explanation: string) => {
    requested.current = true;
    void host.open("agents", command, action, agent, explanation).catch(() => undefined);
  };

  return (
    <div data-testid="wizard-connect-libi" className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">{`Optional: use libi from your own ${name} app or terminal`}</h3>
      <p data-testid="wizard-connect-state" className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <span>
          {connected
            ? `Connected — ${name} can use libi's tools from its own app and terminal. Manage it on the Global setup tab.`
            : state === "stale-port"
              ? `${name} has libi's tools on an old port. Reconnect points it at this one.`
              : state === "unknown"
                ? `Couldn't read whether ${name} has libi's tools.`
                : `Adds libi's tools to your global ${name} configuration, so ${name} can work on your pieces from its own app or terminal while libi is running. Chats in libi don't need this.`}
        </span>
        {/* Served from Codex's last good listing while a fresh one is slow or failed — the marker the
            Global setup card and the Providers tab use for the same listing. `state === "unknown"` is
            the no-good-listing case and never carries `stale`, so it keeps its own wording above. */}
        {stale ? (
          <span data-testid="wizard-connect-stale" className="inline-flex items-center gap-1.5">
            <span>· last known</span>
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              disabled={refreshRegistration.isPending}
              onClick={() => refreshRegistration.mutate()}
            >
              Retry
            </Button>
          </span>
        ) : null}
      </p>
      {state === "stale-port" && !reconnectScope ? (
        <p data-testid="wizard-reconnect-scope-unknown" className="text-xs text-amber-400">
          {`Couldn't read which config ${name} registered libi in, so Reconnect can't remove the old entry yet. This checks again every few seconds.`}
        </p>
      ) : null}
      {connected ? null : state === "stale-port" ? (
        <Button
          size="sm"
          variant="outline"
          className="cursor-pointer"
          disabled={!ready || !reconnectScope}
          onClick={() =>
            ready &&
            reconnectScope &&
            run(
              reconnectLibiCommand(ready.cli, ready.flavor, ready.endpointUrl, reconnectScope),
              "reconnect-libi",
              explainSetupCommand({ action: "reconnect-libi", agentId: agent, endpointUrl: ready.endpointUrl, scope: reconnectScope }),
            )
          }
        >
          Reconnect
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="cursor-pointer"
          disabled={!ready}
          onClick={() => ready && run(
                connectLibiCommand(ready.cli, ready.flavor, ready.endpointUrl),
                "connect-libi",
                explainSetupCommand({ action: "connect-libi", agentId: agent, endpointUrl: ready.endpointUrl }),
              )}
        >
          Connect
        </Button>
      )}
      {connected ? (
        <div className="border-t border-border pt-3">
          <InstallSkillsStep agent={agent} />
        </div>
      ) : null}
    </div>
  );
}
