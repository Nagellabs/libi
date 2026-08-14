import { describe, it, expect } from "vitest";
import { parseSkillBody, serializeSkillBody, frontmatterSchema } from "@/mcp/skills/frontmatter";

const VALID = `---
name: ai-asset-generation
description: Generate AI images, videos, audio.
when_to_use: User asks to generate or create an image, video, or audio clip.
allowed-tools:
  - libi.list_mcp_servers
---

Body line one.

Body line two.
`;

describe("parseSkillBody", () => {
  it("parses valid frontmatter and body", () => {
    const { frontmatter, body } = parseSkillBody(VALID);
    expect(frontmatter.name).toBe("ai-asset-generation");
    expect(frontmatter.description).toMatch(/Generate AI/);
    expect(frontmatter.when_to_use).toMatch(/User asks/);
    expect(frontmatter["allowed-tools"]).toEqual(["libi.list_mcp_servers"]);
    expect(body.trim().startsWith("Body line one.")).toBe(true);
  });

  it("rejects body with no frontmatter", () => {
    expect(() => parseSkillBody("just markdown\n")).toThrow(/frontmatter/i);
  });

  it("rejects frontmatter missing required fields", () => {
    const bad = `---\ndescription: only desc\n---\nbody\n`;
    expect(() => parseSkillBody(bad)).toThrow(/name/);
  });

  it("rejects name with spaces or uppercase", () => {
    const bad = `---\nname: Bad Name\ndescription: x\n---\nbody\n`;
    expect(() => parseSkillBody(bad)).toThrow(/kebab-case/);
  });

  it("rejects name longer than 64 chars", () => {
    const bad = `---\nname: ${"x".repeat(65)}\ndescription: x\n---\nbody\n`;
    expect(() => parseSkillBody(bad)).toThrow(/64/);
  });
});

describe("serializeSkillBody", () => {
  it("round-trips through parse", () => {
    const { frontmatter, body } = parseSkillBody(VALID);
    const serialized = serializeSkillBody(frontmatter, body);
    const reparsed = parseSkillBody(serialized);
    expect(reparsed.frontmatter.name).toBe(frontmatter.name);
    expect(reparsed.body.trim()).toBe(body.trim());
  });
});

describe("frontmatterSchema", () => {
  it("accepts minimal valid object", () => {
    expect(() =>
      frontmatterSchema.parse({ name: "x", description: "x" }),
    ).not.toThrow();
  });
});

describe("frontmatter tags", () => {
  const base = (extra: string) =>
    `---\nname: demo\ndescription: d\n${extra}\n---\nbody`;

  it("parses a YAML list of tags", () => {
    const { frontmatter } = parseSkillBody(base("tags:\n  - ugc\n  - video"));
    expect(frontmatter.tags).toEqual(["ugc", "video"]);
  });

  it("parses a comma-separated tags string", () => {
    const { frontmatter } = parseSkillBody(base("tags: ugc, video"));
    expect(frontmatter.tags).toEqual(["ugc", "video"]);
  });

  it("defaults missing tags to an empty array", () => {
    const { frontmatter } = parseSkillBody("---\nname: demo\ndescription: d\n---\nbody");
    expect(frontmatter.tags).toEqual([]);
  });
});
