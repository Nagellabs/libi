#!/usr/bin/env node

// Respawn under tsx for TypeScript + path alias support, with a
// dev-only worktree bootstrap that isolates LIBI_HOME + picks a free
// port when run from inside a linked git worktree. End-users
// (npm-installed `npx @nagellabs/libi`) hit the dev-mode gate and pass through
// unchanged.

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

// tsx ships as a plain JS script with `#!/usr/bin/env node`. On machines
// where `node` is managed by a version-manager shim (proto, nvm, etc.) that
// reads $HOME, overriding HOME in a subprocess env breaks the shim's config
// lookup, causing it to hang. Use process.execPath (the real Node.js binary
// that is already running us) as the executor and pass tsx as a script
// argument to avoid re-entering the shim layer.
const NODE = process.execPath;

/**
 * Resolve tsx's CLI entry script. Prefer real Node module resolution
 * (`require.resolve`, which walks up ancestor `node_modules/` dirs) over a
 * single hardcoded nested path — a real `npm install`/`npx @nagellabs/libi` consumer
 * install HOISTS `tsx` to the install root's top-level `node_modules/`
 * rather than nesting it under `node_modules/libi/node_modules/`. The old
 * hardcoded-nested-path-only check does not exist there, so `bin/libi.js`
 * threw `MODULE_NOT_FOUND` before running a single line of the actual CLI —
 * found by actually installing + launching a packed tarball, not just
 * checking `npm install` exit codes (see .superpowers/sdd/task-5-report.md).
 * `tsx`'s own `exports` map blocks a direct `tsx/dist/cli.mjs` subpath
 * resolve (same class of restriction documented in lib/install/npm-root.ts
 * for npm's own package) — `tsx/cli` is the exports-map alias for that file.
 */
function resolveTsxScript() {
  try {
    return require.resolve("tsx/cli", { paths: [__dirname] });
  } catch {
    /* fall through to the historical hardcoded candidates below — keeps
     * working for any install layout real resolution doesn't cover. */
  }
  const nested = path.resolve(
    __dirname,
    "..",
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );
  if (fs.existsSync(nested)) return nested;
  // Fallback to the .bin wrapper if the dist entry doesn't exist (older tsx).
  return path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");
}
const TSX = resolveTsxScript();
const PKG_ROOT = path.resolve(__dirname, "..");
const ENTRY = path.resolve(PKG_ROOT, "lib", "cli", "index.ts");
/**
 * The compiled twin of ENTRY, produced by `scripts/build-cli.js`.
 *
 * An npm-INSTALLED libi cannot run from source at all: tsx applies the
 * tsconfig `paths` matcher only when the importing file's own path has no
 * `node_modules` segment (see `node_modules/tsx/dist/register-*.cjs`), and an
 * installed package is entirely under one — so every `@/…` import in
 * `lib/cli/index.ts`'s graph throws MODULE_NOT_FOUND before the CLI runs a
 * line. Running an extracted copy from OUTSIDE node_modules (which is how this
 * path was previously "verified") does not reproduce it, which is exactly how
 * the bug survived.
 */
const COMPILED_ENTRY = path.resolve(PKG_ROOT, "dist-cli", "lib", "cli", "index.js");

/**
 * True when this copy of libi lives under a `node_modules` directory — the
 * exact condition that disables tsx's alias resolution. Deliberately NOT
 * "does dist-cli exist": preferring compiled output whenever it happens to be
 * on disk would silently run a dev's stale build instead of their working
 * tree. Dev checkouts and the packaged Electron app
 * (`Contents/Resources/app/`) both fail this test and keep running from
 * source, unchanged.
 */
function installedUnderNodeModules() {
  return __dirname.split(path.sep).includes("node_modules");
}
// tsx resolves `@/*` path aliases (used throughout lib/ and mcp/) via
// tsconfig.json's `paths`, discovered by walking up from process.cwd() —
// NOT from ENTRY's own directory. A dev checkout chdirs to the checkout
// root first (below), so cwd == the directory holding tsconfig.json and
// auto-discovery just works. A real `npx @nagellabs/libi`/installed launch does NOT
// chdir (cwd is wherever the user ran the command from, almost never this
// package's own directory), so auto-discovery walks up the WRONG ancestor
// chain and never finds it — `@/lib/...` imports throw MODULE_NOT_FOUND
// before the CLI runs a single line. Passing `--tsconfig` explicitly (same
// pattern already used for the MCP child spawn in
// lib/mcp-config.ts#buildLibiEntry) makes this cwd-independent.
const TSCONFIG = path.resolve(__dirname, "..", "tsconfig.json");

