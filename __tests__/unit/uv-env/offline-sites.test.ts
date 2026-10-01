/**
 * The uv call sites that surface an error to the user say "offline" in plain
 * words (lib/uv-env/network-failure.ts) instead of passing uv's "Caused by:"
 * wall through. Whisper and Kokoro are driven end to end against a FAKE `uv`
 * in a per-test LIBI_HOME that fails exactly as uv 0.11.32 does offline; the
 * remaining sites are pinned at the source so a new raw-passthrough cannot
 * slip back in.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OFFLINE =
  "error: Request failed after 3 retries in 9.5s\n" +
  "  Caused by: Failed to download https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.12.13%2B20260718-aarch64-apple-darwin-install_only_stripped.tar.gz\n" +
  "  Caused by: error sending request for url (https://github.com/astral-sh/python-build-standalone/releases/download/x)\n" +
  "  Caused by: tcp connect error\n" +
  "  Caused by: Connection refused (os error 61)\n";

const savedHome = process.env.LIBI_HOME;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-uv-offline-"));
  process.env.LIBI_HOME = home;
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  // `cat` a file rather than printf the text: uv's URLs carry `%2B`.
  fs.writeFileSync(path.join(home, "uv-stderr.txt"), OFFLINE);
  fs.writeFileSync(
    path.join(home, "bin", "uv"),
    `#!/bin/bash\ncat "${path.join(home, "uv-stderr.txt")}" >&2\nexit 2\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("offline uv, end to end", () => {
  it("transcription says it needs a one-time Python download and the computer is offline", async () => {
    const { transcribeAudio } = await import("@/lib/whisper/transcribe");
    const err = await transcribeAudio({ audioPath: path.join(home, "a.wav") }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err!.message).toBe(
      "libi needs a one-time download of its own Python (about 25 MB) for transcription, and this computer appears to be offline. Try again when you're online.",
    );
  });

  it("voiceover says the same, naming voiceover", async () => {
    const { synthesizeSpeech } = await import("@/lib/tts/synthesize");
    const err = await synthesizeSpeech({ text: "hello" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err!.message).toMatch(/one-time download of its own Python .* for voiceover, and this computer appears to be offline/);
    expect(err!.message).not.toContain("Caused by");
  });
});

// uv 0.11.32's real package-fetch failure behind a dead proxy (the install
// paths fetch wheels; the managed Python is the other shape, above).
const PACKAGES_OFFLINE =
  "error: Request failed after 3 retries in 7.7s\n" +
  "  Caused by: Failed to fetch: `https://pypi.org/simple/six/`\n" +
  "  Caused by: error sending request for url (https://pypi.org/simple/six/)\n" +
  "  Caused by: client error (Connect)\n" +
  "  Caused by: tcp connect error\n" +
  "  Caused by: Connection refused (os error 61)\n";

describe.skipIf(process.platform === "win32")("offline uv, install paths (Settings chips, verify_install)", () => {
  const packages = (feature: string) =>
    `libi needs to download the Python packages for ${feature} (a one-time step), and this computer appears to be offline. Try again when you're online.`;
  const python = (feature: string) =>
    `libi needs a one-time download of its own Python (about 25 MB) for ${feature}, and this computer appears to be offline. Try again when you're online.`;

  async function failure(run: () => Promise<unknown>): Promise<Error> {
    const err = await run().then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    return err!;
  }

  it("whisper env install says offline, not uv's text", async () => {
    const { whisperEnvVirtualDep } = await import("@/lib/mcp-virtual-deps/whisper-env-dep");
    expect((await failure(() => whisperEnvVirtualDep.install())).message).toBe(python("transcription"));
    fs.writeFileSync(path.join(home, "uv-stderr.txt"), PACKAGES_OFFLINE);
    expect((await failure(() => whisperEnvVirtualDep.install())).message).toBe(packages("transcription"));
  });

  it("Kokoro env install says offline, naming voiceover", async () => {
    fs.writeFileSync(path.join(home, "uv-stderr.txt"), PACKAGES_OFFLINE);
    const { ttsEnvVirtualDep } = await import("@/lib/mcp-virtual-deps/tts-env-dep");
    expect((await failure(() => ttsEnvVirtualDep.install())).message).toBe(packages("voiceover"));
  });

  it("music-analysis install says offline", async () => {
    fs.writeFileSync(path.join(home, "uv-stderr.txt"), PACKAGES_OFFLINE);
    const { installMusicAnalysisDeps } = await import("@/lib/music/analyze-install");
    expect((await failure(() => installMusicAnalysisDeps())).message).toBe(packages("music analysis"));
  });

  it("the tracking engine's uv sync says offline", async () => {
    fs.writeFileSync(path.join(home, "uv-stderr.txt"), PACKAGES_OFFLINE);
    const { runTrackingPyenvInstall } = await import("@/mcp/registry/installers/tracking-pyenv");
    const err = await failure(() => runTrackingPyenvInstall());
    expect(err.message).toBe(packages("object tracking"));
    expect(err.message).not.toContain("Caused by");
  });

  // UV-1 (G2 report 10a / concern 6): the yt-dlp `uv tool install` passed uv's raw text through to the chip and
  // the job. The sentence carries the raw text as `cause`, and the agent's needs_install text still reads it as the
  // network.
  it("the yt-dlp install says offline, keeps uv's text as its cause, and the agent is told it is the network", async () => {
    fs.writeFileSync(path.join(home, "uv-stderr.txt"), PACKAGES_OFFLINE);
    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const { BUNDLED_MCP_SERVERS } = await import("@/mcp/registry/bundled");
    const dep = BUNDLED_MCP_SERVERS.find((d) => d.id === "youtube-download")!.dependencies.find((d) => d.binary === "yt-dlp")!;
    const dm = new DependencyManager() as unknown as { installYtDlpViaUv: (d: typeof dep, t: number) => Promise<void> };
    const err = await failure(() => dm.installYtDlpViaUv(dep, 30_000));
    expect(err.message).toBe(packages("video download"));
    expect(err.cause).toBe(PACKAGES_OFFLINE);

    const { needsInstallMessage } = await import("@/mcp/tools/video-download-tools");
    const told = needsInstallMessage(`installing yt-dlp (needed to download videos) failed: ${err.message}`);
    expect(told).toContain("This looks like a network problem");
    expect(told).not.toContain("online..");
  });

  it("a failure that is not the network keeps its own text", async () => {
    fs.writeFileSync(path.join(home, "uv-stderr.txt"), "error: No space left on device (os error 28)\n");
    const { whisperEnvVirtualDep } = await import("@/lib/mcp-virtual-deps/whisper-env-dep");
    expect((await failure(() => whisperEnvVirtualDep.install())).message).toMatch(
      /^install exited 2: error: No space left on device/,
    );
  });
});

describe("every user-facing uv site routes failures through uvNetworkFailureMessage", () => {
  it.each([
    ["lib/whisper/transcribe.ts", '"transcription"'],
    ["lib/tts/synthesize.ts", '"voiceover"'],
    ["lib/music/generate.ts", '"music generation"'],
    ["lib/music/analyze.ts", '"music analysis"'],
    ["lib/tracking/boxmot-runner.ts", '"object tracking"'],
    ["lib/tracking/matte-runner.ts", '"background removal"'],
    ["lib/tracking/engine-selftest.ts", '"object tracking"'],
    ["lib/mcp-virtual-deps/whisper-env-dep.ts", '"transcription"'],
    ["lib/mcp-virtual-deps/tts-env-dep.ts", '"voiceover"'],
    ["lib/music/analyze-install.ts", '"music analysis"'],
    ["mcp/registry/installers/tracking-pyenv.ts", '"object tracking"'],
    ["mcp/registry/dependency-manager.ts", '"video download"'],
  ])("%s", (file, feature) => {
    const src = fs.readFileSync(path.join(process.cwd(), file), "utf-8");
    expect(src).toContain(`uvNetworkFailureMessage(${feature}`);
  });
});
