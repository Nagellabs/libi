import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  promptNameSchema,
  readPromptFiles,
  writePromptFile,
  removePromptFile,
  promptFileExists,
} from "@/mcp/skills/prompt-files";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-prompts-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("prompt-files", () => {
  it("rejects bad prompt names", () => {
    expect(promptNameSchema.safeParse("Hook").success).toBe(false);
    expect(promptNameSchema.safeParse("a/b").success).toBe(false);
    expect(promptNameSchema.safeParse("hook-1").success).toBe(true);
  });

  it("rejects path-traversal names on remove and exists", () => {
    expect(() => removePromptFile(dir, "../evil")).toThrow();
    expect(() => promptFileExists(dir, "../../etc/passwd")).toThrow();
  });

  it("writes, reads, and removes a prompt file", () => {
    writePromptFile(dir, "hook", "# Hook\nbody");
    expect(readPromptFiles(dir)).toEqual([{ relPath: "prompts/hook.md", body: "# Hook\nbody" }]);
    removePromptFile(dir, "hook");
    expect(readPromptFiles(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, "prompts"))).toBe(false);
  });
});
