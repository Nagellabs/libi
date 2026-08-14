import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  getInstructions,
  getInstructionContent,
  upsertInstructions,
  parseInstructionVersion,
} from "@/mcp/instructions";
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
    expect(content).toContain("libi.create_scene");
  });
});

describe("parseInstructionVersion", () => {
  it("extracts version from a valid start marker", () => {
    const content = "<!-- libi-instructions-start v1.0.0 -->\nsome content";
    expect(parseInstructionVersion(content)).toBe("1.0.0");
  });

  it("extracts multi-digit version", () => {
    const content = "<!-- libi-instructions-start v12.34.56 -->\nstuff";
    expect(parseInstructionVersion(content)).toBe("12.34.56");
  });

  it("returns null when no marker is present", () => {
    expect(parseInstructionVersion("just some text")).toBeNull();
    expect(parseInstructionVersion("")).toBeNull();
  });
});

describe("upsertInstructions", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempStorageDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("creates the file with markers when it does not exist", () => {
    const filePath = path.join(tempDir, "NEW.md");
    expect(fs.existsSync(filePath)).toBe(false);

    upsertInstructions(filePath);

    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("<!-- libi-instructions-start");
    expect(content).toContain("<!-- libi-instructions-end -->");
    expect(content).toContain("libi.create_scene");
  });

  it("replaces the block between existing markers", () => {
    const filePath = path.join(tempDir, "EXISTING.md");
    const before = "# My Project\n\nSome custom content\n\n";
    const oldBlock =
      "<!-- libi-instructions-start v0.0.1 -->\nOLD INSTRUCTIONS\n<!-- libi-instructions-end -->";
    const after = "\n\n# More stuff below";
    fs.writeFileSync(filePath, before + oldBlock + after);

    upsertInstructions(filePath);

    const content = fs.readFileSync(filePath, "utf-8");
    // Custom content before and after is preserved
    expect(content).toContain("# My Project");
    expect(content).toContain("Some custom content");
    expect(content).toContain("# More stuff below");
    // Old block is replaced
    expect(content).not.toContain("OLD INSTRUCTIONS");
    expect(content).not.toContain("v0.0.1");
    // New instructions present
    expect(content).toContain("libi.create_scene");
  });

  it("appends with separator when file exists without markers", () => {
    const filePath = path.join(tempDir, "NO_MARKERS.md");
    const existingContent = "# My Custom CLAUDE.md\n\nThis is user content.\n";
    fs.writeFileSync(filePath, existingContent);

    upsertInstructions(filePath);

    const content = fs.readFileSync(filePath, "utf-8");
    // Original content preserved
    expect(content).toContain("# My Custom CLAUDE.md");
    expect(content).toContain("This is user content.");
    // Separator present
    expect(content).toContain("\n\n---\n\n");
    // New instructions appended
    expect(content).toContain("<!-- libi-instructions-start");
    expect(content).toContain("libi.create_scene");
  });

  it("does not duplicate when called twice on a file with markers", () => {
    const filePath = path.join(tempDir, "TWICE.md");

    // First upsert creates the file
    upsertInstructions(filePath);
    const firstContent = fs.readFileSync(filePath, "utf-8");

    // Second upsert should replace, not duplicate
    upsertInstructions(filePath);
    const secondContent = fs.readFileSync(filePath, "utf-8");

    expect(secondContent).toBe(firstContent);

    // Verify only one start marker
    const startCount = (
      secondContent.match(/<!-- libi-instructions-start/g) || []
    ).length;
    expect(startCount).toBe(1);

    // Verify only one end marker
    const endCount = (
      secondContent.match(/<!-- libi-instructions-end -->/g) || []
    ).length;
    expect(endCount).toBe(1);
  });

  it("does not duplicate when called twice on a file without initial markers", () => {
    const filePath = path.join(tempDir, "TWICE_APPEND.md");
    fs.writeFileSync(filePath, "# User content\n");

    // First upsert appends
    upsertInstructions(filePath);

    // Second upsert should replace the appended block, not append again
    upsertInstructions(filePath);
    const content = fs.readFileSync(filePath, "utf-8");

    const startCount = (
      content.match(/<!-- libi-instructions-start/g) || []
    ).length;
    expect(startCount).toBe(1);
  });
});
