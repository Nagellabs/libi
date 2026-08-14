import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  userCodexCli,
  classifyCodexPath,
  libiTreeRoots,
} from "@/lib/codex-config/codex-cli";

/**
 * `userCodexCli()` answers "does the PERSON using this computer have codex",
 * NOT "can this server process spawn something called codex".
 *
 * The distinction was measured, not theorised: `execSync("which codex")`
 * inherits the Next.js server's PATH, and under `npm run dev` npm prepends
 * `<repo>/node_modules/.bin`, which since the codex-acp migration contains
 * `codex -> ../@openai/codex/bin/codex.js`. On a machine whose owner has NO
 * codex, the old probe returned true, Install lit up, `codex mcp add` ran, and
 * `~/.codex/config.toml` was really written — for a codex only libi can run.
 *
 * Every test injects the world (search dirs, executable check, realpath, libi
 * roots), so no real shell and no real filesystem is touched.
 */

const REPO = "/Users/dev/libi";
const LIBI_ROOTS = [REPO, "/Users/dev/.libi"];

/** An `isExecutable` that says yes to exactly the paths in `present`. */
function present(...paths: string[]): (candidate: string) => boolean {
  const set = new Set(paths);
  return (candidate) => set.has(candidate);
}

/** A `realpath` driven by an explicit symlink map; identity otherwise. */
function links(map: Record<string, string> = {}): (candidate: string) => string {
  return (candidate) => map[candidate] ?? candidate;
}

describe("userCodexCli — classification", () => {
  it("classifies a genuine external codex as 'user'", () => {
    const bin = "/opt/homebrew/bin/codex";
    const res = userCodexCli({
      searchDirs: ["/opt/homebrew/bin", "/usr/bin"],
      isExecutable: present(bin),
      realpath: links(),
      libiRoots: LIBI_ROOTS,
    });
    expect(res).toEqual({ kind: "user", path: bin });
  });

  it("classifies libi's own node_modules/.bin/codex as 'libi-internal'", () => {
    const shim = path.join(REPO, "node_modules/.bin/codex");
    const res = userCodexCli({
      // npm puts `<repo>/node_modules/.bin` FIRST on the dev server's PATH.
      searchDirs: [path.join(REPO, "node_modules/.bin"), "/usr/bin"],
      isExecutable: present(shim),
      realpath: links({ [shim]: path.join(REPO, "node_modules/@openai/codex/bin/codex.js") }),
      libiRoots: LIBI_ROOTS,
    });
    expect(res).toEqual({ kind: "libi-internal", path: shim });
  });

  it("classifies the PACKAGED runtime bundle's codex as 'libi-internal'", () => {
    // Packaged layout: cwd is `…/libi-bundle/node_modules/@nagellabs/libi`, and
    // the dependencies (including the codex shim) hoist to the ANCESTOR
    // `…/libi-bundle/node_modules`.
    const bundle = "/Applications/Libi.app/Contents/Resources/libi-bundle";
    const cwd = path.join(bundle, "node_modules/@nagellabs/libi");
    const shim = path.join(bundle, "node_modules/.bin/codex");
    const res = userCodexCli({
      searchDirs: [path.join(bundle, "node_modules/.bin")],
      isExecutable: present(shim),
      realpath: links({ [shim]: path.join(bundle, "node_modules/@openai/codex/bin/codex.js") }),
      libiRoots: libiTreeRoots(cwd),
    });
    expect(res).toEqual({ kind: "libi-internal", path: shim });
  });

  it("catches a symlink that POINTS INTO libi's tree from outside it", () => {
    // The dangerous shape: the name on PATH looks external, the bytes are ours.
    const outside = "/usr/local/bin/codex";
    const res = userCodexCli({
      searchDirs: ["/usr/local/bin"],
      isExecutable: present(outside),
      realpath: links({ [outside]: path.join(REPO, "node_modules/@openai/codex/bin/codex.js") }),
      libiRoots: LIBI_ROOTS,
    });
    expect(res).toEqual({ kind: "libi-internal", path: outside });
  });

  it("treats a codex under LIBI_HOME's own npm root as 'libi-internal'", () => {
    const inHome = "/Users/dev/.libi/node_modules/.bin/codex";
    const res = userCodexCli({
      searchDirs: ["/Users/dev/.libi/node_modules/.bin"],
      isExecutable: present(inHome),
      realpath: links(),
      libiRoots: LIBI_ROOTS,
    });
    expect(res.kind).toBe("libi-internal");
  });

  it("returns 'none' when nothing is found", () => {
    const res = userCodexCli({
      searchDirs: ["/opt/homebrew/bin", "/usr/bin"],
      isExecutable: present(),
      realpath: links(),
      libiRoots: LIBI_ROOTS,
    });
    expect(res).toEqual({ kind: "none" });
  });
});

