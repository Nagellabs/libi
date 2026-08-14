import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveSttProvider, transcribeAudio } from "@/lib/analysis/manager";

describe("resolveSttProvider", () => {
  it("defaults to whisper, honors explicit elevenlabs", () => {
    expect(resolveSttProvider(undefined)).toBe("whisper");
    expect(resolveSttProvider("whisper")).toBe("whisper");
    expect(resolveSttProvider("elevenlabs")).toBe("elevenlabs");
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
    const res = await transcribeAudio({
      fileId: "nonexistent",
      provider: "whisper",
    });
    expect(res.status).toBe("needs_install");
    expect(res.provider).toBe("whisper");
    expect(res.hint).toMatch(/get_install_plan/);
  });
});
