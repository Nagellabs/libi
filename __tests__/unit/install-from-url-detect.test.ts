import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  detectCandidate,
  parseGithubUrl,
} from "@/lib/install-from-url/detect";

const VALID_SKILL_MD = `---
name: my-skill
description: A test skill.
---

# My Skill

Body content.
`;

const VALID_SKILL_MD_NAMED = (name: string) => `---
name: ${name}
description: A test skill.
---

Body.
`;

const VALID_PLUGIN_JSON = JSON.stringify({
  name: "test-plugin",
  version: "1.0.0",
  description: "Test",
  skills: ["skills/a"],
  mcpServers: {
    foo: { command: "node", args: ["foo.js"] },
  },
});

describe("parseGithubUrl", () => {
  it("parses plain https://github.com/owner/repo", () => {
    expect(parseGithubUrl("https://github.com/anthropic/claude")).toEqual({
      owner: "anthropic",
      repo: "claude",
    });
  });

  it("parses /tree/<ref>/sub/path", () => {
    expect(
      parseGithubUrl("https://github.com/anthropic/claude/tree/dev/foo/bar"),
    ).toEqual({
      owner: "anthropic",
      repo: "claude",
      ref: "dev",
      subPath: "foo/bar",
    });
  });

  it("parses git@github.com:owner/repo.git", () => {
    expect(parseGithubUrl("git@github.com:anthropic/claude.git")).toEqual({
      owner: "anthropic",
      repo: "claude",
    });
  });

  it("strips trailing .git on https", () => {
    expect(parseGithubUrl("https://github.com/anthropic/claude.git")).toEqual({
      owner: "anthropic",
      repo: "claude",
    });
  });

  it("returns null for invalid host", () => {
    expect(parseGithubUrl("https://gitlab.com/owner/repo")).toBeNull();
  });

  it("returns null for missing repo", () => {
    expect(parseGithubUrl("https://github.com/owner")).toBeNull();
  });

  it("returns null for nonsense input", () => {
    expect(parseGithubUrl("not a url")).toBeNull();
    expect(parseGithubUrl("")).toBeNull();
  });
});

describe("detectCandidate", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "libi-detect-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("detects a single-skill repo at root", async () => {
    await fs.writeFile(path.join(tmp, "SKILL.md"), VALID_SKILL_MD);
    const result = await detectCandidate(tmp);
    expect(result.kind).toBe("single-skill");
    if (result.kind === "single-skill") {
      expect(result.name).toBe("my-skill");
      expect(result.skillPath).toBe(".");
    }
  });

  it("detects a multi-skill repo via skills/<name>/SKILL.md", async () => {
    await fs.mkdir(path.join(tmp, "skills", "alpha"), { recursive: true });
    await fs.mkdir(path.join(tmp, "skills", "beta"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, "skills", "alpha", "SKILL.md"),
      VALID_SKILL_MD_NAMED("alpha-skill"),
    );
    await fs.writeFile(
      path.join(tmp, "skills", "beta", "SKILL.md"),
      VALID_SKILL_MD_NAMED("beta-skill"),
    );

    const result = await detectCandidate(tmp);
    expect(result.kind).toBe("multi-skill");
    if (result.kind === "multi-skill") {
      const names = result.skills.map((s) => s.name).sort();
      expect(names).toEqual(["alpha-skill", "beta-skill"]);
      const relPaths = result.skills.map((s) => s.relPath).sort();
      expect(relPaths).toEqual(["skills/alpha", "skills/beta"]);
    }
  });

  it("detects a claude-plugin via .claude-plugin/plugin.json", async () => {
    await fs.mkdir(path.join(tmp, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".claude-plugin", "plugin.json"),
      VALID_PLUGIN_JSON,
    );
    const result = await detectCandidate(tmp);
    expect(result.kind).toBe("claude-plugin");
    if (result.kind === "claude-plugin") {
      expect(result.manifest.name).toBe("test-plugin");
      expect(result.manifest.skills).toEqual(["skills/a"]);
      expect(result.manifest.mcpServers?.foo?.command).toBe("node");
    }
  });

  it("returns unknown when nothing matches", async () => {
    await fs.writeFile(path.join(tmp, "README.md"), "# nothing here");
    const result = await detectCandidate(tmp);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.reason).toContain("no SKILL.md or plugin.json found");
    }
  });

  it("prefers claude-plugin over a SKILL.md sibling", async () => {
    // If both shapes exist, plugin wins because the manifest is authoritative.
    await fs.writeFile(path.join(tmp, "SKILL.md"), VALID_SKILL_MD);
    await fs.mkdir(path.join(tmp, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".claude-plugin", "plugin.json"),
      VALID_PLUGIN_JSON,
    );
    const result = await detectCandidate(tmp);
    expect(result.kind).toBe("claude-plugin");
  });

  it("returns unknown when plugin.json is malformed JSON", async () => {
    await fs.mkdir(path.join(tmp, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".claude-plugin", "plugin.json"),
      "{ not valid json",
    );
    const result = await detectCandidate(tmp);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.reason).toContain("failed to parse");
    }
  });
});
