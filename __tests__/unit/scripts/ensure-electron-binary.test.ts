import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ensureElectronBinary, distOk, BINARY_REL } = require("../../../scripts/ensure-electron-binary.js");

const REL = BINARY_REL[process.platform] as string;
let root: string;
let pkg: string;

function writeGoodDist() {
  const bin = path.join(pkg, "dist", REL);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "fake-binary");
  fs.writeFileSync(path.join(pkg, "path.txt"), REL);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-electron-"));
  pkg = path.join(root, "node_modules", "electron");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "electron", version: "36.9.5" }),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("distOk", () => {
  it("is false when path.txt is missing", () => {
    expect(distOk(root)).toBe(false);
  });

  it("is false when path.txt points at a missing binary", () => {
    fs.writeFileSync(path.join(pkg, "path.txt"), REL);
    expect(distOk(root)).toBe(false);
  });

  it("is true for a complete install", () => {
    writeGoodDist();
    expect(distOk(root)).toBe(true);
  });
});

describe("ensureElectronBinary", () => {
  it("fast-paths a healthy install without side effects", () => {
    writeGoodDist();
    let installerRan = false;
    const result = ensureElectronBinary(root, {
      runInstaller: () => { installerRan = true; },
      log: () => {},
    });
    expect(result).toBe("ok");
    expect(installerRan).toBe(false);
  });

  it("repairs via install.js when that works", () => {
    const result = ensureElectronBinary(root, {
      runInstaller: () => writeGoodDist(),
      log: () => {},
    });
    expect(result).toBe("reinstalled");
  });

  it("falls back to extracting the cached zip and writes path.txt", () => {
    const result = ensureElectronBinary(root, {
      runInstaller: () => {}, // install.js "succeeds" but repairs nothing (observed failure)
      locateCacheZip: () => "/fake/cache/electron-v36.9.5.zip",
      extractZip: (_zip: string, dest: string) => {
        const bin = path.join(dest, REL);
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        fs.writeFileSync(bin, "fake-binary");
      },
      log: () => {},
    });
    expect(result).toBe("extracted");
    expect(fs.readFileSync(path.join(pkg, "path.txt"), "utf8")).toBe(REL);
    expect(distOk(root)).toBe(true);
  });

  it("throws an actionable error when nothing repairs it", () => {
    expect(() =>
      ensureElectronBinary(root, {
        runInstaller: () => {},
        locateCacheZip: () => null,
        log: () => {},
      }),
    ).toThrow(/rm -rf node_modules\/electron/);
  });

  it("survives install.js itself throwing and still tries the zip fallback", () => {
    const result = ensureElectronBinary(root, {
      runInstaller: () => { throw new Error("boom"); },
      locateCacheZip: () => "/fake/cache/electron.zip",
      extractZip: (_zip: string, dest: string) => {
        const bin = path.join(dest, REL);
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        fs.writeFileSync(bin, "fake-binary");
      },
      log: () => {},
    });
    expect(result).toBe("extracted");
  });
});
