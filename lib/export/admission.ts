/**
 * Admission for several exports at once (spec 2026-09-29 §B1). Pure: given the
 * queue, what is running, and a snapshot of the machine, decide who starts now
 * and why the rest wait. The stateful side (queue, timers, reservations) is
 * lib/export/scheduler.ts.
 */
import type { ExportWaitReason } from "@/lib/exports/types";
import { softwareVariant, type CostEstimate } from "./cost";

export const CPU_THRESHOLD = 0.9;
/** Re-evaluate this often while anything waits: memory frees on its own. */
export const REEVALUATE_MS = 5_000;
/** A request skipped this long becomes a barrier — nothing behind it starts. */
export const STARVATION_MS = 2 * 60_000;
export const MIN_RESERVE_BYTES = 1.5 * 1024 ** 3;
export const RESERVE_FRACTION = 0.15;

export type ExportPriority = "foreground" | "background";

export interface ResourceSnapshot {
  cores: number;
  totalMemBytes: number;
  /** getAvailableMemoryBytes() (lib/system/available-memory.ts). */
  availMemBytes: number;
  /** os.loadavg()[0]; 0 on Windows. */
  load1: number;
}

export interface RunningSlot {
  id: string;
  priority: ExportPriority;
  /** What it was admitted as (its software variant if it runs as software). */
  estimate: CostEstimate;
  usesHwEncoder: boolean;
}

export interface AdmissionConfig {
  hwSessionCap: number;
  softwareFallbackSafe: boolean;
}

export type Admission = { admit: true; software: boolean } | { admit: false; reason: ExportWaitReason };

/** clamp(floor(cores / 4), 1, 6) */
export function exportCap(cores: number): number {
  return Math.min(6, Math.max(1, Math.floor(cores / 4)));
}

/** max(1.5 GB, 15 % of total) */
export function memoryReserveBytes(totalMemBytes: number): number {
  return Math.max(MIN_RESERVE_BYTES, totalMemBytes * RESERVE_FRACTION);
}

/**
 * Memory, then CPU. The CPU rule is the spec's: `load1 / cores + Σ running cpu / cores ≤ 0.9`
 * (load1 lags, so exports that just started are added by their estimates). A SOFTWARE fallback
 * also counts its own cores (`countSelf`), since a libx264 export takes half the machine.
 */
function resourceReason(estimate: CostEstimate, snap: ResourceSnapshot, running: RunningSlot[], countSelf = false): ExportWaitReason | null {
  if (snap.availMemBytes - memoryReserveBytes(snap.totalMemBytes) < estimate.memoryBytes) return "memory";
  const runningCpu = running.reduce((sum, r) => sum + r.estimate.cpu, 0) + (countSelf ? estimate.cpu : 0);
  if (snap.load1 / snap.cores + runningCpu / snap.cores > CPU_THRESHOLD) return "cpu";
  return null;
}

export function canAdmit(estimate: CostEstimate, snap: ResourceSnapshot, running: RunningSlot[], config: AdmissionConfig): Admission {
  if (running.length === 0) return { admit: true, software: false };
  if (running.length >= exportCap(snap.cores)) return { admit: false, reason: "cap" };
  const reason = resourceReason(estimate, snap, running);
  if (reason) return { admit: false, reason };
  if (estimate.hwEncoder) {
    const inUse = running.filter((r) => r.usesHwEncoder).length;
    if (inUse >= config.hwSessionCap) {
      if (!config.softwareFallbackSafe || !estimate.softwareFallback) return { admit: false, reason: "encoder" };
      const swReason = resourceReason(softwareVariant(estimate, snap.cores), snap, running, true);
      if (swReason) return { admit: false, reason: swReason };
      return { admit: true, software: true };
    }
  }
  return { admit: true, software: false };
}

export interface QueuedRequest {
  id: string;
  priority: ExportPriority;
  estimate: CostEstimate;
  enqueuedAt: number;
  /** When a later request first started ahead of it; null while never skipped. */
  skippedSince: number | null;
  /** Background only: a foreground export is about to arrive (its job is queued). */
  busy: boolean;
}

export interface AdmissionPass {
  admitted: Array<{ id: string; software: boolean }>;
  waiting: Array<{ id: string; reason: ExportWaitReason }>;
  /** Waiting requests a later request started ahead of in this pass. */
  skipped: string[];
}

const PRIORITY_ORDER: Record<ExportPriority, number> = { foreground: 0, background: 1 };

/** One admission pass over the queue, in priority then arrival order. Pure. */
export function planAdmissions(
  queue: QueuedRequest[],
  snap: ResourceSnapshot,
  running: RunningSlot[],
  config: AdmissionConfig,
  now: number,
): AdmissionPass {
  const ordered = [...queue].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.enqueuedAt - b.enqueuedAt);
  const sim = [...running];
  const pass: AdmissionPass = { admitted: [], waiting: [], skipped: [] };
  const waitingSoFar: string[] = [];
  let barrier = false;
  let foregroundWaiting = false;
  // A request admitted earlier in this pass has not allocated anything yet, so
  // the snapshot cannot show its memory: count it here, or three renders that
  // each fit alone are admitted together and over-commit the machine.
  let reservedThisPass = 0;
  for (const r of ordered) {
    if (barrier) {
      pass.waiting.push({ id: r.id, reason: "queue" });
      continue;
    }
    if (r.priority === "background" && (foregroundWaiting || r.busy || sim.some((s) => s.priority === "foreground"))) {
      pass.waiting.push({ id: r.id, reason: "queue" });
      continue;
    }
    const decision = canAdmit(r.estimate, { ...snap, availMemBytes: snap.availMemBytes - reservedThisPass }, sim, config);
    if (decision.admit) {
      pass.admitted.push({ id: r.id, software: decision.software });
      const estimate = decision.software ? softwareVariant(r.estimate, snap.cores) : r.estimate;
      reservedThisPass += estimate.memoryBytes;
      sim.push({ id: r.id, priority: r.priority, estimate, usesHwEncoder: estimate.hwEncoder });
      for (const id of waitingSoFar) if (!pass.skipped.includes(id)) pass.skipped.push(id);
      continue;
    }
    pass.waiting.push({ id: r.id, reason: decision.reason });
    waitingSoFar.push(r.id);
    if (r.priority === "foreground") foregroundWaiting = true;
    if (r.skippedSince !== null && now - r.skippedSince > STARVATION_MS) barrier = true;
  }
  return pass;
}

const REASON_TEXT: Record<ExportWaitReason, string> = {
  memory: "Waiting for memory",
  cpu: "Waiting for the processor",
  encoder: "Waiting for the video encoder",
  cap: "Waiting for a free export slot",
  queue: "Waiting for earlier exports",
};

/** "Waiting for memory — 2 exports running" */
export function waitingMessage(reason: ExportWaitReason, runningCount: number): string {
  return `${REASON_TEXT[reason]} — ${runningCount} export${runningCount === 1 ? "" : "s"} running`;
}
