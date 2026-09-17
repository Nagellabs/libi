import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { notify } from "@/mcp/notify";
import { getCurrentToolCall } from "@/mcp/tool-call-context";

/** What a progress report needs from a tool handler's `extra`; the full `extra` satisfies it. */
export type ToolProgressExtra = Partial<
  Pick<RequestHandlerExtra<ServerRequest, ServerNotification>, "sendNotification" | "_meta">
>;

/**
 * Report progress for a tool that is NOT a JobManager job. Two routes, both
 * best-effort — this never throws:
 *
 *  1. MCP `notifications/progress` on the caller's progressToken, when it sent one.
 *     codex-acp forwards that to libi as `tool_call_update._meta.mcp_output_delta`;
 *     claude-agent-acp drops the text (the SDK's `tool_progress` carries none).
 *  2. The studio's `job_progress` side channel — the pipe JobManager already uses
 *     (`notify` → `/api/notify` → `jobProgressEmitter` → `SessionEventHandler`) — with
 *     `jobId: ""` and the line as `message`, so the chat row shows it on Claude too.
 *     The row is found by `_meta["claudecode/toolUseId"]` when the engine sent one (the
 *     ACP toolCallId under claude-agent-acp), else by the tool-name + args hint the jobs
 *     use (`mcp/tool-call-context.ts`). `_meta` carries no ACP toolCallId in general —
 *     `progressToken` is a per-request counter — so the hint is the guaranteed key.
 */
export async function reportToolProgress(
  extra: ToolProgressExtra | undefined,
  p: { progress: number; total: number; message: string },
): Promise<void> {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken !== undefined && extra?.sendNotification) {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: p.progress, total: p.total, message: p.message },
      });
    } catch {
      // best-effort: progress never fails the tool
    }
  }
  const call = getCurrentToolCall();
  const toolUseId = (extra?._meta as Record<string, unknown> | undefined)?.["claudecode/toolUseId"];
  if (!call && typeof toolUseId !== "string") return;
  notify.toolProgress({
    ...(typeof toolUseId === "string" ? { toolCallId: toolUseId } : {}),
    ...(call ? { toolName: call.toolName, toolArgs: call.args } : {}),
    done: p.progress,
    total: p.total,
    message: p.message,
  });
}
