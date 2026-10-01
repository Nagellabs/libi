/**
 * hasFfmpeg() under LIBI_REQUIRE_FFMPEG.
 *
 * On a dev machine without ffmpeg the real-ffmpeg tests should SKIP, loudly.
 * In the release gates they must never skip: 0.1.16's gates had no ffmpeg at
 * all, every real-ffmpeg test skipped through this guard, and the run was
 * green over coverage it never exercised. The gates set LIBI_REQUIRE_FFMPEG=1,
 * and then an absent ffmpeg is an error, not a skip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let empty: string;

beforeEach(() => {
  // A LIBI_HOME with no bin/ffmpeg and a PATH with nothing on it: the two
  // places resolveFfmpegPath() looks.
  empty = fs.mkdtempSync(path.join(os.tmpdir(), "libi-no-ffmpeg-"));
  vi.stubEnv("LIBI_HOME", empty);
  vi.stubEnv("PATH", empty);
  // hasFfmpeg() caches at module level; each case needs a fresh module.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(empty, { recursive: true, force: true });
});

async function freshHelper() {
  return import("@/__tests__/helpers/media");
}

describe("hasFfmpeg() with no ffmpeg anywhere", () => {
  it("throws, naming LIBI_REQUIRE_FFMPEG, when the environment requires ffmpeg", async () => {
    vi.stubEnv("LIBI_REQUIRE_FFMPEG", "1");
    const { hasFfmpeg } = await freshHelper();
    expect(() => hasFfmpeg()).toThrow(/LIBI_REQUIRE_FFMPEG/);
    // The answer is cached like the success path: a second call throws the
    // same way rather than re-probing or quietly returning false.
    expect(() => hasFfmpeg()).toThrow(/LIBI_REQUIRE_FFMPEG/);
  });

  it("returns false (a skip) when the variable is not set", async () => {
    vi.stubEnv("LIBI_REQUIRE_FFMPEG", "");
    const { hasFfmpeg } = await freshHelper();
    expect(hasFfmpeg()).toBe(false);
  });

  it("only the exact value 1 requires it", async () => {
    vi.stubEnv("LIBI_REQUIRE_FFMPEG", "0");
    const { hasFfmpeg } = await freshHelper();
    expect(hasFfmpeg()).toBe(false);
  });
});

describe("hasFfmpeg() under LIBI_REQUIRE_FFMPEG names WHY the probe failed", () => {
  // A probe that times out on a loaded runner is not a missing install, and
  // the error must not send anyone to debug the setup-ffmpeg action for it.
  function fakeFfmpeg(body: string) {
    const bin = path.join(empty, "ffmpeg");
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(bin, 0o755);
  }

  it("not found → says so", async () => {
    vi.stubEnv("LIBI_REQUIRE_FFMPEG", "1");
    const { hasFfmpeg } = await freshHelper();
    expect(() => hasFfmpeg()).toThrow(/ffmpeg was not found/);
  });

  it("a probe that times out → says it TIMED OUT, not that ffmpeg is missing", async () => {
    fakeFfmpeg("/bin/sleep 5");
    vi.stubEnv("LIBI_REQUIRE_FFMPEG", "1");
    vi.stubEnv("LIBI_FFMPEG_PROBE_TIMEOUT_MS", "200");
    const { hasFfmpeg } = await freshHelper();
    let message = "";
    try {
      hasFfmpeg();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/TIMED OUT after 200 ms/);
    expect(message).not.toMatch(/not found/);
  });

  it("an ffmpeg that exits non-zero → names the status", async () => {
    fakeFfmpeg("exit 3");
    vi.stubEnv("LIBI_REQUIRE_FFMPEG", "1");
    const { hasFfmpeg } = await freshHelper();
    expect(() => hasFfmpeg()).toThrow(/exited with status 3/);
  });

  it("the default bound is well above the old 2 s", async () => {
    // A 3 s answer (a cold page-in on a busy runner) is a pass, not a failure.
    fakeFfmpeg("/bin/sleep 3 && echo ffmpeg version fake");
    vi.stubEnv("LIBI_REQUIRE_FFMPEG", "1");
    vi.stubEnv("LIBI_FFMPEG_PROBE_TIMEOUT_MS", "");
    const { hasFfmpeg } = await freshHelper();
    expect(hasFfmpeg()).toBe(true);
  }, 15_000);
});
