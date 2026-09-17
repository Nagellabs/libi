// Tests for the shell↔runtime loader (electron/runtime-loader.ts).
//
// These are the gates that stand between a user and an app that opens, works
// for ten minutes, and then dies at the first database call. Each one is
// exercised against a REAL directory tree in a temp dir rather than a mocked
// fs, because the whole point of the module is what is or isn't on disk.
//
// `probeNative: false` throughout: gate 6 dlopen()s a real `better-sqlite3`
// out of the candidate, which a synthetic prefix cannot have. It is covered
// separately by `probeNativeBinding` against a directory that has no such
// module at all.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import {
  LIBI_DB_FILENAME,
  MAX_SHELL_API_VERSION,
  MIN_SHELL_API_VERSION,
  RUNTIME_PACKAGE,
  RUNTIME_STAMP_FILE,
  SHELL_API_ENTRY,
  describeNoRuntimeFailure,
  inspectRuntimePrefix,
  listUserRuntimePrefixes,
  probeNativeBinding,
  resolveRuntime,
  runtimeRootFor,
} from "@/electron/runtime-loader";

const ABI = "135";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-runtime-loader-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface FakeRuntimeOptions {
  version?: string;
  shellApiVersion?: number;
  stampShellApiVersion?: number;
  abi?: string;
  packageName?: string;
  stampPackage?: string;
  omitStamp?: boolean;
  omitShellApi?: boolean;
  omitNextBuild?: boolean;
  /** Ship no `better-sqlite3/build/Release-node-*` binding — what every
   *  runtime the in-app updater installed before this gate landed looked like. */
  omitNodeSidecars?: boolean;
  /** Value the loaded shell-api module reports. Defaults to shellApiVersion. */
  moduleShellApiVersion?: number;
}

/** Build a prefix that looks exactly like an `npm install`ed runtime. */
function makeRuntime(prefix: string, opts: FakeRuntimeOptions = {}): string {
  const version = opts.version ?? "0.1.0";
  const api = opts.shellApiVersion ?? 1;
  const root = runtimeRootFor(prefix);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: opts.packageName ?? RUNTIME_PACKAGE,
      version,
      libi: { shellApiVersion: api },
    }),
  );
  if (!opts.omitShellApi) {
    const entry = path.join(root, SHELL_API_ENTRY);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(
      entry,
      `module.exports = { SHELL_API_VERSION: ${opts.moduleShellApiVersion ?? api} };\n`,
    );
  }
  if (!opts.omitNextBuild) {
    fs.mkdirSync(path.join(root, ".next"), { recursive: true });
    fs.writeFileSync(path.join(root, ".next", "BUILD_ID"), "abc123");
  }
  if (!opts.omitNodeSidecars) {
    // The MCP child is a separate real-node process, so a runtime must carry a
    // plain-Node binding alongside the Electron one. A real bundle has several;
    // one is enough to satisfy the gate, which matches the producers' own
    // fail-if-zero policy.
    const sidecar = path.join(
      prefix,
      "node_modules",
      "better-sqlite3",
      "build",
      "Release-node-24",
    );
    fs.mkdirSync(sidecar, { recursive: true });
    fs.writeFileSync(path.join(sidecar, "better_sqlite3.node"), "stub");
  }
  if (!opts.omitStamp) {
    fs.writeFileSync(
      path.join(prefix, RUNTIME_STAMP_FILE),
      JSON.stringify({
        package: opts.stampPackage ?? RUNTIME_PACKAGE,
        version,
        shellApiVersion: opts.stampShellApiVersion ?? api,
        abi: opts.abi ?? ABI,
      }),
    );
  }
  return prefix;
}

/** A database stamped as if a runtime at `schema` had migrated it. */
function makeStampedDb(dir: string, schema: number): string {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, LIBI_DB_FILENAME);
  const db = new Database(dbPath);
  db.exec("CREATE TABLE t (a INTEGER)");
  db.pragma(`user_version = ${schema}`);
  db.close();
  return dbPath;
}

/** Give a synthetic runtime a drizzle journal topping out at `maxIdx`. */
function withMigrations(prefix: string, maxIdx: number): string {
  const meta = path.join(runtimeRootFor(prefix), "drizzle", "sqlite", "meta");
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(
    path.join(meta, "_journal.json"),
    JSON.stringify({
      entries: Array.from({ length: maxIdx + 1 }, (_, idx) => ({ idx, tag: `${idx}_x` })),
    }),
  );
  return prefix;
}

