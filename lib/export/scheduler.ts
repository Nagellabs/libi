/**
 * The export scheduler (spec 2026-09-29 §B1): several exports at once — as
 * many as the machine can take. It replaces the three serializers that ran
 * one export at a time (the `export` runner's `maxConcurrent: 1`, the old
 * export lane, and `export_render`'s `maxConcurrent: 1`).
 *
 * Every render asks `acquire()` for a slot with a cost estimate
 * (lib/export/cost.ts) after it knows its backend, and releases it when it
 * ends — ALWAYS, in a `finally`. Admission is the pure `planAdmissions`
 * (lib/export/admission.ts): foreground (user/agent exports) before background
 * (a template example render), FIFO within, skip-ahead with a two-minute
 * barrier, re-evaluated on every release and every 5 s while anything waits.
 *
 * A background render keeps the old lane's promise to the user: it never runs
 * beside a foreground export. When one arrives, the background's
 * `reservation.signal` aborts with `BackgroundYield`, nothing else is admitted
 * until it has let go, and it starts again from the top later.
 *
 * In-process state, like JobManager's: one Next server runs every export.
 */
import os from "node:os";
import { getAvailableMemoryBytes } from "@/lib/system/available-memory";
import { isMac } from "@/lib/platform";
import { exportLogger } from "@/lib/logger";
import type { ExportWaitReason, ExportWaiting } from "@/lib/exports/types";
import { resolveChunkWorkers } from "./chunk-plan";
import {
  HW_SESSION_CAP_DARWIN,
  HW_SESSION_CAP_OTHER,
  MB,
  SOFTWARE_FALLBACK_SAFE,
  softwareVariant,
  type CostEstimate,
} from "./cost";
import {
  REEVALUATE_MS,
  planAdmissions,
  waitingMessage,
  type AdmissionConfig,
  type ExportPriority,
  type QueuedRequest,
  type ResourceSnapshot,
  type RunningSlot,
} from "./admission";

/** The reason a background render's signal aborts when a foreground export arrives. */
export class BackgroundYield extends Error {
  constructor() {
    super("an export the user asked for needs the machine");
    this.name = "BackgroundYield";
  }
}

/** By name, not `instanceof`: each Next route bundle has its own copy of this module. */
export function isBackgroundYield(err: unknown): boolean {
  return err instanceof Error && err.name === "BackgroundYield";
}

export interface AcquireRequest {
  /** The export id (or, for a render with no record, its job id) — what logs and `waitingInfo` name. */
  id: string;
  priority: ExportPriority;
  estimate: CostEstimate;
  /** Aborting leaves the queue at once; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Background only: true while a foreground export is about to arrive (its job is queued). */
  busy?: () => boolean;
  /** Told every time the reason it waits changes. */
  onWait?: (waiting: ExportWaiting) => void;
}

export interface Reservation {
  id: string;
  /** Admitted as libx264 because every hardware session was taken (B0 said that is safe). */
  software: boolean;
  usesHwEncoder: boolean;
  /** Aborts with `BackgroundYield` when a background render must let go. Never aborts for a foreground one. */
  signal: AbortSignal;
  /** Give the slot back. Idempotent. */
  release: () => void;
}

export interface SchedulerDeps {
  snapshot: () => ResourceSnapshot;
  config: AdmissionConfig;
  now?: () => number;
  reevaluateMs?: number;
}

/** How soon a background render waiting on `busy` looks again. */
export const BUSY_POLL_MS = 250;

/**
 * A render admitted a moment ago has not allocated its memory yet, so the next
 * tick would read a free-memory figure that is too high and over-admit. Until
 * this long after admission its estimate is subtracted from what is "available".
 */
export const MEMORY_RAMP_MS = 15_000;

/** What a template example render reserves (it holds its slot before its backend is known). */
export const BACKGROUND_EXAMPLE_ESTIMATE: CostEstimate = {
  backend: "chromium-render",
  memoryBytes: 950 * MB,
  cpu: 1,
  hwEncoder: false,
  softwareFallback: false,
  renderWorkers: 1,
};

