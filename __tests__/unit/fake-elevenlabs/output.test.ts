import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

describe("fake-elevenlabs output helpers", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "libi-el-out-")); process.env.LIBI_HOME = home; });
  afterEach(() => { delete process.env.LIBI_HOME; rmSync(home, { recursive: true, force: true }); });

  it("defaults to <libiHome>/test-mode/elevenlabs-out and creates it", async () => {
    const { resolveOutputDir } = await import("@/mcp/dev/fake-elevenlabs/output");
    const dir = resolveOutputDir(undefined);
    expect(dir).toBe(join(home, "test-mode", "elevenlabs-out"));
    expect(existsSync(dir)).toBe(true);
  });

  it("honors an absolute output_directory", async () => {
    const { resolveOutputDir } = await import("@/mcp/dev/fake-elevenlabs/output");
    const custom = mkdtempSync(join(tmpdir(), "libi-el-custom-"));
    expect(resolveOutputDir(custom)).toBe(custom);
    rmSync(custom, { recursive: true, force: true });
  });

  it("builds a faithful filename: {tool}_{text[:5]}_{ts}.{ext}", async () => {
    const { makeOutputFileName } = await import("@/mcp/dev/fake-elevenlabs/output");
    const name = makeOutputFileName("tts", "Hello world", "wav");
    expect(name).toMatch(/^tts_Hello_\d{8}_\d{6}\.wav$/);
  });

  it("empty text yields a clean stem (music)", async () => {
    const { makeOutputFileName } = await import("@/mcp/dev/fake-elevenlabs/output");
    expect(makeOutputFileName("music", "", "wav")).toMatch(/^music__\d{8}_\d{6}\.wav$/);
  });
});
