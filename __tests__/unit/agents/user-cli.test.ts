import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _resetMainWorktreeRootCache,
  classifyCliPath,
  findUserCli,
  libiTreeRoots,
  libiInstallRoots,
} from "@/lib/agents/user-cli";
import { packageRoot } from "@/lib/runtime/package-root";

const exec = (paths: string[]) => (p: string) => paths.includes(p);

/**
 * A REAL `<bundle>/node_modules/@nagellabs/libi` layout on disk. The ancestor
 * gate reads `<bundle>/package.json`, so unlike every other path in this file
 * these two cases cannot be made-up strings. Left in the OS temp dir; each
 * call gets its own.
 */
function bundleFixture(declaresLibi: boolean): { bundle: string; libiDir: string } {
  const bundle = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "libi-bundle-")));
  const libiDir = path.join(bundle, "node_modules", "@nagellabs", "libi");
  fs.mkdirSync(libiDir, { recursive: true });
  fs.writeFileSync(
    path.join(bundle, "package.json"),
    JSON.stringify({ name: "host", dependencies: declaresLibi ? { "@nagellabs/libi": "^0.1.0" } : {} }),
  );
  return { bundle, libiDir };
}

describe("classifyCliPath", () => {
  const ROOTS = ["/Users/dev/libi"];

  it("a path outside every root is the user's", () => {
    expect(classifyCliPath("/opt/homebrew/bin/codex", ROOTS)).toBe("user");
  });

  it("a path beneath a root, or the root itself, is libi's", () => {
    expect(classifyCliPath("/Users/dev/libi/node_modules/x/codex", ROOTS)).toBe("libi-internal");
    expect(classifyCliPath("/Users/dev/libi", ROOTS)).toBe("libi-internal");
  });

  it("a sibling directory sharing a prefix is NOT inside the root", () => {
    // `/Users/dev/libi-other` must not be swallowed by `/Users/dev/libi`.
    expect(classifyCliPath("/Users/dev/libi-other/bin/codex", ROOTS)).toBe("user");
    expect(classifyCliPath("/Users/dev/libi..x/codex", ROOTS)).toBe("user");
  });

  it("an empty root claims nothing (it would otherwise resolve against the cwd)", () => {
    expect(classifyCliPath(path.join(process.cwd(), "node_modules/.bin/codex"), [""])).toBe("user");
  });
});

