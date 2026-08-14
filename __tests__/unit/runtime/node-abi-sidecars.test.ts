/**
 * The sidecar contract, and the one place it can silently drift.
 *
 * `scripts/build-runtime-bundle.js` is plain CJS run by `node` at build time —
 * it cannot import the TypeScript module, so it keeps a literal copy of the
 * majors list. Two producers writing the same artifact from two copies of the
 * same constant is exactly the shape that goes wrong quietly: bump one, ship a
 * .app whose bundled snapshot and whose in-app updates cover different Node
 * versions, and nothing complains until a user's MCP child cannot open the
 * database.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  NODE_ABI_SIDECAR_MAJORS,
  betterSqliteBuildDir,
  betterSqliteModuleDir,
  sidecarDirName,
  sidecarMajorsIn,
  sidecarMajorsInPrefix,
} from "@/lib/runtime/node-abi-sidecars";

describe("NODE_ABI_SIDECAR_MAJORS", () => {
  it("matches the literal copy in scripts/build-runtime-bundle.js", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "scripts", "build-runtime-bundle.js"),
      "utf-8",
    );
    const m = /const NODE_ABI_SIDECAR_MAJORS = \[([^\]]*)\]/.exec(src);
    expect(m, "the build script no longer declares NODE_ABI_SIDECAR_MAJORS").not.toBeNull();
    const fromScript = m![1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    expect(fromScript).toEqual([...NODE_ABI_SIDECAR_MAJORS]);
  });
});

describe("sidecarMajorsIn", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-sidecars-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function park(buildDir: string, major: number, bytes = "stub") {
    const d = path.join(buildDir, sidecarDirName(major));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "better_sqlite3.node"), bytes);
  }

  it("returns the majors present, ascending", () => {
    park(tmp, 24);
    park(tmp, 20);
    park(tmp, 22);
    expect(sidecarMajorsIn(tmp)).toEqual([20, 22, 24]);
  });

  it("ignores a sidecar dir with no binding in it", () => {
    fs.mkdirSync(path.join(tmp, sidecarDirName(22)), { recursive: true });
    expect(sidecarMajorsIn(tmp)).toEqual([]);
  });

  it("ignores a zero-length binding — a failed copy is not a binding", () => {
    park(tmp, 22, "");
    expect(sidecarMajorsIn(tmp)).toEqual([]);
  });

  it("ignores the Electron default and anything else in the build dir", () => {
    fs.mkdirSync(path.join(tmp, "Release"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "Release", "better_sqlite3.node"), "electron");
    fs.mkdirSync(path.join(tmp, "Release-node-notanumber"), { recursive: true });
    expect(sidecarMajorsIn(tmp)).toEqual([]);
  });

  it("returns empty rather than throwing for a missing dir", () => {
    expect(sidecarMajorsIn(path.join(tmp, "nope"))).toEqual([]);
  });

  it("sidecarMajorsInPrefix reads through the npm install layout", () => {
    park(betterSqliteBuildDir(tmp), 24);
    expect(sidecarMajorsInPrefix(tmp)).toEqual([24]);
    expect(betterSqliteModuleDir(tmp)).toBe(
      path.join(tmp, "node_modules", "better-sqlite3"),
    );
  });
});
