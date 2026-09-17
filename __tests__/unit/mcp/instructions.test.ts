import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getInstructions, getInstructionContent } from "@/mcp/instructions";
import {
  createTempStorageDir,
  cleanupTempDir,
} from "@/__tests__/helpers/test-storage";

beforeEach(() => {
  createTempStorageDir();
});

afterEach(() => {
  cleanupTempDir();
});

describe("getInstructions", () => {
  it("returns a non-empty string containing the start marker", () => {
    const content = getInstructions();
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("<!-- libi-instructions-start");
  });

  it("returns content containing the end marker", () => {
    const content = getInstructions();
    expect(content).toContain("<!-- libi-instructions-end -->");
  });
});

describe("getInstructionContent", () => {
  it("returns content without the markers", () => {
    const content = getInstructionContent();
    expect(content).not.toMatch(/^<!-- libi-instructions-start/);
    expect(content).not.toContain("<!-- libi-instructions-end -->");
  });

  it("returns non-empty content", () => {
    const content = getInstructionContent();
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("libi.add_overlay");
  });
});
