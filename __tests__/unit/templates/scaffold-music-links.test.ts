import { describe, it, expect } from "vitest";
import { validateScaffold } from "@/lib/templates/scaffold";
import { makeScaffold } from "@/__tests__/helpers/templates";
import { musicNotIncluded } from "@/lib/templates/music-links";

const clip = { key: "song", kind: "standalone" as const, startTime: 0, duration: 3, trimStart: 12, volume: 0.8, enabled: true, source: { musicRef: "espresso" } };
const link = { ref: "espresso", track: { title: "Espresso", artist: "Sabrina Carpenter" }, sourceUrl: "https://www.youtube.com/watch?v=abc" };

describe("scaffold musicLinks", () => {
  it("an audio clip may name a music link", () => {
    const v = validateScaffold(makeScaffold({ audioClips: [clip], musicLinks: [link] } as never));
    expect(v.ok).toBe(true);
    expect(musicNotIncluded(v.ok ? v.scaffold : {})).toEqual(["Espresso — Sabrina Carpenter"]);
  });
  it("an old scaffold with no musicLinks is still valid", () => {
    expect(validateScaffold(makeScaffold()).ok).toBe(true);
  });
  it("refuses a missing link, a video overlay naming one, a duplicate ref, and an http source", () => {
    expect(validateScaffold(makeScaffold({ audioClips: [clip] } as never)).ok).toBe(false);
    const overlay = { key: "v", kind: "video", rect: { x: 0, y: 0, width: 1, height: 1 }, startTime: 0, duration: 1, z: 0, opacity: 1, source: { musicRef: "espresso" } };
    expect(validateScaffold(makeScaffold({ overlays: [overlay], musicLinks: [link] } as never)).ok).toBe(false);
    expect(validateScaffold(makeScaffold({ audioClips: [clip], musicLinks: [{ ...link, ref: "clip" }] } as never)).ok).toBe(false); // "clip" is an asset ref
    expect(validateScaffold(makeScaffold({ audioClips: [clip], musicLinks: [{ ...link, sourceUrl: "http://x.example/a" }] } as never)).ok).toBe(false);
  });
});
