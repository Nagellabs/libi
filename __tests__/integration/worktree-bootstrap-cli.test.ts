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

/** The repo's own launch config + its index flags, for the isolation assertion. */
function realLaunchState(): { body: string | null; flag: string } {
  const file = path.join(REPO_ROOT, ".claude", "launch.json");
  let body: string | null = null;
  try {
    body = fs.readFileSync(file, "utf-8");
  } catch {
    body = null;
  }
  const flag = spawnSync("git", ["ls-files", "-v", "--", ".claude/launch.json"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  }).stdout.trim();
  return { body, flag };
}

describe("worktree-bootstrap CLI banner", () => {
  it("prints the dev banner when run from a linked worktree", () => {
    // The worktree is cut from a THROWAWAY repo, never from this one.
    //
    // Booting libi inside a worktree makes `registerCanonicalLaunchConfigs`
    // write `Libi (<key>)` entries — carrying absolute machine paths — into the
    // CANONICAL repo's `.claude/launch.json`, and mark the file
    // `--skip-worktree` so the edit stays out of `git status`. That is correct
    // behaviour for real dev use and completely wrong to aim at this checkout:
    // for as long as this test cut its worktree from REPO_ROOT, every `npm test`
    // silently rewrote a TRACKED file with paths like
    // `/private/var/folders/.../T/libi-wb-cli-xxxx/wt/bin/libi.js`, invisible to
    // `git status`, one `git add -A` away from being committed — and, the repo
    // now being public, published. It also left a `libi-bootstrap-cli-test`
    // branch behind whenever a run was interrupted.
    //
    // Pointing the worktree at a throwaway repo makes canonical resolve there
    // instead. The banner is a fact about the worktree, so the assertions are
    // unchanged; the blast radius is a temp directory.
    const canonical = path.join(tmp, "canonical");
    fs.mkdirSync(canonical, { recursive: true });
    initRepo(canonical);
    const before = realLaunchState();

    const wt = path.join(tmp, "wt");
    execSync(`git worktree add -q "${wt}" -B libi-bootstrap-cli-test`, {
      cwd: canonical,
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

      // The isolation guard. Booting libi in a worktree registers launch
      // configs in the canonical repo — assert that landed in the throwaway,
      // and that THIS repo's tracked file and its index flags never moved.
      const after = realLaunchState();
      expect(after.body, "npm test rewrote this repo's .claude/launch.json").toBe(before.body);
      expect(after.flag, "npm test changed the index flags on .claude/launch.json").toBe(
        before.flag,
      );
    } finally {
      execSync(`git worktree remove --force "${wt}"`, { cwd: canonical });
    }
  }, 60_000);
});
