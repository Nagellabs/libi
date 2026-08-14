import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  candidateBuildDirs,
  resolveNativeBinding,
  sqliteBuildDirForChildren,
} from "@/lib/db/native-binding";

/**
 * Regression cover for the packaged-Electron two-interpreter defect: the app
 * ships ONE better-sqlite3 built for Electron's ABI, while the libi MCP stdio
 * child runs under a real node. Without a per-node-major sidecar binding every
 * DB-backed `libi.*` tool failed with "compiled against a different Node.js
 * version" while the UI looked completely healthy.
 */
describe("db/native-binding", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-binding-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeSidecar(buildDir: string, major: number): string {
    const dir = path.join(buildDir, `Release-node-${major}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "better_sqlite3.node");
    fs.writeFileSync(file, "");
    return file;
  }

  const nodeVersions = (node: string, electron?: string) => ({
    node,
    ...(electron ? { electron } : {}),
  });

  it("returns undefined under Electron — the default binding is already right", () => {
    const buildDir = path.join(tmp, "node_modules", "better-sqlite3", "build");
    writeSidecar(buildDir, 24);
    expect(resolveNativeBinding(tmp, {}, nodeVersions("22.0.0", "36.9.5"))).toBeUndefined();
  });

  it("finds the sidecar for this node major under a checkout layout", () => {
    const buildDir = path.join(tmp, "node_modules", "better-sqlite3", "build");
    const file = writeSidecar(buildDir, 24);
    expect(resolveNativeBinding(tmp, {}, nodeVersions("24.16.0"))).toBe(file);
  });

  it("finds the sidecar under the installed @scope/pkg layout the app ships as", () => {
    // <prefix>/node_modules/@nagellabs/libi is cwd; the dep is two levels up.
    const cwd = path.join(tmp, "node_modules", "@nagellabs", "libi");
    fs.mkdirSync(cwd, { recursive: true });
    const buildDir = path.join(tmp, "node_modules", "better-sqlite3", "build");
    const file = writeSidecar(buildDir, 24);
    expect(resolveNativeBinding(cwd, {}, nodeVersions("24.16.0"))).toBe(file);
  });

  it("prefers an explicit LIBI_SQLITE_BINDING_DIR over the layout guesses", () => {
    const explicitBuild = path.join(tmp, "explicit");
    const file = writeSidecar(explicitBuild, 22);
    const env = { LIBI_SQLITE_BINDING_DIR: explicitBuild };
    expect(resolveNativeBinding(tmp, env, nodeVersions("22.14.0"))).toBe(file);
  });

  it("returns undefined in the npm-install case (no sidecars at all)", () => {
    // This test used to park a `Release-node-22` sidecar and call that "the
    // npm install case" — but a tree carrying sidecars is the PACKAGED layout,
    // where `build/Release` is deliberately Electron's. Returning undefined
    // there loads the Electron binding under Node, which is the green-UI /
    // dead-tools failure the guard in native-binding-abi-guard.test.ts covers.
    //
    // The genuine npm layout has `build/Release` and no `Release-node-*`,
    // because npm compiled it for whichever node ran the install. That is the
    // one case where deferring to better-sqlite3's own resolution is right.
    const buildDir = path.join(tmp, "node_modules", "better-sqlite3", "build");
    fs.mkdirSync(path.join(buildDir, "Release"), { recursive: true });
    expect(resolveNativeBinding(tmp, {}, nodeVersions("24.16.0"))).toBeUndefined();
  });

  it("sqliteBuildDirForChildren names the build dir the server can see", () => {
    const buildDir = path.join(tmp, "node_modules", "better-sqlite3", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    expect(sqliteBuildDirForChildren(tmp, {})).toBe(path.resolve(buildDir));
  });

  it("sqliteBuildDirForChildren returns undefined when there is nothing to name", () => {
    expect(sqliteBuildDirForChildren(tmp, {})).toBeUndefined();
  });

  it("candidateBuildDirs puts the env override first", () => {
    const dirs = candidateBuildDirs("/somewhere", { LIBI_SQLITE_BINDING_DIR: "/override" });
    expect(dirs[0]).toBe("/override");
    expect(dirs).toHaveLength(4);
  });
});
