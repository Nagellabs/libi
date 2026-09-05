import { describe, it, expect } from "vitest";
import { loadBundledTemplate } from "@/lib/instructions/bundled-template";

const doc = loadBundledTemplate();

/**
 * Returns the text from `heading` (inclusive) up to the next occurrence of
 * `stopPrefix`, or "" if `heading` isn't present. Deliberately returns ""
 * rather than throwing on a missing heading so that a mutation which removes
 * a subsection fails only the assertions scoped to that subsection, not every
 * test in the file.
 */
function sectionUntil(source: string, heading: string, stopPrefix: string): string {
  const startIdx = source.indexOf(heading);
  if (startIdx === -1) return "";
  const searchFrom = startIdx + heading.length;
  const stopIdx = source.indexOf(stopPrefix, searchFrom);
  return stopIdx === -1 ? source.slice(startIdx) : source.slice(startIdx, stopIdx);
}

// Scope every assertion below to the actual new subsections rather than the
// whole 1300+ line document — several of the phrases checked here (e.g.
// "9:16", "fal-ai") also appear elsewhere in the doc for unrelated reasons,
// so asserting against `doc` would pass even if this guidance were deleted.
const canvasSection = sectionUntil(doc, "## Canvas Dimensions", "\n## ");
const beforeGenerating = sectionUntil(
  canvasSection,
  "### Before generating AI video or images",
  "\n### "
);
const newPieces = sectionUntil(canvasSection, "### New pieces", "\n### ");

describe("Canvas Dimensions guidance", () => {
  it("still has exactly one Canvas Dimensions section", () => {
    // The rule belongs in the section that already exists. A second one would
    // give the agent two places to look and let them drift apart.
    const matches = doc.match(/^## Canvas Dimensions$/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("requires knowing the ratio before generating AI media", () => {
    expect(beforeGenerating).toMatch(/before generating/i);
    expect(beforeGenerating).toContain("aspect_ratio");
  });

  it("tells the agent to set the canvas when creating a new piece", () => {
    expect(newPieces).toMatch(/new piece/i);
    expect(newPieces).toContain("9:16");
  });

  it("names the read tool as the way to learn the ratio", () => {
    expect(beforeGenerating).toContain("libi.retrieve_assets_dimensions");
  });

  it("explains that generation MCPs are not intercepted", () => {
    // The agent has to understand WHY it must pass aspect_ratio itself.
    expect(beforeGenerating).toMatch(/fal-ai|generation MCP/i);
  });
});
