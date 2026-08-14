import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveUvBinary, requireUvBinary } from "@/lib/uv-path";

class FakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FakeError";
  }
}

describe("resolveUvBinary", () => {
  let tmp: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-uv-path-"));
    priorHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = tmp;
    fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = priorHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the bundled <libi-bin-dir>/uv when present", () => {
    const bundled = path.join(tmp, "bin", "uv");
    fs.writeFileSync(bundled, "#!/bin/sh\n");
    const got = resolveUvBinary();
    expect(got).toBe(bundled);
  });

  it("falls back to system PATH when bundled uv is missing", () => {
    // Don't create bundled uv. Rely on system uv (every dev machine running
    // these tests has uv installed — homebrew or pre-existing). Skip if not.
    const got = resolveUvBinary();
    if (got === null) {
      console.warn("Skipping: no uv on system PATH");
      return;
    }
    expect(got).not.toBe(path.join(tmp, "bin", "uv"));
    expect(fs.existsSync(got)).toBe(true);
  });

  it("requireUvBinary throws domain-specific error when neither location has uv", () => {
    // Override PATH so `which uv` fails — point to an empty dir
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "empty-path-"));
    const priorPath = process.env.PATH;
    process.env.PATH = emptyDir;
    try {
      expect(() => requireUvBinary(FakeError, "Local widget")).toThrow(
        /Local widget requires the bundled uv/,
      );
      try {
        requireUvBinary(FakeError, "Local widget");
      } catch (err) {
        expect((err as Error).name).toBe("FakeError");
      }
    } finally {
      process.env.PATH = priorPath;
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("requireUvBinary returns the bundled path when available", () => {
    const bundled = path.join(tmp, "bin", "uv");
    fs.writeFileSync(bundled, "#!/bin/sh\n");
    expect(requireUvBinary(FakeError, "Whisper")).toBe(bundled);
  });
});