describe("gate 8 — a runtime older than the database on disk", () => {
  // The scenario this gate exists for: a shell update bumps Electron's ABI, so
  // every staged runtime is rejected at gate 2 and the user is demoted to the
  // snapshot inside the .app. Before migration 0051 that was harmless; now the
  // older runtime's seedDatabase writes a dropped column and the app dies in
  // its first boot step, advising `rm -rf` on the user's database.
  it("rejects a runtime whose migrations stop short of the database", () => {
    const prefix = withMigrations(makeRuntime(path.join(tmp, "old")), 50);
    const dbPath = makeStampedDb(path.join(tmp, "home"), 52);
    expect(inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false, dbPath })).toMatchObject({
      ok: false,
      reason: "db-schema-too-new",
    });
  });

  it("accepts a runtime at the same schema, and one ahead of it", () => {
    const dbPath = makeStampedDb(path.join(tmp, "home"), 52);
    for (const [name, idx] of [["same", 52], ["newer", 53]] as const) {
      const prefix = withMigrations(makeRuntime(path.join(tmp, name)), idx);
      expect(
        inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false, dbPath }).ok,
      ).toBe(true);
    }
  });

  it("fails OPEN when there is no database, no stamp, or no journal", () => {
    const withJournal = withMigrations(makeRuntime(path.join(tmp, "j")), 50);
    // No database at all — a first run.
    expect(
      inspectRuntimePrefix(withJournal, {
        abi: ABI,
        probeNative: false,
        dbPath: path.join(tmp, "home", "absent.sqlite"),
      }).ok,
    ).toBe(true);
    // A database from before the stamp existed reads 0.
    const unstamped = makeStampedDb(path.join(tmp, "home0"), 0);
    expect(
      inspectRuntimePrefix(withJournal, { abi: ABI, probeNative: false, dbPath: unstamped }).ok,
    ).toBe(true);
    // A runtime with no `drizzle/` to read.
    const noJournal = makeRuntime(path.join(tmp, "nj"));
    const ahead = makeStampedDb(path.join(tmp, "home2"), 52);
    expect(
      inspectRuntimePrefix(noJournal, { abi: ABI, probeNative: false, dbPath: ahead }).ok,
    ).toBe(true);
  });

  it("is skipped entirely when no dbPath is given", () => {
    const prefix = withMigrations(makeRuntime(path.join(tmp, "old2")), 50);
    expect(inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false }).ok).toBe(true);
  });

  it("resolveRuntime derives the database path from LIBI_HOME", () => {
    const home = path.join(tmp, "libihome");
    makeStampedDb(home, 52);
    const runtimes = path.join(home, "runtime");
    fs.mkdirSync(runtimes, { recursive: true });
    withMigrations(makeRuntime(path.join(runtimes, "0.1.13"), { version: "0.1.13" }), 50);
    const resourcesPath = path.join(tmp, "resources");
    withMigrations(
      makeRuntime(path.join(resourcesPath, "libi-bundle"), { version: "0.1.12" }),
      50,
    );

    const resolved = resolveRuntime({
      isPackaged: true,
      resourcesPath,
      libiHome: home,
      abi: ABI,
      probeNative: false,
    });
    expect(resolved.runtime).toBeNull();
    expect(resolved.rejections.map((r) => r.reason)).toEqual([
      "db-schema-too-new",
      "db-schema-too-new",
    ]);
  });

  it("the splash for an all-too-old resolution never mentions the database", () => {
    const { error, hint } = describeNoRuntimeFailure([
      {
        prefix: "/p",
        root: "/p/root",
        ok: false,
        reason: "db-schema-too-new",
        detail: "libi 0.1.13 understands database schema 50",
        version: "0.1.13",
      },
    ]);
    expect(error).toMatch(/older than your libi data/i);
    expect(hint).toMatch(/Install the latest/i);
    // "nothing to delete or repair" is fine; an INSTRUCTION to delete, or the
    // damaged-install copy, is what must never reach this screen.
    expect(hint).not.toMatch(/rm -rf|damaged|Reinstalling the app/i);
  });
});

