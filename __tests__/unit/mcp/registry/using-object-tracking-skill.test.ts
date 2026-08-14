import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SKILL_PATH = path.resolve(
  __dirname,
  "../../../../mcp/skills/using-object-tracking/SKILL.md",
);

describe("using-object-tracking SKILL.md", () => {
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(SKILL_PATH, "utf8");
  });

  it("documents the base-video requirement", () => {
    expect(content).toMatch(/base video/i);
  });

  it("references the real add_overlay tool name for placing the base video", () => {
    expect(content).toMatch(/libi\.add_overlay/);
  });

  it("explains that tracked overlays render on top of the base video", () => {
    expect(content).toMatch(/on top of/i);
  });

  // --- merged from the deleted tracking-overlay skill (single source of truth) ---

  it("absorbed the overlay skill: covers anchors + derivedFromSubjectName", () => {
    expect(content).toMatch(/analysis_search_frames/);
    expect(content).toMatch(/derivedFromSubjectName/);
  });

  it("uses the lazy-engine install contract, NOT the legacy chromium/mediapipe gate", () => {
    expect(content).toMatch(/tracking_engine_not_installed/);
    expect(content).toMatch(/verify_install/);
    // The stale dependency gate must not come back.
    expect(content).not.toMatch(/list_bundled_mcps/);
  });

  it("does not reference plan-spec tool names that don't exist", () => {
    expect(content).not.toMatch(/analysis_finalize/);
    expect(content).not.toMatch(/analysis_extract_frame_at/);
  });

  it("keeps the face path on objectKind:'face' + fit:'tight' (no fit:head-for-faces drift)", () => {
    expect(content).toMatch(/objectKind:"face"/);
    expect(content).toMatch(/fit:"tight"/);
    // Tolerate Markdown line-wrapping inside the phrase.
    expect(content).toMatch(/NOT the\s+face path/);
  });

  it("states the local engine is the default and SAM2 is opt-in paid only", () => {
    expect(content).toMatch(/default tracker/i);
    expect(content).toMatch(/SAM2/);
    expect(content).toMatch(/paid/i);
  });
});
