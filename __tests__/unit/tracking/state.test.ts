import { describe, it, expect } from "vitest";
import { nextTrackState } from "@/lib/tracking/state";

describe("nextTrackState", () => {
  it("idle → queued on enqueue", () => {
    expect(nextTrackState("idle", { type: "enqueue" })).toBe("queued");
  });
  it("queued → running on start", () => {
    expect(nextTrackState("queued", { type: "start" })).toBe("running");
  });
  it("running → ready on success", () => {
    expect(nextTrackState("running", { type: "success" })).toBe("ready");
  });
  it("running → failed on error", () => {
    expect(nextTrackState("running", { type: "error" })).toBe("failed");
  });
  it("ready → queued on regen", () => {
    expect(nextTrackState("ready", { type: "enqueue" })).toBe("queued");
  });
  it("failed → queued on retry", () => {
    expect(nextTrackState("failed", { type: "enqueue" })).toBe("queued");
  });
  it("invalid transition throws", () => {
    expect(() => nextTrackState("ready", { type: "start" } as never)).toThrow();
  });
});
