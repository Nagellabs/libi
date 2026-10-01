import { describe, it, expect } from "vitest";
import { downloadStamp, generatedStamp, remoteFetchStamp, ownedByProvenance, uploadedStamp } from "@/lib/audio-rights/stamp";

const NOW = new Date("2026-09-27T12:00:00Z");

describe("stamps", () => {
  it("generated: the prompt head is the title", () => {
    expect(generatedStamp("  lofi rain on a tin roof, slow  ", NOW)).toEqual({
      class: "generated", track: { title: "lofi rain on a tin roof, slow" }, decidedBy: "provenance", decidedAt: NOW.toISOString(),
    });
    expect(generatedStamp(undefined, NOW)).toEqual({ class: "generated", decidedBy: "provenance", decidedAt: NOW.toISOString() });
    expect(generatedStamp("x".repeat(200), NOW).track?.title).toHaveLength(80);
  });

  it("yt-dlp with track tags: high confidence, source from webpage_url + extractor", () => {
    const r = downloadStamp(
      { webpage_url: "https://www.youtube.com/watch?v=abc", extractor: "youtube", track: "Espresso", artist: "Sabrina Carpenter", album: "Short n' Sweet", title: "Sabrina Carpenter - Espresso (Official Video)" },
      "https://youtu.be/abc", NOW,
    );
    expect(r).toEqual({
      class: "copyrighted",
      track: { title: "Espresso", artist: "Sabrina Carpenter", album: "Short n' Sweet", trackConfidence: "high" },
      source: { url: "https://www.youtube.com/watch?v=abc", site: "youtube" },
      decidedBy: "provenance", decidedAt: NOW.toISOString(),
    });
  });

  it("yt-dlp without track tags: the page title with low confidence, never the uploader as artist", () => {
    const r = downloadStamp({ webpage_url: "https://www.tiktok.com/@a/video/1", extractor: "TikTok", title: "my dance", creator: "someone" }, "u", NOW);
    expect(r.track).toEqual({ title: "my dance", trackConfidence: "low" });
    expect(r.source).toEqual({ url: "https://www.tiktok.com/@a/video/1", site: "TikTok" });
  });

  it("yt-dlp with no info file: copyrighted, the requested url as source", () => {
    expect(downloadStamp(null, "https://example.com/v", NOW)).toEqual({
      class: "copyrighted", source: { url: "https://example.com/v" }, decidedBy: "provenance", decidedAt: NOW.toISOString(),
    });
  });

  it("remote_fetch: copyrighted, the fetched url and its host", () => {
    expect(remoteFetchStamp("https://cdn.example.com/a/b.mp3?sig=1", NOW)).toEqual({
      class: "copyrighted", source: { url: "https://cdn.example.com/a/b.mp3?sig=1", site: "cdn.example.com" },
      decidedBy: "provenance", decidedAt: NOW.toISOString(),
    });
  });

  it("owned by provenance", () => {
    expect(ownedByProvenance(NOW)).toEqual({ class: "owned", decidedBy: "provenance", decidedAt: NOW.toISOString() });
  });

  it("an upload is the user's own (owner decision 2026-09-28): owned, decided by provenance", () => {
    expect(uploadedStamp(NOW)).toEqual({ class: "owned", decidedBy: "provenance", decidedAt: NOW.toISOString() });
  });
});
