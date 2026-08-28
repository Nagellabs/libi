import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * Guard against the defect that shipped in 0.1.4: Turbopack constant-folds
 * `process.platform === "<literal>"` at BUILD time against the build machine
 * and deletes the losing branch. libi publishes from macOS, so the shipped
 * Next server bundle contained, verbatim:
 *
 *   getBinaryPath(e){return i.default.join((0,d.getLibiBinDir)(),e)}
 *   let{shell:t,args:i}={shell:process.env.SHELL||"/bin/zsh",args:["-l"]}
 *   (process.platform,(0,w.spawn)("open",["-R",e],{...}).unref())
 *
 * On Windows: no bundled MCP ever probed UP (the server looked for `bin/uv`
 * while Category A had written `bin/uv.exe`), the terminal panel tried to
 * spawn /bin/zsh, and "reveal in folder" ran `open -R`.
 *
 * THIS TEST IS THE ONLY THING THAT CAN CATCH IT. The defect exists solely in
 * bundled output; the suite runs against source, and every behavioural test
 * passes on a build that is broken for every non-macOS user. So the guard is
 * necessarily a source-level assertion.
 *
 * What is BANNED (foldable):
 *   - `process.platform === "win32"` and every rearrangement of it
 *   - `const p = process.platform` followed by `p === "..."` in the same file —
 *     the bundler folds straight through the alias, which is how the reveal
 *     route lost two of its three branches.
 *
 * What is FINE (verified against a real build, do not "tidy" these away):
 *   - `process.platform` as an argument or default parameter, compared later
 *     as a variable: `function f(p = process.platform)` survived intact, and
 *     so did `"win32" === p` inside it. The bundler cannot see through a
 *     parameter. Those are the codebase's testability seams.
 *   - `switch (process.platform)` — left alone by the bundler.
 *
 * Use `isWindows()` / `isMac()` / `isLinux()` / `exeSuffix()` from
 * `lib/platform.ts` instead.
 */

/** Files the Next build compiles. `scripts/`, `bin/` and `electron/` are not. */
const ROOTS = ["lib", "mcp", "app"];

/** `lib/platform.ts` owns the one legitimate `os.platform()` call. */
const ALLOWED = new Set(["lib/platform.ts"]);

function sourceFiles(): string[] {
  // Extension filtering happens HERE, not in the pathspec: git ORs pathspecs,
  // so `git ls-files lib mcp app '*.ts'` returns every .ts in the repo —
  // electron/ included — and the guard would fail on files Next never touches.
  const out = execSync(`git ls-files ${ROOTS.join(" ")}`, { encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .filter((f) => !f.includes("__tests__"))
    .filter((f) => !ALLOWED.has(f));
}

const DIRECT =
  /process\s*\.\s*platform\s*[!=]==\s*["']|["'](?:win32|darwin|linux|aix|freebsd|openbsd|sunos|android|haiku|cygwin|netbsd)["']\s*[!=]==\s*process\s*\.\s*platform/;

describe("no build-time-foldable platform checks in Next-compiled code", () => {
  const files = sourceFiles();

  it("finds source files to check (a broken glob must fail, not pass vacuously)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no direct `process.platform === \"...\"` comparison", () => {
    const offenders = files.filter((f) =>
      DIRECT.test(readFileSync(f, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "")),
    );
    expect(
      offenders,
      "use isWindows()/isMac()/isLinux() from lib/platform.ts — see this file's header",
    ).toEqual([]);
  });

  it("no same-scope alias of process.platform that is then compared", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
      // `const x = process.platform` — NOT `= probe.platform ?? process.platform`
      // and NOT a default parameter, both of which the bundler cannot fold.
      const alias = src.match(
        /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*process\s*\.\s*platform\s*;/g,
      );
      if (!alias) continue;
      for (const decl of alias) {
        const name = decl.match(
          /(?:const|let)\s+([A-Za-z_$][\w$]*)/,
        )?.[1];
        if (!name) continue;
        if (new RegExp(`\\b${name}\\s*[!=]==\\s*["']`).test(src)) {
          offenders.push(`${f} (alias \`${name}\`)`);
        }
      }
    }
    expect(
      offenders,
      "the bundler folds through a local alias — compare with lib/platform.ts helpers instead",
    ).toEqual([]);
  });
});
