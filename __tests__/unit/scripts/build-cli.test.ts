import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The compile step that makes `npx @nagellabs/libi` launchable at all.
//
// tsx applies the tsconfig `paths` matcher ONLY when the importing file's own
// path does not contain a `/node_modules/` segment (verified in
// node_modules/tsx/dist/register-*.cjs). Installed from npm every libi file
// trips that check, so every `@/…` import throws MODULE_NOT_FOUND before the
// CLI runs a line. `scripts/build-cli.js` pre-resolves those specifiers into
// plain relative requires so an installed copy never needs tsx.
//
// These tests run the REAL compiler against the REAL source tree (into a temp
// outDir, never the repo's own dist-cli) — a mocked compile would have the
// same blind spot the externals-manifest bug had.

import buildCliModule from "../../../scripts/build-cli.js";

interface BuildResult {
  outDir: string;
  fileCount: number;
  unresolvedFiles: string[];
  stampPath: string;
}
interface VerifyResult {
  ok: boolean;
  reason?: string;
}
interface BuildCliModule {
  rewriteAliasSpecifiers: (
    code: string,
    opts: { root: string; outDir: string; outFile: string },
  ) => { code: string; unresolved: string[] };
  buildCli: (opts: {
    root: string;
    outDir: string;
    quiet?: boolean;
  }) => Promise<BuildResult>;
  verifyCliBundle: (opts: { root: string; outDir: string }) => VerifyResult;
  assertCliBundleFresh: (opts: { root: string; outDir: string }) => VerifyResult;
}
const buildCli = buildCliModule as unknown as BuildCliModule;

const ROOT = path.resolve(__dirname, "..", "..", "..");

describe("rewriteAliasSpecifiers", () => {
  const outDir = path.join(ROOT, "dist-cli");

  it("rewrites a require() of an @/ alias into a relative specifier", () => {
    const outFile = path.join(outDir, "mcp", "tools", "x.js");
    const { code } = buildCli.rewriteAliasSpecifiers(
      'var a = require("@/lib/libi-home");',
      { root: ROOT, outDir, outFile },
    );
    expect(code).toBe('var a = require("../../lib/libi-home");');
  });

  // A dynamic `import()` in a CJS module uses Node's ESM resolver, which has
  // no extension inference — a bare `import("./logger")` throws
  // ERR_MODULE_NOT_FOUND. Adding `.js` resolves but routes our CJS output
  // through the ESM loader, whose named exports come from cjs-module-lexer,
  // which cannot see esbuild's `module.exports = __toCommonJS(...)` — every
  // destructured binding would silently be undefined. Hence a deferred
  // require(). This is a REAL bug found by booting an installed copy
  // (Category A died on `mcp/registry/installers.ts`), not a hypothetical.
  it("turns a dynamic import() of a local module into a deferred require()", () => {
    const outFile = path.join(outDir, "lib", "libi-home.js");
    const { code } = buildCli.rewriteAliasSpecifiers(
      'void import("@/lib/logger").then(m => m);',
      { root: ROOT, outDir, outFile },
    );
    expect(code).toBe(
      'void Promise.resolve().then(() => require("./logger")).then(m => m);',
    );
  });

  it("also defers an already-relative dynamic import (never went through the alias pass)", () => {
    // mcp/registry/dependency-manager.ts does `await import("./installers/tracking-pyenv")`
    // — no `@/`, and written across several lines in source, so only the
    // EMITTED (collapsed) output exposes it.
    const outFile = path.join(outDir, "mcp", "registry", "dependency-manager.js");
    const { code } = buildCli.rewriteAliasSpecifiers(
      'const { run } = await import("./installers/tracking-pyenv");',
      { root: ROOT, outDir, outFile },
    );
    expect(code).toBe(
      'const { run } = await Promise.resolve().then(() => require("./installers/tracking-pyenv"));',
    );
  });

  it("leaves a dynamic import of a BARE package alone (chokidar v5 is ESM-only)", () => {
    const outFile = path.join(outDir, "lib", "storage-watch", "watcher.js");
    const { code } = buildCli.rewriteAliasSpecifiers(
      'const { default: chokidar } = await import("chokidar");',
      { root: ROOT, outDir, outFile },
    );
    expect(code).toBe('const { default: chokidar } = await import("chokidar");');
  });

  it("resolves a directory alias through its index file", () => {
    const outFile = path.join(outDir, "lib", "cli", "index.js");
    const { code } = buildCli.rewriteAliasSpecifiers(
      'require("@/lib/server/lifecycle");',
      { root: ROOT, outDir, outFile },
    );
    // lib/server/lifecycle/index.ts -> compiled sibling directory index
    expect(code).toContain("../server/lifecycle/index");
    expect(code).not.toContain("@/");
  });

  it("points a JSON alias at the real package root, not the compiled tree", () => {
    const outFile = path.join(outDir, "mcp", "skills", "digest.js");
    const { code } = buildCli.rewriteAliasSpecifiers(
      'var pkg = require("@/package.json");',
      { root: ROOT, outDir, outFile },
    );
    // dist-cli/mcp/skills -> <root>/package.json
    expect(code).toBe('var pkg = require("../../../package.json");');
  });

  it("leaves an unresolvable/out-of-tree alias alone and reports it", () => {
    const outFile = path.join(outDir, "lib", "queries", "x.js");
    const { code, unresolved } = buildCli.rewriteAliasSpecifiers(
      'require("@/hooks/sessions/use-agent-chat");',
      { root: ROOT, outDir, outFile },
    );
    expect(code).toContain('require("@/hooks/sessions/use-agent-chat")');
    expect(unresolved).toEqual(["@/hooks/sessions/use-agent-chat"]);
  });
});

