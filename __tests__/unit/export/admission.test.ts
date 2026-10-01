import { describe, it, expect } from "vitest";
import {
  CPU_THRESHOLD,
  STARVATION_MS,
  canAdmit,
  exportCap,
  memoryReserveBytes,
  planAdmissions,
  waitingMessage,
  type QueuedRequest,
  type ResourceSnapshot,
  type RunningSlot,
} from "@/lib/export/admission";
import { type CostEstimate } from "@/lib/export/cost";

const GB = 1024 ** 3;
const SNAP: ResourceSnapshot = { cores: 16, totalMemBytes: 32 * GB, availMemBytes: 20 * GB, load1: 0 };
const CONFIG = { hwSessionCap: 2, softwareFallbackSafe: false };
const est = (over: Partial<CostEstimate> = {}): CostEstimate => ({
  backend: "ffmpeg-overlay", memoryBytes: 1 * GB, cpu: 1, hwEncoder: false, softwareFallback: false, renderWorkers: 0, ...over,
});
const slot = (id: string, over: Partial<CostEstimate> = {}, priority: "foreground" | "background" = "foreground"): RunningSlot => ({
  id, priority, estimate: est(over), usesHwEncoder: !!over.hwEncoder,
});
const req = (id: string, over: Partial<QueuedRequest> = {}): QueuedRequest => ({
  id, priority: "foreground", estimate: est(), enqueuedAt: 0, skippedSince: null, busy: false, ...over,
});

describe("the limits", () => {
  it("cap = clamp(floor(cores / 4), 1, 6)", () => {
    expect([1, 4, 7, 8, 16, 18, 24, 64].map(exportCap)).toEqual([1, 1, 1, 2, 4, 4, 6, 6]);
  });
  it("reserve = max(1.5 GB, 15 % of total)", () => {
    expect(memoryReserveBytes(8 * GB)).toBe(1.5 * GB);
    expect(memoryReserveBytes(32 * GB)).toBeCloseTo(4.8 * GB);
  });
});

describe("canAdmit", () => {
  it("admits anything when nothing runs (never starve), even a request that does not fit", () => {
    expect(canAdmit(est({ memoryBytes: 100 * GB }), SNAP, [], CONFIG)).toEqual({ admit: true, software: false });
  });

  it("waits for the cap", () => {
    const running = [slot("a"), slot("b"), slot("c"), slot("d")];
    expect(canAdmit(est(), SNAP, running, CONFIG)).toEqual({ admit: false, reason: "cap" });
  });

  it("waits for memory: available minus the reserve must cover the estimate", () => {
    const snap = { ...SNAP, availMemBytes: memoryReserveBytes(SNAP.totalMemBytes) + 0.5 * GB };
    expect(canAdmit(est({ memoryBytes: 1 * GB }), snap, [slot("a")], CONFIG)).toEqual({ admit: false, reason: "memory" });
    expect(canAdmit(est({ memoryBytes: 0.4 * GB }), snap, [slot("a")], CONFIG)).toEqual({ admit: true, software: false });
  });

  it("waits for the CPU: load1/cores + Σ running cpu/cores must stay ≤ 0.9", () => {
    const busy = { ...SNAP, load1: 10 };
    // 10/16 + 5/16 = 0.9375 > 0.9
    expect(canAdmit(est(), busy, [slot("a", { cpu: 5 })], CONFIG)).toEqual({ admit: false, reason: "cpu" });
    // 10/16 + 4/16 = 0.875 ≤ 0.9
    expect(canAdmit(est(), busy, [slot("a", { cpu: 4 })], CONFIG)).toEqual({ admit: true, software: false });
    expect(CPU_THRESHOLD).toBe(0.9);
  });

  it("waits for the encoder when every hardware session is taken", () => {
    const running = [slot("a", { hwEncoder: true }), slot("b", { hwEncoder: true })];
    expect(canAdmit(est({ hwEncoder: true, softwareFallback: true }), SNAP, running, CONFIG)).toEqual({ admit: false, reason: "encoder" });
  });

  it("runs it as software instead only when B0 says that is safe and CPU still allows", () => {
    const running = [slot("a", { hwEncoder: true }), slot("b", { hwEncoder: true })];
    const safe = { ...CONFIG, softwareFallbackSafe: true };
    expect(canAdmit(est({ hwEncoder: true, softwareFallback: true }), SNAP, running, safe)).toEqual({ admit: true, software: true });
    expect(canAdmit(est({ hwEncoder: true, softwareFallback: true }), { ...SNAP, load1: 13 }, running, safe)).toEqual({ admit: false, reason: "cpu" });
  });

  it("the software fallback counts its own cores: 6/16 load + (2 + 8)/16 > 0.9 waits for the CPU", () => {
    const running = [slot("a", { hwEncoder: true }), slot("b", { hwEncoder: true })];
    const safe = { ...CONFIG, softwareFallbackSafe: true };
    // As hardware it would pass the CPU rule (6/16 + 2/16 = 0.5); as software it may not start.
    expect(canAdmit(est({ hwEncoder: true, softwareFallback: true }), { ...SNAP, load1: 6 }, running, safe)).toEqual({ admit: false, reason: "cpu" });
  });
});

