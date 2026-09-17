import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { getLibiAgentDir } from "@/lib/libi-home";
import { prepareAgentDir, stripLegacyAgentDirFiles } from "@/mcp/workspace";

describe("prepareAgentDir (HTTP era)", () => {
  beforeEach(() => { createTestDb(); });

  it("writes .version and skills, and nothing else", async () => {
    const dir = getLibiAgentDir();
    await prepareAgentDir(dir);
    expect(fs.existsSync(path.join(dir, ".version"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".claude", "skills"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".agents", "skills"))).toBe(true);
    for (const f of ["CLAUDE.md", "AGENTS.md", ".mcp.json", path.join(".claude", "settings.local.json")]) {
      expect(fs.existsSync(path.join(dir, f))).toBe(false);
    }
  });

  it("stripLegacyAgentDirFiles removes the files older versions wrote and reports them", () => {
    const dir = getLibiAgentDir();
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    for (const f of ["CLAUDE.md", "AGENTS.md", ".mcp.json"]) fs.writeFileSync(path.join(dir, f), "x");
    fs.writeFileSync(path.join(dir, ".claude", "settings.local.json"), "{}");
    const removed = stripLegacyAgentDirFiles(dir);
    expect(removed.map((p) => path.relative(dir, p)).sort()).toEqual([".claude/settings.local.json", ".mcp.json", "AGENTS.md", "CLAUDE.md"]);
    expect(stripLegacyAgentDirFiles(dir)).toEqual([]);
  });
});
