/**
 * Structural guards for two bug classes that have each been fixed several
 * times on this branch and would otherwise keep coming back.
 *
 * ## Class 1 — uv writing outside LIBI_HOME
 *
 * By default uv writes its cache, managed interpreters, tool installs and
 * project venvs into the USER's home, and — worst of all — puts a project venv
 * at `<project>/.venv`. The tracking sidecar's project dir is inside the
 * shipped package, so that default planted a 1.2 GB venv inside the signed
 * `.app`, breaking the code signature and failing on a read-only install.
 *
 * `lib/uv-env/spawn-env.ts#buildUvEnv` is the single seam that pins all of it
 * under LIBI_HOME. The guard below fails when a NEW file spawns uv without
 * going through it.
 *
 * ## Class 2 — `process.execPath` used as a spawn command
 *
 * Under the packaged app `process.execPath` is the Electron binary, and
 * `electronFuses.runAsNode: false` makes it ignore ELECTRON_RUN_AS_NODE — so
 * spawning it launches a second Libi GUI instead of the intended Node program.
 * Fixed four times already (`lib/install/npm-root.ts`, the storyboard render
 * worker, `fetchElectronPrebuild`, and the Playwright chromium installer).
 * `resolveNodeCommand()` (`lib/runtime/node-runtime.ts`) is the answer.
 *
 * A blanket ban would fire on legitimate uses (`bin/libi.js` and the build
 * scripts genuinely run under plain Node), and a rule nobody can satisfy gets
 * disabled — which is worse than no rule. So this is an ALLOWLIST: legitimate
 * uses are enumerated with a reason, and any new file is a failure that must
 * be justified by editing the list.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Directories holding shipped runtime code (not tests, not build output). */
const SOURCE_DIRS = ["lib", "mcp", "app", "components", "hooks", "electron"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(full, out);
    } else if (e.isFile() && /\.(ts|tsx|js|mjs)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const full of walk(path.join(REPO_ROOT, dir))) {
      files.push({
        rel: path.relative(REPO_ROOT, full),
        text: fs.readFileSync(full, "utf-8"),
      });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Class 1: every uv spawn goes through buildUvEnv()
// ---------------------------------------------------------------------------

/**
 * Files that reference a uv binary but do NOT spawn uv to do work, so they have
 * no env to build:
 *   - `lib/uv-path.ts` only RESOLVES the binary (it shells out to `which uv`).
 *   - `lib/uv-env/spawn-env.ts` IS the seam.
 */
const UV_ENV_EXEMPT = new Set(["lib/uv-path.ts", "lib/uv-env/spawn-env.ts"]);

/** Markers meaning "this file has a resolved uv binary in hand". */
const UV_BINARY_MARKERS = [
  "requireUvBinary(",
  "resolveUvBinary(",
  "resolveUvPath(",
  "uvPath(",
  "uvBinary",
];

/**
 * Every child-process launcher name, matched as a whole IDENTIFIER rather than
 * as a substring.
 *
 * Substring matching had a silent hole: `"spawn("` does not occur inside
 * `spawnSync(` (the characters are `spawnSync(`), so a call site using any of
 * the sync variants sailed straight past the guard. Matching identifiers also
 * kills the mirror-image false positive, where `"spawn("` fired on `respawn(`.
 *
 * Longest-first so the alternation cannot settle for `spawn` inside
 * `spawnSync`.
 */
const SPAWN_FN_NAMES = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "execFileAsync",
  "execAsync",
  "execPromise",
  "pexec",
  "fork",
].sort((a, b) => b.length - a.length);

