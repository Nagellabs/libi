import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { prepareAgentDir, renderAgentInstructions } from "@/mcp/workspace";
import { LIBI_SKILL_VERSION } from "@/mcp/version";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import { EXTENSION_MCP_SERVERS } from "@/mcp/registry/bundled";
import { getInstructions } from "@/mcp/instructions";

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
});

describe("renderAgentInstructions", () => {
  // The byte-identical invariant is intentionally ended:
  // "claude" renders the claude dialect, "codex" renders the codex dialect.
  // Since the move to HTTP, prepareAgentDir no longer writes these to
  // CLAUDE.md / AGENTS.md — they're only returned by `libi.read_manual` — so
  // the divergence is asserted on the rendered strings directly.
  it("claude and codex dialects diverge, and both carry the instruction markers", () => {
    const claudeContent = renderAgentInstructions("claude");
    const agentsContent = renderAgentInstructions("codex");

    // They must NOT be byte-identical.
    expect(claudeContent).not.toBe(agentsContent);

    // The claude dialect keeps the "Skill tool" mechanic; the codex dialect
    // drops it and uses the codex progressive-disclosure wording.
    expect(claudeContent).toContain("via the Skill tool");
    expect(claudeContent).not.toContain("$using-storyboard");

    expect(agentsContent).not.toContain("via the Skill tool");
    expect(agentsContent).toContain("$using-storyboard");
    expect(agentsContent).toContain(".agents/skills");

    // Codex self-check block is codex-only.
    expect(agentsContent).toContain("Codex self-check");
    expect(agentsContent).toContain("npx @nagellabs/libi connect");
    expect(agentsContent).toContain("codex mcp list");
    expect(claudeContent).not.toContain("Codex self-check");

    // The shared body survives in both.
    expect(claudeContent).toContain("Libi Video Composition API");
    expect(agentsContent).toContain("Libi Video Composition API");

    // Both carry the instruction markers.
    expect(claudeContent).toContain("<!-- libi-instructions-start");
    expect(claudeContent).toContain("<!-- libi-instructions-end -->");
    expect(agentsContent).toContain("<!-- libi-instructions-start");
    expect(agentsContent).toContain("<!-- libi-instructions-end -->");

    // No unresolved dialect markers leak into either rendered string.
    expect(claudeContent).not.toContain("libi-agent:");
    expect(agentsContent).not.toContain("libi-agent:");
  });
});

/**
 * The half of `renderAgentInstructions` that is not the dialect: the
 * libi-extensions section, built from the `mcp_servers` rows and SPLICED IN
 * before the end marker rather than appended after it. The marker is what the
 * manual's own closing material sits behind, so a section that landed after it
 * would read as being outside the instructions.
 *
 * The section describes libi's OWN extensions only — a third-party
 * row (the user's provider MCP) is never described, whatever its state.
 */
describe("renderAgentInstructions — the extensions section", () => {
  const END_MARKER = "<!-- libi-instructions-end -->";
  const SECTION = "## libi extensions";
  const tracking = EXTENSION_MCP_SERVERS.find((d) => d.id === "libi-tracking")!;

  const row = (over: Record<string, unknown> = {}) => ({
    id: "fake-ai-assets",
    name: "fake-ai-assets",
    description: "Generates placeholder assets.",
    type: "stdio" as const,
    command: "node",
    args: JSON.stringify(["x.js"]),
    url: null,
    headers: null,
    bundled: false,
    enabled: true,
    requireApproval: false,
    installStatus: "installed",
    envVars: "{}",
    dependencyStatus: "[]",
    ...over,
  });

  beforeEach(() => { createTestDb(); });

  it("with no rows the render is the dialect template verbatim", () => {
    const rendered = renderAgentInstructions("claude");
    expect(rendered).toBe(getInstructions("claude"));
    expect(rendered).not.toContain(SECTION);
  });

  it("a third-party row is never described, even when it requires approval", () => {
    getDb().insert(mcpServers).values(row({ requireApproval: true })).run();
    const rendered = renderAgentInstructions("claude");
    expect(rendered).toBe(getInstructions("claude"));
    expect(rendered).not.toContain("fake-ai-assets");
  });

  it("an extension row that requires approval adds the section BEFORE the end marker", () => {
    getDb().insert(mcpServers).values(row({ id: tracking.id, name: tracking.name, bundled: true, requireApproval: true })).run();
    const rendered = renderAgentInstructions("claude");

    expect(rendered).not.toBe(getInstructions("claude"));
    expect(rendered).toContain(SECTION);
    expect(rendered).toContain(`**${tracking.name}**: ${tracking.description}`);
    expect(rendered).toContain("REQUIRES APPROVAL");
    for (const prefix of tracking.toolPrefixes) expect(rendered).toContain(prefix);
    // Spliced in, not appended: the section body precedes the end marker.
    expect(rendered.indexOf(SECTION)).toBeLessThan(rendered.indexOf(END_MARKER));
    // …and everything the template had is still there, in order.
    expect(rendered).toContain(END_MARKER);
  });

  it("both dialects get the same section", () => {
    getDb().insert(mcpServers).values(row({ id: tracking.id, name: tracking.name, bundled: true, requireApproval: true })).run();
    const claude = renderAgentInstructions("claude");
    const codex = renderAgentInstructions("codex");
    // The section is dialect-neutral — the only difference between the two
    // renders is the dialect template it is spliced into.
    const section = (text: string) =>
      text.slice(text.indexOf(SECTION), text.indexOf(END_MARKER));
    expect(section(claude)).toContain("REQUIRES APPROVAL");
    expect(section(claude)).toBe(section(codex));
  });

  it("install state never changes the section — availability is answered by the tools themselves", () => {
    getDb().insert(mcpServers).values(row({ id: tracking.id, name: tracking.name, bundled: true, requireApproval: true, installStatus: "failed", installError: "uv sync exploded" })).run();
    const rendered = renderAgentInstructions("claude");
    expect(rendered).toContain(SECTION);
    expect(rendered).not.toContain("unavailable");
    expect(rendered).not.toContain("uv sync exploded");
  });
});
