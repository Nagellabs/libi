"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useEditorState } from "@/lib/editor-state-context";
import { LibiMark } from "@/components/brand/libi-mark";
import { TerminalLogo } from "@/components/brand/agent-logos";
import {
  AgentSetupCard,
  type AgentSetupMode,
  type AgentSetupState,
} from "@/components/agents/agent-setup-card";
import { listAgentSetups } from "@/lib/agents/setup/registry";
import type { AgentSetup } from "@/lib/agents/setup/types";
import { AGENT_DETECT_QUERY_KEY } from "@/lib/queries/agent-setup";
import { useAgentSetupCardState } from "@/hooks/agents/use-agent-setup-card-state";
import { useRunRemedyInTerminal } from "@/hooks/agents/use-run-remedy-in-terminal";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";
import type { TerminalRemedy } from "@/lib/agents/terminal-remedy";

/** The COMMAND libi would actually run to sign this agent in on THIS
 *  machine — only ever populated from an OBSERVED auth rejection
 *  (`needs-auth`), never guessed. Undefined for every other readiness state,
 *  which is exactly what tells the card to fall back to its declaration's
 *  short form. */
function remedyCommand(readiness: AgentReadiness): string | undefined {
  return readiness.state === "needs-auth" ? (readiness.remedy?.command ?? undefined) : undefined;
}

export function OnboardingPanel() {
  const {
    activeProviderId,
    isAgentConnecting,
    selectAgent,
    agentProviders,
    sessionList,
    setRightRegionMode,
  } = useEditorState();

  const { data: detect } = useQuery({
    queryKey: AGENT_DETECT_QUERY_KEY,
    queryFn: async () => (await fetch("/api/agent/detect")).json(),
  });

  const detected: Array<{
    id: string;
    installed: boolean;
    signInRemedy?: TerminalRemedy | null;
  }> = detect?.agents ?? [];
  // The resolved sign-in remedy, straight from detection — available on first
  // paint, unlike readiness, which the client only ever holds for the ACTIVE
  // agent and therefore never has on this screen.
  const signInRemedies = new Map(
    detected.map((a) => [a.id, a.signInRemedy ?? null]),
  );
  const installedSet = new Set(
    detected.filter((a) => a.installed).map((a) => a.id),
  );
  // Before /api/agent/detect resolves, fall back to the providers list (already
  // fetched by the context on mount) so we don't briefly flash "Not installed".
  const availableSet = new Set(
    agentProviders.filter((p) => p.available).map((p) => p.id),
  );
  const isInstalled = (id: string) =>
    detect ? installedSet.has(id) : availableSet.has(id);

  // Tolerate a context that predates readiness (and the mocked contexts in
  // older component tests) rather than crashing the whole panel.
  const readinessFor = sessionList?.readinessFor;

  return (
    <div className="flex h-full w-full overflow-y-auto px-8 py-6 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar]:w-1.5">
      <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-6 lg:max-w-5xl">
        {/* Logo + heading */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="grid size-16 place-items-center rounded-2xl bg-[color:var(--accent-soft)]">
            <LibiMark className="size-9 text-primary" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-primary">
              Last step
            </span>
            <h2 className="font-brand text-2xl font-semibold text-foreground">
              Connect a coding agent
            </h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              You type what you want. The agent builds it. Pick which one.
            </p>
          </div>
        </div>

        {/* Agent cards. Side by side once there is room for it: stacked, the
            two of them plus the Terminal row are ~950px tall, which does not
            fit a 720px-high window — a very ordinary laptop one — and pushed
            the Terminal option below a fold with no visible scrollbar to
            suggest it was there. */}
        <div className="flex w-full flex-col gap-2">
          <div className="grid gap-2 lg:grid-cols-2">
            {listAgentSetups().map((setup) => (
              <OnboardingAgentCard
                key={setup.id}
                setup={setup}
                installed={isInstalled(setup.id)}
                remedy={signInRemedies.get(setup.id) ?? null}
                resolvedCommand={
                  remedyCommand(readinessFor?.(setup.id) ?? { state: "unknown" }) ??
                  signInRemedies.get(setup.id)?.command
                }
              />
            ))}
          </div>

          <div className="my-1 flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          {/* Terminal is the universal fallback — every machine can run a
              shell, so it's always offered even when no coding-agent CLI is
              detected. It is not an ACP agent (getAgentSetup("terminal") is
              null by design) and gets no setup card. */}
          <button
            type="button"
            onClick={() => {
              void selectAgent("terminal")
                .then(() => setRightRegionMode("editor"))
                .catch(() => {
                  /* selectAgent surfaces its own failure; stay put */
                });
            }}
            disabled={isAgentConnecting && activeProviderId === "terminal"}
            className="group flex items-center gap-3 rounded-xl border border-border bg-card/60 px-4 py-3 text-left transition-colors hover:border-primary/50 hover:bg-accent disabled:cursor-default disabled:opacity-70"
          >
            <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-muted-foreground">
              <TerminalLogo className="size-6" />
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">Terminal</span>
              <span className="truncate text-xs text-muted-foreground">
                Run any CLI agent in a real terminal — works on every machine.
              </span>
            </div>
            <span className="ml-auto shrink-0 text-xs font-medium text-primary">
              {isAgentConnecting && activeProviderId === "terminal" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Connect"
              )}
            </span>
          </button>
        </div>

        <p className="max-w-md text-center text-xs text-muted-foreground">
          For AI asset generation (video/image/music) you&rsquo;ll need to supply
          your provider API key. The key stays local — libi will ask you when
          it&rsquo;s needed.
        </p>
      </div>
    </div>
  );
}

