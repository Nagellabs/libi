import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const RUN = process.env.LIBI_TEST_INTEGRATION === "1";

if (!RUN)
  console.info(
    "[skip] install-deps roundtrip — set LIBI_TEST_INTEGRATION=1 to run (real uv; downloads the ~50 MB librosa env)",
  );

(RUN ? describe : describe.skip)("install-deps roundtrip (real uv)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-int-install-"));
    process.env.LIBI_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.LIBI_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("warms the env, writes the token, gate flips true", async () => {
    const { installMusicAnalysisDeps, isMusicAnalysisInstalled } = await import(
      "@/lib/music/analyze-install"
    );
    expect(isMusicAnalysisInstalled()).toBe(false);
    await installMusicAnalysisDeps();
    expect(isMusicAnalysisInstalled()).toBe(true);
  }, 5 * 60_000);
});
