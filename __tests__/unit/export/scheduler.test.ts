import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exportLogger } from "@/lib/logger";
import { ExportScheduler, MEMORY_RAMP_MS, isBackgroundYield, isHwEncoderSessionError, type AcquireRequest } from "@/lib/export/scheduler";
import type { ResourceSnapshot } from "@/lib/export/admission";
import type { CostEstimate } from "@/lib/export/cost";

const GB = 1024 ** 3;
let snap: ResourceSnapshot;
const est = (over: Partial<CostEstimate> = {}): CostEstimate => ({
  backend: "ffmpeg-overlay", memoryBytes: 1 * GB, cpu: 1, hwEncoder: false, softwareFallback: false, renderWorkers: 0, ...over,
});
function make(hwSessionCap = 2) {
  return new ExportScheduler({ snapshot: () => snap, config: { hwSessionCap, softwareFallbackSafe: false }, reevaluateMs: 20 });
}
const req = (id: string, over: Partial<AcquireRequest> = {}): AcquireRequest => ({ id, priority: "foreground", estimate: est(), ...over });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  // 8 cores → cap 2.
  snap = { cores: 8, totalMemBytes: 16 * GB, availMemBytes: 12 * GB, load1: 0 };
});
afterEach(() => vi.restoreAllMocks());

describe("ExportScheduler", () => {
  it("admits at once when idle; a release lets the next one in", async () => {
    const s = make();
    const a = await s.acquire(req("a"));
    const b = await s.acquire(req("b"));
    expect(s.runningCount()).toBe(2);
    let cIn = false;
    const c = s.acquire(req("c")).then((r) => ((cIn = true), r));
    await tick();
    expect(cIn).toBe(false);
    a.release();
    a.release(); // idempotent
    const cRes = await c;
    expect(s.runningCount()).toBe(2);
    b.release();
    cRes.release();
    expect(s.runningCount()).toBe(0);
  });

  it("says why it waits, with the running count, and logs admit/wait without user text", async () => {
    const info = vi.spyOn(exportLogger, "info");
    const s = make();
    const a = await s.acquire(req("exp_a"));
    const b = await s.acquire(req("exp_b"));
    const onWait = vi.fn();
    const c = s.acquire(req("exp_c", { onWait }));
    await tick();
    expect(onWait).toHaveBeenCalledWith({ reason: "cap", message: "Waiting for a free export slot — 2 exports running" });
    expect(s.waitingInfo("exp_c")).toEqual({ reason: "cap", message: "Waiting for a free export slot — 2 exports running" });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ op: "schedule_wait", exportId: "exp_c", reason: "cap", running: 2, availMB: 12288, load1: 0, cores: 8, estimateMB: 1024, cpu: 1 }),
      "export.schedule_wait",
    );
    a.release();
    (await c).release();
    b.release();
    expect(s.waitingInfo("exp_c")).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ op: "schedule_admit", exportId: "exp_c" }), "export.schedule_admit");
  });

  it("re-evaluates on a timer: memory that frees on its own lets a waiting export in", async () => {
    const s = make();
    const a = await s.acquire(req("a"));
    snap = { ...snap, availMemBytes: 2 * GB }; // 2 GB − 2.4 GB reserve: nothing fits
    let bIn = false;
    const b = s.acquire(req("b")).then((r) => ((bIn = true), r));
    await tick(40);
    expect(bIn).toBe(false);
    expect(s.waitingInfo("b")?.reason).toBe("memory");
    snap = { ...snap, availMemBytes: 12 * GB };
    await vi.waitFor(() => expect(bIn).toBe(true)); // the next 20 ms re-evaluation lets it in
    a.release();
    (await b).release();
  });

  it("a cancel while waiting leaves the queue at once", async () => {
    const s = make();
    const a = await s.acquire(req("a"));
    const b = await s.acquire(req("b"));
    const ac = new AbortController();
    const c = s.acquire(req("c", { signal: ac.signal }));
    await tick();
    ac.abort(new Error("cancelled"));
    await expect(c).rejects.toThrow("cancelled");
    expect(s.waitingInfo("c")).toBeNull();
    a.release();
    b.release();
    expect(s.runningCount()).toBe(0);
  });

  it("a background render yields to a foreground export, which starts once it has let go", async () => {
    const s = make();
    const bg = await s.acquire(req("bg", { priority: "background" }));
    let fgIn = false;
    const fg = s.acquire(req("fg")).then((r) => ((fgIn = true), r));
    await tick();
    expect(bg.signal.aborted).toBe(true);
    expect(isBackgroundYield(bg.signal.reason)).toBe(true);
    expect(fgIn).toBe(false);
    bg.release();
    (await fg).release();
    expect(fgIn).toBe(true);
  });

  it("a background render waits while a foreground export runs or `busy` says one is coming", async () => {
    const s = make();
    const fg = await s.acquire(req("fg"));
    let busy = true;
    let bgIn = false;
    const bg = s.acquire(req("bg", { priority: "background", busy: () => busy })).then((r) => ((bgIn = true), r));
    fg.release();
    await tick(40);
    expect(bgIn).toBe(false);
    busy = false;
    await vi.waitFor(() => expect(bgIn).toBe(true));
    (await bg).release();
  });

  it("lowers the hardware session cap for the process after an encoder refusal, and says so", async () => {
    const warn = vi.spyOn(exportLogger, "warn");
    const s = make(2);
    const hw = est({ hwEncoder: true, softwareFallback: true });
    const a = await s.acquire(req("a", { estimate: hw }));
    s.lowerHwSessionCap("a");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ op: "schedule_hw_cap_lowered", exportId: "a", from: 2, to: 1 }), "export.schedule_hw_cap_lowered");
    const b = s.acquire(req("b", { estimate: hw }));
    await tick();
    expect(s.waitingInfo("b")?.reason).toBe("encoder");
    a.release();
    (await b).release();
  });

  it("shares render workers: min(normal, cores − 2 − held), at least 1; an explicit env override wins", () => {
    const s = make();
    const first = s.leaseRenderWorkers(undefined, "software", 8);
    const second = s.leaseRenderWorkers(undefined, "software", 8);
    const third = s.leaseRenderWorkers(undefined, "software", 8);
    expect([first.workers, second.workers, third.workers]).toEqual([4, 2, 1]);
    expect(s.heldRenderWorkers()).toBe(7);
    second.release();
    third.release();
    expect(s.leaseRenderWorkers(undefined, "software", 8).workers).toBe(2);
    expect(s.leaseRenderWorkers("6", "software", 8).workers).toBe(6);
    first.release();
  });
});

