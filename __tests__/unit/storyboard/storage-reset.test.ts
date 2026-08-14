import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { getStorage, resetStorage } from "@/lib/storage";

afterEach(() => cleanupTempDir());

describe("resetStorage", () => {
  it("rebinds the storage singleton to the current LIBI_HOME", async () => {
    createTempStorageDir();
    const a = await getStorage();
    resetStorage();
    const b = await getStorage();
    expect(b).not.toBe(a); // fresh instance after reset
  });
});