export const HW_SESSION_FAILED_MESSAGE =
  "The video encoder refused another session. libi will run fewer exports at once from now on — export this one again.";

/**
 * The words of a hardware encoder that can't open another SESSION: VideoToolbox
 * ("cannot create compression session: -12903") and NVENC (OpenEncodeSessionEx).
 * Never ffmpeg's generic "Error while opening encoder … maybe incorrect
 * parameters" — that is a bad argument, and lowering the cap for the whole
 * process over it would be wrong.
 */
export function isHwEncoderSessionError(message: string): boolean {
  return /VTCompressionSession|compression session|OpenEncodeSessionEx|-12903/i.test(message);
}

interface Pending {
  key: string;
  req: AcquireRequest;
  enqueuedAt: number;
  skippedSince: number | null;
  lastReason: ExportWaitReason | null;
  resolve: (r: Reservation) => void;
  onAbort?: () => void;
}

interface Held {
  key: string;
  id: string;
  priority: ExportPriority;
  estimate: CostEstimate;
  usesHwEncoder: boolean;
  yieldCtl: AbortController;
  admittedAt: number;
}

/** A caught value as a bounded log field. */
function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("cancelled");
}

export class ExportScheduler {
  private readonly pending = new Map<string, Pending>();
  private readonly held = new Map<string, Held>();
  private readonly waits = new Map<string, ExportWaiting>();
  private readonly renderLeases = new Map<number, number>();
  private hwCap: number;
  private renderMode: "gpu" | "software" | undefined;
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: SchedulerDeps) {
    this.hwCap = deps.config.hwSessionCap;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  acquire(req: AcquireRequest): Promise<Reservation> {
    if (req.signal?.aborted) return Promise.reject(abortReason(req.signal));
    return new Promise<Reservation>((resolve, reject) => {
      const key = `${req.id}#${++this.seq}`;
      const entry: Pending = { key, req, enqueuedAt: this.now(), skippedSince: null, lastReason: null, resolve };
      if (req.signal) {
        const signal = req.signal;
        entry.onAbort = () => {
          if (!this.pending.delete(key)) return;
          this.waits.delete(req.id);
          reject(abortReason(signal));
          this.pump();
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(key, entry);
      // A pass that throws must not strand this request: it leaves the queue and fails the
      // acquire, so the caller (which holds nothing yet) fails its export cleanly.
      const failure = this.pump();
      if (failure && this.pending.delete(key)) {
        this.waits.delete(req.id);
        if (entry.onAbort) req.signal?.removeEventListener("abort", entry.onAbort);
        reject(failure);
      }
    });
  }

  /** Why this export is not rendering yet; null when it is not waiting here. */
  waitingInfo(id: string): ExportWaiting | null {
    return this.waits.get(id) ?? null;
  }

  runningCount(): number {
    return this.held.size;
  }

  /** An encoder session failed at runtime despite B0's cap: run fewer hardware encodes, for the rest of the process. */
  lowerHwSessionCap(exportId: string): void {
    const from = this.hwCap;
    this.hwCap = Math.max(1, from - 1);
    exportLogger.warn({ op: "schedule_hw_cap_lowered", exportId, from, to: this.hwCap }, "export.schedule_hw_cap_lowered");
    this.pump();
  }

  /** Chunk pages for one Chromium render, sharing the cores with the renders already running. */
  leaseRenderWorkers(env: string | undefined, mode: "gpu" | "software" | undefined, cores: number): { workers: number; release: () => void } {
    const workers = resolveChunkWorkers(env, mode, cores, this.heldRenderWorkers());
    const id = ++this.seq;
    this.renderLeases.set(id, workers);
    let released = false;
    return {
      workers,
      release: () => {
        if (released) return;
        released = true;
        this.renderLeases.delete(id);
      },
    };
  }

  /** The driver's render mode, as `export_render` last probed it (undefined until one has). */
  noteRenderMode(mode: "gpu" | "software" | undefined): void {
    if (mode) this.renderMode = mode;
  }

  knownRenderMode(): "gpu" | "software" | undefined {
    return this.renderMode;
  }

  heldRenderWorkers(): number {
    let sum = 0;
    for (const n of this.renderLeases.values()) sum += n;
    return sum;
  }

  /**
   * One admission pass, never throwing: it runs from release(), the abort handler
   * and the timers, none of which can survive an exception (a throw from a
   * `finally`'s release() would fail a finished export). A failure is logged and
   * returned — `acquire` turns it into a rejection — and the timer is kept alive
   * so the queue still drains once whatever threw stops throwing.
   */
  private pump(): Error | null {
    try {
      this.runPass();
      return null;
    } catch (err) {
      exportLogger.error(
        { op: "schedule_pump_failed", pending: this.pending.size, running: this.held.size, error: errorText(err) },
        "export.schedule_pump_failed",
      );
      if (this.pending.size > 0) this.startTimer();
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  /** One admission pass. Runs on every acquire, release, cancel, and on the timers. */
  private runPass(): void {
    if (this.pending.size === 0) {
      this.stopTimers();
      return;
    }
    const raw = this.deps.snapshot();
    const now = this.now();
    const snap = this.withoutRampingMemory(raw, now);
    const queuedForeground = [...this.pending.values()].some((p) => p.req.priority === "foreground");
    if (queuedForeground) {
      for (const h of this.held.values()) {
        if (h.priority === "background" && !h.yieldCtl.signal.aborted) h.yieldCtl.abort(new BackgroundYield());
      }
    }
    // A yielding background render still holds the machine until it lets go.
    const yielding = [...this.held.values()].some((h) => h.yieldCtl.signal.aborted);
    if (yielding) {
      for (const p of this.pending.values()) this.markWaiting(p, "queue", raw);
      this.startTimer();
      return;
    }

    const running: RunningSlot[] = [...this.held.values()].map((h) => ({
      id: h.key,
      priority: h.priority,
      estimate: h.estimate,
      usesHwEncoder: h.usesHwEncoder,
    }));
    const queue: QueuedRequest[] = [...this.pending.values()].map((p) => ({
      id: p.key,
      priority: p.req.priority,
      estimate: p.req.estimate,
      enqueuedAt: p.enqueuedAt,
      skippedSince: p.skippedSince,
      busy: p.req.priority === "background" && this.isBusy(p),
    }));
    const pass = planAdmissions(queue, snap, running, { hwSessionCap: this.hwCap, softwareFallbackSafe: this.deps.config.softwareFallbackSafe }, now);
    for (const key of pass.skipped) {
      const p = this.pending.get(key);
      if (p && p.skippedSince === null) p.skippedSince = now;
    }
    for (const { id: key, software } of pass.admitted) this.admit(key, software, raw, now);
    for (const { id: key, reason } of pass.waiting) {
      const p = this.pending.get(key);
      if (p) this.markWaiting(p, reason, raw);
    }
    if (this.pending.size === 0) {
      this.stopTimers();
      return;
    }
    this.startTimer();
    if (queue.some((q) => q.busy)) this.pumpSoon();
  }

  /** The machine as admission should see it: memory that exports admitted a moment ago are still about to take is not free. */
  private withoutRampingMemory(snap: ResourceSnapshot, now: number): ResourceSnapshot {
    const ramping = this.rampingBytes(now);
    return ramping === 0 ? snap : { ...snap, availMemBytes: Math.max(0, snap.availMemBytes - ramping) };
  }

  private rampingBytes(now: number): number {
    let ramping = 0;
    for (const h of this.held.values()) {
      if (now - h.admittedAt < MEMORY_RAMP_MS) ramping += h.estimate.memoryBytes;
    }
    return ramping;
  }

  private admit(key: string, software: boolean, snap: ResourceSnapshot, now: number): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    if (p.onAbort) p.req.signal?.removeEventListener("abort", p.onAbort);
    this.waits.delete(p.req.id);
    const estimate = software ? softwareVariant(p.req.estimate, snap.cores) : p.req.estimate;
    const yieldCtl = new AbortController();
    const held: Held = { key, id: p.req.id, priority: p.req.priority, estimate, usesHwEncoder: estimate.hwEncoder, yieldCtl, admittedAt: now };
    this.held.set(key, held);
    let released = false;
    p.resolve({
      id: p.req.id,
      software,
      usesHwEncoder: held.usesHwEncoder,
      signal: yieldCtl.signal,
      release: () => {
        if (released) return;
        released = true;
        this.held.delete(key);
        this.pump();
      },
    });
    // After the resolve: a throwing logger must not leave an admitted slot with no owner.
    exportLogger.info(
      {
        op: "schedule_admit",
        exportId: p.req.id,
        reason: software ? "software_fallback" : "fits",
        running: this.held.size,
        availMB: Math.round(snap.availMemBytes / MB),
        rampMB: Math.round(this.rampingBytes(now) / MB),
        load1: Math.round(snap.load1 * 100) / 100,
        cores: snap.cores,
        estimateMB: Math.round(estimate.memoryBytes / MB),
        cpu: estimate.cpu,
      },
      "export.schedule_admit",
    );
  }

  private markWaiting(p: Pending, reason: ExportWaitReason, snap: ResourceSnapshot): void {
    const waiting: ExportWaiting = { reason, message: waitingMessage(reason, this.held.size) };
    this.waits.set(p.req.id, waiting);
    if (p.lastReason === reason) return;
    p.lastReason = reason;
    exportLogger.info(
      {
        op: "schedule_wait",
        exportId: p.req.id,
        reason,
        running: this.held.size,
        availMB: Math.round(snap.availMemBytes / MB),
        rampMB: Math.round(this.rampingBytes(this.now()) / MB),
        load1: Math.round(snap.load1 * 100) / 100,
        cores: snap.cores,
        estimateMB: Math.round(p.req.estimate.memoryBytes / MB),
        cpu: p.req.estimate.cpu,
      },
      "export.schedule_wait",
    );
    try {
      p.req.onWait?.(waiting);
    } catch (err) {
      this.callbackFailed("onWait", p.req.id, err);
    }
  }

  /** A request's `busy` callback; one that throws counts as not busy, so a background render is never held up forever by it. */
  private isBusy(p: Pending): boolean {
    try {
      return p.req.busy?.() ?? false;
    } catch (err) {
      this.callbackFailed("busy", p.req.id, err);
      return false;
    }
  }

  private callbackFailed(callback: "onWait" | "busy", exportId: string, err: unknown): void {
    exportLogger.warn(
      { op: "schedule_callback_failed", callback, exportId, error: errorText(err) },
      "export.schedule_callback_failed",
    );
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), this.deps.reevaluateMs ?? REEVALUATE_MS);
    this.timer.unref?.();
  }

  private pumpSoon(): void {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      this.pump();
    }, BUSY_POLL_MS);
    this.soon.unref?.();
  }

  private stopTimers(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.soon) clearTimeout(this.soon);
    this.soon = null;
  }
}

/** The machine now. `os.loadavg()` is [0, 0, 0] on Windows — the CPU rule then counts only running estimates. */
export function liveSnapshot(): ResourceSnapshot {
  return {
    cores: os.cpus().length,
    totalMemBytes: os.totalmem(),
    availMemBytes: getAvailableMemoryBytes(),
    load1: os.loadavg()[0] ?? 0,
  };
}

// One scheduler per process — survives Next.js HMR via globalThis, as JobManager does.
declare global {
  var __libiExportScheduler: ExportScheduler | undefined;
}

export function getExportScheduler(): ExportScheduler {
  if (!globalThis.__libiExportScheduler) {
    globalThis.__libiExportScheduler = new ExportScheduler({
      snapshot: liveSnapshot,
      config: {
        hwSessionCap: isMac() ? HW_SESSION_CAP_DARWIN : HW_SESSION_CAP_OTHER,
        softwareFallbackSafe: SOFTWARE_FALLBACK_SAFE,
      },
    });
  }
  return globalThis.__libiExportScheduler;
}
