import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { generateMusic, downloadModel } from "@/lib/music/generate";
import { writeInstalledToken, ACESTEP_MODEL_VERSION } from "@/lib/music/models";
import { assertWav } from "@/__tests__/helpers/audio-assert";

const RUN = process.env.LIBI_MUSIC_E2E === "1";

function resolveSystemUv(): string {
  const bundled = path.join(
    process.env.HOME ?? os.homedir(),
    ".libi",
    "bin",
    "uv",
  );
  if (fs.existsSync(bundled)) return bundled;
  try {
    return execSync("command -v uv", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error(
      "LIBI_MUSIC_E2E=1 but no `uv` found (neither ~/.libi/bin/uv nor on PATH).",
    );
  }
}

let prevLibiHome: string | undefined;

beforeAll(() => {
  if (!RUN) return;
  prevLibiHome = process.env.LIBI_HOME;
  const home = path.join(os.tmpdir(), "libi-music-e2e");
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  const uvLink = path.join(home, "bin", "uv");
  try {
    fs.unlinkSync(uvLink);
  } catch {
    /* not present */
  }
  fs.symlinkSync(resolveSystemUv(), uvLink);
  process.env.LIBI_HOME = home;
});

afterAll(() => {
  if (!RUN) return;
  if (prevLibiHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = prevLibiHome;
});

describe.skipIf(!RUN)("real ACE-Step music E2E", () => {
  it("generates a valid non-silent WAV of the requested length", async () => {
    const expected = JSON.parse(
      fs.readFileSync(
        path.resolve("__tests__/fixtures/music/expected.json"),
        "utf-8",
      ),
    );

    await downloadModel();
    writeInstalledToken(ACESTEP_MODEL_VERSION);

    const r = await generateMusic({
      prompt: expected.prompt,
      durationSeconds: expected.durationSeconds,
      instrumental: true,
    });

    const wav = fs.readFileSync(r.wavPath);
    assertWav(wav, {
      sampleRate: expected.sampleRate,
      minSeconds: expected.minSeconds,
      maxSeconds: expected.maxSeconds,
    });
    const pcm = wav.subarray(44);
    let energy = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      energy += Math.abs(pcm.readInt16LE(i));
    }
    expect(energy / (pcm.length / 2)).toBeGreaterThan(50);

    fs.rmSync(r.wavPath, { force: true });
  }, 3_600_000);
});
