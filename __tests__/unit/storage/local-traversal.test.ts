// __tests__/unit/storage/local-traversal.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { LocalFileStorage } from "@/lib/storage/local";

let tempBase: string | undefined;

afterEach(() => {
  if (tempBase) {
    fs.rmSync(tempBase, { recursive: true, force: true });
    tempBase = undefined;
  }
});

describe("LocalFileStorage pieceId traversal guard", () => {
  it("rejects a traversal pieceId and writes NOTHING outside baseDir", async () => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "libi-trav-"));
    const storage = new LocalFileStorage(tempBase);
    const bytes = Buffer.from("owned");

    // The escape target: <tempBase>/../agent/CLAUDE.md — a sibling of baseDir.
    const escapeTarget = path.resolve(tempBase, "..", "agent", "CLAUDE.md");

    await expect(storage.save("../agent", "CLAUDE.md", bytes)).rejects.toThrow();

    // Nothing was written outside baseDir.
    expect(fs.existsSync(escapeTarget)).toBe(false);
    expect(fs.existsSync(path.resolve(tempBase, "..", "agent"))).toBe(false);
  });

  it("rejects a deep traversal pieceId (../../ toward $HOME)", async () => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "libi-trav-"));
    const storage = new LocalFileStorage(tempBase);
    await expect(
      storage.save("../../evil", "x.txt", Buffer.from("x")),
    ).rejects.toThrow();
  });

  it("still writes normally for a valid pieceId", async () => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "libi-trav-"));
    const storage = new LocalFileStorage(tempBase);
    const pieceId = crypto.randomUUID();
    await storage.save(pieceId, "clip.mp4", Buffer.from("data"));
    expect(fs.existsSync(path.join(tempBase, pieceId, "clip.mp4"))).toBe(true);
  });

  it("still writes normally for the global (null) scope", async () => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "libi-trav-"));
    const storage = new LocalFileStorage(tempBase);
    await storage.save(null, "g.txt", Buffer.from("data"));
    expect(fs.existsSync(path.join(tempBase, "_global", "g.txt"))).toBe(true);
  });
});
