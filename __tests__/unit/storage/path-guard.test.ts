// __tests__/unit/storage/path-guard.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { getStorage, resetStorage } from "@/lib/storage";

afterEach(() => cleanupTempDir());

describe("storage path containment", () => {
  it("allows nested paths within the piece dir", async () => {
    createTempStorageDir(); resetStorage();
    const s = await getStorage();
    expect(() => s.localPath("p1", "storyboard/cards/c1/card.json")).not.toThrow();
  });
  it("rejects parent-escaping paths", async () => {
    createTempStorageDir(); resetStorage();
    const s = await getStorage();
    expect(() => s.localPath("p1", "../../etc/passwd")).toThrow();
    await expect(s.read("p1", "../../etc/passwd")).rejects.toThrow();
  });
});
