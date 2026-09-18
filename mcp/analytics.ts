// mcp/analytics.ts
// MCP-side analytics: the MCP runs in a separate stdio process and cannot import
// the Next-only server transport, so it POSTs to /api/analytics/event (mirrors
// mcp/notify.ts). Every libi.* tool call emits `tool_used`.
import { getCurrentPort } from "@/lib/libi-home";
import type { AnalyticsEventName, AnalyticsParams } from "@/lib/analytics/events";
import type { AgentSurface } from "@/lib/mcp/agent-surface";

function serverUrl(): string | null {
  try {
    return `http://127.0.0.1:${getCurrentPort()}`;
  } catch {
    return null;
  }
}

/** Fire-and-forget a server-side analytics event from the MCP process.
 *  `name` must be on `lib/analytics/events.ts`'s allow-list (the route
 *  rejects anything else) and `params` bounded enums only — never user text. */
export function trackMcpEvent(name: AnalyticsEventName, params?: AnalyticsParams): void {
  const url = serverUrl();
  if (!url) return;
  void fetch(`${url}/api/analytics/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, params }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {
    // Fire-and-forget — server may not be running.
  });
}

/** Every libi.* tool call emits `tool_used`. */
export function trackToolUsed(toolName: string): void {
  trackMcpEvent("tool_used", { tool_name: toolName });
}

/** A session opened on libi's HTTP endpoint from the user's OWN CLI — any
 *  request without the in-app surface header. In-app sessions are the chat's
 *  own and are already counted (`agent_connected`, the wizard's `open-chat`),
 *  so they report nothing here. `dialect` is the endpoint's `?agent=` query,
 *  bounded by construction. */
export function trackCliSessionOpened(surface: AgentSurface, dialect: "claude" | "codex"): void {
  if (surface !== "cli") return;
  trackMcpEvent("mcp_cli_session_opened", { dialect });
}

/** Reach a first_* milestone from the MCP process. The studio server owns the
 *  mark-once primitive (`POST /api/analytics/milestone` wraps
 *  `markAnalyticsMilestoneOnce`), so the event fires exactly once per install
 *  however many processes reach the step, and the MCP child never writes the
 *  analytics settings itself. Fire-and-forget; never throws. */
export function trackMcpMilestone(name: string, event: AnalyticsEventName): void {
  const url = serverUrl();
  if (!url) return;
  void fetch(`${url}/api/analytics/milestone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, event }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {
    // Fire-and-forget — server may not be running.
  });
}

type RegisterFn = (...args: unknown[]) => unknown;

/** Wrap an McpServer.registerTool so every handler invocation calls `tracker`
 *  with the tool name first. Tracker errors are swallowed. */
export function wrapRegisterToolWithTracking(
  register: RegisterFn,
  tracker: (toolName: string) => void,
): RegisterFn {
  return (...args: unknown[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as (...h: unknown[]) => unknown;
    const wrappedHandler = async (...hargs: unknown[]) => {
      try {
        tracker(name);
      } catch {
        // analytics must never affect tool execution
      }
      return handler(...hargs);
    };
    const newArgs = [...args];
    newArgs[newArgs.length - 1] = wrappedHandler;
    return register(...newArgs);
  };
}