describe("isHwEncoderSessionError", () => {
  it("recognises an encoder-SESSION refusal and nothing else", () => {
    expect(isHwEncoderSessionError("ffmpeg exited with code 187: [h264_videotoolbox] Error: cannot create compression session: -12903")).toBe(true);
    expect(isHwEncoderSessionError("VTCompressionSessionCreate failed")).toBe(true);
    expect(isHwEncoderSessionError("[h264_nvenc] OpenEncodeSessionEx failed: out of memory (10)")).toBe(true);
  });
  it("is not fooled by ffmpeg's generic encoder-open failure (a bad parameter) or other errors", () => {
    expect(isHwEncoderSessionError("Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height")).toBe(false);
    expect(isHwEncoderSessionError("No capable devices found")).toBe(false);
    expect(isHwEncoderSessionError("Invalid data found when processing input")).toBe(false);
  });
});

describe("ExportScheduler — memory still ramping up", () => {
  function timed(now: () => number) {
    return new ExportScheduler({ snapshot: () => snap, config: { hwSessionCap: 2, softwareFallbackSafe: false }, reevaluateMs: 20, now });
  }

  it("counts what a just-admitted export will take, so the next tick does not over-admit; it stops counting after MEMORY_RAMP_MS", async () => {
    let t = 1_000;
    const info = vi.spyOn(exportLogger, "info");
    const s = timed(() => t);
    const six = est({ memoryBytes: 6 * GB });
    // 12 GB available − 2.4 GB reserve: 9.6 GB free. The first takes 6 GB of it.
    const a = await s.acquire(req("a", { estimate: six }));
    let bIn = false;
    const b = s.acquire(req("b", { estimate: six })).then((r) => ((bIn = true), r));
    await tick(60); // several 20 ms re-evaluations: the OS figure still says 12 GB free
    expect(bIn).toBe(false);
    expect(s.waitingInfo("b")?.reason).toBe("memory");
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ op: "schedule_wait", exportId: "b", reason: "memory", availMB: 12288, rampMB: 6144 }), "export.schedule_wait");
    t += MEMORY_RAMP_MS + 1; // by now the first has allocated and the OS figure shows it
    await vi.waitFor(() => expect(bIn).toBe(true));
    a.release();
    (await b).release();
  });

  it("does not count a released export's ramp, and never blocks the first export", async () => {
    const t = 1_000;
    const s = timed(() => t);
    const huge = est({ memoryBytes: 64 * GB });
    const a = await s.acquire(req("a", { estimate: huge })); // nothing running: admitted whatever it needs
    a.release();
    const b = await s.acquire(req("b", { estimate: est({ memoryBytes: 6 * GB }) }));
    expect(s.runningCount()).toBe(1);
    b.release();
  });
});

