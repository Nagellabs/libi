import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";

// writeAudioPlaceholder synthesizes a REAL sine-wave WAV through ffmpeg.
if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);

describe.skipIf(!hasFfmpeg())("fake-elevenlabs placeholders", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "libi-el-ph-")); process.env.LIBI_HOME = home; });
  afterEach(() => { delete process.env.LIBI_HOME; rmSync(home, { recursive: true, force: true }); });

  it("writes a non-empty wav and returns its absolute path", async () => {
    const { writeAudioPlaceholder } = await import("@/mcp/dev/fake-elevenlabs/placeholders");
    const p = await writeAudioPlaceholder({ tool: "tts", text: "hello", durationSeconds: 1 });
    expect(isAbsolute(p)).toBe(true);
    expect(p.endsWith(".wav")).toBe(true);
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(0);
  });
});
