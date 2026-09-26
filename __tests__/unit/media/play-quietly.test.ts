import { describe, it, expect, vi } from "vitest";
import { playQuietly } from "@/lib/media/play-quietly";

const el = (play: () => unknown) => ({ play }) as unknown as HTMLMediaElement;

describe("playQuietly", () => {
  it("resolves when play() resolves", async () => {
    const play = vi.fn(() => Promise.resolve());
    await expect(playQuietly(el(play))).resolves.toBeUndefined();
    expect(play).toHaveBeenCalledOnce();
  });

  it("swallows a rejected play() (autoplay blocked)", async () => {
    await expect(playQuietly(el(() => Promise.reject(new DOMException("blocked", "NotAllowedError"))))).resolves.toBeUndefined();
  });

  it("copes with a DOM whose play() returns undefined — the full-suite flake", async () => {
    await expect(playQuietly(el(() => undefined))).resolves.toBeUndefined();
  });

  it("copes with a play() that throws, and with no element", async () => {
    await expect(playQuietly(el(() => { throw new Error("not implemented"); }))).resolves.toBeUndefined();
    await expect(playQuietly(null)).resolves.toBeUndefined();
  });
});
