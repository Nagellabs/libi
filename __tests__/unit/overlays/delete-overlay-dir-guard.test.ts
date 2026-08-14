import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { writeOverlayCode, deleteOverlayDir } from "@/lib/overlays/code-files";
import type { PersistedOverlay } from "@/lib/composition/persistence";

const codeOverlay: PersistedOverlay = {
  id: "code-x",
  kind: "code",
  startTime: 0,
  duration: 1,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  z: 0,
  opacity: 1,
  drawFunction: "ctx.fillRect(0,0,5,5)",
};

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

describe("deleteOverlayDir empty-id guard", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("throws on an empty overlayId instead of wiping overlays/", async () => {
    // Seed a real overlay so there is something an unguarded call would destroy.
    await writeOverlayCode("piece1", codeOverlay);
    const overlaysDir = path.join(tempDir, "piece1", "overlays");
    expect(fs.existsSync(path.join(overlaysDir, "code-x"))).toBe(true);

    await expect(deleteOverlayDir("piece1", "")).rejects.toThrow(/overlayId/);

    // The whole overlays/ dir — and the sibling overlay it holds — must survive.
    expect(fs.existsSync(overlaysDir)).toBe(true);
    expect(fs.existsSync(path.join(overlaysDir, "code-x"))).toBe(true);
  });
});
