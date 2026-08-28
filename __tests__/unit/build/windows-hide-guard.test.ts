import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * Guard against the defect observed on the Azure QA box on 2026-08-23: opening
 * Claude Code or Codex for the first time popped a black Windows Terminal
 * window that never printed anything and stayed for the whole session.
 *
 * Cause: Electron's main process is a GUI-subsystem process with NO console.
 * When it spawns a console-subsystem child, Windows allocates a BRAND-NEW
 * console for that child, and Windows 11 hands the new console to Windows
 * Terminal — a visible window titled with the child's image path. Node's
 * `windowsHide` defaults to FALSE, so nothing suppressed it. The window was
 * empty because stdin/stdout are pipes and the `inherit`ed stderr had no
 * console in the parent to land in, and it was permanent because the ACP
 * adapter lives as long as the agent session.
 *
 * Measured on the box, spawning the same binary from a console-less parent
 * with today's exact options vs. the same plus `windowsHide: true`:
 *
 *   after spawning NOHIDE : 1 NEW visible window   (pid 7528 = WindowsTerminal.exe)
 *   after spawning HIDE   : 0 NEW visible windows
 *
 * This never reproduced on macOS (consoles are a Windows concept) nor under
 * `npx @nagellabs/libi` (the launching terminal already owns a console, which
 * children attach to), which is why it survived to a release. Every one of
 * these spawns is a window in the packaged Windows app — `runFfmpeg` alone
 * would flash one per export segment.
 *
 * A source-level assertion is the only thing that catches this: the suite runs
 * on macOS and Linux, where `windowsHide` is inert, so no behavioural test can
 * fail on its absence.
 */

/** The runtime Next compiles and Electron loads. `app/` spawns nothing. */
const ROOTS = ["lib", "mcp"];

/**
 * Spawns that provably cannot open a window on a user's Windows machine.
 * Every entry needs a reason — "it probably never runs" is not one.
 */
const ALLOWED = new Map([
  ["lib/claude/plan-usage.ts", "macOS `security` keychain tool; no Windows equivalent is invoked"],
  ["lib/system/available-memory.ts", "macOS `/usr/bin/vm_stat`"],
  ["lib/cli/studio.ts", "dev only (`npm run dev`) — launched from a terminal that owns a console"],
  ["lib/dev/worktree-bootstrap.ts", "dev-only tooling; never reaches a packaged app"],
]);

/** Strip comments so prose like "sanitise its env before spawn (…)" isn't a call. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n"'`]*?\/\/.*$/gm, "");
}

function sourceFiles(): string[] {
  const out = execSync(`git ls-files ${ROOTS.join(" ")}`, { encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".d.ts"))
    .filter((f) => !f.includes("__tests__"));
}

const CP_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g;

/**
 * Identifiers in `src` that spawn a process: whatever the file imported from
 * `child_process`, plus any `const x = promisify(execFile)` alias built on one.
 */
function spawnerNames(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(CP_IMPORT)) {
    names.push(
      ...m[1]
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/).pop()!)
        .filter(Boolean),
    );
  }
  for (const base of [...names]) {
    for (const m of src.matchAll(
      new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*promisify\\(\\s*${base}\\s*\\)`, "g"),
    )) {
      names.push(m[1]);
    }
  }
  return names;
}

function countCalls(src: string, names: string[]): number {
  let calls = 0;
  for (const name of names) {
    for (const m of src.matchAll(new RegExp(`(?<![\\w.$])${name}\\s*\\(`, "g"))) {
      // `promisify(execFile)` builds an alias, it does not spawn.
      if (/promisify\(\s*$/.test(src.slice(Math.max(0, m.index - 40), m.index))) continue;
      calls++;
    }
  }
  return calls;
}

describe("every child_process spawn in the runtime sets windowsHide", () => {
  const files = sourceFiles();

  it("finds source files to check (a broken glob must fail, not pass vacuously)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds the spawn sites it is meant to guard", () => {
    const spawning = files.filter((f) => {
      const src = stripComments(readFileSync(f, "utf8"));
      const names = spawnerNames(src);
      return names.length > 0 && countCalls(src, names) > 0;
    });
    // Sanity floor: if the import regex ever stops matching, this test would
    // otherwise report a clean sweep over zero files.
    expect(spawning.length).toBeGreaterThan(20);
  });

  it("no spawn site omits windowsHide", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOWED.has(f)) continue;
      const src = stripComments(readFileSync(f, "utf8"));
      const names = spawnerNames(src);
      if (names.length === 0) continue;
      const calls = countCalls(src, names);
      if (calls === 0) continue;
      const hides = (src.match(/windowsHide/g) ?? []).length;
      if (hides < calls) offenders.push(`${f} (${calls} spawn call(s), ${hides} windowsHide)`);
    }
    expect(
      offenders,
      "pass `windowsHide: true` — see this file's header — or add a reasoned entry to ALLOWED",
    ).toEqual([]);
  });

  it("every ALLOWED entry still exists and still spawns", () => {
    const stale: string[] = [];
    for (const f of ALLOWED.keys()) {
      if (!files.includes(f)) {
        stale.push(`${f} (no longer a source file)`);
        continue;
      }
      const src = stripComments(readFileSync(f, "utf8"));
      if (countCalls(src, spawnerNames(src)) === 0) stale.push(`${f} (no longer spawns)`);
    }
    expect(stale, "drop the stale exemption").toEqual([]);
  });
});
