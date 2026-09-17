import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchConnectedProviders } from "@/mcp/tools/provider-http";

/**
 * The MCP child reads provider detection over HTTP so the codex spawn and the
 * `~/.claude.json` read stay in the Next process. The shim's one promise is
 * that it never throws: whatever the studio does — 5xx, a body without
 * `connected`, a socket error, the 6 s timeout firing — the tool answers with
 * "nothing detected". Only `fetch` is mocked; the port comes from the real
 * `getCurrentPort` (env fallback when no port file exists).
 */

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe("fetchConnectedProviders", () => {
  it("returns the studio's connected list", async () => {
    const connected = [
      { agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected" },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse({ connected }));
    await expect(fetchConnectedProviders()).resolves.toEqual(connected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/providers$/);
  });

  it("answers [] on a non-ok response without reading the body", async () => {
    const json = vi.fn(async () => ({ connected: [{ name: "should-not-be-read" }] }));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json } as unknown as Response);
    await expect(fetchConnectedProviders()).resolves.toEqual([]);
    expect(json).not.toHaveBeenCalled();
  });

  it("answers [] when the body carries no `connected`", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ somethingElse: true }));
    await expect(fetchConnectedProviders()).resolves.toEqual([]);
  });

  it("answers [] when the body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    } as unknown as Response);
    await expect(fetchConnectedProviders()).resolves.toEqual([]);
  });

  it("answers [] — never throws — when fetch rejects (studio unreachable)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed: ECONNREFUSED"));
    await expect(fetchConnectedProviders()).resolves.toEqual([]);
  });

  it("sends a 6 s timeout signal and answers [] when it fires", async () => {
    // Node's AbortSignal.timeout runs on an internal timer that fake timers
    // cannot reach, so the firing is played through the mock: fetch rejects
    // the way undici does when the signal it was handed times out.
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const signal = init?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    await expect(fetchConnectedProviders()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
