import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// `scripts/build-runtime-bundle.js` writes the stamp the packaged shell's
// runtime loader reads, and `verifyRuntimeBundle()` — wired as
// electron-builder's `beforePack` hook — is the last gate before that bundle is
// copied into a signable app.
//
// It was once a gate that could not fail. The stamp's `buildId` / `cliBuiltAt`
// were read from the WORKING TREE and then compared back against that same
// working tree, so under `--from-registry` (the shell-release path, where
// the bundle's contents come from npm and have no necessary relationship to the
// tree) the stamp described one artifact while the bundle contained another —
// and the guard compared the tree against itself and reported green.
//
// Every test below therefore constructs a bundle whose stamp genuinely
// disagrees with the installed runtime and asserts the guard says so. Against
// the old implementation they all pass, which is the entire point of having
// them.

import runtimeBundleModule from "../../../scripts/build-runtime-bundle.js";

interface VerifyResult {
  ok: boolean;
  reason?: string;
  stamp?: Record<string, unknown>;
}
interface RuntimeBundleModule {
  verifyRuntimeBundle: (opts: { outDir: string; treeRoot?: string }) => VerifyResult;
  runtimeRootFor: (prefix: string) => string;
  electronAbi: () => string;
}
const { verifyRuntimeBundle, runtimeRootFor, electronAbi } =
  runtimeBundleModule as unknown as RuntimeBundleModule;

// The two cases that must get PAST the ABI check to assert anything need the
// real one. Asking the Electron binary is how the script itself does it, and it
// is unavailable on a checkout where `electron` was never downloaded — those
// two tests skip there rather than asserting something weaker.
let realAbi: string | null = null;
try {
  realAbi = electronAbi();
} catch {
  realAbi = null;
}
if (realAbi === null)
  console.info(
    "[skip] runtime-bundle-stamp ABI tests — Electron binary not downloaded on this checkout (7 tests skip; the rest of the file still runs)",
  );

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const repoPkg = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
) as { version: string; libi: { shellApiVersion: number } };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

/** The stamp's dist-cli source digest — must mirror `digestCliInputs`. */
function digestInputs(inputs: Record<string, string>): string {
  return sha256(
    Object.keys(inputs)
      .sort()
      .map((rel) => `${rel} ${inputs[rel]}`)
      .join("\n"),
  );
}

interface BundleOverrides {
  /** Patched into the stamp AFTER it is derived from the bundle's real facts. */
  stamp?: Record<string, unknown>;
  /** Patched into the installed runtime, leaving the stamp describing the old state. */
  runtime?: {
    buildId?: string;
    cliBuiltAt?: string;
    version?: string;
    /** Extra `lib/`/`mcp/` sources the bundle's dist-cli stamp does not know about. */
    addSources?: Record<string, string>;
    /** Sources to delete from the bundle after its dist-cli stamp was written. */
    dropSources?: string[];
    /** Sources to edit after its dist-cli stamp was written. */
    editSources?: Record<string, string>;
  };
}

/**
 * A minimal but STRUCTURALLY REAL bundle: an install prefix holding
 * `node_modules/@nagellabs/libi` with a `.next/BUILD_ID`, a `dist-cli/`
 * compiled from two sources, and a `.libi-runtime.json` at the prefix root.
 *
 * Small enough to build in milliseconds; laid out exactly as the 1.2 GB real
 * thing, so `verifyRuntimeBundle` exercises the same code paths.
 */
