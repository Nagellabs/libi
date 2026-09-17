import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `bin/libi.js` runs under the shell's own Node (`process.execPath`, captured
 * as `NODE` — already allowlisted in
 * `__tests__/unit/uv-env/install-path-invariants.test.ts`). In a DEV CHECKOUT
 * it forwards that path to the server process as `LIBI_LAUNCHER_NODE`, so the
 * dev branch of `lib/cli/studio.ts` can spawn `next dev` under the SAME node
 * `predev` (`scripts/ensure-native-modules.js`) just rebuilt `better-sqlite3`
 * for, instead of under the libi-managed node `resolveNodeCommand()` would
 * pick — which can be a different major (see `resolveDevServerNodeCommand` in
 * `lib/cli/studio.ts`).
 *
 * The assignment is gated by `inDevCheckout()`, matching the
 * `NEXT_PUBLIC_LIBI_SENTRY` / `NEXT_PUBLIC_LIBI_ANALYTICS` vars right next to
 * it in `bin/libi.js`: nothing downstream of a production install ever reads
 * `LIBI_LAUNCHER_NODE` (only the dev branch does), so setting it unconditionally
 * would only leak the end user's local machine path (home dir,
 * version-manager layout) into every agent/MCP/terminal child process for no
 * benefit.
 */
const BIN_PATH = path.resolve(__dirname, "..", "..", "..", "bin", "libi.js");
const TSX_PACKAGE = path.resolve(__dirname, "..", "..", "..", "node_modules", "tsx");

const tmpDirs: string[] = [];

/** An installed (non-dev-checkout) layout: nested under `node_modules`, no
 *  `.git` anywhere above it — `inDevCheckout()` is false at the very first
 *  check (the `node_modules` segment), before it ever looks for `.git`. */
function makeInstalledLibi(): { binPath: string; outFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-launcher-node-installed-"));
  tmpDirs.push(root);
  const pkg = path.join(root, "node_modules", "@nagellabs", "libi");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "dist-cli", "lib", "cli"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), "{}");
  fs.copyFileSync(BIN_PATH, path.join(pkg, "bin", "libi.js"));
  const outFile = path.join(root, "server-env-node.txt");
  fs.writeFileSync(
    path.join(pkg, "dist-cli", "lib", "cli", "index.js"),
    [
      `const fs = require("fs");`,
      `fs.writeFileSync(${JSON.stringify(outFile)}, process.env.LIBI_LAUNCHER_NODE || "");`,
      `process.exit(0);`,
    ].join("\n"),
  );
  return { binPath: path.join(pkg, "bin", "libi.js"), outFile };
}

/** A dev-checkout layout: a `.git` file at the root (outside `node_modules`),
 *  so `inDevCheckout()` walks up from `bin/` and finds it. This takes the
 *  same tsx-source branch a real dev checkout does — `lib/dev/worktree-bootstrap.ts`
 *  is deliberately left absent, so `runBootstrap()`'s inner tsx invocation
 *  fails fast on import resolution and falls back to `{}`, exactly as it does
 *  when the bootstrap module errors for any other reason. */
function makeDevCheckoutLibi(): { binPath: string; outFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-launcher-node-dev-"));
  tmpDirs.push(root);
  fs.writeFileSync(path.join(root, ".git"), "");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
  fs.mkdirSync(path.join(root, "bin"));
  fs.copyFileSync(BIN_PATH, path.join(root, "bin", "libi.js"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(TSX_PACKAGE, path.join(root, "node_modules", "tsx"), "dir");
  fs.mkdirSync(path.join(root, "lib", "cli"), { recursive: true });
  const outFile = path.join(root, "server-env-node.txt");
  fs.writeFileSync(
    path.join(root, "lib", "cli", "index.ts"),
    [
      `const fs = require("fs");`,
      `fs.writeFileSync(${JSON.stringify(outFile)}, process.env.LIBI_LAUNCHER_NODE || "");`,
      `process.exit(0);`,
    ].join("\n"),
  );
  return { binPath: path.join(root, "bin", "libi.js"), outFile };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("bin/libi.js forwards its own node as LIBI_LAUNCHER_NODE only in a dev checkout", () => {
  it("a production launch (not a dev checkout) does not put LIBI_LAUNCHER_NODE in the server env", async () => {
    const { binPath, outFile } = makeInstalledLibi();

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [binPath], { stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`fake server exited with code ${code}`));
      });
    });

    expect(fs.readFileSync(outFile, "utf-8")).toBe("");
  }, 15_000);

  // Symlinks a real tsx package, like `bin/libi.js through a real tsx wrapper`
  // in `__tests__/unit/bin/libi-ctrl-c.test.ts` — skipped on win32 for the
  // same reason that block is.
  it.skipIf(process.platform === "win32")(
    "a dev checkout passes process.execPath (the shell's node, already allowlisted as a spawn target in bin/libi.js) to the server env",
    async () => {
      const { binPath, outFile } = makeDevCheckoutLibi();

      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [binPath], { stdio: "ignore" });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`fake server exited with code ${code}`));
        });
      });

      expect(fs.readFileSync(outFile, "utf-8")).toBe(process.execPath);
    },
    20_000,
  );
});