describe("ExportScheduler — a reservation is always given back", () => {
  it("a cancel while waiting and a release after admission both leave nothing held, however often called", async () => {
    const s = make();
    const a = await s.acquire(req("a"));
    const b = await s.acquire(req("b"));
    const ac = new AbortController();
    const c = s.acquire(req("c", { signal: ac.signal }));
    await tick();
    ac.abort(new Error("cancelled"));
    await expect(c).rejects.toThrow("cancelled");
    a.release();
    b.release();
    b.release();
    expect(s.runningCount()).toBe(0);
    // A request whose signal is already aborted never enters the queue.
    await expect(s.acquire(req("d", { signal: AbortSignal.abort(new Error("gone")) }))).rejects.toThrow("gone");
    expect(s.runningCount()).toBe(0);
    expect(s.waitingInfo("d")).toBeNull();
  });
});

describe("ExportScheduler — the render mode a Chromium estimate is sized by", () => {
  it("is unknown until export_render has probed one, and an undefined probe does not erase it", () => {
    const s = make();
    expect(s.knownRenderMode()).toBeUndefined();
    s.noteRenderMode("software");
    expect(s.knownRenderMode()).toBe("software");
    s.noteRenderMode(undefined);
    expect(s.knownRenderMode()).toBe("software");
    s.noteRenderMode("gpu");
    expect(s.knownRenderMode()).toBe("gpu");
  });
});

describe("ExportScheduler — a throwing callback or pass never leaks a slot", () => {
  it("an onWait that throws is logged and the queue still drains", async () => {
    const warn = vi.spyOn(exportLogger, "warn");
    const s = make();
    const a = await s.acquire(req("a"));
    const b = await s.acquire(req("b"));
    const onWait = vi.fn(() => {
      throw new Error("progress sink down");
    });
    const c = s.acquire(req("exp_c", { onWait }));
    await tick();
    expect(onWait).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ op: "schedule_callback_failed", callback: "onWait", exportId: "exp_c", error: "progress sink down" }),
      "export.schedule_callback_failed",
    );
    expect(s.waitingInfo("exp_c")?.reason).toBe("cap");
    a.release();
    const cRes = await c;
    expect(s.runningCount()).toBe(2);
    cRes.release();
    b.release();
    expect(s.runningCount()).toBe(0);
  });

  it("a background's busy() that throws counts as not busy, so it is admitted rather than held forever", async () => {
    const warn = vi.spyOn(exportLogger, "warn");
    const s = make();
    const r = await s.acquire(req("bg", { priority: "background", busy: () => { throw new Error("busy read failed"); } }));
    expect(s.runningCount()).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ op: "schedule_callback_failed", callback: "busy", exportId: "bg" }), "export.schedule_callback_failed");
    r.release();
    expect(s.runningCount()).toBe(0);
  });

  it("a pass that throws inside acquire rejects that request and leaves nothing queued or held", async () => {
    const error = vi.spyOn(exportLogger, "error");
    let boom = true;
    const s = new ExportScheduler({
      snapshot: () => {
        if (boom) throw new Error("snapshot exploded");
        return snap;
      },
      config: { hwSessionCap: 2, softwareFallbackSafe: false },
      reevaluateMs: 20,
    });
    await expect(s.acquire(req("a"))).rejects.toThrow("snapshot exploded");
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ op: "schedule_pump_failed" }), "export.schedule_pump_failed");
    expect(s.runningCount()).toBe(0);
    expect(s.waitingInfo("a")).toBeNull();
    // Nothing is left behind to hold a later request back: it is admitted once the pass works.
    boom = false;
    const b = await s.acquire(req("b"));
    expect(s.runningCount()).toBe(1);
    b.release();
    expect(s.runningCount()).toBe(0);
  });

  it("a pass that throws on a release or a timer tick never throws out of it, and the queue drains once it recovers", async () => {
    vi.spyOn(exportLogger, "error").mockImplementation(() => {});
    let boom = false;
    const s = new ExportScheduler({
      snapshot: () => {
        if (boom) throw new Error("snapshot exploded");
        return snap;
      },
      config: { hwSessionCap: 2, softwareFallbackSafe: false },
      reevaluateMs: 20,
    });
    const a = await s.acquire(req("a"));
    const b = await s.acquire(req("b"));
    const c = s.acquire(req("c"));
    await tick();
    boom = true;
    expect(() => a.release()).not.toThrow(); // release() pumps, and is called from a finally
    await tick(80); // several failing timer ticks — an uncaught one would fail the run
    expect(s.runningCount()).toBe(1);
    boom = false;
    const cRes = await c;
    expect(s.runningCount()).toBe(2);
    cRes.release();
    b.release();
    expect(s.runningCount()).toBe(0);
  });
});

