/**
 * Background-job infrastructure types. Every long-running async flow in libi
 * (tracking, proxy generation, export render, LLM analysis, ...) runs through
 * the JobManager and registers as a JobRunner.
 *
 * Read CLAUDE.md → "Background Jobs" for the full contract.
 */

import type { ZodSchema } from "zod/v3";
import type { JobRecord } from "@/lib/db/schema/types";
import type { McpToolId } from "@/lib/agents/mcp-tool-id";
import { remainingMs } from "@/lib/jobs/eta";

/** Lifecycle state of a job; mirrors the DB column type. */
export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "cancel-requested";

/** What the JobManager exposes on a job to callers. */
export interface JobStatusSnapshot {
  id: string;
  kind: string;
  status: JobStatus;
  /** Piece this job is scoped to, when set via `EnqueueOptions.pieceId`.
   *  For `piece_dup` this is the id of the copy being created — lets the
   *  resources panel show a copy-in-progress spinner on the right row. */
  pieceId: string | null;
  /** File this job is scoped to, when set via `EnqueueOptions.fileId`. Used
   *  by per-file UIs (e.g. the Script tab) to find the job for a given file. */
  fileId: string | null;
  progressDone: number;
  progressTotal: number;
  progressUnit: string;
  /** Estimated remaining wallclock. Null when total is 0, when msPerUnit is not
   *  yet computed, OR when the estimate has been outlived by the wait — see
   *  `remainingMs`. Null therefore means "unknown", never "nearly done". */
  etaMs: number | null;
  msPerUnit: number | null;
  /** Wall-clock ms since the last progress tick, for a running job; null when
   *  the job never reported progress or has already finished. Lets a caller
   *  distinguish "working, quiet for 12 minutes" from "working, ticking every
   *  second" — the difference the frozen-ETA bug hid. */
  msSinceProgress: number | null;
  error: string | null;
  resultJson: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  lastProgressAt: Date | null;
}

/** Live event emitted by the JobManager when a runner reports progress. */
export interface ProgressEvent {
  jobId: string;
  kind: string;
  done: number;
  total: number;
  unit: string;
  etaMs: number | null;
  msPerUnit: number | null;
  /** Set on heartbeat re-sends (`JobManager.emitHeartbeat`), absent on real
   *  ticks — where by definition no time has passed since the last one. */
  msSinceProgress?: number | null;
}

/** What a registered runner sees during execution. The JobManager constructs
 *  a fresh JobContext for each `run()` call. */
export interface JobContext<P> {
  jobId: string;
  params: P;
  /** Null on first run. Populated from `partialPath` on resume — runner-specific shape. */
  resumeState: unknown | null;
  /** Call as work happens. JobManager rate-limits DB writes + progress emissions to 1s. */
  reportProgress(done: number, total: number, unit?: string): void;
  /** Persist resume state to `partialPath` on disk. Cheap; runners checkpoint frequently. */
  checkpoint(state: unknown): Promise<void>;
  /** True after `DELETE /api/jobs/[id]` flips status to `cancel-requested`. Runner polls
   *  this at natural boundaries and bails out cleanly. */
  shouldCancel(): boolean;
  /** True when this row was created by an explicit `forceNew` enqueue — the
   *  caller asked to start over, so any partial OUTPUT the runner owns (not
   *  just the job's checkpoint state, which JobManager already cleared) may be
   *  discarded.
   *
   *  This is deliberately NOT a `params` field. A flag in `params` changes the
   *  paramsHash, so `{force:true}` and `{}` become two different jobs writing
   *  the same output — see the note on `exclusiveResource`. Optional so the
   *  many hand-built test contexts stay valid; read it as `ctx.forced === true`. */
  forced?: boolean;
  /** True only when the caller EXPLICITLY asked to throw away this runner's
   *  on-disk output and start over — a user choosing "re-download", not a
   *  retry.
   *
   *  Deliberately separate from `forced`. Coupling the two is a defect this
   *  repo has already shipped once: `forced` is set by every retry surface
   *  (the failed-row auto-escape in `mcp/jobs-client.ts`, and
   *  `POST /api/jobs/[id]/retry`), so a runner that wipes on `forced` wipes on
   *  every retry. For `music_model_download` that discarded a resumable
   *  multi-GB huggingface pull — including its `.incomplete` blobs — every
   *  time a download was retried after a network blip, and on a deliberate
   *  user cancel too.
   *
   *  Rule of thumb: `forced` means "give me a fresh job row", `discardOutput`
   *  means "the bytes on disk are suspect, delete them". */
  discardOutput?: boolean;
}

