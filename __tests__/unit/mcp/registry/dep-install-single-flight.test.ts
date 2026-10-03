/**
 * DependencyManager.retryDep single-flight is keyed by what the install
 * WRITES, and a downloaded binary lands atomically.
 *
 * `uv` is declared on five extensions (youtube-download, whisper, local-tts,
 * local-music, libi-tracking), and every one of them installs the same
 * `<bin>/uv`. Keyed by `<mcpId>/<binary>`, a video download and a
 * transcription starting together each downloaded and copied uv over the
 * other. `downloadGroup` (the network step) is replaced by a slow fake here;
 * everything else — status resolution, tokens, transitions — is real, over an
 * in-memory DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("../../../helpers/test-db");
  const db = createTestDb();
  return { getDb: () => db };
});
const transitions: Array<{ mcpId: string; binary: string; patch: Record<string, unknown> }> = [];
vi.mock("@/mcp/registry/dep-transition", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/registry/dep-transition")>()),
  writeDepTransition: (mcpId: string, binary: string, patch: Record<string, unknown>) =>
    transitions.push({ mcpId, binary, patch }),
}));

import {
  DependencyManager,
  STALE_PARTIAL_MS,
  sweepStalePartialBinaries,
} from "@/mcp/registry/dependency-manager";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { exeSuffix } from "@/lib/platform";

const savedHome = process.env.LIBI_HOME;
let home: string;
/** Where the product looks for uv: `bin/uv`, or `bin/uv.exe` on Windows — the same `exeSuffix()` it uses. */
const uvPath = () => path.join(home, "bin", `uv${exeSuffix()}`);
/** What a finished uv install leaves behind: the binary and its install-token marker beside it. */
function writeInstalledUv(token: string): void {
  fs.writeFileSync(uvPath(), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(`${uvPath()}.install-token`, token);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dep-flight-"));
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  process.env.LIBI_HOME = home;
  transitions.length = 0;
  // `uv` may be satisfied by a system uv on PATH (resolveStatus's `which`
  // fallback). Pin "not on PATH" so the host's uv never decides a test.
  vi.spyOn(
    DependencyManager.prototype as unknown as { binaryExistsOnPath: () => boolean },
    "binaryExistsOnPath",
  ).mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("retryDep single-flight by install target", () => {
  it("uv requested by two extensions at once downloads ONCE, and both rows learn the outcome", async () => {
    const uvOwners = BUNDLED_MCP_SERVERS.filter((d) => d.dependencies.some((x) => x.binary === "uv")).map(
      (d) => d.id,
    );
    expect(uvOwners.length).toBeGreaterThanOrEqual(2);
    const token = BUNDLED_MCP_SERVERS.flatMap((d) => d.dependencies).find((x) => x.binary === "uv")!
      .pinnedInstallToken!;

    const proto = DependencyManager.prototype as unknown as {
      downloadGroup: (url: string, deps: unknown[]) => Promise<void>;
    };
    const download = vi.spyOn(proto, "downloadGroup").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150));
      writeInstalledUv(token);
    });

    await Promise.all([
      new DependencyManager().retryDep("youtube-download", "uv"),
      new DependencyManager().retryDep("whisper", "uv"),
    ]);

    expect(download).toHaveBeenCalledTimes(1);
    for (const mcpId of ["youtube-download", "whisper"]) {
      const last = transitions.filter((t) => t.mcpId === mcpId && t.binary === "uv").at(-1);
      expect(last?.patch, mcpId).toMatchObject({ installed: true });
    }
  });
});

