/**
 * Unit: resolveGlob — used by DependencyManager to locate binaries inside
 * extracted upstream archives whose folder names include floating version
 * prefixes. If upstream changes, this test documents what to update.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resolveGlob } from "@/lib/file/glob";

describe("resolveGlob", () => {
  let root: string;

  beforeEach(() => {
    root = createTempStorageDir();
  });

  afterEach(() => {
    cleanupTempDir(root);
  });

  it("resolves a literal path with no wildcards", () => {
    const file = path.join(root, "sub", "bin");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    expect(resolveGlob(root, "sub/bin")).toBe(file);
  });

  it("matches a segment with a single wildcard", () => {
    fs.mkdirSync(path.join(root, "ffmpeg-7.1-amd64-static"));
    const file = path.join(root, "ffmpeg-7.1-amd64-static", "ffmpeg");
    fs.writeFileSync(file, "");
    expect(resolveGlob(root, "ffmpeg-*-amd64-static/ffmpeg")).toBe(file);
  });

  it("returns null when no match exists", () => {
    expect(resolveGlob(root, "nope/*/bin")).toBe(null);
  });

  it("returns null when wildcard segment exists but final path is missing", () => {
    fs.mkdirSync(path.join(root, "ffmpeg-7.1-amd64-static"));
    expect(resolveGlob(root, "ffmpeg-*-amd64-static/ffmpeg")).toBe(null);
  });
});
