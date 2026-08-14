import { getCurrentPort } from "@/lib/libi-home";

/**
 * Lightweight HTTP client for notifying the Next.js server about UI events.
 * All calls are fire-and-forget — silently no-op if the server isn't running.
 */

function getServerUrl(): string | null {
  try {
    const port = getCurrentPort();
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

async function send(payload: Record<string, unknown>): Promise<void> {
  const url = getServerUrl();
  if (!url) return;

  try {
    await fetch(`${url}/api/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Fire-and-forget — server may not be running.
  }
}

export const notify = {
  navigate(event: {
    target: "piece" | "asset" | "preview" | "storyboard" | "folder";
    /** Required for piece/asset/preview/storyboard/folder targets. */
    pieceId?: string;
    fileId?: string;
    /** Optional id for special targets. */
    id?: string;
  }): void {
    send({ type: "navigate", ...event });
  },
  refreshQuery(event: { queryKey: string; pieceId?: string; sceneId?: string; fileId?: string; trackId?: string }): void {
    send({ type: "refresh_query", ...event });
  },
  refreshMcpConfig(): void {
    send({ type: "refresh_mcp_config" });
  },
  /** Tell the server that memories or the instruction override changed (files
   *  under ~/.libi/). The server regenerates workspace files and restarts
   *  sessions; the agent process firing this is about to be killed. */
  instructionsChanged(): void {
    send({ type: "instructions_changed" });
  },
  analysisChanged(event: { fileId: string }): void {
    send({ type: "analysis_changed", ...event });
  },
  /** Tell the server to navigate the user to Settings (optionally focusing an MCP card). */
  navigateSettings(event: { mcpId?: string }): void {
    send({ type: "navigate_settings", mcpId: event.mcpId });
  },
  /** Tell the server to open or switch the right-region panel (onboarding, api-config, etc.). */
  rightRegion(event: {
    mode: "editor" | "onboarding" | "api-config";
    mcpId?: string;
  }): void {
    send({ type: "right_region", ...event });
  },
  /** Flash an inspector field for an overlay (guided edit). */
  highlight(event: {
    pieceId: string;
    overlayId: string;
    property: string;
    note?: string;
  }): void {
    send({ type: "highlight", ...event });
  },
  /** Flash an effect in the catalog or on a layer's slot (guided edit). */
  highlightEffect(event: {
    pieceId: string;
    target: { kind: "catalog"; effectId: string; phase?: "in" | "out" | "loop" } | { kind: "applied"; layerId: string; phase: "in" | "out" | "loop" };
    note?: string;
  }): void {
    send({ type: "highlight_effect", ...event });
  },
  /** Set a specific overlay's inspector tab/group. */
  setComplexityMode(event: {
    pieceId?: string;
    overlayId?: string;
    mode: "transform" | "style" | "text" | "3d" | "anchors";
  }): void {
    send({
      type: "set_complexity_mode",
      pieceId: event.pieceId,
      overlayId: event.overlayId,
      mode: event.mode,
    });
  },
  /** Forward a job progress tick into the in-process event bus so
   *  `SessionEventHandler` can synthesize an `agent-tool-progress` event
   *  on the matching tool-call part in the active session. */
  jobProgress(event: {
    jobId: string;
    toolCallId?: string;
    kind: string;
    done: number;
    total: number;
    unit: string;
    etaMs: number | null;
    toolName?: string;
    toolArgs?: unknown;
    progressLabel?: string;
  }): void {
    send({ type: "job_progress", ...event });
  },
};

export type PushPayload = { title: string; body: string; pieceId?: string; jobId?: string };
export type Notifier = {
  isFocused: () => boolean;
  notify: (p: PushPayload) => void;
};

let notifier: Notifier | null = null;

/** Bind the runtime notifier. Called from `electron/main.ts` after window
 *  creation. In `npx libi --connect-agent` mode this is never called and
 *  `pushIfBackgrounded` silently no-ops. */
export function bindNotifier(n: Notifier): void {
  notifier = n;
}

/** Test-only — override notifier inside vitest. */
export function __setTestNotifier(n: Notifier | null): void {
  notifier = n;
}

/** Fire a system notification if the runtime window isn't focused. Used by
 *  the job-progress bridge on job completion + failure for runs over
 *  ~10 seconds. Caller suppresses based on the user's settings toggle. */
export async function pushIfBackgrounded(p: PushPayload): Promise<void> {
  if (!notifier) return;
  if (notifier.isFocused()) return;
  notifier.notify(p);
}