function makeBundle(
  origin: "working-tree" | "registry",
  overrides: BundleOverrides = {},
): string {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "libi-bundle-stamp-"));
  dirs.push(prefix);
  const root = runtimeRootFor(prefix);

  const sources: Record<string, string> = {
    "lib/alpha.ts": "export const alpha = 1;\n",
    "mcp/beta.ts": "export const beta = 2;\n",
  };
  for (const [rel, body] of Object.entries(sources)) write(path.join(root, rel), body);
  for (const rel of Object.keys(sources)) {
    write(path.join(root, "dist-cli", rel.replace(/\.ts$/, ".js")), "module.exports = {};\n");
  }
  write(path.join(root, "dist-cli", "lib", "runtime", "shell-api.js"), "module.exports = {};\n");

  const inputs: Record<string, string> = {};
  for (const [rel, body] of Object.entries(sources)) inputs[rel] = sha256(body);
  const cliBuiltAt = "2026-07-29T12:00:00.000Z";
  write(
    path.join(root, "dist-cli", "BUILD_INFO.json"),
    JSON.stringify({ version: repoPkg.version, builtAt: cliBuiltAt, fileCount: 2, inputs }, null, 2),
  );

  const buildId = "BUILD-ID-IN-THE-BUNDLE";
  write(path.join(root, ".next", "BUILD_ID"), `${buildId}\n`);

  // The Turbopack externals symlink farm, laid out exactly as the real bundle:
  // an externalised package hoisted to the prefix's own `node_modules`, and a
  // RELATIVE symlink to it under `.next/node_modules/` — the shape that lets a
  // packaged boot verify the farm instead of writing into the signed .app.
  // A fixture without one is not a healthy bundle, so it belongs here rather
  // than in the individual tests.
  fs.mkdirSync(path.join(prefix, "node_modules", "pino"), { recursive: true });
  const farmDir = path.join(root, ".next", "node_modules");
  fs.mkdirSync(farmDir, { recursive: true });
  fs.symlinkSync(
    path.relative(farmDir, path.join(prefix, "node_modules", "pino")),
    path.join(farmDir, "pino-abc123"),
    "dir",
  );
  write(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@nagellabs/libi",
      version: repoPkg.version,
      libi: { shellApiVersion: repoPkg.libi.shellApiVersion },
    }),
  );

  const stamp: Record<string, unknown> = {
    package: "@nagellabs/libi",
    version: repoPkg.version,
    shellApiVersion: repoPkg.libi.shellApiVersion,
    // A deliberately impossible default: cases that are designed to fail
    // BEFORE the ABI probe runs never need a real Electron. Cases that must
    // get past it override this with `realAbi` and skip when Electron was
    // never downloaded.
    abi: "0",
    electronVersion: "36.9.5",
    buildId,
    cliBuiltAt,
    cliFileCount: 2,
    cliInputsDigest: digestInputs(inputs),
    origin,
    requestedVersion: origin === "registry" ? repoPkg.version : null,
    versionPinned: false,
    source: "bundled",
    installedAt: new Date().toISOString(),
    ...(overrides.stamp ?? {}),
  };
  write(path.join(prefix, ".libi-runtime.json"), JSON.stringify(stamp, null, 2));

  const rt = overrides.runtime;
  if (rt?.buildId !== undefined) write(path.join(root, ".next", "BUILD_ID"), `${rt.buildId}\n`);
  if (rt?.cliBuiltAt !== undefined) {
    const p = path.join(root, "dist-cli", "BUILD_INFO.json");
    const info = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    info.builtAt = rt.cliBuiltAt;
    fs.writeFileSync(p, JSON.stringify(info, null, 2));
  }
  if (rt?.version !== undefined) {
    const p = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    manifest.version = rt.version;
    fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
    // A real tarball's dist-cli stamp carries the same version as the manifest
    // beside it — `verifyCliBundle` cross-checks the two, so leaving them
    // inconsistent would make the fixture fail for a reason of its own making.
    const info = path.join(root, "dist-cli", "BUILD_INFO.json");
    const cliStamp = JSON.parse(fs.readFileSync(info, "utf-8")) as Record<string, unknown>;
    cliStamp.version = rt.version;
    fs.writeFileSync(info, JSON.stringify(cliStamp, null, 2));
  }
  for (const [rel, body] of Object.entries(rt?.addSources ?? {})) write(path.join(root, rel), body);
  for (const rel of rt?.dropSources ?? []) fs.rmSync(path.join(root, rel), { force: true });
  for (const [rel, body] of Object.entries(rt?.editSources ?? {})) write(path.join(root, rel), body);

  return prefix;
}

