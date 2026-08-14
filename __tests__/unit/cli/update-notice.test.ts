import { describe, it, expect, vi } from "vitest";

import { maybePrintUpdateNotice, NOTICE_TIMEOUT_MS } from "@/lib/cli/update-notice";
import { PUBLIC_NPM_REGISTRY } from "@/lib/runtime/registry-url";

/** A fetch that answers the `/latest` manifest endpoint with `version`. */
function fetchServing(version: string): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("maybePrintUpdateNotice", () => {
  it("prints one notice when the registry serves a newer version", async () => {
    const write = vi.fn();
    const line = await maybePrintUpdateNotice({
      currentVersion: "0.1.0",
      env: {},
      fetchImpl: fetchServing("0.2.0"),
      write,
    });
    expect(line).toContain("0.1.0 → 0.2.0");
    expect(line).toContain("npm install -g @nagellabs/libi@latest");
    expect(write).toHaveBeenCalledOnce();
  });

  it("stays silent when up to date, and when the registry serves something older", async () => {
    const write = vi.fn();
    expect(
      await maybePrintUpdateNotice({
        currentVersion: "0.2.0",
        env: {},
        fetchImpl: fetchServing("0.2.0"),
        write,
      }),
    ).toBeNull();
    expect(
      await maybePrintUpdateNotice({
        currentVersion: "0.2.0",
        env: {},
        fetchImpl: fetchServing("0.1.9"),
        write,
      }),
    ).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("a prerelease of the same triple is not an update", async () => {
    const write = vi.fn();
    expect(
      await maybePrintUpdateNotice({
        currentVersion: "0.2.0",
        env: {},
        fetchImpl: fetchServing("0.2.0-rc.1"),
        write,
      }),
    ).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("is silent on every network failure shape", async () => {
    const write = vi.fn();
    const failures: Array<typeof fetch> = [
      vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
      vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    ];
    for (const fetchImpl of failures) {
      expect(
        await maybePrintUpdateNotice({ currentVersion: "0.1.0", env: {}, fetchImpl, write }),
      ).toBeNull();
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("honors LIBI_REGISTRY_URL when valid, falls back to public npm when not", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 });
    }) as unknown as typeof fetch;

    await maybePrintUpdateNotice({
      currentVersion: "0.1.0",
      env: { LIBI_REGISTRY_URL: "http://127.0.0.1:4873" },
      fetchImpl,
      write: vi.fn(),
    });
    expect(seen[0]).toContain("127.0.0.1:4873");

    seen.length = 0;
    await maybePrintUpdateNotice({
      currentVersion: "0.1.0",
      // Non-loopback http is rejected by normalizeRegistryUrl → public npm.
      env: { LIBI_REGISTRY_URL: "http://evil.example.com" },
      fetchImpl,
      write: vi.fn(),
    });
    expect(seen[0]).toContain(new URL(PUBLIC_NPM_REGISTRY).host);
  });

  it("uses the short notice timeout by default", () => {
    // The desktop check tolerates 8s; a terminal startup line must not.
    expect(NOTICE_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});
