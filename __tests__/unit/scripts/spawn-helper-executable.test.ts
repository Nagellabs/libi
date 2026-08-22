// node-pty's `spawn-helper` must ship EXECUTABLE inside the packaged app.
//
// npm unpacks it without the execute bit. `lib/terminal/pty.ts` carries a
// runtime `chmod +x` for exactly that, and in a dev tree or an `npx` install
// it works — those live somewhere writable.
//
// It cannot work in the desktop app. The bundle ends up inside a signed,
// notarized `.app`, where chmod is refused outright:
//
//   EPERM: operation not permitted, chmod
//     '/Applications/Libi.app/Contents/Resources/libi-bundle/node_modules/
//      node-pty/prebuilds/darwin-arm64/spawn-helper'
//
// node-pty posix_spawn()s that helper on EVERY pty launch, so a non-executable
// one means the built-in Terminal cannot start at all. The user gets a bare
// "posix_spawn failed." — and if they are signed out of Codex, no way to sign
// in, because the remedy libi offers is "open a terminal".
//
// Found in the v0.1.3 FULL verification, against the shipped dmg, where the
// helper was mode 644 in both the installed app and the pristine image. It had
// shipped that way for three releases; no gate looked.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertPrebuiltExecutablesRunnable,
  restorePrebuiltExecutables,
} from "@/scripts/build-runtime-bundle.js";

let tmp: string;

/** Lay down a bundle shaped like the one electron-builder packages. */
function makeBundle(mode: number, platforms = ["darwin-arm64"]): string {
  for (const p of platforms) {
    const dir = path.join(tmp, "node_modules", "node-pty", "prebuilds", p);
    fs.mkdirSync(dir, { recursive: true });
    const helper = path.join(dir, "spawn-helper");
    fs.writeFileSync(helper, "#!/bin/sh\n");
    fs.chmodSync(helper, mode);
  }
  return tmp;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-spawnhelper-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the packaged bundle's spawn-helper", () => {
  it("FAILS the build when the helper is not executable", () => {
    makeBundle(0o644);
    expect(() => assertPrebuiltExecutablesRunnable(tmp)).toThrow(/NOT executable/);
  });

  // The message has to carry the whole story: someone reads it months from
  // now with no idea why a file mode fails a build.
  it("explains why it matters, not just that it is wrong", () => {
    makeBundle(0o644);
    let message = "";
    try {
      assertPrebuiltExecutablesRunnable(tmp);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("posix_spawn");
    expect(message).toContain("Terminal");
    expect(message).toContain("signed");
  });

  it("passes when the helper is executable", () => {
    makeBundle(0o755);
    expect(() => assertPrebuiltExecutablesRunnable(tmp)).not.toThrow();
  });

  it("restores the bit, and the guard then passes", () => {
    makeBundle(0o644, ["darwin-arm64", "darwin-x64", "linux-x64"]);
    restorePrebuiltExecutables(tmp);
    for (const p of ["darwin-arm64", "darwin-x64", "linux-x64"]) {
      const helper = path.join(tmp, "node_modules", "node-pty", "prebuilds", p, "spawn-helper");
      expect(fs.statSync(helper).mode & 0o111, `${p} should be executable`).not.toBe(0);
    }
    expect(() => assertPrebuiltExecutablesRunnable(tmp)).not.toThrow();
  });

  // Restoring must be additive. Clobbering the mode outright would be a
  // different bug wearing the fix's clothes.
  it("keeps a bit that was already set", () => {
    makeBundle(0o755);
    restorePrebuiltExecutables(tmp);
    const helper = path.join(
      tmp, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper",
    );
    expect(fs.statSync(helper).mode & 0o777).toBe(0o755);
  });

  // A bundle for another platform carries no darwin helper, and that is fine —
  // the guard must not fail a Linux or Windows build for a missing file.
  it("says nothing when there are no node-pty prebuilds at all", () => {
    expect(() => assertPrebuiltExecutablesRunnable(tmp)).not.toThrow();
    expect(() => restorePrebuiltExecutables(tmp)).not.toThrow();
  });
});
