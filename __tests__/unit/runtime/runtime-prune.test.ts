import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  pruneUserRuntimes,
  pruneRuntimesBelowBundled,
  runningRuntimePrefix,
  DEFAULT_KEEP,
} from "@/lib/runtime/runtime-prune";
import {
  listInstalledRuntimes,
  pendingRuntimeVersion,
} from "@/lib/runtime/installed-runtimes";
import {
  SHELL_API_MIN_ENV,
  SHELL_API_MAX_ENV,
} from "@/lib/runtime/current-runtime";

let root: string;

function makeRuntime(version: string, extra: Record<string, unknown> = {}): string {
  const prefix = path.join(root, version);
  fs.mkdirSync(path.join(prefix, "node_modules", "@nagellabs", "libi"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(prefix, ".libi-runtime.json"),
    JSON.stringify({
      package: "@nagellabs/libi",
      version,
      shellApiVersion: 1,
      abi: "135",
      source: "fetched",
      installedAt: new Date().toISOString(),
      ...extra,
    }),
  );
  return prefix;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-runtime-prune-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("pruneUserRuntimes", () => {
  it("keeps the current AND the previous version — the rollback floor", () => {
    // Step 6's minimum: if a freshly-installed runtime fails the loader's
    // gates, the shell falls back to the previous prefix on its own. That only
    // works while the previous prefix still exists.
    for (const v of ["0.1.0", "0.1.1", "0.1.2", "0.1.3"]) makeRuntime(v);
    const res = pruneUserRuntimes({ rootDir: root });
    expect(res.kept.map((p) => path.basename(p))).toEqual(["0.1.3", "0.1.2"]);
    expect(res.removed.map((p) => path.basename(p)).sort()).toEqual(["0.1.0", "0.1.1"]);
    expect(DEFAULT_KEEP).toBe(2);
  });

  it("sorts numerically, so 0.10.0 outranks 0.9.0", () => {
    for (const v of ["0.9.0", "0.10.0", "0.8.0"]) makeRuntime(v);
    const res = pruneUserRuntimes({ rootDir: root, keep: 1 });
    expect(res.kept.map((p) => path.basename(p))).toEqual(["0.10.0"]);
  });

  it("never deletes the prefix this process is running from", () => {
    for (const v of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) makeRuntime(v);
    const running = path.join(root, "0.1.0");
    const res = pruneUserRuntimes({ rootDir: root, keep: 1, protectPrefix: running });
    expect(res.removed).not.toContain(running);
    expect(fs.existsSync(running)).toBe(true);
    expect(res.kept.map((p) => path.basename(p))).toContain("0.1.0");
  });

  it("sweeps installer debris regardless of the keep count", () => {
    makeRuntime("0.1.0");
    fs.mkdirSync(path.join(root, ".tmp-0.1.1-123-456"), { recursive: true });
    fs.mkdirSync(path.join(root, "0.1.0.old-999"), { recursive: true });
    const res = pruneUserRuntimes({ rootDir: root, keep: 5 });
    expect(fs.existsSync(path.join(root, ".tmp-0.1.1-123-456"))).toBe(false);
    expect(fs.existsSync(path.join(root, "0.1.0.old-999"))).toBe(false);
    expect(fs.existsSync(path.join(root, "0.1.0"))).toBe(true);
    expect(res.removed).toHaveLength(2);
  });

  it("is a no-op when the runtime dir does not exist", () => {
    expect(pruneUserRuntimes({ rootDir: path.join(root, "nope") })).toEqual({
      removed: [],
      kept: [],
    });
  });
});

describe("runningRuntimePrefix", () => {
  it("walks up from the runtime root to its install prefix", () => {
    const prefix = path.join("/tmp", "libi-home", "runtime", "0.1.1");
    const cwd = path.join(prefix, "node_modules", "@nagellabs", "libi");
    expect(runningRuntimePrefix(cwd)).toBe(prefix);
  });

  it("returns null for a dev checkout (nothing to protect)", () => {
    expect(runningRuntimePrefix("/Users/someone/dev/libi")).toBeNull();
    expect(runningRuntimePrefix("/Users/someone/node_modules/other/pkg")).toBeNull();
  });
});

describe("listInstalledRuntimes / pendingRuntimeVersion", () => {
  it("lists stamped runtimes newest first", () => {
    makeRuntime("0.1.0");
    makeRuntime("0.2.0");
    expect(listInstalledRuntimes(root).map((r) => r.version)).toEqual(["0.2.0", "0.1.0"]);
  });

  it("ignores an unstamped (interrupted) install", () => {
    makeRuntime("0.1.0");
    fs.mkdirSync(path.join(root, "0.3.0"), { recursive: true });
    expect(listInstalledRuntimes(root).map((r) => r.version)).toEqual(["0.1.0"]);
  });

  it("ignores a stamp naming some other package", () => {
    makeRuntime("0.1.0");
    makeRuntime("0.9.9", { package: "@someone/else" });
    expect(listInstalledRuntimes(root).map((r) => r.version)).toEqual(["0.1.0"]);
  });

  it("reports a pending version only when it is NEWER than the running one", () => {
    makeRuntime("0.1.1");
    expect(pendingRuntimeVersion("0.1.0", root)).toBe("0.1.1");
    // Already running it — nothing pending, so the UI must not claim a restart
    // will change anything.
    expect(pendingRuntimeVersion("0.1.1", root)).toBeNull();
    expect(pendingRuntimeVersion("0.2.0", root)).toBeNull();
  });

  it("has nothing pending when no runtime has been fetched", () => {
    expect(pendingRuntimeVersion("0.1.0", root)).toBeNull();
  });
});

describe("pendingRuntimeVersion — only counts what the shell would load (B2d)", () => {
  // The stamps in `makeRuntime` default to shellApiVersion 1 / abi "135";
  // this gate mirrors the loader's gates 2–3, so a shell accepting [1, 2]
  // on ABI 135 loads the defaults.
  const gate = { [SHELL_API_MIN_ENV]: "1", [SHELL_API_MAX_ENV]: "2" };
  const abi = "135";

  it("does not report a runtime staged for a NEWER shell (api above max)", () => {
    // The B2d bug: Settings said "restart to update", the loader refused the
    // candidate (`api-too-new`), and the restart silently changed nothing.
    makeRuntime("0.1.5", { shellApiVersion: 3 });
    expect(pendingRuntimeVersion("0.1.3", root, { env: gate, abi })).toBeNull();
  });

  it("does not report a runtime below the shell's minimum", () => {
    makeRuntime("0.1.5", { shellApiVersion: 0 });
    expect(pendingRuntimeVersion("0.1.3", root, { env: gate, abi })).toBeNull();
  });

  it("reports an in-range newer runtime exactly as before — boundaries inclusive", () => {
    // The loader accepts min <= api <= max, so both ends must count.
    makeRuntime("0.1.5", { shellApiVersion: 2 });
    expect(pendingRuntimeVersion("0.1.3", root, { env: gate, abi })).toBe("0.1.5");
    fs.rmSync(path.join(root, "0.1.5"), { recursive: true, force: true });
    makeRuntime("0.1.6", { shellApiVersion: 1 });
    expect(pendingRuntimeVersion("0.1.3", root, { env: gate, abi })).toBe("0.1.6");
  });

  it("gates nothing when the shell has published no range (npx / dev / old shell)", () => {
    // No env vars → no loader whose verdict could be contradicted. Hiding a
    // pending runtime because the env happened to be missing would be a worse
    // bug than the one the gate fixes.
    makeRuntime("0.1.5", { shellApiVersion: 99, abi: "999" });
    expect(pendingRuntimeVersion("0.1.3", root, { env: {}, abi })).toBe("0.1.5");
  });

  it("gates nothing on half a range", () => {
    makeRuntime("0.1.5", { shellApiVersion: 99 });
    expect(
      pendingRuntimeVersion("0.1.3", root, {
        env: { [SHELL_API_MIN_ENV]: "1" },
        abi,
      }),
    ).toBe("0.1.5");
    expect(
      pendingRuntimeVersion("0.1.3", root, {
        env: { [SHELL_API_MAX_ENV]: "2" },
        abi,
      }),
    ).toBe("0.1.5");
  });

  it("treats a missing or non-integer shellApiVersion as not loadable", () => {
    // The loader rejects such a stamp outright ("api-not-an-integer"), so
    // counting it pending would re-open the bug in a different costume.
    makeRuntime("0.1.5", { shellApiVersion: undefined });
    expect(pendingRuntimeVersion("0.1.3", root, { env: gate, abi })).toBeNull();
    fs.rmSync(path.join(root, "0.1.5"), { recursive: true, force: true });
    makeRuntime("0.1.5", { shellApiVersion: "one" });
    expect(pendingRuntimeVersion("0.1.3", root, { env: gate, abi })).toBeNull();
    // …but without a published range it still counts, exactly as today.
    expect(pendingRuntimeVersion("0.1.3", root, { env: {}, abi })).toBe("0.1.5");
  });

  it("treats a wrong or missing ABI as not loadable", () => {
    makeRuntime("0.1.5", { abi: "999" });
    expect(pendingRuntimeVersion("0.1.3", root, { env: gate, abi })).toBeNull();
    fs.rmSync(path.join(root, "0.1.5"), { recursive: true, force: true });
    makeRuntime("0.1.5", { abi: undefined });
    expect(pendingRuntimeVersion("0.1.3", root, { env: gate, abi })).toBeNull();
  });

  it("falls through to an older IN-RANGE candidate when the newest is refusable", () => {
    // The loader picks the newest candidate it accepts, not newest-or-nothing
    // — so must this. `installed[0]`-only would answer null here and undersell
    // a restart that genuinely applies 0.1.5.
    makeRuntime("0.1.6", { shellApiVersion: 5 }); // staged for a future shell
    makeRuntime("0.1.5"); // loadable, and newer than current
    expect(pendingRuntimeVersion("0.1.3", root, { env: gate, abi })).toBe("0.1.5");
    // …and the fallback candidate still has to beat the RUNNING version.
    expect(pendingRuntimeVersion("0.1.5", root, { env: gate, abi })).toBeNull();
  });

  it("pruning still sees runtimes the shell cannot load", () => {
    // The gate lives in pendingRuntimeVersion, NOT in listInstalledRuntimes:
    // pruning exists to reclaim exactly these unloadable directories (B2a/B2b)
    // and must never have them hidden from it.
    makeRuntime("0.1.5", { shellApiVersion: 99, abi: "999" });
    makeRuntime("0.1.4", { shellApiVersion: 99, abi: "999" });
    expect(listInstalledRuntimes(root).map((r) => r.version)).toEqual([
      "0.1.5",
      "0.1.4",
    ]);
    const surplus = pruneUserRuntimes({ rootDir: root, keep: 1 });
    expect(surplus.removed.map((p) => path.basename(p))).toEqual(["0.1.4"]);
    const below = pruneRuntimesBelowBundled({ bundledVersion: "0.1.6", rootDir: root });
    expect(below.removed.map((p) => path.basename(p))).toEqual(["0.1.5"]);
  });
});