/** Per-kind contract registered once at startup. */
export interface JobRunner<P, R> {
  /** Unique identifier; matches the `jobs.kind` column. */
  kind: string;
  /** Per-kind in-process concurrency cap. JobManager queues excess. */
  maxConcurrent: number;
  /** Validates + canonicalizes input. Used for both validation AND paramsHash. */
  paramsSchema: ZodSchema<P>;
  /** Does this runner write checkpoints + accept resumeState? */
  resumable: boolean;
  /** No-progress timeout: kill if `lastProgressAt` hasn't moved in this many ms.
   *  Null disables the watchdog (use sparingly). Default 60_000. */
  noProgressTimeoutMs?: number | null;
  /** Canonical MCP tool ID(s) of the tool that invokes this runner.
   *  - Set for any runner whose tool the agent calls (chat UI surface).
   *  - Use an array when the same runner is invoked from multiple MCP servers
   *    (e.g. tracking is registered on both `libi` and `libi-tracking`).
   *  - Omit for server-internal jobs that have no chat UI (proxy_gen on upload,
   *    analysis_describe_frame stub, export_render UI-triggered).
   *
   *  Required for the chat-progress bridge to route progress + Stop button to
   *  the correct in-flight tool-call entry. The bridge derives the kind→ID
   *  map from the runner registry at boot; no hand-maintained tables. */
  mcpToolId?: McpToolId | McpToolId[];
  /** True when `run()` spends money on an external provider API; gates the
   *  paid-job rate limiter (`lib/jobs/rate-limit.ts`). Omit for local-compute
   *  runners. Sourced structurally so a new paid runner can't silently bypass
   *  the billing rate-limiter by being forgotten in a hardcoded list. */
  paid?: boolean;
  /** Set when every run of this kind writes ONE shared on-disk resource (a
   *  model dir, a global cache) rather than a per-job output keyed by params.
   *
   *  For such a runner a forced restart must never race an in-flight run:
   *  `forceNew` would delete the live row and schedule a second run against
   *  the same directory, and whichever one clears it destroys the other's
   *  work. Measured 2026-08-02: a `music_download_model` retry (provoked by a
   *  spurious SSE `terminated`) wiped ~5.3 GB of a download that was
   *  succeeding, and the abandoned row still read `completed`.
   *
   *  When set, `enqueue({forceNew:true})` returns `attached_running` instead
   *  of deleting a non-terminal row — the caller is told a run is already in
   *  progress and can `cancel_job` first if it really wants to start over.
   *  Left unset (the default) `forceNew` keeps its existing semantics, which
   *  three call sites rely on returning a `new` shape. */
  exclusiveResource?: boolean;
  /** Implementation. Throws `CancelledError` when ctx.shouldCancel becomes true. */
  run(ctx: JobContext<P>): Promise<R>;
}

/** Thrown by the runner (or by reportProgress + checkpoint) when cancellation is observed. */
export class CancelledError extends Error {
  constructor(public readonly jobId: string) {
    super(`Job ${jobId} cancelled`);
    this.name = "CancelledError";
  }
}

/** Returned from `getStatus` / `cancel` when the jobId is unknown. */
export class JobNotFoundError extends Error {
  constructor(public readonly jobId: string) {
    super(`Job ${jobId} not found`);
    this.name = "JobNotFoundError";
  }
}

/** Result of `enqueue`. Discriminated union with four shapes:
 *  - `new`: no match found; a fresh row was inserted.
 *  - `attached_running`: an in-flight (queued/running/cancel-requested) job
 *    with the same paramsHash already exists; caller attaches to it.
 *  - `matching_completed`: a terminal (completed/failed/cancelled) job with
 *    the same paramsHash exists; no new work was scheduled and the prior
 *    result is returned. `existingJob.jobId` is the terminal row's id.
 *  - `new` with `forced: true`: the caller requested `forceNew` (or the
 *    deprecated `resume: false`); any existing matching row was deleted and
 *    a fresh one inserted. */
