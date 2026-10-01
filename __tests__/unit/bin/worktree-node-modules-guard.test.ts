import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * 0.1.16 suites report F1. A git worktree with no `node_modules` of its own
 * resolves every import from the CANONICAL checkout's `node_modules` (Node
 * walks up from `.claude/worktrees/<wt>/`), which was weeks stale: `/editor`
 * answered 500 with "Export Logging doesn't exist in target module"
 * (mediabunny 1.40 against 1.60 code). The dev boot now refuses there, and
 * warns — without refusing — when `node_modules` predates `package-lock.json`.
 */
const BIN = path.resolve(__dirname, "..", "..", "..", "bin", "libi.js");
const REFUSAL =
  "This worktree has no finished npm install of its own (node_modules/.package-lock.json " +
  "is missing) — run `npm ci` here first.";
const { worktreeNodeModulesCheck } = createRequire(import.meta.url)(BIN) as {
  worktreeNodeModulesCheck: (root: string) => { refuse?: string; warn?: string };
};

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-nm-guard-"));
  fs.writeFileSync(path.join(tmp, "package.json"), "{}");
  fs.writeFileSync(path.join(tmp, "package-lock.json"), "{}");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A linked worktree's root: `.git` is a FILE pointing into the main repo. */
function asLinkedWorktree(): void {
  fs.writeFileSync(path.join(tmp, ".git"), "gitdir: /somewhere/.git/worktrees/wt\n");
}
function withNodeModules(lockAgeSec: number): void {
  fs.mkdirSync(path.join(tmp, "node_modules"), { recursive: true });
  const hidden = path.join(tmp, "node_modules", ".package-lock.json");
  fs.writeFileSync(hidden, "{}");
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(tmp, "package-lock.json"), now, now);
  fs.utimesSync(hidden, now + lockAgeSec, now + lockAgeSec);
}

describe("worktreeNodeModulesCheck", () => {
  it("refuses a linked worktree with no node_modules", () => {
    asLinkedWorktree();
    expect(worktreeNodeModulesCheck(tmp)).toEqual({ refuse: REFUSAL });
  });

  it("refuses a linked worktree whose install never finished (node_modules but no .package-lock.json)", () => {
    asLinkedWorktree();
    fs.mkdirSync(path.join(tmp, "node_modules", "some-pkg"), { recursive: true });
    expect(worktreeNodeModulesCheck(tmp)).toEqual({ refuse: REFUSAL });
  });

  it("passes a linked worktree with its own, current node_modules", () => {
    asLinkedWorktree();
    withNodeModules(+60);
    expect(worktreeNodeModulesCheck(tmp)).toEqual({});
  });

  it("leaves the canonical checkout (a .git DIRECTORY) alone even with no node_modules", () => {
    fs.mkdirSync(path.join(tmp, ".git"));
    expect(worktreeNodeModulesCheck(tmp)).toEqual({});
  });

  it("warns, without refusing, when node_modules predates package-lock.json (canonical or worktree)", () => {
    fs.mkdirSync(path.join(tmp, ".git"));
    withNodeModules(-3600);
    const r = worktreeNodeModulesCheck(tmp);
    expect(r.refuse).toBeUndefined();
    expect(r.warn).toMatch(/older than package-lock\.json/);
    expect(r.warn).toMatch(/npm ci/);
  });
});

describe("bin/libi.js in a worktree without node_modules", () => {
  it("exits non-zero with the refusal before starting anything", () => {
    asLinkedWorktree();
    fs.mkdirSync(path.join(tmp, "bin"));
    fs.copyFileSync(BIN, path.join(tmp, "bin", "libi.js"));
    const r = spawnSync(process.execPath, [path.join(tmp, "bin", "libi.js")], {
      cwd: tmp,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, LIBI_HOME: path.join(tmp, "home"), LIBI_PORT: "3799" },
    });
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(r.stderr).toContain(REFUSAL);
    expect(fs.existsSync(path.join(tmp, "home"))).toBe(false);
  });
});
