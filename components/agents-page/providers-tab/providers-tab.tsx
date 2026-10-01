"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentSwitch, AgentSwitchPanel, OtherAgentTerminalNotice, setupTerminalState } from "@/components/agents-page/agent-switch";
import { LegacyKeyNotice } from "@/components/agents-page/providers-tab/pieces";
import { SetupTerminal } from "@/components/terminal/setup-terminal";
import { useSetupTerminalHost, type SetupAction } from "@/components/agents-page/setup-terminal-host";
import { useSetupAgent } from "@/components/agents-page/use-agents-page-params";
import { useShellFlavor } from "@/hooks/terminal/use-shell-flavor";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import type { AgentStatus } from "@/lib/agents/agent-status";
import {
  providerAddCommand,
  providerRemoveCommand,
  providerReplaceCommand,
  providerSignInCommand,
  providerScriptNames,
  setupScriptUrl,
  type DetectedProviderEntry,
  type ProviderScriptAction,
  type SetupAgentId,
  type SetupCli,
} from "@/lib/agents/setup/commands";
import { explainSetupCommand } from "@/lib/agents/setup/explain";
import { isSetupAgentId, SETUP_AGENTS, setupAgentName } from "@/lib/agents/setup/registry";
import { trackEvent } from "@/lib/analytics/client";
import type { AnalyticsProviderAgent, AnalyticsSurface } from "@/lib/analytics/events";
import { commandNeedsKey, PROVIDER_CATALOG, type ProviderDef, type ProviderId } from "@/lib/providers/catalog";
import type { DetectedMcp } from "@/lib/providers/detect";
import { providerSetupSteps } from "@/lib/providers/setup-steps";
import type { ShellFlavor } from "@/lib/terminal/shell-quote";
import { useAllAgentStatus } from "@/lib/queries/agent-status";
import { useProviders, useRefreshProviders, type ProvidersResponse } from "@/lib/queries/providers";
import { SetupScriptsUnreachableError, useSetupScriptsDir } from "@/lib/queries/setup-scripts";
import type { ChipState } from "@/lib/providers/chip-state";
import { ProviderRow, type RowChip, type RowNotice } from "./provider-row";

/** How detection and analytics name an agent. */
function agentKey(agentId: SetupAgentId): AnalyticsProviderAgent {
  return agentId === "codex" ? "codex" : "claude";
}

/** What the Codex chip says under its Add: where a saved key goes, or the catalog's own note. */
function codexNoteFor(def: ProviderDef, flavor: ShellFlavor | undefined): string | undefined {
  if (!def.codexKeyEnv) return def.codexNote;
  const where = flavor === "powershell" ? "for your Windows user" : "in your shell profile";
  return `Add asks for your key and saves it as ${def.codexKeyEnv} ${where}, where Codex reads it. Restart libi and Codex afterwards.`;
}

/** The entry name the catalog's Codex add gives the provider (`codex mcp add <name> …`). */
function codexEntryName(def: ProviderDef): string | undefined {
  return def.commands ? /^codex mcp add (\S+)/.exec(def.commands.codex)?.[1] : undefined;
}

/**
 * Test mode: libi attaches its stdio fakes to Codex under the real entry names, and codex merges an ACP entry into
 * a config entry of the same name field by field, so a real HTTP entry of that name makes codex refuse its whole
 * config (`TEST_MODE_STDIO_FAKE_NAMES` in lib/mcp-config.ts). No Add of such a provider on Codex, and an entry that
 * is already there is named as the cause.
 */
function testModeCodexNote(
  def: ProviderDef,
  agentId: SetupAgentId,
  model: ChipModel,
  fakes: string[] | undefined,
): { note: string; blocksAdd: boolean } | null {
  if (agentId !== "codex" || !fakes?.length) return null;
  if (model.state === "not-added") {
    const name = codexEntryName(def);
    if (!name || !fakes.includes(name)) return null;
    return {
      note: `Test mode: libi gives Codex its own fake ${def.name} under the name ${name}, and a real ${def.name} entry of that name would make Codex refuse its whole config. Add it outside test mode.`,
      blocksAdd: true,
    };
  }
  if (model.detected?.transport === "http" && fakes.includes(model.detected.name)) {
    return {
      note: `Test mode: this entry has the name libi's fake ${def.name} uses, so Codex refuses its whole config and its chats in libi can't start. Remove it, or run libi outside test mode.`,
      blocksAdd: true,
    };
  }
  return null;
}

