"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Copy, Pencil, Terminal as TerminalIcon, X } from "lucide-react";
import { getSessionIcon } from "@/lib/sessions/session-icons";
import { useEditorState } from "@/lib/editor-state-context";
import {
  useCloseTerminal,
  useRenameTerminal,
  useTerminalSessions,
} from "@/lib/queries/terminals";
import type { TerminalSessionMeta } from "@/lib/terminal/types";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

interface TerminalGroup {
  label: string;
  sessions: TerminalSessionMeta[];
}

/** Same day-bucketing as the chat session list, keyed on createdAt. */
function groupByDay(sessions: TerminalSessionMeta[]): TerminalGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const groups = new Map<string, TerminalSessionMeta[]>();
  for (const session of sessions) {
    const date = new Date(session.createdAt);
    let label: string;
    if (date >= startOfToday) label = "Today";
    else if (date >= startOfYesterday) label = "Yesterday";
    else label = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const list = groups.get(label) ?? [];
    list.push(session);
    groups.set(label, list);
  }
  return [...groups.entries()].map(([label, sessions]) => ({ label, sessions }));
}

interface MenuState {
  x: number;
  y: number;
  sessionId: string;
}

/**
 * Sidebar list for the Terminal surface. Sessions are in-memory on the
 * server (newest first); a closed/exited terminal disappears from this
 * list via the `terminal-sessions` refresh_query SSE event.
 */
export default function TerminalSessionList() {
  const { activeTerminalId, setActiveTerminalId } = useEditorState();
  const { data: sessions, isLoading } = useTerminalSessions();
  const renameTerminal = useRenameTerminal();
  const closeTerminal = useCloseTerminal();
  const pathname = usePathname();
  const router = useRouter();

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Close context menu on outside click / Escape (same pattern as the chat
  // session list).
  useEffect(() => {
    if (!menu) return;
    const handleClick = () => setMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu]);

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  const handleSelect = (sessionId: string) => {
    if (pathname !== "/editor") router.push("/editor");
    setActiveTerminalId(sessionId);
  };

  const startRename = (session: TerminalSessionMeta) => {
    setMenu(null);
    setDraftTitle(session.title);
    setEditingId(session.id);
  };

  const commitRename = () => {
    if (editingId && draftTitle.trim()) {
      renameTerminal.mutate({ id: editingId, title: draftTitle.trim() });
    }
    setEditingId(null);
  };

  const handleClose = (sessionId: string) => {
    setMenu(null);
    closeTerminal.mutate(sessionId);
    if (activeTerminalId === sessionId) setActiveTerminalId(null);
  };

  if (isLoading) {
    return (
      <SidebarGroup>
        <SidebarMenu className="gap-1.5">
          {[...Array(3)].map((_, i) => (
            <SidebarMenuItem key={i}>
              <Skeleton className="h-8 w-full rounded-md" />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>
    );
  }

  if (!sessions || sessions.length === 0) {
    return (
      <SidebarGroup>
        <div className="px-2 py-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          No terminals open
        </div>
      </SidebarGroup>
    );
  }

  const highlightActive = pathname === "/editor";
  const menuSession = menu
    ? sessions.find((s) => s.id === menu.sessionId) ?? null
    : null;

  return (
    <>
      {groupByDay(sessions).map((group) => (
        <SidebarGroup key={group.label}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarMenu>
            {group.sessions.map((s) => {
              const isSelected = highlightActive && s.id === activeTerminalId;
              const iconColor = getSessionIcon(s.id).color;
              if (editingId === s.id) {
                return (
                  <SidebarMenuItem key={s.id}>
                    <div className="flex h-8 items-center gap-2 rounded-md px-2">
                      <TerminalIcon className="size-4 shrink-0" style={{ color: iconColor }} />
                      <input
                        ref={inputRef}
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="w-full min-w-0 rounded border border-ring bg-background px-1 py-0.5 text-sm text-foreground outline-none"
                      />
                    </div>
                  </SidebarMenuItem>
                );
              }
              return (
                <SidebarMenuItem key={s.id}>
                  <SidebarMenuButton
                    tooltip={s.title}
                    isActive={isSelected}
                    onClick={() => handleSelect(s.id)}
                    onDoubleClick={() => startRename(s)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenu({ x: e.clientX, y: e.clientY, sessionId: s.id });
                    }}
                    className="cursor-pointer"
                  >
                    <TerminalIcon className="size-4 shrink-0" style={{ color: iconColor }} />
                    <span className="truncate">{s.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      ))}

      {menu && menuSession && (
        <div
          className="fixed z-50 min-w-[170px] rounded-lg border border-border bg-popover p-1 shadow-md"
          style={{
            top: Math.min(menu.y, typeof window !== "undefined" ? window.innerHeight - 130 : menu.y),
            left: Math.min(menu.x, typeof window !== "undefined" ? window.innerWidth - 180 : menu.x),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => startRename(menuSession)}
            className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
          >
            <Pencil className="h-3.5 w-3.5" />
            Rename
          </button>
          <button
            onClick={() => {
              navigator.clipboard.writeText(menuSession.id);
              setMenu(null);
            }}
            className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy session ID
          </button>
          <button
            onClick={() => handleClose(menuSession.id)}
            className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive transition-colors hover:bg-accent"
          >
            <X className="h-3.5 w-3.5" />
            Close terminal
          </button>
        </div>
      )}
    </>
  );
}
