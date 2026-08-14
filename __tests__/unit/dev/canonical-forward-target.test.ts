import { describe, it, expect, vi } from "vitest";
import path from "path";
import { resolveCanonicalForwardTarget } from "@/lib/dev/worktree-bootstrap";

const CANON = "/repo/libi";

function wtElectronEntry(key: string, wtPath: string) {
  return {
    name: `Libi Electron (${key})`,
    runtimeExecutable: "node",
    runtimeArgs: [path.join(wtPath, "scripts", "dev-electron.js")],
    port: 9234,
    libiWorktree: key,
  };
}

function wtLibiEntry(key: string, wtPath: string) {
  // The bin/libi.js (non-Electron) companion config — must be IGNORED.
  return {
    name: `Libi (${key})`,
    runtimeExecutable: "node",
    runtimeArgs: [path.join(wtPath, "bin", "libi.js")],
    port: 3468,
    libiWorktree: key,
  };
}

const plainEntry = {
  name: "Libi Electron",
  runtimeExecutable: "node",
  runtimeArgs: ["scripts/dev-electron.js"],
  port: 9222,
};

describe("resolveCanonicalForwardTarget", () => {
  const allExist = () => true;

  it("returns null when there are no worktree configs", () => {
    const deps = { readLaunchJson: () => ({ configurations: [plainEntry] }), exists: allExist };
    expect(resolveCanonicalForwardTarget(CANON, deps)).toBeNull();
  });

  it("forwards to the single live worktree's dev-electron.js", () => {
    const wt = "/repo/libi/.worktrees/feat";
    const deps = {
      readLaunchJson: () => ({
        configurations: [plainEntry, wtLibiEntry("feat", wt), wtElectronEntry("feat", wt)],
      }),
      exists: allExist,
    };
    const t = resolveCanonicalForwardTarget(CANON, deps);
    expect(t).toEqual({ key: "feat", scriptPath: path.join(wt, "scripts", "dev-electron.js") });
  });

  it("ignores the bin/libi.js companion config (only the Electron one forwards)", () => {
    const wt = "/repo/libi/.worktrees/feat";
    const deps = {
      readLaunchJson: () => ({ configurations: [wtLibiEntry("feat", wt)] }),
      exists: allExist,
    };
    expect(resolveCanonicalForwardTarget(CANON, deps)).toBeNull();
  });

  it("skips a pruned worktree whose script no longer exists", () => {
    const wt = "/repo/libi/.worktrees/gone";
    const script = path.join(wt, "scripts", "dev-electron.js");
    const deps = {
      readLaunchJson: () => ({ configurations: [wtElectronEntry("gone", wt)] }),
      exists: (p: string) => p !== script,
    };
    expect(resolveCanonicalForwardTarget(CANON, deps)).toBeNull();
  });

  it("does NOT forward with 2+ live worktrees; warns with the names", () => {
    const wtA = "/repo/libi/.worktrees/a";
    const wtB = "/repo/libi/.worktrees/b";
    const warn = vi.fn();
    const deps = {
      readLaunchJson: () => ({
        configurations: [wtElectronEntry("a", wtA), wtElectronEntry("b", wtB)],
      }),
      exists: allExist,
      warn,
    };
    expect(resolveCanonicalForwardTarget(CANON, deps)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"Libi Electron (a)"');
    expect(warn.mock.calls[0][0]).toContain('"Libi Electron (b)"');
  });

  it("never forwards to the canonical checkout itself", () => {
    // A degenerate entry whose worktree path resolves back to CANON.
    const selfEntry = {
      name: "Libi Electron (self)",
      runtimeArgs: [path.join(CANON, "scripts", "dev-electron.js")],
      libiWorktree: "self",
    };
    const deps = { readLaunchJson: () => ({ configurations: [selfEntry] }), exists: allExist };
    expect(resolveCanonicalForwardTarget(CANON, deps)).toBeNull();
  });

  it("returns null on a missing/malformed launch.json", () => {
    expect(
      resolveCanonicalForwardTarget(CANON, { readLaunchJson: () => null, exists: allExist }),
    ).toBeNull();
    expect(
      resolveCanonicalForwardTarget(CANON, { readLaunchJson: () => ({}), exists: allExist }),
    ).toBeNull();
  });
});