describe("the compile step refuses `import.meta` (esbuild only WARNS about it)", () => {
  // Under a CJS output format esbuild substitutes `{}` for `import.meta` and
  // keeps going, so `fileURLToPath(import.meta.url)` becomes
  // `fileURLToPath(undefined)` — a TypeError at module load, i.e. the MCP
  // child crashes on startup. This shipped once (mcp/bundled-mcps/install-tools.ts)
  // because tsx's hybrid shim makes `import.meta` and `__dirname` both work in
  // the same file, which real Node never does.
  it("fails the build instead of emitting fileURLToPath(undefined)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-import-meta-"));
    try {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "x", version: "0.0.0" }),
      );
      fs.writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "ES2017", paths: { "@/*": ["./*"] } } }),
      );
      fs.mkdirSync(path.join(root, "lib"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "lib", "bad.ts"),
        'import { fileURLToPath } from "node:url";\nexport const here = fileURLToPath(import.meta.url);\n',
      );
      await expect(
        buildCli.buildCli({ root, outDir: path.join(root, "dist-cli"), quiet: true }),
      ).rejects.toThrow(/import\.meta/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("compiled output actually EXECUTES (not just resolves)", () => {
  // Regression for the bug a real installed-copy boot caught after every
  // static-analysis check passed: Category A's binary-install phase threw
  // `Cannot find module '…/dist-cli/lib/libi-home'` from
  // `mcp/registry/installers.js`, because `await import("@/lib/libi-home")`
  // had been rewritten to an extensionless relative specifier and dynamic
  // import() in CJS goes through the ESM resolver. Asserting on emitted text
  // is not enough — this builds AND runs.
  it("runs a module whose local dynamic import() was rewritten, with named bindings intact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dynimport-"));
    try {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "x", version: "0.0.0" }),
      );
      fs.writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "ES2017", paths: { "@/*": ["./*"] } } }),
      );
      fs.mkdirSync(path.join(root, "lib"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "lib", "leaf.ts"),
        "export const answer = 42;\nexport default { answer };\n",
      );
      fs.writeFileSync(
        path.join(root, "lib", "caller.ts"),
        'export async function go(): Promise<number> {\n' +
          '  const { answer } = await import("@/lib/leaf");\n' +
          "  return answer;\n" +
          "}\n",
      );
      const outDir = path.join(root, "dist-cli");
      await buildCli.buildCli({ root, outDir, quiet: true });

      const emitted = fs.readFileSync(path.join(outDir, "lib", "caller.js"), "utf-8");
      expect(emitted).not.toMatch(/import\(\s*["']\.{1,2}\//);

      const mod = await import(path.join(outDir, "lib", "caller.js"));
      const go = (mod.default?.go ?? mod.go) as () => Promise<number>;
      await expect(go()).resolves.toBe(42);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("buildCli + verifyCliBundle (real compile of the real tree)", () => {
  let tmpOut: string;
  let result: BuildResult;

  beforeAll(async () => {
    tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dist-cli-"));
    result = await buildCli.buildCli({ root: ROOT, outDir: tmpOut, quiet: true });
  }, 120_000);

  afterAll(() => {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  });

  it("emits the two entry chains the installed CLI actually spawns", () => {
    expect(fs.existsSync(path.join(tmpOut, "lib", "cli", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(tmpOut, "mcp", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(tmpOut, "mcp", "tracking-mcp", "index.js"))).toBe(true);
    expect(result.fileCount).toBeGreaterThan(400);
  });

  it("leaves no @/ specifier in any require()/import() of the compiled output", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".js")) {
          const src = fs.readFileSync(full, "utf-8");
          const m = src.match(/(?:require|import)\(\s*["']@\//g);
          if (m) offenders.push(path.relative(tmpOut, full));
        }
      }
    };
    walk(tmpOut);
    // The only tolerated residue is the client-only tree (@/hooks, @/components),
    // which the server entry chains never load — reported by the builder.
    expect(offenders.sort()).toEqual(
      result.unresolvedFiles.map((f: string) => f).sort(),
    );
  });

  it("leaves no extensionless RELATIVE dynamic import() anywhere (ESM resolver, no extension inference)", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".js")) {
          const src = fs.readFileSync(full, "utf-8");
          if (/\bimport\(\s*["']\.{1,2}\//.test(src)) offenders.push(path.relative(tmpOut, full));
        }
      }
    };
    walk(tmpOut);
    expect(offenders).toEqual([]);
  });

  it("keeps every bare package specifier external (nothing from node_modules is inlined)", () => {
    const mcpEntry = fs.readFileSync(path.join(tmpOut, "mcp", "index.js"), "utf-8");
    expect(mcpEntry).toContain('require("@modelcontextprotocol/sdk/server/stdio.js")');
    // A per-file transpile, not a bundle: the entry stays tiny.
    expect(mcpEntry.length).toBeLessThan(20_000);
  });

  it("writes a stamp that verifies clean immediately after a build", () => {
    const v = buildCli.verifyCliBundle({ root: ROOT, outDir: tmpOut });
    expect(v.ok, v.reason).toBe(true);
  });

  it("fails verification when a compiled output file is missing", () => {
    const victim = path.join(tmpOut, "mcp", "index.js");
    const saved = fs.readFileSync(victim);
    fs.rmSync(victim);
    try {
      const v = buildCli.verifyCliBundle({ root: ROOT, outDir: tmpOut });
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/missing compiled output/i);
    } finally {
      fs.writeFileSync(victim, saved);
    }
  });

  it("fails verification when a source file changed after the build (stale output)", () => {
    const stampPath = path.join(tmpOut, "BUILD_INFO.json");
    const stamp = JSON.parse(fs.readFileSync(stampPath, "utf-8"));
    const saved = JSON.stringify(stamp);
    stamp.inputs["mcp/index.ts"] = "0".repeat(64);
    fs.writeFileSync(stampPath, JSON.stringify(stamp));
    try {
      const v = buildCli.verifyCliBundle({ root: ROOT, outDir: tmpOut });
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/mcp\/index\.ts/);
    } finally {
      fs.writeFileSync(stampPath, saved);
    }
  });

  it("fails verification when a NEW source file appeared after the build", () => {
    const stampPath = path.join(tmpOut, "BUILD_INFO.json");
    const stamp = JSON.parse(fs.readFileSync(stampPath, "utf-8"));
    const saved = JSON.stringify(stamp);
    delete stamp.inputs["mcp/index.ts"];
    fs.writeFileSync(stampPath, JSON.stringify(stamp));
    try {
      const v = buildCli.verifyCliBundle({ root: ROOT, outDir: tmpOut });
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/not in the stamp|new source/i);
    } finally {
      fs.writeFileSync(stampPath, saved);
    }
  });

  it("fails verification when the bundle is absent entirely", () => {
    const v = buildCli.verifyCliBundle({
      root: ROOT,
      outDir: path.join(tmpOut, "does-not-exist"),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/BUILD_INFO\.json/);
  });

  it("assertCliBundleFresh throws (not warns) on a stale bundle", () => {
    expect(() =>
      buildCli.assertCliBundleFresh({
        root: ROOT,
        outDir: path.join(tmpOut, "does-not-exist"),
      }),
    ).toThrow(/build-cli/);
  });
});
