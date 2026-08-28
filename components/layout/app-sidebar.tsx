"use client";

import * as React from "react";
import Link from "next/link";
import { Blocks, BookOpen, Loader2, Plug, Plus, Settings } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { ThemeToggle } from "@/components/layout/theme-toggle";
import { LibiMark } from "@/components/brand/libi-mark";
import AgentSelector from "@/components/sessions/agent-selector";
import SidebarSessionList from "@/components/sessions/sidebar-session-list";
import CliPresetSelector from "@/components/terminal/cli-preset-selector";
import { CodexConnectNudge } from "@/components/sessions/codex-connect-nudge";
import { useEditorState } from "@/lib/editor-state-context";
import { useRuntimeInfo } from "@/lib/queries/runtime";
import {
  blockedShellUpdate,
  isInstallInFlight,
  isShellInstallInFlight,
  restartOffer,
  updateOffer,
  useRuntimeUpdate,
} from "@/lib/queries/runtime-update";
import {
  useCreateTerminal,
  useTerminalSessions,
} from "@/lib/queries/terminals";
import { MAX_TERMINAL_SESSIONS } from "@/lib/terminal/types";
import { readinessMessage } from "@/lib/agents/agent-readiness";
import { getAgentSetup } from "@/lib/agents/setup/registry";
import type { TerminalRemedy } from "@/lib/agents/terminal-remedy";
import { useRunRemedyInTerminal } from "@/hooks/agents/use-run-remedy-in-terminal";
import { toast } from "sonner";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type AppSidebarProps = React.ComponentProps<typeof Sidebar>;

/** How long to wait for a freshly-created terminal's xterm to mount and attach
 *  before pasting the remedy into it. The insert listener is registered in a
 *  `useEffect` keyed on the terminal id (components/terminal/terminal-view.tsx),
 *  so it cannot exist until React has committed that subtree. */


/**
 * A way back to the connect screen, for as long as there is anything to go
 * back to.
 *
 * The connect screen is not a route — it is `rightRegionMode === "onboarding"`
 * inside `/editor`. The mode survives navigation (EditorStateProvider lives at
 * the `(app)` layout and is never unmounted), so the state was never the
 * problem. The problem was that NOTHING in this sidebar navigates to /editor:
 * the libi mark only toggles the sidebar, Instructions/MCPs/Settings are all
 * elsewhere, and a first-run user has no session to click. The one control
 * that does route there is `+`, which starts a chat session — the exact thing
 * that cannot work until an agent is connected.
 *
 * So a user who opened Settings mid-setup was stranded. This row is the way
 * back, and it stops existing the moment `agentEverConnected` flips — it is a
 * task, not a destination.
 */