/** Whether this agent's add asks for a key: its catalog command carries the key, or Codex reads it from its environment. */
function takesKey(def: ProviderDef, agentId: SetupAgentId): boolean {
  if (!def.commands) return false;
  if (agentId === "codex") return commandNeedsKey(def.commands.codex) || Boolean(def.codexKeyEnv);
  return commandNeedsKey(def.commands.claude);
}

/** On-device extensions are libi's own and live on the Libi MCP tab. */
const REMOTE_PROVIDERS = PROVIDER_CATALOG.filter((d) => d.kind === "remote-mcp");

/** Detection re-reads this often while a command may be running in the tab's terminal. */
const DETECTION_POLL_MS = 3000;
/** And this often while libi is asking Claude Code whether it has signed in to an entry (`signInCheck`). */
const SIGN_IN_CHECK_POLL_MS = 1500;

interface ChipModel {
  state: ChipState;
  cli: SetupCli | null;
  detected: DetectedMcp | null;
  /** What a remove command needs; null for a Claude entry that arrived without its scope. */
  entry: DetectedProviderEntry | null;
  /** Codex only: the state comes from codex's last good listing, not a fresh one. */
  stale: boolean;
}

function readyCli(agentId: SetupAgentId, status: AgentStatus | undefined): SetupCli | null {
  if (!status?.ready || !status.cli || !("realPath" in status.cli)) return null;
  return { agentId, realPath: status.cli.realPath, ...(status.cli.launch ? { launch: status.cli.launch } : {}) };
}

function detectedEntry(agentId: SetupAgentId, detected: DetectedMcp): DetectedProviderEntry | null {
  // The transport tells a remove whether there is a sign-in to clear (a local entry of a sign-in provider has a key).
  if (agentId === "codex") return { agentId: "codex", name: detected.name, transport: detected.transport };
  return detected.scope ? { agentId: "claude-code", name: detected.name, scope: detected.scope, transport: detected.transport } : null;
}

/**
 * The agent status comes first: when it could not be read, nothing below it is
 * known. An agent that is not ready has no CLI to type into. Then detection:
 * an error is not "Not added", and neither is a Codex listing codex gave no
 * answer to. Codex rows served from its last good listing keep their state,
 * marked stale.
 */
function chipModel(
  def: ProviderDef,
  agentId: SetupAgentId,
  statuses: Partial<Record<SetupAgentId, AgentStatus>> | undefined,
  providers: ProvidersResponse | undefined,
): ChipModel {
  const none = { cli: null, detected: null, entry: null, stale: false };
  if (!statuses) return { state: "unknown", ...none };
  const cli = readyCli(agentId, statuses[agentId]);
  if (!cli) return { state: "agent-not-ready", ...none };
  if (!providers || providers.error) return { state: "unknown", ...none, cli };
  if (agentId === "codex" && providers.codex === "unread") return { state: "unknown", ...none, cli };
  const stale = agentId === "codex" && providers.codex === "stale";
  const detected = providers.connected.find((c) => c.agent === agentKey(agentId) && c.providerId === def.id) ?? null;
  if (!detected) return { state: "not-added", ...none, cli, stale };
  // A sign-in libi can't see is never "Connected": the chip says the provider was added and still needs signing in.
  const state: ChipState = detected.status === "connected" && detected.signIn === "unknown" ? "sign-in-unknown" : detected.status;
  return { state, cli, detected, entry: detectedEntry(agentId, detected), stale };
}

/** Where the tab's terminal is shown: the row (and agent) whose action opened it. */
function anchorFor(providerId: ProviderId, agentId: SetupAgentId): string {
  return `${providerId}:${agentId}`;
}

function parseAnchor(anchor: string | undefined): { providerId: ProviderId; agentId: SetupAgentId } | null {
  if (!anchor) return null;
  const [providerId, agentId] = anchor.split(":");
  const def = REMOTE_PROVIDERS.find((d) => d.id === providerId);
  return def && agentId !== undefined && isSetupAgentId(agentId) ? { providerId: def.id, agentId } : null;
}

/** The provider script a terminal was opened for, if it was one. */
function providerAction(action: SetupAction | undefined): ProviderScriptAction | null {
  switch (action) {
    case "provider-add":
    case "provider-replace":
    case "provider-remove":
    case "provider-sign-in":
      return action;
    default:
      return null;
  }
}

