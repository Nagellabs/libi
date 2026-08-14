/**
 * A missing sidecar binding must FAIL LOUDLY, not load the wrong ABI.
 *
 * better-sqlite3 has to load under two interpreters: Electron (ABI 135) in the
 * main process, and a plain Node (ABI 137) in the MCP stdio child. The packaged
 * runtime therefore parks per-major copies at `build/Release-node-<major>/` and
 * lets the Electron prebuild own the default `build/Release`.
 *
 * `resolveNativeBinding` used to return `undefined` on a miss, which makes
 * better-sqlite3 fall back to that default — i.e. load the ELECTRON binding
 * under Node. `require` succeeds and `new Database()` then throws ERR_DLOPEN or
 * SIGKILLs the process, so the UI and every install status stay green while
 * every DB-backed `libi.*` tool dies at first agent use.
 *
 * Two separate release blockers on this branch reached that state:
 *   - an in-app runtime update installed a tree with NO sidecars at all;
 *   - `findSystemNode` linked a system node (Homebrew's current is 25.x) whose
 *     major is outside the shipped set.
 *
 * The distinction that makes this safe to enforce: sidecars present ⇒ packaged
 * layout, where a miss is fatal. No sidecars at all ⇒ the plain-`npx` layout,
 * where `build/Release` was compiled by npm for the running node and returning
 * `undefined` is correct.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveNativeBinding } from "@/lib/db/native-binding";

let tmp: string;
let buildDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-abi-"));
  buildDir = path.join(tmp, "build");
  fs.mkdirSync(buildDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function parkSidecars(majors: number[]) {
  for (const m of majors) {
    const d = path.join(buildDir, `Release-node-${m}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "better_sqlite3.node"), "stub");
  }
}

/** Point the resolver straight at our fixture build dir. */
const env = () => ({ LIBI_SQLITE_BINDING_DIR: buildDir });

describe("resolveNativeBinding ABI guard", () => {
  it("throws, naming both majors, when sidecars exist but not for this node", () => {
    parkSidecars([20, 21, 22, 23, 24]);
    let err: Error | undefined;
    try {
      resolveNativeBinding(tmp, env(), { node: "25.0.0" });
    } catch (e) {
      err = e as Error;
    }
    expect(
      err,
      "returning undefined here loads the Electron binding under Node — the " +
        "green-UI/dead-tools failure this guard exists to prevent",
    ).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/Node 25/);
    expect(err!.message).toMatch(/20, 21, 22, 23, 24/);
  });

  it("returns the matching sidecar when this node IS covered", () => {
    parkSidecars([20, 22, 24]);
    const got = resolveNativeBinding(tmp, env(), { node: "22.14.0" });
    expect(got).toBe(
      path.join(buildDir, "Release-node-22", "better_sqlite3.node"),
    );
  });

  it("stays quiet for the plain-npx layout (no sidecars anywhere)", () => {
    // build/Release here was compiled by npm for the running node, so
    // better-sqlite3's own default resolution is correct.
    fs.mkdirSync(path.join(buildDir, "Release"), { recursive: true });
    expect(resolveNativeBinding(tmp, env(), { node: "25.0.0" })).toBeUndefined();
  });

  it("never interferes inside Electron", () => {
    // In-process, the default binding IS this interpreter's binding.
    parkSidecars([20]);
    expect(
      resolveNativeBinding(tmp, env(), { node: "25.0.0", electron: "36.3.1" }),
    ).toBeUndefined();
  });
});
