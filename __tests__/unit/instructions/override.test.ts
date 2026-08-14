import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import {
  createTempStorageDir,
  cleanupTempDir,
} from "@/__tests__/helpers/test-storage";
import {
  hasInstructionsOverride,
  readInstructionsOverride,
  saveInstructionsOverride,
  revertInstructionsOverride,
  getInstructionsStatus,
  getInstructionsOverridePath,
  getInstructionsOverrideBasePath,
} from "@/lib/instructions/override";
import { loadBundledTemplate } from "@/lib/instructions/bundled-template";

let tempDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  tempDir = createTempStorageDir();
  prevHome = process.env.LIBI_HOME;
  process.env.LIBI_HOME = tempDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = prevHome;
  cleanupTempDir(tempDir);
});

describe("instructions override store", () => {
  it("no override by default: bundled source, not stale", () => {
    expect(hasInstructionsOverride()).toBe(false);
    expect(readInstructionsOverride()).toBeNull();
    expect(getInstructionsStatus()).toEqual({
      source: "bundled",
      bundledUpdatedSinceFork: false,
    });
  });

  it("saveInstructionsOverride creates the override + .base.md snapshot", () => {
    saveInstructionsOverride("# My custom instructions\n");
    expect(readInstructionsOverride()).toBe("# My custom instructions\n");
    expect(fs.readFileSync(getInstructionsOverrideBasePath(), "utf-8")).toBe(
      loadBundledTemplate(),
    );
    expect(getInstructionsStatus()).toEqual({
      source: "override",
      bundledUpdatedSinceFork: false,
    });
  });

  it("second save updates content but keeps the original snapshot", () => {
    saveInstructionsOverride("v1");
    const snapshot = fs.readFileSync(getInstructionsOverrideBasePath(), "utf-8");
    saveInstructionsOverride("v2");
    expect(readInstructionsOverride()).toBe("v2");
    expect(fs.readFileSync(getInstructionsOverrideBasePath(), "utf-8")).toBe(snapshot);
  });

  it("rejects empty override content", () => {
    expect(() => saveInstructionsOverride("   ")).toThrow(/empty/i);
  });

  it("reports stale when the bundled template differs from the snapshot", () => {
    saveInstructionsOverride("custom");
    fs.writeFileSync(getInstructionsOverrideBasePath(), "an older bundled version");
    expect(getInstructionsStatus().bundledUpdatedSinceFork).toBe(true);
  });

  it("reports 'unknown' when the snapshot is missing", () => {
    saveInstructionsOverride("custom");
    fs.rmSync(getInstructionsOverrideBasePath());
    expect(getInstructionsStatus().bundledUpdatedSinceFork).toBe("unknown");
  });

  it("revert deletes override + snapshot and restores bundled status", () => {
    saveInstructionsOverride("custom");
    revertInstructionsOverride();
    expect(fs.existsSync(getInstructionsOverridePath())).toBe(false);
    expect(fs.existsSync(getInstructionsOverrideBasePath())).toBe(false);
    expect(getInstructionsStatus().source).toBe("bundled");
  });
});
