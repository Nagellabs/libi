import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  sanitizeFilename,
  resolveExportPath,
  claimExportPath,
  claimExportFile,
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
  it("does not double an extension the stem already carries", () => {
    expect(resolveExportPath(dir, "x.mp4", "mp4")).toBe(path.join(dir, "x.mp4"));
    expect(resolveExportPath(dir, "X.MP4", "mp4")).toBe(path.join(dir, "X.mp4"));
    expect(resolveExportPath(dir, "clip.webm", ".webm")).toBe(path.join(dir, "clip.webm"));
  });
  it("keeps a different extension or a dotted stem as written", () => {
    expect(resolveExportPath(dir, "cut.mov", "mp4")).toBe(path.join(dir, "cut.mov.mp4"));
    expect(resolveExportPath(dir, "v1.2", "mp4")).toBe(path.join(dir, "v1.2.mp4"));
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

describe("claimExportFile — a delete-pending name", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-export-claim-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** The first create of the plain name answers `code` (Windows says so for a name unlinked under an open handle); `existsSync` still calls it free. */
  function firstOpenRefuses(code: string) {
    const real = fs.openSync;
    let refused = false;
    vi.spyOn(fs, "openSync").mockImplementation(((...a: Parameters<typeof fs.openSync>) => {
      if (!refused) {
        refused = true;
        throw Object.assign(new Error(`${code}: operation not permitted, open`), { code });
      }
      return real(...a);
    }) as typeof fs.openSync);
  }

  it.each(["EPERM", "EACCES"])("on win32 %s moves on to the next suffix", (code) => {
    firstOpenRefuses(code);
    const { path: p, fd } = claimExportFile(dir, "X", "mp4", "win32");
    fs.closeSync(fd);
    expect(p).toBe(path.join(dir, "X-1.mp4"));
  });

  it.each(["EPERM", "EACCES"])("on linux %s is fatal", (code) => {
    firstOpenRefuses(code);
    expect(() => claimExportFile(dir, "X", "mp4", "linux")).toThrow(code);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("on win32 a folder that denies every create surfaces the original EPERM after a few tries, not '50 attempts'", () => {
    const open = vi.spyOn(fs, "openSync").mockImplementation((() => {
      throw Object.assign(new Error("EPERM: operation not permitted, open"), { code: "EPERM" });
    }) as typeof fs.openSync);
    expect(() => claimExportFile(dir, "X", "mp4", "win32")).toThrow(/EPERM/);
    expect(open.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("on win32 an unrelated error still propagates", () => {
    vi.spyOn(fs, "openSync").mockImplementation((() => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    }) as typeof fs.openSync);
    expect(() => claimExportFile(dir, "X", "mp4", "win32")).toThrow("ENOSPC");
  });
});
