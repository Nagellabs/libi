import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { prepareAgentDir } from "@/mcp/workspace";
import { LIBI_SKILL_VERSION } from "@/mcp/version";
import { AGENT_MARKER_START, AGENT_MARKER_END } from "@/lib/instructions/marker-merge";

describe("prepareAgentDir", () => {
  let tempHome: string;
  let workspaceDir: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "libi-test-"));
    workspaceDir = path.join(tempHome, "agent");
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("creates the workspace directory", async () => {
    await prepareAgentDir(workspaceDir);

    expect(fs.existsSync(workspaceDir)).toBe(true);
  });

  it("writes CLAUDE.md into the workspace", async () => {
    await prepareAgentDir(workspaceDir);

    const claudeMd = path.join(workspaceDir, "CLAUDE.md");
    expect(fs.existsSync(claudeMd)).toBe(true);
  });

  it("writes AGENTS.md into the workspace", async () => {
    await prepareAgentDir(workspaceDir);

    const agentsMd = path.join(workspaceDir, "AGENTS.md");
    expect(fs.existsSync(agentsMd)).toBe(true);
  });

  it("CLAUDE.md and AGENTS.md diverge by agent dialect", async () => {
    // The byte-identical invariant is intentionally ended (Task 4.2 / G0b):
    // CLAUDE.md renders the claude dialect, AGENTS.md renders the codex dialect.
    await prepareAgentDir(workspaceDir);

    const claudeContent = fs.readFileSync(
      path.join(workspaceDir, "CLAUDE.md"),
      "utf-8"
    );
    const agentsContent = fs.readFileSync(
      path.join(workspaceDir, "AGENTS.md"),
      "utf-8"
    );

    // They must NOT be byte-identical anymore.
    expect(claudeContent).not.toBe(agentsContent);

    // CLAUDE.md keeps the "Skill tool" mechanic; AGENTS.md drops it and uses the
    // codex progressive-disclosure wording.
    expect(claudeContent).toContain("via the Skill tool");
    expect(claudeContent).not.toContain("$using-storyboard");

    expect(agentsContent).not.toContain("via the Skill tool");
    expect(agentsContent).toContain("$using-storyboard");
    expect(agentsContent).toContain(".agents/skills");

    // Codex self-check block is codex-only.
    expect(agentsContent).toContain("Codex self-check");
    expect(agentsContent).toContain("MCPs & Skills");
    expect(agentsContent).toContain("codex mcp list");
    expect(claudeContent).not.toContain("Codex self-check");

    // The shared body survives in both files.
    expect(claudeContent).toContain("Libi Video Composition API");
    expect(agentsContent).toContain("Libi Video Composition API");
    expect(claudeContent).toContain("<!-- libi-instructions-start");
    expect(agentsContent).toContain("<!-- libi-instructions-start");

    // No unresolved dialect markers leak into either shipped file.
    expect(claudeContent).not.toContain("libi-agent:");
    expect(agentsContent).not.toContain("libi-agent:");
  });

  it("CLAUDE.md contains instruction markers", async () => {
    await prepareAgentDir(workspaceDir);

    const content = fs.readFileSync(
      path.join(workspaceDir, "CLAUDE.md"),
      "utf-8"
    );
    expect(content).toContain("<!-- libi-instructions-start");
    expect(content).toContain("<!-- libi-instructions-end -->");
  });

  it("writes .version file with the correct version", async () => {
    await prepareAgentDir(workspaceDir);

    const versionFile = path.join(workspaceDir, ".version");
    expect(fs.existsSync(versionFile)).toBe(true);

    const content = fs.readFileSync(versionFile, "utf-8");
    expect(content).toBe(LIBI_SKILL_VERSION);
  });

  it("is idempotent: calling twice doesn't throw", async () => {
    await expect(
      (async () => {
        await prepareAgentDir(workspaceDir);
        await prepareAgentDir(workspaceDir);
      })(),
    ).resolves.toBeUndefined();
  });

  it("the .version file content matches the exported LIBI_SKILL_VERSION", async () => {
    await prepareAgentDir(workspaceDir);

    const versionFile = path.join(workspaceDir, ".version");
    const content = fs.readFileSync(versionFile, "utf-8");

    expect(content).toBe(LIBI_SKILL_VERSION);
    expect(LIBI_SKILL_VERSION).toBeTruthy();
  });

  it("writes .mcp.json with libi MCP server and settings.local.json with enableAllProjectMcpServers", async () => {
    await prepareAgentDir(workspaceDir);

    // settings.local.json should have enableAllProjectMcpServers but no mcpServers
    const settingsPath = path.join(workspaceDir, ".claude", "settings.local.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.mcpServers).toBeUndefined();

    // .mcp.json should have the libi server definition
    const mcpJsonPath = path.join(workspaceDir, ".mcp.json");
    expect(fs.existsSync(mcpJsonPath)).toBe(true);
    const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
    expect(mcpJson.mcpServers.libi).toBeDefined();
    // Runs mcp/index.ts via tsx's CLI entry point (node_modules/tsx/dist/cli.mjs)
    // through a plain `node` — not node_modules/.bin/tsx, which packaged
    // Electron builds never ship (see lib/mcp-config.ts#buildLibiEntry).
    expect(mcpJson.mcpServers.libi.command).toMatch(/(^|[\\/])node(\.exe)?$/);
    expect(mcpJson.mcpServers.libi.args).toEqual(
      expect.arrayContaining([
        expect.stringContaining(path.join("node_modules", "tsx", "dist", "cli.mjs")),
        expect.stringContaining("mcp/index.ts"),
      ])
    );
  });
});

describe("prepareAgentDir — connected (merge) mode", () => {
  let tempHome: string;
  let connectedDir: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "libi-test-"));
    connectedDir = path.join(tempHome, "user-proj");
    fs.mkdirSync(connectedDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("creates CLAUDE.md with markers when missing", async () => {
    await prepareAgentDir(connectedDir);
    const content = fs.readFileSync(path.join(connectedDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain(AGENT_MARKER_START);
    expect(content).toContain(AGENT_MARKER_END);
  });

  it("preserves user content outside the markers on re-run", async () => {
    fs.writeFileSync(path.join(connectedDir, "CLAUDE.md"), "# My own rules\n");
    await prepareAgentDir(connectedDir);
    await prepareAgentDir(connectedDir); // idempotent second run
    const content = fs.readFileSync(path.join(connectedDir, "CLAUDE.md"), "utf-8");
    expect(content.startsWith("# My own rules")).toBe(true);
    expect(content.indexOf(AGENT_MARKER_START)).toBe(
      content.lastIndexOf(AGENT_MARKER_START),
    );
  });

  it("plain-overwrites at the DEFAULT agent dir (owned mode, no markers)", async () => {
    const { getLibiAgentDir } = await import("@/lib/libi-home");
    const defaultDir = getLibiAgentDir(); // isolated under the vitest temp home
    await prepareAgentDir(defaultDir);
    const content = fs.readFileSync(path.join(defaultDir, "CLAUDE.md"), "utf-8");
    expect(content).not.toContain(AGENT_MARKER_START);
  });
});
