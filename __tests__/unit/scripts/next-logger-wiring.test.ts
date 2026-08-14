import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression guard for `~/.libi/logs/server.log`.
//
// That file is where Next.js' OWN output goes — compile errors, request lines,
// runtime exceptions, `[browser]`-relayed React errors — and it is the first
// thing anyone reads when a packaged app 500s. It is produced by `next-logger`
// reading the pino factory in `next-logger.config.js`.
//
// It silently did not exist. Three of the four required pieces were in place —
// `next-logger` in `dependencies`, in `serverExternalPackages`, and a
// `next-logger.config.js` at the repo root — but NOTHING ever loaded
// `next-logger`, so no environment (dev, `npx`, packaged) ever wrote the file,
// while three skills and CLAUDE.md told readers to tail it. On top of that the
// config file was not in `package.json#files`, so it would not have shipped in
// the tarball even once something did load it.
//
// Each `it` below pins one of those pieces. Any one of them regressing puts the
// diagnostics hole straight back.

const ROOT = path.resolve(__dirname, "..", "..", "..");

function readPackageJson(): {
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
}

describe("server.log stays wired end to end", () => {
  it("the pino factory config exists at the package root, where lilconfig searches from", () => {
    // `next-logger` discovers its config by walking up from `process.cwd()`,
    // and every launch path chdirs to the package/checkout root first:
    // bin/libi.js (dev), lib/cli/studio.ts#projectRoot (npx install), and
    // electron/main.ts (packaged, to the runtime root).
    expect(fs.existsSync(path.join(ROOT, "next-logger.config.js"))).toBe(true);
  });

  it("ships next-logger.config.js in the npm tarball allowlist", () => {
    const files = readPackageJson().files ?? [];
    expect(
      files.includes("next-logger.config.js"),
      "package.json#files has no `next-logger.config.js` entry. `files` is an ALLOWLIST and root-level " +
        "files are not implied by the directory globs, so an installed copy would fall back to " +
        "next-logger's default pino config (stdout only) and never create server.log.",
    ).toBe(true);
  });

  it("keeps next-logger a production dependency", () => {
    const pkg = readPackageJson();
    expect(
      pkg.dependencies?.["next-logger"],
      "next-logger must stay in `dependencies` — an installed copy has no devDependencies, " +
        "so instrumentation.ts's import would throw and server.log would never be written.",
    ).toBeTruthy();
    expect(pkg.devDependencies?.["next-logger"]).toBeUndefined();
  });

  it("startNextServer loads next-logger BEFORE Next is constructed", () => {
    // Measured on a real packaged boot: with `instrumentation.ts#register()` as
    // the only loader, server.log shipped 0 BYTES. Next calls `register()` from
    // inside its own startup, so the framework's configuration/workspace
    // diagnostics are already on stdout by then — and in a packaged app there
    // is no terminal to read stdout from, which is the entire point of the
    // file. Loading it here first took the same boot from 0 to 452 bytes with
    // the warning captured.
    const source = fs.readFileSync(path.join(ROOT, "lib", "server", "next-server.ts"), "utf-8");
    expect(
      source,
      "lib/server/next-server.ts no longer imports next-logger. register() alone is too late — " +
        "Next's own init warnings are emitted before it runs, so server.log comes out empty in a " +
        "packaged app. This is the load site that makes the file useful.",
    ).toMatch(/import\(\s*["']next-logger["']\s*\)/);

    const loggerAt = source.search(/import\(\s*["']next-logger["']\s*\)/);
    const nextAt = source.search(/\bnext\(\s*\{/);
    expect(
      nextAt === -1 || loggerAt < nextAt,
      "the next-logger import must come BEFORE the next({...}) call in startNextServer — " +
        "after it, the framework's startup diagnostics are already gone.",
    ).toBe(true);
  });

  it("instrumentation.ts also LOADS next-logger inside the nodejs-runtime guard", () => {
    // Kept alongside the startNextServer load site (Node caches the module, so
    // the second import is a no-op): this is Next's documented hook and covers
    // entry shapes that do not go through startNextServer.
    const source = fs.readFileSync(path.join(ROOT, "instrumentation.ts"), "utf-8");
    expect(
      source,
      "instrumentation.ts no longer imports next-logger. Declaring it in dependencies and " +
        "serverExternalPackages does nothing on its own — an import is the ONLY activation path, " +
        'and without one server.log is never created in ANY environment.',
    ).toMatch(/import\(\s*["']next-logger["']\s*\)/);
    expect(
      source,
      "the next-logger import must stay behind a NEXT_RUNTIME === \"nodejs\" guard — the Edge " +
        "bundler walks string-literal dynamic imports too.",
    ).toMatch(/NEXT_RUNTIME\s*===\s*["']nodejs["']/);
  });

  it("keeps next-logger external so its config's `require(\"pino\")` resolves natively", () => {
    // pino's transport spawns a worker that loads pino-pretty BY NAME. Turbopack
    // rewrites a bundled `require("pino")` to a content-hashed alias, which the
    // worker then cannot resolve (the reason lib/logger.ts avoids transports
    // entirely). next-logger.config.js gets away with a transport only because
    // it is loaded outside the bundle.
    const nextConfig = fs.readFileSync(path.join(ROOT, "next.config.ts"), "utf-8");
    for (const pkg of ["next-logger", "pino", "pino-pretty"]) {
      expect(nextConfig, `${pkg} dropped out of serverExternalPackages`).toMatch(
        new RegExp(`["']${pkg}["']`),
      );
    }
  });

  it("actually writes <LIBI_HOME>/logs/server.log when next-logger is loaded", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-next-logger-"));
    try {
      execFileSync(
        process.execPath,
        [
          "-e",
          [
            "require('next-logger');",
            "console.log('framework line');",
            "console.error('[browser] Uncaught Error: boom');",
            "setTimeout(() => process.exit(0), 500);",
          ].join(""),
        ],
        {
          // cwd is what lilconfig searches from — the same invariant every
          // launch path establishes by chdir'ing to the package root.
          cwd: ROOT,
          env: { ...process.env, LIBI_HOME: home },
          stdio: "ignore",
        },
      );

      const logPath = path.join(home, "logs", "server.log");
      expect(fs.existsSync(logPath), `${logPath} was not created`).toBe(true);
      const contents = fs.readFileSync(logPath, "utf-8");
      expect(contents).toContain("framework line");
      expect(contents).toContain("[browser] Uncaught Error: boom");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
