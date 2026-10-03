import { describe, it, expect } from "vitest";
import { isInboxTarget, postStatusLabel, postStatusSentence, postStatusTone, targetStatusLabel } from "@/lib/social/status-words";
import type { PostStatus, SocialTarget } from "@/lib/social/types";

const target = (over: Partial<SocialTarget> = {}): SocialTarget => ({ platform: "tiktok", accountId: "a", status: "published", ...over });
const post = (status: PostStatus, targets: SocialTarget[]) => ({ status, targets });

describe("libi's words for a post's status", () => {
  it("an inbox upload is 'Sent to inbox', never 'Published'", () => {
    const t = target({ delivery: "inbox" });
    expect(isInboxTarget(t)).toBe(true);
    expect(targetStatusLabel(t)).toBe("Sent to inbox");
    expect(postStatusLabel(post("published", [t]))).toBe("Sent to inbox");
    expect(postStatusTone(post("published", [t]))).toBe("inbox");
    expect(postStatusSentence(post("published", [t]))).toBe(
      "Sent to your TikTok inbox — open the TikTok app's notification to finish. Nothing is public yet.",
    );
  });

  it("a normal published target and post stay Published", () => {
    const t = target({ platform: "instagram" });
    expect(targetStatusLabel(t)).toBe("Published");
    expect(postStatusLabel(post("published", [t]))).toBe("Published");
    expect(postStatusTone(post("published", [t]))).toBe("published");
    expect(postStatusSentence(post("published", [t]))).toBe("Published on Instagram.");
  });

  it("a mix keeps the post 'Published' but names each part in the sentence", () => {
    const inbox = target({ delivery: "inbox" });
    const live = target({ platform: "instagram" });
    expect(postStatusLabel(post("published", [inbox, live]))).toBe("Published");
    expect(postStatusSentence(post("published", [inbox, live]))).toMatch(/Sent to your TikTok inbox.*Published on Instagram\./);
  });

  it("a delivery flag on a target that is not published is ignored", () => {
    expect(isInboxTarget(target({ status: "pending", delivery: "inbox" }))).toBe(false);
    expect(targetStatusLabel(target({ status: "failed", delivery: "inbox" }))).toBe("Failed");
  });

  it("a draft is said to live in libi and at the provider only", () => {
    const s = postStatusSentence(post("draft", [target({ status: "pending" })]));
    expect(s).toMatch(/libi's Posting tab and at the provider/);
    expect(s).toMatch(/Nothing appears in TikTok or Instagram/);
    expect(postStatusLabel(post("draft", []))).toBe("Draft");
  });
});
