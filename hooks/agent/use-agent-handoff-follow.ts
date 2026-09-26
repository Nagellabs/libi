"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { navigateEmitter } from "@/hooks/sessions/use-agent-chat";
import { useEditorState } from "@/lib/editor-state-context";
import { EDITOR_PATH, routeOffEditorNavigate } from "@/lib/agents/agent-handoff";

/**
 * Layout-level half of following a hand-off (see lib/agents/agent-handoff.ts
 * for the rule): an agent `navigate` event that arrives before the editor has
 * attached, for the session the user just handed a prompt to from another
 * page, is parked for the editor and the user is taken to `/editor`.
 *
 * Every other event is left to the editor's own listener, exactly as before —
 * this never moves a user who did not just send something from here.
 */
export function useAgentHandoffFollow(): void {
  const router = useRouter();
  const pathname = usePathname();
  const { sessionList } = useEditorState();

  // Read at event time, so the subscription is made once.
  const pathnameRef = useRef(pathname);
  const activeSessionRef = useRef(sessionList.activeSessionId);
  useEffect(() => {
    pathnameRef.current = pathname;
    activeSessionRef.current = sessionList.activeSessionId;
  }, [pathname, sessionList.activeSessionId]);

  useEffect(() => {
    return navigateEmitter.on((event) => {
      const here = pathnameRef.current;
      const follow = routeOffEditorNavigate(event, {
        pathname: here,
        activeSessionId: activeSessionRef.current,
        now: Date.now(),
      });
      if (follow && here !== EDITOR_PATH) router.push(EDITOR_PATH);
    });
  }, [router]);
}
