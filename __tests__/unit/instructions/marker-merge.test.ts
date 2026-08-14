import { describe, it, expect } from "vitest";
import {
  mergeMarkerSection,
  AGENT_MARKER_START,
  AGENT_MARKER_END,
} from "@/lib/instructions/marker-merge";

describe("mergeMarkerSection", () => {
  it("creates a fresh marker-wrapped file when existing is null", () => {
    const out = mergeMarkerSection(null, "libi rules");
    expect(out).toBe(`${AGENT_MARKER_START}\nlibi rules\n${AGENT_MARKER_END}\n`);
  });

  it("treats an empty/whitespace file as fresh", () => {
    const out = mergeMarkerSection("  \n", "libi rules");
    expect(out).toBe(`${AGENT_MARKER_START}\nlibi rules\n${AGENT_MARKER_END}\n`);
  });

  it("replaces only the marked section, preserving user content around it", () => {
    const existing = `# My project\n\n${AGENT_MARKER_START}\nold\n${AGENT_MARKER_END}\n\n## My notes\n`;
    const out = mergeMarkerSection(existing, "new content");
    expect(out).toContain("# My project");
    expect(out).toContain("## My notes");
    expect(out).toContain("new content");
    expect(out).not.toContain("old\n");
  });

  it("appends a marker section to a file without markers", () => {
    const out = mergeMarkerSection("# My own CLAUDE.md\nrule A\n", "libi rules");
    expect(out.startsWith("# My own CLAUDE.md")).toBe(true);
    expect(out).toContain(`${AGENT_MARKER_START}\nlibi rules\n${AGENT_MARKER_END}`);
  });

  it("is idempotent — merging the same section twice yields identical bytes", () => {
    const once = mergeMarkerSection("# Mine\n", "libi rules");
    const twice = mergeMarkerSection(once, "libi rules");
    expect(twice).toBe(once);
  });
});
