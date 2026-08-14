import { describe, it, expect } from "vitest";
import { matchesQuery, mergeByName, matchesTags } from "@/components/mcps-skills/skills-view";

describe("skills-view matchesQuery (body search)", () => {
  const skill = {
    name: "doc-summarizer",
    description: "Summarizes long documents",
    body: "---\nname: doc-summarizer\ndescription: Summarizes long documents\n---\n\n# How to summarize a PDF\n\nUse the chunking strategy ...",
  };

  it("matches by name", () => {
    expect(matchesQuery(skill, "doc")).toBe(true);
  });

  it("matches by description", () => {
    expect(matchesQuery(skill, "documents")).toBe(true);
  });

  it("matches by body content (deferred-from-A2 case)", () => {
    expect(matchesQuery(skill, "chunking")).toBe(true);
    expect(matchesQuery(skill, "PDF")).toBe(true); // case-insensitive
  });

  it("returns false when nothing matches", () => {
    expect(matchesQuery(skill, "video")).toBe(false);
  });

  it("returns true on empty query", () => {
    expect(matchesQuery(skill, "")).toBe(true);
  });

  it("handles missing body gracefully (bundled skills have body=null)", () => {
    const bundled = { name: "a", description: "b", body: null };
    expect(matchesQuery(bundled, "anything")).toBe(false);
    expect(matchesQuery(bundled, "a")).toBe(true);
  });
});

describe("mergeByName", () => {
  it("keeps the user skill when a user and bundled share a name", () => {
    const merged = mergeByName([
      { id: "b", name: "x", source: "bundled", enabled: true, description: "", body: null, tags: [], prompts: [] },
      { id: "u", name: "x", source: "user", enabled: true, description: "", body: "y", tags: [], prompts: [] },
    ] as never);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("u");
    expect(merged[0].overriddenFromBundled).toBe(true);
  });
  it("leaves a standalone bundled skill un-flagged", () => {
    const merged = mergeByName([
      { id: "b", name: "y", source: "bundled", enabled: true, description: "", body: null, tags: [], prompts: [] },
    ] as never);
    expect(merged[0].overriddenFromBundled).toBeFalsy();
  });
});

describe("matchesTags", () => {
  const s = { tags: ["ugc", "video"] } as never;
  it("matches when any selected tag is present (OR), or none selected", () => {
    expect(matchesTags(s, ["audio", "ugc"])).toBe(true);
    expect(matchesTags(s, [])).toBe(true);
    expect(matchesTags(s, ["audio"])).toBe(false);
  });
});