/**
 * One agent's card. Split out from OnboardingPanel so the install-status
 * poll (`useAgentInstall`, inside `useAgentSetupCardState`) only runs, per
 * agent, while that agent's card is actually in install mode.
 *
 * Everything about deriving state from the job — progress, cancel-vs-fail,
 * the POST round-trip, the completed-install recovery — lives in
 * `useAgentSetupCardState`, shared with the sidebar and the chat. This
 * component's only job is deciding WHICH MODE this agent is in, which is the
 * part that genuinely differs per surface (here: detection).
 */
function OnboardingAgentCard({
  setup,
  installed,
  remedy,
  resolvedCommand,
}: {
  setup: AgentSetup;
  installed: boolean;
  /** The sign-in command resolved on THIS machine, from `/api/agent/detect`.
   *  Present regardless of readiness, which is the whole point: Claude Code
   *  answers `session/new` with no credentials, so connecting can never tell
   *  us it needs signing in. */
  remedy: TerminalRemedy | null;
  resolvedCommand?: string;
}) {
  // Not installed AND the registry declares an install step ⇒ offer to
  // install. Otherwise (already installed, or the agent ships inside libi
  // and declares `install: null`, e.g. Codex) ⇒ offer to sign in.
  const mode: AgentSetupMode = !installed && setup.install !== null ? "install" : "sign-in";
  const { selectAgent, setRightRegionMode, sessionList } = useEditorState();
  const runRemedyInTerminal = useRunRemedyInTerminal();
  // Covers the whole action, not just the part `isAgentConnecting` sees:
  // selecting the agent AND opening the session. Without it the button went
  // idle again the moment `/api/agent/start` resolved, while the session POST
  // — the slow half, since it may wait on a fresh ACP `newSession` — was
  // still running, and the screen just sat there looking clickable.
  const [startingChat, setStartingChat] = useState(false);
  // Sign-in mode hands the hook the remedy, so its action opens a terminal
  // instead of connecting. Install mode passes none — there is nothing to
  // sign into yet.
  const { state, onAction, onRetry, onCancel } = useAgentSetupCardState(setup.id, mode, {
    surface: "onboarding",
    remedy: mode === "sign-in" ? remedy : null,
  });

  /**
   * The primary action in sign-in mode: connect this agent and land the user
   * in a chat with it, which is the thing they came to this screen to get.
   *
   * It leads because most machines with a coding-agent CLI on them are
   * already signed into it, and libi cannot tell which — so the choice is
   * between making the majority take a detour through a terminal they do not
   * need, and letting the minority find out one click later. The minority
   * path is not a dead end either: Codex rejects at `session/new`, and that
   * OBSERVED rejection carries the remedy, so we go straight on to the
   * terminal rather than dropping someone into a chat that cannot answer.
   * (Claude Code accepts `session/new` unauthenticated and only fails at the
   * first prompt, which is why this can never be a detection.)
   */
  const startChat = async () => {
    setStartingChat(true);
    try {
      const readiness = await selectAgent(setup.id);
      if (readiness?.state === "needs-auth" && readiness.remedy) {
        await runRemedyInTerminal(readiness.remedy, setup.id, "onboarding");
        return;
      }
      // Tolerate a context that predates this (and the mocked contexts in
      // older component tests): the agent is connected either way, so leave
      // the takeover and let the sidebar's "+" open the session.
      const create = sessionList?.createSessionWithResult;
      if (!create) {
        setRightRegionMode("editor");
        return;
      }
      const { sessionId, error } = await create();
      // A failure here is exactly the silent dead end this screen exists to
      // remove — `createError` is rendered by the sidebar, which is not what
      // the user is looking at.
      if (error) {
        toast.error(error);
        return;
      }
      // No id and no error means a create was already in flight; leave the
      // screen alone rather than closing it on someone else's result.
      if (sessionId) setRightRegionMode("editor");
    } catch {
      /* selectAgent surfaces its own failure; stay on the screen */
    } finally {
      setStartingChat(false);
    }
  };

  const cardState: AgentSetupState = startingChat
    ? { kind: "busy", label: "Starting chat…" }
    : state;

  return (
    <AgentSetupCard
      setup={setup}
      mode={mode}
      state={cardState}
      surface="onboarding"
      resolvedCommand={resolvedCommand}
      onStartChat={mode === "sign-in" ? () => void startChat() : undefined}
      onAction={onAction}
      onRetry={onRetry}
      onCancel={onCancel}
    />
  );
}
