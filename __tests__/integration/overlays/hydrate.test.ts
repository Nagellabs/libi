import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { hydrateOverlayCode, stripOverlayCode } from "@/lib/overlays/hydrate";
import { writeOverlayCode } from "@/lib/overlays/code-files";
import { getOverlayBody } from "@/lib/overlays/code-fields";
import type { CompositionManifest, PersistedOverlay } from "@/lib/composition/persistence";

function mkManifest(ov: PersistedOverlay[]): CompositionManifest {
  return { width: 1920, height: 1080, fps: 30, overlays: ov };
}
const three = (body: string): PersistedOverlay => ({ id: "three-1", kind: "three", startTime: 0, duration: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1, sceneFunction: body });

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

describe("hydrate/strip overlay code", () => {
  beforeEach(() => { tempDir = createTempStorageDir(); });
  afterEach(() => cleanupTempDir(tempDir));

  it("hydrates body from file", async () => {
    const o = three("");
    await writeOverlayCode("piece1", three("FROM FILE"));
    const m = mkManifest([o]);
    await hydrateOverlayCode("piece1", m);
    expect(getOverlayBody(m.overlays![0])).toBe("FROM FILE");
  });

  it("strictly file-only: a missing file yields an empty body (no inline fallback)", async () => {
    const m = mkManifest([three("INLINE SHOULD BE IGNORED")]);
    await hydrateOverlayCode("piece1", m); // no file on disk
    expect(getOverlayBody(m.overlays![0])).toBe(""); // inline body is NOT kept, NOT migrated
  });

  it("strip empties the body in the returned clone but not the original", () => {
    const m = mkManifest([three("KEEP ON DISK")]);
    const stripped = stripOverlayCode(m);
    expect(getOverlayBody(stripped.overlays![0])).toBe("");
    expect(getOverlayBody(m.overlays![0])).toBe("KEEP ON DISK"); // original untouched
  });
});