export type EnqueueResult =
  | { status: "new"; jobId: string; clientKey: string }
  | {
      status: "attached_running";
      jobId: string;
      clientKey: string;
      existingJob: {
        jobId: string;
        pieceId: string | null;
        startedAt: string;
      };
    }
  | {
      status: "matching_completed";
      existingJob: {
        jobId: string;
        pieceId: string | null;
        completedAt: string;
        status: "completed" | "failed" | "cancelled";
        result?: unknown;
        error?: string | null;
      };
    }
  | { status: "new"; jobId: string; clientKey: string; forced: true };

/** Options accepted by `JobManager.enqueue`. */
export interface EnqueueOptions {
  pieceId?: string | null;
  fileId?: string | null;
  /** Stable identifier the caller can use to correlate the enqueue with later
   *  status / events queries. If omitted, the JobManager generates a UUID
   *  prefixed with `srv-`. */
  clientKey?: string;
  /** Skip the paramsHash match check; always create a new job (deletes the
   *  existing row if any). Replaces the old `resume: false`. */
  forceNew?: boolean;
  /** @deprecated — accepted as inverse of forceNew for backward compat.
   *  `resume: false` is equivalent to `forceNew: true`. */
  resume?: boolean;
  /** Surface as `ctx.discardOutput`. Set ONLY for an explicit user request to
   *  throw away the runner's on-disk output — never by a retry path. See the
   *  note on `JobContext.discardOutput`. */
  discardOutput?: boolean;
}

/** Row → snapshot mapper, exported so route handlers + tests can reuse.
 *
 *  The clock is injectable for tests only; production callers omit it. It exists
 *  because the ETA is time-dependent (see `remainingMs`) — reading the same row
 *  twenty minutes apart must not yield the same estimate.
 *
 *  Deliberately an OPTIONS OBJECT rather than a positional `now: number`, and
 *  that is not style. `rows.map(snapshotFromRow)` is the natural way to write the
 *  list endpoint, and `Array.prototype.map` passes the ELEMENT INDEX as the
 *  second argument — so a positional clock silently became `now = 0` for the
 *  first row, making every job report `msSinceProgress: 0` and an undecayed ETA.
 *  That shipped into `GET /api/jobs`, which is what `libi.list_jobs` reads, and
 *  was caught only by watching a live job (2026-08-17). With an object, a stray
 *  numeric index is falsy-or-not-an-object either way and the default clock
 *  wins. */
export function snapshotFromRow(
  row: JobRecord,
  opts?: { now?: number },
): JobStatusSnapshot {
  const now = opts?.now ?? Date.now();
  // Terminal jobs never carry a stale nonzero ETA: a completed job is 0ms
  // away, a failed/cancelled job has no meaningful remaining time (null).
  const isCompleted = row.status === "completed";
  const isFailedOrCancelled =
    row.status === "failed" || row.status === "cancelled";
  const isTerminal = isCompleted || isFailedOrCancelled;
  // Only meaningful while running: a finished job's "time since last tick" just
  // measures how long ago it finished.
  const msSinceProgress =
    !isTerminal && row.lastProgressAt
      ? Math.max(0, now - row.lastProgressAt.getTime())
      : null;
  // Aged by msSinceProgress, so a job that has gone quiet stops quoting the
  // estimate it made before it went quiet. This read path and the live emit
  // path share `remainingMs` precisely so they cannot disagree.
  const runningRemaining = remainingMs({
    total: row.progressTotal,
    done: row.progressDone,
    msPerUnit: row.msPerUnit,
    msSinceProgress,
  });
  const etaMs = isCompleted ? 0 : isFailedOrCancelled ? null : runningRemaining;
  // A completed job reads as fully done even if the final tick under-reported.
  const progressDone =
    isCompleted && row.progressTotal > 0 ? row.progressTotal : row.progressDone;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    pieceId: row.pieceId,
    fileId: row.fileId,
    progressDone,
    progressTotal: row.progressTotal,
    progressUnit: row.progressUnit,
    etaMs,
    msPerUnit: row.msPerUnit,
    msSinceProgress,
    error: row.error,
    resultJson: row.resultJson,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    lastProgressAt: row.lastProgressAt,
  };
}
