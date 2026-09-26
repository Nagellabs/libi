import { describe, it, expect } from "vitest";
import { toAd } from "@/lib/social/providers/zernio/normalize";

describe("toAd", () => {
  it("reads the two ids that tie an ad to the post it boosts, in either casing", () => {
    // These spellings are the provider's own FILTER names on
    // `ad_campaigns_list_ads`, which is what makes the piece <-> ad link
    // possible at all — a rename here breaks the whole feature silently.
    expect(toAd({ _id: "a1", effective_instagram_media_id: "179000001" }).effectiveInstagramMediaId).toBe("179000001");
    expect(toAd({ _id: "a1", effectiveInstagramMediaId: "179000001" }).effectiveInstagramMediaId).toBe("179000001");
    expect(toAd({ _id: "a1", effective_object_story_id: "11_99" }).effectiveObjectStoryId).toBe("11_99");
    // Some shapes carry them on the creative rather than the ad.
    expect(toAd({ _id: "a1", creative: { effectiveInstagramMediaId: "179000002" } }).effectiveInstagramMediaId).toBe("179000002");
  });

  it("lower-cases status the way campaigns do, so one chip map serves both", () => {
    expect(toAd({ _id: "a1", status: "ACTIVE" }).status).toBe("active");
    expect(toAd({ _id: "a1", status: "PAUSED" }).status).toBe("paused");
    expect(toAd({ _id: "a1" }).status).toBe("unknown");
  });

  it("leaves a metric the provider did not send undefined, never zero", () => {
    // The ad shape is unverified against a live ads account: a fabricated 0
    // reads as "this ad got nothing", which is a different and actionable
    // claim from "the provider said nothing".
    const ad = toAd({ _id: "a1", metrics: { spend: 42.18, impressions: 18400 } });
    expect(ad.metrics).toMatchObject({ spend: 42.18, impressions: 18400 });
    expect(ad.metrics?.clicks).toBeUndefined();
    expect(ad.metrics?.ctr).toBeUndefined();
  });

  it("defaults the network to a META ADS key, never a posting-platform key", () => {
    // Ad networks are a separate key space: `metaads` is not `facebook`.
    expect(toAd({ _id: "a1" }).network).toBe("metaads");
    expect(toAd({ _id: "a1", network: "tiktokads" }).network).toBe("tiktokads");
  });
});
