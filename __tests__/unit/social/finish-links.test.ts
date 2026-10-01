import { describe, it, expect } from "vitest";
import { finishLinkFor, TIKTOK_APP_URL, youtubeStudioEditorUrl } from "@/lib/social/finish-links";
import type { SocialTarget } from "@/lib/social/types";

const t = (over: Partial<SocialTarget>): SocialTarget => ({ platform: "tiktok", accountId: "a", status: "published", ...over });

describe("finish links", () => {
  it("TikTok draft handed to the inbox: the app link + QR + instruction (no documented inbox deep link)", () => {
    expect(finishLinkFor(t({}), { mode: "draft" }, true)).toEqual({
      kind: "tiktok-inbox", label: "Open TikTok to finish", href: TIKTOK_APP_URL, qr: TIKTOK_APP_URL,
      instruction: "On your phone, open TikTok and tap the inbox notification for this draft.",
    });
    expect(TIKTOK_APP_URL).toBe("https://www.tiktok.com/");
    expect(finishLinkFor(t({ status: "pending" }), { mode: "draft" }, true)).toBeNull();
    expect(finishLinkFor(t({}), { mode: "attach", track: { id: "x", title: "y" }, musicVolume: 1, originalVolume: 1 }, true)).toBeNull();
  });
  it("YouTube with the song: YouTube Studio's editor for that video", () => {
    expect(youtubeStudioEditorUrl("abc_123")).toBe("https://studio.youtube.com/video/abc_123/editor");
    expect(finishLinkFor(t({ platform: "youtube", platformPostId: "abc_123" }), undefined, true)).toEqual({ kind: "youtube-studio-editor", label: "Open in YouTube Studio", href: "https://studio.youtube.com/video/abc_123/editor" });
    expect(finishLinkFor(t({ platform: "youtube", platformPostId: "abc_123" }), undefined, false)).toBeNull();
    expect(finishLinkFor(t({ platform: "youtube" }), undefined, true)).toBeNull();
  });
  it("Instagram that kept the song: the post link to replace the audio in the app", () => {
    expect(finishLinkFor(t({ platform: "instagram", url: "https://www.instagram.com/reel/x/" }), { mode: "include" }, true)).toEqual({
      kind: "instagram-app", label: "Replace the audio in the Instagram app", href: "https://www.instagram.com/reel/x/",
    });
    expect(finishLinkFor(t({ platform: "instagram", url: "https://www.instagram.com/reel/x/" }), undefined, true)?.kind).toBe("instagram-app");
    expect(finishLinkFor(t({ platform: "instagram", url: "https://www.instagram.com/reel/x/" }), undefined, false)).toBeNull();
    expect(finishLinkFor(t({ platform: "instagram", url: "https://www.instagram.com/reel/x/" }), { mode: "strip" }, true)).toBeNull();
  });
});