describe("planAdmissions", () => {
  it("foreground before background, FIFO within a priority", () => {
    const pass = planAdmissions(
      [req("bg", { priority: "background", enqueuedAt: 0 }), req("fg2", { enqueuedAt: 2 }), req("fg1", { enqueuedAt: 1 })],
      SNAP, [], CONFIG, 10,
    );
    expect(pass.admitted.map((a) => a.id)).toEqual(["fg1", "fg2"]);
    expect(pass.waiting).toEqual([{ id: "bg", reason: "queue" }]);
  });

  it("a background render waits while any foreground export runs, or while `busy` says one is coming", () => {
    expect(planAdmissions([req("bg", { priority: "background" })], SNAP, [slot("fg")], CONFIG, 0).admitted).toEqual([]);
    expect(planAdmissions([req("bg", { priority: "background", busy: true })], SNAP, [], CONFIG, 0).admitted).toEqual([]);
    expect(planAdmissions([req("bg", { priority: "background" })], SNAP, [], CONFIG, 0).admitted).toEqual([{ id: "bg", software: false }]);
  });

  it("skip-ahead: a head that does not fit does not block a cheaper one behind it", () => {
    const snap = { ...SNAP, availMemBytes: memoryReserveBytes(SNAP.totalMemBytes) + 2 * GB };
    const pass = planAdmissions([req("big", { estimate: est({ memoryBytes: 8 * GB }) }), req("small", { enqueuedAt: 1 })], snap, [slot("r")], CONFIG, 10);
    expect(pass.admitted.map((a) => a.id)).toEqual(["small"]);
    expect(pass.waiting).toEqual([{ id: "big", reason: "memory" }]);
    expect(pass.skipped).toEqual(["big"]);
  });

  it("a request skipped for more than 2 minutes becomes a barrier", () => {
    const snap = { ...SNAP, availMemBytes: memoryReserveBytes(SNAP.totalMemBytes) + 2 * GB };
    const queue = [req("big", { estimate: est({ memoryBytes: 8 * GB }), skippedSince: 0 }), req("small", { enqueuedAt: 1 })];
    const pass = planAdmissions(queue, snap, [slot("r")], CONFIG, STARVATION_MS + 1);
    expect(pass.admitted).toEqual([]);
    expect(pass.waiting).toEqual([
      { id: "big", reason: "memory" },
      { id: "small", reason: "queue" },
    ]);
  });

  it("memory admitted earlier in the same pass counts against the next: two that fit alone but not together", () => {
    // 20 GB avail − 4.8 GB reserve = 15.2 GB free; each request is 8 GB.
    const big = est({ memoryBytes: 8 * GB });
    const pass = planAdmissions([req("a", { estimate: big }), req("b", { estimate: big, enqueuedAt: 1 })], SNAP, [slot("r")], CONFIG, 0);
    expect(pass.admitted.map((a) => a.id)).toEqual(["a"]);
    expect(pass.waiting).toEqual([{ id: "b", reason: "memory" }]);
  });

  it("a barrier request that can never fit is admitted once nothing is running (never starve)", () => {
    const queue = [req("huge", { estimate: est({ memoryBytes: 100 * GB }), skippedSince: 0 }), req("small", { enqueuedAt: 1 })];
    const pass = planAdmissions(queue, SNAP, [], CONFIG, STARVATION_MS + 1);
    expect(pass.admitted).toEqual([{ id: "huge", software: false }]);
    // Its 100 GB is counted, so nothing else starts beside it.
    expect(pass.waiting).toEqual([{ id: "small", reason: "memory" }]);
  });

  it("each admission counts against the next in the same pass (cap and encoder sessions)", () => {
    const hw = est({ hwEncoder: true, softwareFallback: true });
    const pass = planAdmissions([req("a", { estimate: hw }), req("b", { estimate: hw, enqueuedAt: 1 }), req("c", { estimate: hw, enqueuedAt: 2 })], SNAP, [], CONFIG, 0);
    expect(pass.admitted.map((a) => a.id)).toEqual(["a", "b"]);
    expect(pass.waiting).toEqual([{ id: "c", reason: "encoder" }]);
  });
});

describe("waitingMessage", () => {
  it("names the reason and how many exports are running", () => {
    expect(waitingMessage("memory", 2)).toBe("Waiting for memory — 2 exports running");
    expect(waitingMessage("cpu", 1)).toBe("Waiting for the processor — 1 export running");
    expect(waitingMessage("encoder", 2)).toBe("Waiting for the video encoder — 2 exports running");
    expect(waitingMessage("cap", 4)).toBe("Waiting for a free export slot — 4 exports running");
    expect(waitingMessage("queue", 3)).toBe("Waiting for earlier exports — 3 exports running");
  });
});
