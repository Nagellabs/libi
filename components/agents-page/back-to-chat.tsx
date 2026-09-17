"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useEditorState } from "@/lib/editor-state-context";

/**
 * `?from=<sessionId>`: the chat card that sent the user here gets them back.
 *
 * The chat list outlives navigation, so the editor keeps whatever chat was
 * already active and never re-reads `lastSessionId` on the way back — the
 * chat has to be made active HERE, before the push. A `from` that no longer
 * names a chat (deleted, evicted) just opens the editor on the current one.
 */
export function BackToChat({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { sessionList, setLastSessionId } = useEditorState();
  return (
    <Button
      variant="outline"
      size="sm"
      className="cursor-pointer"
      onClick={() => {
        if (sessionList.sessions.some((s) => s.sessionId === sessionId)) {
          sessionList.setActiveSessionId(sessionId);
          setLastSessionId(sessionId);
        }
        router.push("/editor");
      }}
    >
      <ArrowLeft className="size-3.5" />
      Back to chat
    </Button>
  );
}
