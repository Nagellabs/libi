import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

vi.mock("@/lib/ffmpeg/probe", () => ({ probeMedia: vi.fn() }));

import { probeMedia } from "@/lib/ffmpeg/probe";
import { checkFit } from "@/lib/social/fit-check";

const probe = (durationSeconds: number, width: number, height: number, sizeBytes: number) => ({
  durationSeconds,
  width,
  height,
  sizeBytes,
});

describe("checkFit", () => {
  it("a 34 s 1080×1920 41 MB export fits Reel, Story and TikTok", () => {
    for (const t of [
      { platform: "instagram", postType: "reel" },
      { platform: "instagram", postType: "story" },
      { platform: "tiktok", postType: "video" },
    ] as const) {
      expect(checkFit(probe(34, 1080, 1920, 41e6), t).ok).toBe(true);
    }
  });

  it("names every problem, per platform, before anything is sent", () => {
    const v = checkFit(probe(95, 1920, 1080, 350e6), { platform: "instagram", postType: "reel" });
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual([
      "1:35 is longer than Instagram Reel's 1:30 maximum",
      "16:9 is not an accepted aspect for Instagram Reel (9:16)",
      // 350e6 bytes is 333.8 MiB, and the limit is quoted in MiB too — the size
      // and the limit in one sentence now share a unit.
      "333.8 MB is over Instagram Reel's 300 MB limit",
    ]);
  });

  it("TikTok uses the 600 s ceiling from this account's creator info", () => {
    expect(checkFit(probe(601, 1080, 1920, 1e6), { platform: "tiktok", postType: "video" }).problems[0]).toMatch(/10:00 maximum/);
  });

  it("aspect tolerance is 2%: 1080×1918 still reads as 9:16", () => {
    expect(checkFit(probe(10, 1080, 1918, 1e6), { platform: "instagram", postType: "reel" }).ok).toBe(true);
  });

  it("flags a post type the provider does not support, without crashing", () => {
    const v = checkFit(probe(10, 1080, 1920, 1e6), { platform: "instagram", postType: "carousel" });
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual(["Instagram carousel is not a post type this provider supports"]);
  });

  it("names the platform and the actual measurement so the UI can show a short reason", () => {
    const v = checkFit(probe(10, 1920, 1080, 1e6), { platform: "instagram", postType: "reel" });
    expect(v.problems[0]).toContain("16:9");
    expect(v.problems[0]).toContain("9:16");
    expect(v.problems[0]).toContain("Instagram Reel");
  });

  it("returns the probe alongside the verdict", () => {
    const p = probe(12, 1080, 1920, 5e6);
    const v = checkFit(p, { platform: "instagram", postType: "story" });
    expect(v.probe).toEqual(p);
    expect(v.platform).toBe("instagram");
    expect(v.postType).toBe("story");
  });
});

