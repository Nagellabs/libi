import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveBundledSpawn } from "@/mcp/registry/local-bin-resolver";
import { adapterBinFileNames } from "@/lib/agents/adapter-tree";
import type { BundledMcpDef } from "@/mcp/registry/types";

const baseDef: BundledMcpDef = {
  id: "test-pkg",
  name: "Test",
  description: "",
  kind: "extension",
  toolPrefixes: [],
  npmUrl: null,
  type: "stdio",
  command: "npx",
  args: ["-y", "@scope/pkg@1.0.0"],
  requireApproval: false,
  dependencies: [],
};

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "libi-resolver-test-"));
}

/**
 * The bin shim(s) npm writes for `name` on this host, and the one the resolver must answer. Off Windows that is
 * the bare `<name>`; on Windows cmd-shim writes an extensionless BASH script plus `<name>.cmd` (and `.ps1`), and
 * only the `.cmd` is spawnable — `adapterBinFileNames`, the product's own list, names it.
 */
function writeBinShim(binDir: string, name: string): string {
  fs.writeFileSync(path.join(binDir, name), "#!/bin/sh\n");
  const expected = path.join(binDir, adapterBinFileNames(name, process.platform)[0]);
  if (!fs.existsSync(expected)) fs.writeFileSync(expected, "@ECHO off\r\n");
  return expected;
}

describe("resolveBundledSpawn", () => {
  let prevHome: string | undefined;
  let root: string;

  beforeEach(() => {
    prevHome = process.env.LIBI_HOME;
    root = makeRoot();
    process.env.LIBI_HOME = root;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("falls back to def.command when no npmPackage is set", () => {
    const result = resolveBundledSpawn(baseDef);
    expect(result.source).toBe("fallback");
    expect(result.command).toBe("npx");
    expect(result.args).toEqual(["-y", "@scope/pkg@1.0.0"]);
  });

  it("falls back when the install does not exist on disk", () => {
    const def: BundledMcpDef = {
      ...baseDef,
      npmPackage: "@scope/pkg",
      pinnedVersion: "1.0.0",
      binName: "pkg-bin",
    };
    const result = resolveBundledSpawn(def);
    expect(result.source).toBe("fallback");
  });

  it("falls back when the installed version does not match pinned", () => {
    fs.mkdirSync(path.join(root, "node_modules", "@scope", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "@scope", "pkg", "package.json"),
      JSON.stringify({ version: "0.9.0" }),
    );
    fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
    writeBinShim(path.join(root, "node_modules", ".bin"), "pkg-bin");

    const def: BundledMcpDef = {
      ...baseDef,
      npmPackage: "@scope/pkg",
      pinnedVersion: "1.0.0",
      binName: "pkg-bin",
    };

    const result = resolveBundledSpawn(def);
    expect(result.source).toBe("fallback");
  });

  it("falls back when the bin shim is missing even if the version matches", () => {
    fs.mkdirSync(path.join(root, "node_modules", "@scope", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "@scope", "pkg", "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );

    const def: BundledMcpDef = {
      ...baseDef,
      npmPackage: "@scope/pkg",
      pinnedVersion: "1.0.0",
      binName: "pkg-bin",
    };

    const result = resolveBundledSpawn(def);
    expect(result.source).toBe("fallback");
  });

  it("returns the local bin when version matches and shim exists", () => {
    fs.mkdirSync(path.join(root, "node_modules", "@scope", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "@scope", "pkg", "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
    const binPath = writeBinShim(path.join(root, "node_modules", ".bin"), "pkg-bin");

    const def: BundledMcpDef = {
      ...baseDef,
      npmPackage: "@scope/pkg",
      pinnedVersion: "1.0.0",
      binName: "pkg-bin",
    };

    const result = resolveBundledSpawn(def);
    expect(result.source).toBe("local");
    expect(result.command).toBe(binPath);
    expect(result.args).toEqual([]);
  });

  it("derives binName from the package's last segment when unset", () => {
    fs.mkdirSync(path.join(root, "node_modules", "@scope", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "@scope", "pkg", "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
    const binPath = writeBinShim(path.join(root, "node_modules", ".bin"), "pkg");

    const def: BundledMcpDef = {
      ...baseDef,
      npmPackage: "@scope/pkg",
      pinnedVersion: "1.0.0",
    };

    const result = resolveBundledSpawn(def);
    expect(result.source).toBe("local");
    expect(result.command).toBe(binPath);
  });
});
