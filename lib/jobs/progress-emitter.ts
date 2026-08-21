import { EventEmitter } from "node:events";

/**
 * In-process event bus for `job_progress` notifies.
 *
 * The MCP-side `notify.jobProgress` POSTs to `/api/notify`, the notify route
 * emits here, and `SessionEventHandler` subscribes to synthesize
 * `agent-tool-progress` events on the active session so the chat UI can
 * surface live progress text on the matching tool-call part.
 *
 * Using a globalThis-backed singleton so the emitter survives Next.js HMR —
 * same pattern as the runner registry / JobManager singleton.
 */
export interface JobProgressPayload {
  jobId: string;
  toolCallId?: string;
  kind: string;
  done: number;
  total: number;
  unit: string;
  etaMs: number | null;
  /** Wall-clock ms since the last REAL progress tick. Present on heartbeat
   *  re-sends (see `JobManager.emitHeartbeat`) so the chat line can say
   *  "quiet for 12m" instead of either a frozen countdown or nothing at all. */
  msSinceProgress?: number | null;
  toolName?: string;
  toolArgs?: unknown;
  progressLabel?: string;
}

class JobProgressEmitter extends EventEmitter {}

declare global {
  // eslint-disable-next-line no-var
  var __libiJobProgressEmitter: JobProgressEmitter | undefined;
}

export const jobProgressEmitter: JobProgressEmitter =
  globalThis.__libiJobProgressEmitter ?? new JobProgressEmitter();
globalThis.__libiJobProgressEmitter = jobProgressEmitter;
