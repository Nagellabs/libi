import { describe, it, expect } from "vitest";
import { musicArtworkSrc, musicPreviewSrc, previewHostAllowed } from "@/lib/social/music-preview";

it("allows only the platforms' own https CDNs", () => {
  expect(previewHostAllowed("https://sf16-ies-music-sg.tiktokcdn.com/obj/x")).toBe(true);
  expect(previewHostAllowed("https://scontent.cdninstagram.com/o1/v/x.mp4")).toBe(true);
  expect(previewHostAllowed("https://video.xx.fbcdn.net/v/x.mp4")).toBe(true);
  expect(previewHostAllowed("http://sf16-ies-music-sg.tiktokcdn.com/obj/x")).toBe(false);
  expect(previewHostAllowed("https://tiktokcdn.com.evil.example/x")).toBe(false);
  expect(previewHostAllowed("https://127.0.0.1/x")).toBe(false);
  expect(previewHostAllowed("nope")).toBe(false);
  expect(musicPreviewSrc("https://a.tiktokcdn.com/x?y=1")).toBe("/api/social/music/preview?url=https%3A%2F%2Fa.tiktokcdn.com%2Fx%3Fy%3D1");
});

describe("musicArtworkSrc", () => {
  it("routes artwork through libi's own proxy, marked as artwork", () => {
    expect(musicArtworkSrc("https://p16-sg.tiktokcdn.com/a.jpg")).toBe("/api/social/music/preview?kind=artwork&url=https%3A%2F%2Fp16-sg.tiktokcdn.com%2Fa.jpg");
  });
});
