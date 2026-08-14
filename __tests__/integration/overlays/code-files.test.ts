import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { writeOverlayCode, readOverlayCode, listOverlayDirs, deleteOverlayDir } from "@/lib/overlays/code-files";
import type { PersistedOverlay } from "@/lib/composition/persistence";

const codeOverlay: PersistedOverlay = { id: "code-x", kind: "code", startTime: 0, duration: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1, drawFunction: "ctx.fillRect(0,0,5,5)" };

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

describe("overlay code files", () => {
  beforeEach(() => { tempDir = createTempStorageDir(); });
  afterEach(() => cleanupTempDir(tempDir));

  it("writes then reads a body", async () => {
    await writeOverlayCode("piece1", codeOverlay);
    expect(await readOverlayCode("piece1", codeOverlay)).toBe("ctx.fillRect(0,0,5,5)");
  });

  it("returns empty string when the file is missing", async () => {
    expect(await readOverlayCode("piece1", codeOverlay)).toBe("");
  });

  it("lists and deletes overlay dirs", async () => {
    await writeOverlayCode("piece1", codeOverlay);
    expect(await listOverlayDirs("piece1")).toContain("code-x");
    await deleteOverlayDir("piece1", "code-x");
    expect(await listOverlayDirs("piece1")).not.toContain("code-x");
  });
});
