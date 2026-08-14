// components/banner/instructions-updated-banner.tsx
"use client";

import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import { subscribeBroadcast } from "@/hooks/sessions/use-agent-chat";

const HIDE_AFTER_MS = 12_000;

interface BannerState {
  sessionsTerminated: number;
  shownAt: number;
}

export function InstructionsUpdatedBanner() {
  const [state, setState] = useState<BannerState | null>(null);

  // Use the shared singleton EventSource (subscribeBroadcast) instead of
  // opening another /api/agent/events connection — Chrome's HTTP/1.1
  // 6-connections-per-origin limit (in dev) means an extra long-lived SSE
  // connection here can starve route navigation of socket slots and hang
  // /settings for minutes.
  useEffect(() => {
    return subscribeBroadcast((data) => {
      if (data.type !== "instructions_updated") return;
      const sessionsTerminated =
        typeof data.sessionsTerminated === "number" ? data.sessionsTerminated : 0;
      setState({ sessionsTerminated, shownAt: Date.now() });
    });
  }, []);

  useEffect(() => {
    if (!state) return;
    const t = setTimeout(() => setState(null), HIDE_AFTER_MS);
    return () => clearTimeout(t);
  }, [state]);

  if (!state) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-blue-500/30 bg-blue-500/10 px-4 py-2 text-sm text-blue-100">
      <span>
        Custom instructions updated — {state.sessionsTerminated} running session
        {state.sessionsTerminated === 1 ? "" : "s"} restarted to apply changes.
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setState(null)}
        className="cursor-pointer rounded p-1 hover:bg-blue-500/20"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
