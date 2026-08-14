import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { computeSkillDirDigest, listChangedFiles } from "@/mcp/skills/digest";

describe("computeSkillDirDigest", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-digest-"));
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: a\n---\nbody");
    fs.mkdirSync(path.join(dir, "prompts"));
    fs.writeFileSync(path.join(dir, "prompts", "hook.md"), "hook v1");
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is stable for identical content", () => {
    expect(computeSkillDirDigest(dir)).toBe(computeSkillDirDigest(dir));
  });

  it("changes when SKILL.md changes", () => {
    const before = computeSkillDirDigest(dir);
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: a\n---\nbody v2");
    expect(computeSkillDirDigest(dir)).not.toBe(before);
  });

  it("changes when a prompt file changes", () => {
    const before = computeSkillDirDigest(dir);
    fs.writeFileSync(path.join(dir, "prompts", "hook.md"), "hook v2");
    expect(computeSkillDirDigest(dir)).not.toBe(before);
  });

  it("changes when a file is added or removed", () => {
    const before = computeSkillDirDigest(dir);
    fs.writeFileSync(path.join(dir, "extra.md"), "x");
    const withExtra = computeSkillDirDigest(dir);
    expect(withExtra).not.toBe(before);
    fs.rmSync(path.join(dir, "extra.md"));
    expect(computeSkillDirDigest(dir)).toBe(before);
  });

  it("skips symlinks (same policy as loader)", () => {
    const before = computeSkillDirDigest(dir);
    fs.symlinkSync("/etc/hosts", path.join(dir, "link.md"));
    expect(computeSkillDirDigest(dir)).toBe(before);
  });
});

describe("listChangedFiles", () => {
  let base: string;
  let current: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "skill-base-"));
    current = fs.mkdtempSync(path.join(os.tmpdir(), "skill-cur-"));
    for (const d of [base, current]) {
      fs.writeFileSync(path.join(d, "SKILL.md"), "same");
      fs.mkdirSync(path.join(d, "prompts"));
      fs.writeFileSync(path.join(d, "prompts", "hook.md"), "same");
    }
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(current, { recursive: true, force: true });
  });

  it("returns [] for identical trees", () => {
    expect(listChangedFiles(base, current)).toEqual([]);
  });

  it("reports modified, added, and removed files by relative path", () => {
    fs.writeFileSync(path.join(current, "SKILL.md"), "changed");
    fs.writeFileSync(path.join(current, "prompts", "new.md"), "added");
    fs.rmSync(path.join(base, "prompts", "hook.md"));
    expect(listChangedFiles(base, current).sort()).toEqual(
      ["SKILL.md", path.join("prompts", "hook.md"), path.join("prompts", "new.md")].sort(),
    );
  });
});