describe("userCodexCli — precedence", () => {
  it("prefers a real user codex even when libi's shim comes FIRST on PATH", () => {
    // Exactly the `npm run dev` layout on a machine that DOES have codex:
    // npm's `node_modules/.bin` prefix shadows /opt/homebrew/bin.
    const shim = path.join(REPO, "node_modules/.bin/codex");
    const real = "/opt/homebrew/bin/codex";
    const res = userCodexCli({
      searchDirs: [path.join(REPO, "node_modules/.bin"), "/opt/homebrew/bin"],
      isExecutable: present(shim, real),
      realpath: links({ [shim]: path.join(REPO, "node_modules/@openai/codex/bin/codex.js") }),
      libiRoots: LIBI_ROOTS,
    });
    expect(res).toEqual({ kind: "user", path: real });
  });

  it("reports the FIRST in-tree hit when there is no user codex at all", () => {
    const shim = path.join(REPO, "node_modules/.bin/codex");
    const other = "/Users/dev/.libi/node_modules/.bin/codex";
    const res = userCodexCli({
      searchDirs: [path.join(REPO, "node_modules/.bin"), "/Users/dev/.libi/node_modules/.bin"],
      isExecutable: present(shim, other),
      realpath: links(),
      libiRoots: LIBI_ROOTS,
    });
    expect(res).toEqual({ kind: "libi-internal", path: shim });
  });

  it("skips duplicate PATH entries without changing the answer", () => {
    // The reported machine's persisted PATH contained the repo's
    // node_modules/.bin TWICE — the npm-script signature.
    const shim = path.join(REPO, "node_modules/.bin/codex");
    const dir = path.join(REPO, "node_modules/.bin");
    const res = userCodexCli({
      searchDirs: [dir, dir, "", dir],
      isExecutable: present(shim),
      realpath: links(),
      libiRoots: LIBI_ROOTS,
    });
    expect(res).toEqual({ kind: "libi-internal", path: shim });
  });
});

describe("userCodexCli — best effort, never throws", () => {
  it("survives an isExecutable/realpath that throws", () => {
    const good = "/opt/homebrew/bin/codex";
    const res = userCodexCli({
      searchDirs: ["/opt/homebrew/bin"],
      isExecutable: (c) => {
        if (c.startsWith("/broken")) throw new Error("EACCES");
        return c === good;
      },
      realpath: links(),
      libiRoots: LIBI_ROOTS,
    });
    expect(res.kind).toBe("user");
  });
});

describe("classifyCodexPath / libiTreeRoots", () => {
  it("a path outside every root is the user's", () => {
    expect(classifyCodexPath("/opt/homebrew/bin/codex", LIBI_ROOTS)).toBe("user");
  });

  it("a path beneath a root is libi's", () => {
    expect(classifyCodexPath(path.join(REPO, "node_modules/x/codex"), LIBI_ROOTS)).toBe(
      "libi-internal",
    );
  });

  it("a sibling directory sharing a prefix is NOT inside the root", () => {
    // `/Users/dev/libi-other` must not be swallowed by `/Users/dev/libi`.
    expect(classifyCodexPath("/Users/dev/libi-other/bin/codex", LIBI_ROOTS)).toBe("user");
  });

  it("libiTreeRoots walks node_modules ancestors up to the tree root", () => {
    const cwd = "/x/libi-bundle/node_modules/@nagellabs/libi";
    expect(libiTreeRoots(cwd)).toEqual(
      expect.arrayContaining([cwd, "/x/libi-bundle"]),
    );
  });
});
