/** Generic MCP-side wait tool. Lets the agent sleep for N seconds
 *  without using Terminal `sleep` (which can hit tool-call timeouts) or
 *  ScheduleWakeup (which can fail to re-fire). AbortSignal-aware: the
 *  agent / MCP client can cancel mid-sleep and the tool returns partial.
 *  Reports progress every 5 s — MCP `notifications/progress` plus the
 *  studio's `job_progress` side channel (`tool-progress.ts`) — so the chat
 *  row shows the wait on both agents. */

import { serverLogger } from "@/lib/logger";
import type { ToolResult } from "./types";
import type { SleepParams } from "./schemas";
import { reportToolProgress, type ToolProgressExtra } from "./tool-progress";

const log = serverLogger.child({ tag: "libi-sleep" });
const TICK_MS = 5_000;

/** Subset of `RequestHandlerExtra` that `sleep` needs; the tool handler's full `extra`
 *  satisfies it. `_meta` carries the MCP progressToken (a notification is sent only when
 *  the client supplied one) and, under Claude, `claudecode/toolUseId`. */
interface SleepExtra extends ToolProgressExtra {
  /** AbortSignal from the MCP runtime — fires on tool cancellation. */
  signal?: AbortSignal;
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

    // Progress after each tick: the MCP notification (when the client asked for it) AND
    // the studio's job_progress side channel — claude-agent-acp drops MCP progress text.
    const message = params.reason
      ? `sleeping (${params.reason}) — ${Math.floor(elapsedMs / 1000)}/${params.seconds}s`
      : `sleeping — ${Math.floor(elapsedMs / 1000)}/${params.seconds}s`;
    await reportToolProgress(extra, { progress: elapsedMs, total: totalMs, message });
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
