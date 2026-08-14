import { describe, it, expect, vi } from "vitest";
import { playWindowOnce, type PlayWindowTransport } from "@/lib/preview/play-window-once";

function fakeTransport(initialFrame = 0) {
  let frame = initialFrame;
  const subs = new Set<() => void>();
  const t: PlayWindowTransport & { emit(f: number): void } = {
    seek: vi.fn((f: number) => {
      frame = f;
    }),
    play: vi.fn(),
    pause: vi.fn(),
    frameStore: {
      get: () => frame,
      subscribe: (cb: () => void) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    },
    emit(f: number) {
      frame = f;
      for (const cb of subs) cb();
    },
  };
  return t;
}

describe("playWindowOnce", () => {
  it("seeks to start and plays", () => {
    const t = fakeTransport();
    playWindowOnce({ transport: t, startFrame: 30, endFrame: 90 });
    expect(t.seek).toHaveBeenCalledWith(30);
    expect(t.play).toHaveBeenCalled();
  });

  it("pauses once the playhead reaches endFrame", () => {
    const t = fakeTransport();
    playWindowOnce({ transport: t, startFrame: 30, endFrame: 90 });
    t.emit(60);
    expect(t.pause).not.toHaveBeenCalled();
    t.emit(90);
    expect(t.pause).toHaveBeenCalledTimes(1);
  });

  it("pauses if the playhead scrubs back before startFrame", () => {
    const t = fakeTransport();
    playWindowOnce({ transport: t, startFrame: 30, endFrame: 90 });
    t.emit(10);
    expect(t.pause).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a non-positive window", () => {
    const t = fakeTransport();
    const teardown = playWindowOnce({ transport: t, startFrame: 90, endFrame: 90 });
    expect(t.seek).not.toHaveBeenCalled();
    expect(t.play).not.toHaveBeenCalled();
    teardown();
  });

  it("teardown unsubscribes the watcher", () => {
    const t = fakeTransport();
    const teardown = playWindowOnce({ transport: t, startFrame: 30, endFrame: 90 });
    teardown();
    t.emit(90);
    expect(t.pause).not.toHaveBeenCalled();
  });
});
