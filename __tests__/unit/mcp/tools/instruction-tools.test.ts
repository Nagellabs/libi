import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createTempStorageDir,
  cleanupTempDir,
} from "@/__tests__/helpers/test-storage";

vi.mock("@/mcp/notify", () => ({
  notify: { instructionsChanged: vi.fn() },
}));

import { updateMemories, overrideInstructions } from "@/mcp/tools/instruction-tools";
import { readMemories, writeMemories } from "@/lib/instructions/memories";
import { readInstructionsOverride } from "@/lib/instructions/override";
import { notify } from "@/mcp/notify";

let tempDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  tempDir = createTempStorageDir();
  prevHome = process.env.LIBI_HOME;
  process.env.LIBI_HOME = tempDir;
  vi.mocked(notify.instructionsChanged).mockClear();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = prevHome;
  cleanupTempDir(tempDir);
});

describe("updateMemories", () => {
  it("appends by default and notifies the server", async () => {
    writeMemories("existing\n");
    const result = await updateMemories({ content: "new memory" });
    expect(result.success).toBe(true);
    expect(readMemories()).toBe("existing\n\nnew memory\n");
    expect(notify.instructionsChanged).toHaveBeenCalledTimes(1);
  });

  it("replace mode rewrites the file", async () => {
    writeMemories("old stuff");
    const result = await updateMemories({ content: "## Fresh\n\nrewritten", mode: "replace" });
    expect(result.success).toBe(true);
    expect(readMemories()).toBe("## Fresh\n\nrewritten");
  });

  it("returns a structured error when the cap is exceeded (no notify)", async () => {
    writeMemories("x".repeat(7995));
    const result = await updateMemories({ content: "y".repeat(100) });
    expect(result.success).toBe(false);
    expect(notify.instructionsChanged).not.toHaveBeenCalled();
  });
});

describe("overrideInstructions", () => {
  it("creates the override and notifies", async () => {
    const result = await overrideInstructions({ content: "# Custom base instructions" });
    expect(result.success).toBe(true);
    expect(readInstructionsOverride()).toBe("# Custom base instructions");
    expect(notify.instructionsChanged).toHaveBeenCalledTimes(1);
  });

  it("rejects empty content with a structured error", async () => {
    const result = await overrideInstructions({ content: "   " });
    expect(result.success).toBe(false);
    expect(notify.instructionsChanged).not.toHaveBeenCalled();
  });
});
