import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fake-elevenlabs output helpers", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "libi-el-out-"));
    process.env.LIBI_HOME = home;
    process.env.LIBI_SERVER_PORT = "3999";
  });
  afterEach(() => {
    delete process.env.LIBI_HOME;
    delete process.env.LIBI_SERVER_PORT;
    rmSync(home, { recursive: true, force: true });
  });

  it("writes under <libiHome>/test-mode/elevenlabs-out and creates it", async () => {
    const { resolveOutputDir } = await import("@/mcp/dev/fake-elevenlabs/output");
    const dir = resolveOutputDir();
    expect(dir).toBe(join(home, "test-mode", "elevenlabs-out"));
    expect(existsSync(dir)).toBe(true);
  });

  // ElevenLabs hands back an output URL, not a file: the fake's is the studio's test-mode route, so the agent
  // downloads it exactly as it downloads a real one.
  it("serves outputs and uploads at the studio's test-mode route, on 127.0.0.1", async () => {
    const { outputUrl, uploadUrl } = await import("@/mcp/dev/fake-elevenlabs/output");
    expect(outputUrl("el_tts_x.wav")).toBe("http://127.0.0.1:3999/api/test-mode/elevenlabs/out/el_tts_x.wav");
    expect(uploadUrl("asset_fake_0123456789abcdef")).toBe("http://127.0.0.1:3999/api/test-mode/elevenlabs/upload/asset_fake_0123456789abcdef");
  });
});
