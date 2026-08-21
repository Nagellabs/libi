import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema/sqlite";
import { getLibiHome } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { canonicalHash } from "@/lib/jobs/canonical-hash";
import { getRunner, registerBuiltinRunners } from "@/lib/jobs/runners/registry";
import { EtaTracker } from "@/lib/jobs/eta";
import {
  CancelledError,
  JobNotFoundError,
  type EnqueueOptions,
  type EnqueueResult,
  type JobContext,
  type JobStatusSnapshot,
  type ProgressEvent,
  snapshotFromRow,
} from "@/lib/jobs/types";
import {
  findJobByKindAndHash,
  findRunningByHash,
  findTerminalByHash,
  getJobById,
  insertJob,
  markCancelRequested,
  markCancelled,
  markCompleted,
  markFailed,
  markRunning,
  updatePartialPath,
  updateProgress,
} from "@/lib/jobs/repo";
import { notify } from "@/mcp/notify";

function partialPathFor(jobId: string): string {
  return path.join(getLibiHome(), "jobs", jobId, "state.json");
}

/** Defensive parse of a cached terminal job's resultJson. If the cached JSON
 *  is malformed (corruption, schema drift), log + return undefined rather
 *  than throwing — the agent can still get a `matching_completed` status
 *  and apply its heuristic. */
