import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { seedDatabase } from "@/lib/db/init";
import { prepareAgentDir } from "@/mcp/workspace";
import { BUNDLED_SKILLS } from "@/mcp/skills/registry";

/**
 * `prepareAgentDir` calls through to `writeAllAgentConfigs` →
 * `writeSettingsFile` → `buildLibiEntry()`, which resolves `mcp/index.ts` and
 * `node_modules/tsx/dist/cli.mjs` relative to `process.cwd()` and THROWS if
 * either is missing (see `lib/mcp-config.ts` — deliberately no silent `npx
 * libi serve-mcp` fallback). These tests `chdir` into a synthetic
 * `bundledRoot` that only mirrors `mcp/skills/`, so stub both paths there too
 * — mirrors how a real deploy (dev checkout or packaged build) always has
 * them alongside `mcp/skills`.
 */
function stubLibiMcpEntry(bundledRoot: string): void {
  fs.mkdirSync(path.join(bundledRoot, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(bundledRoot, "mcp", "index.ts"), "// stub for test\n");
  fs.mkdirSync(path.join(bundledRoot, "node_modules", "tsx", "dist"), { recursive: true });
  fs.writeFileSync(path.join(bundledRoot, "node_modules", "tsx", "dist", "cli.mjs"), "// stub for test\n");
}

describe("prepareAgentDir integrates skills", () => {
  let bundledRoot: string;
  let homeRoot: string;
  let workspace: string;
  let prevHome: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prep-ws-bundled-"));
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prep-ws-home-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "prep-ws-"));

    // Mirror the real bundled skill onto disk for the test (so the loader
    // resolves bundled bodies via getBundledSkillsDir() == cwd/mcp/skills).
    for (const def of BUNDLED_SKILLS) {
      const srcDir = path.join(prevCwd, "mcp", "skills", def.name);
      const dstDir = path.join(bundledRoot, "mcp", "skills", def.name);
      fs.mkdirSync(dstDir, { recursive: true });
      if (fs.existsSync(srcDir)) {
        for (const f of fs.readdirSync(srcDir)) {
          const src = path.join(srcDir, f);
          const dst = path.join(dstDir, f);
          if (fs.statSync(src).isFile()) fs.copyFileSync(src, dst);
        }
      } else {
        // Generate a minimal SKILL.md if the bundled file isn't on disk yet
        fs.writeFileSync(
          path.join(dstDir, "SKILL.md"),
          `---\nname: ${def.name}\ndescription: ${def.description}\n---\nBundled body.\n`,
        );
      }
    }

    stubLibiMcpEntry(bundledRoot);
    process.chdir(bundledRoot);
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = homeRoot;
    createTestDb();
    seedDatabase(getDb() as never);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    fs.rmSync(bundledRoot, { recursive: true, force: true });
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("writes every enabled bundled skill into both dialect surfaces", async () => {
    await prepareAgentDir(workspace);
    for (const def of BUNDLED_SKILLS) {
      const claude = path.join(workspace, ".claude", "skills", def.name, "SKILL.md");
      const agents = path.join(workspace, ".agents", "skills", def.name, "SKILL.md");
      expect(fs.existsSync(claude)).toBe(true);
      expect(fs.existsSync(agents)).toBe(true);
    }
    expect(fs.existsSync(path.join(workspace, "GEMINI.md"))).toBe(false);
  });

  it("disabled bundled skill is not written even after seedDatabase", async () => {
    // Disable a bundled skill in DB
    const def = BUNDLED_SKILLS[0];
    const { eq } = await import("drizzle-orm");
    getDb().update(skills).set({ enabled: false }).where(eq(skills.id, def.id)).run();

    await prepareAgentDir(workspace);
    const claude = path.join(workspace, ".claude", "skills", def.name);
    expect(fs.existsSync(claude)).toBe(false);
  });
});

