/**
 * Y4: libi fetches its own Python in the background after boot, so the first
 * uv feature after an upgrade neither waits for it nor fails offline for want
 * of it (lib/uv-env/python-prefetch.ts). Driven against a FAKE `uv` in a
 * per-test LIBI_HOME that records its argv and the uv env it was given.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverLogger } from "@/lib/logger";
import {
  LIBI_PYTHON_VERSION,
  TRACKING_PYTHON_VERSION,
  prefetchManagedPython,
  pythonPrefetchMarker,
  pythonPrefetchUnsupportedMarker,
  pythonVersionsToPrefetch,
  schedulePythonPrefetch,
} from "@/lib/uv-env/python-prefetch";
import { trackingVenvDir, uvPythonInstallDir } from "@/lib/uv-env/spawn-env";

const OFFLINE =
  "error: Failed to install cpython-3.12.13-macos-aarch64-none\n" +
  "  Caused by: Request failed after 3 retries in 12.1s\n" +
  "  Caused by: Failed to download https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.12.13%2B20260718-aarch64-apple-darwin-install_only_stripped.tar.gz\n" +
  "  Caused by: error sending request for url (https://github.com/astral-sh/python-build-standalone/releases/download/20260718/x)\n" +
  "  Caused by: tcp connect error\n" +
  "  Caused by: Connection refused (os error 61)\n";

const savedHome = process.env.LIBI_HOME;
let home: string;
let uv: string;
let calls: string;

/** A uv that logs `argv | UV_PYTHON_INSTALL_DIR | UV_PYTHON_PREFERENCE` and, on
 *  `python install <v>`, creates `cpython-<v>.9-test` the way uv names its dirs. */
function writeFakeUv(mode: "ok" | "offline" | "old" | "slow"): void {
  fs.writeFileSync(path.join(home, "offline.txt"), OFFLINE);
  const body = {
    ok: `mkdir -p "$UV_PYTHON_INSTALL_DIR/cpython-$3.9-test"\nexit 0\n`,
    offline: `cat "${path.join(home, "offline.txt")}" >&2\nexit 1\n`,
    // uv < 0.8's clap error for a flag it does not know.
    old: `echo "error: unexpected argument '--no-bin' found" >&2\nexit 2\n`,
    slow: `sleep 0.4\nmkdir -p "$UV_PYTHON_INSTALL_DIR/cpython-$3.9-test"\nexit 0\n`,
  }[mode];
  fs.writeFileSync(
    uv,
    `#!/bin/bash\necho "$* | $UV_PYTHON_INSTALL_DIR | $UV_PYTHON_PREFERENCE" >> "${calls}"\n${body}`,
    { mode: 0o755 },
  );
}

