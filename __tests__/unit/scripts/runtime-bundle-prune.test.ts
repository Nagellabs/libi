import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundleScript = require("../../../scripts/build-runtime-bundle.js") as {
  PRUNE_LIST: Array<{ pkg: string; why: string }>;
  pruneBundle: (outDir: string) => {
    removed: Array<{ pkg: string; bytes: number; transitive?: boolean; danglingShim?: boolean }>;
    totalBytes: number;
  };
  BUNDLE_CEILING_MB: number;
  assertNoDanglingLinks: (outDir: string) => void;
};
const { PRUNE_LIST, pruneBundle, BUNDLE_CEILING_MB, assertNoDanglingLinks } = bundleScript;

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-prune-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function plant(rel: string, bytes = 1024): void {
  const p = path.join(tmp, "node_modules", rel, "index.js");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x".repeat(bytes));
}

/** A package with a package.json declaring `deps`, so the sweep can see edges. */
function plantPkg(name: string, deps: string[] = [], bytes = 1024): void {
  const dir = path.join(tmp, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", dependencies: Object.fromEntries(deps.map((d) => [d, "*"])) }),
  );
  fs.writeFileSync(path.join(dir, "index.js"), "x".repeat(bytes));
}

function plantPrebuilds(names: string[]): void {
  for (const n of names) {
    const dir = path.join(tmp, "node_modules", "node-pty", "prebuilds", n);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spawn-helper"), "x");
  }
}

const HOST = `${process.platform}-${process.arch}`;

