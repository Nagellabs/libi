import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  computeSha256,
  verifySha256,
  fetchWithHttpsOnlyRedirects,
} from "@/lib/security/download-verify";

function hashOf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").toLowerCase();
}

describe("download-verify", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "libi-dlverify-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("computeSha256", () => {
    it("computes the lowercase hex sha256 of a file", async () => {
      const buf = Buffer.from("hello libi", "utf-8");
      const p = path.join(tmpDir, "a.bin");
      await fs.writeFile(p, buf);
      expect(await computeSha256(p)).toBe(hashOf(buf));
    });

    it("throws on a missing file", async () => {
      await expect(
        computeSha256(path.join(tmpDir, "nope.bin")),
      ).rejects.toThrow();
    });
  });

  describe("verifySha256", () => {
    it("passes when the hash matches (case-insensitive)", async () => {
      const buf = Buffer.from("payload bytes", "utf-8");
      const p = path.join(tmpDir, "b.bin");
      await fs.writeFile(p, buf);
      await expect(
        verifySha256(p, hashOf(buf).toUpperCase()),
      ).resolves.toBeUndefined();
    });

    it("throws with an actionable message on mismatch", async () => {
      const p = path.join(tmpDir, "c.bin");
      await fs.writeFile(p, Buffer.from("real content", "utf-8"));
      const wrong = "0".repeat(64);
      await expect(verifySha256(p, wrong)).rejects.toThrow(/sha256 mismatch/);
      await expect(verifySha256(p, wrong)).rejects.toThrow(p);
    });

    it("throws on a missing file", async () => {
      await expect(
        verifySha256(path.join(tmpDir, "gone.bin"), "0".repeat(64)),
      ).rejects.toThrow();
    });
  });

  describe("fetchWithHttpsOnlyRedirects", () => {
    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
    });

    it("rejects a non-HTTPS initial URL without fetching", async () => {
      const spy = vi.fn();
      global.fetch = spy as unknown as typeof fetch;
      await expect(
        fetchWithHttpsOnlyRedirects("http://insecure/thing.bin"),
      ).rejects.toThrow(/non-HTTPS/);
      expect(spy).not.toHaveBeenCalled();
    });

    it("returns a 200 response directly", async () => {
      global.fetch = vi.fn(
        async () => new Response("ok", { status: 200 }),
      ) as unknown as typeof fetch;
      const res = await fetchWithHttpsOnlyRedirects("https://host/a.bin");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    });

    it("follows an HTTPS→HTTPS redirect", async () => {
      global.fetch = vi.fn(async (url: string | URL) => {
        if (String(url) === "https://host/a.bin") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://cdn/a.bin" },
          });
        }
        return new Response("final", { status: 200 });
      }) as unknown as typeof fetch;
      const res = await fetchWithHttpsOnlyRedirects("https://host/a.bin");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("final");
    });

    it("refuses an HTTPS→http redirect downgrade", async () => {
      global.fetch = vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://evil/a.bin" },
          }),
      ) as unknown as typeof fetch;
      await expect(
        fetchWithHttpsOnlyRedirects("https://host/a.bin"),
      ).rejects.toThrow(/redirect\s+downgrade/i);
    });

    it("throws on a redirect loop exceeding the hop cap", async () => {
      global.fetch = vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://host/loop.bin" },
          }),
      ) as unknown as typeof fetch;
      await expect(
        fetchWithHttpsOnlyRedirects("https://host/loop.bin"),
      ).rejects.toThrow(/Too many redirects/);
    });
  });
});
