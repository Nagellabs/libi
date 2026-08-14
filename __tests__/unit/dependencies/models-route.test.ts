import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "libi-models-test-"));
  process.env.LIBI_HOME = tmpHome;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("/api/models route", () => {
  it("serves a file from ~/.libi/models/", async () => {
    const modelsDir = path.join(tmpHome, "models", "face-api");
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.writeFileSync(path.join(modelsDir, "weights.bin"), "hello");

    const { GET } = await import("@/app/api/models/[...path]/route");
    const res = await GET(new Request("http://localhost/api/models/face-api/weights.bin"), {
      params: Promise.resolve({ path: ["face-api", "weights.bin"] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("hello");
  });

  it("rejects path traversal (..)", async () => {
    const { GET } = await import("@/app/api/models/[...path]/route");
    const res = await GET(new Request("http://localhost/api/models/..%2Fbin%2Fffmpeg"), {
      params: Promise.resolve({ path: ["..", "bin", "ffmpeg"] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 (not 500 EISDIR) when target is a directory", async () => {
    const modelsDir = path.join(tmpHome, "models", "face-api");
    fs.mkdirSync(modelsDir, { recursive: true });
    const { GET } = await import("@/app/api/models/[...path]/route");
    const res = await GET(new Request("http://localhost/api/models/face-api"), {
      params: Promise.resolve({ path: ["face-api"] }),
    });
    expect(res.status).toBe(404);
  });

  it("refuses a symlink planted inside the models dir that points outside it", async () => {
    // The lexical resolve()+startsWith() containment check above sees a
    // well-formed in-bounds path and passes it — only a realpath re-check
    // sees through a symlink to its actual target. Mirrors
    // __tests__/unit/storage/realpath-symlink-escape.test.ts for the
    // storage-backed routes.
    const modelsDir = path.join(tmpHome, "models", "face-api");
    fs.mkdirSync(modelsDir, { recursive: true });
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-secret-"));
    const secretFile = path.join(secretDir, "id_rsa");
    fs.writeFileSync(secretFile, "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n");
    try {
      fs.symlinkSync(secretFile, path.join(modelsDir, "leak.bin"));

      const { GET } = await import("@/app/api/models/[...path]/route");
      const res = await GET(new Request("http://localhost/api/models/face-api/leak.bin"), {
        params: Promise.resolve({ path: ["face-api", "leak.bin"] }),
      });
      expect(res.status).toBe(400);
    } finally {
      fs.rmSync(secretDir, { recursive: true, force: true });
    }
  });
});
