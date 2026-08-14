import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
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
    // An unwritable home whose failure mode is a fast ENOTDIR on every
    // platform: a path that routes THROUGH a regular file. The previous
    // choice, "/proc/nonexistent-unwritable", hung the entire suite on Linux
    // CI: procfs answers mkdir in its root with ENOENT, which Node's
    // `mkdirSync(..., { recursive: true })` treats as "create the parent
    // first" — and since the parent (/proc) already exists, the native
    // retry walk spins forever. A synchronous native loop services no
    // timers and no signals, so the vitest fork burned CPU until the CI job
    // timeout, the file never reported, and no failure output was ever
    // printed for the whole run.
    const fileAsDir = join(home, "not-a-dir");
    writeFileSync(fileAsDir, "");
    process.env.LIBI_HOME = join(fileAsDir, "nested");
    expect(() => recordCall({ tool: "compose_music", prompt: "x" })).not.toThrow();
  });
});
