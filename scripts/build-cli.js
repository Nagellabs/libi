#!/usr/bin/env node
/**
 * Compile the tsx-run entry chains to plain CommonJS at `dist-cli/`, with
 * every `@/…` path alias pre-resolved to a relative specifier.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * `npx @nagellabs/libi` could not launch at all before this step. tsx applies
 * the tsconfig `paths` matcher ONLY when the importing file's own path does
 * not contain a `node_modules` segment — verified directly in
 * `node_modules/tsx/dist/register-*.cjs`:
 *
 *     const J = `${path.sep}node_modules${path.sep}`;
 *     … if (!filePath.includes(J)) { …only here are `paths` applied… }
 *
 * Installed from npm, EVERY libi file sits under
 * `<consumer>/node_modules/@nagellabs/libi/…`, so all ~792 `@/…` imports
 * throw MODULE_NOT_FOUND before the CLI runs a single line. The packaged
 * Electron app escapes this purely by accident of layout — it lives at
 * `Contents/Resources/app/`, which has no `node_modules` path segment — which
 * is exactly why the bug stayed invisible.
 *
 * ── Transpile, NOT bundle ─────────────────────────────────────────────────
 * esbuild only resolves tsconfig `paths` in BUNDLE mode, so bundling looks
 * like the obvious answer (and a 2.1 MB single-file CJS bundle does build in
 * 38 ms). It is the wrong answer here: ten files in these chains derive
 * package-relative paths from their own `__dirname`
 * (`lib/whisper/transcribe.ts` → `../../mcp/whisper/transcribe.py`,
 * `lib/libi-home.ts`'s walk-up for `mcp/skills`, `lib/cli/studio.ts`'s
 * `projectRoot` chdir, …). Collapsing the graph into one file at one depth
 * silently repoints every one of them — a class of failure that surfaces as
 * "the Python sidecar isn't installed" rather than as a build error.
 *
 * So: per-file transpile with `bundle: false`, output mirroring the source
 * tree, and a mechanical rewrite of the `@/…` specifiers esbuild leaves
 * behind. `__dirname` then differs from source by exactly one level
 * (`dist-cli/`), which `lib/runtime/package-root.ts` absorbs for the handful
 * of sites that care. As a bonus, nothing from `node_modules` is ever inlined
 * — bare specifiers stay bare requires — so the licence gates
 * (`scripts/check-licenses.sh`, `scripts/afterpack-license-guard.js`) keep
 * seeing the truth, and native modules (better-sqlite3, node-pty) are
 * untouched.
 *
 * ── This step MUST NOT be skippable ───────────────────────────────────────
 * This repo already shipped a silent-build-step-skip in this exact pipeline:
 * `scripts/write-next-externals-manifest.js` was chained as an npm `postbuild`
 * hook, and npm only fires pre/post hooks for scripts it runs BY NAME —
 * `build:electron` invokes the release script BY PATH, so the hook never fired
 * and a release shipped a `.next` that 500'd every route. Read that file's
 * header for the full receipt.
 *
 * The same defence is applied here, deliberately reusing its shape:
 *   * exposed as a plain function, called EXPLICITLY from every real entry
 *     point (`scripts/next-build-release.js`, and `prepack` by name);
 *   * output STAMPED at `dist-cli/BUILD_INFO.json` with a sha256 per input
 *     file, so a stale or partial bundle is detectable rather than trusted;
 *   * `assertCliBundleFresh()` THROWS on missing/stale output, and `prepack`
 *     runs it so a tarball can never be packed around a rotten bundle;
 *   * `__tests__/unit/scripts/build-cli.test.ts` runs the REAL compiler over
 *     the REAL tree (a mocked compile would inherit the same blind spot), and
 *     `__tests__/unit/scripts/cli-bundle-wiring.test.ts` asserts the wiring.
 *
 * Never re-introduce this as a lifecycle hook.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
/** Directory name of the compiled tree, relative to the package root. */
const OUT_DIRNAME = "dist-cli";
/** Stamp file name inside the compiled tree. */
const STAMP_NAME = "BUILD_INFO.json";

/**
 * Source roots that get compiled. `lib/` and `mcp/` are the complete blast
 * radius of the two entry chains (`lib/cli/index.ts`, `mcp/index.ts`) — 426
 * files traced, zero from `app/`, `components/` or `hooks/`. We compile the
 * whole of both directories rather than a traced subset so the set stays
 * correct as files are added, with no tracer to keep in sync.
 */
const SOURCE_DIRS = ["lib", "mcp"];

