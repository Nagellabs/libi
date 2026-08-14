import { describe, it, expect } from "vitest";
import { extractSections, slugifyHeading } from "@/lib/instructions/toc";

describe("slugifyHeading", () => {
  it("lowercases, strips punctuation, hyphenates", () => {
    expect(slugifyHeading("MCP Tools")).toBe("mcp-tools");
    expect(slugifyHeading("Remove vs. Delete")).toBe("remove-vs-delete");
    expect(slugifyHeading("Memories & self-improvement")).toBe("memories-self-improvement");
  });
});

describe("extractSections", () => {
  it("extracts ## headings with ids, ignoring other levels", () => {
    const md = "# Title\n\n## First Section\n\ntext\n\n### Sub\n\n## Second Section\n";
    expect(extractSections(md)).toEqual([
      { id: "first-section", title: "First Section", line: 3 },
      { id: "second-section", title: "Second Section", line: 9 },
    ]);
  });

  it("ignores ## inside fenced code blocks", () => {
    const md = "## Real\n\n```bash\n## not a heading\n```\n\n## Also Real\n";
    expect(extractSections(md).map((s) => s.title)).toEqual(["Real", "Also Real"]);
  });

  it("dedupes repeated heading ids with a numeric suffix", () => {
    const md = "## Setup\n\n## Setup\n";
    expect(extractSections(md).map((s) => s.id)).toEqual(["setup", "setup-1"]);
  });

  it("strips backticks from titles", () => {
    const md = "## The `DrawContext`\n";
    expect(extractSections(md)).toEqual([
      { id: "the-drawcontext", title: "The DrawContext", line: 1 },
    ]);
  });
});
