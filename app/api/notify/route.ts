import { NextResponse } from "next/server";
import {
  navigationEmitter,
  emitHighlight,
  emitHighlightEffect,
  emitSetComplexityMode,
  type HighlightEffectEvent,
} from "@/lib/navigation-events";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { regenerateAndRestart } from "@/mcp/workspace";
import { serverLogger } from "@/lib/logger";

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
      // Server-side: regenerate workspace files + terminate every session.
      // The UI banner fires via SessionManager.resetAll()'s system event
      // (`instructions_updated`), not from here.
      regenerateAndRestart().catch((err) => {
        serverLogger.error(
          { err, tag: "instructions", op: "regenerate_failed" },
          "regenerateAndRestart failed after instructions_changed notify",
        );
      });
      break;
    }

    case "analysis_changed":
      navigationEmitter.emit("analysis_changed", {
        fileId: typeof body.fileId === "string" ? body.fileId : "",
      });
      break;

    case "navigate_settings":
      navigationEmitter.emit("navigate_settings", {
        mcpId: typeof body.mcpId === "string" ? body.mcpId : undefined,
      });
      break;

    case "right_region": {
      const mode =
        body.mode === "onboarding" || body.mode === "api-config" || body.mode === "editor"
          ? body.mode
          : "editor";
      navigationEmitter.emit("right_region", {
        mode,
        mcpId: typeof body.mcpId === "string" ? body.mcpId : undefined,
      });
      break;
    }

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
