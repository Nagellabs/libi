import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tts-env-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ttsEnvSignature", () => {
  it("is a 16-char hex string covering kokoro-onnx pin", async () => {
    const { ttsEnvSignature } = await import("@/lib/tts/synthesize");
    const { KOKORO_ONNX_VERSION } = await import("@/lib/tts/voices");
    expect(ttsEnvSignature()).toMatch(/^[0-9a-f]{16}$/);
    expect(KOKORO_ONNX_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is wired to the real TTS_WITH_SPECS + TTS_PYTHON_VERSION", async () => {
    // Locks signature to the shared constant so adding a dep to
    // TTS_WITH_SPECS can't silently skip the signature update.
    const { ttsEnvSignature, TTS_WITH_SPECS, TTS_PYTHON_VERSION } = await import(
      "@/lib/tts/synthesize"
    );
    const { hashSpec } = await import("@/lib/uv-env/hash-spec");
    expect(ttsEnvSignature()).toBe(
      hashSpec(TTS_PYTHON_VERSION, TTS_WITH_SPECS),
    );
  });
});

describe("isTtsEnvCurrent", () => {
  it("false when missing", async () => {
    const { isTtsEnvCurrent } = await import("@/lib/tts/synthesize");
    expect(isTtsEnvCurrent()).toBe(false);
  });
  it("true when matches", async () => {
    const { isTtsEnvCurrent, ttsEnvSignature } = await import("@/lib/tts/synthesize");
    const { writeInstallToken } = await import("@/lib/uv-env/install-token");
    writeInstallToken(".libi-tts-env.install-token", ttsEnvSignature());
    expect(isTtsEnvCurrent()).toBe(true);
  });
});
