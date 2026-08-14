import { describe, it, expect } from "vitest";
import {
  capChars,
  capWords,
  overlayTrackLabel,
  overlayTrackTooltip,
  audioTrackLabel,
  MEDIA_NAME_MAX,
} from "@/lib/preview/track-labels";
import type { Overlay } from "@/lib/engine/types";

const base = {
  startTime: 0,
  duration: 5,
  z: 0,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  opacity: 1,
} as const;

describe("capChars / capWords", () => {
  it("capChars hard-caps with an ellipsis and collapses whitespace", () => {
    expect(capChars("hello", 10)).toBe("hello");
    expect(capChars("hello   world", 8)).toBe("hello wo…");
  });

  it("capWords never splits a word (char + word caps)", () => {
    // 18 chars / 3 words → fits the 20-char/3-word media cap.
    expect(capWords("Korean girls dance", MEDIA_NAME_MAX, 3)).toBe("Korean girls dance");
    // 4 words → trimmed to 3 whole words.
    expect(capWords("a b c d", 20, 3)).toBe("a b c…");
    expect(capWords("sunset", MEDIA_NAME_MAX, 3)).toBe("sunset"); // fits
    // First word longer than the char cap → hard char cap.
    expect(capWords("supercalifragilisticexpialidocious", 10)).toBe("supercalif…");
  });
});

describe("overlayTrackLabel", () => {
  it("text → its content (no prefix)", () => {
    const o = { ...base, id: "t", kind: "text", content: "Hello there" } as unknown as Overlay;
    expect(overlayTrackLabel(o)).toBe("Hello there");
  });

  it("code / three → 'kind - displayName'", () => {
    const code = { ...base, id: "c", kind: "code", displayName: "Intro Title", drawFunction: "" } as unknown as Overlay;
    const three = { ...base, id: "h", kind: "three", displayName: "Logo Spin", sceneFunction: "" } as unknown as Overlay;
    expect(overlayTrackLabel(code)).toBe("code - Intro Title");
    expect(overlayTrackLabel(three)).toBe("three - Logo Spin");
  });

  it("image / video → name capped to 3 words / 20 chars on a word boundary", () => {
    const img = { ...base, id: "i", kind: "image", fileId: "f" } as unknown as Overlay;
    // "Korean girls dance.png" = 22 chars > 20 → stop before the 3rd word.
    expect(overlayTrackLabel(img, "Korean girls dance.png")).toBe("Korean girls…");
    const vid = { ...base, id: "v", kind: "video", fileId: "f" } as unknown as Overlay;
    expect(overlayTrackLabel(vid, "clip.mp4")).toBe("clip.mp4"); // fits
  });

  it("image/video prefer an explicit displayName over the file name", () => {
    const img = { ...base, id: "i", kind: "image", fileId: "f", displayName: "Hero" } as unknown as Overlay;
    expect(overlayTrackLabel(img, "some-long-file-name.png")).toBe("Hero");
  });
});

describe("overlayTrackTooltip (rail-icon hover — full name + attached note)", () => {
  it("code/three → 'kind — full displayName' (uncapped)", () => {
    const code = { ...base, id: "c", kind: "code", displayName: "A Very Long Intro Title Name", drawFunction: "" } as unknown as Overlay;
    expect(overlayTrackTooltip(code)).toBe("code — A Very Long Intro Title Name");
  });
  it("video → notes whether audio is attached", () => {
    const vid = { ...base, id: "v", kind: "video", fileId: "f" } as unknown as Overlay;
    expect(overlayTrackTooltip(vid, "clip.mp4", true)).toBe("video — clip.mp4 · audio attached");
    expect(overlayTrackTooltip(vid, "clip.mp4", false)).toBe("video — clip.mp4 · no attached audio");
  });
  it("text → full content", () => {
    const t = { ...base, id: "t", kind: "text", content: "Hello world" } as unknown as Overlay;
    expect(overlayTrackTooltip(t)).toBe("text — Hello world");
  });
});

describe("audioTrackLabel", () => {
  it("inline audio → 'audio of video - <name>'", () => {
    expect(audioTrackLabel({ inline: true, videoName: "clip.mp4" })).toBe("audio of video - clip.mp4");
  });
  it("standalone → its own label", () => {
    expect(audioTrackLabel({ inline: false, clipLabel: "Voiceover" })).toBe("Voiceover");
  });
});
