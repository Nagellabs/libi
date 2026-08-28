// Windows must build the externals farm with JUNCTIONS, not "dir" symlinks.
//
// A `"dir"` symlink on Windows needs SeCreateSymbolicLinkPrivilege, which an
// ordinary account does not hold and which UAC strips from an administrator's
// token unless Developer Mode is on. NSIS stores no reparse points, so unlike
// the signed `.app` — where the farm survives packaging and boot only verifies
// it — a Windows install arrives with no farm and MUST build one at first boot.
// In v0.1.8 that made libi fail to start for a normal Windows user: the shell
// logged "about to startNextServer" and then died, splash screen and all, with
// nothing in any log. It passed QA only because the QA box runs an elevated
// administrator. A junction is the unprivileged equivalent for a directory
// target; verified side by side on that box under a trustlevel-0x20000 token.
//
// The platform is pinned INSIDE each test rather than inherited from the host
// (see AGENTS.md → Testing): this file has to assert Windows behaviour while
// running on the ubuntu-only CI. `symlinkSync`'s type argument is ignored off
// Windows, so the spy can pass straight through to the real call and the farm
// it builds is still checked for correctness afterwards.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs, { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";

import { ensureNextExternalSymlinks } from "@/lib/install/next-externals";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const BUILD_ID = "win-farm-build-id";

/** A root holding `node_modules/pino` and a `.next` whose manifest asks for it. */
function makeRoot(): { nextDir: string; pkgDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "next-externals-win-"));
  dirs.push(root);
  const pkgDir = path.join(root, "node_modules", "pino");
  mkdirSync(pkgDir, { recursive: true });
  const nextDir = path.join(root, ".next");
  mkdirSync(nextDir, { recursive: true });
  writeFileSync(path.join(nextDir, "BUILD_ID"), `${BUILD_ID}\n`);
  writeFileSync(
    path.join(nextDir, "externals-manifest.json"),
    JSON.stringify({ buildId: BUILD_ID, links: [{ link: "pino-abc123", package: "pino" }] }),
  );
  return { nextDir, pkgDir };
}

/** Stub `os.platform()`, NOT `process.platform`. The source deliberately goes
 *  through `lib/platform.ts`'s `isWindows()`, which calls `os.platform()`
 *  precisely because Turbopack constant-folds the `process.platform` literal
 *  comparison at build time — so a test that stubbed `process.platform` would
 *  be exercising a branch the shipped bundle does not contain. */
function pinPlatform(value: NodeJS.Platform): void {
  vi.spyOn(os, "platform").mockReturnValue(value);
}

describe("externals farm creation is platform-correct", () => {
  it("on Windows creates a JUNCTION with an absolute target", () => {
    pinPlatform("win32");
    const { nextDir, pkgDir } = makeRoot();
    const spy = vi.spyOn(fs, "symlinkSync");

    const result = ensureNextExternalSymlinks(nextDir);

    expect(result.created).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const [target, , type] = spy.mock.calls[0]!;
    // "junction" is the whole point: it is the one directory-link type Windows
    // grants an unprivileged process.
    expect(type).toBe("junction");
    // Junctions cannot be relative. Node resolves the target to an absolute
    // path anyway, so passing a relative one would only obscure that.
    expect(path.isAbsolute(String(target))).toBe(true);
    expect(realpathSync(String(target))).toBe(realpathSync(pkgDir));
  });

  it("everywhere else keeps the RELATIVE dir symlink the signed .app needs", () => {
    pinPlatform("darwin");
    const { nextDir, pkgDir } = makeRoot();
    const spy = vi.spyOn(fs, "symlinkSync");

    const result = ensureNextExternalSymlinks(nextDir);

    expect(result.created).toHaveLength(1);
    const [target, , type] = spy.mock.calls[0]!;
    expect(type).toBe("dir");
    // Relative because the bundle is built at build/libi-bundle/ and copied
    // into Libi.app/Contents/Resources/; an absolute target would point at the
    // build machine and dangle on every user's disk.
    expect(path.isAbsolute(String(target))).toBe(false);
    expect(realpathSync(path.join(nextDir, "node_modules", "pino-abc123"))).toBe(
      realpathSync(pkgDir),
    );
  });

  it("the farm a Windows boot builds still verifies as a no-op on the next boot", () => {
    // The repair runs on EVERY Windows boot, so a junction the first boot
    // writes must satisfy the second boot's verify branch. If it did not, each
    // launch would rm and rewrite the farm — churn inside the install tree,
    // and a silent admission that the link type is not actually understood.
    pinPlatform("win32");
    const { nextDir } = makeRoot();

    expect(ensureNextExternalSymlinks(nextDir).created).toHaveLength(1);
    const second = ensureNextExternalSymlinks(nextDir);
    expect(second.created).toHaveLength(0);
    expect(second.verified).toHaveLength(1);
  });
});