function parseTerminalResult(
  jobId: string,
  resultJson: string | null,
): unknown | undefined {
  if (!resultJson) return undefined;
  try {
    return JSON.parse(resultJson);
  } catch (err) {
    logger.warn(
      {
        tag: "jobs",
        op: "terminal_result_parse_failed",
        jobId,
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to parse cached job result JSON; returning undefined",
    );
    return undefined;
  }
}

/** Throttle ms for DB writes + progress emissions per the CLAUDE.md contract. */
const PROGRESS_DEBOUNCE_MS = 1000;
/**
 * How often a running job re-sends its last progress with a re-aged ETA.
 *
 * Runs for EVERY job, including those with the watchdog disabled
 * (`noProgressTimeoutMs: null`) — which is precisely the set that can go silent
 * for many minutes, and precisely where the frozen ETA was visible. 15s is
 * frequent enough that a countdown never looks stuck and cheap enough to be
 * irrelevant: it re-sends values already in memory and touches neither the DB
 * nor `lastProgressAt`.
 */
const PROGRESS_HEARTBEAT_MS = 15_000;
/** Default no-progress watchdog timeout when the runner doesn't specify. */
const DEFAULT_NO_PROGRESS_MS = 60_000;

export class JobManager extends EventEmitter {
  /** In-process map of currently-running jobId → AbortController. Used to
   *  flag local cancellation; runners poll via ctx.shouldCancel(). */
  private cancelFlags = new Map<string, AbortController>();
  /** In-process inflight map (jobId → promise) so concurrent runToCompletion
   *  callers attach to the same execution instead of double-starting. */
  private inflight = new Map<string, Promise<unknown>>();
  /** Last progress emit per jobId, for throttle. */
  private lastEmitAt = new Map<string, number>();
  /** Last REAL progress tick per job, replayed by `emitHeartbeat` with a re-aged
   *  ETA while the job is quiet. Cleared in `runWithSlot`'s finally. */
  private lastProgress = new Map<
    string,
    { kind: string; done: number; total: number; unit: string }
  >();
  /** Tracks jobs aborted by the no-progress watchdog so the catch path can
   *  reclassify them from "cancelled" to "failed" with a clear error. */
  private watchdogTripped = new Set<string>();
  /** Per-job promise chain ensures progress writes + emits stay ordered. */
  private progressChains = new Map<string, Promise<void>>();
  /** Per-job rolling-window ETA tracker. Cleared in `runWithSlot`'s finally. */
  private etaTrackers = new Map<string, EtaTracker>();
  /** Jobs created by an explicit `forceNew` enqueue, surfaced to the runner as
   *  `ctx.forced`. In-memory on purpose: it only has to survive from enqueue to
   *  the run that immediately follows, and a process restart orphans the row
   *  anyway (recoverOrphanedJobs flips it to `failed`). Cleared in
   *  `runWithSlot`'s finally alongside the other per-job maps. */
  private forcedJobs = new Set<string>();
  /** Jobs whose caller explicitly asked to discard on-disk output. Strictly a
   *  subset of `forcedJobs` — see `JobContext.discardOutput` for why the two
   *  must not be the same flag. */
  private discardOutputJobs = new Set<string>();
  /** In-process active counts per kind. */
  private activeByKind = new Map<string, number>();
  /** Pending waiters per kind. */
  private waiters = new Map<string, Array<() => void>>();
  /** Optional toolCallIds attached to a job so progress notifies can target
   *  the matching chat tool-call parts. Multiple toolCallIds can map to the
   *  same jobId when the agent fires the same tool twice with identical
   *  params: JobManager dedupes by paramsHash and returns the same jobId,
   *  but each call has its own toolCallId in the chat cache. Set by
   *  `attachToolCallId`; cleared in `runWithSlot`'s finally. */
  private toolCallIdByJob = new Map<string, Set<string>>();
  /** Reverse index of `toolCallIdByJob` — lets the session-event-handler
   *  ingest path stamp `jobId` on a freshly-pushed tool-call cache entry
   *  WITHOUT waiting for a progress event. This closes the race where
   *  POST /api/jobs attaches the toolCallId + the runner fires its first
   *  progress tick BEFORE the ACP `tool_call` event lands in the cache;
   *  the bridge's findSessionByToolCallId would otherwise return undefined
   *  and the cache patch would silently no-op, leaving the Stop button
   *  hidden for opaque runners (model downloads) that emit progress rarely. */
  private jobIdByToolCallId = new Map<string, string>();

  /** Tool identity/args hint per job (from POST /api/jobs `toolHint`).
   *  Rides every progress notify so the session bridge can match the job
   *  to the exact chat tool-call part. Cleared in `runWithSlot`'s finally. */
  private toolHintByJob = new Map<
    string,
    { toolName: string; toolArgs: unknown; progressLabel?: string }
  >();

  attachToolHint(
    jobId: string,
    hint: { toolName: string; toolArgs: unknown; progressLabel?: string },
  ): void {
    this.toolHintByJob.set(jobId, hint);
  }

  getToolHint(
    jobId: string,
  ): { toolName: string; toolArgs: unknown; progressLabel?: string } | null {
    return this.toolHintByJob.get(jobId) ?? null;
  }

  /** Associate a `toolCallId` with a `jobId` so subsequent progress
   *  notifies carry it. The MCP tool that enqueued the job calls this so
   *  the chat UI can map progress text + the Stop button to the right
   *  tool-call part. Safe to call before or after the job actually starts.
   *  Multiple toolCallIds can be attached to the same jobId — progress
   *  emits fan out to each one.
   */
  attachToolCallId(jobId: string, toolCallId: string): void {
    let set = this.toolCallIdByJob.get(jobId);
    if (!set) {
      set = new Set();
      this.toolCallIdByJob.set(jobId, set);
    }
    set.add(toolCallId);
    this.jobIdByToolCallId.set(toolCallId, jobId);
  }

  /** Reverse lookup — return the jobId attached to a given toolCallId, or
   *  `null` if no job is attached. Used by session-event-handler's
   *  tool_call ingest path so a freshly-pushed cache entry can carry
   *  `jobId` immediately (enabling the Stop button) without waiting for
   *  the first progress event. */
  getJobIdForToolCallId(toolCallId: string): string | null {
    return this.jobIdByToolCallId.get(toolCallId) ?? null;
  }

  /**
   * Emit a terminal event with the job's toolCallIds ATTACHED to the payload.
   *
   * The attachment is the whole point and it is not a convenience. `runWithSlot`'s
   * `finally` clears `toolCallIdByJob`, and terminal listeners are async (the
   * push-notification one awaits `getStatus`), so a listener that looks the ids up
   * itself resumes after the map is already empty and silently finds nothing. Any
   * listener that needs to reach the chat row must read them off the payload.
   */
  private emitTerminal(
    event: "completed" | "failed" | "cancelled",
    jobId: string,
    extra: Record<string, unknown> = {},
  ): void {
    const ids = this.toolCallIdByJob.get(jobId);
    this.emit(event, {
      jobId,
      ...extra,
      toolCallIds: ids ? Array.from(ids) : [],
    });
  }

  async enqueue<P>(
    kind: string,
    params: P,
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    const runner = getRunner(kind);
    if (!runner) {
      throw new Error(`No runner registered for kind: ${kind}`);
    }
    // Validate + canonicalize via the runner's zod schema before hashing.
    const parsed = runner.paramsSchema.parse(params) as P;
    const hash = canonicalHash(parsed);
    const clientKey = options.clientKey || `srv-${cryptoRandomId()}`;
    // `resume: false` is the deprecated form of `forceNew: true`.
    const forceNew = options.forceNew === true || options.resume === false;

    if (forceNew) {
      // A runner that owns ONE shared on-disk resource can't have a forced
      // restart race an in-flight run: deleting the live row schedules a second
      // run against the same directory, and whichever clears it first destroys
      // the other's work (see JobRunner.exclusiveResource). Attach instead, so
      // the caller learns a download is already in progress and can cancel it
      // explicitly if it really means to start over.
      if (runner.exclusiveResource) {
        const live = await findRunningByHash(kind, hash);
        if (live) {
          logger.info(
            { jobId: live.id, kind },
            "jobs.force_new.attached_exclusive",
          );
          return {
            status: "attached_running",
            jobId: live.id,
            clientKey: live.clientKey || clientKey,
            existingJob: {
              jobId: live.id,
              pieceId: live.pieceId,
              startedAt: live.startedAt?.toISOString() ?? "",
            },
          };
        }
      }
      // Hard-reset: delete ANY existing row with the same hash (running or
      // terminal) and clear on-disk partial state so the new run starts clean.
      const existing = await findJobByKindAndHash(kind, hash);
      if (existing) {
        const db = getDb();
        db.delete(jobs).where(eq(jobs.id, existing.id)).run();
        // The superseded row will never reach runWithSlot's finally, so prune
        // its flags here or they leak for the process lifetime.
        this.forcedJobs.delete(existing.id);
        this.discardOutputJobs.delete(existing.id);
        const oldStateDir = path.dirname(partialPathFor(existing.id));
        try {
          fs.rmSync(oldStateDir, { recursive: true, force: true });
        } catch (err) {
          logger.warn({ err, oldStateDir }, "jobs.resume.cleanup_failed");
        }
      }
      const id = `job-${cryptoRandomId()}`;
      await insertJob({
        id,
        kind,
        clientKey,
        paramsHash: hash,
        paramsJson: JSON.stringify(parsed),
        pieceId: options.pieceId ?? null,
        fileId: options.fileId ?? null,
      });
      this.forcedJobs.add(id);
      if (options.discardOutput === true) this.discardOutputJobs.add(id);
      this.emit("created", { jobId: id, kind });
      return { status: "new", jobId: id, clientKey, forced: true };
    }

    const running = await findRunningByHash(kind, hash);
    if (running) {
      return {
        status: "attached_running",
        jobId: running.id,
        clientKey: running.clientKey || clientKey,
        existingJob: {
          jobId: running.id,
          pieceId: running.pieceId,
          startedAt: running.startedAt?.toISOString() ?? "",
        },
      };
    }

    const terminal = await findTerminalByHash(kind, hash);
    if (terminal) {
      return {
        status: "matching_completed",
        existingJob: {
          jobId: terminal.id,
          pieceId: terminal.pieceId,
          completedAt: terminal.completedAt?.toISOString() ?? "",
          status: terminal.status as "completed" | "failed" | "cancelled",
          result: parseTerminalResult(terminal.id, terminal.resultJson),
          error: terminal.error,
        },
      };
    }

    // No match — fresh insert.
    const id = `job-${cryptoRandomId()}`;
    await insertJob({
      id,
      kind,
      clientKey,
      paramsHash: hash,
      paramsJson: JSON.stringify(parsed),
      pieceId: options.pieceId ?? null,
      fileId: options.fileId ?? null,
    });
    this.emit("created", { jobId: id, kind });
    return { status: "new", jobId: id, clientKey };
  }

  /** Start the runner if needed and resolve with the result. Multiple
   *  callers for the same jobId await the same execution. */
  async runToCompletion<R>(
    jobId: string,
    onProgress?: (p: ProgressEvent) => void,
  ): Promise<R> {
    const unsubscribe = onProgress
      ? this.subscribe(jobId, onProgress)
      : () => {};
    try {
      const existing = this.inflight.get(jobId) as Promise<R> | undefined;
      if (existing) return existing;

      const promise = this.runLocked<R>(jobId);
      this.inflight.set(jobId, promise);
      try {
        return await promise;
      } finally {
        this.inflight.delete(jobId);
      }
    } finally {
      unsubscribe();
    }
  }

  /** Live progress feed for a single job. */
  subscribe(jobId: string, listener: (p: ProgressEvent) => void): () => void {
    const handler = (p: ProgressEvent) => {
      if (p.jobId === jobId) listener(p);
    };
    this.on("progress", handler);
    return () => this.off("progress", handler);
  }

  async getStatus(jobId: string): Promise<JobStatusSnapshot> {
    const row = await getJobById(jobId);
    if (!row) throw new JobNotFoundError(jobId);
    return snapshotFromRow(row);
  }

  async cancel(jobId: string): Promise<void> {
    const row = await getJobById(jobId);
    if (!row) throw new JobNotFoundError(jobId);
    // Idempotent: already terminal → no-op.
    if (
      row.status === "completed" ||
      row.status === "failed" ||
      row.status === "cancelled"
    ) {
      return;
    }
    await markCancelRequested(jobId);
    const ac = this.cancelFlags.get(jobId);
    if (ac) ac.abort();
    this.emit("cancel-requested", { jobId });
  }

  // ─── private ────────────────────────────────────────────────────────

  private async runLocked<R>(jobId: string): Promise<R> {
    const row = await getJobById(jobId);
    if (!row) throw new JobNotFoundError(jobId);
    const runner = getRunner(row.kind);
    if (!runner) throw new Error(`No runner registered for kind: ${row.kind}`);

    // Acquire a per-kind concurrency slot. The DB row stays in `queued`
    // until we actually have a slot — `markRunning` happens after acquire.
    await this.acquireSlot(runner.kind, runner.maxConcurrent);
    try {
      // Re-check status after acquiring the slot in case `cancel()` arrived
      // while this job was parked in the waiter queue. Without this, the
      // cancel would have flipped the DB row to `cancel-requested` but the
      // runner would still execute once a slot freed up.
      const fresh = await getJobById(jobId);
      if (fresh?.status === "cancel-requested") {
        await markCancelled(jobId);
        this.emitTerminal("cancelled", jobId);
        throw new CancelledError(jobId);
      }
      return await this.runWithSlot<R>(jobId, fresh ?? row, runner);
    } finally {
      this.releaseSlot(runner.kind);
    }
  }

  private async acquireSlot(kind: string, maxConcurrent: number): Promise<void> {
    if ((this.activeByKind.get(kind) ?? 0) < maxConcurrent) {
      this.activeByKind.set(kind, (this.activeByKind.get(kind) ?? 0) + 1);
      return;
    }
    await new Promise<void>((resolve) => {
      const arr = this.waiters.get(kind) ?? [];
      arr.push(resolve);
      this.waiters.set(kind, arr);
    });
    this.activeByKind.set(kind, (this.activeByKind.get(kind) ?? 0) + 1);
  }

  private releaseSlot(kind: string): void {
    this.activeByKind.set(kind, Math.max(0, (this.activeByKind.get(kind) ?? 0) - 1));
    const arr = this.waiters.get(kind);
    if (arr && arr.length > 0) {
      const next = arr.shift()!;
      next();
    }
  }

  private async runWithSlot<R>(
    jobId: string,
    row: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
    runner: NonNullable<ReturnType<typeof getRunner>>,
  ): Promise<R> {
    await markRunning(jobId);
    const ac = new AbortController();
    this.cancelFlags.set(jobId, ac);

    // ── No-progress watchdog ──
    // `noProgressTimeoutMs === null` disables the watchdog entirely.
    // `undefined` → fall back to DEFAULT_NO_PROGRESS_MS.
    const watchdogMs =
      runner.noProgressTimeoutMs === null
        ? null
        : runner.noProgressTimeoutMs ?? DEFAULT_NO_PROGRESS_MS;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    if (watchdogMs !== null) {
      // Stamp lastProgressAt now so the watchdog has a baseline before the
      // runner emits its first real progress event.
      await updateProgress(jobId, { done: 0, total: 0 });
      const pollMs = Math.max(10, Math.min(5000, Math.floor(watchdogMs / 4)));
      watchdog = setInterval(() => {
        void (async () => {
          const fresh = await getJobById(jobId);
          if (!fresh) return;
          // Guard against late ticks after completion/failure — interval may have
          // queued a tick before `clearInterval` ran.
          if (fresh.status !== "running") return;
          if (!fresh.lastProgressAt) return;
          const idleMs = Date.now() - fresh.lastProgressAt.getTime();
          if (idleMs > watchdogMs) {
            logger.warn(
              { jobId, kind: row.kind, idleMs },
              "jobs.watchdog.no_progress",
            );
            this.watchdogTripped.add(jobId);
            ac.abort();
          }
        })().catch((err) =>
          logger.warn({ err, jobId }, "jobs.watchdog.poll_failed"),
        );
      }, pollMs);
    }

    // ── ETA heartbeat ──
    // Unconditional, unlike the watchdog: a runner that opts out of the
    // watchdog (a 6 GB download) is the one that most needs its ETA to keep
    // moving. Skips work until the job has emitted at least one real tick.
    const heartbeat: ReturnType<typeof setInterval> = setInterval(() => {
      try {
        this.emitHeartbeat(jobId);
      } catch (err) {
        logger.warn({ err, jobId }, "jobs.heartbeat.failed");
      }
    }, PROGRESS_HEARTBEAT_MS);
    // Never hold the process open for a heartbeat — it is pure UI polish, and a
    // stray one must not keep `npx libi` alive after work is done.
    heartbeat.unref?.();

    const stateFile = partialPathFor(jobId);
    let resumeState: unknown | null = null;
    if (row.partialPath && fs.existsSync(row.partialPath)) {
      try {
        resumeState = JSON.parse(fs.readFileSync(row.partialPath, "utf-8"));
      } catch (err) {
        logger.warn({ err, jobId }, "jobs.resume.parse_failed");
        resumeState = null;
      }
    }

    const ctx: JobContext<unknown> = {
      jobId,
      params: JSON.parse(row.paramsJson),
      resumeState,
      reportProgress: (done, total, unit) => {
        this.handleProgress(jobId, row.kind, done, total, unit ?? row.progressUnit);
      },
      checkpoint: async (state) => {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify(state), "utf-8");
        if (!row.partialPath) {
          await updatePartialPath(jobId, stateFile);
          // Mutate `row` so subsequent checkpoints in this call see the same path.
          (row as { partialPath: string | null }).partialPath = stateFile;
        }
      },
      shouldCancel: () => ac.signal.aborted,
      forced: this.forcedJobs.has(jobId),
      discardOutput: this.discardOutputJobs.has(jobId),
    };

    try {
      // Race the runner against the abort signal. Well-behaved runners check
      // ctx.shouldCancel() at natural boundaries; the race ensures we still
      // bail promptly when the runner doesn't (watchdog or user cancel).
      const result = await Promise.race<R>([
        runner.run(ctx) as Promise<R>,
        abortPromise<R>(ac.signal, () =>
          this.watchdogTripped.has(jobId)
            ? new Error(
                `No progress for ${watchdogMs}ms — watchdog tripped`,
              )
            : new CancelledError(jobId),
        ),
      ]);
      // Delete the partial state file on success — future resumes shouldn't see stale state.
      if (fs.existsSync(stateFile)) {
        try {
          fs.unlinkSync(stateFile);
        } catch {
          /* best-effort */
        }
      }
      await markCompleted(jobId, JSON.stringify(result));
      this.emitTerminal("completed", jobId, { result });
      return result;
    } catch (err) {
      if (this.watchdogTripped.has(jobId)) {
        this.watchdogTripped.delete(jobId);
        const message = `No progress for ${watchdogMs}ms — watchdog tripped`;
        try {
          await markFailed(jobId, message);
        } catch (e) {
          logger.error({ err: e, jobId }, "jobs.run.mark_failed_throw");
        }
        logger.error(
          { jobId, kind: row.kind, watchdogMs },
          "jobs.run.watchdog_failed",
        );
        this.emitTerminal("failed", jobId, { error: message });
        // Re-throw as a regular Error (not CancelledError) so callers don't
        // treat it like a graceful cancel.
        throw new Error(message);
      }
      if (err instanceof CancelledError || ac.signal.aborted) {
        try {
          await markCancelled(jobId);
        } catch (e) {
          logger.error({ err: e, jobId }, "jobs.run.mark_cancelled_throw");
        }
        this.emitTerminal("cancelled", jobId);
        throw err instanceof CancelledError ? err : new CancelledError(jobId);
      }
      const message = err instanceof Error ? err.message : String(err);
      try {
        await markFailed(jobId, message);
      } catch (e) {
        logger.error({ err: e, jobId }, "jobs.run.mark_failed_throw");
      }
      logger.error({ jobId, kind: row.kind, err: message }, "jobs.run.failed");
      this.emitTerminal("failed", jobId, { error: message });
      throw err;
    } finally {
      if (watchdog) clearInterval(watchdog);
      clearInterval(heartbeat);
      this.cancelFlags.delete(jobId);
      this.progressChains.delete(jobId);
      this.etaTrackers.delete(jobId);
      this.lastProgress.delete(jobId);
      const tcIds = this.toolCallIdByJob.get(jobId);
      if (tcIds) {
        for (const tcid of tcIds) this.jobIdByToolCallId.delete(tcid);
      }
      this.toolCallIdByJob.delete(jobId);
      this.toolHintByJob.delete(jobId);
      this.forcedJobs.delete(jobId);
      this.discardOutputJobs.delete(jobId);
    }
  }

  private handleProgress(
    jobId: string,
    kind: string,
    done: number,
    total: number,
    unit: string,
  ): void {
    const now = Date.now();
    // Clamp done to total so a runner over-reporting (249/248) never leaks
    // a done > total into the DB, snapshot, or chat UI.
    done = Math.min(done, total > 0 ? total : done);
    const last = this.lastEmitAt.get(jobId) ?? 0;
    if (now - last < PROGRESS_DEBOUNCE_MS && done < total) return;
    this.lastEmitAt.set(jobId, now);

    // Compute msPerUnit from a rolling window of recent samples (not the
    // lifetime average, which inflates while early frames absorb model load).
    const prev = this.progressChains.get(jobId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const row = await getJobById(jobId);
      if (!row || !row.startedAt) return;
      let tracker = this.etaTrackers.get(jobId);
      if (!tracker) {
        tracker = new EtaTracker();
        this.etaTrackers.set(jobId, tracker);
      }
      tracker.add(now, done);
      const msPerUnit = tracker.msPerUnit();
      await updateProgress(jobId, { done, total, unit, msPerUnit });
      // Remember the last real tick so the heartbeat can re-emit it with a
      // freshly aged ETA without inventing progress that didn't happen.
      this.lastProgress.set(jobId, { kind, done, total, unit });
      const ev: ProgressEvent = {
        jobId,
        kind,
        done,
        total,
        unit,
        msPerUnit,
        // No `now` argument: this IS the tick, so zero time has passed and
        // there is nothing to age. The heartbeat passes `now` instead.
        etaMs: tracker.etaMs(total, done),
      };
      this.emit("progress", ev);
      this.notifyProgress(ev);
    }).catch((err) => {
      logger.warn({ err, jobId }, "jobs.progress.update_failed");
    });
    this.progressChains.set(jobId, next);
  }

  /**
   * Fan a progress event out to `notify.jobProgress` — the in-process bridge
   * used by the Settings UI (which polls /api/jobs/[id]/events SSE), the chat
   * tool-call row, and any future non-MCP listener. MCP tools forward progress
   * directly via the standard `notifications/progress` mechanism instead — see
   * `lib/jobs/progress-forwarder.ts`.
   *
   * Split out of `handleProgress` so `emitHeartbeat` can re-send the last known
   * progress with a re-aged ETA without also re-recording it as a new tick.
   */
  private notifyProgress(ev: ProgressEvent): void {
    const toolCallIds = this.toolCallIdByJob.get(ev.jobId);
    const hint = this.toolHintByJob.get(ev.jobId);
    const baseEvent = {
      jobId: ev.jobId,
      kind: ev.kind,
      done: ev.done,
      total: ev.total,
      unit: ev.unit,
      etaMs: ev.etaMs,
      msSinceProgress: ev.msSinceProgress ?? null,
      ...(hint
        ? {
            toolName: hint.toolName,
            toolArgs: hint.toolArgs,
            ...(hint.progressLabel ? { progressLabel: hint.progressLabel } : {}),
          }
        : {}),
    };
    try {
      if (toolCallIds && toolCallIds.size > 0) {
        for (const tcid of toolCallIds) {
          notify.jobProgress({ ...baseEvent, toolCallId: tcid });
        }
      } else {
        notify.jobProgress({ ...baseEvent, toolCallId: undefined });
      }
    } catch (err) {
      logger.warn({ err, jobId: ev.jobId }, "jobs.progress.notify_failed");
    }
  }

  /**
   * Re-send the last known progress with a freshly aged ETA.
   *
   * Why this exists: the chat row's progress line is a STRING baked at emit
   * time, so a job that stops ticking leaves whatever countdown it last quoted
   * frozen on screen. The ACE-Step download read "ETA 1m 12s" for fifteen
   * minutes that way (session 9c3ce4d0, 2026-08-17) — one 6.2 GB file inside a
   * file-counted job emits nothing at all while it transfers. Aging the ETA in
   * `remainingMs` is only half the fix; something has to re-ask.
   *
   * Deliberately does NOT call `updateProgress` or `tracker.add`. Both would
   * move `lastProgressAt`, which is exactly the timestamp the staleness rule and
   * the no-progress watchdog measure from — a heartbeat that touched it would
   * make every job look permanently healthy and silently defuse the watchdog.
   * A heartbeat reports the passage of time, not the arrival of progress.
   */
  private emitHeartbeat(jobId: string): void {
    const last = this.lastProgress.get(jobId);
    if (!last) return; // nothing real to re-send yet
    const tracker = this.etaTrackers.get(jobId);
    if (!tracker) return;
    const now = Date.now();
    const lastSampleAt = tracker.lastSampleAt();
    const ev: ProgressEvent = {
      jobId,
      kind: last.kind,
      done: last.done,
      total: last.total,
      unit: last.unit,
      msPerUnit: tracker.msPerUnit(),
      etaMs: tracker.etaMs(last.total, last.done, now),
      msSinceProgress: lastSampleAt !== null ? now - lastSampleAt : null,
    };
    this.emit("progress", ev);
    this.notifyProgress(ev);
  }
}

/** Resolves never; rejects with `errorFactory()` when the signal aborts.
 *  Used to race against `runner.run` so cancellation (user or watchdog) takes
 *  effect even when the runner doesn't poll shouldCancel(). */
function abortPromise<T>(
  signal: AbortSignal,
  errorFactory: () => Error,
): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (signal.aborted) {
      reject(errorFactory());
      return;
    }
    signal.addEventListener("abort", () => reject(errorFactory()), { once: true });
  });
}

function cryptoRandomId(): string {
  return randomUUID();
}

// Singleton — survives Next.js HMR via globalThis cache.
declare global {
  // eslint-disable-next-line no-var
  var __libiJobManager: JobManager | undefined;
}

export function getJobManager(): JobManager {
  if (!globalThis.__libiJobManager) {
    // The lifecycle prelude (lib/cli/studio.ts → runStartupPrelude) runs in
    // the CLI process; this JobManager lives in the Next.js child process,
    // which has its own globalThis. Without lazy registration here, every
    // Next.js-side enqueue throws "No runner registered for kind: X".
    // registerBuiltinRunners is idempotent — it skips kinds already present.
    registerBuiltinRunners();
    globalThis.__libiJobManager = new JobManager();
  }
  return globalThis.__libiJobManager;
}
