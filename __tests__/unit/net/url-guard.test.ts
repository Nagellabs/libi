import { describe, it, expect, vi, beforeEach } from "vitest";

// `assertPublicHttpUrl` resolves DNS itself now, so every test controls what
// the resolver "returns" instead of hitting the real network. Named-export
// mock (matches `import { promises as dnsPromises } from "node:dns"` in
// lib/net/url-guard.ts) rather than mocking the default export, which is
// fiddlier to get right for Node core modules under Vitest.
const lookupMock = vi.fn();
vi.mock("node:dns", () => ({
  promises: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

interface CapturedLookupCallback {
  (
    err: Error | null,
    address: string | Array<{ address: string; family: number }>,
    family?: number,
  ): void;
}
interface CapturedAgentOptions {
  connect: {
    lookup: (
      hostname: string,
      options: { all?: boolean },
      callback: CapturedLookupCallback,
    ) => void;
  };
}

// Capture the options undici's `Agent` is constructed with so the pinned
// `connect.lookup` can be exercised directly, without spinning up a real
// socket. `dispatcher` returned by `assertPublicHttpUrl` becomes whatever
// this mock implementation returns.
vi.mock("undici", () => ({
  Agent: vi.fn(function MockAgent(this: { __opts: CapturedAgentOptions }, opts: CapturedAgentOptions) {
    this.__opts = opts;
  }),
}));

import { Agent } from "undici";
import { assertPublicHttpUrl } from "@/lib/net/url-guard";

beforeEach(() => {
  lookupMock.mockReset();
  vi.mocked(Agent).mockClear();
  // Default: an unrelated public-looking hostname resolves to a public
  // address, so tests that aren't specifically about DNS behavior don't each
  // need their own mock.
  lookupMock.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
});

describe("assertPublicHttpUrl", () => {
  it("accepts public https", async () => {
    await expect(
      assertPublicHttpUrl("https://storage.googleapis.com/x/a.mp4"),
    ).resolves.toMatchObject({ url: expect.any(URL) });
  });

  it("rejects non-http schemes", async () => {
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicHttpUrl("ftp://x/a")).rejects.toThrow();
  });

  it("rejects loopback + private + metadata hosts by literal form, before any DNS lookup", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1/a")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://localhost/a")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://10.0.0.5/a")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://192.168.1.1/a")).rejects.toThrow();
    await expect(
      assertPublicHttpUrl("http://169.254.169.254/latest/meta-data"),
    ).rejects.toThrow();
    // Literal forms are caught before reaching DNS — the resolver is never consulted.
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects other WHATWG-normalized literal forms (decimal, hex, short IPv4)", async () => {
    await expect(assertPublicHttpUrl("http://2130706433/")).rejects.toThrow(); // decimal 127.0.0.1
    await expect(assertPublicHttpUrl("http://0x7f000001/")).rejects.toThrow(); // hex 127.0.0.1
    await expect(assertPublicHttpUrl("http://127.1/")).rejects.toThrow(); // short-form 127.0.0.1
  });

  it("rejects an unparseable url", async () => {
    await expect(assertPublicHttpUrl("not a url")).rejects.toThrow();
  });

  it("rejects IPv6 loopback / ULA / link-local / v4-mapped (bracketed hosts)", async () => {
    await expect(assertPublicHttpUrl("http://[::1]/a")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://[fd12:3456::1]/a")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://[fc00::1]/a")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://[fe80::1]/a")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://[::ffff:127.0.0.1]/a")).rejects.toThrow();
  });

  it("accepts a public IPv6 host", async () => {
    await expect(
      assertPublicHttpUrl("http://[2606:4700:4700::1111]/a"),
    ).resolves.toMatchObject({ url: expect.any(URL) });
  });

  describe("DNS resolution (rebinding / metadata-hostname coverage)", () => {
    it("rejects a public-looking hostname whose A record is a single private address", async () => {
      lookupMock.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
      await expect(assertPublicHttpUrl("http://metadata.google.internal/")).rejects.toThrow(
        /private/,
      );
      expect(lookupMock).toHaveBeenCalledWith("metadata.google.internal", { all: true });
    });

    it("rejects when only ONE of several round-robin answers is private", async () => {
      lookupMock.mockResolvedValueOnce([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
      await expect(assertPublicHttpUrl("http://sneaky.example/")).rejects.toThrow(/private/);
    });

    it("rejects when the FIRST of several round-robin answers is public and a later one is private", async () => {
      lookupMock.mockResolvedValueOnce([
        { address: "203.0.113.9", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]);
      await expect(assertPublicHttpUrl("http://sneaky2.example/")).rejects.toThrow(/private/);
    });

    it("rejects when DNS resolution fails outright (fail-closed, not fall-through)", async () => {
      lookupMock.mockRejectedValueOnce(new Error("ENOTFOUND sneaky.example"));
      await expect(assertPublicHttpUrl("http://sneaky.example/")).rejects.toThrow(
        /dns lookup failed/,
      );
    });

    it("accepts a hostname whose every answer is public", async () => {
      lookupMock.mockResolvedValueOnce([
        { address: "203.0.113.9", family: 4 },
        { address: "203.0.113.10", family: 4 },
      ]);
      await expect(assertPublicHttpUrl("http://fine.example/")).resolves.toMatchObject({
        url: expect.any(URL),
      });
    });

    it("times out a hanging lookup rather than waiting forever (fail-closed)", async () => {
      vi.useFakeTimers();
      try {
        lookupMock.mockReturnValueOnce(new Promise(() => {})); // never resolves
        const pending = assertPublicHttpUrl("http://slow-dns.example/");
        const assertion = expect(pending).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(6_000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("pinned dispatcher", () => {
    it("returns a dispatcher whose connect.lookup ignores the hostname it's asked about and always answers with the vetted address", async () => {
      lookupMock.mockResolvedValueOnce([{ address: "203.0.113.5", family: 4 }]);
      const { dispatcher } = await assertPublicHttpUrl("https://example-public.test/a");

      const AgentMock = vi.mocked(Agent);
      expect(AgentMock).toHaveBeenCalledTimes(1);
      const opts = AgentMock.mock.calls[0][0] as unknown as CapturedAgentOptions;
      expect(dispatcher).toBeDefined();

      const cb = vi.fn();
      // Simulate a rebinding attempt at connect time: undici asks the lookup
      // function about some other hostname entirely. A correctly-pinned
      // lookup ignores that and still answers with only the address that was
      // actually vetted above — never re-resolving.
      opts.connect.lookup("attacker-controlled.test", { all: true }, cb);
      expect(cb).toHaveBeenCalledWith(null, [{ address: "203.0.113.5", family: 4 }]);
      // The resolver itself was only consulted once — for the vetting lookup,
      // never again for the connect-time lookup.
      expect(lookupMock).toHaveBeenCalledTimes(1);
    });

    it("answers a non-`all` lookup with a single address/family pair", async () => {
      lookupMock.mockResolvedValueOnce([{ address: "203.0.113.5", family: 4 }]);
      await assertPublicHttpUrl("https://example-public2.test/a");

      const AgentMock = vi.mocked(Agent);
      const opts = AgentMock.mock.calls.at(-1)?.[0] as unknown as CapturedAgentOptions;

      const cb = vi.fn();
      opts.connect.lookup("attacker-controlled.test", {}, cb);
      expect(cb).toHaveBeenCalledWith(null, "203.0.113.5", 4);
    });
  });
});