describe("verifyRuntimeBundle — the stamp must describe the bundle", () => {
  // THE regression test. A registry-origin bundle whose installed runtime
  // carries a different `.next` build than the stamp claims is precisely the
  // artifact the old guard waved through, because it never looked at the
  // bundle at all.
  it("fails when the bundled runtime's .next build differs from the stamp", () => {
    const prefix = makeBundle("registry", { runtime: { buildId: "A-COMPLETELY-OTHER-BUILD" } });
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("the stamp does not describe the bundle");
    expect(result.reason).toContain("A-COMPLETELY-OTHER-BUILD");
  });

  it("fails when the bundled runtime's dist-cli was compiled at a different time", () => {
    const prefix = makeBundle("registry", { runtime: { cliBuiltAt: "1999-01-01T00:00:00.000Z" } });
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("dist-cli build time");
  });

  it("fails when the bundled runtime is a different package version than stamped", () => {
    const prefix = makeBundle("registry", { runtime: { version: "0.0.99" } });
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("package version");
  });

  // build-cli's stamp is checked in BOTH directions, so neither an added nor a
  // deleted source can be used to smuggle a mismatched dist-cli through.
  it("fails on a source the bundled runtime's dist-cli stamp does not know about", () => {
    const prefix = makeBundle("registry", {
      runtime: { addSources: { "lib/gamma.ts": "export const gamma = 3;\n" } },
    });
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("new source file not in the stamp");
  });

  it("fails on a source deleted from the bundled runtime after its dist-cli was built", () => {
    const prefix = makeBundle("registry", { runtime: { dropSources: ["mcp/beta.ts"] } });
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no longer exist");
  });

  it("fails on a source edited in the bundled runtime after its dist-cli was built", () => {
    const prefix = makeBundle("registry", {
      runtime: { editSources: { "lib/alpha.ts": "export const alpha = 999;\n" } },
    });
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("source changed since the bundle was built");
  });

  it("rejects a legacy stamp outright rather than verifying it the old way", () => {
    const prefix = makeBundle("registry", { stamp: { origin: undefined } });
    // `undefined` does not survive JSON.stringify, so the field is simply absent.
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("origin");
  });
});

describe("verifyRuntimeBundle — origin decides what freshness means", () => {
  // The registry path must not demand that the working tree agree with a
  // runtime that came from npm; requiring it would make a shell release unusable.
  // What IS knowable is that npm handed back the version that was asked for.
  it("fails when npm installed a different version than was requested", () => {
    const prefix = makeBundle("registry", { stamp: { requestedVersion: "9.9.9" } });
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("asked npm for");
  });

  it("fails when an unpinned registry bundle has fallen behind package.json", () => {
    const stale = "0.0.1";
    const prefix = makeBundle("registry", {
      stamp: { version: stale, requestedVersion: stale, versionPinned: false },
      runtime: { version: stale },
    });
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(repoPkg.version);
  });

  it.skipIf(realAbi === null)("accepts a DELIBERATELY pinned older registry bundle", () => {
    const pinned = "0.0.1";
    const prefix = makeBundle("registry", {
      stamp: { version: pinned, requestedVersion: pinned, versionPinned: true, abi: realAbi },
      runtime: { version: pinned },
    });
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.reason ?? "(ok)").toBe("(ok)");
    expect(result.ok).toBe(true);
  });

  it("holds a working-tree bundle to the working tree as well", () => {
    // Stamp and bundle agree with each other, and neither matches the tree they
    // claim to describe — the case that says "packed from a tree that has since
    // moved on".
    //
    // `treeRoot` points at a fixture rather than at this repo ON PURPOSE.
    // Reading the real working tree made the assertion depend on whether
    // whoever ran the suite happened to have built: with no `.next/BUILD_ID`,
    // verification stops one step earlier — "working tree is not built" — and
    // never reaches the drift check this test exists to pin. That is exactly
    // how it failed during the first `npm publish` (2026-08-14, after a
    // `rm -rf .next`), and it would fail the same way on any fresh clone. No CI
    // runs this suite, so "passes on my machine" was the only thing holding it
    // up. The case below covers the not-built path deliberately instead.
    const prefix = makeBundle("working-tree");
    const treeRoot = runtimeRootFor(
      makeBundle("working-tree", { runtime: { buildId: "A-TREE-THAT-MOVED-ON" } }),
    );
    const result = verifyRuntimeBundle({ outDir: prefix, treeRoot });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("different tree state");
  });

  it("reports an unbuilt working tree as such, rather than as drift", () => {
    // The path the test above used to hit by accident. A tree with no
    // `.next/BUILD_ID` cannot be compared to anything, and saying "different
    // tree state" there would send someone hunting a drift that does not exist.
    const prefix = makeBundle("working-tree");
    const unbuilt = runtimeRootFor(makeBundle("working-tree"));
    fs.rmSync(path.join(unbuilt, ".next", "BUILD_ID"), { force: true });
    const result = verifyRuntimeBundle({ outDir: prefix, treeRoot: unbuilt });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("working tree is not built");
  });
});

