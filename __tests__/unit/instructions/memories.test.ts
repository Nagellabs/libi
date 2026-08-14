import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createTempStorageDir,
  cleanupTempDir,
} from "@/__tests__/helpers/test-storage";
import {
  readMemories,
  writeMemories,
  appendMemories,
  MEMORIES_MAX_CHARS,
} from "@/lib/instructions/memories";
import { getLibiMemoriesPath } from "@/lib/libi-home";

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

describe("memories store", () => {
  it("getLibiMemoriesPath points at <home>/memories.md", () => {
    expect(getLibiMemoriesPath()).toBe(path.join(tempDir, "memories.md"));
  });

  it("readMemories returns empty string when the file does not exist", () => {
    expect(readMemories()).toBe("");
  });

  it("writeMemories persists and readMemories round-trips", () => {
    writeMemories("## Style\n\nAlways cinematic.\n");
    expect(readMemories()).toBe("## Style\n\nAlways cinematic.\n");
    expect(fs.existsSync(path.join(tempDir, "memories.md"))).toBe(true);
  });

  it("writeMemories rejects content over the cap", () => {
    expect(() => writeMemories("x".repeat(MEMORIES_MAX_CHARS + 1))).toThrow(/8000/);
  });

  it("appendMemories creates the file when missing", () => {
    appendMemories("## Voice\n\nUse warm voices.");
    expect(readMemories()).toBe("## Voice\n\nUse warm voices.\n");
  });

  it("appendMemories separates entries with a blank line", () => {
    writeMemories("## A\n\nfirst\n");
    appendMemories("## B\n\nsecond");
    expect(readMemories()).toBe("## A\n\nfirst\n\n## B\n\nsecond\n");
  });

  it("appendMemories enforces the combined cap", () => {
    writeMemories("x".repeat(MEMORIES_MAX_CHARS - 10));
    expect(() => appendMemories("y".repeat(100))).toThrow(/8000/);
  });
});