function spawnCallRegex(): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9_$])(?:${SPAWN_FN_NAMES.join("|")})\\s*\\(`,
    "g",
  );
}

/**
 * Slice the argument list of a call whose `(` sits at `openIdx`.
 *
 * Counts brackets and skips string literals so a `)` inside `"…"` or `[…]`
 * cannot close the call early. Returns null when the source does not balance
 * (should not happen on valid TS, but the caller falls back rather than
 * silently passing).
 */
function callArguments(src: string, openIdx: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

/** The first argument of a call — i.e. the COMMAND being spawned. */
function firstArgument(args: string): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return args.slice(0, i);
  }
  return args;
}

/**
 * Local identifiers holding a resolved uv binary, so the extremely common
 * two-line form is recognised as a uv spawn:
 *
 *   const uv = requireUvBinary(WhisperTranscribeError, "Whisper");
 *   spawn(uv, args, { env: buildUvEnv() });
 *
 * A binding counts when its initialiser calls a uv resolver, or when the NAME
 * itself is a uv marker (`let uvBinary = this.getBinaryPath("uv")`).
 */
function uvBoundNames(text: string): string[] {
  const names = new Set<string>();
  const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*([^;\n]*)/g;
  for (const m of text.matchAll(decl)) {
    const [, name, init] = m;
    if (
      UV_BINARY_MARKERS.some((k) => init.includes(k)) ||
      UV_BINARY_MARKERS.some((k) => name === k.replace("(", ""))
    ) {
      names.add(name);
    }
  }
  return [...names];
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * Every call site in `text` that spawns uv, tagged with whether that CALL wires
 * `buildUvEnv`.
 *
 * The check is per call site, not per file. A file-level
 * `text.includes("buildUvEnv")` passed a file whose FIRST uv spawn was correct
 * even after a second, unwired one was added below it — which is exactly how a
 * regression would land in practice.
 */
function uvSpawnSites(text: string): { line: number; wired: boolean }[] {
  const uvNames = uvBoundNames(text);
  const sites: { line: number; wired: boolean }[] = [];
  for (const m of text.matchAll(spawnCallRegex())) {
    const openIdx = m.index! + m[0].length - 1;
    // Unbalanced source: fall back to a bounded window rather than skipping.
    const args = callArguments(text, openIdx) ?? text.slice(openIdx, openIdx + 2000);
    const command = firstArgument(args);
    const spawnsUv =
      UV_BINARY_MARKERS.some((k) => command.includes(k)) ||
      uvNames.some((n) => new RegExp(`(?<![A-Za-z0-9_$])${n}(?![A-Za-z0-9_$])`).test(command));
    if (!spawnsUv) continue;
    sites.push({ line: lineOf(text, m.index!), wired: args.includes("buildUvEnv") });
  }
  return sites;
}

describe("uv state stays under LIBI_HOME", () => {
  it("every uv spawn CALL SITE passes buildUvEnv() as its env", () => {
    const offenders: string[] = [];
    let found = 0;
    for (const f of sourceFiles()) {
      if (UV_ENV_EXEMPT.has(f.rel)) continue;
      for (const site of uvSpawnSites(maskComments(f.text))) {
        found++;
        if (!site.wired) offenders.push(`${f.rel}:${site.line}`);
      }
    }

    // Anti-vacuity: an empty offender list is only meaningful if the detector
    // still recognises the uv spawns we know exist (13 at the time of writing:
    // whisper, tts, music × 3, tracking × 4, virtual-deps × 2, yt-dlp × 2).
    // A refactor that renames the resolvers would otherwise make this guard
    // pass by seeing nothing at all.
    expect(
      found,
      "The uv-spawn detector matched almost nothing — it has stopped " +
        "recognising uv spawns rather than found them all correct. Check " +
        "UV_BINARY_MARKERS / SPAWN_FN_NAMES against the current call sites.",
    ).toBeGreaterThanOrEqual(10);

    expect(
      offenders,
      "These uv spawn call sites do not pass buildUvEnv() as their env. " +
        "Without it uv writes its cache/interpreters/tools to the user's " +
        "home, and a `uv sync` plants a venv inside the shipped package — " +
        "breaking the code signature. Import buildUvEnv from " +
        "@/lib/uv-env/spawn-env and pass it as `env` AT THIS CALL. A correct " +
        "sibling call elsewhere in the same file does not cover this one.",
    ).toEqual([]);
  });

  it("no file resolves uv and spawns without importing buildUvEnv at all", () => {
    // Coarse safety net beneath the call-site check: catches a spawn helper
    // whose name is not in SPAWN_FN_NAMES (a locally-aliased promisified
    // launcher, say) in a file that never wires the env anywhere.
    const offenders = sourceFiles()
      .filter((f) => !UV_ENV_EXEMPT.has(f.rel))
      .map((f) => ({ ...f, code: maskComments(f.text) }))
      .filter((f) => UV_BINARY_MARKERS.some((m) => f.code.includes(m)))
      .filter((f) => spawnCallRegex().test(f.code))
      .filter((f) => !f.code.includes("buildUvEnv"))
      .map((f) => f.rel);

    expect(
      offenders,
      "These files resolve a uv binary and spawn a child process, but never " +
        "reference buildUvEnv(). Import it from @/lib/uv-env/spawn-env and " +
        "pass it as `env`, or add the file to UV_ENV_EXEMPT with a reason if " +
        "it genuinely does not spawn uv.",
    ).toEqual([]);
  });

  it("pins every uv location under LIBI_HOME", async () => {
    const home = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "libi-uv-inv-")),
      "home",
    );
    const prev = process.env.LIBI_HOME;
    process.env.LIBI_HOME = home;
    try {
      const mod = await import("@/lib/uv-env/spawn-env");
      const vars = mod.uvEnvVars();

      // All four uv state locations, plus the tracking project venv.
      const pinned = [...Object.values(vars), mod.trackingVenvDir()];
      expect(pinned.length).toBeGreaterThanOrEqual(5);
      for (const p of pinned) {
        expect(p.startsWith(home), `${p} escapes LIBI_HOME ${home}`).toBe(true);
      }

      // The venv must NOT sit inside the package tree — that is the exact
      // defect this module exists to prevent.
      expect(mod.trackingVenvDir().includes(REPO_ROOT)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LIBI_HOME;
      else process.env.LIBI_HOME = prev;
    }
  });

  it("shares the uv tree across worktrees instead of re-downloading it", async () => {
    const { SHARED_LINKS } = await import("@/lib/dev/worktree-bootstrap");
    // Multi-gigabyte and not worktree-specific — same rationale as
    // bin/models/node_modules.
    expect(SHARED_LINKS).toContain("uv");
  });
});

// ---------------------------------------------------------------------------
// Class 2: process.execPath is never a spawn command in shipped runtime code
// ---------------------------------------------------------------------------

/**
 * Blank out line and block comments so the guards check real CODE.
 *
 * Deliberately not an allowlist entry per documenting comment: several files
 * legitimately EXPLAIN these rules in prose, and adding each to an allowlist
 * would erode the guard (an allowlisted file could later gain a real use
 * silently). Masking comments keeps the allowlist to actual spawns.
 *
 * Comment characters become spaces rather than being deleted, so every offset
 * and line number still lines up with the file on disk — the uv guard reports
 * `file:line`.
 */
function maskComments(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + blank(m.slice(p1.length)));
}

/**
 * Every legitimate `process.execPath` in shipped runtime CODE, with the reason
 * it is safe. Adding a file here is a deliberate act that should be reviewed.
 */
const EXEC_PATH_ALLOWLIST: Record<string, string> = {
  "lib/install/npm-root.ts":
    "guarded — only on the plain-Node branch; the Electron branch uses utilityProcess",
  "lib/runtime/runtime-install.ts":
    "guarded — runNpm() branches to utilityProcess under Electron",
};

describe("process.execPath is never a spawn command", () => {
  it("only appears in allowlisted files", () => {
    const found = sourceFiles()
      .filter((f) => maskComments(f.text).includes("process.execPath"))
      .map((f) => f.rel);

    const unexpected = found.filter((rel) => !(rel in EXEC_PATH_ALLOWLIST));

    expect(
      unexpected,
      "New `process.execPath` use in shipped runtime code. Under the packaged " +
        "app this is the Electron binary and (runAsNode fuse off) it launches " +
        "a second Libi GUI instead of running Node. Use resolveNodeCommand() " +
        "from @/lib/runtime/node-runtime. If this use is genuinely safe, add " +
        "it to EXEC_PATH_ALLOWLIST with a reason.",
    ).toEqual([]);
  });

  it("the chromium installer does not bake in process.execPath", async () => {
    const { getCustomInstaller, NODE_COMMAND_SENTINEL } = await import(
      "@/mcp/registry/installers"
    );
    const installer = getCustomInstaller("playwright-chromium");
    expect(installer).toBeDefined();
    expect(installer!.install.command).not.toBe(process.execPath);
    expect(installer!.install.command).toBe(NODE_COMMAND_SENTINEL);
  });
});