describe("prepareAgentDir renders per-agent dialects (Task 4.2 / G0b)", () => {
  let bundledRoot: string;
  let homeRoot: string;
  let workspace: string;
  let prevHome: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prep-dialect-bundled-"));
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prep-dialect-home-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "prep-dialect-"));

    // Mirror the REAL template + bundled skills onto disk so getInstructions()
    // reads the shipped template with its dialect blocks (cwd = bundledRoot).
    const tplSrc = path.join(prevCwd, "mcp", "templates", "instructions.md");
    const tplDst = path.join(bundledRoot, "mcp", "templates", "instructions.md");
    fs.mkdirSync(path.dirname(tplDst), { recursive: true });
    fs.copyFileSync(tplSrc, tplDst);

    for (const def of BUNDLED_SKILLS) {
      const srcDir = path.join(prevCwd, "mcp", "skills", def.name);
      const dstDir = path.join(bundledRoot, "mcp", "skills", def.name);
      fs.mkdirSync(dstDir, { recursive: true });
      if (fs.existsSync(srcDir)) {
        for (const f of fs.readdirSync(srcDir)) {
          const src = path.join(srcDir, f);
          const dst = path.join(dstDir, f);
          if (fs.statSync(src).isFile()) fs.copyFileSync(src, dst);
        }
      } else {
        fs.writeFileSync(
          path.join(dstDir, "SKILL.md"),
          `---\nname: ${def.name}\ndescription: ${def.description}\n---\nBundled body.\n`,
        );
      }
    }

    stubLibiMcpEntry(bundledRoot);
    process.chdir(bundledRoot);
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = homeRoot;
    createTestDb();
    seedDatabase(getDb() as never);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    fs.rmSync(bundledRoot, { recursive: true, force: true });
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const read = (file: string) =>
    fs.readFileSync(path.join(workspace, file), "utf-8");

  it("CLAUDE.md carries claude wording, AGENTS.md carries codex wording + self-check", async () => {
    await prepareAgentDir(workspace);
    const claude = read("CLAUDE.md");
    const agents = read("AGENTS.md");

    expect(claude).not.toBe(agents);

    expect(claude).toContain("via the Skill tool");
    expect(claude).not.toContain("$using-storyboard");

    expect(agents).not.toContain("via the Skill tool");
    expect(agents).toContain("$using-storyboard");
    expect(agents).toContain(".agents/skills");
    // Codex self-check text
    expect(agents).toContain("Codex self-check");
    expect(agents).toContain("MCPs & Skills");
    expect(agents).toContain("codex mcp list");

    // Shared body survives in both.
    expect(claude).toContain("Libi Video Composition API");
    expect(agents).toContain("Libi Video Composition API");

    // No unresolved markers leak into either shipped file.
    expect(claude).not.toContain("libi-agent:");
    expect(agents).not.toContain("libi-agent:");
  });

  it("both files carry the same memories section (dialect-neutral)", async () => {
    fs.writeFileSync(path.join(homeRoot, "memories.md"), "Remember to be concise.");
    await prepareAgentDir(workspace);
    const claude = read("CLAUDE.md");
    const agents = read("AGENTS.md");

    const memBlock = "## Memories\n\nRemember to be concise.";
    expect(claude).toContain(memBlock);
    expect(agents).toContain(memBlock);
  });

  it("a marker-free user override renders identically for both dialects", async () => {
    // Override with content that has NO dialect markers → graceful degradation.
    const instrDir = path.join(homeRoot, "instructions");
    fs.mkdirSync(instrDir, { recursive: true });
    fs.writeFileSync(
      path.join(instrDir, "instructions.md"),
      "<!-- libi-instructions-start v9.9.9 -->\n# Custom rules\nJust do the thing.\n<!-- libi-instructions-end -->\n",
    );

    await prepareAgentDir(workspace);
    const claude = read("CLAUDE.md");
    const agents = read("AGENTS.md");

    expect(claude).toBe(agents);
    expect(claude).toContain("Just do the thing.");
  });
});
