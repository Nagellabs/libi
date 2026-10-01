"use client";

import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { toast } from "sonner";

export const sessionForgetKeys = {
  all: ["session-forget"] as const,
};

/**
 * "Remove from list" (`POST /api/sessions/:id/forget`) on a chat whose history is gone: libi drops
 * its own index entry for it and the row leaves the sidebar. The transcript is not touched (there is
 * none). The session list is not a React Query cache (`useSessionList`), so the caller passes what
 * to do once it is gone (refetch the list, move off the chat if it was on screen).
 */
export function useForgetSession(options: {
  onForgotten: (sessionId: string) => void;
}): UseMutationResult<void, Error, string> {
  return useMutation({
    mutationKey: sessionForgetKeys.all,
    mutationFn: async (sessionId: string): Promise<void> => {
      let res: Response;
      try {
        res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/forget`, { method: "POST" });
      } catch {
        throw new Error("libi's server didn't answer. Check that libi is still running, then try again.");
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(typeof body.error === "string" ? body.error : "libi couldn't remove this chat from the list.");
      }
    },
    onSuccess: (_data, sessionId) => options.onForgotten(sessionId),
    onError: (err) => {
      toast.error("Couldn't remove the chat from the list", { description: err.message });
    },
  });
}
