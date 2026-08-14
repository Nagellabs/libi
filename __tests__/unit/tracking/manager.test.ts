import { describe, it, expect, vi } from "vitest";
import { TrackingManager } from "@/lib/tracking/manager";

const baseArgs = {
  pieceId: "p", fileId: "f", fileUrl: "/x",
  fps: 30, method: "mediapipe-face" as const, objectKind: "face" as const,
};

describe("TrackingManager", () => {
  it("dedupes overlapping enqueues for the same key", async () => {
    const fakeRunner = vi.fn().mockImplementation(
      () => new Promise((res) => setTimeout(() => res({ samples: [], framerate: 30 }), 50)),
    );
    const m = new TrackingManager({ runner: fakeRunner });
    const a = m.enqueue({ jobKey: "k1", trackId: "t1", ...baseArgs });
    const b = m.enqueue({ jobKey: "k1", trackId: "t1", ...baseArgs });
    await Promise.all([a, b]);
    expect(fakeRunner).toHaveBeenCalledTimes(1);
  });

  it("emits state events queued → running → ready", async () => {
    const fakeRunner = vi.fn().mockResolvedValue({ samples: [], framerate: 30 });
    const m = new TrackingManager({ runner: fakeRunner });
    const states: string[] = [];
    m.on("state", (e) => states.push(e.state));
    await m.enqueue({ jobKey: "k2", trackId: "t2", ...baseArgs });
    expect(states).toEqual(["queued", "running", "ready"]);
  });

  it("emits failed on runner error", async () => {
    const fakeRunner = vi.fn().mockImplementation(() => Promise.reject(new Error("boom")));
    const m = new TrackingManager({ runner: fakeRunner });
    const states: string[] = [];
    m.on("state", (e) => states.push(e.state));
    let thrown: unknown;
    try {
      await m.enqueue({ jobKey: "k3", trackId: "t3", ...baseArgs });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("boom");
    expect(states).toEqual(["queued", "running", "failed"]);
  });
});
