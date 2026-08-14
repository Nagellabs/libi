import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `bin/libi.js` carries its OWN copy of `inDevCheckout()` (it runs before
 * tsx, so it can't import the TS one in lib/dev/worktree-bootstrap.ts). That
 * copy decides whether the worktree bootstrap runs and whether Sentry +
 * analytics are switched on as a "real install" — and its twin decides
 * `next dev` vs the production server. A drift between the two is silent and
 * ships. This test extracts the real function text out of `bin/libi.js` and
 * exercises it directly, with `__dirname` injected, so both copies are held
 * to the same contract.
 */
const BIN_PATH = path.resolve(__dirname, "..", "..", "..", "bin", "libi.js");

function loadBinInDevCheckout(): (dirname: string) => boolean {
  const source = fs.readFileSync(BIN_PATH, "utf-8");
  const match = source.match(/\nfunction inDevCheckout\(\) \{[\s\S]*?\n\}\n/);
  if (!match) {
    throw new Error(`could not extract inDevCheckout() from ${BIN_PATH}`);
  }
  const factory = new Function(
    "fs",
    "path",
    "__dirname",
    `${match[0]}\nreturn inDevCheckout();`,
  ) as (fsMod: typeof fs, pathMod: typeof path, dirname: string) => boolean;
  return (dirname: string) => factory(fs, path, dirname);
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-bin-dev-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("bin/libi.js inDevCheckout()", () => {
  const inDevCheckout = loadBinInDevCheckout();

  it("true for the real repo checkout (bin/ inside a package root that has .git)", () => {
    expect(inDevCheckout(path.dirname(BIN_PATH))).toBe(true);
  });

  it("false when installed under the consumer's node_modules, even with a .git above it", () => {
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    const pkgBin = path.join(tmp, "node_modules", "libi", "bin");
    fs.mkdirSync(pkgBin, { recursive: true });
    fs.writeFileSync(path.join(tmp, "node_modules", "libi", "package.json"), "{}");

    expect(inDevCheckout(pkgBin)).toBe(false);
  });

  it("false for an extracted runtime outside node_modules under an unrelated git repo (e.g. ~/.git dotfiles)", () => {
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    const pkgBin = path.join(tmp, "runtime", "libi-0.1.0", "bin");
    fs.mkdirSync(pkgBin, { recursive: true });
    fs.writeFileSync(path.join(tmp, "runtime", "libi-0.1.0", "package.json"), "{}");

    expect(inDevCheckout(pkgBin)).toBe(false);
  });

  it("true for a linked git worktree (.git is a FILE at the package root)", () => {
    fs.writeFileSync(path.join(tmp, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    fs.writeFileSync(path.join(tmp, "package.json"), "{}");
    const pkgBin = path.join(tmp, "bin");
    fs.mkdirSync(pkgBin, { recursive: true });

    expect(inDevCheckout(pkgBin)).toBe(true);
  });
});