function SetUpAgentRow(): React.ReactElement | null {
  const { sessionList } = useEditorState();
  // Same query key as the editor page and PersonaModal — one shared fetch.
  const { data, refetch } = useQuery<{ agentEverConnected?: boolean }>({
    queryKey: ["onboarding-state"],
    queryFn: async () => (await fetch("/api/onboarding/state")).json(),
  });

  // `agentEverConnected` flips server-side the first time an agent completes a
  // session, and NOTHING invalidated this key — only the persona modal did. So
  // the row went on offering setup to a user who had just finished it, until
  // a reload. Readiness reaching `ready` is the client-side echo of that same
  // event, and it is already on the context this sidebar reads.
  // Optional chaining: several test doubles for useSessionList predate
  // `readiness`, and an incomplete mock must read as "not ready", not throw.
  const readinessState = sessionList?.readiness?.state;
  React.useEffect(() => {
    if (readinessState !== "ready") return;
    void refetch();
  }, [readinessState, refetch]);
  // A ready agent IS "you have connected one", known client-side and instantly.
  // The refetch above is the durable answer but it races the server write that
  // flips `agentEverConnected`, so on its own the row lingered after a
  // successful connect. This is the immediate one.
  if (readinessState === "ready") return null;
  // Absent data means "not loaded yet", NOT "finished" — rendering the row on
  // a hunch would flash it at every returning user on every cold start.
  if (!data || data.agentEverConnected) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        // The param, rather than a bare /editor link: the user may already
        // have SELECTED an agent that turned out to be signed out, and the
        // editor leaves onboarding as soon as one is selected. Asking for the
        // screen explicitly is what makes the link work in that state.
        render={<Link href="/editor?setup=agent" />}
        tooltip="Finish connecting a coding agent"
        className="cursor-pointer"
      >
        <Plug className="size-4 text-primary" />
        <span>Connect an agent</span>
        <span
          aria-hidden
          className="ml-auto size-1.5 shrink-0 rounded-full bg-primary group-data-[collapsible=icon]:hidden"
        />
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar(props: AppSidebarProps) {
  const { toggleSidebar } = useSidebar();
  const {
    agentProviders,
    activeProviderId,
    isAgentConnecting,
    selectAgent,
    sessionList,
    terminalCliId,
    setActiveTerminalId,
    setRightRegionMode,
  } = useEditorState();
  const pathname = usePathname();
  const router = useRouter();
  const { data: runtime } = useRuntimeInfo();
  // Shared with Settings → General via one React Query key, so the dot and the
  // card can never disagree about whether an update exists.
  const { data: runtimeUpdate } = useRuntimeUpdate();
  // Either channel: a runtime install job, or the shell downloading itself.
  const installingUpdate =
    isInstallInFlight(runtimeUpdate) || isShellInstallInFlight(runtimeUpdate);
  // The dot covers three asks: "restart to apply" (the normal auto-download
  // outcome), the legacy click-to-install offers, and an update this install
  // can't apply from where it's running. The last one is not dismissible —
  // it stays lit until the user moves the app, because it is the only update
  // state they have to act on outside Libi.
  const updateAvailable =
    !installingUpdate &&
    (restartOffer(runtimeUpdate) !== null ||
      updateOffer(runtimeUpdate) !== null ||
      blockedShellUpdate(runtimeUpdate) !== null);
  // Real fraction when the runner reports one; null renders indeterminate.
  const installJob = runtimeUpdate?.install;
  const shellPercent = runtimeUpdate?.shell?.percent ?? null;
  const installFraction = !installingUpdate
    ? null
    : isShellInstallInFlight(runtimeUpdate)
      ? shellPercent !== null
        ? Math.min(1, shellPercent / 100)
        : null
      : installJob && installJob.progressTotal > 0
        ? Math.min(1, installJob.progressDone / installJob.progressTotal)
        : null;
  const worktreeName = runtime?.worktreeName ?? null;

  const isTerminalSurface = activeProviderId === "terminal";
  const { data: terminalSessions } = useTerminalSessions(isTerminalSurface);
  const createTerminal = useCreateTerminal();
  const runRemedyInTerminal = useRunRemedyInTerminal();
  const terminalAtCapacity =
    (terminalSessions?.length ?? 0) >= MAX_TERMINAL_SESSIONS;

  const activeProvider = agentProviders.find((p) => p.id === activeProviderId);

  // Readiness of the agent the server actually has active — see
  // lib/agents/agent-readiness.ts. `needs-auth` is only ever set from an
  // OBSERVED auth rejection, so when it is present we know something concrete
  // and are obliged to say it rather than imply progress.
  const readiness = sessionList.readiness;
  const needsAuth = readiness.state === "needs-auth";
  const authRemedy: TerminalRemedy | null = needsAuth ? readiness.remedy : null;
  // The OBSERVED readiness carries its own agentId — more reliable here than
  // `activeProviderId`, which is optimistic client state. Used only to
  // report the bounded `agent_sign_in_opened` funnel param.
  const authAgentId: string | null = readiness.state === "needs-auth" ? readiness.agentId : null;
  // `not-installed` used to echo the server's raw reason verbatim, which for
  // Claude Code is the sentence Task 10 retires everywhere else — "Claude
  // Code support failed to install — restart libi to retry." — an assertion
  // nobody here can act on (this row has no Install button; the agent
  // dropdown's row does, see components/sessions/agent-selector.tsx). When
  // the not-installed agent declares an install step, point at that real
  // action instead of repeating the dead end. An agent with no declared
  // install step (Codex — libi ships its engine) has nothing to point at, so
  // the server's own reason is still the honest thing to show.
  const readinessNote = (() => {
    if (readiness.state === "not-installed") {
      const setup = activeProviderId ? getAgentSetup(activeProviderId) : null;
      if (setup?.install) {
        return `${setup.name} isn't installed yet — open the agent menu and press Install.`;
      }
    }
    return readinessMessage(readiness);
  })();

  // The dot used to go green the instant `_activeAgentId` was set, which is
  // before anything has been proven — that is how an agent that could never
  // open a session still looked connected. Green now requires a session that
  // exists or one the server says it can hand over immediately.
  const agentProven =
    isTerminalSurface ||
    sessionList.sessions.length > 0 ||
    sessionList.canCreate;
  const agentDotClass = isAgentConnecting
    ? "bg-amber-400 animate-pulse"
    : needsAuth
      ? "bg-amber-400"
      : readiness.state === "not-installed"
        ? "bg-destructive"
        : activeProviderId && agentProven
          ? "bg-emerald-500"
          : "bg-muted-foreground/40";
  const agentTitle = isAgentConnecting
    ? "Connecting agent…"
    : readinessNote
      ? `${activeProvider ? `${activeProvider.name}: ` : ""}${readinessNote} (click to expand)`
      : activeProvider
        ? `Agent: ${activeProvider.name} (click to expand)`
        : "No agent selected (click to expand)";

  const handleNewChat = async () => {
    if (isTerminalSurface) {
      try {
        const meta = await createTerminal.mutateAsync(terminalCliId);
        setActiveTerminalId(meta.id);
        if (pathname !== "/editor") router.push("/editor");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to open terminal",
        );
      }
      return;
    }

    // A session cannot be created while the agent is unauthenticated, so don't
    // fire a POST we know will 500. Do the thing that actually helps instead.
    if (needsAuth) {
      if (authRemedy) {
        await runRemedyInTerminal(authRemedy, authAgentId ?? "", "sidebar");
        return;
      }
      toast.error(readinessNote ?? "This agent needs to be signed in.");
      return;
    }

    const { sessionId, error } = await sessionList.createSessionWithResult();
    if (error) {
      toast.error(error);
      return;
    }
    if (sessionId) {
      // Starting a chat is a way OUT of the connect takeover. Deriving this
      // from "is a session active?" cannot work — that is equally true when
      // the session list merely finishes loading, which slams the screen shut
      // on a deliberate visit. The click is the unambiguous signal.
      setRightRegionMode("editor");
      if (pathname !== "/editor") router.push("/editor");
    }
  };

  // Mid-switch, every input below still describes the PREVIOUS agent, so the
  // button would decide whether it can start a chat — and what its tooltip
  // says — from the wrong agent entirely. The list beside it is showing a
  // skeleton for the same reason.
  const canCreate = isAgentConnecting
    ? false
    : isTerminalSurface
      ? !createTerminal.isPending && !terminalAtCapacity
      : // `needs-auth` deliberately ENABLES the button: it now opens the
        // sign-in remedy. A dead control with an explanation nobody can reach
        // is what we are removing.
        sessionList.canCreate || needsAuth;
  const newButtonLabel = isTerminalSurface ? "New terminal" : "New chat";

  /** What the tooltip says when the button can't (or shouldn't) start a chat.
   *  It must never assert progress for a state that will not finish. */
  const newButtonBlockedLabel = (() => {
    if (isTerminalSurface) {
      return terminalAtCapacity
        ? `Terminal limit reached (${MAX_TERMINAL_SESSIONS}) — close one first`
        : "Opening terminal…";
    }
    if (readinessNote) return readinessNote;
    return "Preparing a new chat session…";
  })();

  /** The tooltip actually rendered — an enabled `needs-auth` button still has
   *  to explain itself, so "enabled" and "nothing to say" are not the same. */
  const newButtonTooltip = (() => {
    if (needsAuth) {
      const problem = readinessNote ?? "This agent needs to be signed in.";
      return authRemedy ? `${problem} — ${authRemedy.label}` : problem;
    }
    return canCreate ? newButtonLabel : newButtonBlockedLabel;
  })();

  return (
    <Sidebar collapsible="icon" {...props}>
      {/* Brand header. Drag region for the window is owned by the
          layout-level <TopBar /> — this row is plain UI. */}
      <SidebarHeader className="px-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={toggleSidebar}
              tooltip={worktreeName ? `libi · worktree: ${worktreeName}` : "libi"}
              className="cursor-pointer group-data-[collapsible=icon]:!p-1.5"
            >
              <LibiMark className="size-5 text-primary shrink-0" />
              <span className="font-brand text-[17px] font-semibold">libi</span>
              {worktreeName ? (
                <span
                  className="ml-1 inline-flex max-w-[180px] items-center rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-amber-400 group-data-[collapsible=icon]:hidden"
                  title={`Worktree: ${worktreeName}`}
                >
                  <span className="truncate">{worktreeName}</span>
                </span>
              ) : null}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="gap-1">
        {/* Setup first, then the selector it makes useful. In the footer this
            row sat among Instructions / MCPs / Settings and read as one more
            page; here it reads as the thing to press before the dropdown below
            it can do anything. */}
        <SidebarGroup className="pb-0">
          <SidebarMenu>
            <SetUpAgentRow />
          </SidebarMenu>
        </SidebarGroup>
        {/* Agent selector — scopes the sessions list below */}
        <SidebarGroup>
          <SidebarGroupLabel className="group-data-[collapsible=icon]:hidden">
            Agent
          </SidebarGroupLabel>
          {/* Expanded: full dropdown */}
          <div className="px-2 pb-1 group-data-[collapsible=icon]:hidden">
            <AgentSelector />
          </div>
          {/* Terminal surface: "Launch CLI" preset for NEW terminals */}
          {isTerminalSurface ? (
            <div className="px-2 pb-1 group-data-[collapsible=icon]:hidden">
              <CliPresetSelector />
            </div>
          ) : null}
          {/* First-use nudge: only when Codex is selected (agent or terminal
              preset) on the canonical instance; self-suppresses otherwise. */}
          <CodexConnectNudge />
          {/* Icon-collapsed: colored status dot that expands the sidebar */}
          <button
            type="button"
            onClick={toggleSidebar}
            title={agentTitle}
            aria-label={agentTitle}
            className="hidden cursor-pointer mx-auto my-1 size-6 items-center justify-center rounded-full hover:ring-2 hover:ring-primary/40 group-data-[collapsible=icon]:flex"
          >
            <span className={`size-2 rounded-full ${agentDotClass}`} />
          </button>
        </SidebarGroup>

        {/* Sessions header + New chat button */}
        <SidebarGroup>
          <div className="flex items-center justify-between px-2 group-data-[collapsible=icon]:justify-center">
            <span className="text-xs font-medium text-muted-foreground group-data-[collapsible=icon]:hidden">
              {isTerminalSurface ? "Terminals" : "Sessions"}
            </span>
            {/* Themed Tooltip (components/ui/tooltip). The trigger renders
                as a span so hover is detected even when the inner button
                is disabled — Chromium suppresses pointer events on
                `<button disabled>`. Provider has delay={0} → no 5s native-
                tooltip wait. */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  <button
                    type="button"
                    onClick={handleNewChat}
                    disabled={!canCreate}
                    aria-label={newButtonTooltip}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{newButtonTooltip}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </SidebarGroup>

        {/* Sessions list (grouped by day) */}
        <SidebarSessionList />
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        {/* One menu for all footer rows so they're evenly spaced. Splitting
            these across multiple <SidebarMenu>s reintroduces the footer's
            gap-2 between groups and breaks the alignment. */}
        <SidebarMenu>
          <ThemeToggle />
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/instructions" />}
              tooltip="Instructions"
              isActive={pathname.startsWith("/instructions")}
              className="cursor-pointer"
            >
              <BookOpen className="size-4" />
              <span>Instructions</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/mcps-skills" />}
              tooltip="MCPs & Skills"
              isActive={pathname.startsWith("/mcps-skills")}
              className="cursor-pointer"
            >
              <Blocks className="size-4" />
              <span>MCPs & Skills</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/settings" />}
              tooltip={installingUpdate ? "Downloading update…" : "Settings"}
              isActive={pathname === "/settings"}
              className="cursor-pointer relative"
            >
              <Settings className="size-4" />
              <span>Settings</span>
              {/* While an update installs: a spinner plus (when the runner
                  reports one) a real progress bar along the row's bottom edge
                  — visible from every page, so navigating away from Settings
                  never hides that an install is running. */}
              {installingUpdate && (
                <>
                  <Loader2
                    aria-label="Installing update"
                    className="ml-auto size-3 shrink-0 animate-spin text-primary"
                  />
                  <span
                    aria-hidden
                    className="absolute inset-x-2 bottom-0 h-0.5 overflow-hidden rounded-full bg-primary/20"
                  >
                    <span
                      className={
                        installFraction === null
                          ? "block h-full w-1/3 animate-pulse rounded-full bg-primary"
                          : "block h-full rounded-full bg-primary transition-[width] duration-500"
                      }
                      style={
                        installFraction === null
                          ? undefined
                          : { width: `${Math.round(installFraction * 100)}%` }
                      }
                    />
                  </span>
                </>
              )}
              {/* The persistent update indicator. The louder surface is the
                  app-wide dismissible toast (components/layout/update-toast.tsx);
                  this dot is what remains after a dismiss, so a waved-away
                  update stays discoverable. It renders only when there is an
                  actual OFFER (either channel — a newer npm runtime or a newer
                  desktop shell) and disappears once the new runtime is on disk
                  waiting for a restart — a check that could not reach its feed
                  shows nothing at all. */}
              {updateAvailable && (
                <span
                  aria-label="Update available"
                  title="Update available"
                  className="ml-auto size-2 shrink-0 rounded-full bg-primary"
                />
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