describe("isAllowedExportPath / probeExport", () => {
  let tmpRoot: string;
  let exportFolder: string;
  let storageDir: string;
  let outsideDir: string;

  beforeEach(() => {
    vi.mocked(probeMedia).mockReset();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "libi-fit-check-"));
    exportFolder = path.join(tmpRoot, "exports");
    storageDir = path.join(tmpRoot, "storage");
    outsideDir = path.join(tmpRoot, "outside");
    fs.mkdirSync(exportFolder, { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    process.env.LIBI_HOME = tmpRoot;
    vi.doMock("@/lib/db/settings", () => ({ resolveExportFolder: () => exportFolder }));
  });

  afterEach(() => {
    delete process.env.LIBI_HOME;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
    vi.doUnmock("@/lib/db/settings");
  });

  it("allows a file under the export folder", async () => {
    vi.resetModules();
    const mod = await import("@/lib/social/fit-check");
    const file = path.join(exportFolder, "out.mp4");
    fs.writeFileSync(file, "x");
    expect(mod.isAllowedExportPath(file)).toBe(true);
  });

  it("allows a file under libi storage", async () => {
    vi.resetModules();
    const mod = await import("@/lib/social/fit-check");
    const file = path.join(storageDir, "asset.mp4");
    fs.writeFileSync(file, "x");
    expect(mod.isAllowedExportPath(file)).toBe(true);
  });

  it("rejects a file outside both roots (no traversal)", async () => {
    vi.resetModules();
    const mod = await import("@/lib/social/fit-check");
    const file = path.join(outsideDir, "sneaky.mp4");
    fs.writeFileSync(file, "x");
    expect(mod.isAllowedExportPath(file)).toBe(false);
    expect(mod.isAllowedExportPath(path.join(exportFolder, "..", "outside", "sneaky.mp4"))).toBe(false);
  });

  it("rejects a symlink inside the export folder that points outside it", async () => {
    // The guard's whole job: a name under an allowed root is not the same as a FILE
    // under it. realpath is what separates the two, and nothing proved that until now
    // (the Task 11 review found this case claimed but missing).
    vi.resetModules();
    const mod = await import("@/lib/social/fit-check");
    const real = path.join(outsideDir, "real.mp4");
    fs.writeFileSync(real, "x");
    const link = path.join(exportFolder, "looks-legit.mp4");
    fs.symlinkSync(real, link);
    expect(mod.isAllowedExportPath(link)).toBe(false);
  });

  it("rejects a file whose PARENT directory is a symlink out of the export folder", async () => {
    vi.resetModules();
    const mod = await import("@/lib/social/fit-check");
    const realDir = path.join(outsideDir, "elsewhere");
    fs.mkdirSync(realDir, { recursive: true });
    const file = path.join(realDir, "clip.mp4");
    fs.writeFileSync(file, "x");
    fs.symlinkSync(realDir, path.join(exportFolder, "subdir"));
    expect(mod.isAllowedExportPath(path.join(exportFolder, "subdir", "clip.mp4"))).toBe(false);
  });

  it("rejects a path that does not exist", async () => {
    vi.resetModules();
    const mod = await import("@/lib/social/fit-check");
    expect(mod.isAllowedExportPath(path.join(exportFolder, "does-not-exist.mp4"))).toBe(false);
  });

  it("probeExport throws a validation SocialError for a missing file, never a crash", async () => {
    vi.resetModules();
    const mod = await import("@/lib/social/fit-check");
    const missing = path.join(exportFolder, "gone.mp4");
    await expect(mod.probeExport(missing)).rejects.toMatchObject({ name: "SocialError", kind: "validation" });
  });

  it("probeExport throws a validation SocialError for a file outside the allowed roots", async () => {
    vi.resetModules();
    const mod = await import("@/lib/social/fit-check");
    const outsideFile = path.join(outsideDir, "not-mine.mp4");
    fs.writeFileSync(outsideFile, "x");
    await expect(mod.probeExport(outsideFile)).rejects.toMatchObject({ kind: "validation" });
  });

  it("probeExport throws a validation SocialError when ffprobe can't read the file", async () => {
    vi.resetModules();
    vi.doMock("@/lib/ffmpeg/probe", () => ({ probeMedia: vi.fn().mockResolvedValue({}) }));
    const mod = await import("@/lib/social/fit-check");
    const file = path.join(exportFolder, "corrupt.mp4");
    fs.writeFileSync(file, "not really a video");
    await expect(mod.probeExport(file)).rejects.toMatchObject({ kind: "validation" });
    vi.doUnmock("@/lib/ffmpeg/probe");
  });

  it("probeExport returns duration/width/height from ffprobe and size from the file itself", async () => {
    vi.resetModules();
    vi.doMock("@/lib/ffmpeg/probe", () => ({
      probeMedia: vi.fn().mockResolvedValue({ duration: 12.5, width: 1080, height: 1920 }),
    }));
    const mod = await import("@/lib/social/fit-check");
    const file = path.join(exportFolder, "good.mp4");
    fs.writeFileSync(file, Buffer.alloc(2048));
    const result = await mod.probeExport(file);
    expect(result).toEqual({ durationSeconds: 12.5, width: 1080, height: 1920, sizeBytes: 2048 });
    vi.doUnmock("@/lib/ffmpeg/probe");
  });
});
