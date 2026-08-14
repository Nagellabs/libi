import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { createTestDb } from "../../helpers/test-db";

describe("multi-file installer", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-multi-"));
    process.env.LIBI_HOME = tmp;
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  });
  afterEach(() => {
    delete process.env.LIBI_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("downloads all files and verifies sha256 checksums", async () => {
    const body1 = "alpha";
    const body2 = "beta";
    const sha1 = crypto.createHash("sha256").update(body1).digest("hex");
    const sha2 = crypto.createHash("sha256").update(body2).digest("hex");

    global.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      const body = u.endsWith("/a.bin") ? body1 : body2;
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const mgr = new DependencyManager();
    await mgr.installMultiFile({
      binary: "test-pack",
      destination: "models",
      files: [
        { url: "https://x/a.bin", relPath: "a.bin", sha256: sha1 },
        { url: "https://x/b.bin", relPath: "b.bin", sha256: sha2 },
      ],
    });

    expect(fs.readFileSync(path.join(tmp, "models", "test-pack", "a.bin"), "utf8")).toBe(body1);
    expect(fs.readFileSync(path.join(tmp, "models", "test-pack", "b.bin"), "utf8")).toBe(body2);
  });

  it("throws and deletes file on checksum mismatch", async () => {
    global.fetch = vi.fn(
      async () => new Response("WRONG_BODY", { status: 200 }),
    ) as unknown as typeof fetch;

    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const mgr = new DependencyManager();
    await expect(
      mgr.installMultiFile({
        binary: "test-pack",
        destination: "models",
        files: [{ url: "https://x/a.bin", relPath: "a.bin", sha256: "deadbeef".repeat(8) }],
      }),
    ).rejects.toThrow(/mismatch/i);
    expect(fs.existsSync(path.join(tmp, "models", "test-pack", "a.bin"))).toBe(false);
  });

  it("throws on HTTP error and writes no files", async () => {
    global.fetch = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    ) as unknown as typeof fetch;

    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const mgr = new DependencyManager();
    await expect(
      mgr.installMultiFile({
        binary: "test-pack",
        destination: "models",
        files: [{ url: "https://x/a.bin", relPath: "a.bin", sha256: "deadbeef".repeat(8) }],
      }),
    ).rejects.toThrow(/HTTP 404/);
    expect(fs.existsSync(path.join(tmp, "models", "test-pack", "a.bin"))).toBe(false);
  });

  it("rolls back already-written files when a later file fails checksum", async () => {
    const goodBody = "alpha";
    const goodSha = crypto.createHash("sha256").update(goodBody).digest("hex");

    global.fetch = vi.fn(async (url: string | URL) => {
      return new Response(String(url).endsWith("/good.bin") ? goodBody : "WRONG_BODY", { status: 200 });
    }) as unknown as typeof fetch;

    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const mgr = new DependencyManager();
    await expect(
      mgr.installMultiFile({
        binary: "test-pack",
        destination: "models",
        files: [
          { url: "https://x/good.bin", relPath: "good.bin", sha256: goodSha },
          { url: "https://x/bad.bin",  relPath: "bad.bin",  sha256: "deadbeef".repeat(8) },
        ],
      }),
    ).rejects.toThrow(/mismatch/i);
    // After the second file's checksum fails, the first file should NOT remain.
    expect(fs.existsSync(path.join(tmp, "models", "test-pack", "good.bin"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "models", "test-pack", "bad.bin"))).toBe(false);
  });
});
