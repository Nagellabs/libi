"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getSessionIcon } from "@/lib/sessions/session-icons";
import { useEditorState } from "@/lib/editor-state-context";
import { usePendingApprovalCount } from "@/hooks/sessions/use-agent-chat";
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

function PendingApprovalDot({ sessionId }: { sessionId: string }) {
  const count = usePendingApprovalCount(sessionId);
  if (count === 0) return null;
  const label = `${count} pending approval${count > 1 ? "s" : ""}`;
  return (
    <span
      aria-label={label}
      title={label}
      className="ml-auto h-2 w-2 shrink-0 rounded-full bg-amber-500"
    />
  );
}

export default function SidebarSessionList() {
  const { sessionList, activeProviderId, agentProviders } = useEditorState();
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
  if (isTerminalSurface) {
    return <TerminalSessionList />;
  }

  if (isLoading) {
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
                onClick={() => runRemedyInTerminal(readiness.remedy!)}
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
                    <PendingApprovalDot sessionId={s.sessionId} />
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