describe("findUserCli", () => {
  it("returns the first executable outside libi's tree", () => {
    const r = findUserCli(["claude"], { searchDirs: ["/repo/node_modules/.bin", "/usr/local/bin"], isExecutable: exec(["/repo/node_modules/.bin/claude", "/usr/local/bin/claude"]), realpath: (p) => p, libiRoots: ["/repo"], platform: "darwin" });
    expect(r).toEqual({ kind: "user", path: "/usr/local/bin/claude" });
  });
  it("reports libi-internal when only an in-tree shim exists", () => {
    const r = findUserCli(["claude"], { searchDirs: ["/repo/node_modules/.bin"], isExecutable: exec(["/repo/node_modules/.bin/claude"]), realpath: (p) => p, libiRoots: ["/repo"], platform: "darwin" });
    expect(r).toEqual({ kind: "libi-internal", path: "/repo/node_modules/.bin/claude" });
  });
  it("judges the realpath target too", () => {
    const r = findUserCli(["claude"], { searchDirs: ["/usr/local/bin"], isExecutable: exec(["/usr/local/bin/claude"]), realpath: () => "/repo/node_modules/@anthropic-ai/claude-code/cli.js", libiRoots: ["/repo"], platform: "darwin" });
    expect(r.kind).toBe("libi-internal");
  });
  it("none when nothing is executable", () => {
    expect(findUserCli(["claude"], { searchDirs: ["/x"], isExecutable: () => false, realpath: (p) => p, libiRoots: [], platform: "darwin" })).toEqual({ kind: "none" });
  });
  it("skips duplicate and empty search dirs: each candidate is probed once, and never cwd-relative", () => {
    // A persisted PATH can hold the repo's node_modules/.bin TWICE (the
    // npm-script signature), and an empty entry must not turn into a bare
    // `codex` looked up against whatever the cwd happens to be.
    const shim = "/repo/node_modules/.bin/codex";
    const probed: string[] = [];
    const r = findUserCli(["codex"], {
      searchDirs: ["/repo/node_modules/.bin", "/repo/node_modules/.bin", "", "/repo/node_modules/.bin"],
      isExecutable: (p) => {
        probed.push(p);
        return p === shim;
      },
      realpath: (p) => p,
      libiRoots: ["/repo"],
      platform: "darwin",
    });
    expect(r).toEqual({ kind: "libi-internal", path: shim });
    expect(probed).toEqual([shim]);
  });
  it("findUserCli tries windows spellings on win32", () => {
    const r = findUserCli(["claude"], { searchDirs: ["C:\\bin"], isExecutable: (p) => p.endsWith("claude.cmd"), realpath: (p) => p, libiRoots: [], platform: "win32" });
    expect(r).toEqual({ kind: "user", path: "C:\\bin\\claude.cmd" });
  });

  describe("default isExecutable (real fs, no injected isExecutable/realpath)", () => {
    let dir: string;

    afterEach(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    // CI is ubuntu; posix X_OK semantics are identical to darwin's, and this
    // exercises the real fs.statSync/fs.accessSync path defaultIsExecutable
    // uses — the win32 branch (`isWindows()` short-circuit) is covered by the
    // "tries windows spellings on win32" case above, not here.
    it.skipIf(process.platform === "win32")("finds an executable file with real fs.accessSync", () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-cli-test-"));
      const exe = path.join(dir, "claude");
      fs.writeFileSync(exe, "#!/bin/sh\n");
      fs.chmodSync(exe, 0o755);

      const r = findUserCli(["claude"], { searchDirs: [dir], libiRoots: [], platform: "darwin" });
      expect(r).toEqual({ kind: "user", path: exe });
    });

    it.skipIf(process.platform === "win32")("rejects a non-executable file with real fs.accessSync", () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-cli-test-"));
      const notExe = path.join(dir, "noexec");
      fs.writeFileSync(notExe, "not a script\n");
      fs.chmodSync(notExe, 0o644);

      const r = findUserCli(["noexec"], { searchDirs: [dir], libiRoots: [], platform: "darwin" });
      expect(r).toEqual({ kind: "none" });
    });
  });

  describe("default libiRoots is anchored on libi's own package root, not cwd", () => {
    // `libi connect` runs from the user's folder, not libi's package root —
    // unlike every other run mode, which chdirs there first (`startStudio`).
    // Left on a cwd-only default, a candidate under libi's OWN package root
    // would misclassify as the user's own binary. Simulate that mismatch by
    // chdir-ing to an unrelated temp dir and NOT injecting `libiRoots`.
    it("classifies a candidate under libi's package root as libi-internal even when cwd is elsewhere", () => {
      const root = packageRoot(__dirname);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "user-cli-cwd-"));
      const originalCwd = process.cwd();
      try {
        process.chdir(tmp);
        const shim = path.join(root, "node_modules/.bin/codex");
        const r = findUserCli(["codex"], {
          searchDirs: [path.join(root, "node_modules/.bin")],
          isExecutable: exec([shim]),
          realpath: (p) => p,
          platform: "darwin",
        });
        expect(r).toEqual({ kind: "libi-internal", path: shim });
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  // The `node_modules` ancestor of libi's own package root is where npm HOISTS
  // libi's dependencies to — but only when libi is a dependency OF that tree.
  // Under `npm i -g @nagellabs/libi` the same shape appears
  // (`<prefix>/lib/node_modules/@nagellabs/libi`) without that relationship:
  // `<prefix>/lib` is npm's global root, holding every OTHER global package the
  // user installed, and claiming it as libi's turf makes the user's own
  // `<prefix>/bin/claude` read as `libi-internal` — `libi connect` then refuses
  // a perfectly good claude. So the hoisted parent counts only when its
  // `package.json` declares `@nagellabs/libi`.
  describe("hoisted parents count as libi's only when they declare libi", () => {
    let tmp: string;

    beforeEach(() => {
      tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "user-cli-layout-")));
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const write = (file: string, body: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    };

    it("a global install does not claim npm's global root — the user's own claude stays `user`", () => {
      // <prefix>/lib/node_modules/@nagellabs/libi, deps NESTED underneath it
      // (npm never hoists across global packages), and no package.json in
      // <prefix>/lib at all.
      const libiRoot = path.join(tmp, "prefix/lib/node_modules/@nagellabs/libi");
      write(path.join(libiRoot, "package.json"), JSON.stringify({ name: "@nagellabs/libi" }));
      const shim = path.join(tmp, "prefix/bin/claude");
      const real = path.join(tmp, "prefix/lib/node_modules/@anthropic-ai/claude-code/cli.js");

      const r = findUserCli(["claude"], {
        searchDirs: [path.join(tmp, "prefix/bin")],
        isExecutable: exec([shim]),
        realpath: (p) => (p === shim ? real : p),
        packageRootDir: libiRoot,
        platform: "darwin",
      });
      expect(r).toEqual({ kind: "user", path: shim });
    });

    it("a consumer project that declares libi DOES own the hoisted deps", () => {
      const libiRoot = path.join(tmp, "app/node_modules/@nagellabs/libi");
      write(path.join(libiRoot, "package.json"), JSON.stringify({ name: "@nagellabs/libi" }));
      write(
        path.join(tmp, "app/package.json"),
        JSON.stringify({ dependencies: { "@nagellabs/libi": "*" } }),
      );
      const shim = path.join(tmp, "app/node_modules/.bin/codex");
      const real = path.join(tmp, "app/node_modules/@openai/codex/bin/codex.js");

      const r = findUserCli(["codex"], {
        searchDirs: [path.join(tmp, "app/node_modules/.bin")],
        isExecutable: exec([shim]),
        realpath: (p) => (p === shim ? real : p),
        packageRootDir: libiRoot,
        platform: "darwin",
      });
      expect(r).toEqual({ kind: "libi-internal", path: shim });
    });

    it("the same layout WITHOUT the declaration reads as the user's own codex", () => {
      const libiRoot = path.join(tmp, "app/node_modules/@nagellabs/libi");
      write(path.join(libiRoot, "package.json"), JSON.stringify({ name: "@nagellabs/libi" }));
      write(path.join(tmp, "app/package.json"), JSON.stringify({ name: "app" }));
      const shim = path.join(tmp, "app/node_modules/.bin/codex");
      const real = path.join(tmp, "app/node_modules/@openai/codex/bin/codex.js");

      const r = findUserCli(["codex"], {
        searchDirs: [path.join(tmp, "app/node_modules/.bin")],
        isExecutable: exec([shim]),
        realpath: (p) => (p === shim ? real : p),
        packageRootDir: libiRoot,
        platform: "darwin",
      });
      expect(r).toEqual({ kind: "user", path: shim });
    });

    it("a dev checkout still owns everything under its own root", () => {
      const libiRoot = path.join(tmp, "repo");
      write(path.join(libiRoot, "package.json"), JSON.stringify({ name: "@nagellabs/libi" }));
      const shim = path.join(libiRoot, "node_modules/.bin/codex");
      const real = path.join(libiRoot, "node_modules/@openai/codex/bin/codex.js");

      const r = findUserCli(["codex"], {
        searchDirs: [path.join(libiRoot, "node_modules/.bin")],
        isExecutable: exec([shim]),
        realpath: (p) => (p === shim ? real : p),
        packageRootDir: libiRoot,
        platform: "darwin",
      });
      expect(r).toEqual({ kind: "libi-internal", path: shim });
    });
  });

  // The deleting callers' root set. `libiTreeRoots()`'s cwd walk always
  // includes the start dir, and under an installed `libi connect` that dir is
  // the USER's folder — see `libiInstallRoots`' own comment.
  describe("libiInstallRoots", () => {
    it("is the package-root half only — never process.cwd()", () => {
      const declaring = bundleFixture(true);
      const roots = libiInstallRoots(declaring.libiDir);
      expect(roots).toEqual(expect.arrayContaining([declaring.libiDir, declaring.bundle]));
      expect(roots).not.toContain(process.cwd());
      expect(libiTreeRoots()).toContain(process.cwd());
    });
    it("still gates node_modules ancestors on declaring libi", () => {
      const shared = bundleFixture(false);
      const roots = libiInstallRoots(shared.libiDir);
      expect(roots).toContain(shared.libiDir);
      expect(roots).not.toContain(shared.bundle);
    });
  });

  describe("libiTreeRoots", () => {
    it("no-arg default unions packageRoot(__dirname) with process.cwd()-derived roots", () => {
      const roots = libiTreeRoots();
      expect(roots).toContain(packageRoot(__dirname));
      expect(roots).toContain(process.cwd());
    });
    // An explicit startDir used to keep an UNGATED walk: every `node_modules`
    // ancestor became a root. That is the exact shape that made a global
    // install's `<prefix>/lib` — npm's shared global root, full of the USER's
    // other packages — read as libi's turf, so the gate has to apply here too.
    // The start dir itself is always a root, gated or not.
    it("an explicit startDir gates node_modules ancestors on declaring libi", () => {
      const declaring = bundleFixture(true);
      expect(libiTreeRoots(declaring.libiDir)).toEqual(
        expect.arrayContaining([declaring.libiDir, declaring.bundle]),
      );

      const shared = bundleFixture(false);
      const roots = libiTreeRoots(shared.libiDir);
      expect(roots).toContain(shared.libiDir);
      expect(roots).not.toContain(shared.bundle);
    });
  });

  /**
   * Feature work happens in `.claude/worktrees/<name>/`, and from there
   * the CANONICAL checkout's `node_modules/.bin/codex` sat outside every root:
   * libi's package root is the worktree, `<LIBI_HOME>` is somewhere else
   * again. So the codex probe answered "the user has their own codex" while
   * pointing at libi's own in-tree shim, one directory over — exactly the
   * misclassification `libiInstallRoots` was written to prevent.
   *
   * The fixture is the real on-disk shape: a linked worktree's `.git` is a
   * FILE holding `gitdir: <main>/.git/worktrees/<name>`.
   */
  describe("linked git worktrees", () => {
    let tmp: string;
    let main: string;
    let worktree: string;

    beforeEach(() => {
      _resetMainWorktreeRootCache();
      tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "libi-wt-")));
      main = path.join(tmp, "libi");
      worktree = path.join(main, ".claude", "worktrees", "feature");
      fs.mkdirSync(path.join(main, ".git", "worktrees", "feature"), { recursive: true });
      fs.mkdirSync(path.join(main, "node_modules", ".bin"), { recursive: true });
      fs.mkdirSync(worktree, { recursive: true });
      fs.writeFileSync(
        path.join(worktree, ".git"),
        `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`,
      );
    });

    afterEach(() => {
      _resetMainWorktreeRootCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("adds the main checkout's root when the start dir is inside a linked worktree", () => {
      expect(libiTreeRoots(worktree)).toContain(main);
    });

    it("classifies the canonical checkout's in-tree shim as libi's, not the user's", () => {
      const shim = path.join(main, "node_modules", ".bin", "codex");
      const r = findUserCli(["codex"], {
        searchDirs: [path.join(main, "node_modules", ".bin")],
        isExecutable: exec([shim]),
        realpath: (p) => p,
        libiRoots: libiTreeRoots(worktree),
        platform: "darwin",
      });
      expect(r).toEqual({ kind: "libi-internal", path: shim });
    });

    it("adds nothing for a normal checkout, where .git is a directory", () => {
      const plain = path.join(tmp, "plain");
      fs.mkdirSync(path.join(plain, ".git"), { recursive: true });
      // `<LIBI_HOME>` is always in the set; the assertion is about `main`.
      expect(libiTreeRoots(plain)).toContain(plain);
      expect(libiTreeRoots(plain)).not.toContain(main);
    });

    it("adds nothing when the .git file cannot be parsed", () => {
      const broken = path.join(tmp, "broken");
      fs.mkdirSync(broken, { recursive: true });
      fs.writeFileSync(path.join(broken, ".git"), "not a gitdir line\n");
      expect(libiTreeRoots(broken)).toContain(broken);
      expect(libiTreeRoots(broken)).not.toContain(main);
    });

    it("adds nothing for a gitdir that is not a worktree pointer", () => {
      const submodule = path.join(tmp, "submodule");
      fs.mkdirSync(submodule, { recursive: true });
      fs.writeFileSync(
        path.join(submodule, ".git"),
        `gitdir: ${path.join(main, ".git", "modules", "sub")}\n`,
      );
      expect(libiTreeRoots(submodule)).toContain(submodule);
      expect(libiTreeRoots(submodule)).not.toContain(main);
    });

    it("does NOT widen libiInstallRoots — that is what deletes on the answer", () => {
      // `cleanupLegacyConnectFiles` ate a user's own `.mcp.json` entry when a
      // delete-root was too wide. The worktree hop only ever widens the
      // CLASSIFIER's root set.
      expect(libiInstallRoots(worktree)).not.toContain(main);
    });
  });
});