/** Paths never compiled: dev-only fakes (excluded from both shipped
 *  artifacts), tests, and the Python sidecar tree. */
const EXCLUDE_RE =
  /(^|\/)(__tests__|__pycache__|\.venv|\.pytest_cache)(\/|$)|(^|\/)mcp\/dev\//;

const SOURCE_EXT = new Set([".ts", ".tsx"]);
/** Extensions tried when resolving an `@/…` specifier, mirroring how tsx /
 *  Turbopack resolve it today. */
const RESOLVE_CANDIDATES = [
  "",
  ".ts",
  ".tsx",
  ".json",
  "/index.ts",
  "/index.tsx",
];

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

function walkDir(dir, root, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (EXCLUDE_RE.test(rel)) continue;
    if (entry.isDirectory()) {
      walkDir(full, root, out);
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      if (entry.name.endsWith(".d.ts")) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      out.push(rel);
    }
  }
}

/** Every source file the compile step owns, as `/`-joined paths relative to
 *  `root`, sorted for determinism. */
function listSourceFiles(root = ROOT) {
  const out = [];
  for (const dir of SOURCE_DIRS) walkDir(path.join(root, dir), root, out);
  out.sort();
  return out;
}

// ---------------------------------------------------------------------------
// Alias rewriting
// ---------------------------------------------------------------------------

/** Resolve `@/rest` against the source tree. Returns the `/`-joined relative
 *  source path, or null when nothing matches. */
function resolveAliasTarget(rest, root) {
  for (const suffix of RESOLVE_CANDIDATES) {
    const candidateRel = rest + suffix;
    const abs = path.join(root, candidateRel);
    try {
      if (fs.statSync(abs).isFile()) {
        return candidateRel.split(path.sep).join("/");
      }
    } catch {
      /* not this candidate */
    }
  }
  return null;
}

