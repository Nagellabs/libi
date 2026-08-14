/** Generic MCP-side wait tool. Lets the agent sleep for N seconds
 *  without using Terminal `sleep` (which can hit tool-call timeouts) or
 *  ScheduleWakeup (which can fail to re-fire). AbortSignal-aware: the
 *  agent / MCP client can cancel mid-sleep and the tool returns partial.
 *  Emits MCP `notifications/progress` every 5 s so the chat UI shows
 *  the wait in flight. */

import { serverLogger } from "@/lib/logger";
import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResult } from "./types";
import type { SleepParams } from "./schemas";

const log = serverLogger.child({ tag: "libi-sleep" });
const TICK_MS = 5_000;

/** Subset of `RequestHandlerExtra` that `sleep` needs. Passing the full
 *  `extra` from the tool handler (typed as
 *  `RequestHandlerExtra<ServerRequest, ServerNotification>`) satisfies this
 *  interface without requiring any additional imports at the call site. */
interface SleepExtra {
  /** AbortSignal from the MCP runtime — fires on tool cancellation. */
  signal?: AbortSignal;
  /** MCP progress-notification sender. Optional; only attached when the
   *  caller passed a progressToken in `_meta`. Typed to match the MCP SDK's
   *  `RequestHandlerExtra.sendNotification` so server.ts can pass `extra`
   *  directly. */
  sendNotification?: RequestHandlerExtra<ServerRequest, ServerNotification>["sendNotification"];
  /** Progress token from the MCP request meta — required to construct a
   *  valid ProgressNotification. Extracted from `extra._meta?.progressToken`. */
  progressToken?: string | number;
}

/** Sleep for `params.seconds`, ticking every 5 s. Cancellable via
 *  `extra.signal`. Returns the actual elapsed time (may be less than
 *  requested if cancelled).
 *
 *  Implementation detail: we loop in 5 s chunks instead of a single
 *  setTimeout so we can (a) check the AbortSignal at each tick and
 *  (b) emit a progress notification per tick — both impossible with
 *  one long setTimeout. */
export async function sleep(
  params: SleepParams,
  extra: SleepExtra = {},
): Promise<ToolResult> {
  const totalMs = params.seconds * 1000;
  const startedAt = Date.now();

  log.info(
    { op: "start", seconds: params.seconds, reason: params.reason ?? null },
    `libi.sleep start (${params.seconds}s)${params.reason ? ` — ${params.reason}` : ""}`,
  );

  let elapsedMs = 0;
  while (elapsedMs < totalMs) {
    if (extra.signal?.aborted) {
      const sleptSeconds = (Date.now() - startedAt) / 1000;
      log.info(
        { op: "cancelled", requestedSec: params.seconds, sleptSec: sleptSeconds },
        `libi.sleep cancelled after ${sleptSeconds.toFixed(1)}s`,
      );
      return {
        success: true,
        data: {
          slept: sleptSeconds,
          cancelled: true,
          reason: params.reason,
        },
      };
    }

    const chunkMs = Math.min(TICK_MS, totalMs - elapsedMs);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, chunkMs);
      // If the AbortSignal fires during a chunk, resolve early and let
      // the next loop iteration see the aborted flag.
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (extra.signal) {
        extra.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    elapsedMs += chunkMs;

    // Emit a progress notification after each tick (when MCP wired it).
    // progressToken is required by the MCP spec — skip when absent.
    if (extra.sendNotification && extra.progressToken !== undefined) {
      try {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: extra.progressToken,
            progress: elapsedMs,
            total: totalMs,
            message: params.reason
              ? `sleeping (${params.reason}) — ${Math.floor(elapsedMs / 1000)}/${params.seconds}s`
              : `sleeping — ${Math.floor(elapsedMs / 1000)}/${params.seconds}s`,
          },
        });
      } catch {
        // progress emit is best-effort; never let it fail the sleep
      }
    }
  }

  const sleptSeconds = (Date.now() - startedAt) / 1000;
  log.info(
    { op: "done", seconds: params.seconds, actualSec: sleptSeconds },
    `libi.sleep done (${sleptSeconds.toFixed(1)}s)`,
  );
  return {
    success: true,
    data: {
      slept: sleptSeconds,
      cancelled: false,
      reason: params.reason,
    },
  };
}