/**
 * The line under the row whose add, replace or sign-in is open in the terminal, once detection shows what it did.
 * "Start a new chat" only when the acting agent's entry is Connected. An add or replace of a provider the user
 * signs in to with an account that is not signed in yet says to sign in instead. After a Sign in libi can't see,
 * it says nothing. A chip that lists its setup steps (`stepped`) says what is left in its own next step, so the
 * row adds nothing.
 */
function rowNotice(
  def: ProviderDef,
  agentName: string,
  action: string | null | undefined,
  state: ChipState,
  stepped: boolean,
  launcherAfterStart = false,
): RowNotice | null {
  if (action !== "provider-add" && action !== "provider-replace" && action !== "provider-sign-in") return null;
  // Its launcher came after this agent's process in libi started: the chip says to restart libi, not to start a chat.
  if (state === "connected" && launcherAfterStart) return null;
  if (state === "connected") {
    return { tone: "ready", text: `${def.name} is connected. Start a new chat to use it — an agent loads its MCP servers when a chat starts.` };
  }
  if (action === "provider-sign-in" || stepped) return null;
  if (state === "sign-in-unknown") {
    return {
      tone: "sign-in",
      text: `${def.name} is added to ${agentName}, but it isn't ready until you sign in with your ${def.name} account: click Sign in on ${agentName}, then start a new chat.`,
    };
  }
  if (state === "needs-sign-in") {
    return {
      tone: "sign-in",
      text: `${def.name} is added to ${agentName}, but not signed in yet: finish signing in in your browser, or click Sign in on ${agentName}. Then start a new chat.`,
    };
  }
  return null;
}

/**
 * Third-party providers the user adds to their own agents. libi never writes
 * an agent's config and never takes a key: every Add, Replace and Remove types
 * a short call to one of libi's provider scripts, which runs the agent's own
 * `mcp add` / `mcp remove` / `mcp login`, into this tab's ONE setup terminal, shown inside the
 * row whose action opened it, with a link to read each script it runs. The user
 * decides whether to press Enter. A keyed add reads the key at a hidden prompt
 * inside that script.
 *
 * The tab shows ONE agent at a time, picked with the Claude Code | Codex switch
 * at its top — the selection the setup tabs share (`useSetupAgent`). The
 * terminal, the row notices and Codex's listing banners follow the selection;
 * a terminal left open for the other agent keeps a line that switches back to it.
 *
 * Detection is polled only while that terminal is live. When it ends, detection
 * is re-read once so a finished Add does not keep reading "Not added": an exit
 * or a gone terminal triggers it here; a Close triggers it from the close
 * mutation (`lib/queries/setup-terminals.ts`), after the DELETE that drops the
 * server's detection memo has landed.
 *
 * `?provider=<id>` shows only that row, highlighted, until Show all providers.
 */
