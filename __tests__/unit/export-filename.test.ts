import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  sanitizeFilename,
  resolveExportPath,
  claimExportPath,
} from "@/lib/export/filename";

describe("sanitizeFilename", () => {
  it("preserves spaces and dashes in normal piece names", () => {
    expect(sanitizeFilename("Beach Day - Final")).toBe("Beach Day - Final");
  });
  it("replaces forbidden characters with underscore", () => {
    expect(sanitizeFilename("Hello/World:test")).toBe("Hello_World_test");
    expect(sanitizeFilename('a*b?c"d<e>f|g')).toBe("a_b_c_d_e_f_g");
  });
  it("falls back to libi-export when the result would be empty", () => {
    expect(sanitizeFilename("....")).toBe("libi-export");
    expect(sanitizeFilename("   ")).toBe("libi-export");
    expect(sanitizeFilename("")).toBe("libi-export");
  });
  it("strips trailing dots and whitespace (Windows drops them silently)", () => {
    expect(sanitizeFilename("Trailing dots... ")).toBe("Trailing dots");
  });
  it("prefixes reserved Windows names with underscore", () => {
    expect(sanitizeFilename("CON")).toBe("_CON");
    expect(sanitizeFilename("PRN.mp4")).toBe("_PRN.mp4");
    expect(sanitizeFilename("LPT1")).toBe("_LPT1");
  });
});

describe("resolveExportPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-export-test-"));
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns the unprefixed path when no collision exists", () => {
    expect(resolveExportPath(dir, "MyVideo", "mp4")).toBe(path.join(dir, "MyVideo.mp4"));
  });
  it("appends -1 when the base path is taken", () => {
    fs.writeFileSync(path.join(dir, "MyVideo.mp4"), "");
    expect(resolveExportPath(dir, "MyVideo", "mp4")).toBe(path.join(dir, "MyVideo-1.mp4"));
  });
  it("counts up to find the next available suffix", () => {
    fs.writeFileSync(path.join(dir, "MyVideo.mp4"), "");
    fs.writeFileSync(path.join(dir, "MyVideo-1.mp4"), "");
    fs.writeFileSync(path.join(dir, "MyVideo-2.mp4"), "");
    expect(resolveExportPath(dir, "MyVideo", "mp4")).toBe(path.join(dir, "MyVideo-3.mp4"));
  });
  it("accepts an extension with or without leading dot", () => {
    expect(resolveExportPath(dir, "x", "mp4")).toBe(path.join(dir, "x.mp4"));
    expect(resolveExportPath(dir, "x", ".mp4")).toBe(path.join(dir, "x.mp4"));
  });
});

describe("claimExportPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-export-claim-"));
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates a zero-byte placeholder atomically", () => {
    const p = claimExportPath(dir, "X", "mp4");
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBe(0);
  });
  it("two concurrent claims of the same stem get different paths", () => {
    const a = claimExportPath(dir, "X", "mp4");
    const b = claimExportPath(dir, "X", "mp4");
    expect(a).not.toBe(b);
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);
  });
});
