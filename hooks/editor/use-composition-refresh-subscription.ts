"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { refreshQueryEmitter } from "@/hooks/sessions/use-agent-chat";
import { pieceKeys } from "@/lib/queries/pieces";

export interface CompositionRefreshEvent {
  queryKey: string;
  pieceId?: string;
  sceneId?: string;
  fileId?: string;
}

/**
 * Subscribes directly to the global `refreshQueryEmitter` (module-level
 * singleton, see `hooks/sessions/use-agent-chat.ts`) and invalidates the
 * composition caches whenever a `composition` event arrives.
 *
 * This used to be delivered ONLY through `<ChatPanel onRefreshQuery=…>`,
 * which is not mounted on the terminal chat surface — `app/(app)/editor/
 * page.tsx` renders `<TerminalPanel>` instead of `<ChatPanel>` when
 * `activeProviderId === "terminal"`, so nothing ever registered the
 * per-instance handler and every composition change made by a
 * terminal-driven agent (music, overlays, scenes) was silently dropped
 * until a manual reload. Subscribing to the emitter directly — the same
 * fix already applied to `navigateEmitter` in the editor page — means the
 * invalidation fires regardless of which chat surface, if any, is mounted.
 *
 * `onComposition` lets the caller layer additional side effects (auto-show
 * seek, tab switch) on top of the invalidation without those side effects
 * being required for the invalidation itself to happen — which is what
 * keeps this hook testable without mounting the rest of the editor.
 */
export function useCompositionRefreshSubscription(
  onComposition?: (event: CompositionRefreshEvent & { pieceId: string }) => void,
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    return refreshQueryEmitter.on((event) => {
      if (event.queryKey !== "composition") return;
      if (!event.pieceId) return;

      queryClient.invalidateQueries({
        queryKey: pieceKeys.composition(event.pieceId),
      });
      queryClient.invalidateQueries({
        queryKey: ["composition-snapshot", event.pieceId],
      });

      onComposition?.(event as CompositionRefreshEvent & { pieceId: string });
    });
  }, [queryClient, onComposition]);
}
