// __tests__/unit/storage/safe-name.test.ts
//
// The file-serving routes used a SUBSTRING guard, `name.includes("..")`, which
// refused any stored name containing `...` — a TikTok title ending in `...` made
// its own download unservable (proxy 400 → endless "Buffering…",
// docs-local/qa/2026-09-25-video-download-and-playback-plan.md T1). The guard is
// now per-segment: a name is ONE path segment, so only the segments `.` / `..`,
// separators and NUL are unsafe.
import { describe, it, expect } from "vitest";
import { isUnsafeStorageName, isUnsafeUrlParamName } from "@/lib/storage/safe-name";

const ORDINARY = [
  "clip.mp4",
  "Morning_vibe_happyhippie_....mp4",
  "Morning_vibe_happyhippie_...-proxy.mp4",
  "a..b.mp4",
  "...",
  "....",
  ".hidden",
  "clip-filmstrip.jpg",
  // A literal `%` is legal on disk (storeFile only basename()s; yt-dlp's
  // --restrict-filenames keeps it) — fix round 1.
  "100%.png",
  "50% off.mp4",
  "a%zz.mp4",
];

const TRAVERSAL = ["", ".", "..", "../x", "../../etc/passwd", "a/b", "a\\b", "..\\x", "/abs", "x\0.mp4"];

/** Encoded traversal: only meaningful for a name taken from a URL segment. */
const ENCODED = [
  "..%2fx", "..%2Fx", "a%5cb", "%2e%2e", "%2E",
  // A trailing malformed escape must not hide the well-formed ones (fix round 2).
  "..%2fx%", "%2e%2e%", "a%5cb%zz",
];

describe("isUnsafeStorageName (a DB-sourced name, judged raw)", () => {
  it.each(ORDINARY)("allows %j", (name) => {
    expect(isUnsafeStorageName(name)).toBe(false);
  });
  it.each(TRAVERSAL)("refuses %j", (name) => {
    expect(isUnsafeStorageName(name)).toBe(true);
  });
  it.each(ENCODED)("takes %j literally: one segment on disk, no separator", (name) => {
    expect(isUnsafeStorageName(name)).toBe(false);
  });
  it("refuses non-strings", () => {
    expect(isUnsafeStorageName(undefined as unknown as string)).toBe(true);
    expect(isUnsafeStorageName(null as unknown as string)).toBe(true);
  });
});

describe("isUnsafeUrlParamName (a name from a URL segment, also judged decoded)", () => {
  // A trailing `.` is a Windows hazard for a URL-supplied name (F11, below), so `...` / `....`
  // are allowed only as DB-sourced names.
  it.each(ORDINARY.filter((n) => !n.endsWith(".")))("allows %j", (name) => {
    expect(isUnsafeUrlParamName(name)).toBe(false);
  });
  it.each([...TRAVERSAL, ...ENCODED])("refuses %j", (name) => {
    expect(isUnsafeUrlParamName(name)).toBe(true);
  });
  it("refuses non-strings", () => {
    expect(isUnsafeUrlParamName(undefined as unknown as string)).toBe(true);
  });
});

// F11 (final review): a URL-supplied name also refuses `:` (a Windows alternate data stream,
// `clip.mp4:secret`, or a drive-relative `C:x`) and a trailing `.` or space, which Windows strips —
// `clip.mp4.` would open `clip.mp4`. Decoded forms too. DB-sourced names are judged as before.
describe("isUnsafeUrlParamName — Windows name hazards (F11)", () => {
  it.each(["clip.mp4:secret", "C:x", "C:", "a%3Ab", "clip.mp4.", "clip.mp4 ", "clip.mp4%2e", "clip.mp4%20", "...."])(
    "refuses %j",
    (name) => {
      expect(isUnsafeUrlParamName(name)).toBe(true);
    },
  );
  it.each(["clip.mp4", "Morning_vibe_happyhippie_....mp4", "a..b.mp4", ".hidden", "100%.png", "50% off.mp4"])(
    "still allows %j",
    (name) => {
      expect(isUnsafeUrlParamName(name)).toBe(false);
    },
  );
  it("leaves DB-sourced names alone (judged raw, as on disk)", () => {
    expect(isUnsafeStorageName("clip.mp4:secret")).toBe(false);
    expect(isUnsafeStorageName("....")).toBe(false);
  });
});
