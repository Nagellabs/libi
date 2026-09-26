import { describe, it, expect } from "vitest";
import { postEntryLabel, postTypes, targetType } from "@/lib/social/format";
import type { SocialPost, SocialTarget } from "@/lib/social/types";

function post(targets: SocialTarget[]): SocialPost {
  return { id: "p", status: "published", content: "hi", createdAt: "2026-09-21T00:00:00.000Z", media: [], targets, tags: [] };
}

const ig = (contentType: "reel" | "feed" | "story"): SocialTarget => ({
  platform: "instagram",
  accountId: "a",
  status: "published",
  options: { platform: "instagram", instagram: { contentType } },
});

describe("postEntryLabel — how a post is named in a list of its siblings", () => {
  it("names a post by its network and its type", () => {
    expect(postEntryLabel(post([ig("reel")]))).toBe("Instagram — Reel");
    expect(postEntryLabel(post([ig("story")]))).toBe("Instagram — Story");
    expect(postEntryLabel(post([{ platform: "tiktok", accountId: "a", status: "published" }]))).toBe("TikTok — Video");
  });

  it("names X as X, not as its wire key", () => {
    // `twitter` is the provider's key; nobody calls it that any more.
    expect(postEntryLabel(post([{ platform: "twitter", accountId: "a", status: "published" }]))).toBe("X");
  });

  it("never invents a type for a platform whose options libi does not build", () => {
    // The agent posted it and the provider did not say what shape it took.
    // "YouTube — Video" would be a label we made up.
    expect(postEntryLabel(post([{ platform: "youtube", accountId: "a", status: "published" }]))).toBe("YouTube");
    expect(targetType({ platform: "youtube", accountId: "a", status: "published" })).toBeNull();
  });

  it("counts the rest rather than joining a list that would not fit", () => {
    expect(postEntryLabel(post([ig("reel"), { platform: "tiktok", accountId: "b", status: "published" }]))).toBe(
      "Instagram — Reel +1",
    );
  });

  it("a post with no targets at all is still named", () => {
    expect(postEntryLabel(post([]))).toBe("Post");
  });

  it("postTypes reports each distinct type once, and nothing for an untyped target", () => {
    expect(postTypes(post([ig("reel"), ig("reel"), { platform: "tiktok", accountId: "b", status: "published" }]))).toEqual([
      "reel",
      "video",
    ]);
    expect(postTypes(post([{ platform: "facebook", accountId: "a", status: "published" }]))).toEqual([]);
  });
});

import { summarizeAnalytics } from "@/lib/social/format";
import { sortRows } from "@/components/social/social-page/list-views";

describe("summarizeAnalytics", () => {
  it("sums each figure across the networks a post went to, views falling back to impressions", () => {
    const m = summarizeAnalytics({
      postId: "p",
      syncStatus: "ready",
      perTarget: [
        { platform: "instagram", views: 100, likes: 5 },
        { platform: "facebook", impressions: 40, likes: 2, shares: 1 },
      ],
    });
    expect(m).toEqual({ views: 140, reach: undefined, likes: 7, comments: undefined, shares: 1 });
  });

  it("is absent, never zero, while a network is still syncing — but a Story's own numbers still count", () => {
    expect(summarizeAnalytics({ postId: "p", syncStatus: "pending", perTarget: [{ platform: "instagram", views: 9 }] }).views).toBeUndefined();
    const story = summarizeAnalytics({
      postId: "p",
      syncStatus: "pending",
      perTarget: [],
      stories: [{ insights: { source: "live", metrics: { views: 80, replies: 2 } } }],
    });
    expect(story.views).toBe(80);
    expect(story.comments).toBe(2);
    expect(summarizeAnalytics(undefined)).toEqual({});
  });
});

describe("sortRows", () => {
  it("sorts either way and always sinks rows with no value", () => {
    const rows = [{ v: 2 }, { v: undefined }, { v: 9 }];
    expect(sortRows(rows, "desc", (r) => r.v).map((r) => r.v)).toEqual([9, 2, undefined]);
    expect(sortRows(rows, "asc", (r) => r.v).map((r) => r.v)).toEqual([2, 9, undefined]);
  });
});
