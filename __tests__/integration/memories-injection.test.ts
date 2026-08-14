import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTempStorageDir,
  cleanupTempDir,
} from "@/__tests__/helpers/test-storage";
import { writeMemories } from "@/lib/instructions/memories";
import { saveInstructionsOverride } from "@/lib/instructions/override";
import { getInstructions } from "@/mcp/instructions";

beforeEach(() => {
  createTempStorageDir();
});

afterEach(() => {
  cleanupTempDir();
});

describe("memories injection", () => {
  it("inlines memories between the memories markers under ## Memories", () => {
    writeMemories("PIN: ElevenLabs for STT");
    const out = getInstructions();
    expect(out).toContain("<!-- libi-memories-start -->");
    expect(out).toContain("## Memories");
    expect(out).toContain("PIN: ElevenLabs for STT");
    expect(out).toContain("<!-- libi-memories-end -->");
  });

  it("omits the Memories section when the file is empty/whitespace", () => {
    writeMemories("   ");
    expect(getInstructions()).not.toContain("## Memories\n");
  });

  it("omits the Memories section when the file does not exist", () => {
    expect(getInstructions()).not.toContain("<!-- libi-memories-start -->\n\n## Memories");
  });
});

describe("override resolution", () => {
  it("uses the override template when present", () => {
    saveInstructionsOverride(
      "<!-- libi-instructions-start v9.9.9 -->\nMY OVERRIDE BODY\n<!-- libi-memories-start -->\n<!-- libi-memories-end -->\n<!-- libi-instructions-end -->",
    );
    const out = getInstructions();
    expect(out).toContain("MY OVERRIDE BODY");
    expect(out).not.toContain("libi.create_scene");
  });

  it("appends memories at the end when the override lost ALL markers", () => {
    saveInstructionsOverride("just some custom text with no markers");
    writeMemories("never drop me");
    const out = getInstructions();
    expect(out).toContain("never drop me");
    expect(out.indexOf("never drop me")).toBeGreaterThan(out.indexOf("just some custom text"));
  });

  it("injects before the end marker when memories markers are missing but end marker exists", () => {
    saveInstructionsOverride("custom\n<!-- libi-instructions-end -->");
    writeMemories("mem-body");
    const out = getInstructions();
    expect(out.indexOf("mem-body")).toBeLessThan(out.indexOf("<!-- libi-instructions-end -->"));
  });
});