describe("inspectRuntimePrefix", () => {
  it("accepts a well-formed runtime", () => {
    const result = inspectRuntimePrefix(makeRuntime(path.join(tmp, "good")), {
      abi: ABI,
      probeNative: false,
    });
    expect(result.ok).toBe(true);
    expect(result.version).toBe("0.1.0");
    expect(result.shellApiVersion).toBe(1);
  });

  it("rejects a prefix that does not exist", () => {
    const result = inspectRuntimePrefix(path.join(tmp, "nope"), {
      abi: ABI,
      probeNative: false,
    });
    expect(result).toMatchObject({ ok: false, reason: "prefix-missing" });
  });

  it("rejects an unstamped prefix", () => {
    const prefix = makeRuntime(path.join(tmp, "unstamped"), { omitStamp: true });
    expect(inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false })).toMatchObject({
      ok: false,
      reason: "stamp-missing",
    });
  });

  it("rejects an unparseable stamp", () => {
    const prefix = makeRuntime(path.join(tmp, "bad-json"));
    fs.writeFileSync(path.join(prefix, RUNTIME_STAMP_FILE), "{not json");
    expect(inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false })).toMatchObject({
      ok: false,
      reason: "stamp-unparseable",
    });
  });

  it("rejects a stamp naming some other package", () => {
    const prefix = makeRuntime(path.join(tmp, "stranger"), {
      stampPackage: "@evil/libi",
    });
    expect(inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false })).toMatchObject({
      ok: false,
      reason: "stamp-wrong-package",
    });
  });

  // THE load-bearing one: a wrong-ABI runtime must be refused up front, not
  // discovered when the app first opens the database.
  it("rejects a runtime built for a different NODE_MODULE_VERSION", () => {
    const prefix = makeRuntime(path.join(tmp, "wrong-abi"), { abi: "137" });
    const result = inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false });
    expect(result).toMatchObject({ ok: false, reason: "abi-mismatch" });
    expect(result.detail).toContain("137");
    expect(result.detail).toContain("135");
  });

  it("rejects a runtime whose shell API predates this shell", () => {
    const prefix = makeRuntime(path.join(tmp, "old"), {
      shellApiVersion: MIN_SHELL_API_VERSION - 1,
    });
    expect(inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false })).toMatchObject({
      ok: false,
      reason: "api-too-old",
    });
  });

  it("rejects a runtime that needs a newer shell", () => {
    const prefix = makeRuntime(path.join(tmp, "new"), {
      shellApiVersion: MAX_SHELL_API_VERSION + 1,
    });
    const result = inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false });
    expect(result).toMatchObject({ ok: false, reason: "api-too-new" });
    expect(result.detail).toContain("update the desktop app");
  });

  it("rejects a non-integer shell API version", () => {
    const prefix = makeRuntime(path.join(tmp, "float"));
    const stamp = JSON.parse(
      fs.readFileSync(path.join(prefix, RUNTIME_STAMP_FILE), "utf-8"),
    );
    stamp.shellApiVersion = "1";
    fs.writeFileSync(path.join(prefix, RUNTIME_STAMP_FILE), JSON.stringify(stamp));
    expect(inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false })).toMatchObject({
      ok: false,
      reason: "api-not-an-integer",
    });
  });

  // A stamp is a claim; package.json is the artifact. Someone editing the
  // stamp to sneak a runtime past the gate must not succeed.
  it("rejects a stamp that disagrees with the installed package.json", () => {
    const prefix = makeRuntime(path.join(tmp, "liar"), {
      shellApiVersion: 1,
      stampShellApiVersion: 1,
    });
    const manifestPath = path.join(runtimeRootFor(prefix), "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    manifest.libi.shellApiVersion = 99;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false })).toMatchObject({
      ok: false,
      reason: "root-disagrees-with-stamp",
    });
  });

  it("rejects a runtime with no shell-api entry", () => {
    const prefix = makeRuntime(path.join(tmp, "no-api"), { omitShellApi: true });
    expect(inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false })).toMatchObject({
      ok: false,
      reason: "shell-api-missing",
    });
  });

  it("rejects a runtime with no production Next build", () => {
    const prefix = makeRuntime(path.join(tmp, "no-next"), { omitNextBuild: true });
    expect(inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false })).toMatchObject({
      ok: false,
      reason: "next-build-missing",
    });
  });

  // The blocker this gate exists for. The in-app updater ran only the ELECTRON
  // prebuild fetch, so every runtime it installed had `build/Release` and no
  // `Release-node-*` at all. Gate 7 dlopens better-sqlite3 in THIS process —
  // which is Electron, where that single binding is exactly right — so the
  // broken runtime validated cleanly, and being newer than the bundled
  // snapshot it shadowed a working runtime on every subsequent boot. The user
  // got a fully healthy-looking app in which every DB-backed `libi.*` tool
  // died at first agent use, with nothing naming the cause.
  it("rejects a runtime carrying no plain-Node better-sqlite3 binding", () => {
    const prefix = makeRuntime(path.join(tmp, "no-sidecar"), {
      omitNodeSidecars: true,
    });
    const result = inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false });
    expect(result).toMatchObject({ ok: false, reason: "node-sidecars-missing" });
    expect(result.detail).toContain("separate Node process");
  });

  it("treats a zero-length sidecar as absent", () => {
    const prefix = makeRuntime(path.join(tmp, "empty-sidecar"), {
      omitNodeSidecars: true,
    });
    const dir = path.join(
      prefix,
      "node_modules",
      "better-sqlite3",
      "build",
      "Release-node-24",
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "better_sqlite3.node"), ""); // failed copy
    expect(inspectRuntimePrefix(prefix, { abi: ABI, probeNative: false })).toMatchObject({
      ok: false,
      reason: "node-sidecars-missing",
    });
  });

  it("rejects when the native probe cannot load better-sqlite3", () => {
    const prefix = makeRuntime(path.join(tmp, "no-native"));
    // probeNative defaults to true; the synthetic tree has no better-sqlite3.
    expect(inspectRuntimePrefix(prefix, { abi: ABI })).toMatchObject({
      ok: false,
      reason: "native-probe-failed",
    });
  });
});

