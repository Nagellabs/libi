/**
 * `lib/runtime/compiled-entry.ts` — the dual-mode spawn resolver shared by
 * `lib/mcp-config.ts` and `mcp/registry/local-bin-resolver.ts`.
 *
 * Previously covered only by `cli-bundle-wiring.test.ts`, which greps for the
 * literal call-site string `resolveEntrySpawn(` — it never actually invokes
 * the function. This file exercises the real dual-mode decision against a
 * synthetic fixture tree: a dev checkout (tsx mode), an npm-installed copy
 * under `node_modules` with a compiled `dist-cli/` mirror (compiled mode), a
 * not-installed copy whose compiled output nonetheless exists (compiled mode
 * — the branch is keyed on "am I under node_modules", not "does dist-cli
 * exist"), and the case where neither mode resolves (`null`).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isInstalledUnderNodeModules,
  compiledEntryPath,
  resolveEntrySpawn,
  entryResolutionDiagnostic,
  COMPILED_DIR,
} from "@/lib/runtime/compiled-entry";

function makeFixtureRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("isInstalledUnderNodeModules", () => {
  it.each([
    [path.join("/Users/dev/project"), false],
    [path.join("/Users/dev/project", "dist-cli"), false],
    [path.join("/Users/dev/consumer", "node_modules", "@nagellabs", "libi"), true],
    [
      path.join("/Users/dev/consumer", "node_modules", "@nagellabs", "libi", "dist-cli"),
      true,
    ],
    // Electron's packaged layout has no node_modules segment at all.
    [path.join("/Applications/Libi.app/Contents/Resources/app"), false],
  ])("%s -> %s", (root, expected) => {
    expect(isInstalledUnderNodeModules(root)).toBe(expected);
  });
});

describe("compiledEntryPath", () => {
  it("maps a .ts source path to its compiled .js twin under dist-cli/", () => {
    expect(compiledEntryPath("/pkg", "mcp/index.ts")).toBe(
      path.join("/pkg", COMPILED_DIR, "mcp", "index.js"),
    );
  });

  it("maps a .tsx source path too", () => {
    expect(compiledEntryPath("/pkg", "lib/cli/index.tsx")).toBe(
      path.join("/pkg", COMPILED_DIR, "lib", "cli", "index.js"),
    );
  });
});

describe("resolveEntrySpawn", () => {
  const sourceRel = "mcp/index.ts";

  it("dev checkout: not under node_modules, source + tsx both present -> tsx mode", () => {
    const root = makeFixtureRoot("libi-entry-dev-");
    try {
      fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
      fs.writeFileSync(path.join(root, sourceRel), "// source");
      const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
      fs.mkdirSync(path.dirname(tsxCli), { recursive: true });
      fs.writeFileSync(tsxCli, "// tsx cli");
      fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");

      const result = resolveEntrySpawn(root, sourceRel);
      expect(result).not.toBeNull();
      expect(result!.mode).toBe("tsx");
      expect(result!.args).toEqual([
        tsxCli,
        "--tsconfig",
        path.join(root, "tsconfig.json"),
        path.join(root, sourceRel),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("npm install under node_modules with a compiled dist-cli mirror -> compiled mode, even though source+tsx also exist", () => {
    // Root deliberately lives under a node_modules segment, mirroring a real
    // `npx @nagellabs/libi` install layout.
    const base = makeFixtureRoot("libi-entry-installed-");
    const root = path.join(base, "node_modules", "@nagellabs", "libi");
    try {
      fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
      // Source + tsx are ALSO present (a real npm install ships the .ts too) —
      // the compiled branch must still win because it's under node_modules.
      fs.writeFileSync(path.join(root, sourceRel), "// source");
      const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
      fs.mkdirSync(path.dirname(tsxCli), { recursive: true });
      fs.writeFileSync(tsxCli, "// tsx cli");

      const compiled = compiledEntryPath(root, sourceRel);
      fs.mkdirSync(path.dirname(compiled), { recursive: true });
      fs.writeFileSync(compiled, "// compiled");

      const result = resolveEntrySpawn(root, sourceRel);
      expect(result).not.toBeNull();
      expect(result!.mode).toBe("compiled");
      expect(result!.args).toEqual([compiled]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("not under node_modules but source or tsx is missing -> falls through to compiled mode when dist-cli exists", () => {
    const root = makeFixtureRoot("libi-entry-fallthrough-");
    try {
      // No mcp/index.ts, no node_modules/tsx at all — only the compiled
      // output is on disk (e.g. a build artifact copied somewhere unusual).
      const compiled = compiledEntryPath(root, sourceRel);
      fs.mkdirSync(path.dirname(compiled), { recursive: true });
      fs.writeFileSync(compiled, "// compiled");

      const result = resolveEntrySpawn(root, sourceRel);
      expect(result).not.toBeNull();
      expect(result!.mode).toBe("compiled");
      expect(result!.args).toEqual([compiled]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("neither source+tsx nor compiled output exist -> null", () => {
    const root = makeFixtureRoot("libi-entry-none-");
    try {
      const result = resolveEntrySpawn(root, sourceRel);
      expect(result).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("entryResolutionDiagnostic", () => {
  it("names both candidate paths so the failure is actionable", () => {
    const msg = entryResolutionDiagnostic("/pkg", "mcp/index.ts");
    expect(msg).toContain(path.join("/pkg", "mcp/index.ts"));
    expect(msg).toContain(path.join("/pkg", "node_modules", "tsx", "dist", "cli.mjs"));
    expect(msg).toContain(compiledEntryPath("/pkg", "mcp/index.ts"));
  });
});