const callLines = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf-8").trim().split("\n") : []);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-py-prefetch-"));
  process.env.LIBI_HOME = home;
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  uv = path.join(home, "bin", "uv");
  calls = path.join(home, "calls.txt");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("prefetchManagedPython", () => {
  it("installs libi's Python under LIBI_HOME, never linking it into ~/.local/bin, and marks it done", async () => {
    writeFakeUv("ok");
    expect(await prefetchManagedPython({ uv })).toEqual({ [LIBI_PYTHON_VERSION]: "fetched" });
    const [line] = callLines();
    expect(line).toBe(
      `python install ${LIBI_PYTHON_VERSION} --no-bin --no-registry | ${uvPythonInstallDir()} | only-managed`,
    );
    expect(fs.existsSync(pythonPrefetchMarker(LIBI_PYTHON_VERSION))).toBe(true);
  });

  it("runs once per version: a second boot does not spawn uv", async () => {
    writeFakeUv("ok");
    await prefetchManagedPython({ uv });
    expect(await prefetchManagedPython({ uv })).toEqual({ [LIBI_PYTHON_VERSION]: "already" });
    expect(callLines()).toHaveLength(1);
  });

  it("fetches again when the interpreter was removed although the marker remains", async () => {
    writeFakeUv("ok");
    await prefetchManagedPython({ uv });
    fs.rmSync(uvPythonInstallDir(), { recursive: true, force: true });
    expect(await prefetchManagedPython({ uv })).toEqual({ [LIBI_PYTHON_VERSION]: "fetched" });
    expect(callLines()).toHaveLength(2);
  });

  it("offline: never throws, writes no marker, logs uv-env/python_prefetch_failed with offline: true", async () => {
    writeFakeUv("offline");
    const info = vi.spyOn(serverLogger, "info");
    expect(await prefetchManagedPython({ uv })).toEqual({ [LIBI_PYTHON_VERSION]: "failed" });
    expect(fs.existsSync(pythonPrefetchMarker(LIBI_PYTHON_VERSION))).toBe(false);
    const logged = info.mock.calls.find((c) => (c[0] as { op?: string }).op === "python_prefetch_failed");
    expect(logged?.[0]).toMatchObject({ tag: "uv-env", version: LIBI_PYTHON_VERSION, offline: true });
  });

  it("a uv too old for --no-bin is remembered, not retried every boot — until uv changes", async () => {
    writeFakeUv("old");
    expect(await prefetchManagedPython({ uv })).toEqual({ [LIBI_PYTHON_VERSION]: "failed" });
    expect(fs.existsSync(pythonPrefetchUnsupportedMarker())).toBe(true);
    expect(await prefetchManagedPython({ uv })).toBeNull();
    expect(callLines()).toHaveLength(1);
    // An updated uv (a different binary) is tried again.
    writeFakeUv("ok");
    fs.appendFileSync(uv, "# updated\n");
    expect(await prefetchManagedPython({ uv })).toEqual({ [LIBI_PYTHON_VERSION]: "fetched" });
  });

  it("kills a download still running when libi exits, and unhooks once it ends", async () => {
    writeFakeUv("slow");
    const before = process.listenerCount("exit");
    const run = prefetchManagedPython({ uv });
    await vi.waitFor(() => expect(process.listenerCount("exit")).toBe(before + 1));
    expect(await run).toEqual({ [LIBI_PYTHON_VERSION]: "fetched" });
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("does nothing without uv — it never installs uv itself", async () => {
    expect(await prefetchManagedPython({ uv: null })).toBeNull();
    expect(callLines()).toHaveLength(0);
  });

  it("also fetches the tracking Python once the tracking engine has been installed", async () => {
    writeFakeUv("ok");
    expect(pythonVersionsToPrefetch()).toEqual([LIBI_PYTHON_VERSION]);
    fs.mkdirSync(trackingVenvDir(), { recursive: true });
    expect(pythonVersionsToPrefetch()).toEqual([LIBI_PYTHON_VERSION, TRACKING_PYTHON_VERSION]);
    expect(await prefetchManagedPython({ uv })).toEqual({
      [LIBI_PYTHON_VERSION]: "fetched",
      [TRACKING_PYTHON_VERSION]: "fetched",
    });
  });
});

describe("schedulePythonPrefetch", () => {
  afterEach(() => {
    delete (globalThis as { __libiPythonPrefetchScheduled?: boolean }).__libiPythonPrefetchScheduled;
    vi.useRealTimers();
  });

  it.each([
    ["LIBI_TEST_MODE", "1"],
    ["LIBI_ENABLE_TEST_ROUTES", "1"],
  ])("is not scheduled with %s=%s (test mode, e2e)", (name, value) => {
    vi.useFakeTimers();
    vi.stubEnv(name, value);
    const set = vi.spyOn(globalThis, "setTimeout");
    schedulePythonPrefetch();
    expect(set.mock.calls.filter((c) => c[1] === 60_000)).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it("waits out the boot window, and schedules only once per process", () => {
    vi.useFakeTimers();
    const set = vi.spyOn(globalThis, "setTimeout");
    schedulePythonPrefetch();
    schedulePythonPrefetch();
    const ours = set.mock.calls.filter((c) => c[1] === 60_000);
    expect(ours).toHaveLength(1);
  });
});

// The prefetch is only worth anything if it fetches the versions the features
// actually ask uv for.
describe("the prefetched versions are the ones libi's uv callers use", () => {
  it("3.12: whisper, Kokoro, ACE-Step, music analysis and yt-dlp", async () => {
    const { WHISPER_PYTHON_VERSION } = await import("@/lib/whisper/transcribe");
    const { TTS_PYTHON_VERSION } = await import("@/lib/tts/synthesize");
    const { ACESTEP_PYTHON_VERSION } = await import("@/lib/music/generate");
    const { ANALYZE_PYTHON_VERSION } = await import("@/lib/music/analyze");
    const { ytDlpUvInstallArgs } = await import("@/mcp/registry/installers");
    const args = ytDlpUvInstallArgs();
    for (const v of [
      WHISPER_PYTHON_VERSION,
      TTS_PYTHON_VERSION,
      ACESTEP_PYTHON_VERSION,
      ANALYZE_PYTHON_VERSION,
      args[args.indexOf("--python") + 1],
    ]) {
      expect(v).toBe(LIBI_PYTHON_VERSION);
    }
  });

  it("3.11: the tracking sidecar's .python-version", () => {
    const pinned = fs
      .readFileSync(path.join(process.cwd(), "mcp", "tracking", "py", ".python-version"), "utf-8")
      .trim();
    expect(pinned).toBe(TRACKING_PYTHON_VERSION);
  });
});