/**
 * Walk up from __dirname looking for a `.git` dir/file. If absent we're
 * an installed npm package, not a dev checkout — skip the bootstrap.
 *
 * The walk STOPS AT THE PACKAGE ROOT (first ancestor with a `package.json`)
 * and never looks above it, so an ancestor's `.git` — the user's own project
 * around `node_modules/libi`, or a `~/.git` dotfiles repo around an extracted
 * runtime — can never make an installed package look like a dev checkout.
 * This decision gates the worktree bootstrap AND the Sentry/analytics
 * dev-vs-install flags below, and its twin in lib/dev/worktree-bootstrap.ts
 * additionally gates `next dev` vs the production server — getting it wrong
 * spawns `npx next dev` inside the consumer's project. Keep the two in sync.
 */
function inDevCheckout() {
  let dir = __dirname;
  // An installed dependency always sits under a `node_modules` path segment.
  if (dir.split(path.sep).includes("node_modules")) return false;
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return true;
    // Package root reached without a `.git` → an installed/extracted copy.
    if (fs.existsSync(path.join(dir, "package.json"))) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

async function runBootstrap(originalCwd) {
  if (!inDevCheckout()) return {};
  // Use tsx to import the TS module (avoids a build step for the dev path).
  // We invoke it inline via a tiny eval script piped through tsx.
  // Pass `originalCwd` so resolveWorktreeEnv detects the CALLER's worktree,
  // not the post-chdir script-checkout root.
  try {
    const BOOTSTRAP = path.resolve(
      __dirname,
      "..",
      "lib",
      "dev",
      "worktree-bootstrap.ts",
    );
    const json = execFileSync(
      NODE,
      [
        TSX,
        "--eval",
        `import { resolveWorktreeEnv } from ${JSON.stringify(BOOTSTRAP)}; resolveWorktreeEnv({ cwd: ${JSON.stringify(originalCwd)}, startPath: ${JSON.stringify(originalCwd)} }).then(r => process.stdout.write(JSON.stringify(r))).catch(() => process.stdout.write("{}"));`,
      ],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    return JSON.parse(json || "{}");
  } catch {
    return {};
  }
}

(async () => {
  // In a dev checkout, normalize cwd to THIS checkout's root before anything
  // else. The worktree bootstrap + `next dev` both key off process.cwd(), so
  // when a preview/launcher runs a worktree's bin/libi.js from the canonical
  // repo's cwd, they'd otherwise resolve the canonical checkout (serving main
  // on the default port) instead of the worktree this script belongs to.
  // __dirname is <checkout>/bin, so the checkout root is one level up.
  //
  // Capture the original cwd BEFORE we chdir, so runBootstrap can detect
  // which git worktree the caller was actually running from. The chdir is
  // only for next dev / tsx spawning; worktree-bootstrap uses the original.
  const originalCwd = process.cwd();
  if (inDevCheckout()) {
    try {
      process.chdir(path.resolve(__dirname, ".."));
    } catch {
      /* best-effort */
    }
  }
  const result = await runBootstrap(originalCwd);
  const env = { ...process.env };
  // The caller's true launch directory. We chdir to the checkout root above
  // (dev), so process.cwd() is wrong for "--connect-agent" (bare form =
  // "connect the directory I ran libi from"). The CLI + spawned server read
  // this instead.
  env.LIBI_LAUNCH_CWD = originalCwd;
  // Sentry: enable error/log tracking ONLY for genuine end-user installs, never
  // a developer's working clone. `inDevCheckout()` (the .git-presence signal
  // used above) is exactly that distinction — an installed `npx @nagellabs/libi` package
  // has no .git. The flag is read by lib/sentry/config.ts inside the Next
  // process. A contributor can still force it on by exporting the var first.
  if (env.NEXT_PUBLIC_LIBI_SENTRY === undefined) {
    env.NEXT_PUBLIC_LIBI_SENTRY = inDevCheckout() ? "0" : "1";
  }
  // Mirror the hard kill-switch under a NEXT_PUBLIC_ name so it actually
  // reaches the BROWSER bundle. Next.js only exposes NEXT_PUBLIC_*-prefixed
  // vars to client code, so `LIBI_SENTRY_DISABLED=1` alone shut off the server
  // while the renderer kept reporting (browser tracing, release-health
  // sessions, DOM-path INP spans). lib/sentry/config.ts honours either name.
  if (
    env.LIBI_SENTRY_DISABLED === "1" &&
    env.NEXT_PUBLIC_LIBI_SENTRY_DISABLED === undefined
  ) {
    env.NEXT_PUBLIC_LIBI_SENTRY_DISABLED = "1";
  }
  // Analytics: same policy as Sentry — ON only for genuine installs (no .git),
  // OFF in a dev checkout. A contributor can force it on (sandbox testing) by
  // exporting NEXT_PUBLIC_LIBI_ANALYTICS=1 before launch.
  if (env.NEXT_PUBLIC_LIBI_ANALYTICS === undefined) {
    env.NEXT_PUBLIC_LIBI_ANALYTICS = inDevCheckout() ? "0" : "1";
  }
  if (result.libiHome) env.LIBI_HOME = result.libiHome;
  if (typeof result.port === "number") env.LIBI_PORT = String(result.port);
  // Worktree name → server reads this via /api/runtime so the chat sidebar
  // can badge the brand. Only set when in a worktree (omitted for canonical).
  if (typeof result.worktreeName === "string" && result.worktreeName.length > 0) {
    env.LIBI_WORKTREE_NAME = result.worktreeName;
  }
  // Merge canonical-repo dotenv (`.env.local`, `.env`) without overwriting
  // anything the user already exported in their shell — shell wins, matching
  // the Next.js precedence model.
  if (result.envOverrides && typeof result.envOverrides === "object") {
    for (const [k, v] of Object.entries(result.envOverrides)) {
      if (env[k] === undefined && typeof v === "string") env[k] = v;
    }
  }

  if (result.logLine) {
    process.stderr.write(result.logLine + "\n");
  }

  const argv = process.argv.slice(2);
  // Only inject --port for the studio (no-subcommand or `studio` mode)
  // and only when the user didn't pass --port / -p explicitly.
  const isStudio =
    argv.length === 0 ||
    argv[0] === "studio" ||
    (argv[0]?.startsWith("-") &&
      !["serve-mcp", "update", "export"].includes(argv[0]));
  const hasPortFlag = argv.some((a) => a === "--port" || a === "-p");
  if (isStudio && !hasPortFlag && typeof result.port === "number") {
    argv.push("--port", String(result.port));
  }

  // Dual mode: source through tsx for a dev checkout / the packaged Electron
  // app; the compiled CommonJS entry for an npm install, where tsx cannot
  // resolve `@/…` at all. Missing compiled output is a HARD failure with an
  // actionable message — silently falling back to tsx there would produce a
  // MODULE_NOT_FOUND stack from deep inside libi with no hint of the cause.
  let launchArgs;
  if (installedUnderNodeModules()) {
    if (!fs.existsSync(COMPILED_ENTRY)) {
      process.stderr.write(
        "\n[libi] This install is missing its compiled CLI (" +
          COMPILED_ENTRY +
          ").\n" +
          "[libi] An installed libi cannot run from TypeScript source: tsx disables\n" +
          "[libi] tsconfig `paths` for anything under node_modules, so every @/ import fails.\n" +
          "[libi] Either this tarball was packed without `npm run build:cli` (please report it),\n" +
          "[libi] or this is a dev checkout sitting under a directory literally named\n" +
          "[libi] `node_modules` — move it outside node_modules, or run `npm run build:cli`\n" +
          "[libi] yourself and it will launch from dist-cli/ like a real install.\n\n",
      );
      process.exit(1);
    }
    launchArgs = [COMPILED_ENTRY, ...argv];
  } else {
    launchArgs = [TSX, "--tsconfig", TSCONFIG, ENTRY, ...argv];
  }

  try {
    execFileSync(NODE, launchArgs, {
      stdio: "inherit",
      env,
    });
  } catch (err) {
    if (err && typeof err === "object" && "status" in err) {
      process.exit(err.status);
    }
    process.exit(1);
  }
})();
