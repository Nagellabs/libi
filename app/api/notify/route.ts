import { NextResponse } from "next/server";
import {
  navigationEmitter,
  emitHighlight,
  emitHighlightEffect,
  emitSetComplexityMode,
  type HighlightEffectEvent,
} from "@/lib/navigation-events";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { serverLogger } from "@/lib/logger";
import { clearRenderDiagnostics } from "@/lib/render/render-diagnostics-store";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { randomUUID } from "node:crypto";

/**
 * The libi chat a "show" navigation came from (NAV-1): the MCP child sends the tool call it is
 * running as `origin`, and the session manager finds the chat whose cache holds that call. Stamped
 * as `fromSessionId` + a per-event `navId`, so only the tab showing that chat navigates
 * (`hooks/sessions/tab-nav-gate.ts`). A call no libi chat holds — a CLI agent's — adds nothing, and
 * every tab obeys as before.
 */
function navigationOriginStamp(origin: unknown): { fromSessionId: string; navId: string } | Record<string, never> {
  if (!origin || typeof origin !== "object") return {};
  const o = origin as Record<string, unknown>;
  const lookup = {
    ...(typeof o.toolCallId === "string" ? { toolCallId: o.toolCallId } : {}),
    ...(typeof o.toolName === "string" ? { toolName: o.toolName } : {}),
    ...("toolArgs" in o ? { toolArgs: o.toolArgs } : {}),
  };
  let fromSessionId: string | null = null;
  try {
    fromSessionId = getSessionManager().sessionForToolCall(lookup);
  } catch (err) {
    serverLogger.warn({ err, tag: "session-manager", op: "navigation_origin_failed" }, "Could not resolve a navigation's chat");
  }
  return fromSessionId ? { fromSessionId, navId: randomUUID() } : {};
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { type } = body;

  switch (type) {
    case "navigate":
      navigationEmitter.emit("navigate", {
        target: body.target,
        pieceId: body.pieceId,
        fileId: body.fileId,
        id: body.id,
      });
      break;

    case "refresh_query":
      navigationEmitter.emit("refresh_query", {
        queryKey: body.queryKey,
        pieceId: body.pieceId,
        fileId: body.fileId,
        trackId: body.trackId,
      });
      break;

    case "refresh_mcp_config":
      invalidateMcpConfig({ reason: "mcp-notify-refresh" });
      break;

    case "instructions_changed": {
      // The MCP child that served the agent's `libi.update_memories` /
      // `libi.override_instructions` call has already written the file, and
      // `libi.read_manual` renders memories and the override fresh on every
      // call, so the studio has nothing to apply. It must NOT terminate
      // sessions: the one that made the save is mid-turn, and killing it ended
      // the chat with "ACP connection closed" (2026-10-02). The change reaches
      // a chat on its next `read_manual`, so a new chat. A user's Settings save
      // is a separate route that does restart (`regenerateAndRestart`).
      serverLogger.info(
        { tag: "instructions", op: "changed_no_restart" },
        "instructions or memories saved; running sessions left alone",
      );
      break;
    }

    case "analysis_changed":
      navigationEmitter.emit("analysis_changed", {
        fileId: typeof body.fileId === "string" ? body.fileId : "",
      });
      break;

    // An MCP-driven piece delete runs in the MCP child, whose in-memory
    // render-diagnostics store is not the one the preview fills.
    case "piece_deleted":
      if (typeof body.pieceId === "string" && body.pieceId) clearRenderDiagnostics(body.pieceId);
      break;

    // The retired `navigate_settings` and `right_region` types fall through to
    // the 400 below: nothing sends them any more.
    case "navigate_agents": {
      const tab = body.tab === "libi-mcp" || body.tab === "providers" ? body.tab : "agents";
      navigationEmitter.emit("navigate_agents", {
        tab,
        ...(typeof body.extensionId === "string" ? { extensionId: body.extensionId } : {}),
        ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
        ...navigationOriginStamp(body.origin),
      });
      break;
    }

    case "navigate_templates":
      navigationEmitter.emit("navigate_templates", {
        ...(typeof body.templateId === "string" ? { templateId: body.templateId } : {}),
        ...navigationOriginStamp(body.origin),
      });
      break;

    case "navigate_social":
      navigationEmitter.emit("navigate_social", {
        ...(typeof body.accountId === "string" && body.accountId ? { accountId: body.accountId.slice(0, 200) } : {}),
        ...navigationOriginStamp(body.origin),
      });
      break;

    case "highlight":
      emitHighlight({
        pieceId: typeof body.pieceId === "string" ? body.pieceId : "",
        overlayId: typeof body.overlayId === "string" ? body.overlayId : "",
        property: typeof body.property === "string" ? body.property : "",
        note: typeof body.note === "string" ? body.note : undefined,
      });
      break;

    case "highlight_effect":
      emitHighlightEffect({
        pieceId: typeof body.pieceId === "string" ? body.pieceId : "",
        target: body.target as HighlightEffectEvent["target"],
        note: typeof body.note === "string" ? body.note : undefined,
      });
      break;

    case "set_complexity_mode": {
      const mode =
        body.mode === "style" || body.mode === "text" || body.mode === "transform"
          ? body.mode
          : "transform";
      emitSetComplexityMode({
        pieceId: typeof body.pieceId === "string" ? body.pieceId : undefined,
        overlayId: typeof body.overlayId === "string" ? body.overlayId : "",
        mode,
      });
      break;
    }

    case "job_progress": {
      // Forward via the in-process event emitter so the
      // session-event-handler can synthesize an agent-tool-progress event.
      const { jobProgressEmitter } = await import("@/lib/jobs/progress-emitter");
      jobProgressEmitter.emit("job_progress", {
        jobId: typeof body.jobId === "string" ? body.jobId : "",
        toolCallId: typeof body.toolCallId === "string" ? body.toolCallId : undefined,
        kind: typeof body.kind === "string" ? body.kind : "",
        done: typeof body.done === "number" ? body.done : 0,
        total: typeof body.total === "number" ? body.total : 0,
        unit: typeof body.unit === "string" ? body.unit : "",
        etaMs: typeof body.etaMs === "number" ? body.etaMs : null,
        msSinceProgress:
          typeof body.msSinceProgress === "number" ? body.msSinceProgress : null,
        toolName: typeof body.toolName === "string" ? body.toolName : undefined,
        toolArgs: "toolArgs" in body ? body.toolArgs : undefined,
        progressLabel:
          typeof body.progressLabel === "string" ? body.progressLabel : undefined,
        message: typeof body.message === "string" ? body.message : undefined,
      });
      break;
    }

    default:
      return NextResponse.json(
        { error: `Unknown type: ${type}` },
        { status: 400 }
      );
  }

  return NextResponse.json({ ok: true });
}