describe("PRUNE_LIST", () => {
  it("never lists a package the runtime resolves", () => {
    const keep = [
      // Reachable from the two request-time esbuild routes.
      "three",
      "opentype.js",
      "@mediapipe/tasks-vision",
      "mediabunny",
      "zod",
      // require()d from dist-cli.
      "roughjs",
      "satori",
      "sonner",
      "@tanstack/react-query",
      "@xterm/headless",
      "@xterm/addon-serialize",
      // serverExternalPackages — the farm links these by name.
      "better-sqlite3",
      "esbuild",
      "node-pty",
      "pino",
      "pino-pretty",
      "next-logger",
      "@napi-rs/canvas",
      "@resvg/resvg-js",
      "require-in-the-middle",
      "import-in-the-middle",
      "@opentelemetry/instrumentation",
      "@sentry/node",
      "@sentry/nextjs",
      "next",
    ];
    for (const k of keep) {
      expect(
        PRUNE_LIST.some((e) => e.pkg === k),
        `${k} is resolved at runtime and must never be pruned`,
      ).toBe(false);
    }
  });

  /**
   * The 116 MB entry that three static checks all cleared and the product
   * refuted. `next({ dev: false })` → `loadConfig` → `transpileConfig` loads the
   * SWC bindings to strip the types out of the `next.config.ts` this package
   * ships; with the package absent, Next silently DOWNLOADS it into
   * `node_modules/next/next-swc-fallback/` (measured 2026-09-09: 80 ms present,
   * 11 460 ms absent). That is a network round-trip on a first launch that has
   * to work offline, writing into a directory that is read-only inside a signed
   * .app. Nothing in this repo names the package, so no grep can find it.
   */
  it("does not list @next/swc-*, which loading next.config.ts needs at boot", () => {
    expect(PRUNE_LIST.filter((e) => e.pkg.startsWith("@next/swc"))).toEqual([]);
  });

  it("gives every entry a reason", () => {
    for (const e of PRUNE_LIST) {
      expect(e.why.length, `${e.pkg} has no reason`).toBeGreaterThan(20);
    }
  });

  it("lists each package once", () => {
    const names = PRUNE_LIST.map((e) => e.pkg);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The ceiling only earns its keep while it sits BELOW the un-pruned tree.
   * Measured on darwin-arm64 2026-09-09: 891 MB with the prune disabled, 706 MB
   * with it. A ceiling raised past 891 to make a build go green would still be
   * "a ceiling" and would catch nothing.
   */
  it("stays below the un-pruned bundle it exists to catch", () => {
    expect(BUNDLE_CEILING_MB).toBeGreaterThan(0);
    expect(BUNDLE_CEILING_MB).toBeLessThan(891);
  });
});

describe("pruneBundle", () => {
  it("removes the listed packages and reports what it freed", () => {
    plant("lucide-react", 4096);
    plant("three", 4096);
    plant("@sentry/cli", 2048);
    const { removed, totalBytes } = pruneBundle(tmp);
    const names = removed.map((r) => r.pkg);
    expect(names).toContain("lucide-react");
    expect(names).toContain("@sentry/cli");
    expect(names).not.toContain("three");
    expect(totalBytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tmp, "node_modules", "lucide-react"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "node_modules", "three"))).toBe(true);
  });

  /**
   * Deleting the roots is less than half the job. On the first real build the
   * 27 roots left 32 packages behind — 53 MB, a third of the total — because a
   * root is often a shim: `@sentry/cli` is 0.1 MB and its platform binary
   * `@sentry/cli-darwin` is 35 MB. `recharts` leaves `victory-vendor`, which
   * leaves `decimal.js-light`, so the sweep has to run to a fixpoint.
   */
  it("also removes what the pruned roots brought in, to a fixpoint", () => {
    plantPkg("recharts", ["victory-vendor"], 4096);
    plantPkg("victory-vendor", ["decimal.js-light"], 4096);
    plantPkg("decimal.js-light", [], 4096);
    const { removed } = pruneBundle(tmp);
    const names = removed.map((r) => r.pkg);
    expect(names).toContain("victory-vendor");
    expect(names).toContain("decimal.js-light");
    expect(removed.find((r) => r.pkg === "victory-vendor")).toMatchObject({ transitive: true });
    expect(removed.find((r) => r.pkg === "recharts")).not.toHaveProperty("transitive");
  });

  it("keeps a transitive dep something surviving still declares", () => {
    plantPkg("recharts", ["react-is"], 4096);
    plantPkg("react-is", [], 4096);
    // A package that is NOT pruned and still wants react-is.
    plantPkg("@tanstack/react-query", ["react-is"], 4096);
    const { removed } = pruneBundle(tmp);
    expect(removed.map((r) => r.pkg)).toContain("recharts");
    expect(fs.existsSync(path.join(tmp, "node_modules", "react-is"))).toBe(true);
  });

  /**
   * The sweep is seeded ONLY from the PRUNE_LIST roots. A general
   * "delete anything unreferenced" pass would have deleted
   * `@modelcontextprotocol/sdk`, which reached the production tree only through
   * `shadcn` while 53 files import it directly — every MCP tool, gone, in a way
   * no test in this suite would have noticed.
   */
  it("never touches a package no pruned root brought in, however unreferenced", () => {
    plantPkg("recharts", [], 4096);
    plantPkg("@modelcontextprotocol/sdk", [], 4096); // declared by nobody here
    const { removed } = pruneBundle(tmp);
    expect(removed.map((r) => r.pkg)).toEqual(["recharts"]);
    expect(fs.existsSync(path.join(tmp, "node_modules", "@modelcontextprotocol/sdk"))).toBe(true);
  });

  it("is a no-op for an entry that is not installed", () => {
    const { removed } = pruneBundle(tmp);
    expect(removed).toEqual([]);
  });

  it("keeps the host platform's node-pty prebuild and removes the others", () => {
    plantPrebuilds([HOST, "darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]);
    pruneBundle(tmp);
    const left = fs.readdirSync(path.join(tmp, "node_modules", "node-pty", "prebuilds"));
    expect(left).toEqual([HOST]);
  });

  /**
   * The failure this guard exists for is silent and unrepairable: node-pty
   * `posix_spawn()`s `spawn-helper` on every pty launch, and inside a signed
   * .app the bundle cannot be written to at runtime. If node-pty ever renames
   * its prebuild directories, an unguarded sweep would delete ALL of them —
   * shipping an app whose Terminal is dead with no way to fix it in place.
   */
  it("deletes nothing when node-pty carries no prebuild for this host", () => {
    plantPrebuilds(["some-future-naming-scheme", "another-one"]);
    const { removed } = pruneBundle(tmp);
    expect(removed).toEqual([]);
    expect(
      fs.readdirSync(path.join(tmp, "node_modules", "node-pty", "prebuilds")).sort(),
    ).toEqual(["another-one", "some-future-naming-scheme"]);
  });

  it("still sweeps when node-pty built from source instead of shipping a host prebuild", () => {
    plantPrebuilds(["darwin-x64", "win32-x64"]);
    const rel = path.join(tmp, "node_modules", "node-pty", "build", "Release");
    fs.mkdirSync(rel, { recursive: true });
    fs.writeFileSync(path.join(rel, "pty.node"), "x");
    const { removed } = pruneBundle(tmp);
    expect(removed.map((r) => r.pkg).sort()).toEqual(
      ["darwin-x64", "win32-x64"]
        .filter((n) => n !== HOST)
        .map((n) => `node-pty/prebuilds/${n}`)
        .sort(),
    );
  });
});

/**
 * npm writes a `.bin` entry per package `bin` field and REMOVING THE
 * PACKAGE LEAVES IT BEHIND. Pruning `@sentry/cli` left
 * `node_modules/.bin/sentry-cli -> ../@sentry/cli/bin/sentry-cli` dangling,
 * and nothing in the build noticed: it surfaced two steps later in
 * electron-builder's macOS signing pass, which stats every file it packages,
 * as `ENOENT … libi-bundle/node_modules/.bin/sentry-cli` — AFTER writing a
 * half-signed `.app` (`Identifier=Electron`, `Sealed Resources=none`) that
 * exits instantly when launched. `@sentry/cli` is not special: every future
 * PRUNE_LIST entry with a `bin` would do the same, which is why the sweep is
 * generic and `assertNoDanglingLinks` backstops it.
 */
describe("dangling .bin shims", () => {
  function planBin(dir: string, name: string, target: string): string {
    const binDir = path.join(tmp, "node_modules", ...(dir ? dir.split("/") : []), ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, name);
    fs.symlinkSync(target, link);
    return link;
  }

  it("removes the shim a pruned package left behind, and names it in the report", () => {
    // `@sentry/cli` is a real PRUNE_LIST root, so this is the exact shape.
    plantPkg("@sentry/cli");
    const shim = planBin("", "sentry-cli", "../@sentry/cli/bin/sentry-cli");
    plantPkg("keeper");
    const keeperShim = planBin("", "keeper", "../keeper/index.js");

    const result = pruneBundle(tmp);

    // Gone entirely — `existsSync` follows the link, so lstat is what proves
    // the entry itself is not there.
    expect(fs.existsSync(shim)).toBe(false);
    expect(() => fs.lstatSync(shim)).toThrow();
    expect(result.removed.some((r) => r.pkg.endsWith(".bin/sentry-cli"))).toBe(true);
    // A shim whose package survives is left exactly where it was.
    expect(fs.readlinkSync(keeperShim)).toBe("../keeper/index.js");
  });

  it("sweeps nested node_modules/.bin too", () => {
    plantPkg("@sentry/cli");
    const nestedDir = path.join(tmp, "node_modules", "outer", "node_modules");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.mkdirSync(path.join(nestedDir, ".bin"), { recursive: true });
    const nested = path.join(nestedDir, ".bin", "gone");
    fs.symlinkSync("../nowhere/bin/gone", nested);

    pruneBundle(tmp);
    expect(fs.existsSync(path.join(nestedDir, ".bin", "gone"))).toBe(false);
  });

  it("assertNoDanglingLinks names the link and the target it wanted", () => {
    fs.mkdirSync(path.join(tmp, "node_modules", "somewhere"), { recursive: true });
    fs.symlinkSync(
      "../nope/bin/thing",
      path.join(tmp, "node_modules", "somewhere", "thing"),
    );
    expect(() => assertNoDanglingLinks(tmp)).toThrow(/dangling symlink/i);
    expect(() => assertNoDanglingLinks(tmp)).toThrow(/thing/);
  });

  it("assertNoDanglingLinks is happy with a link that resolves", () => {
    plantPkg("keeper");
    fs.symlinkSync("./keeper/index.js", path.join(tmp, "node_modules", "resolves"));
    expect(() => assertNoDanglingLinks(tmp)).not.toThrow();
  });
});