describe("probeNativeBinding", () => {
  it("reports a failure instead of throwing when the module is absent", () => {
    const result = probeNativeBinding(makeRuntime(path.join(tmp, "bare")));
    expect(result.ok).toBe(false);
    expect(typeof result.detail).toBe("string");
  });
});

describe("listUserRuntimePrefixes", () => {
  it("returns nothing when the runtime dir does not exist", () => {
    expect(listUserRuntimePrefixes(path.join(tmp, "empty-home"))).toEqual([]);
  });

  it("orders versions newest first, numerically", () => {
    const home = path.join(tmp, "home");
    for (const v of ["0.9.0", "0.10.0", "0.1.0"]) {
      fs.mkdirSync(path.join(home, "runtime", v), { recursive: true });
    }
    // In-progress installs are hidden; they must never be picked up mid-write.
    fs.mkdirSync(path.join(home, "runtime", ".tmp-0.11.0"), { recursive: true });
    expect(listUserRuntimePrefixes(home).map((p) => path.basename(p))).toEqual([
      "0.10.0",
      "0.9.0",
      "0.1.0",
    ]);
  });
});

describe("resolveRuntime", () => {
  function layout() {
    const resourcesPath = path.join(tmp, "Resources");
    const libiHome = path.join(tmp, "home");
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.mkdirSync(libiHome, { recursive: true });
    return { resourcesPath, libiHome };
  }

  it("never loads a runtime when the app is not packaged", () => {
    const { resourcesPath, libiHome } = layout();
    makeRuntime(path.join(resourcesPath, "libi-bundle"));
    const result = resolveRuntime({
      isPackaged: false,
      resourcesPath,
      libiHome,
      abi: ABI,
      probeNative: false,
    });
    expect(result.runtime).toBeNull();
  });

  it("uses the bundled snapshot when nothing has been fetched", () => {
    const { resourcesPath, libiHome } = layout();
    makeRuntime(path.join(resourcesPath, "libi-bundle"), { version: "0.1.0" });
    const result = resolveRuntime({
      isPackaged: true,
      resourcesPath,
      libiHome,
      abi: ABI,
      probeNative: false,
    });
    expect(result.runtime?.source).toBe("bundled");
    expect(result.runtime?.version).toBe("0.1.0");
  });

  it("prefers a fetched runtime over the bundled one", () => {
    const { resourcesPath, libiHome } = layout();
    makeRuntime(path.join(resourcesPath, "libi-bundle"), { version: "0.1.0" });
    makeRuntime(path.join(libiHome, "runtime", "0.2.0"), { version: "0.2.0" });
    const result = resolveRuntime({
      isPackaged: true,
      resourcesPath,
      libiHome,
      abi: ABI,
      probeNative: false,
    });
    expect(result.runtime?.source).toBe("user");
    expect(result.runtime?.version).toBe("0.2.0");
  });

  // The whole safety argument for shipping runtimes weekly: an incompatible
  // fetched runtime must fall back, not half-load.
  it("falls back to the bundled snapshot when the fetched runtime needs a newer shell", () => {
    const { resourcesPath, libiHome } = layout();
    makeRuntime(path.join(resourcesPath, "libi-bundle"), { version: "0.1.0" });
    makeRuntime(path.join(libiHome, "runtime", "0.2.0"), {
      version: "0.2.0",
      shellApiVersion: MAX_SHELL_API_VERSION + 1,
    });
    const result = resolveRuntime({
      isPackaged: true,
      resourcesPath,
      libiHome,
      abi: ABI,
      probeNative: false,
    });
    expect(result.runtime?.source).toBe("bundled");
    expect(result.runtime?.version).toBe("0.1.0");
    expect(result.rejections.map((r) => r.reason)).toContain("api-too-new");
  });

  it("falls back when the fetched runtime has the wrong native ABI", () => {
    const { resourcesPath, libiHome } = layout();
    makeRuntime(path.join(resourcesPath, "libi-bundle"), { version: "0.1.0" });
    makeRuntime(path.join(libiHome, "runtime", "0.2.0"), {
      version: "0.2.0",
      abi: "137",
    });
    const result = resolveRuntime({
      isPackaged: true,
      resourcesPath,
      libiHome,
      abi: ABI,
      probeNative: false,
    });
    expect(result.runtime?.source).toBe("bundled");
    expect(result.rejections.map((r) => r.reason)).toContain("abi-mismatch");
  });

  // The documented rollback for runtimes ALREADY on disk from the buggy
  // installer: no UI, no user action — the shell just stops preferring them.
  it("falls back to the bundled snapshot when a fetched runtime has no Node sidecar", () => {
    const { resourcesPath, libiHome } = layout();
    makeRuntime(path.join(resourcesPath, "libi-bundle"), { version: "0.1.0" });
    makeRuntime(path.join(libiHome, "runtime", "0.2.0"), {
      version: "0.2.0",
      omitNodeSidecars: true,
    });
    const result = resolveRuntime({
      isPackaged: true,
      resourcesPath,
      libiHome,
      abi: ABI,
      probeNative: false,
    });
    expect(result.runtime?.source).toBe("bundled");
    expect(result.runtime?.version).toBe("0.1.0");
    expect(result.rejections.map((r) => r.reason)).toContain("node-sidecars-missing");
  });

  it("rejects a runtime whose loaded module disagrees with its stamp", () => {
    const { resourcesPath, libiHome } = layout();
    makeRuntime(path.join(resourcesPath, "libi-bundle"), {
      version: "0.1.0",
      moduleShellApiVersion: 7,
    });
    const result = resolveRuntime({
      isPackaged: true,
      resourcesPath,
      libiHome,
      abi: ABI,
      probeNative: false,
    });
    expect(result.runtime).toBeNull();
    expect(result.rejections.map((r) => r.reason)).toContain(
      "shell-api-version-disagrees",
    );
  });

  it("returns null — never a half-loaded runtime — when nothing is usable", () => {
    const { resourcesPath, libiHome } = layout();
    const result = resolveRuntime({
      isPackaged: true,
      resourcesPath,
      libiHome,
      abi: ABI,
      probeNative: false,
    });
    expect(result.runtime).toBeNull();
    expect(result.rejections.length).toBeGreaterThan(0);
  });

  it("actually loads the module it selected", () => {
    const { resourcesPath, libiHome } = layout();
    makeRuntime(path.join(resourcesPath, "libi-bundle"));
    const result = resolveRuntime({
      isPackaged: true,
      resourcesPath,
      libiHome,
      abi: ABI,
      probeNative: false,
    });
    expect(result.runtime?.api.SHELL_API_VERSION).toBe(1);
  });
});

