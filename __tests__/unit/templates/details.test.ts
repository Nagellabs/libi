// D5: the pure helpers both template pages read — the overlays table in
// z-order, the resources grid with where each asset plays from, and the
// catalog's per-day counts turned into 30-day uses and a last-used day.
import { describe, expect, it } from "vitest";
import { makeScaffold } from "@/__tests__/helpers/templates";
import { assetStreamUrl, formatDuration, lastUsedDayOf, musicLinkRows, overlayRows, resourceRows, usesInLastDays } from "@/lib/templates/details";
import type { TemplateScaffold } from "@/lib/templates/scaffold-schema";

const rect = { x: 0, y: 0, width: 10, height: 10 };

function scaffold(): TemplateScaffold {
  return makeScaffold({
    slots: [
      { key: "headline", kind: "text", label: "Headline", required: true },
      { key: "hero", kind: "video", label: "Hero clip", required: true },
    ],
    overlays: [
      { key: "headline", kind: "text", displayName: "Headline", rect, startTime: 0, duration: 3, z: 1, opacity: 1, text: { slot: "headline" }, font: "bold 72px Inter", color: "#fff", align: "center" },
      { key: "hero", kind: "video", rect, startTime: 0.5, duration: 2, z: 0, opacity: 1, source: { slot: "hero" } },
      { key: "logo", kind: "image", rect, startTime: 1, duration: 2, z: 5, opacity: 1, source: { assetRef: "logo" } },
      { key: "badge", kind: "image", displayName: "Badge", rect, startTime: 0, duration: 1, z: 5, opacity: 1, source: { assetRef: "logo" } },
      { key: "caption", kind: "text", rect, startTime: 0, duration: 3, z: 1, opacity: 1, text: { fixed: "Hi" }, font: "24px Inter", color: "#fff", align: "left" },
    ],
    assets: [
      { ref: "logo", kind: "image", file: "assets/logo.png", bytes: 1234 },
      { ref: "clip", kind: "video", url: "https://cdn.example.com/media/clip.mp4" },
      { ref: "bed", kind: "audio", file: "assets/bed.mp3" },
      { ref: "brand-font", kind: "font", file: "assets/Brand.ttf", bytes: 9000 },
    ],
  });
}

describe("overlayRows", () => {
  it("lists the top-most first (z descending), ties by start time then key", () => {
    expect(overlayRows(scaffold()).map((r) => r.key)).toEqual(["badge", "logo", "caption", "headline", "hero"]);
  });

  it("labels by displayName, else the key; the slot from source or text, else null (fixed)", () => {
    const rows = overlayRows(scaffold());
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(by("headline")).toEqual({ key: "headline", label: "Headline", kind: "text", start: 0, end: 3, slot: "headline", z: 1 });
    expect(by("hero")).toMatchObject({ label: "hero", kind: "video", start: 0.5, end: 2.5, slot: "hero" });
    expect(by("logo")).toMatchObject({ label: "logo", slot: null });
    expect(by("caption")).toMatchObject({ slot: null });
  });

  it("an empty scaffold has no rows", () => {
    expect(overlayRows(makeScaffold({ overlays: [] }))).toEqual([]);
  });
});

