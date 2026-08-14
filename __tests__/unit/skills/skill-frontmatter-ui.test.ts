import { describe, it, expect } from "vitest";
import {
  buildFrontmatter,
  buildSkillBody,
  splitSkillBody,
} from "@/lib/skills/skill-frontmatter";
import { parseSkillBody } from "@/mcp/skills/frontmatter";

describe("buildFrontmatter", () => {
  it("emits name, description, and an always-present tags array", () => {
    const fm = buildFrontmatter("my-skill", "Does a thing", "", ["a", "b"]);
    expect(fm).toContain('name: "my-skill"');
    expect(fm).toContain('description: "Does a thing"');
    expect(fm).toContain('tags: ["a", "b"]');
    expect(fm.startsWith("---")).toBe(true);
    expect(fm.trimEnd().endsWith("---")).toBe(true);
  });

  it("omits when_to_use when blank but always emits tags (even empty)", () => {
    const fm = buildFrontmatter("s", "d", "", []);
    expect(fm).not.toContain("when_to_use");
    expect(fm).toContain("tags: []");
  });

  it("includes when_to_use when provided", () => {
    const fm = buildFrontmatter("s", "d", "when X happens", ["t"]);
    expect(fm).toContain('when_to_use: "when X happens"');
  });
});

describe("server parser round-trip (tag-wipe guard)", () => {
  it("tags built by the client survive the server parseSkillBody", () => {
    // The content-update PATCH derives tags from frontmatter; if buildFrontmatter
    // ever dropped them the server would wipe the skill's tags on every save.
    const body = buildSkillBody("doc", "Summarize docs", "user asks", ["pdf", "summary"], "# Body\n");
    const { frontmatter } = parseSkillBody(body);
    expect(frontmatter.tags).toEqual(["pdf", "summary"]);
    expect(frontmatter.name).toBe("doc");
    expect(frontmatter.description).toBe("Summarize docs");
    expect(frontmatter.when_to_use).toBe("user asks");
  });

  it("empty tags parse back to an empty array (not undefined)", () => {
    const body = buildSkillBody("doc", "d", "", [], "# B\n");
    const { frontmatter } = parseSkillBody(body);
    expect(frontmatter.tags).toEqual([]);
  });

  it("escapes special characters so the YAML stays valid", () => {
    const body = buildSkillBody(
      "x",
      'Has "quotes": and colons',
      "",
      ["a"],
      "# B\n",
    );
    const { frontmatter } = parseSkillBody(body);
    expect(frontmatter.description).toBe('Has "quotes": and colons');
  });
});

describe("splitSkillBody", () => {
  it("round-trips the structured fields and markdown that buildSkillBody emits", () => {
    const body = buildSkillBody("my-skill", "Desc", "trigger", ["t1"], "# Heading\n\nText.\n");
    const split = splitSkillBody(body);
    expect(split.name).toBe("my-skill");
    expect(split.description).toBe("Desc");
    expect(split.whenToUse).toBe("trigger");
    expect(split.markdown.trim()).toBe("# Heading\n\nText.");
  });

  it("returns the raw text as markdown when there is no frontmatter", () => {
    const split = splitSkillBody("just some text");
    expect(split).toEqual({ name: "", description: "", whenToUse: "", markdown: "just some text" });
  });
});
