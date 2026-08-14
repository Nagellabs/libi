// __tests__/unit/storage/realpath-symlink-escape.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { LocalFileStorage } from "@/lib/storage/local";

let tempBase: string | undefined;
let secretDir: string | undefined;

afterEach(() => {
  if (tempBase) {
    fs.rmSync(tempBase, { recursive: true, force: true });
    tempBase = undefined;
  }
  if (secretDir) {
    fs.rmSync(secretDir, { recursive: true, force: true });
    secretDir = undefined;
  }
});

describe("LocalFileStorage realpath containment for HTTP-served reads", () => {
  it("refuses a symlink planted inside a piece dir that points outside it", async () => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "libi-realpath-"));
    secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-secret-"));
    const secretFile = path.join(secretDir, "id_rsa");
    fs.writeFileSync(secretFile, "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n");

    const storage = new LocalFileStorage(tempBase);
    const pieceId = "piece1";
    const pieceDir = path.join(tempBase, pieceId);
    fs.mkdirSync(pieceDir, { recursive: true });

    // Plant a symlink INSIDE the piece dir pointing OUTSIDE the storage root.
    // The lexical resolve+startsWith check in `localPath` sees a well-formed
    // in-bounds path and passes it — only realpath sees through the symlink.
    const linkPath = path.join(pieceDir, "leak.mp4");
    fs.symlinkSync(secretFile, linkPath);

    // Lexical check alone (existing `localPath`) does NOT catch this — confirms
    // the two checks are doing different jobs, not duplicating one another.
    expect(() => storage.localPath(pieceId, "leak.mp4")).not.toThrow();

    await expect(storage.realPathForRead(pieceId, "leak.mp4")).rejects.toThrow(
      /escapes piece directory/,
    );
  });

  it("still resolves a normal, non-symlinked file inside the piece dir", async () => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "libi-realpath-ok-"));
    const storage = new LocalFileStorage(tempBase);
    await storage.save("piece1", "clip.mp4", Buffer.from("data"));

    const real = await storage.realPathForRead("piece1", "clip.mp4");
    expect(fs.realpathSync(real)).toBe(real);
    expect(fs.readFileSync(real, "utf-8")).toBe("data");
  });
});