export function ProvidersTab({ provider }: { provider: string | null }) {
  const host = useSetupTerminalHost();
  const terminal = host.terminals.providers;
  const terminalLive = Boolean(terminal && !terminal.exited && !terminal.gone);
  const endedTerminalId = terminal && (terminal.exited || terminal.gone) ? terminal.id : null;
  const visible = useDocumentVisible();
  // A Claude sign-in that ends in the terminal is announced by the script, and the server asks Claude Code once
  // then (`lib/providers/sign-in-markers.ts`); the 3 s poll picks the answer up. Opening the tab, or coming back to
  // it, re-asks about an entry not signed in (`revalidateOnLook`).
  const providersQuery = useProviders({
    enabled: visible,
    // While Claude Code is being asked whether it has signed in to an entry, poll until it has answered.
    refetchInterval: (data) =>
      terminalLive ? DETECTION_POLL_MS : data?.connected.some((row) => row.signInCheck === "pending") ? SIGN_IN_CHECK_POLL_MS : false,
    revalidateOnLook: true,
  });
  const statusQuery = useAllAgentStatus();
  const flavor = useShellFlavor().data;
  const scriptsDirQuery = useSetupScriptsDir();
  const scriptsDir = scriptsDirQuery.data;
  const [selectedId, selectAgent] = useSetupAgent();
  const selected = { id: selectedId, name: setupAgentName(selectedId) };
  const { refetch: refetchProviders } = providersQuery;
  const { refetch: refetchStatus } = statusQuery;
  // Retry asks codex again; a plain refetch could be answered from a listing that failed a moment ago.
  const refreshProviders = useRefreshProviders();
  const retryProviders = () => refreshProviders.mutate();

  useEffect(() => {
    if (!endedTerminalId) return;
    void refetchProviders();
  }, [endedTerminalId, refetchProviders]);

  // A new `?provider=` (a deep link while the tab is open) narrows again.
  const [showAll, setShowAll] = useState(false);
  const [prevProvider, setPrevProvider] = useState(provider);
  if (provider !== prevProvider) {
    setPrevProvider(provider);
    setShowAll(false);
  }
  const focused = showAll ? undefined : REMOTE_PROVIDERS.find((d) => d.id === provider);
  const rows = focused ? [focused] : REMOTE_PROVIDERS;

  const latestRun = useRef(0);
  // The add, replace or sign-in whose success the tab is waiting to observe:
  // counted once detection reads `connected` for that provider on that agent,
  // never on the click (the wizard's connect step does the same). A newer
  // command replaces the wait; a remove is never waited on.
  const awaitingConnect = useRef<{ def: ProviderDef; agentId: SetupAgentId; surface: AnalyticsSurface } | null>(null);
  const run = (
    def: ProviderDef,
    agentId: SetupAgentId,
    action: ProviderScriptAction,
    build: (flavor: ShellFlavor, scriptsDir: string) => string | null,
    explain: (flavor: ShellFlavor) => string,
  ) => {
    if (!flavor || !scriptsDir) return;
    let command: string | null;
    try {
      command = build(flavor, scriptsDir);
    } catch {
      // The builder refuses a detected name a terminal line editor would act on.
      toast.error("Couldn't build a command for this entry — its name contains a character a terminal would act on.");
      return;
    }
    if (command === null) return;
    const scripts = providerScriptNames(action, flavor).map((name) => ({ name, url: setupScriptUrl(name) }));
    const runNumber = ++latestRun.current;
    void host
      .open("providers", command, action, anchorFor(def.id, agentId), explain(flavor), scripts)
      .then(() => {
        // Superseded by a newer action before its terminal existed: the host never shows it.
        if (runNumber !== latestRun.current) return;
        // Narrowed to one row by a `libi.suggest_provider` link: the suggestion is what is converting.
        const surface: AnalyticsSurface = focused ? "suggestion" : "providers";
        trackEvent("provider_command_opened", { provider: def.id, agent: agentKey(agentId), surface });
        awaitingConnect.current = action === "provider-remove" ? null : { def, agentId, surface };
      })
      .catch(() => undefined);
  };

  const anchor = parseAnchor(terminal?.anchor);
  const loading = statusQuery.isLoading || providersQuery.isLoading;
  const statusUnreadable = !loading && !statusQuery.data;
  const providers = providersQuery.data;
  // Detection now reads the awaited command's provider as connected on its agent: counted once,
  // then forgotten. A last known (stale) state is not what the command did.
  useEffect(() => {
    const awaited = awaitingConnect.current;
    if (!awaited) return;
    const model = chipModel(awaited.def, awaited.agentId, statusQuery.data, providers);
    if (model.state !== "connected" || model.stale) return;
    awaitingConnect.current = null;
    trackEvent("provider_connected", { provider: awaited.def.id, agent: agentKey(awaited.agentId), surface: awaited.surface });
  }, [providers, statusQuery.data]);
  const detectionUnreadable = !loading && Boolean(providers?.error || (providersQuery.isError && !providers));
  // Codex's listing alone gave no fresh answer: its chips say Unknown (`unread`) or keep their last known state (`stale`).
  const codexListing = loading || detectionUnreadable || selected.id !== "codex" ? undefined : providers?.codex;
  // Every action names a script by this folder: without it they all stay disabled, so say why.
  const scriptsDirUnreadable = scriptsDirQuery.isError && !scriptsDir;
  // The terminal belongs to the agent whose action opened it, and shows in its row only while that agent is shown.
  const otherAgentTerminal = anchor && anchor.agentId !== selected.id ? anchor.agentId : undefined;
  const terminalInARow =
    !loading && anchor !== null && anchor.agentId === selected.id && rows.some((d) => d.id === anchor.providerId);
  // Providers connected on each agent, beside its name in the switch, so the side not shown still says it has
  // something. Unknown counts as none, and none says nothing.
  const hints: Partial<Record<SetupAgentId, string>> = {};
  for (const agent of SETUP_AGENTS) {
    const count = REMOTE_PROVIDERS.filter((def) => chipModel(def, agent.id, statusQuery.data, providers).state === "connected").length;
    if (count > 0) hints[agent.id] = `${count} connected`;
  }

  return (
    <div className="space-y-4">
      <LegacyKeyNotice agent={agentKey(selected.id)} enabled={visible} />

      <AgentSwitch label="Set up providers for" value={selected.id} onValueChange={selectAgent} hints={hints} testIdPrefix="providers">

        {statusUnreadable ? (
          <ReadError testId="providers-status-error" onRetry={() => void refetchStatus()}>
            {"Couldn't read your agents' status."}
          </ReadError>
        ) : null}
        {detectionUnreadable ? (
          <ReadError testId="providers-detect-error" onRetry={retryProviders} pending={refreshProviders.isPending}>
            {"Couldn't read which MCP servers your agents have."}
          </ReadError>
        ) : null}
        {codexListing === "unread" ? (
          <ReadError testId="providers-codex-unread" onRetry={retryProviders} pending={refreshProviders.isPending}>
            {"Couldn't read which MCP servers Codex has: it gave libi no list."}
          </ReadError>
        ) : null}
        {codexListing === "stale" ? (
          <ReadError testId="providers-codex-stale" onRetry={retryProviders} pending={refreshProviders.isPending}>
            {"Couldn't re-read Codex's MCP servers just now, so Codex shows the list it gave earlier."}
          </ReadError>
        ) : null}
        {scriptsDirUnreadable ? (
          <ReadError testId="providers-scripts-error" onRetry={() => void scriptsDirQuery.refetch()}>
            {scriptsDirQuery.error instanceof SetupScriptsUnreachableError
              ? "Couldn't reach libi's setup scripts. Try again; if it keeps happening, restart libi."
              : "Couldn't find libi's setup scripts. Restart libi; if it keeps happening, reinstall it."}
          </ReadError>
        ) : null}

        <AgentSwitchPanel value={selected.id} className="space-y-3">
          {terminal && otherAgentTerminal ? (
            <OtherAgentTerminalNotice
              agentId={otherAgentTerminal}
              state={setupTerminalState(terminal)}
              onShow={() => selectAgent(otherAgentTerminal)}
              testId="providers-other-agent-terminal"
            />
          ) : null}

          {focused ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">Showing {focused.name} only.</p>
              <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => setShowAll(true)}>
                Show all providers
              </Button>
            </div>
          ) : null}

          {loading ? (
            <div className="space-y-3">
              {rows.map((def) => (
                <div key={def.id} className="space-y-3 rounded-lg border border-border p-4">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {rows.map((def) => {
                const agent = selected;
                const docsOnly = !def.commands;
                const model = chipModel(def, agent.id, statusQuery.data, providers);
                const scopeUnreadable = model.detected !== null && model.entry === null;
                // This row's command for the agent shown, while it is open in the tab's terminal.
                const acting = anchor?.providerId === def.id && anchor.agentId === agent.id;
                const liveAction = terminalLive && acting ? providerAction(terminal?.action) : null;
                const steps = providerSetupSteps({
                  def,
                  agentId: agent.id,
                  state: model.state,
                  scopeUnreadable,
                  liveAction,
                  transport: model.detected?.transport,
                });
                const { cli, entry } = model;
                const actionable = !docsOnly && cli !== null;
                const testMode = testModeCodexNote(def, agent.id, model, providers?.testModeCodexFakes);
                // Not signed in, or libi can't see the sign-in: Sign in, with Remove beside it.
                const signInState = model.state === "needs-sign-in" || model.state === "sign-in-unknown";
                // A docs-only provider has nothing to add; it shows the agent only when that agent already has it.
                const chip: RowChip | null =
                  docsOnly && model.detected === null
                    ? null
                    : {
                        agentId: agent.id,
                        agentName: agent.name,
                        state: model.state,
                        scope: agent.id === "claude-code" ? model.detected?.scope : undefined,
                        scopeUnreadable,
                        actionsEnabled: Boolean(flavor && scriptsDir),
                        note: agent.id === "codex" ? codexNoteFor(def, flavor) : undefined,
                        keyed: takesKey(def, agent.id),
                        missingCommand: model.state === "cant-start" ? model.detected?.missingCommand : undefined,
                        windowsHost: flavor === "powershell",
                        stale: model.stale,
                        steps: steps ?? undefined,
                        terminalSubmitted: Boolean(liveAction && terminal?.submitted),
                        signInHint: signInHintFor(model, agent.name, def.name),
                        launcherAfterStart: model.detected?.launcherAfterStart === true,
                        testModeNote: testMode?.note,
                        onRetry: retryProviders,
                        onAdd:
                          actionable && cli && model.state === "not-added" && !testMode?.blocksAdd
                            ? () =>
                                run(def, agent.id, "provider-add", (f, dir) => providerAddCommand(cli, f, def, dir), (f) =>
                                  explainSetupCommand({ action: "provider-add", agentId: agent.id, provider: def, flavor: f }),
                                )
                            : undefined,
                        // Needs key: a new key. Can't start: the catalog's current add in place of an entry whose
                        // launcher is missing. Both are the same remove-then-add script.
                        onReplace:
                          actionable && cli && entry && (model.state === "needs-key" || model.state === "cant-start") && !testMode?.blocksAdd
                            ? () =>
                                run(def, agent.id, "provider-replace", (f, dir) => providerReplaceCommand(cli, f, def, entry, dir), (f) =>
                                  explainSetupCommand({
                                    action: "provider-replace",
                                    agentId: agent.id,
                                    provider: def,
                                    flavor: f,
                                    missingCommand: model.state === "cant-start" ? model.detected?.missingCommand : undefined,
                                  }),
                                )
                            : undefined,
                        onSignIn:
                          actionable && cli && entry && signInState
                            ? () =>
                                run(def, agent.id, "provider-sign-in", (f, dir) => providerSignInCommand(cli, f, entry, def, dir), () =>
                                  explainSetupCommand({ action: "provider-sign-in", agentId: agent.id, provider: def }),
                                )
                            : undefined,
                        onRemove:
                          actionable && cli && entry && (model.state === "connected" || model.state === "cant-start" || signInState)
                            ? () =>
                                run(def, agent.id, "provider-remove", (f, dir) => providerRemoveCommand(cli, f, entry, def, dir), (f) =>
                                  explainSetupCommand({
                                    action: "provider-remove",
                                    agentId: agent.id,
                                    provider: def,
                                    flavor: f,
                                    scope: "scope" in entry ? String(entry.scope) : undefined,
                                    transport: entry.transport,
                                  }),
                                )
                            : undefined,
                      };
                // A last known state is not what the command just did.
                const notice =
                  acting && !model.stale
                    ? rowNotice(def, agent.name, terminal?.action, model.state, steps !== null, model.detected?.launcherAfterStart === true)
                    : null;
                return (
                  <ProviderRow
                    key={def.id}
                    def={def}
                    chip={chip}
                    highlighted={focused?.id === def.id}
                    showTerminal={terminalInARow && acting}
                    notice={notice}
                  />
                );
              })}
            </div>
          )}

          {/* Still one terminal: it is shown here only when its row is not on screen and it belongs to the agent shown. */}
          {terminal && !terminalInARow && !otherAgentTerminal ? <SetupTerminal surface="providers" /> : null}
        </AgentSwitchPanel>
      </AgentSwitch>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Adding a provider changes your agent&apos;s own config. A command that needs a key asks for it at a hidden
        prompt in the terminal — libi never sees it, stores it, or sends it anywhere. A provider you sign in to opens
        your browser, and your agent keeps that sign-in.
      </p>
    </div>
  );
}

/**
 * Why a `sign-in-unknown` chip can't say whether the agent is ready. Claude Code answers when libi asks it
 * (`lib/providers/claude-signin-probe.ts`): while it is being asked, the line says so; when it gave no answer libi
 * could read, and for a Codex entry codex gives no answer for, it says libi can't tell.
 */
function signInHintFor(model: ChipModel, agentName: string, providerName: string): string | undefined {
  if (model.state !== "sign-in-unknown") return undefined;
  if (model.detected?.signInCheck === "pending") return `Asking ${agentName} whether it has signed in to ${providerName}.`;
  return model.detected?.agent === "claude"
    ? `${agentName} didn't say whether it has signed in to ${providerName}. If you already have, it's ready to use.`
    : `libi can't see whether ${agentName} has signed in to ${providerName}. If you already have, it's ready to use.`;
}

function ReadError({
  testId,
  onRetry,
  pending = false,
  children,
}: {
  testId: string;
  onRetry: () => void;
  pending?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-foreground"
    >
      <span>{children}</span>
      <Button variant="outline" size="sm" className="cursor-pointer" disabled={pending} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
