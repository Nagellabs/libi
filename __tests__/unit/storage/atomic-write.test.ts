// __tests__/unit/storage/atomic-write.test.ts
//
// LocalFileStorage.save must be ATOMIC: a concurrent reader (e.g. loadManifest's
// readFile + JSON.parse) overlapping a writer must always see a COMPLETE file —
// never a truncated/partial one. A plain `fs.writeFile` truncates-then-writes,
// leaving a window where a concurrent read parses half a file and throws — the
// overlay-drag "commit failed: 500" the inspector hit on rapid X/Y slider drags.
import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { getStorage, resetStorage } from "@/lib/storage";

afterEach(() => cleanupTempDir());

describe("LocalFileStorage atomic save", () => {
  it("interleaved saves + reads never yield a torn/partial JSON file", async () => {
    createTempStorageDir();
    resetStorage();
    const s = await getStorage();

    // Distinct, large-ish payloads so a truncated read would be obvious.
    const payload = (n: number) =>
      Buffer.from(JSON.stringify({ n, blob: "x".repeat(20_000) }), "utf-8");

    // Seed the file so the first reads have something complete to find.
    await s.save("p1", "composition.json", payload(0));

    // Hammer the same file with many concurrent writes while concurrently
    // reading + JSON.parsing it. Every read must parse cleanly to a known shape.
    const writes = Array.from({ length: 40 }, (_, i) =>
      s.save("p1", "composition.json", payload(i + 1)),
    );
    const reads = Array.from({ length: 80 }, async () => {
      const buf = await s.read("p1", "composition.json");
      const obj = JSON.parse(buf.toString("utf-8")) as { n: number; blob: string };
      // Must be one of the complete payloads — never truncated.
      expect(obj.blob.length).toBe(20_000);
      expect(typeof obj.n).toBe("number");
      return obj.n;
    });

    // If save were non-atomic, at least one read would throw a SyntaxError here.
    await expect(Promise.all([...writes, ...reads])).resolves.toBeDefined();
  });

  it("does not leave .tmp- files behind and hides any in-flight temp from list()", async () => {
    createTempStorageDir();
    resetStorage();
    const s = await getStorage();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        s.save("p2", "composition.json", Buffer.from(`{"n":${i}}`)),
      ),
    );
    const entries = await s.list("p2");
    expect(entries).toContain("composition.json");
    expect(entries.some((e) => e.includes(".tmp-"))).toBe(false);
  });
});
