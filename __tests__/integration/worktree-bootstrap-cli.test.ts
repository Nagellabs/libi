import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync, spawnSync } from "child_process";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIBI_JS = path.join(REPO_ROOT, "bin", "libi.js");
// Use the real Node.js binary that is already running us. This avoids
// issues with version-manager shims (proto, nvm, etc.) that read $HOME
// for their config — those shims break when $HOME is overridden to a
// temporary directory. process.execPath IS the binary the shim would
// delegate to, so the semantics are identical.
const NODE = process.execPath;

let tmp: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-wb-cli-"));
  originalHome = process.env.HOME;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function initRepo(dir: string): void {
  execSync("git init -q -b main", { cwd: dir });
  execSync(
    "git config user.email t@t && git config user.name t",
    { cwd: dir },
  );
  fs.writeFileSync(path.join(dir, "README"), "x");
  execSync("git add . && git commit -qm init", { cwd: dir });
}

describe("worktree-bootstrap CLI banner", () => {
  it("prints the dev banner when run from a linked worktree", () => {
    const wt = path.join(tmp, "wt");
    execSync(`git worktree add -q "${wt}" -B libi-bootstrap-cli-test`, {
      cwd: REPO_ROOT,
    });
    try {
      const fakeHome = path.join(tmp, "home");
      fs.mkdirSync(path.join(fakeHome, ".libi"), { recursive: true });
      const cleanEnv = { ...process.env, HOME: fakeHome };
      delete cleanEnv.LIBI_HOME;
      delete cleanEnv.LIBI_PORT;
      // Use spawnSync with the real Node.js binary (process.execPath) to
      // avoid version-manager shims (proto, nvm, etc.) that read $HOME.
      // spawnSync captures stdout and stderr separately, letting us check
      // both the banner (stderr) and the version string (stdout).
      const result = spawnSync(NODE, [LIBI_JS, "--version"], {
        cwd: wt,
        env: cleanEnv,
        encoding: "utf-8",
        timeout: 55_000,
      });
      if (result.error) throw result.error;
      const combined = (result.stderr ?? "") + (result.stdout ?? "");
      expect(combined).toMatch(/\[libi\/dev] worktree=wt /);
      expect(combined).toMatch(/port=\d+/);
      expect(combined).toMatch(/home=\/[^ ]+\/worktrees\/wt /);
      expect(combined).not.toMatch(/home=\(env override\)/);
    } finally {
      execSync(`git worktree remove --force "${wt}"`, { cwd: REPO_ROOT });
      execSync(`git branch -D libi-bootstrap-cli-test`, {
        cwd: REPO_ROOT,
      }).toString();
    }
  }, 60_000);
});