// new 10b: `ensureAll` (Settings resync, Category A) installs through ensureMcp,
// which used to call the installers directly and so ran a second install over
// one a job's repair or a Retry click had in flight.
describe("ensureMcp shares the single-flight with retryDep", () => {
  type Internals = {
    downloadGroup: (url: string, deps: unknown[]) => Promise<void>;
    runCustomInstaller: (dep: unknown) => Promise<void>;
  };
  type WithEnsureMcp = { ensureMcp: (def: unknown) => Promise<void> };
  const proto = DependencyManager.prototype as unknown as Internals;
  const ytDef = () => BUNDLED_MCP_SERVERS.find((d) => d.id === "youtube-download")!;
  const uvToken = () => ytDef().dependencies.find((x) => x.binary === "uv")!.pinnedInstallToken!;

  function slowUvDownload() {
    return vi.spyOn(proto, "downloadGroup").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150));
      writeInstalledUv(uvToken());
    });
  }

  it("a resync that reaches uv while a Retry is installing it joins that install", async () => {
    const download = slowUvDownload();
    vi.spyOn(proto, "runCustomInstaller").mockResolvedValue(undefined);
    await Promise.all([
      new DependencyManager().retryDep("youtube-download", "uv"),
      (new DependencyManager() as unknown as WithEnsureMcp).ensureMcp(ytDef()),
    ]);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("a Retry that arrives while a resync is installing uv joins the resync's install", async () => {
    const download = slowUvDownload();
    vi.spyOn(proto, "runCustomInstaller").mockResolvedValue(undefined);
    const resync = (new DependencyManager() as unknown as WithEnsureMcp).ensureMcp(ytDef());
    await vi.waitFor(() => expect(download).toHaveBeenCalled()); // the resync's install is in flight
    await Promise.all([resync, new DependencyManager().retryDep("whisper", "uv")]);
    expect(download).toHaveBeenCalledTimes(1);
    const last = transitions.filter((t) => t.mcpId === "whisper" && t.binary === "uv").at(-1);
    expect(last?.patch).toMatchObject({ installed: true });
  });

  it("two yt-dlp repairs — a job's and a resync's — run ONE uv tool install, and share its outcome", async () => {
    // uv already present, so the resync goes straight to yt-dlp.
    writeInstalledUv(uvToken());
    const install = vi.spyOn(proto, "runCustomInstaller").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150));
      throw new Error("uv tool install failed: offline");
    });
    const repair = new DependencyManager().retryDep("youtube-download", "yt-dlp");
    await vi.waitFor(() => expect(install).toHaveBeenCalled()); // the repair's install is in flight
    await Promise.allSettled([
      repair,
      (new DependencyManager() as unknown as WithEnsureMcp).ensureMcp(ytDef()),
    ]);
    expect(install).toHaveBeenCalledTimes(1);
    const failed = transitions.filter(
      (t) => t.binary === "yt-dlp" && t.patch.runtimeStatus === "failed",
    );
    // The repair's row, and the resync's (same extension) — both carry the one error.
    expect(failed.length).toBeGreaterThanOrEqual(2);
    for (const t of failed) expect(t.patch.error).toMatch(/offline/);
  });

  it("a Retry that joins a resync which left uv undetected fails, naming it", async () => {
    // The download "succeeds" but puts nothing in place (a binary that fails
    // its run check would look the same).
    const download = vi.spyOn(proto, "downloadGroup").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    vi.spyOn(proto, "runCustomInstaller").mockResolvedValue(undefined);
    const resync = (new DependencyManager() as unknown as WithEnsureMcp).ensureMcp(ytDef());
    await vi.waitFor(() => expect(download).toHaveBeenCalled()); // the resync's install is in flight
    await expect(new DependencyManager().retryDep("whisper", "uv")).rejects.toThrow(
      "uv: the install completed without an error, but libi still does not detect it as installed.",
    );
    await resync;
    const last = transitions.filter((t) => t.mcpId === "whisper" && t.binary === "uv").at(-1);
    expect(last?.patch).toMatchObject({ runtimeStatus: "failed" });
  });

  it("with nothing in flight, a resync still installs", async () => {
    const download = slowUvDownload();
    vi.spyOn(proto, "runCustomInstaller").mockResolvedValue(undefined);
    await (new DependencyManager() as unknown as WithEnsureMcp).ensureMcp(ytDef());
    expect(download).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(uvPath())).toBe(true);
  });
});