// The two version tracks — the shell (a whole `.app`, carrying a bundled
// runtime snapshot) and the runtime (`runtime/<v>/` staged from npm) — move
// independently, so either can end up newer. Selection used to read "any user
// prefix first, bundled last", which was only ever correct while the bundled
// snapshot could not advance underneath a staged one. A shell update advances
// it, and a user who staged 0.1.1 and then updated the shell to 0.1.5 ran
// 0.1.1 while the UI told them they were current.
//
// This is a MATRIX and not a single case on purpose: the bug is a rule, and
// one row cannot express a rule. Row 1 is the regression itself and must fail
// against source-before-version selection; if it passes, the test is not
// reaching the selection logic.
describe("resolveRuntime — selecting across the shell and runtime tracks", () => {
  function layout() {
    const resourcesPath = path.join(tmp, "Resources");
    const libiHome = path.join(tmp, "home");
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.mkdirSync(libiHome, { recursive: true });
    return { resourcesPath, libiHome };
  }

  interface Row {
    why: string;
    bundled: string;
    /** Staged user runtimes, as `version` or `version@apiVersion`. */
    staged: Array<string | FakeRuntimeOptions>;
    expectVersion: string;
    expectSource: "bundled" | "user";
  }

  const MATRIX: Row[] = [
    {
      why: "a staged runtime older than bundled must NOT win (the A0b regression)",
      bundled: "0.1.5",
      staged: ["0.1.1"],
      expectVersion: "0.1.5",
      expectSource: "bundled",
    },
    {
      why: "a staged runtime newer than bundled still wins — the update path",
      bundled: "0.1.5",
      staged: ["0.1.7"],
      expectVersion: "0.1.7",
      expectSource: "user",
    },
    {
      why: "fresh install, nothing staged",
      bundled: "0.1.5",
      staged: [],
      expectVersion: "0.1.5",
      expectSource: "bundled",
    },
    {
      why: "an exact tie prefers bundled — no extra disk, already integrity-checked",
      bundled: "0.1.5",
      staged: ["0.1.5"],
      expectVersion: "0.1.5",
      expectSource: "bundled",
    },
    {
      why: "the forward gate still holds: a runtime too new for this shell is refused",
      bundled: "0.1.0",
      staged: [{ version: "0.1.9", shellApiVersion: MAX_SHELL_API_VERSION + 1 }],
      expectVersion: "0.1.0",
      expectSource: "bundled",
    },
    {
      why: "several stale staged runtimes all lose, not just the newest of them",
      bundled: "0.1.5",
      staged: ["0.1.1", "0.1.3"],
      expectVersion: "0.1.5",
      expectSource: "bundled",
    },
  ];

  for (const row of MATRIX) {
    const staged = row.staged
      .map((s) => (typeof s === "string" ? s : s.version))
      .join(", ");
    it(`bundled ${row.bundled} + staged [${staged || "none"}] → ${row.expectVersion} (${row.expectSource}) — ${row.why}`, () => {
      const { resourcesPath, libiHome } = layout();
      makeRuntime(path.join(resourcesPath, "libi-bundle"), {
        version: row.bundled,
      });
      for (const s of row.staged) {
        const opts = typeof s === "string" ? { version: s } : s;
        makeRuntime(path.join(libiHome, "runtime", opts.version!), opts);
      }

      const result = resolveRuntime({
        isPackaged: true,
        resourcesPath,
        libiHome,
        abi: ABI,
        probeNative: false,
      });

      expect(result.runtime?.version).toBe(row.expectVersion);
      expect(result.runtime?.source).toBe(row.expectSource);
    });
  }

  // Losing on version is not the same as being broken, and the splash's
  // rejection list is for things that are broken. A stale-but-valid runtime
  // that simply lost the comparison must not be reported as a failure.
  it("does not report a merely-older staged runtime as a rejection", () => {
    const { resourcesPath, libiHome } = layout();
    makeRuntime(path.join(resourcesPath, "libi-bundle"), { version: "0.1.5" });
    makeRuntime(path.join(libiHome, "runtime", "0.1.1"), { version: "0.1.1" });

    const result = resolveRuntime({
      isPackaged: true,
      resourcesPath,
      libiHome,
      abi: ABI,
      probeNative: false,
    });

    expect(result.runtime?.version).toBe("0.1.5");
    expect(result.rejections).toEqual([]);
  });
});

describe("describeNoRuntimeFailure", () => {
  it("tells the user to update the app when a runtime needs a newer shell", () => {
    const { error, hint } = describeNoRuntimeFailure([
      {
        prefix: "/x",
        root: "/x/r",
        ok: false,
        reason: "api-too-new",
        version: "9.9.9",
        detail: "shellApiVersion 4 > 1",
      },
    ]);
    expect(error).toContain("9.9.9");
    expect(hint).toContain("Update Libi");
  });

  // The plan's three-outcome table: this case is a damaged install, and
  // blaming the network would send the user chasing the wrong thing.
  it("does not blame the network when the bundled snapshot is simply missing", () => {
    const { error, hint } = describeNoRuntimeFailure([
      { prefix: "/x", root: "/x/r", ok: false, reason: "prefix-missing" },
    ]);
    expect(error).toContain("could not load its runtime");
    expect(hint).toContain("not a\nnetwork problem");
    expect(hint).toContain("support@nagellabs.com");
  });
});
