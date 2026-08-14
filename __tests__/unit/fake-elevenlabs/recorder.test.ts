import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fake-elevenlabs recorder", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "libi-el-rec-"));
    process.env.LIBI_HOME = home;
  });
  afterEach(() => {
    delete process.env.LIBI_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("appends one JSON line per call to elevenlabs-calls.jsonl", async () => {
    const { recordCall, elevenlabsRecordPath } = await import("@/mcp/dev/fake-elevenlabs/recorder");
    recordCall({ tool: "text_to_speech", voice_id: "v1", model_id: "eleven_multilingual_v2", output_path: "/tmp/a.wav", text: "hi" });
    recordCall({ tool: "voice_clone", name: "Ava", voice_id: "fakevoiceXYZ" });
    const p = elevenlabsRecordPath();
    expect(existsSync(p)).toBe(true);
    const lines = readFileSync(p, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.tool).toBe("text_to_speech");
    expect(first.voice_id).toBe("v1");
    expect(first.ts).toBeTypeOf("string");
  });

  it("never throws even if the dir is unwritable", async () => {
    const { recordCall } = await import("@/mcp/dev/fake-elevenlabs/recorder");
    process.env.LIBI_HOME = "/proc/nonexistent-unwritable";
    expect(() => recordCall({ tool: "compose_music", prompt: "x" })).not.toThrow();
  });
});