describe("verifyRuntimeBundle — structural checks", () => {
  it("reports a missing bundle rather than throwing", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "libi-bundle-empty-"));
    dirs.push(empty);
    const result = verifyRuntimeBundle({ outDir: empty });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no runtime bundle");
  });

  it("reports a runtime root missing the module the shell loads", () => {
    const prefix = makeBundle("registry");
    fs.rmSync(path.join(runtimeRootFor(prefix), "dist-cli", "lib", "runtime", "shell-api.js"));
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("shell-api.js");
  });

  it.skipIf(realAbi === null)("fails a bundle carrying code libi may not redistribute", () => {
    const prefix = makeBundle("registry", { stamp: { abi: realAbi } });
    fs.mkdirSync(path.join(prefix, "node_modules", "@anthropic-ai", "claude-agent-sdk"), {
      recursive: true,
    });
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("LICENCE VIOLATION");
  });
});

// Check (9). The farm is materialised at bundle-build time so a packaged boot
// never has to write into the code-signed (possibly read-only) .app to repair
// it. All three of these ship SILENTLY otherwise: the app boots, binds its
// port, and 500s every route that touches an externalised package.
//
// These need `realAbi` because (9) runs LAST — deliberately, so it can never
// mask the licence/ABI gates, which is exactly what it did when it ran early.
describe("verifyRuntimeBundle — the externals symlink farm", () => {
  const farmDirOf = (prefix: string): string =>
    path.join(runtimeRootFor(prefix), ".next", "node_modules");

  it.skipIf(realAbi === null)("accepts a bundle whose farm is present and relative", () => {
    const result = verifyRuntimeBundle({ outDir: makeBundle("registry", { stamp: { abi: realAbi } }) });
    expect(result.reason ?? "(none)").toBe("(none)");
    expect(result.ok).toBe(true);
  });

  it.skipIf(realAbi === null)("fails a bundle with no farm at all", () => {
    const prefix = makeBundle("registry", { stamp: { abi: realAbi } });
    fs.rmSync(farmDirOf(prefix), { recursive: true, force: true });
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no Next.js externals symlink farm");
  });

  it.skipIf(realAbi === null)("fails a farm whose targets are ABSOLUTE", () => {
    const prefix = makeBundle("registry", { stamp: { abi: realAbi } });
    const farm = farmDirOf(prefix);
    // Resolves fine HERE, and dangles the moment the bundle is copied into
    // Contents/Resources — the failure that must not reach a user.
    fs.rmSync(path.join(farm, "pino-abc123"));
    fs.symlinkSync(path.join(prefix, "node_modules", "pino"), path.join(farm, "pino-abc123"), "dir");
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ABSOLUTE target");
  });

  it.skipIf(realAbi === null)("fails a farm whose links dangle", () => {
    const prefix = makeBundle("registry", { stamp: { abi: realAbi } });
    fs.rmSync(path.join(prefix, "node_modules", "pino"), { recursive: true, force: true });
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not resolve");
  });

  it.skipIf(realAbi === null)("reports the LICENCE violation, not the farm, when both are wrong", () => {
    const prefix = makeBundle("registry", { stamp: { abi: realAbi } });
    fs.rmSync(farmDirOf(prefix), { recursive: true, force: true });
    fs.mkdirSync(path.join(prefix, "node_modules", "@anthropic-ai", "claude-agent-sdk"), {
      recursive: true,
    });
    const result = verifyRuntimeBundle({ outDir: prefix });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("LICENCE VIOLATION");
  });
});