function toRelativeSpecifier(fromDir, toAbs) {
  let rel = path.relative(fromDir, toAbs).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

/**
 * Rewrite every `require("@/…")` / `import("@/…")` in `code` into a relative
 * specifier valid from `outFile`.
 *
 * Two target classes:
 *  - a compiled `.ts`/`.tsx` source → points into the mirrored `outDir` tree
 *    (extension dropped so Node resolves the emitted `.js`);
 *  - a non-compiled file that ships as-is (today: the root `package.json`,
 *    imported by `mcp/skills/digest.ts`) → points at the REAL package root.
 *    `outDir` sits directly under the package root in the shipped tarball, so
 *    the build-time relative path stays correct at runtime.
 *
 * Anything else (the client-only `@/hooks`, `@/components` tree, reachable
 * only from files the server entry chains never load) is left VERBATIM and
 * reported, rather than rewritten into a require that would resolve to a
 * `.ts` file Node cannot load.
 *
 * Pure: no I/O beyond resolving the specifier against the source tree.
 */
function rewriteAliasSpecifiers(code, { root, outDir, outFile }) {
  const outFileDir = path.dirname(outFile);
  const unresolved = [];
  const pattern = /\b(require|import)\(\s*(["'])(@\/[^"'\n]+)\2\s*\)/g;

  const rewritten = code.replace(pattern, (match, kind, quote, specifier) => {
    const rest = specifier.slice(2);
    const targetRel = resolveAliasTarget(rest, root);
    if (targetRel === null) {
      unresolved.push(specifier);
      return match;
    }
    const ext = path.extname(targetRel);
    const inCompiledTree =
      SOURCE_DIRS.includes(targetRel.split("/")[0]) && !EXCLUDE_RE.test(targetRel);
    let nextSpecifier;
    if (SOURCE_EXT.has(ext) && inCompiledTree) {
      const outTarget = path.join(outDir, targetRel.slice(0, -ext.length));
      nextSpecifier = toRelativeSpecifier(outFileDir, outTarget);
    } else if (ext === ".json") {
      nextSpecifier = toRelativeSpecifier(outFileDir, path.join(root, targetRel));
    } else {
      unresolved.push(specifier);
      return match;
    }

    // A dynamic `import()` inside a CommonJS module goes through Node's ESM
    // resolver, which — unlike `require()` — has NO extension inference: a
    // rewritten `import("../../lib/libi-home")` throws
    // ERR_MODULE_NOT_FOUND at runtime. (Found by actually booting an installed
    // copy: Category A's binary-install phase died on exactly this,
    // `mcp/registry/installers.ts` → `await import("@/lib/libi-home")`.)
    //
    // Adding `.js` would resolve, but then Node imports our CJS output THROUGH
    // the ESM loader, whose named exports come from cjs-module-lexer — and
    // esbuild emits `module.exports = __toCommonJS(...)`, a dynamic property
    // copy the lexer cannot see. Every named binding would silently be
    // `undefined`, e.g. `const { getAvailableMemoryBytes } = await import(…)`.
    //
    // So local dynamic imports become a deferred `require()` instead. The
    // whole compiled tree is CJS, so `require()` yields exactly the object the
    // call sites destructure; `Promise.resolve().then(…)` keeps the laziness
    // AND the rejection semantics of `import()` (a synchronous throw would
    // escape a trailing `.catch()`).
    if (kind === "import") {
      return `Promise.resolve().then(() => require(${quote}${nextSpecifier}${quote}))`;
    }
    return `${kind}(${quote}${nextSpecifier}${quote})`;
  });

  // Same ESM-resolver trap, for dynamic imports that were ALREADY relative in
  // the source and so never went through the alias pass above — e.g.
  // `mcp/registry/dependency-manager.ts`'s
  // `await import("./installers/tracking-pyenv")`. (That one is written across
  // several lines, which esbuild collapses onto one, so rewriting the EMITTED
  // output rather than the source is what makes this catchable at all.)
  // Bare package specifiers are deliberately untouched: `import("chokidar")` /
  // `import("next")` must stay real ESM imports — chokidar v5 is ESM-only with
  // no `require` export condition.
  const relativeDynamicImport = /\bimport\(\s*(["'])(\.{1,2}\/[^"'\n]+)\1\s*\)/g;
  const finalCode = rewritten.replace(
    relativeDynamicImport,
    (_match, quote, specifier) =>
      `Promise.resolve().then(() => require(${quote}${specifier}${quote}))`,
  );

  return { code: finalCode, unresolved };
}

// ---------------------------------------------------------------------------
// Stamp
// ---------------------------------------------------------------------------

function sha256File(abs) {
  return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

function readPackageVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")).version ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Compile `lib/` + `mcp/` into `outDir`, rewrite the alias specifiers, and
 * write the stamp. Returns `{ outDir, fileCount, unresolvedFiles, stampPath }`.
 */
async function buildCli({ root = ROOT, outDir, quiet = false } = {}) {
  const targetDir = outDir ?? path.join(root, OUT_DIRNAME);
  const sources = listSourceFiles(root);
  if (sources.length === 0) {
    throw new Error(
      `[build-cli] found no source files under ${SOURCE_DIRS.join("/, ")}/ in ${root} — refusing to write an empty bundle.`,
    );
  }

  fs.rmSync(targetDir, { recursive: true, force: true });

  const built = await esbuild.build({
    entryPoints: sources.map((rel) => path.join(root, rel)),
    bundle: false,
    outdir: targetDir,
    outbase: root,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: false,
    tsconfig: path.join(root, "tsconfig.json"),
    absWorkingDir: root,
    logLevel: quiet ? "silent" : "warning",
  });

  // `import.meta` under a CJS output format is a WARNING in esbuild, not an
  // error: it substitutes `{}` and carries on, so
  // `fileURLToPath(import.meta.url)` compiles to `fileURLToPath(undefined)`
  // and throws at MODULE LOAD — the MCP child dies on startup with a stack
  // trace pointing at node:internal/url. tsx masks the whole CJS/ESM
  // inconsistency at dev time, so this WILL be written again. eslint bans the
  // syntax in lib/ + mcp/; this promotes esbuild's own warning to a hard build
  // failure so the compile step is not the one place that shrugs.
  const fatal = (built.warnings ?? []).filter((w) => w.id === "empty-import-meta");
  if (fatal.length > 0) {
    const where = fatal
      .map((w) => (w.location ? `${w.location.file}:${w.location.line}` : "(unknown)"))
      .join(", ");
    throw new Error(
      `[build-cli] \`import.meta\` is not usable in the CommonJS output this step emits — ` +
        `esbuild replaces it with {} and the compiled file throws at load time. Found at: ${where}. ` +
        "Use `__dirname` (or `packageRoot()` from lib/runtime/package-root.ts) instead.",
    );
  }

  // Rewrite the `@/…` specifiers esbuild leaves untouched in non-bundle mode.
  const unresolvedByFile = new Map();
  let fileCount = 0;
  for (const rel of sources) {
    const outRel = rel.replace(/\.tsx?$/, ".js");
    const outFile = path.join(targetDir, outRel);
    if (!fs.existsSync(outFile)) {
      throw new Error(`[build-cli] esbuild produced no output for ${rel} (expected ${outFile})`);
    }
    const src = fs.readFileSync(outFile, "utf-8");
    const { code, unresolved } = rewriteAliasSpecifiers(src, {
      root,
      outDir: targetDir,
      outFile,
    });
    if (code !== src) fs.writeFileSync(outFile, code);
    if (unresolved.length > 0) unresolvedByFile.set(outRel, unresolved);
    fileCount += 1;
  }

  const inputs = {};
  for (const rel of sources) inputs[rel] = sha256File(path.join(root, rel));
  const stampPath = path.join(targetDir, STAMP_NAME);
  fs.writeFileSync(
    stampPath,
    JSON.stringify(
      {
        version: readPackageVersion(root),
        builtAt: new Date().toISOString(),
        fileCount,
        inputs,
      },
      null,
      2,
    ) + "\n",
  );

  const unresolvedFiles = [...unresolvedByFile.keys()].sort();
  if (!quiet) {
    console.log(
      `[build-cli] compiled ${fileCount} file(s) -> ${path.relative(root, targetDir) || targetDir}`,
    );
    if (unresolvedFiles.length > 0) {
      console.log(
        `[build-cli] ${unresolvedFiles.length} file(s) keep an unrewritten @/ specifier ` +
          "(client-only tree, never loaded by the CLI/MCP entry chains): " +
          unresolvedFiles.join(", "),
      );
    }
  }

  return { outDir: targetDir, fileCount, unresolvedFiles, stampPath };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Check the compiled tree against the current sources. Returns
 * `{ ok: true }` or `{ ok: false, reason }`. Detects: no bundle at all, a
 * changed source file, a NEW source file the bundle predates, and a missing
 * compiled output.
 */
function verifyCliBundle({ root = ROOT, outDir } = {}) {
  const targetDir = outDir ?? path.join(root, OUT_DIRNAME);
  const stampPath = path.join(targetDir, STAMP_NAME);
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(stampPath, "utf-8"));
  } catch {
    return { ok: false, reason: `no compiled CLI bundle: ${stampPath} is missing or unreadable` };
  }
  if (!stamp || typeof stamp.inputs !== "object" || stamp.inputs === null) {
    return { ok: false, reason: `${stampPath} has no \`inputs\` map` };
  }

  const version = readPackageVersion(root);
  if (stamp.version !== version) {
    return {
      ok: false,
      reason: `bundle was built for version ${stamp.version || "(none)"}, package.json says ${version || "(none)"}`,
    };
  }

  const sources = listSourceFiles(root);
  const stamped = new Set(Object.keys(stamp.inputs));
  for (const rel of sources) {
    if (!stamped.has(rel)) {
      return { ok: false, reason: `new source file not in the stamp: ${rel}` };
    }
    const actual = sha256File(path.join(root, rel));
    if (actual !== stamp.inputs[rel]) {
      return { ok: false, reason: `source changed since the bundle was built: ${rel}` };
    }
    const outFile = path.join(targetDir, rel.replace(/\.tsx?$/, ".js"));
    if (!fs.existsSync(outFile)) {
      return { ok: false, reason: `missing compiled output for ${rel} (expected ${outFile})` };
    }
    stamped.delete(rel);
  }
  if (stamped.size > 0) {
    return {
      ok: false,
      reason: `stamp references ${stamped.size} source file(s) that no longer exist, e.g. ${[...stamped][0]}`,
    };
  }
  return { ok: true };
}

/** `verifyCliBundle`, but throws with an actionable message. */
function assertCliBundleFresh(opts = {}) {
  const result = verifyCliBundle(opts);
  if (!result.ok) {
    throw new Error(
      `[build-cli] the compiled CLI bundle is missing or stale — ${result.reason}.\n` +
        "   `npx @nagellabs/libi` CANNOT launch without it (tsx refuses to apply tsconfig\n" +
        "   `paths` to any file under node_modules, so every @/ import throws).\n" +
        "   Rebuild with: npm run build:cli",
    );
  }
  return result;
}

module.exports = {
  OUT_DIRNAME,
  STAMP_NAME,
  listSourceFiles,
  rewriteAliasSpecifiers,
  buildCli,
  verifyCliBundle,
  assertCliBundleFresh,
};

if (require.main === module) {
  const verifyOnly = process.argv.includes("--verify");
  (async () => {
    try {
      if (!verifyOnly) await buildCli({ root: ROOT });
      assertCliBundleFresh({ root: ROOT });
      console.log("[build-cli] OK");
    } catch (err) {
      console.error(`\n❌ ${err && err.message ? err.message : err}\n`);
      process.exit(1);
    }
  })();
}
