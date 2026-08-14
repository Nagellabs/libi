"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { refreshQueryEmitter } from "@/hooks/sessions/use-agent-chat";
import { dispatchRefreshQueryData } from "@/lib/queries/dispatch-refresh-query";

/**
 * Subscribes to the global refresh_query SSE event stream and runs the
 * pure data-cache invalidations (pieces, files, piece, analysis,
 * script). Composition events are NOT handled here — the editor page
 * owns those because they also drive auto-show / tab switch / pendingSeek.
 *
 * Mounted once at the (app) layout so the Resources panel, Characters /
 * Items pages, and any future cross-page consumer all get fresh data
 * regardless of which route is active.
 */
export function useGlobalRefreshQuerySubscription(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    return refreshQueryEmitter.on((event) => {
      dispatchRefreshQueryData(event, queryClient);
    });
  }, [queryClient]);
}
