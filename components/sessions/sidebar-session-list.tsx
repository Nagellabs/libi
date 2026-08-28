"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getSessionIcon } from "@/lib/sessions/session-icons";
import { useEditorState } from "@/lib/editor-state-context";
import {
  usePendingApprovalCount,
  useSessionGenerating,
  useSessionUnviewed,
} from "@/hooks/sessions/use-agent-chat";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import SessionContextMenu, {
  type SessionContextMenuState,
} from "./session-context-menu";
import { emptySessionsMessage } from "./session-list-utils";
import TerminalSessionList from "./terminal-session-list";
import { useRunRemedyInTerminal } from "@/hooks/agents/use-run-remedy-in-terminal";

function SessionIcon({ sessionId }: { sessionId: string }) {
  const icon = getSessionIcon(sessionId);
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill={icon.color}>
      {(Array.isArray(icon.d) ? icon.d : [icon.d]).map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

/** Up to three things can be true of one row, and three lookalike dots in a
 *  column would be worse than saying nothing — so ONE mark is rendered, chosen
 *  here, and each is told apart by form as well as by hue:
 *
 *    needs approval  amber, flat, filled — attention, and the strongest call
 *                    to action of the three: it is the only one that will not
 *                    resolve itself without the user.
 *    working         a sky dot that fades in and out — the only mark that
 *                    MOVES, which is what reads as "in progress" at a glance.
 *                    Opacity ONLY: no scale, no ring. Both of those were tried
 *                    and both rendered the mark as a SQUARE for part of the
 *                    cycle; `.libi-working-beat` in app/globals.css has the
 *                    full account. 1.4s ease-in-out, stilled under
 *                    prefers-reduced-motion.
 *    unviewed        a hollow grey ring — see `UnviewedMark`.
 *
 *  Priority is deliberate: a session blocked on a permission prompt is not
 *  "working", it is waiting on YOU; and a session that is working again has
 *  nothing to say about what it finished last time.
 *
 *  All three marks render for the ACTIVE session too, not only backgrounded
 *  ones. The composer that reports this state exists only on /editor, so
 *  suppressing them on the selected row would erase the state exactly when the
 *  user walks over to /settings. (`unviewed` cannot be true of the session on
 *  screen anyway — the tracker never records it; see `setViewedSession`.)
 *
 *  Every hook is called unconditionally: the branching is on the values, never
 *  on which hooks run. */
function SessionStateMark({ sessionId }: { sessionId: string }) {
  const pendingApprovals = usePendingApprovalCount(sessionId);
  const working = useSessionGenerating(sessionId);
  const unviewed = useSessionUnviewed(sessionId);

  if (pendingApprovals > 0) {
    const label = `${pendingApprovals} pending approval${pendingApprovals > 1 ? "s" : ""}`;
    return (
      <span
        aria-label={label}
        title={label}
        className="ml-auto h-2 w-2 shrink-0 rounded-full bg-amber-500"
      />
    );
  }

  if (working) {
    const label = "Working…";
    return (
      <span
        aria-label={label}
        title={label}
        className="relative ml-auto flex size-2 shrink-0 items-center justify-center"
      >
        {/* Round by a radius the compositor can actually honour: `rounded-full`
            is `calc(infinity * 1px)`, and that clamped value is what stopped
            surviving once the element was animated. Nothing here transforms or
            casts a shadow — see `.libi-working-beat` for why that matters. */}
        <span className="size-2 rounded-[50%] bg-sky-400 libi-working-beat" />
      </span>
    );
  }

  if (unviewed) return <UnviewedMark />;

  return null;
}

/** "This one finished while you were somewhere else." The working dot answers
 *  a question that answers itself eventually; this answers the one that
 *  doesn't, because a session that went quiet in the background never brings
 *  itself up again.
 *
 *  Form, not a fourth hue: some users cannot separate amber from a third warm
 *  colour, so this is a HOLLOW ring — an outline where the other two are
 *  filled — and it carries no status hue at all, only the sidebar's own
 *  foreground grey. That also says the right thing about urgency: it is the
 *  only one of the three that is not an alert, just a quiet "there's something
 *  here", and the greyscale silhouette (ring vs disc) is what distinguishes it
 *  if the colours are indistinguishable.
 *
 *  Deliberately static. Motion is the working dot's signal and would be a lie
 *  here; it also means there is nothing for prefers-reduced-motion to still.
 *
 *  The state is visual, so it carries a text equivalent — the label is read by
 *  a screen reader and shown on hover. */
function UnviewedMark() {
  const label = "Finished, not viewed yet";
  return (
    <span
      aria-label={label}
      title={label}
      className="ml-auto size-2.5 shrink-0 rounded-full border-[1.5px] border-muted-foreground/70"
    />
  );
}

/** Four rows the height of a real one. Shared by the first load and by an
 *  agent switch, so the two can never drift into looking different. */
function SessionListSkeleton() {
  return (
    <SidebarGroup>
      <SidebarMenu className="gap-1.5">
        {[...Array(4)].map((_, i) => (
          <SidebarMenuItem key={i}>
            <Skeleton className="h-8 w-full rounded-md" />
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}

export default function SidebarSessionList() {
  const { sessionList, activeProviderId, agentProviders, isAgentConnecting } =
    useEditorState();
  const { groups, isLoading, activeSessionId, switchSession } = sessionList;
  const isTerminalSurface = activeProviderId === "terminal";
  const pathname = usePathname();
  const router = useRouter();
  const runRemedyInTerminal = useRunRemedyInTerminal();
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(
    null,
  );

  const handleSwitch = (sessionId: string) => {
    // Navigate first so the user sees the editor (and its connecting skeleton)
    // immediately; switchSession kicks off activation in the background.
    if (pathname !== "/editor") {
      router.push("/editor");
    }
    switchSession(sessionId);
  };

  // Close context menu on outside click or Escape key
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  };

  const handleCopyId = () => {
    if (!contextMenu) return;
    navigator.clipboard.writeText(contextMenu.sessionId);
    setContextMenu(null);
  };

  // Only highlight the active session when the user is actually viewing the
  // editor — on other routes (e.g. /settings) nothing should appear selected.
  const highlightActive = pathname === "/editor";

  // Terminal surface: the sidebar shows live terminal sessions instead of
  // ACP chat sessions. Branch AFTER the hooks above so hook order is stable
  // across surface switches.
  // A switch is in flight. NOTHING clears the previous agent's data while it
  // runs — `isLoading` is true only on first mount, and `sessions`/`readiness`
  // keep their old values until the new agent's arrive — so the sidebar went
  // on showing the OLD agent's session list, and its sign-in or install
  // action, for the whole handshake. Several seconds of confidently wrong
  // state, on the one control whose entire job is to say which agent you are
  // looking at.
  //
  // Placed BEFORE the terminal branch so switching to or from the Terminal
  // surface is covered too, and after every hook above so hook order stays
  // stable across surfaces.
  if (isAgentConnecting) {
    return <SessionListSkeleton />;
  }

  if (isTerminalSurface) {
    return <TerminalSessionList />;
  }

  if (isLoading) {
    return <SessionListSkeleton />;
  }

  if (groups.length === 0) {
    // Agents that can't list past sessions (codex) only ever show live sessions
    // for the current run, so a bare "No sessions yet" misleads. `canListSessions`
    // defaults to true when the active provider isn't resolved yet, keeping the
    // claude-code copy stable during the brief provider-load window.
    const activeProvider = agentProviders.find((p) => p.id === activeProviderId);
    const canListSessions = activeProvider?.capabilities.canListSessions ?? true;

    // An agent that CAN'T sign in has no sessions for a reason, and that reason
    // must be READ, not hovered. Live QA on a machine with an unauthenticated
    // codex found the whole sidebar saying only "No sessions yet" while the real
    // explanation sat in a `title` attribute — so the one visible sentence
    // invited the user to make a session they could never make. This is the
    // surface the original bug report ("no error anywhere") was actually about.
    const readiness = sessionList.readiness;
    if (readiness?.state === "needs-auth") {
      return (
        <SidebarGroup>
          <div className="flex flex-col gap-2 px-2 py-2 group-data-[collapsible=icon]:hidden">
            <p className="text-xs text-muted-foreground">{readiness.message}</p>
            {readiness.remedy && (
              <button
                type="button"
                onClick={() => runRemedyInTerminal(readiness.remedy!, readiness.agentId, "sidebar")}
                className="cursor-pointer rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                {readiness.remedy.label}
              </button>
            )}
          </div>
        </SidebarGroup>
      );
    }

    return (
      <SidebarGroup>
        <div className="px-2 py-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          {emptySessionsMessage(canListSessions, activeProvider?.name)}
        </div>
      </SidebarGroup>
    );
  }

  return (
    <>
      {groups.map((group) => (
        <SidebarGroup key={group.label}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarMenu>
            {group.sessions.map((s) => {
              const isSelected = highlightActive && s.sessionId === activeSessionId;
              const title = s.title?.trim() || "Untitled session";
              return (
                <SidebarMenuItem key={s.sessionId}>
                  <SidebarMenuButton
                    tooltip={title}
                    isActive={isSelected}
                    onClick={() => handleSwitch(s.sessionId)}
                    onContextMenu={(e) => handleContextMenu(e, s.sessionId)}
                    className="cursor-pointer"
                  >
                    <SessionIcon sessionId={s.sessionId} />
                    <span className="truncate">{title}</span>
                    <SessionStateMark sessionId={s.sessionId} />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      ))}
      {contextMenu && (
        <SessionContextMenu state={contextMenu} onCopyId={handleCopyId} />
      )}
    </>
  );
}
