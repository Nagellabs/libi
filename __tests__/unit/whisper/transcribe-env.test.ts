import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-whisper-env-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("whisperEnvSignature", () => {
  it("is a 16-char hex string covering faster-whisper version", async () => {
    const { whisperEnvSignature, FASTER_WHISPER_VERSION } = await import(
      "@/lib/whisper/transcribe"
    );
    expect(whisperEnvSignature()).toMatch(/^[0-9a-f]{16}$/);
    expect(FASTER_WHISPER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is wired to the real WHISPER_WITH_SPECS + WHISPER_PYTHON_VERSION", async () => {
    // Locks signature to the shared constant so adding a dep to
    // WHISPER_WITH_SPECS can't silently skip the signature update.
    const {
      whisperEnvSignature,
      WHISPER_WITH_SPECS,
      WHISPER_PYTHON_VERSION,
    } = await import("@/lib/whisper/transcribe");
    const { hashSpec } = await import("@/lib/uv-env/hash-spec");
    expect(whisperEnvSignature()).toBe(
      hashSpec(WHISPER_PYTHON_VERSION, WHISPER_WITH_SPECS),
    );
  });
});

describe("isWhisperEnvCurrent", () => {
  it("false when token missing", async () => {
    const { isWhisperEnvCurrent } = await import("@/lib/whisper/transcribe");
    expect(isWhisperEnvCurrent()).toBe(false);
  });
  it("true when token matches", async () => {
    const { isWhisperEnvCurrent, whisperEnvSignature } = await import("@/lib/whisper/transcribe");
    const { writeInstallToken } = await import("@/lib/uv-env/install-token");
    writeInstallToken(".libi-whisper-env.install-token", whisperEnvSignature());
    expect(isWhisperEnvCurrent()).toBe(true);
  });
});
