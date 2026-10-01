import { it, expect } from "vitest";
import { musicOfTarget } from "@/lib/social/post-music";
import type { SocialPost } from "@/lib/social/types";

it("reads a target's music from libi's stamp, by position and platform", () => {
  const post = {
    id: "p", status: "draft", content: "", createdAt: "x", media: [], tags: [],
    targets: [{ platform: "instagram", accountId: "ig", status: "pending" }, { platform: "tiktok", accountId: "tt", status: "pending" }],
    libi: { pieceId: "piece", targetOptions: [
      { platform: "instagram", instagram: { contentType: "reel" }, music: { mode: "strip" } },
      { platform: "tiktok", tiktok: { privacyLevel: "P" }, music: { mode: "draft" } },
    ] },
  } as unknown as SocialPost;
  expect(musicOfTarget(post, 0)).toEqual({ mode: "strip" });
  expect(musicOfTarget(post, 1)).toEqual({ mode: "draft" });
  expect(musicOfTarget({ ...post, libi: undefined }, 1)).toBeUndefined();
});

it("reads a malformed stamp as no music, never as a half-shaped decision", () => {
  const post = {
    id: "p", status: "draft", content: "", createdAt: "x", media: [], tags: [],
    targets: [{ platform: "instagram", accountId: "ig", status: "pending" }, { platform: "tiktok", accountId: "tt", status: "pending" }],
    libi: { pieceId: "piece", targetOptions: [
      { platform: "instagram", instagram: { contentType: "reel" }, music: { mode: "attach", track: { title: "no id" }, musicVolume: 80, originalVolume: 100 } },
      { platform: "tiktok", tiktok: { privacyLevel: "P" }, music: { mode: "loud" } },
    ] },
  } as unknown as SocialPost;
  expect(musicOfTarget(post, 0)).toBeUndefined();
  expect(musicOfTarget(post, 1)).toBeUndefined();
});