// new 10c: a download interrupted between write and rename leaves
// `<dest>.partial-<pid>-<ms>` in bin/, and nothing else ever removes it.
describe("sweepStalePartialBinaries", () => {
  const binDir = () => path.join(home, "bin");
  const DEAD = () => false;
  /** `<base>.partial-<pid>-<ms>` NAMED `ageMs` ago; its mtime is now. */
  function partial(base: string, pid: number, ageMs: number): string {
    const p = path.join(binDir(), `${base}.partial-${pid}-${Date.now() - ageMs}`);
    fs.writeFileSync(p, "half a binary");
    return p;
  }

  it("judges age by the time in the name, not the mtime, and leaves everything else", () => {
    const stale = partial("ffmpeg", 4242, 2 * STALE_PARTIAL_MS);
    const fresh = partial("uv", 4243, 60_000);
    // A fresh name with an ancient mtime — Windows' CopyFileW keeps the source's.
    const oldMtime = partial("ffprobe", 4244, 60_000);
    const ancient = new Date(Date.now() - 30 * 24 * 3600_000);
    fs.utimesSync(oldMtime, ancient, ancient);
    fs.writeFileSync(path.join(binDir(), "uv"), "binary");
    const lookalike = path.join(binDir(), "notes.partial-draft");
    fs.writeFileSync(lookalike, "x");
    expect(sweepStalePartialBinaries(binDir(), Date.now(), DEAD)).toEqual([stale]);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(oldMtime)).toBe(true);
    expect(fs.existsSync(lookalike)).toBe(true);
    expect(fs.existsSync(path.join(binDir(), "uv"))).toBe(true);
  });

  it("leaves an old partial whose pid is another running process (a second libi sharing bin/)", () => {
    const theirs = partial("ffmpeg", 4242, 2 * STALE_PARTIAL_MS);
    expect(sweepStalePartialBinaries(binDir(), Date.now(), (pid) => pid === 4242)).toEqual([]);
    expect(fs.existsSync(theirs)).toBe(true);
  });

  it("removes an old partial named with this pid that no install here is writing (a leftover)", () => {
    const leftover = partial("uv", process.pid, 2 * STALE_PARTIAL_MS);
    expect(sweepStalePartialBinaries(binDir(), Date.now(), () => true)).toEqual([leftover]);
  });

  it("never removes a temp file placeBinary is writing in this process, however old", async () => {
    const dest = path.join(binDir(), "tool");
    let survived = false;
    await (
      new DependencyManager() as unknown as {
        placeBinary: (dep: unknown, dest: string, write: (tmp: string) => void) => Promise<void>;
      }
    ).placeBinary({ binary: "tool" }, dest, (tmp) => {
      fs.writeFileSync(tmp, "new");
      // Pretend the write started long ago: the sweep must still skip it.
      sweepStalePartialBinaries(binDir(), Date.now() + 2 * STALE_PARTIAL_MS, DEAD);
      survived = fs.existsSync(tmp);
    });
    expect(survived).toBe(true);
    expect(fs.readFileSync(dest, "utf-8")).toBe("new");
  });

  it("runs at the start of a retryDep", async () => {
    const stale = partial(`uv${exeSuffix()}`, 999_999_999, 2 * STALE_PARTIAL_MS);
    vi.spyOn(DependencyManager.prototype as unknown as { downloadGroup: () => Promise<void> }, "downloadGroup")
      .mockImplementation(async () => {
        writeInstalledUv(BUNDLED_MCP_SERVERS.flatMap((d) => d.dependencies).find((x) => x.binary === "uv")!.pinnedInstallToken!);
      });
    await new DependencyManager().retryDep("youtube-download", "uv");
    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe("placeBinary", () => {
  type Placer = {
    placeBinary: (
      dep: unknown,
      dest: string,
      write: (tmp: string) => void,
      rename?: (from: string, to: string) => void,
    ) => Promise<void>;
  };
  const errno = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

  it("replaces the binary only after the new one is fully written and verified; no temp file left", async () => {
    const dest = path.join(home, "bin", "tool");
    fs.writeFileSync(dest, "old");
    let seenDuringWrite = "";
    await (new DependencyManager() as unknown as Placer).placeBinary({ binary: "tool" }, dest, (tmp) => {
      seenDuringWrite = fs.readFileSync(dest, "utf-8"); // the live path still holds the old file
      fs.writeFileSync(tmp, "new");
    });
    expect(seenDuringWrite).toBe("old");
    expect(fs.readFileSync(dest, "utf-8")).toBe("new");
    expect(fs.readdirSync(path.join(home, "bin"))).toEqual(["tool"]);
  });

  it("a download that fails its sha256 leaves the working binary in place", async () => {
    const dest = path.join(home, "bin", "tool");
    fs.writeFileSync(dest, "working");
    await expect(
      (new DependencyManager() as unknown as Placer).placeBinary(
        { binary: "tool", sha256: "0".repeat(64) },
        dest,
        (tmp) => fs.writeFileSync(tmp, "tampered"),
      ),
    ).rejects.toThrow();
    expect(fs.readFileSync(dest, "utf-8")).toBe("working");
    expect(fs.readdirSync(path.join(home, "bin"))).toEqual(["tool"]);
  });

  // F6 (final review): on Windows an antivirus scanner holds a just-written .exe for a moment, so
  // the rename over the live path fails EPERM / EACCES / EBUSY. A short bounded retry, not a failure.
  it.each(["EPERM", "EACCES", "EBUSY"])("retries a rename that fails %s briefly, then places the binary", async (code) => {
    const dest = path.join(home, "bin", "tool");
    fs.writeFileSync(dest, "old");
    let failures = 2;
    const rename = vi.fn((from: string, to: string) => {
      if (failures-- > 0) throw errno(code);
      fs.renameSync(from, to);
    });
    await (new DependencyManager() as unknown as Placer).placeBinary({ binary: "tool" }, dest, (tmp) => fs.writeFileSync(tmp, "new"), rename);
    expect(rename).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(dest, "utf-8")).toBe("new");
    expect(fs.readdirSync(path.join(home, "bin"))).toEqual(["tool"]);
  });

  it("gives up after a bounded number of attempts, leaving the old binary and no temp file", async () => {
    const dest = path.join(home, "bin", "tool");
    fs.writeFileSync(dest, "old");
    const rename = vi.fn(() => { throw errno("EBUSY"); });
    const started = Date.now();
    await expect(
      (new DependencyManager() as unknown as Placer).placeBinary({ binary: "tool" }, dest, (tmp) => fs.writeFileSync(tmp, "new"), rename),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(rename.mock.calls.length).toBeGreaterThan(1);
    expect(rename.mock.calls.length).toBeLessThanOrEqual(8);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fs.readFileSync(dest, "utf-8")).toBe("old");
    expect(fs.readdirSync(path.join(home, "bin"))).toEqual(["tool"]);
  });

  it("does not retry any other error", async () => {
    const dest = path.join(home, "bin", "tool");
    const rename = vi.fn(() => { throw errno("ENOENT"); });
    await expect(
      (new DependencyManager() as unknown as Placer).placeBinary({ binary: "tool" }, dest, (tmp) => fs.writeFileSync(tmp, "new"), rename),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(rename).toHaveBeenCalledTimes(1);
  });
});
