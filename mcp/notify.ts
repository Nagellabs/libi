import { getCurrentPort } from "@/lib/libi-home";

/**
 * Lightweight HTTP client for notifying the Next.js server about UI events.
 *
 * Fire-and-forget by default — silently no-ops if the server isn't running.
 * `send` reports whether the POST actually landed, which most callers ignore;
 * the one that must not is `navigateAgents`, because `libi.show_extension` and
 * `libi.start_onboarding` tell the agent a page is on screen and that claim has
 * to be true.
 */

/** The studio's base URL — `http://127.0.0.1:<port>`, never `localhost`.
 *  The ONE base helper: the notify POSTs and every URL handed to an agent
 *  (`libi.suggest_provider`'s `agentsPageUrl`) are built from it. Null when no
 *  studio port is known. */
export function studioBaseUrl(): string | null {
  try {
    const port = getCurrentPort();
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

/** True when the studio accepted the notification; false for every failure
 *  (no port file, unreachable, non-2xx, timeout). Never throws. */
async function send(payload: Record<string, unknown>): Promise<boolean> {
  const url = studioBaseUrl();
  if (!url) return false;

  try {
    const res = await fetch(`${url}/api/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    // Fire-and-forget — server may not be running.
    return false;
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
  refreshQuery(event: { queryKey: string; pieceId?: string; fileId?: string; trackId?: string }): void {
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
  /** Send the user to the Agents page. The ONE method that
   *  hands its promise back: `libi.show_extension` and `libi.start_onboarding`
   *  report "navigated" only when the POST landed. */
  navigateAgents(event: { tab: "agents" | "libi-mcp" | "providers"; extensionId?: string; provider?: string }): Promise<boolean> {
    return send({ type: "navigate_agents", ...event });
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
    msSinceProgress?: number | null;
    toolName?: string;
    toolArgs?: unknown;
    progressLabel?: string;
    message?: string;
  }): void {
    send({ type: "job_progress", ...event });
  },
  /** A NON-job tool's progress line on the SAME `job_progress` pipe as
   *  `jobProgress` — no second route. `jobId: ""` tells the session bridge there is no
   *  job to attach (no Stop button); `message` replaces the `<kind> done/total unit` line. */
  toolProgress(event: {
    toolCallId?: string;
    toolName?: string;
    toolArgs?: unknown;
    done: number;
    total: number;
    message: string;
  }): void {
    send({ type: "job_progress", jobId: "", kind: "", unit: "", etaMs: null, ...event });
  },
};

export type PushPayload = { title: string; body: string; pieceId?: string; jobId?: string };
export type Notifier = {
  isFocused: () => boolean;
  notify: (p: PushPayload) => void;
};

let notifier: Notifier | null = null;

/** Bind the runtime notifier. Called from `electron/main.ts` after window
 *  creation. Under `npx @nagellabs/libi` (no desktop shell) this is never
 *  called and `pushIfBackgrounded` silently no-ops. */
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
