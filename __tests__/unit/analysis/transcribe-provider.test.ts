import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { transcribeAudio } from "@/lib/analysis/manager";
import { analysisTranscribeAudioSchema } from "@/mcp/tools/schemas";

describe("transcription is Whisper-only on libi's side", () => {
  it("the tool schema has no provider field", () => {
    expect(Object.keys(analysisTranscribeAudioSchema.shape)).not.toContain("provider");
    // zod object strips unknown keys — a stale `provider: "elevenlabs"` from an
    // old manual is dropped, not honored.
    const parsed = analysisTranscribeAudioSchema.parse({ fileId: "x", provider: "elevenlabs" });
    expect(parsed).toEqual({ fileId: "x" });
  });
});

describe("transcribeAudio needs_install gate", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-wgate-"));
    process.env.LIBI_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.LIBI_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns needs_install for whisper when model absent (no DB touch)", async () => {
    const res = await transcribeAudio({ fileId: "nonexistent" });
    expect(res.status).toBe("needs_install");
    expect(res.provider).toBe("whisper");
    expect(res.hint).toMatch(/get_install_plan/);
  });
});
