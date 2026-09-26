import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";

// writeAudioPlaceholder synthesizes a REAL sine-wave MP3 through ffmpeg.
if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);

describe.skipIf(!hasFfmpeg())("fake-elevenlabs placeholders", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "libi-el-ph-")); process.env.LIBI_HOME = home; });
  afterEach(() => { delete process.env.LIBI_HOME; rmSync(home, { recursive: true, force: true }); });

  it("writes a non-empty <stem>.mp3 (what the hosted server returns) in the output dir and returns its absolute path", async () => {
    const { writeAudioPlaceholder } = await import("@/mcp/dev/fake-elevenlabs/placeholders");
    const p = await writeAudioPlaceholder({ stem: "el_tts_gen_fake_1", durationSeconds: 1 });
    expect(p).toBe(join(home, "test-mode", "elevenlabs-out", "el_tts_gen_fake_1.mp3"));
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(0);
  });
});