describe("resourceRows", () => {
  it("maps a file asset through fileUrl, a link to its host, and a refused file to unavailable", () => {
    const rows = resourceRows(scaffold(), (file) => (file === "assets/bed.mp3" ? null : `/media/${file.split("/").pop()}`));
    expect(rows).toEqual([
      { ref: "logo", kind: "image", name: "logo.png", bytes: 1234, source: { kind: "file", url: "/media/logo.png" } },
      { ref: "clip", kind: "video", name: "clip.mp4", bytes: null, source: { kind: "link", url: "https://cdn.example.com/media/clip.mp4", host: "cdn.example.com" } },
      { ref: "bed", kind: "audio", name: "bed.mp3", bytes: null, source: { kind: "unavailable" } },
      { ref: "brand-font", kind: "font", name: "Brand.ttf", bytes: 9000, source: { kind: "file", url: "/media/Brand.ttf" } },
    ]);
  });

  it("with streamUrl, a link-only audio or video asset also carries libi's own stream URL; an image link does not", () => {
    const s = makeScaffold({
      assets: [
        { ref: "clip", kind: "video", url: "https://cdn.example.com/clip.mp4?sig=a&b=c" },
        { ref: "song", kind: "audio", url: "https://cdn.example.com/song.mp3" },
        { ref: "pic", kind: "image", url: "https://cdn.example.com/pic.png" },
      ],
    });
    const rows = resourceRows(s, () => null, (u) => assetStreamUrl("abcdefghijklmnopqrst", u));
    expect(rows[0].source).toEqual({
      kind: "link",
      url: "https://cdn.example.com/clip.mp4?sig=a&b=c",
      host: "cdn.example.com",
      stream: "/api/templates/cloud/asset-stream?cloudId=abcdefghijklmnopqrst&url=https%3A%2F%2Fcdn.example.com%2Fclip.mp4%3Fsig%3Da%26b%3Dc",
    });
    expect(rows[1].source).toMatchObject({ kind: "link", stream: expect.stringContaining("song.mp3") });
    expect(rows[2].source).not.toHaveProperty("stream");
    // The stream URL carries the scaffold's value verbatim — the route looks it up there.
    expect(new URL(`http://x${(rows[0].source as { stream: string }).stream}`).searchParams.get("url")).toBe("https://cdn.example.com/clip.mp4?sig=a&b=c");
  });

  it("a url that does not parse, or is not https, is unavailable rather than linked", () => {
    const s = makeScaffold({ assets: [{ ref: "a", kind: "video", url: "not a url" }, { ref: "b", kind: "audio", url: "http://plain.example.com/a.mp3" }] });
    expect(resourceRows(s, () => null).map((r) => r.source)).toEqual([{ kind: "unavailable" }, { kind: "unavailable" }]);
  });
});

describe("usesInLastDays / lastUsedDayOf", () => {
  const NOW = Date.UTC(2026, 8, 25, 12, 0);
  it("sums today and the days before it, reading both key formats", () => {
    const byDay = { "20260925": 2, "2026-09-19": 3, "20260918": 5, "2026-08-27": 7, "2026-08-26": 11 };
    expect(usesInLastDays(byDay, 7, NOW)).toBe(5); // 25th … 19th
    expect(usesInLastDays(byDay, 30, NOW)).toBe(17); // 25 Sep … 27 Aug
    expect(usesInLastDays({}, 30, NOW)).toBe(0);
  });

  it("the latest day with a use, as YYYY-MM-DD; null when none", () => {
    expect(lastUsedDayOf({ "20260901": 1, "2026-09-20": 2, "20260922": 0 })).toBe("2026-09-20");
    expect(lastUsedDayOf({ "20260922": 0 })).toBeNull();
    expect(lastUsedDayOf({})).toBeNull();
  });
});

describe("musicLinkRows", () => {
  it("labels each link and parses its source host", () => {
    expect(musicLinkRows({ musicLinks: [{ ref: "e", track: { title: "Espresso", artist: "Sabrina Carpenter" }, sourceUrl: "https://www.youtube.com/watch?v=abc" }, { ref: "x", track: { title: "Untitled" } }] })).toEqual([
      { ref: "e", label: "Espresso — Sabrina Carpenter", source: { url: "https://www.youtube.com/watch?v=abc", host: "www.youtube.com" } },
      { ref: "x", label: "Untitled", source: null },
    ]);
    expect(musicLinkRows({})).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("m:ss, with tenths only when there are any", () => {
    expect(formatDuration(3)).toBe("0:03");
    expect(formatDuration(3.5)).toBe("0:03.5");
    expect(formatDuration(75.25)).toBe("1:15.3");
    expect(formatDuration(0)).toBe("0:00");
  });
});
